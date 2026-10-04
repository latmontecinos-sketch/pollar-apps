/**
 * The questions that decide whether someone can pay twice: what the SDK's
 * answer proves, what the browser remembers and for whom, whether a caller
 * that did not win the server's claim can reach the SDK, and which wallet
 * balance a refund draws on.
 *
 * The claim, the SDK and the storage are injected: nothing here touches a
 * network or a database.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkoutKey,
  parseInFlight,
  parseRefundIntent,
  refundKey,
  serializeInFlight,
  serializeRefundIntent,
} from "../lib/checkout.ts";
import { paymentOptions, sendUnderClaim, type ClaimAnswer, type SendOutcome } from "../lib/claimed-send.ts";
import { ATTEMPT_TX_TIMEOUT_SEC, MIN_SEND_WINDOW_SEC, SEND_MARGIN_SEC } from "../lib/pay-attempt.ts";
import { classifySubmit, holdsAtLeast, rejectionReason } from "../lib/payments.ts";

const HASH = "a".repeat(64);
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

// --- What the SDK's answer proves --------------------------------------------

test("an outcome with a hash was seen by the network", () => {
  assert.equal(classifySubmit({ status: "success", hash: HASH }), "sent");
  assert.equal(classifySubmit({ status: "pending", hash: HASH }), "sent");
  // A transaction the network failed still has a hash: Horizon decides what it means.
  assert.equal(classifySubmit({ status: "error", hash: HASH, details: "op_underfunded" }), "sent");
});

test("a lost response is unknown, never 'nothing was charged'", () => {
  // The SDK returns these instead of throwing: submit timed out, fetch failed,
  // a 502 with no body. Any of them can follow a transfer that went through.
  assert.equal(classifySubmit({ status: "error", details: "The operation was aborted due to timeout" }), "unknown");
  assert.equal(classifySubmit({ status: "error", details: "fetch failed" }), "unknown");
  assert.equal(classifySubmit({ status: "error" }), "unknown");
  assert.equal(classifySubmit({ status: "error", code: "INTERNAL", message: "boom" }), "unknown");
  assert.equal(classifySubmit(undefined), "unknown");
  assert.equal(classifySubmit({ status: "pending" }), "unknown");
});

test("a listed refusal or a missing wallet is provably not sent", () => {
  assert.equal(classifySubmit({ status: "error", code: "TX_INSUFFICIENT_FEE" }), "rejected");
  assert.equal(classifySubmit({ status: "error", details: "No wallet connected" }), "rejected");
  assert.equal(
    classifySubmit({ status: "error", details: "Wallet not connected. Reconnect your wallet to sign." }),
    "rejected"
  );
  assert.equal(classifySubmit({ status: "error", details: "User declined access" }), "rejected");
  assert.equal(classifySubmit({ status: "error", details: "The user rejected this request." }), "rejected");
});

test("a server-side 'rejected' is not a person declining", () => {
  assert.equal(classifySubmit({ status: "error", details: "Request rejected (502)" }), "unknown");
});

// --- Which refusals are provably "never left" ---------------------------------

test("only an explicit list of backend codes counts as rejected", () => {
  for (const code of [
    "TX_INSUFFICIENT_BALANCE",
    "TX_INSUFFICIENT_FEE",
    "TX_FEE_LIMIT_EXCEEDED",
    "TX_DESTINATION_NOT_FOUND",
    "TX_NO_TRUSTLINE",
  ]) {
    assert.equal(classifySubmit({ status: "error", code }), "rejected", code);
  }
});

test("a TX_ code outside the list is unknown, because it may follow a submission", () => {
  // A bad sequence is what re-sending a transaction that already landed produces.
  assert.equal(classifySubmit({ status: "error", code: "TX_BAD_SEQUENCE" }), "unknown");
  assert.equal(classifySubmit({ status: "error", code: "TX_CONTRACT_FAILED" }), "unknown");
  assert.equal(classifySubmit({ status: "error", code: "SDK_TX_FAILED" }), "unknown");
  assert.equal(classifySubmit({ status: "error", code: "TX_SOMETHING_NEW" }), "unknown");
  assert.equal(classifySubmit({ status: "error", code: "tx_insufficient_balance" }), "unknown");
});

test("the SDK's own pre-send messages are matched whole, never as a fragment", () => {
  assert.equal(rejectionReason({ status: "error", details: "No wallet connected" }), "noWallet");
  assert.equal(rejectionReason({ status: "error", details: "  no wallet connected " }), "noWallet");
  assert.equal(
    rejectionReason({ status: "error", details: "Wallet not connected. Reconnect your wallet to sign." }),
    "noWallet"
  );
  assert.equal(rejectionReason({ status: "error", details: "missing unsigned transaction" }), "other");
  // The same words inside a longer diagnostic prove nothing.
  assert.equal(
    rejectionReason({ status: "error", details: "submit failed after No wallet connected retry" }),
    null
  );
});

test("a person declining in their wallet is rejected, and says so", () => {
  assert.equal(rejectionReason({ status: "error", details: "User declined access" }), "declined");
  assert.equal(rejectionReason({ status: "error", details: "The user rejected this request." }), "declined");
  // Free text around the words is not a decline.
  assert.equal(
    rejectionReason({ status: "error", details: "gateway said the user rejected this and then timed out upstream" }),
    null
  );
  // A message must be short and start with it.
  assert.equal(rejectionReason({ status: "error", details: "User declined " + "x".repeat(80) }), null);
});

test("an outcome with a hash is never a rejection", () => {
  assert.equal(rejectionReason({ status: "error", hash: HASH, code: "TX_INSUFFICIENT_BALANCE" }), null);
});

test("each rejection maps to a reason the UI has words for", () => {
  assert.equal(rejectionReason({ status: "error", code: "TX_INSUFFICIENT_BALANCE" }), "balance");
  assert.equal(rejectionReason({ status: "error", code: "TX_INSUFFICIENT_FEE" }), "fee");
  assert.equal(rejectionReason({ status: "error", code: "TX_FEE_LIMIT_EXCEEDED" }), "fee");
  assert.equal(rejectionReason({ status: "error", code: "TX_NO_TRUSTLINE" }), "destination");
  assert.equal(rejectionReason({ status: "error", code: "TX_DESTINATION_NOT_FOUND" }), "destination");
});

// --- What the browser remembers, and for whom -----------------------------------

const ALICE = "GALICEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const BOB = "GBOBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

test("the checkout key carries the buyer, so two accounts never share a record", () => {
  const alice = checkoutKey(ALICE, "ev1", "tier1");
  const bob = checkoutKey(BOB, "ev1", "tier1");
  assert.notEqual(alice, bob);
  assert.ok(alice.includes(ALICE) && alice.includes("ev1") && alice.includes("tier1"));
  assert.notEqual(checkoutKey(ALICE, "ev1", "tier1"), checkoutKey(ALICE, "ev1", "tier2"));
  assert.notEqual(refundKey(ALICE, "s1"), refundKey(BOB, "s1"));
});

test("a stored checkout only reads for the account that wrote it", () => {
  const raw = serializeInFlight({ saleId: "s1", hash: HASH, startedAt: "2026-10-03T12:00:00.000Z", at: 5 }, ALICE);
  assert.deepEqual(parseInFlight(raw, ALICE), {
    saleId: "s1",
    hash: HASH,
    startedAt: "2026-10-03T12:00:00.000Z",
    at: 5,
  });
  // Bob signs in on the same browser: Alice's purchase is nothing of his.
  assert.equal(parseInFlight(raw, BOB), null);
  // A record from before the owner existed fails closed once an owner is asked for.
  assert.equal(parseInFlight('{"saleId":"s1"}', ALICE), null);
});

test("stored checkouts are parsed defensively", () => {
  assert.equal(parseInFlight(null), null);
  assert.equal(parseInFlight("not json"), null);
  assert.equal(parseInFlight('{"saleId":""}'), null);
  assert.equal(parseInFlight('{"hash":"x"}'), null);
  assert.equal(parseInFlight("[]"), null);
});

test("a stored refund intent only reads for the account that wrote it", () => {
  const raw = serializeRefundIntent({ at: 7, hash: HASH, startedAt: "2026-10-03T12:00:00.000Z" }, ALICE);
  assert.deepEqual(parseRefundIntent(raw, ALICE), { at: 7, hash: HASH, startedAt: "2026-10-03T12:00:00.000Z" });
  assert.equal(parseRefundIntent(raw, BOB), null);
  assert.equal(parseRefundIntent("nope"), null);
});

// --- Send only if the server says you may --------------------------------------

type Calls = {
  remembered: string[];
  sent: number;
  released: { startedAt: string; claimToken: string }[];
  timeouts: number[];
};

/**
 * The I/O of one attempt, recorded: what the claim said, what the SDK will answer.
 * `sitFor`: how long (ms) the tab holds the claim's answer before the send starts,
 * on an injected clock.
 */
function attempt(opts: {
  answer: ClaimAnswer<{ plan: string }>;
  outcome?: SendOutcome | "throws";
  releaseFails?: boolean;
  sitFor?: number;
}) {
  const calls: Calls = { remembered: [], sent: 0, released: [], timeouts: [] };
  let clock = 1_000_000;
  const run = () =>
    sendUnderClaim({
      claim: async () => opts.answer,
      remember: ({ startedAt }) => void calls.remembered.push(startedAt),
      send: async ({ timeoutSec }) => {
        calls.sent++;
        calls.timeouts.push(timeoutSec);
        if (opts.outcome === "throws") throw new Error("socket closed");
        return opts.outcome;
      },
      release: async ({ startedAt, claimToken }) => {
        calls.released.push({ startedAt, claimToken });
        if (opts.releaseFails) throw new Error("offline");
      },
      // The clock jumps by `sitFor` between the answer arriving and the send being decided.
      now: () => {
        const at = clock;
        clock += opts.sitFor ?? 0;
        return at;
      },
    });
  return { calls, run };
}

const WON: ClaimAnswer<{ plan: string }> = {
  kind: "won",
  startedAt: "T1",
  claimToken: "TOK1",
  remainingSec: ATTEMPT_TX_TIMEOUT_SEC,
  value: { plan: "p" },
};

test("a caller that loses the claim never reaches the SDK", async () => {
  for (const answer of [
    { kind: "held" },
    { kind: "refused", code: "sale_not_pending" },
    { kind: "unreachable" },
  ] as ClaimAnswer<{ plan: string }>[]) {
    const { calls, run } = attempt({ answer, outcome: { status: "success", hash: HASH } });
    const result = await run();
    assert.equal(result.kind, "not_claimed");
    assert.equal(calls.sent, 0, `sent after ${answer.kind}`);
    assert.deepEqual(calls.remembered, [], `remembered after ${answer.kind}`);
    assert.deepEqual(calls.released, []);
  }
});

test("the winner remembers the attempt before the SDK is called", async () => {
  const order: string[] = [];
  await sendUnderClaim({
    claim: async () => WON,
    remember: () => void order.push("remember"),
    send: async () => {
      order.push("send");
      return { status: "success", hash: HASH };
    },
    release: async () => void order.push("release"),
  });
  assert.deepEqual(order, ["remember", "send"]);
});

test("a hash means submitted, and nothing is released", async () => {
  const { calls, run } = attempt({ answer: WON, outcome: { status: "success", hash: HASH } });
  assert.deepEqual(await run(), { kind: "submitted", hash: HASH, startedAt: "T1" });
  assert.deepEqual(calls.released, []);
});

test("a lost answer or a throw is submitted without a hash, never released", async () => {
  for (const outcome of [
    "throws",
    { status: "error", details: "The operation was aborted due to timeout" },
    { status: "error", code: "TX_BAD_SEQUENCE" },
    undefined,
  ] as const) {
    const { calls, run } = attempt({ answer: WON, outcome });
    assert.deepEqual(await run(), { kind: "submitted", hash: undefined, startedAt: "T1" });
    assert.deepEqual(calls.released, [], "an attempt that may have left must keep its claim");
  }
});

test("a proven rejection hands the claim back and names why", async () => {
  const { calls, run } = attempt({ answer: WON, outcome: { status: "error", code: "TX_INSUFFICIENT_BALANCE" } });
  assert.deepEqual(await run(), { kind: "rejected", reason: "balance", startedAt: "T1" });
  // The claim is handed back with the winner's proof: its attempt AND its token.
  assert.deepEqual(calls.released, [{ startedAt: "T1", claimToken: "TOK1" }]);
});

test("a rejection is still a rejection when handing the claim back fails", async () => {
  const { calls, run } = attempt({
    answer: WON,
    outcome: { status: "error", details: "No wallet connected" },
    releaseFails: true,
  });
  assert.deepEqual(await run(), { kind: "rejected", reason: "noWallet", startedAt: "T1" });
  assert.deepEqual(calls.released, [{ startedAt: "T1", claimToken: "TOK1" }]);
});

test("payments carry the memo and exactly the transaction lifetime they are given", () => {
  assert.deepEqual(paymentOptions("p1a2b3c4d5", 123), {
    memo: { type: "text", value: "p1a2b3c4d5" },
    timeoutSec: 123,
  });
});

// --- A transaction is never built later than the claim allows --------------------

test("an attempt sent at once asks for the claim's lifetime less the margin", async () => {
  const { calls, run } = attempt({ answer: WON, outcome: { status: "success", hash: HASH } });
  await run();
  assert.deepEqual(calls.timeouts, [ATTEMPT_TX_TIMEOUT_SEC - SEND_MARGIN_SEC]);
});

test("the longer the tab held the claim, the shorter the transaction it may build", async () => {
  // Two minutes between the answer and the send: the bound shrinks by exactly that.
  const { calls, run } = attempt({ answer: WON, outcome: { status: "success", hash: HASH }, sitFor: 2 * 60_000 });
  await run();
  assert.deepEqual(calls.timeouts, [ATTEMPT_TX_TIMEOUT_SEC - SEND_MARGIN_SEC - 2 * 60]);
});

test("a claim held past its window is never sent: the claim goes back and the caller is told", async () => {
  // Twelve minutes asleep: a fresh ten-minute transaction would outlive the attempt's deadline.
  const { calls, run } = attempt({ answer: WON, outcome: { status: "success", hash: HASH }, sitFor: 12 * 60_000 });
  assert.deepEqual(await run(), { kind: "stale", startedAt: "T1" });
  assert.equal(calls.sent, 0, "the SDK was never reached");
  assert.deepEqual(calls.remembered, [], "nothing in flight is remembered for something never sent");
  assert.deepEqual(calls.released, [{ startedAt: "T1", claimToken: "TOK1" }]);
});

test("the cut-off is the minimum window: just above sends, just below does not", async () => {
  const left = ATTEMPT_TX_TIMEOUT_SEC - SEND_MARGIN_SEC - MIN_SEND_WINDOW_SEC;
  const above = attempt({ answer: WON, outcome: { status: "success", hash: HASH }, sitFor: left * 1000 });
  assert.equal((await above.run()).kind, "submitted");
  assert.deepEqual(above.calls.timeouts, [MIN_SEND_WINDOW_SEC]);
  const below = attempt({ answer: WON, outcome: { status: "success", hash: HASH }, sitFor: (left + 1) * 1000 });
  assert.equal((await below.run()).kind, "stale");
  assert.equal(below.calls.sent, 0);
});

test("a stale claim whose release fails is still not sent", async () => {
  const { calls, run } = attempt({ answer: WON, sitFor: 20 * 60_000, releaseFails: true });
  assert.deepEqual(await run(), { kind: "stale", startedAt: "T1" });
  assert.equal(calls.sent, 0);
});

test("an answer with an unreadable lifetime is not sent", async () => {
  for (const remainingSec of [Number.NaN, Number.POSITIVE_INFINITY * -1, -5, 0]) {
    const { calls, run } = attempt({ answer: { ...WON, remainingSec } as ClaimAnswer<{ plan: string }> });
    assert.equal((await run()).kind, "stale", String(remainingSec));
    assert.equal(calls.sent, 0);
  }
});

// --- A refund draws on the sale's own asset -------------------------------------

const usdc = { code: "USDC", issuer: ISSUER };

test("a refund needs the sale's asset, matched by issuer", () => {
  const balances = [
    { type: "native" as const, code: "XLM", balance: "500.0000000", available: "500.0000000" },
    // Same code, different issuer: not this money.
    { type: "credit_alphanum4" as const, code: "USDC", issuer: "GFAKEISSUER", balance: "999.0000000", available: "999.0000000" },
  ];
  assert.equal(holdsAtLeast(balances, usdc, "10.0000000"), false);
});

test("a refund checks the amount in stroops, not as a float", () => {
  const wallet = (available: string) => [
    { type: "credit_alphanum4" as const, code: "USDC", issuer: ISSUER, balance: available, available },
  ];
  assert.equal(holdsAtLeast(wallet("10.0000000"), usdc, "10.0000000"), true);
  assert.equal(holdsAtLeast(wallet("9.9999999"), usdc, "10.0000000"), false);
  assert.equal(holdsAtLeast(wallet("10000000000.0000001"), usdc, "10000000000.0000002"), false);
});

test("an unreadable balance is unknown, not zero", () => {
  const balances = [
    { type: "credit_alphanum4" as const, code: "USDC", issuer: ISSUER, balance: null, available: null },
  ];
  assert.equal(holdsAtLeast(balances, usdc, "1.0000000"), null);
});
