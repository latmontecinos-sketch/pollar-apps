import { db, dbReady } from "./db.ts";
import { stroopsToDecimal } from "./money.ts";

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
};

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
export async function listPublicEvents(limit = 40, now = new Date()): Promise<PublicEvent[]> {
  await dbReady();
  const result = await db.execute({
    sql: `SELECT e.id, e.name, e.datetime_utc, e.place,
                 ${PRICE_RANGE_COLUMNS},
                 (SELECT COALESCE(SUM(MAX(t.capacity - t.reserved, 0)), 0)
                    FROM ticket_types t WHERE t.event_id = e.id) AS seats_left,
                 i.version AS image_version
          FROM events e
          LEFT JOIN event_images i ON i.event_id = e.id
          WHERE e.visibility = 'public' AND e.datetime_utc >= ?
          ORDER BY e.datetime_utc
          LIMIT ?`,
    args: [now.toISOString(), limit],
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
    }));
}
