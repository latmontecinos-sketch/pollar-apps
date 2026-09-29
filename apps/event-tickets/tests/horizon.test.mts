import test from "node:test";
import assert from "node:assert/strict";

import { findPaymentHashByMemo, verifyPaymentOnHorizon } from "../lib/horizon.ts";
import { expectedUsdcIssuer } from "../lib/network.ts";

/**
 * The other half of "did they really pay". `lib/tickets.ts` decides whether an
 * entry is valid; this decides whether money arrived, and everything after it
 * — the ticket, the email, the seat — trusts the answer.
 *
 * Horizon is stubbed rather than reached: these assert what the app concludes
 * from a given chain state, which is the part we own. The one rule worth
 * stating out loud is that a network failure must never read as "no payment":
 * the sale stays pending and retryable, it does not get rejected.
 */

const USDC = expectedUsdcIssuer();
const HASH = "a".repeat(64);
const DESTINATION = "GORGANIZERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const MEMO = "p1a2b3c4d5";

type Json = Record<string, unknown>;

/** A payment operation as Horizon returns it, with any field overridden. */
function payment(overrides: Json = {}): Json {
  return {
    type: "payment",
    to: DESTINATION,
    from: "GBUYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    amount: "10.0000000",
    asset_type: "credit_alphanum4",
    asset_code: "USDC",
    asset_issuer: USDC,
    ...overrides,
  };
}

function transaction(overrides: Json = {}): Json {
  return { successful: true, memo: MEMO, memo_type: "text", ...overrides };
}

const realFetch = globalThis.fetch;

/**
 * Answers by path fragment. `null` means 404 (Horizon's "no such thing"),
 * `"boom"` means the request itself fails, which is the case the app has to
 * keep separate from a legitimate mismatch.
 */
function stubHorizon(routes: { tx?: Json | null | "boom"; ops?: Json | null | "boom" }) {
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    const answer = url.includes("/operations") ? routes.ops : routes.tx;
    if (answer === "boom") throw new Error("network down");
    if (answer === null || answer === undefined) {
      return new Response("not found", { status: 404 });
    }
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function opsWith(...records: Json[]): Json {
  return { _embedded: { records } };
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

const sale = {
  hash: HASH,
  destination: DESTINATION,
  amountDecimal: "10.0000000",
  reference: MEMO,
};

test("a payment that matches the sale is accepted", async () => {
  stubHorizon({ tx: transaction(), ops: opsWith(payment()) });
  assert.deepEqual(await verifyPaymentOnHorizon(sale), { ok: true });
});

test("the same amount written differently still matches", async () => {
  // Compared in stroops, not as text and not as a float.
  stubHorizon({ tx: transaction(), ops: opsWith(payment({ amount: "10" })) });
  assert.deepEqual(await verifyPaymentOnHorizon(sale), { ok: true });
});

test("a payment for a different amount is refused", async () => {
  stubHorizon({ tx: transaction(), ops: opsWith(payment({ amount: "9.9999999" })) });
  const result = await verifyPaymentOnHorizon(sale);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, "mismatch");
});

test("a payment carrying another sale's memo is refused", async () => {
  stubHorizon({ tx: transaction({ memo: "pdeadbeef1" }), ops: opsWith(payment()) });
  const result = await verifyPaymentOnHorizon(sale);
  assert.equal(result.ok === false && result.code, "mismatch");
});

test("a memo that is not text is refused", async () => {
  // An id or hash memo that happens to stringify the same is still not ours.
  stubHorizon({ tx: transaction({ memo_type: "id" }), ops: opsWith(payment()) });
  const result = await verifyPaymentOnHorizon(sale);
  assert.equal(result.ok === false && result.code, "mismatch");
});

test("paying in XLM instead of USDC is refused", async () => {
  stubHorizon({
    tx: transaction(),
    ops: opsWith(payment({ asset_type: "native", asset_code: undefined, asset_issuer: undefined })),
  });
  const result = await verifyPaymentOnHorizon(sale);
  assert.equal(result.ok === false && result.code, "mismatch");
});

test("a USDC from an issuer that is not Circle is refused", async () => {
  // Anyone can issue an asset called USDC; only one issuer is money here.
  stubHorizon({
    tx: transaction(),
    ops: opsWith(payment({ asset_issuer: "GFAKEISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" })),
  });
  const result = await verifyPaymentOnHorizon(sale);
  assert.equal(result.ok === false && result.code, "mismatch");
});

test("a payment to somebody else is refused", async () => {
  stubHorizon({
    tx: transaction(),
    ops: opsWith(payment({ to: "GSOMEONEELSEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" })),
  });
  const result = await verifyPaymentOnHorizon(sale);
  assert.equal(result.ok === false && result.code, "mismatch");
});

test("a path payment is not a payment", async () => {
  // Same money, same memo, different operation type: the shape we verify is
  // `payment`, and a strict-send path payment does not qualify.
  stubHorizon({
    tx: transaction(),
    ops: opsWith(payment({ type: "path_payment_strict_send" })),
  });
  const result = await verifyPaymentOnHorizon(sale);
  assert.equal(result.ok === false && result.code, "mismatch");
});

test("the right payment is found among several operations", async () => {
  stubHorizon({
    tx: transaction(),
    ops: opsWith(payment({ amount: "1" }), payment({ type: "create_account" }), payment()),
  });
  assert.deepEqual(await verifyPaymentOnHorizon(sale), { ok: true });
});

test("a transaction the network rejected is reported as failed, not as a mismatch", async () => {
  // It applied no operations, so the buyer was never charged and can retry.
  stubHorizon({ tx: transaction({ successful: false }), ops: opsWith(payment()) });
  const result = await verifyPaymentOnHorizon(sale);
  assert.equal(result.ok === false && result.code, "failed");
});

test("a transaction Horizon has not indexed yet is retryable, never a rejection", async () => {
  stubHorizon({ tx: null, ops: null });
  const result = await verifyPaymentOnHorizon(sale);
  assert.equal(result.ok === false && result.code, "not_found");
});

test("Horizon being unreachable never reads as an unpaid sale", async () => {
  // The distinction the whole module exists for: infrastructure failing is
  // not evidence about the payment. "not_found" keeps the sale pending.
  stubHorizon({ tx: "boom", ops: "boom" });
  const result = await verifyPaymentOnHorizon(sale);
  assert.equal(result.ok === false && result.code, "not_found");
});

test("a hash that is not a hash never reaches the network", async () => {
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const result = await verifyPaymentOnHorizon({ ...sale, hash: "../../etc/passwd" });
  assert.equal(result.ok === false && result.code, "mismatch");
  assert.equal(called, false);
});

test("a payment is found by its memo when the buyer never sent us the hash", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        _embedded: {
          records: [
            { type: "payment", transaction_hash: "b".repeat(64), transaction: { memo: "pother", memo_type: "text" } },
            { type: "payment", transaction_hash: HASH, transaction: { memo: MEMO, memo_type: "text" } },
          ],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )) as typeof fetch;
  assert.equal(await findPaymentHashByMemo({ account: DESTINATION, memo: MEMO }), HASH);
});

test("no payment with that memo is null, while Horizon failing is undefined", async () => {
  // The caller treats these very differently: null is "you have not paid",
  // undefined is "ask me again in a moment".
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ _embedded: { records: [] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  assert.equal(await findPaymentHashByMemo({ account: DESTINATION, memo: MEMO }), null);

  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  assert.equal(await findPaymentHashByMemo({ account: DESTINATION, memo: MEMO }), undefined);
});
