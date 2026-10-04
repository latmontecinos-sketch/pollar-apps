import test from "node:test";
import assert from "node:assert/strict";

import { findVerifiedPaymentByMemo, searchSince, verifyPaymentOnHorizon } from "../lib/horizon.ts";
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

/**
 * Looking a payment up by its memo (the buyer closed the tab before we got a
 * hash). The memo is public on the chain, so what comes back is a list of
 * candidates, each of which has to pass the full check on its own.
 */
const BUYER = "GBUYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const DUST_HASH = "d".repeat(64);

type Listed = Json;

/** A payments-list record, the way Horizon returns it with `join=transactions`. */
function listed(hash: string, overrides: Json = {}): Listed {
  return {
    type: "payment",
    paging_token: `pt-${hash.slice(0, 6)}`,
    created_at: new Date().toISOString(),
    transaction_hash: hash,
    from: BUYER,
    to: DESTINATION,
    transaction: { memo: MEMO, memo_type: "text" },
    ...overrides,
  };
}

/**
 * Serves the account's payment pages (by cursor) and each transaction's own
 * lookup. `txs` maps a hash to the transaction + operations Horizon holds.
 */
function stubChain(opts: {
  pages: Listed[][];
  txs?: Record<string, { tx: Json; ops: Json }>;
  failPages?: boolean;
}) {
  let pageRequests = 0;
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.pathname.includes("/payments")) {
      pageRequests++;
      if (opts.failPages) throw new Error("network down");
      const cursor = url.searchParams.get("cursor");
      const index = cursor ? Number(cursor.split("-").pop()) : 0;
      return json({ _embedded: { records: opts.pages[index] ?? [] } });
    }
    const hash = url.pathname.split("/")[2];
    const held = opts.txs?.[hash];
    if (!held) return new Response("not found", { status: 404 });
    return json(url.pathname.endsWith("/operations") ? held.ops : held.tx);
  }) as typeof fetch;
  return { requests: () => pageRequests };
}

const lookup = {
  account: BUYER,
  memo: MEMO,
  destination: DESTINATION,
  amountDecimal: "10.0000000",
};

const realPayment = { tx: transaction(), ops: opsWith(payment()) };

test("a payment is found by its memo when the buyer never sent us the hash", async () => {
  stubChain({ pages: [[listed("b".repeat(64), { transaction: { memo: "pother", memo_type: "text" } }), listed(HASH)]], txs: { [HASH]: realPayment } });
  assert.deepEqual(await findVerifiedPaymentByMemo(lookup), { status: "found", hash: HASH });
});

test("a newer dust payment with the same memo does not hide the real one", async () => {
  // Newest first: the attacker's 1-stroop payment, then the buyer's.
  const dustTx = { tx: transaction(), ops: opsWith(payment({ amount: "0.0000001" })) };
  stubChain({
    pages: [[listed(DUST_HASH), listed(HASH)]],
    txs: { [DUST_HASH]: dustTx, [HASH]: realPayment },
  });
  assert.deepEqual(await findVerifiedPaymentByMemo(lookup), { status: "found", hash: HASH });
});

test("a payment to somebody other than the organizer is never a candidate", async () => {
  // Sent to the buyer with the sale's memo: it must not even be looked at as the purchase.
  stubChain({ pages: [[listed(DUST_HASH, { to: BUYER, from: "GSPAMMERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" })]] });
  assert.deepEqual(await findVerifiedPaymentByMemo(lookup), { status: "none" });
});

test("an account with no payment carrying the memo is none, not an error", async () => {
  stubChain({ pages: [[]] });
  assert.deepEqual(await findVerifiedPaymentByMemo(lookup), { status: "none" });
});

test("Horizon failing is inconclusive, never none", async () => {
  // The caller treats these very differently: none is "you have not paid",
  // inconclusive is "ask me again in a moment".
  stubChain({ pages: [], failPages: true });
  assert.deepEqual(await findVerifiedPaymentByMemo(lookup), { status: "inconclusive" });
});

test("a candidate that can't be read leaves the answer open", async () => {
  // The transaction lookup 404s (not indexed yet): that is not "this isn't ours".
  stubChain({ pages: [[listed(HASH)]], txs: {} });
  assert.deepEqual(await findVerifiedPaymentByMemo(lookup), { status: "inconclusive" });
});

test("history longer than the search is willing to read is inconclusive", async () => {
  // Full pages all the way down, none of them ours: flooding the account
  // must not turn into a confident "no payment".
  const full = (n: number) =>
    Array.from({ length: 200 }, (_, i) =>
      listed(`${n}`.padStart(2, "0") + `${i}`.padStart(62, "0"), { transaction: { memo: "pnoise", memo_type: "text" }, paging_token: `pt-${n + 1}` })
    );
  const stub = stubChain({ pages: [full(0), full(1), full(2), full(3), full(4), full(5)] });
  assert.deepEqual(await findVerifiedPaymentByMemo(lookup), { status: "inconclusive" });
  assert.equal(stub.requests(), 5, "the search is bounded in requests");
});

test("paging stops once the history is older than the sale", async () => {
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const page = Array.from({ length: 200 }, (_, i) =>
    listed(`${i}`.padStart(64, "0"), { transaction: { memo: "pnoise", memo_type: "text" }, created_at: old, paging_token: "pt-1" })
  );
  const stub = stubChain({ pages: [page, page] });
  const result = await findVerifiedPaymentByMemo({ ...lookup, since: Date.now() - 60 * 60 * 1000 });
  assert.deepEqual(result, { status: "none" });
  assert.equal(stub.requests(), 1);
});

test("the search window starts a little before the sale was created", () => {
  const created = "2026-10-03 12:00:00"; // SQLite's datetime('now'), UTC
  const since = searchSince(created);
  assert.ok(since !== undefined);
  assert.equal(since, Date.parse("2026-10-03T12:00:00Z") - 5 * 60 * 1000);
  assert.equal(searchSince("2026-10-03T12:00:00.000Z"), since);
  assert.equal(searchSince("garbage"), undefined);
  assert.equal(searchSince(null), undefined);
});

// --- The search has one budget, shared by every request it makes ---------------

/**
 * Like `stubChain`, but every request costs `costMs` on a fake clock, so the
 * budget can be spent without waiting for it. `fetches` counts all of them.
 */
function stubSlowChain(opts: { pages: Listed[][]; txs: Record<string, { tx: Json; ops: Json }>; costMs: number }) {
  const clock = { ms: 1_000_000 };
  let fetches = 0;
  globalThis.fetch = (async (input: string | URL) => {
    fetches++;
    clock.ms += opts.costMs;
    const url = new URL(String(input));
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.pathname.includes("/payments")) {
      const cursor = url.searchParams.get("cursor");
      const index = cursor ? Number(cursor.split("-").pop()) : 0;
      return json({ _embedded: { records: opts.pages[index] ?? [] } });
    }
    const held = opts.txs[url.pathname.split("/")[2]];
    if (!held) return new Response("not found", { status: 404 });
    return json(url.pathname.endsWith("/operations") ? held.ops : held.tx);
  }) as typeof fetch;
  return { now: () => clock.ms, fetches: () => fetches };
}

const dustChain = { tx: transaction(), ops: opsWith(payment({ amount: "0.0000001" })) };

test("a page full of candidates cannot outlast the search budget", async () => {
  // 100 distinct transactions carrying the memo, none of them ours. Each costs two
  // requests of 6 s; unchecked that is 20 minutes behind one buyer's request.
  const hashes = Array.from({ length: 100 }, (_, i) => `${i}`.padStart(64, "0"));
  const stub = stubSlowChain({
    pages: [hashes.map((hash) => listed(hash))],
    txs: Object.fromEntries(hashes.map((hash) => [hash, dustChain])),
    costMs: 6000,
  });
  const result = await findVerifiedPaymentByMemo({ ...lookup, now: stub.now });
  assert.deepEqual(result, { status: "inconclusive" });
  // The page, then only as many candidates as 20 s allows: a handful of requests, not 201.
  assert.ok(stub.fetches() <= 7, `made ${stub.fetches()} requests`);
});

test("the last request of a search is cut to what is left of the budget", async () => {
  const seen: number[] = [];
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = ((ms: number) => {
    seen.push(ms);
    return realTimeout.call(AbortSignal, ms);
  }) as typeof AbortSignal.timeout;
  try {
    const stub = stubSlowChain({ pages: [[]], txs: {}, costMs: 0 });
    await findVerifiedPaymentByMemo({ ...lookup, now: stub.now, budgetMs: 2500 });
  } finally {
    AbortSignal.timeout = realTimeout;
  }
  assert.deepEqual(seen, [2500], "bounded by the budget, not by the per-request timeout of 6 s");
});

test("a transaction that shows up once per operation is verified once", async () => {
  // One transaction with five payment operations to the same place: five records, one hash.
  const stub = stubSlowChain({
    pages: [Array.from({ length: 5 }, () => listed(DUST_HASH))],
    txs: { [DUST_HASH]: dustChain },
    costMs: 0,
  });
  assert.deepEqual(await findVerifiedPaymentByMemo({ ...lookup, now: stub.now }), { status: "none" });
  // The page, the transaction, its operations: three requests, not eleven.
  assert.equal(stub.fetches(), 3);
});

test("a deduplicated candidate that could not be read still leaves the answer open", async () => {
  const stub = stubSlowChain({
    pages: [[listed(HASH), listed(HASH)]],
    txs: {},
    costMs: 0,
  });
  assert.deepEqual(await findVerifiedPaymentByMemo({ ...lookup, now: stub.now }), { status: "inconclusive" });
});

test("a budget already spent is inconclusive without asking Horizon", async () => {
  const stub = stubSlowChain({ pages: [[listed(HASH)]], txs: { [HASH]: realPayment }, costMs: 0 });
  const result = await findVerifiedPaymentByMemo({ ...lookup, now: stub.now, budgetMs: 0 });
  assert.deepEqual(result, { status: "inconclusive" });
  assert.equal(stub.fetches(), 0);
});
