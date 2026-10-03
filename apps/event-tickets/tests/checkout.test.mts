/**
 * The questions that decide whether someone can pay twice: what the SDK's
 * answer proves, when a half-finished checkout may be forgotten, whether a
 * second tab may send, and which wallet balance a refund draws on.
 *
 * Browser APIs are injected (fake locks, fake storage), the SDK outcome is a
 * plain object: nothing here touches a network or a database.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FORGET_GRACE_MS,
  REFUND_FORGET_AFTER_MS,
  canForgetRefundIntent,
  canForgetUnpaid,
  parseInFlight,
  parseRefundIntent,
} from "../lib/checkout.ts";
import { withClaim } from "../lib/claim.ts";
import { classifySubmit, holdsAtLeast } from "../lib/payments.ts";

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

test("a typed refusal or a missing wallet is provably not sent", () => {
  assert.equal(classifySubmit({ status: "error", code: "TX_INSUFFICIENT_FEE" }), "rejected");
  assert.equal(classifySubmit({ status: "error", code: "SDK_TX_FAILED" }), "rejected");
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

// --- When a half-finished checkout may be forgotten ---------------------------

const T0 = Date.parse("2026-10-03T12:00:00Z");
const EXPIRES = new Date(T0 + 10 * 60 * 1000).toISOString();

test("a checkout with no hash is kept while the reservation is still open", () => {
  const record = { saleId: "s1", expiresAtUtc: EXPIRES, at: T0 };
  // One minute in: the payment may simply not be indexed yet.
  assert.equal(canForgetUnpaid(record, T0 + 60_000), false);
  // The hold is over but the grace isn't: a late-accepted submission may still land.
  assert.equal(canForgetUnpaid(record, T0 + 10 * 60_000 + FORGET_GRACE_MS - 1), false);
  assert.equal(canForgetUnpaid(record, T0 + 10 * 60_000 + FORGET_GRACE_MS + 1), true);
});

test("a checkout that has a hash is never forgotten", () => {
  const record = { saleId: "s1", hash: HASH, expiresAtUtc: EXPIRES, at: T0 };
  assert.equal(canForgetUnpaid(record, T0 + 24 * 60 * 60_000), false);
});

test("a legacy record with no deadline can't strand anyone", () => {
  assert.equal(canForgetUnpaid({ saleId: "s1" }, T0), true);
});

test("a record with only a start time falls back to a fixed hold", () => {
  const record = { saleId: "s1", at: T0 };
  assert.equal(canForgetUnpaid(record, T0 + 60_000), false);
  assert.equal(canForgetUnpaid(record, T0 + 30 * 60_000), true);
});

test("stored checkouts are parsed defensively", () => {
  assert.equal(parseInFlight(null), null);
  assert.equal(parseInFlight("not json"), null);
  assert.equal(parseInFlight('{"saleId":""}'), null);
  assert.equal(parseInFlight('{"hash":"x"}'), null);
  assert.deepEqual(parseInFlight(`{"saleId":"s1","hash":"${HASH}","expiresAtUtc":"${EXPIRES}","at":5}`), {
    saleId: "s1",
    hash: HASH,
    expiresAtUtc: EXPIRES,
    at: 5,
  });
  // The shape written before this rule existed still reads.
  assert.deepEqual(parseInFlight('{"saleId":"s1"}'), {
    saleId: "s1",
    hash: undefined,
    expiresAtUtc: undefined,
    at: undefined,
  });
});

test("a refund intent is forgotten only after a long silence and never with a hash", () => {
  const intent = { at: T0 };
  assert.equal(canForgetRefundIntent(intent, T0 + 60_000), false);
  assert.equal(canForgetRefundIntent(intent, T0 + REFUND_FORGET_AFTER_MS + 1), true);
  assert.equal(canForgetRefundIntent({ at: T0, hash: HASH }, T0 + 24 * 60 * 60_000), false);
  assert.deepEqual(parseRefundIntent(`{"at":7,"hash":"${HASH}"}`), { at: 7, hash: HASH });
  assert.equal(parseRefundIntent("nope"), null);
});

// --- Two tabs, one reservation --------------------------------------------------

/** A Web Locks stand-in with the one behaviour we use: ifAvailable. */
function fakeLocks() {
  const held = new Set<string>();
  return {
    request: async (name: string, _o: { ifAvailable: boolean }, cb: (lock: object | null) => Promise<unknown>) => {
      if (held.has(name)) return cb(null);
      held.add(name);
      try {
        return await cb({});
      } finally {
        held.delete(name);
      }
    },
  };
}

function fakeStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    data,
  };
}

test("a second tab cannot send while the first holds the reservation", async () => {
  const locks = fakeLocks();
  let sends = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));

  const first = withClaim(
    "pay:s1",
    async () => {
      sends++;
      await gate;
    },
    { locks }
  );
  // The other tab arrives while the first is mid-payment.
  const second = await withClaim("pay:s1", async () => void sends++, { locks });
  assert.equal(second.held, false);

  release();
  assert.equal((await first).held, true);
  assert.equal(sends, 1);

  // Once the first is done the claim is free again.
  const third = await withClaim("pay:s1", async () => "ok", { locks });
  assert.deepEqual(third, { held: true, value: "ok" });
});

test("different reservations never block each other", async () => {
  const locks = fakeLocks();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const first = withClaim("pay:s1", () => gate, { locks });
  const other = await withClaim("pay:s2", async () => "ok", { locks });
  assert.equal(other.held, true);
  release();
  await first;
});

test("without Web Locks, a live claim in storage still keeps a second tab out", async () => {
  const storage = fakeStorage();
  const now = 1_000_000;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));

  const first = withClaim("pay:s1", () => gate, { locks: null, storage, now: () => now, token: () => "tab-a" });
  // Let the first claim write itself before the second tab looks.
  await Promise.resolve();
  const second = await withClaim("pay:s1", async () => "x", { locks: null, storage, now: () => now, token: () => "tab-b" });
  assert.equal(second.held, false);

  release();
  await first;
  assert.equal(storage.data.size, 0, "the claim is released when the work ends");
});

test("without Web Locks, a claim left by a crashed tab expires", async () => {
  const storage = fakeStorage();
  storage.setItem("pollarpass:claim:pay:s1", JSON.stringify({ token: "dead-tab", at: 1_000_000 }));
  const stale = await withClaim("pay:s1", async () => "ok", {
    locks: null,
    storage,
    now: () => 1_000_000 + 10 * 60_000,
    token: () => "tab-b",
  });
  assert.deepEqual(stale, { held: true, value: "ok" });
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
