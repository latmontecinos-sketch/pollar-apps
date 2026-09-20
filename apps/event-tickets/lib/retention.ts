import { db, dbReady } from "./db.ts";

/**
 * The only personal data this app stores is the buyer's email, and it has
 * exactly two jobs: send them their ticket, and tell them the door let them
 * in. Both are over once the event is. Keeping it after that isn't caution,
 * it's a growing pile of other people's addresses waiting for the day
 * someone reads our database.
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
