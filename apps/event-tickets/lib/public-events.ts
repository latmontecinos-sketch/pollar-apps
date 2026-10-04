import { attendeesToShow } from "./attendees.ts";
import { db, dbReady } from "./db.ts";
import { stroopsToDecimal } from "./money.ts";
import { whenWindow, type ShowcaseWhen } from "./showcase-filters.ts";

/** One card in the showcase. Everything a stranger may see about a public event, and no more. */
export type PublicEvent = {
  id: string;
  name: string;
  datetimeUtc: string;
  place: string;
  /** Cheapest tier still on sale (lib/price-label.ts `priceRange`); "0.0000000" when it's free. */
  minPriceDecimal: string;
  maxPriceDecimal: string;
  /** Free seats across every tier right now (held checkouts count as taken). */
  seatsLeft: number;
  imageVersion: string | null;
  /** Normalised city (lib/city.ts), or null. */
  city: string | null;
  /** When the doors open, ISO UTC, or null. */
  doorsOpenUtc: string | null;
  /** `#rrggbb` from the poster; hand it to `accentStyle` / `accentVariants` (lib/accent.ts), never to CSS directly. */
  accent: string | null;
  /** Tickets issued, only a number, and only from the threshold up (lib/attendees.ts); null = don't show. */
  attendees: number | null;
};

/** What the showcase can be narrowed by. */
export type ShowcaseFilters = { city?: string | null; when?: ShowcaseWhen };

/** A city that has public events coming up, for the filter chips. */
export type ShowcaseCity = { city: string; count: number };

/**
 * Tickets issued for the event (paid and free, never a refunded one), as SQL.
 * Expects the event as `e`. A bare count: no names, no addresses. Served by
 * `tickets`' (event_id, door_code) index and the sales primary key.
 */
export const ATTENDEES_COLUMN = `
  (SELECT count(*) FROM tickets tk JOIN sales s ON s.id = tk.sale_id
    WHERE tk.event_id = e.id AND s.status = 'paid') AS attendees`;

/**
 * An event's advertised price range as SQL, for listings that can't load
 * every tier: the same rule as `priceRange` in lib/price-label.ts — over the
 * tiers with a seat left, else over all of them. Expects the event as `e`.
 */
export const PRICE_RANGE_COLUMNS = `
  COALESCE((SELECT MIN(t.price_stroops) FROM ticket_types t WHERE t.event_id = e.id AND t.reserved < t.capacity),
           (SELECT MIN(t.price_stroops) FROM ticket_types t WHERE t.event_id = e.id)) AS min_price,
  COALESCE((SELECT MAX(t.price_stroops) FROM ticket_types t WHERE t.event_id = e.id AND t.reserved < t.capacity),
           (SELECT MAX(t.price_stroops) FROM ticket_types t WHERE t.event_id = e.id)) AS max_price`;

/**
 * The app's showcase (/app): public events that haven't started, soonest
 * first. Private events never appear here, and neither do the link-only
 * events from before visibility existed (lib/visibility.ts).
 *
 * The date is compared as stored — ISO strings sort like the times they
 * are — so the (visibility, datetime_utc) index serves both the filter and
 * the order; wrapping the column in datetime() would force a scan.
 */
export async function listPublicEvents(
  limit = 40,
  now = new Date(),
  filters: ShowcaseFilters = {}
): Promise<PublicEvent[]> {
  await dbReady();
  // "Today" / "this week" end at a La Paz midnight (lib/showcase-filters.ts); the start is
  // always `now`, as before. Both bounds are plain text comparisons on `datetime_utc`.
  const window = whenWindow(filters.when ?? "all", now);
  const conditions = ["e.visibility = 'public'", "e.datetime_utc >= ?"];
  const args: (string | number)[] = [window.from];
  if (window.to) {
    conditions.push("e.datetime_utc < ?");
    args.push(window.to);
  }
  if (filters.city) {
    conditions.push("e.city = ?");
    args.push(filters.city);
  }
  args.push(limit);
  const result = await db.execute({
    sql: `SELECT e.id, e.name, e.datetime_utc, e.place, e.city, e.doors_open_utc, e.accent,
                 ${ATTENDEES_COLUMN},
                 ${PRICE_RANGE_COLUMNS},
                 (SELECT COALESCE(SUM(MAX(t.capacity - t.reserved, 0)), 0)
                    FROM ticket_types t WHERE t.event_id = e.id) AS seats_left,
                 i.version AS image_version
          FROM events e
          LEFT JOIN event_images i ON i.event_id = e.id
          WHERE ${conditions.join(" AND ")}
          ORDER BY e.datetime_utc
          LIMIT ?`,
    args,
  });
  return result.rows
    .filter((row) => row.min_price !== null)
    .map((row) => ({
      id: String(row.id),
      name: String(row.name),
      datetimeUtc: String(row.datetime_utc),
      place: String(row.place),
      minPriceDecimal: stroopsToDecimal(BigInt(row.min_price as number)),
      maxPriceDecimal: stroopsToDecimal(BigInt(row.max_price as number)),
      seatsLeft: Number(row.seats_left),
      imageVersion: row.image_version === null ? null : String(row.image_version),
      city: row.city === null ? null : String(row.city),
      doorsOpenUtc: row.doors_open_utc === null ? null : String(row.doors_open_utc),
      accent: row.accent === null ? null : String(row.accent),
      attendees: attendeesToShow(Number(row.attendees)),
    }));
}

/**
 * Cities with public events that haven't started, most events first (then
 * alphabetical), for the showcase's chips. Always the whole list, whatever
 * filter is active: picking a city must not make the other chips vanish.
 */
export async function listPublicCities(now = new Date()): Promise<ShowcaseCity[]> {
  await dbReady();
  const result = await db.execute({
    sql: `SELECT city, count(*) AS n FROM events
          WHERE visibility = 'public' AND city IS NOT NULL AND datetime_utc >= ?
          GROUP BY city ORDER BY n DESC, city`,
    args: [now.toISOString()],
  });
  return result.rows.map((row) => ({ city: String(row.city), count: Number(row.n) }));
}

/** The showcase's data in one call: the (filtered) events and the cities for the chips. */
export async function listShowcase(
  filters: ShowcaseFilters = {},
  limit = 40,
  now = new Date()
): Promise<{ events: PublicEvent[]; cities: ShowcaseCity[] }> {
  const [events, cities] = await Promise.all([listPublicEvents(limit, now, filters), listPublicCities(now)]);
  return { events, cities };
}
