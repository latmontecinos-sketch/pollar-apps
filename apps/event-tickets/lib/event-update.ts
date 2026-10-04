import { db } from "./db.ts";
import { newAccessCode } from "./visibility.ts";

/** What an organizer's edit may carry. A field left out is a field left alone. */
export type EventPatch = {
  name?: string;
  description?: string;
  place?: string;
  organizerName?: string;
  organizerContact?: string;
  datetimeUtc?: string;
  visibility?: "public" | "private";
  /** Normalised (lib/city.ts); `null` clears it. */
  city?: string | null;
  /** Checked against the start (lib/doors-open.ts); `null` clears it. */
  doorsOpenUtc?: string | null;
};

/** `datetime_utc` minus a day, in the same shape `toISOString()` writes, so it compares as text. */
const MIN_DOORS_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', datetime_utc, '-24 hours')";

/**
 * One UPDATE that writes only the fields in `patch`.
 *
 * The earlier version read the row, merged the body over it in JavaScript and
 * wrote back EVERY column — so a PATCH that only renamed the event, racing a
 * "make it private" one, wrote back the `visibility` it had read before and
 * quietly made a private event public again, listing it in the showcase.
 * Now a request that doesn't mention visibility cannot change it, whatever
 * else is racing it (rule 3 in CLAUDE.md: the condition lives in the
 * statement). Going private keeps an existing access code (`COALESCE`), so
 * links already shared keep working, and two requests going private at once
 * can't mint two codes.
 *
 * Returns false when nothing was written: the event is gone, or the new start
 * (or doors time) would leave the other outside its window (lib/doors-open.ts).
 *
 * `capacity` (the listing summary) is derived from the tiers inside the same
 * statement, not from a list read earlier that a capacity increase may have
 * outdated.
 */
export async function updateEventFields(eventId: string, patch: EventPatch): Promise<boolean> {
  const sets: string[] = [];
  const args: (string | null)[] = [];
  const guards: string[] = [];
  const guardArgs: string[] = [];
  const set = (column: string, value: string | null | undefined) => {
    if (value === undefined) return;
    sets.push(`${column} = ?`);
    args.push(value);
  };
  set("name", patch.name);
  set("description", patch.description);
  set("place", patch.place);
  set("organizer_name", patch.organizerName);
  set("organizer_contact", patch.organizerContact);
  set("datetime_utc", patch.datetimeUtc);
  set("city", patch.city);
  set("doors_open_utc", patch.doorsOpenUtc);
  if (patch.visibility) {
    set("visibility", patch.visibility);
    if (patch.visibility === "private") {
      sets.push("access_code = COALESCE(access_code, ?)");
      args.push(newAccessCode());
    }
  }
  sets.push("capacity = (SELECT COALESCE(SUM(capacity), 0) FROM ticket_types WHERE event_id = events.id)");

  // The doors time has to stay within a day before the start. When the request
  // carries both, the route already checked the pair; when it carries only one,
  // the other is whatever the row holds NOW, so the check lives in the WHERE
  // (rule 3), not in a read that a racing edit can outdate.
  if (patch.datetimeUtc !== undefined && patch.doorsOpenUtc === undefined) {
    guards.push(
      "(doors_open_utc IS NULL OR (doors_open_utc <= ? AND doors_open_utc >= strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-24 hours')))"
    );
    guardArgs.push(patch.datetimeUtc, patch.datetimeUtc);
  } else if (typeof patch.doorsOpenUtc === "string" && patch.datetimeUtc === undefined) {
    guards.push(`(? <= datetime_utc AND ? >= ${MIN_DOORS_SQL})`);
    guardArgs.push(patch.doorsOpenUtc, patch.doorsOpenUtc);
  }

  const result = await db.execute({
    sql: `UPDATE events SET ${sets.join(", ")} WHERE id = ?${guards.map((g) => ` AND ${g}`).join("")} RETURNING id`,
    args: [...args, eventId, ...guardArgs],
  });
  return result.rows.length > 0;
}
