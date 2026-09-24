import { createHash, randomInt } from "node:crypto";
import { db, dbReady } from "./db.ts";
import { newId } from "./ids.ts";
import { MAX_CAPACITY } from "./ticket-limits.ts";
import { extendCapacity } from "./ticket-types.ts";

/**
 * Raising a tier's capacity takes two steps: ask for a code (it goes to the
 * organizer's email), then send it back. The signed session already proves
 * who is asking; the code proves they meant it and that they read the
 * organizer's inbox — so a session left open on a borrowed phone, or a
 * forwarded request, can't quietly add seats.
 *
 * Which inbox: the first code goes to the address the client offers (the
 * Pollar profile email, or one typed in). Confirming that code binds the
 * address to the organizer, and from then on every code goes there whatever
 * the client says. Binding on confirmation rather than on request means a
 * typo can't lock an organizer out: an address nobody confirmed binds nothing.
 *
 * Kept free of `next/server` so the tests can run it under `node --test`.
 */

export const CODE_TTL_MS = 10 * 60 * 1000;
/** Wrong guesses per code. With 10^6 codes and a request quota per hour, guessing is hopeless. */
export const MAX_CODE_ATTEMPTS = 5;

function hashCode(challengeId: string, code: string): string {
  return createHash("sha256").update(`${challengeId}:${code}`).digest("hex");
}

/** Six digits, leading zeros kept: what someone reads off an email and types. */
function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

async function boundEmail(organizer: string): Promise<string | null> {
  const result = await db.execute({
    sql: "SELECT email FROM organizer_emails WHERE organizer_pollar_id = ?",
    args: [organizer],
  });
  return result.rows.length > 0 ? String(result.rows[0].email) : null;
}

export type CodeRequest =
  | { ok: true; challengeId: string; code: string; email: string; tierName: string }
  | { ok: false; code: "capacity_lower" | "capacity_limit" | "not_found" | "email_required" };

/**
 * Checks the change would be allowed right now and issues a code for it.
 * The caller emails `code` to `email`; nothing is stored in the clear.
 */
export async function requestCapacityCode(args: {
  eventId: string;
  ticketTypeId: string;
  capacity: number;
  organizer: string;
  /** Only used until an address is bound to this organizer. */
  offeredEmail: string | null;
  now?: number;
}): Promise<CodeRequest> {
  await dbReady();
  const { capacity } = args;
  if (!Number.isInteger(capacity) || capacity < 1) return { ok: false, code: "capacity_lower" };
  if (capacity > MAX_CAPACITY) return { ok: false, code: "capacity_limit" };

  const tier = await db.execute({
    sql: "SELECT name, capacity FROM ticket_types WHERE id = ? AND event_id = ?",
    args: [args.ticketTypeId, args.eventId],
  });
  if (tier.rows.length === 0) return { ok: false, code: "not_found" };
  // Early, so nobody gets an email for a change that can't happen. Still
  // re-checked by the UPDATE itself when the code comes back.
  if (capacity <= Number(tier.rows[0].capacity)) return { ok: false, code: "capacity_lower" };

  const email = (await boundEmail(args.organizer)) ?? args.offeredEmail;
  if (!email) return { ok: false, code: "email_required" };

  const challengeId = newId();
  const code = newCode();
  const expires = new Date((args.now ?? Date.now()) + CODE_TTL_MS).toISOString();
  await db.execute({
    sql: `INSERT INTO capacity_codes
            (id, event_id, ticket_type_id, organizer_pollar_id, capacity, email, code_hash, expires_at_utc)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [challengeId, args.eventId, args.ticketTypeId, args.organizer, capacity, email, hashCode(challengeId, code), expires],
  });
  return { ok: true, challengeId, code, email, tierName: String(tier.rows[0].name) };
}

/** A request that asked for a code but never got it (the email failed): not worth a retry budget. */
export async function discardCapacityCode(challengeId: string): Promise<void> {
  await db.execute({ sql: "DELETE FROM capacity_codes WHERE id = ? AND used_at IS NULL", args: [challengeId] });
}

export type CodeConfirmation =
  | { ok: true; capacity: number }
  | {
      ok: false;
      code: "code_invalid" | "code_expired" | "code_attempts" | "capacity_lower" | "capacity_limit" | "not_found";
    };

/**
 * Spends the code on exactly the change it was issued for, then applies it.
 *
 * The code is consumed by one conditional UPDATE (rule 3 in CLAUDE.md): two
 * requests racing with the right code can't both pass, and a wrong guess is
 * counted by an UPDATE of its own. The capacity change runs after, through
 * `extendCapacity`, which re-checks "only upwards" in its own WHERE — if the
 * seats moved in between, the code is spent and the answer says why.
 */
export async function confirmCapacityCode(args: {
  eventId: string;
  ticketTypeId: string;
  capacity: number;
  organizer: string;
  challengeId: string;
  code: string;
  now?: number;
}): Promise<CodeConfirmation> {
  await dbReady();
  const code = args.code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(code) || !args.challengeId) return { ok: false, code: "code_invalid" };
  const now = new Date(args.now ?? Date.now()).toISOString();

  const spent = await db.execute({
    sql: `UPDATE capacity_codes SET used_at = ?
          WHERE id = ? AND event_id = ? AND ticket_type_id = ? AND organizer_pollar_id = ?
            AND capacity = ? AND used_at IS NULL AND attempts < ? AND expires_at_utc > ?
            AND code_hash = ?
          RETURNING email`,
    args: [
      now,
      args.challengeId,
      args.eventId,
      args.ticketTypeId,
      args.organizer,
      args.capacity,
      MAX_CODE_ATTEMPTS,
      now,
      hashCode(args.challengeId, code),
    ],
  });

  if (spent.rows.length === 0) return { ok: false, code: await whyNot(args, now) };

  // The code reached this inbox and came back: that's the proof binding needs.
  await db.execute({
    sql: `INSERT INTO organizer_emails (organizer_pollar_id, email) VALUES (?, ?)
          ON CONFLICT(organizer_pollar_id) DO NOTHING`,
    args: [args.organizer, String(spent.rows[0].email)],
  });

  const extended = await extendCapacity(args.eventId, args.ticketTypeId, args.capacity);
  return extended.ok ? { ok: true, capacity: args.capacity } : extended;
}

/** Explains a refused code, and counts the attempt when it was a wrong guess on a live code. */
async function whyNot(
  args: { challengeId: string; eventId: string; ticketTypeId: string; organizer: string; capacity: number },
  now: string
): Promise<"code_invalid" | "code_expired" | "code_attempts"> {
  const counted = await db.execute({
    sql: `UPDATE capacity_codes SET attempts = attempts + 1
          WHERE id = ? AND event_id = ? AND ticket_type_id = ? AND organizer_pollar_id = ?
            AND capacity = ? AND used_at IS NULL AND attempts < ? AND expires_at_utc > ?
          RETURNING attempts`,
    args: [args.challengeId, args.eventId, args.ticketTypeId, args.organizer, args.capacity, MAX_CODE_ATTEMPTS, now],
  });
  if (counted.rows.length > 0) {
    return Number(counted.rows[0].attempts) >= MAX_CODE_ATTEMPTS ? "code_attempts" : "code_invalid";
  }

  // Not a live code for this change: say which, without revealing someone else's challenge.
  const row = await db.execute({
    sql: `SELECT attempts, expires_at_utc, used_at FROM capacity_codes
          WHERE id = ? AND organizer_pollar_id = ? AND event_id = ? AND ticket_type_id = ? AND capacity = ?`,
    args: [args.challengeId, args.organizer, args.eventId, args.ticketTypeId, args.capacity],
  });
  if (row.rows.length === 0 || row.rows[0].used_at) return "code_invalid";
  if (Number(row.rows[0].attempts) >= MAX_CODE_ATTEMPTS) return "code_attempts";
  return String(row.rows[0].expires_at_utc) <= now ? "code_expired" : "code_invalid";
}

