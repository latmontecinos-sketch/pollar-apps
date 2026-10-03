import { db, dbReady } from "./db.ts";

/**
 * Money taken in, summed in BigInt.
 *
 * Never `SUM(amount_stroops)` in SQL: SQLite aborts the whole statement with
 * "integer overflow" past 2^63, and a JS number loses stroops past 2^53 — on
 * a query that serves the organizer's home, one poisoned total would take the
 * whole screen down. Each amount is read as text and added here.
 */
export function sumStroops(amounts: Iterable<string | number | bigint>): bigint {
  let total = 0n;
  for (const amount of amounts) total += BigInt(amount);
  return total;
}

/** What each of an organizer's events has collected: the sum of its `paid` sales, by event id. */
export async function collectedByEvent(organizerPollarId: string): Promise<Map<string, bigint>> {
  await dbReady();
  const result = await db.execute({
    sql: `SELECT s.event_id, CAST(s.amount_stroops AS TEXT) AS amount
          FROM sales s
          JOIN events e ON e.id = s.event_id
          WHERE e.organizer_pollar_id = ? AND s.status = 'paid'`,
    args: [organizerPollarId],
  });
  const totals = new Map<string, bigint>();
  for (const row of result.rows) {
    const eventId = String(row.event_id);
    totals.set(eventId, (totals.get(eventId) ?? 0n) + BigInt(String(row.amount)));
  }
  return totals;
}

/** What one event has collected: the sum of its `paid` sales, whatever tier each one was. */
export async function collectedForEvent(eventId: string): Promise<bigint> {
  await dbReady();
  const result = await db.execute({
    sql: "SELECT CAST(amount_stroops AS TEXT) AS amount FROM sales WHERE event_id = ? AND status = 'paid'",
    args: [eventId],
  });
  return sumStroops(result.rows.map((row) => String(row.amount)));
}
