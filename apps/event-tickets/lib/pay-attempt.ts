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

/**
 * Seconds of transaction lifetime left for the attempt started at
 * `startedAtMs`, on the SERVER's clock: the claim's own `startedAt +
 * ATTEMPT_TX_TIMEOUT_SEC`, never negative. The claim responses carry it so the
 * winner can bound a transaction it builds LATER to the same instant, however
 * long its tab sat between receiving the claim and calling the SDK.
 */
export function txSecondsLeft(startedAtMs: number, nowMs: number): number {
  const left = Math.floor((startedAtMs + ATTEMPT_TX_TIMEOUT_SEC * 1000 - nowMs) / 1000);
  return left > 0 ? left : 0;
}

/**
 * Shorter than this and the winner does not send: a wallet approval needs more
 * than that, and the transaction would be built so close to the claim's end
 * that clock drift alone could carry it past the server's deadline.
 */
export const MIN_SEND_WINDOW_SEC = 30;

/**
 * Taken off the window for the claim response's own travel time (the
 * server's `remainingSec` was computed before the response left, and the
 * client's stopwatch starts when it arrives) and for the SDK's build request.
 * The attempt's slack ({@link ATTEMPT_SLACK_MS}) covers whatever is left.
 */
export const SEND_MARGIN_SEC = 15;

/**
 * The `timeoutSec` the winner may ask the SDK for, or `null` when it must NOT
 * send: `remainingSec` is what the server said was left when it answered, and
 * `elapsedMs` is how long this client has held that answer (a `Date.now()`
 * delta, so it also counts time the tab spent suspended).
 *
 * The transaction's time bound is built from `timeoutSec` at the moment of the
 * SDK call, so asking for `remaining - elapsed - margin` makes it end before
 * `startedAt + ATTEMPT_TX_TIMEOUT_SEC`, which is itself before the server
 * treats the attempt as dead. Anything unreadable is `null`: when in doubt,
 * nobody sends.
 */
export function sendWindowSec(remainingSec: number, elapsedMs: number): number | null {
  if (!Number.isFinite(remainingSec) || !Number.isFinite(elapsedMs)) return null;
  const elapsedSec = Math.max(0, elapsedMs) / 1000;
  const window = Math.floor(Math.min(remainingSec, ATTEMPT_TX_TIMEOUT_SEC) - elapsedSec - SEND_MARGIN_SEC);
  return window >= MIN_SEND_WINDOW_SEC ? window : null;
}

/**
 * The latest `started_at` (ISO UTC) an attempt can have and already be dead at
 * `nowMs`. Guarded UPDATEs compare against it inside their WHERE, so the
 * decision "this attempt is dead" is taken at write time, not read earlier.
 */
export function deadStartedBeforeIso(nowMs: number): string {
  return new Date(nowMs - (ATTEMPT_TX_TIMEOUT_SEC * 1000 + ATTEMPT_SLACK_MS)).toISOString();
}

/**
 * The instant Horizon's ingested history must have passed before an empty
 * memo search may be believed, for the attempt that started at `startedAt`:
 * its deadline, but only when the attempt is DEAD (the one case where "nothing
 * on the chain" lets a second payment, a takeover or a start-over go ahead).
 * `undefined` (no demand on the watermark) for no attempt, an attempt that may
 * still land (the answer decides nothing yet) or a start time we cannot read.
 */
export function historyPastFor(startedAt: string | null | undefined, now: number): number | undefined {
  if (attemptState(startedAt, now) !== "dead") return undefined;
  return attemptDeadlineMs(Date.parse(startedAt as string));
}

/**
 * Everything a search whose "none" might end a checkout decides, taken from ONE
 * instant: `searchStartedAt`, read BEFORE the search begins. Never recomputed
 * after it, because a search can take seconds and an attempt can cross its
 * deadline meanwhile: judged at the end, an attempt that was still in flight
 * when the search started (so no history watermark was demanded) would read as
 * dead and be released on the strength of a "none" that nobody vouched for.
 *
 * - `historyPast`: pass it to the search (see {@link historyPastFor}).
 * - `startOver`: whether that "none" may end the checkout ({@link mayStartOver}).
 *
 * Invariant (tested): `startOver` on a started attempt implies `historyPast` is
 * set, so a release is never authorised without the watermark.
 */
export function releaseGate(
  sale: SaleAttemptView,
  searchStartedAt: number
): { historyPast: number | undefined; startOver: boolean } {
  return {
    historyPast: historyPastFor(sale.payStartedAt, searchStartedAt),
    startOver: mayStartOver(sale, searchStartedAt),
  };
}
