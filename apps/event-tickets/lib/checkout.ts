/**
 * What a checkout (or a refund) remembers between the moment money may have
 * left the account and the moment the server confirms it.
 *
 * Pure on purpose, with no browser or server imports: the one question these
 * answer — "may I let this person send the payment again?" — is exactly the
 * kind that must have a unit test, because a wrong "yes" charges twice.
 */

/**
 * A purchase that may already have money in flight. Its mere existence means
 * "a payment could have been submitted": it is written *before* `runTx`
 * starts and only removed when the outcome is known (a ticket, a failed
 * transaction, a rejection that never reached the network, or a deadline
 * long enough that a late payment is the refund flow's problem, not ours).
 */
export type InFlight = {
  saleId: string;
  /** Known only once the SDK acknowledged the submission. */
  hash?: string;
  /** When the seat hold ends: the earliest moment forgetting it is defensible. */
  expiresAtUtc?: string;
  /** When the payment was started (ms since epoch). */
  at?: number;
};

/**
 * After the hold ends the server stops turning a payment into a ticket (a
 * late one becomes `unclaimed` and is refunded). The grace covers a
 * submission the SDK gave up waiting for but the network still accepted.
 */
export const FORGET_GRACE_MS = 2 * 60 * 1000;

/** Used only when a record carries no deadline of its own. */
const FALLBACK_HOLD_MS = 15 * 60 * 1000;

export function parseInFlight(raw: string | null): InFlight | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (!value || typeof value !== "object") return null;
    if (typeof value.saleId !== "string" || value.saleId === "") return null;
    return {
      saleId: value.saleId,
      hash: typeof value.hash === "string" && value.hash !== "" ? value.hash : undefined,
      expiresAtUtc: typeof value.expiresAtUtc === "string" ? value.expiresAtUtc : undefined,
      at: typeof value.at === "number" && Number.isFinite(value.at) ? value.at : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Is it safe to drop this record and let the person start over? Only when no
 * hash was ever seen and the seat hold is over (plus a grace). One negative
 * lookup on Horizon is never enough: the network may simply not have indexed
 * a payment that was accepted a second ago.
 *
 * A legacy record (written before this rule, with neither deadline nor
 * timestamp) is forgettable at once, so an upgrade can't leave anyone stuck.
 */
export function canForgetUnpaid(inFlight: InFlight, now: number): boolean {
  if (inFlight.hash) return false;
  const expiry = inFlight.expiresAtUtc ? Date.parse(inFlight.expiresAtUtc) : Number.NaN;
  const deadline = Number.isNaN(expiry) ? (inFlight.at ?? 0) + FALLBACK_HOLD_MS : expiry;
  return now > deadline + FORGET_GRACE_MS;
}

/** An organizer's refund that may already be on its way. */
export type RefundIntent = { hash?: string; at: number };

/**
 * A refund has no hold window, so its deadline is a fixed time: long enough
 * for the SDK's submit timeout plus its confirmation polling, with room to
 * spare.
 */
export const REFUND_FORGET_AFTER_MS = 15 * 60 * 1000;

export function parseRefundIntent(raw: string | null): RefundIntent | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (!value || typeof value !== "object") return null;
    const at = typeof value.at === "number" && Number.isFinite(value.at) ? value.at : 0;
    return {
      at,
      hash: typeof value.hash === "string" && value.hash !== "" ? value.hash : undefined,
    };
  } catch {
    return null;
  }
}

/** Same rule as {@link canForgetUnpaid}: no hash, and enough time has passed. */
export function canForgetRefundIntent(intent: RefundIntent, now: number): boolean {
  if (intent.hash) return false;
  return now > intent.at + REFUND_FORGET_AFTER_MS;
}
