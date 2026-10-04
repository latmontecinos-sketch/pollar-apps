/**
 * What a checkout (or a refund) remembers in the browser while money may be
 * in flight.
 *
 * Pure on purpose, with no browser or server imports. This memory is a
 * convenience for resuming after a reload (the sale to verify, the hash if the
 * SDK gave one); it decides nothing about whether anyone may pay again. That
 * is the server's call: the claim on the sale (`pay_started_at`) and the
 * verdict in the `no_payment` answer (see lib/pay-attempt.ts).
 */

/**
 * A purchase that may already have money in flight. Written *before* `runTx`
 * starts and removed only when the server says the checkout is over: a
 * ticket, a failed transaction, a rejection proven before sending, or a sale
 * whose attempt can no longer land.
 */
export type InFlight = {
  saleId: string;
  /** Known only once the SDK acknowledged the submission. */
  hash?: string;
  /** The server's `pay_started_at` for this attempt. */
  startedAt?: string;
  /** When the payment was started in this browser (ms since epoch). */
  at?: number;
};

/**
 * One in-flight checkout per account and tier. The buyer's address is part of
 * the key: another person signing in on the same browser must not inherit (or
 * be blocked by) someone else's half-finished purchase.
 */
export function checkoutKey(address: string, eventId: string, ticketTypeId: string): string {
  return `pollarpass:compra:${address}:${eventId}:${ticketTypeId}`;
}

/** One refund in flight per account and sale. */
export function refundKey(address: string, saleId: string): string {
  return `pollarpass:reembolso:${address}:${saleId}`;
}

/**
 * Reads a stored checkout. `owner` is the account asking: a record written
 * for another account reads as nothing, even if it somehow sits under this
 * key (the address is in the key and in the record, so either can fail safe).
 */
export function parseInFlight(raw: string | null, owner?: string): InFlight | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (!value || typeof value !== "object") return null;
    if (typeof value.saleId !== "string" || value.saleId === "") return null;
    if (owner !== undefined && value.owner !== owner) return null;
    return {
      saleId: value.saleId,
      hash: typeof value.hash === "string" && value.hash !== "" ? value.hash : undefined,
      startedAt: typeof value.startedAt === "string" ? value.startedAt : undefined,
      at: typeof value.at === "number" && Number.isFinite(value.at) ? value.at : undefined,
    };
  } catch {
    return null;
  }
}

export function serializeInFlight(value: InFlight, owner: string): string {
  return JSON.stringify({ ...value, owner });
}

/** An organizer's refund that may already be on its way. */
export type RefundIntent = {
  hash?: string;
  /** The server's `refund_started_at` for this attempt. */
  startedAt?: string;
  at: number;
};

export function parseRefundIntent(raw: string | null, owner?: string): RefundIntent | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (!value || typeof value !== "object") return null;
    if (owner !== undefined && value.owner !== owner) return null;
    return {
      at: typeof value.at === "number" && Number.isFinite(value.at) ? value.at : 0,
      hash: typeof value.hash === "string" && value.hash !== "" ? value.hash : undefined,
      startedAt: typeof value.startedAt === "string" ? value.startedAt : undefined,
    };
  } catch {
    return null;
  }
}

export function serializeRefundIntent(value: RefundIntent, owner: string): string {
  return JSON.stringify({ ...value, owner });
}
