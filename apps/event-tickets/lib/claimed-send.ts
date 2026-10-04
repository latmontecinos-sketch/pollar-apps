import { ATTEMPT_TX_TIMEOUT_SEC } from "./pay-attempt.ts";
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
  /** You may send, and only you. `value` is whatever the claim hands back (a refund's plan). */
  | { kind: "won"; startedAt: string; value: T }
  /** Someone else already started: look for their payment, never send. */
  | { kind: "held"; startedAt?: string }
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

export type ClaimedSend =
  | { kind: "not_claimed"; answer: Exclude<ClaimAnswer<unknown>, { kind: "won" }> }
  /** Provably never left; the claim was handed back. */
  | { kind: "rejected"; reason: RejectionReason; startedAt: string }
  /**
   * Went out, or may have: with the hash when the SDK saw one. Either way the
   * only next step is to look it up (by hash, or by memo), never to send again.
   */
  | { kind: "submitted"; hash?: string; startedAt: string };

export async function sendUnderClaim<T>(deps: {
  claim: () => Promise<ClaimAnswer<T>>;
  /** Written BEFORE `send`: from here on a payment may exist, and a reload must find that out. */
  remember: (won: { startedAt: string; value: T }) => void;
  /** Calls the SDK. A throw means the outcome is unknown, never "not sent". */
  send: (won: { startedAt: string; value: T }) => Promise<SendOutcome | undefined>;
  /** Hands the claim back after a rejection proven before sending. Failures are the caller's to swallow. */
  release: (won: { startedAt: string; value: T }) => Promise<void>;
}): Promise<ClaimedSend> {
  const answer = await deps.claim();
  if (answer.kind !== "won") return { kind: "not_claimed", answer };
  const won = { startedAt: answer.startedAt, value: answer.value };

  deps.remember(won);
  let outcome: SendOutcome | undefined;
  try {
    outcome = await deps.send(won);
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
 * identifies the sale (or its refund) and a bounded transaction lifetime, so
 * the server can tell when an attempt that left no trace can no longer land
 * (see lib/pay-attempt.ts).
 */
export function paymentOptions(memo: string) {
  return {
    memo: { type: "text" as const, value: memo },
    timeoutSec: ATTEMPT_TX_TIMEOUT_SEC,
  };
}
