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
};

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
 * `capacity` (the listing summary) is derived from the tiers inside the same
 * statement, not from a list read earlier that a capacity increase may have
 * outdated.
 */
export async function updateEventFields(eventId: string, patch: EventPatch): Promise<void> {
  const sets: string[] = [];
  const args: string[] = [];
  const set = (column: string, value: string | undefined) => {
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
  if (patch.visibility) {
    set("visibility", patch.visibility);
    if (patch.visibility === "private") {
      sets.push("access_code = COALESCE(access_code, ?)");
      args.push(newAccessCode());
    }
  }
  sets.push("capacity = (SELECT COALESCE(SUM(capacity), 0) FROM ticket_types WHERE event_id = events.id)");

  await db.execute({
    sql: `UPDATE events SET ${sets.join(", ")} WHERE id = ?`,
    args: [...args, eventId],
  });
}
