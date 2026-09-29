import { db, dbReady } from "./db.ts";

/**
 * The personal data this app stores is two kinds of email: the buyer's, which
 * sends them their ticket and tells them the door let them in, and the
 * organizer's, where capacity-increase codes go. Each is over once the events
 * it serves are. Keeping them after that isn't caution, it's a growing pile of
 * other people's addresses waiting for the day someone reads our database.
 */

/** A month after the event: long enough for a late "I never got my ticket". */
const KEEP_DAYS = 30;

/**
 * Forgets the buyer's email on every sale whose event ended more than
 * {@link KEEP_DAYS} days ago. The ticket, the payment and the check-in
 * stay: those are the record of what happened, and none of them names a
 * person — a Stellar address is the account, not the human.
 *
 * Idempotent, so it's safe to run from anywhere, as often as it happens.
 */
export async function purgeStaleBuyerEmails(): Promise<number> {
  await dbReady();
  const purged = await db.execute({
    sql: `UPDATE sales SET buyer_email = NULL, buyer_locale = NULL
          WHERE buyer_email IS NOT NULL
            AND event_id IN (
              SELECT id FROM events
              WHERE datetime(datetime_utc) < datetime('now', ?)
            )`,
    args: [`-${KEEP_DAYS} days`],
  });
  return purged.rowsAffected ?? 0;
}

/**
 * The organizer's side of the same rule. Their confirmed email (where
 * capacity codes go) is kept while they have an event that isn't long over,
 * and forgotten {@link KEEP_DAYS} days after their last one. Codes are only
 * useful for ten minutes; a day later they're just rows.
 */
export async function purgeStaleOrganizerData(): Promise<number> {
  await dbReady();
  const codes = await db.execute(
    "DELETE FROM capacity_codes WHERE datetime(created_at) < datetime('now', '-1 day')"
  );
  const emails = await db.execute({
    sql: `DELETE FROM organizer_emails
          WHERE NOT EXISTS (
            SELECT 1 FROM events
            WHERE events.organizer_pollar_id = organizer_emails.organizer_pollar_id
              AND datetime(events.datetime_utc) >= datetime('now', ?)
          )`,
    args: [`-${KEEP_DAYS} days`],
  });
  return (codes.rowsAffected ?? 0) + (emails.rowsAffected ?? 0);
}
