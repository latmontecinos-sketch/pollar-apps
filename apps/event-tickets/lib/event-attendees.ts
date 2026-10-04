import { attendeesToShow } from "./attendees.ts";
import { db, dbReady } from "./db.ts";

/**
 * Tickets issued for one event, paid and free, never a refunded one: a bare
 * number. Read only. For a private event the caller asks only after the
 * access gate (lib/visibility.ts `canView`): even a count is the event's data.
 */
export async function countAttendees(eventId: string): Promise<number> {
  await dbReady();
  const result = await db.execute({
    sql: `SELECT count(*) AS n FROM tickets tk JOIN sales s ON s.id = tk.sale_id
          WHERE tk.event_id = ? AND s.status = 'paid'`,
    args: [eventId],
  });
  return Number(result.rows[0].n);
}

/** The count to show on the event page, or null while it is too small to say anything. */
export async function attendeesForPage(eventId: string): Promise<number | null> {
  return attendeesToShow(await countAttendees(eventId));
}
