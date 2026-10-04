/**
 * When a payment attempt that left no trace can be written off.
 *
 * Pure on purpose (no database, no browser): "may this person pay again?" is
 * the kind of question that must have a unit test, because a wrong "yes"
 * charges twice.
 *
 * The rule, for a purchase and for a refund alike: the server records the
 * moment someone won the right to send (`pay_started_at` /
 * `refund_started_at`). From then on nobody else sends. The only ways to send
 * again are
 *   1. a rejection proven before anything left (the sender says so, and says
 *      which attempt), or
 *   2. the attempt's own transaction can no longer be accepted by the network,
 *      which is what {@link attemptDeadlineMs} computes.
 * Never "enough time passed since the reservation".
 */

/**
 * The lifetime we ask the network to give the transaction (`timeoutSec` of
 * `runTx`'s options, which the SDK forwards to the build step as the
 * transaction's time bound). A transaction signed after its time bound is
 * refused by Stellar, so an approval prompt left open past this point can
 * never become a payment.
 *
 * Ten minutes, the same window the buyer is promised for the seat hold
 * ("Tu cupo queda reservado 10 minutos", SALE_TTL_MS in app/api/sales/route.ts):
 * a person approving in their wallet never runs out of time before the copy
 * says they would. An abandoned attempt frees the seat after this plus the
 * slack below.
 */
export const ATTEMPT_TX_TIMEOUT_SEC = 10 * 60;

/**
 * Room for the time between taking the claim and the SDK building the
 * transaction (its time bound starts there), for clock drift between our
 * server and the ledger, and for a ledger that closes just after the bound.
 */
export const ATTEMPT_SLACK_MS = 2 * 60 * 1000;

/** The instant after which the attempt started at `startedAtMs` cannot land any more. */
export function attemptDeadlineMs(startedAtMs: number): number {
  return startedAtMs + ATTEMPT_TX_TIMEOUT_SEC * 1000 + ATTEMPT_SLACK_MS;
}

/**
 * - `none`: nobody started an attempt.
 * - `in_flight`: someone did, and its transaction may still be accepted.
 * - `dead`: someone did, and by now the network would refuse it.
 *
 * A start time we cannot read is `in_flight`: when in doubt, nobody sends.
 */
export type AttemptState = "none" | "in_flight" | "dead";

export function attemptState(startedAt: string | null | undefined, now: number): AttemptState {
  if (startedAt === null || startedAt === undefined || startedAt === "") return "none";
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return "in_flight";
  return now > attemptDeadlineMs(started) ? "dead" : "in_flight";
}

export type SaleAttemptView = {
  status: string;
  payStartedAt: string | null;
  expiresAtUtc: string;
};

/**
 * A `pending` sale nobody can pay any more, so its seat can go back: a started
 * attempt whose transaction is dead, or a sale nobody started whose hold is
 * over. (The claim stretches `expires_at_utc` to cover the attempt, so the
 * ordinary sweep never takes a live attempt's seat; this is the early exit for
 * a dead one.)
 */
export function pendingSaleIsDead(sale: SaleAttemptView, now: number): boolean {
  if (sale.status !== "pending") return false;
  const state = attemptState(sale.payStartedAt, now);
  if (state === "dead") return true;
  if (state === "in_flight") return false;
  const expires = Date.parse(sale.expiresAtUtc);
  return !Number.isNaN(expires) && now > expires;
}

/**
 * After a conclusive "no payment for this sale on the chain": may the buyer
 * forget this checkout and start a new one? Yes only when the sale is over
 * (expired, or pending but dead, which the caller then expires) AND its
 * attempt is not in flight. A sale released after a rejection proven in the
 * sender's tab still reads `in_flight` here until its deadline: slower for the
 * person who opened it in a second tab, never wrong.
 */
export function mayStartOver(sale: SaleAttemptView, now: number): boolean {
  const over = sale.status === "expired" || pendingSaleIsDead(sale, now);
  if (!over) return false;
  return attemptState(sale.payStartedAt, now) !== "in_flight";
}
