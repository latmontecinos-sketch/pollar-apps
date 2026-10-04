import { laPazLocalToUtcIso, utcIsoToLaPazLocal } from "./format.ts";
import { normalizeCity } from "./city.ts";

/**
 * The showcase's two filters: a city, and a window of time ("hoy", "esta
 * semana"). Pure, so the midnight and week edges are tested without a
 * database.
 *
 * Days are La Paz days. The app stores no time zone per event and shows every
 * event time in America/La_Paz (lib/format.ts), so "today" has to mean the
 * same: an event at 23:30 in La Paz is today's even though it is already
 * tomorrow in UTC. Bolivia has no daylight saving, so a day always starts at
 * 04:00 UTC.
 */

export type ShowcaseWhen = "today" | "week" | "all";

export function isShowcaseWhen(value: unknown): value is ShowcaseWhen {
  return value === "today" || value === "week" || value === "all";
}

/** What the page's query string says, cleaned: unknown `when` is "all", the city is normalised. */
export function parseShowcaseFilters(params: { city?: unknown; when?: unknown }): {
  city: string | null;
  when: ShowcaseWhen;
} {
  const pick = (value: unknown) => (Array.isArray(value) ? value[0] : value);
  const when = pick(params.when);
  return { city: normalizeCity(pick(params.city)), when: isShowcaseWhen(when) ? when : "all" };
}

/** UTC instant at which the La Paz calendar day containing `instant` begins. */
export function startOfLaPazDay(instant: Date): Date {
  const local = utcIsoToLaPazLocal(instant.toISOString()); // "YYYY-MM-DDTHH:mm"
  return new Date(laPazLocalToUtcIso(`${local.slice(0, 10)}T00:00`));
}

/** The La Paz day starting `days` days after the one that starts at `dayStart`. */
function addLaPazDays(dayStart: Date, days: number): Date {
  // 24 h steps are exact: no daylight saving in Bolivia.
  return new Date(dayStart.getTime() + days * 86_400_000);
}

/**
 * The window a `when` filter covers, as ISO bounds: events with
 * `from <= datetime_utc < to`. `from` is always `now` (the showcase never lists
 * what already started); `to` is null for "all".
 *
 * - `today`: until the next La Paz midnight.
 * - `week`: until the end of the coming Sunday (the week runs Monday to
 *   Sunday), so on a Sunday it is the same as today.
 */
export function whenWindow(when: ShowcaseWhen, now: Date): { from: string; to: string | null } {
  const from = now.toISOString();
  if (when === "all") return { from, to: null };
  const dayStart = startOfLaPazDay(now);
  if (when === "today") return { from, to: addLaPazDays(dayStart, 1).toISOString() };
  const local = utcIsoToLaPazLocal(now.toISOString());
  const weekday = new Date(`${local.slice(0, 10)}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const daysLeftIncludingToday = weekday === 0 ? 1 : 8 - weekday; // Mon=7 … Sat=2, Sun=1
  return { from, to: addLaPazDays(dayStart, daysLeftIncludingToday).toISOString() };
}

/**
 * The showcase URL for a filter state, for the chips' links: defaults leave
 * the query string (no city, "all" times), so the unfiltered page is just
 * `/app`. The city is encoded, never trusted: it is whatever `normalizeCity`
 * produced from a query string or from the database.
 */
export function showcaseHref(
  current: { city: string | null; when: ShowcaseWhen },
  change: { city?: string | null; when?: ShowcaseWhen },
  base = "/app"
): string {
  const city = change.city === undefined ? current.city : change.city;
  const when = change.when ?? current.when;
  const params = new URLSearchParams();
  if (city) params.set("city", city);
  if (when !== "all") params.set("when", when);
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}
