import { sendWindowSec } from "./pay-attempt.ts";
import { classifySubmit, rejectionReason, type RejectionReason } from "./payments.ts";

/**
 * "Send only if the server says you may", as one function with its I/O
 * injected, so the one property that matters can be tested: a caller that
 * does not win the server's claim never reaches the SDK.
 *
 * A purchase and an organizer's refund both go through it. The claim is the
 * server's (`pay_started_at` / `refund_started_at`, one conditional UPDATE),
 * because a lock that lives in one browser cannot stop a second tab that
 * lacks it, a second browser, or a second device.
 */

/** What the server said to "I am about to send this". */
export type ClaimAnswer<T> =
  /**
   * You may send, and only you. `value` is whatever the claim hands back (a
   * refund's plan). `claimToken` is the proof that you are the winner: only
   * this answer carries it, and handing the claim back needs it.
   * `remainingSec` is the transaction lifetime left on the SERVER's clock at
   * the moment it answered; the transaction is bounded to it (see
   * {@link sendUnderClaim}).
   */
  | { kind: "won"; startedAt: string; claimToken: string; remainingSec: number; value: T }
  /** Someone else already started: look for their payment, never send. */
  | { kind: "held" }
  /**
   * The server refused for another reason (not pending, not yours, over quota).
   * `saleStatus`: what the sale is, when it said (a `paid` sale has a payment to verify).
   */
  | { kind: "refused"; code?: string; error?: string; saleStatus?: string }
  /**
   * No answer. The claim may or may not have been taken, and nothing was
   * sent: the caller must not send, and says so.
   */
  | { kind: "unreachable" };

/** The shape of `runTx`'s answer that this module reads. */
export type SendOutcome = {
  status?: string;
  hash?: string;
  code?: string;
  details?: string;
  message?: string;
};

/** What the winner holds: the attempt it may send, its proof, and the plan the claim handed back. */
export type WonClaim<T> = { startedAt: string; claimToken: string; value: T };

export type ClaimedSend =
  | { kind: "not_claimed"; answer: Exclude<ClaimAnswer<unknown>, { kind: "won" }> }
  /** Provably never left; the claim was handed back. */
  | { kind: "rejected"; reason: RejectionReason; startedAt: string }
  /**
   * Won, but too much of the claim's lifetime was gone by the time the send
   * would have started (the tab sat on the answer). Nothing was sent, and the
   * claim was handed back: the caller says "try again" and starts over.
   */
  | { kind: "stale"; startedAt: string }
  /**
   * Went out, or may have: with the hash when the SDK saw one. Either way the
   * only next step is to look it up (by hash, or by memo), never to send again.
   */
  | { kind: "submitted"; hash?: string; startedAt: string };

export async function sendUnderClaim<T>(deps: {
  claim: () => Promise<ClaimAnswer<T>>;
  /** Written BEFORE `send`: from here on a payment may exist, and a reload must find that out. */
  remember: (won: WonClaim<T>) => void;
  /**
   * Calls the SDK, with the `timeoutSec` it may ask for (see `sendWindowSec`).
   * A throw means the outcome is unknown, never "not sent".
   */
  send: (won: WonClaim<T> & { timeoutSec: number }) => Promise<SendOutcome | undefined>;
  /**
   * Hands the claim back after a rejection proven before sending, or when the
   * claim went stale before it could be used. Needs the claim token. Failures
   * are the caller's to swallow.
   */
  release: (won: WonClaim<T>) => Promise<void>;
  /** Milliseconds clock (tests inject one). Wall-clock on purpose: it must keep counting while a tab is suspended. */
  now?: () => number;
}): Promise<ClaimedSend> {
  const now = deps.now ?? Date.now;
  const answer = await deps.claim();
  // Started the moment the winning answer reached us; `remainingSec` was
  // computed by the server just before it left, so the trip is not counted
  // here (the margin in `sendWindowSec` covers it).
  const receivedAt = now();
  if (answer.kind !== "won") return { kind: "not_claimed", answer };
  const won: WonClaim<T> = { startedAt: answer.startedAt, claimToken: answer.claimToken, value: answer.value };

  // The transaction's time bound starts when the SDK builds it, which is NOW,
  // not when the claim was taken. Bound it to what is left of the claim's own
  // lifetime; if too little is left, do not send at all. Without this a tab
  // that was suspended for twelve minutes could build a fresh ten-minute
  // transaction after another sender had already taken the attempt over.
  const timeoutSec = sendWindowSec(answer.remainingSec, now() - receivedAt);
  if (timeoutSec === null) {
    try {
      await deps.release(won);
    } catch {
      // The attempt's deadline frees it anyway; nothing was sent either way.
    }
    return { kind: "stale", startedAt: won.startedAt };
  }

  // Written BEFORE the SDK is called, and only for an attempt that will be sent.
  deps.remember(won);
  let outcome: SendOutcome | undefined;
  try {
    outcome = await deps.send({ ...won, timeoutSec });
  } catch {
    // Unknown outcome: possibly sent, so the caller only verifies.
  }

  if (classifySubmit(outcome) === "rejected") {
    const reason = rejectionReason(outcome) ?? "other";
    try {
      await deps.release(won);
    } catch {
      // The attempt's deadline frees it anyway; the person is told it failed either way.
    }
    return { kind: "rejected", reason, startedAt: won.startedAt };
  }
  return { kind: "submitted", hash: outcome?.hash, startedAt: won.startedAt };
}

/**
 * The options both `runTx('payment', …)` calls carry: the memo that
 * identifies the sale (or its refund) and the transaction lifetime, so the
 * server can tell when an attempt that left no trace can no longer land (see
 * lib/pay-attempt.ts). `timeoutSec` is the one {@link sendUnderClaim} hands to
 * `send`: what is left of the claim's lifetime, never a fresh full window.
 */
export function paymentOptions(memo: string, timeoutSec: number) {
  return {
    memo: { type: "text" as const, value: memo },
    timeoutSec,
  };
}
