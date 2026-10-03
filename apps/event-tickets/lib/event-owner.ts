import { db, dbReady } from "./db.ts";

/**
 * Who organizes an event, or `null` when it doesn't exist. The owner-only
 * routes call this first, answer 404 on `null`, and only then check the
 * caller against the address it returns (404 before 403: existence isn't
 * secret, ownership is).
 */
export async function organizerOf(eventId: string): Promise<string | null> {
  await dbReady();
  const result = await db.execute({
    sql: "SELECT organizer_pollar_id FROM events WHERE id = ?",
    args: [eventId],
  });
  return result.rows.length > 0 ? String(result.rows[0].organizer_pollar_id) : null;
}
