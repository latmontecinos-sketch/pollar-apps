/**
 * The server's claims against a real (temporary) libSQL database: the right to
 * pay a reservation and the right to send a refund. One conditional UPDATE
 * decides each, so two tabs, two devices or a stale page can never both win.
 *
 * Uses its own file DB, so it never touches dev.db or production. No payment
 * is sent and nothing here reaches the network.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { after, before, test } from "node:test";

const DB_FILE = `test-attempts-${randomUUID()}.db`;
process.env.DATABASE_URL = `file:./${DB_FILE}`;
delete process.env.DATABASE_AUTH_TOKEN;

const { db, dbReady } = await import("../lib/db.ts");
const {
  claimPayment,
  claimRefund,
  markRefunded,
  releaseIfDead,
  releaseRefundClaim,
  releaseSale,
  reopenDeadRefund,
  reserveAndCreateSale,
  settlePayment,
  sweepExpiredSales,
} = await import("../lib/sales.ts");
const { createTicketTypes, listTicketTypes } = await import("../lib/ticket-types.ts");
const { ATTEMPT_SLACK_MS, ATTEMPT_TX_TIMEOUT_SEC, attemptDeadlineMs } = await import("../lib/pay-attempt.ts");

const TTL = 10 * 60 * 1000;
const ORGANIZER = "GORG";
const HASH = "b".repeat(64);

before(async () => {
  await dbReady();
});

after(() => {
  db.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    try {
      rmSync(`${DB_FILE}${suffix}`, { force: true });
    } catch {
      /* left behind on purpose rather than failing the suite */
    }
  }
});

async function newEvent(capacity = 5, organizer = ORGANIZER) {
  const id = randomUUID();
  await db.execute({
    sql: `INSERT INTO events (id, organizer_pollar_id, name, datetime_utc, place, price_stroops, capacity)
          VALUES (?, ?, 'Test', datetime('now'), 'Test', 10000000, ?)`,
    args: [id, organizer, capacity],
  });
  await createTicketTypes(id, [{ name: "General", priceDecimal: "1.0000000", capacity }]);
  const types = await listTicketTypes(id);
  return { eventId: id, typeId: types[0].id };
}

async function reservation(eventId: string, typeId: string, buyer: string, ttlMs = TTL) {
  const result = await reserveAndCreateSale({
    eventId,
    ticketTypeId: typeId,
    buyerPollarId: buyer,
    reference: `r_${randomUUID()}`,
    amountStroops: 10_000_000n,
    idempotencyKey: `i_${randomUUID()}`,
    ttlMs,
  });
  assert.ok(result.ok);
  return result.sale;
}

async function reserved(typeId: string): Promise<number> {
  const result = await db.execute({ sql: "SELECT reserved FROM ticket_types WHERE id = ?", args: [typeId] });
  return Number(result.rows[0].reserved);
}

async function saleRow(id: string) {
  return (await db.execute({ sql: "SELECT * FROM sales WHERE id = ?", args: [id] })).rows[0];
}

// --- The right to pay a reservation ---------------------------------------------

test("only one of many simultaneous callers wins the right to pay", async () => {
  const { eventId, typeId } = await newEvent();
  const sale = await reservation(eventId, typeId, "GBUYER1");

  // Two tabs, a second device, a double tap: all at once.
  const results = await Promise.all(Array.from({ length: 8 }, () => claimPayment(sale.id, "GBUYER1")));
  const winners = results.filter((r) => r.outcome === "won");
  const held = results.filter((r) => r.outcome === "held");
  assert.equal(winners.length, 1);
  assert.equal(held.length, 7);

  // Everyone who lost is told when the winner started, and it is the same instant.
  const win = winners[0];
  const startedAt = win.outcome === "won" ? win.startedAt : "";
  const claimToken = win.outcome === "won" ? win.claimToken : "";
  for (const loser of held) {
    assert.equal(loser.outcome === "held" && loser.startedAt, startedAt);
    // ...but the proof of who won is the winner's alone: no loser's answer carries it.
    assert.equal("claimToken" in loser, false);
    assert.ok(!JSON.stringify(loser).includes(claimToken));
  }
  assert.equal((await saleRow(sale.id)).pay_started_at, startedAt);
  assert.match(claimToken, /^[0-9a-f]{32}$/);
  assert.equal((await saleRow(sale.id)).pay_claim_token, claimToken);
});

test("the claim is not given back by a later caller, however long it takes", async () => {
  const { eventId, typeId } = await newEvent();
  const sale = await reservation(eventId, typeId, "GBUYER1");
  const first = await claimPayment(sale.id, "GBUYER1", Date.now());
  assert.equal(first.outcome, "won");
  // An hour later, still held: only a rejection the winner proves, or the sale ending, frees it.
  const later = await claimPayment(sale.id, "GBUYER1", Date.now() + 60 * 60_000);
  assert.equal(later.outcome, "held");
});

test("someone else's reservation cannot be claimed", async () => {
  const { eventId, typeId } = await newEvent();
  const sale = await reservation(eventId, typeId, "GBUYER1");
  assert.deepEqual(await claimPayment(sale.id, "GINTRUDER"), { outcome: "forbidden" });
  assert.equal((await saleRow(sale.id)).pay_started_at, null, "a refused claim leaves no trace");
  assert.deepEqual(await claimPayment("no-such-sale", "GBUYER1"), { outcome: "not_found" });
});

test("a sale that is not pending cannot be claimed", async () => {
  const { eventId, typeId } = await newEvent();
  const paid = await reservation(eventId, typeId, "GBUYER1");
  await settlePayment(paid.id, eventId, HASH);
  assert.deepEqual(await claimPayment(paid.id, "GBUYER1"), { outcome: "not_pending", status: "paid" });

  const released = await reservation(eventId, typeId, "GBUYER2");
  await releaseSale(released.id, "GBUYER2");
  assert.deepEqual(await claimPayment(released.id, "GBUYER2"), { outcome: "not_pending", status: "expired" });
});

test("a reservation whose hold is over cannot be claimed, even before the sweep runs", async () => {
  const { eventId, typeId } = await newEvent();
  const sale = await reservation(eventId, typeId, "GBUYER1", -60_000);
  assert.deepEqual(await claimPayment(sale.id, "GBUYER1"), { outcome: "expired" });
  assert.equal((await saleRow(sale.id)).pay_started_at, null);
});

test("winning stretches the hold to the attempt's deadline, so the sweep keeps the seat", async () => {
  const { eventId, typeId } = await newEvent(1);
  // 30 seconds of hold left: shorter than a transaction's lifetime.
  const sale = await reservation(eventId, typeId, "GBUYER1", 30_000);
  const now = Date.now();
  const claim = await claimPayment(sale.id, "GBUYER1", now);
  assert.equal(claim.outcome, "won");

  const row = await saleRow(sale.id);
  assert.equal(
    Date.parse(String(row.expires_at_utc)),
    attemptDeadlineMs(now),
    "expires exactly when the attempt's transaction can no longer land"
  );
  assert.ok(attemptDeadlineMs(now) - now >= (ATTEMPT_TX_TIMEOUT_SEC * 1000 + ATTEMPT_SLACK_MS));

  // The seat stays held: a sweep now takes nothing and the last seat is not for sale.
  assert.equal(await sweepExpiredSales({ eventId }), 0);
  assert.equal(await reserved(typeId), 1);
  const stranger = await reserveAndCreateSale({
    eventId,
    ticketTypeId: typeId,
    buyerPollarId: "GBUYER2",
    reference: `r_${randomUUID()}`,
    amountStroops: 10_000_000n,
    idempotencyKey: `i_${randomUUID()}`,
    ttlMs: TTL,
  });
  assert.deepEqual(stranger, { ok: false, reason: "sold_out" });
});

test("a renewed reservation never shortens a started attempt's hold", async () => {
  const { eventId, typeId } = await newEvent();
  const sale = await reservation(eventId, typeId, "GBUYER1");
  const started = await claimPayment(sale.id, "GBUYER1");
  assert.equal(started.outcome, "won");
  const before = String((await saleRow(sale.id)).expires_at_utc);
  // The same buyer asks for the same event and tier again: the live sale comes back, renewed.
  const again = await reserveAndCreateSale({
    eventId,
    ticketTypeId: typeId,
    buyerPollarId: "GBUYER1",
    reference: `r_${randomUUID()}`,
    amountStroops: 10_000_000n,
    idempotencyKey: `i_${randomUUID()}`,
    ttlMs: 1_000,
  });
  assert.ok(again.ok && again.reused);
  assert.equal(again.ok && again.sale.id, sale.id);
  assert.ok(String((await saleRow(sale.id)).expires_at_utc) >= before);
  // And it comes back saying someone already started paying it.
  assert.ok(again.ok && again.sale.payStartedAt !== null);
});

test("an attempt that is released after a rejection frees the seat once", async () => {
  const { eventId, typeId } = await newEvent(1);
  const sale = await reservation(eventId, typeId, "GBUYER1");
  const won = await claimPayment(sale.id, "GBUYER1");
  assert.equal(won.outcome, "won");
  const proof = won.outcome === "won" ? { startedAt: won.startedAt, claimToken: won.claimToken } : undefined;
  assert.equal(await reserved(typeId), 1);

  assert.deepEqual(await releaseSale(sale.id, "GBUYER1", proof), { outcome: "released" });
  assert.deepEqual(await releaseSale(sale.id, "GBUYER1", proof), { outcome: "kept" });
  assert.equal(await reserved(typeId), 0);
  // The reservation is over: a new one is a new sale, a new memo, a new claim.
  const next = await reservation(eventId, typeId, "GBUYER1");
  assert.notEqual(next.id, sale.id);
  assert.equal((await claimPayment(next.id, "GBUYER1")).outcome, "won");
});

// --- The right to send a refund -------------------------------------------------

/** A late payment: expired, then settled, which is what `unclaimed` means. */
async function unclaimedSale(organizer = ORGANIZER) {
  const { eventId, typeId } = await newEvent(5, organizer);
  const sale = await reservation(eventId, typeId, "GBUYER1");
  await releaseSale(sale.id, "GBUYER1");
  const settled = await settlePayment(sale.id, eventId, HASH);
  assert.equal(settled.outcome, "unclaimed");
  return sale;
}

test("only one of many simultaneous callers wins the right to send a refund", async () => {
  const sale = await unclaimedSale();
  // A page with a plan loaded minutes ago, a second tab and a second device: all at once.
  const results = await Promise.all(Array.from({ length: 8 }, () => claimRefund(sale.id, ORGANIZER)));
  assert.equal(results.filter((r) => r.outcome === "won").length, 1);
  assert.equal(results.filter((r) => r.outcome === "held").length, 7);
  assert.notEqual((await saleRow(sale.id)).refund_started_at, null);
});

test("a refund claim belongs to the sale's organizer", async () => {
  const sale = await unclaimedSale();
  assert.deepEqual(await claimRefund(sale.id, "GSOMEONEELSE"), { outcome: "forbidden" });
  assert.equal((await saleRow(sale.id)).refund_started_at, null, "a refused claim leaves no trace");
  assert.deepEqual(await claimRefund("no-such-sale", ORGANIZER), { outcome: "not_found" });
});

test("only an unclaimed sale can be refunded", async () => {
  const { eventId, typeId } = await newEvent();
  const pending = await reservation(eventId, typeId, "GBUYER1");
  assert.deepEqual(await claimRefund(pending.id, ORGANIZER), { outcome: "not_unclaimed", status: "pending" });

  const sale = await unclaimedSale();
  assert.equal((await claimRefund(sale.id, ORGANIZER)).outcome, "won");
  await markRefunded(sale.id, HASH);
  assert.deepEqual(await claimRefund(sale.id, ORGANIZER), { outcome: "not_unclaimed", status: "refunded" });
});

test("a refund claim is handed back only by the winner: its attempt AND its token", async () => {
  const sale = await unclaimedSale();
  const won = await claimRefund(sale.id, ORGANIZER);
  assert.equal(won.outcome, "won");
  const startedAt = won.outcome === "won" ? won.startedAt : "";
  const claimToken = won.outcome === "won" ? won.claimToken : "";

  // A late "release" from some older attempt changes nothing.
  assert.equal(await releaseRefundClaim(sale.id, ORGANIZER, "2020-01-01T00:00:00.000Z", claimToken), false);

  // The loser's answer says someone started, with no proof of who.
  const loser = await claimRefund(sale.id, ORGANIZER);
  assert.equal(loser.outcome, "held");
  assert.equal("claimToken" in loser, false);
  // Another organizer session that learned the timestamp (from the loser's answer) still cannot reopen it.
  assert.equal(await releaseRefundClaim(sale.id, ORGANIZER, startedAt, "not-the-token"), false);
  assert.equal(await releaseRefundClaim(sale.id, ORGANIZER, startedAt, ""), false);
  assert.equal((await claimRefund(sale.id, ORGANIZER)).outcome, "held", "still held after every wrong release");
  // Nor can someone else's account release it, token and all.
  assert.equal(await releaseRefundClaim(sale.id, "GSOMEONEELSE", startedAt, claimToken), false);

  // The winner's own rejection does, once.
  assert.equal(await releaseRefundClaim(sale.id, ORGANIZER, startedAt, claimToken), true);
  assert.equal(await releaseRefundClaim(sale.id, ORGANIZER, startedAt, claimToken), false);
  assert.equal((await saleRow(sale.id)).refund_claim_token, null, "the old token dies with the claim");
  assert.equal((await claimRefund(sale.id, ORGANIZER)).outcome, "won");
});

test("a live refund attempt cannot be taken over, whatever the caller says it saw", async () => {
  const sale = await unclaimedSale();
  const won = await claimRefund(sale.id, ORGANIZER);
  const startedAt = won.outcome === "won" ? won.startedAt : "";
  // Right timestamp, wrong time: its transaction can still land.
  assert.equal(await reopenDeadRefund(sale.id, ORGANIZER, startedAt), false);
  // The boundary itself still counts as alive; a moment after it, the attempt is dead.
  const deadline = attemptDeadlineMs(Date.parse(startedAt));
  assert.equal(await reopenDeadRefund(sale.id, ORGANIZER, startedAt, deadline), false);
  assert.equal((await claimRefund(sale.id, ORGANIZER)).outcome, "held");
  assert.equal(await reopenDeadRefund(sale.id, ORGANIZER, startedAt, deadline + 2_000), true);
});

test("a dead refund attempt is taken over by exactly one caller", async () => {
  const sale = await unclaimedSale();
  const won = await claimRefund(sale.id, ORGANIZER, Date.now() - 60 * 60_000);
  assert.equal(won.outcome, "won");
  const old = won.outcome === "won" ? won.startedAt : "";

  // The route has already searched the chain and found nothing; both racers try the swap.
  const swaps = await Promise.all([
    reopenDeadRefund(sale.id, ORGANIZER, old),
    reopenDeadRefund(sale.id, ORGANIZER, old),
    reopenDeadRefund(sale.id, ORGANIZER, old),
  ]);
  assert.equal(swaps.filter(Boolean).length, 1);
  const next = await Promise.all([claimRefund(sale.id, ORGANIZER), claimRefund(sale.id, ORGANIZER)]);
  assert.equal(next.filter((r) => r.outcome === "won").length, 1);
});

// --- Handing a purchase's seat back: only with proof once an attempt started -----

test("before any attempt, the buyer can give the seat back with no proof", async () => {
  const { eventId, typeId } = await newEvent(2);
  const sale = await reservation(eventId, typeId, "GBUYER1");
  assert.deepEqual(await releaseSale(sale.id, "GINTRUDER"), { outcome: "forbidden" });
  assert.deepEqual(await releaseSale("no-such-sale", "GBUYER1"), { outcome: "not_found" });
  assert.equal(await reserved(typeId), 1);
  assert.deepEqual(await releaseSale(sale.id, "GBUYER1"), { outcome: "released" });
  assert.equal(await reserved(typeId), 0);
});

test("once an attempt started, no release works without the winner's token and attempt", async () => {
  const { eventId, typeId } = await newEvent(2);
  const sale = await reservation(eventId, typeId, "GBUYER1");
  const won = await claimPayment(sale.id, "GBUYER1");
  assert.equal(won.outcome, "won");
  if (won.outcome !== "won") return;

  // The abandoned-checkout shape (no proof) no longer releases a started attempt: a buyer who
  // already sent the payment cannot free the seat by posting /release before confirmation.
  assert.deepEqual(await releaseSale(sale.id, "GBUYER1"), { outcome: "kept" });
  // A loser's view of the attempt (it knows `startedAt`, never the token) is not enough.
  const loser = await claimPayment(sale.id, "GBUYER1");
  assert.equal(loser.outcome, "held");
  const learned = loser.outcome === "held" ? loser.startedAt : "";
  assert.deepEqual(await releaseSale(sale.id, "GBUYER1", { startedAt: learned, claimToken: "guess" }), {
    outcome: "kept",
  });
  assert.deepEqual(await releaseSale(sale.id, "GBUYER1", { startedAt: learned, claimToken: "" }), {
    outcome: "kept",
  });
  // The right token for another attempt's timestamp does not work either.
  assert.deepEqual(
    await releaseSale(sale.id, "GBUYER1", { startedAt: "2020-01-01T00:00:00.000Z", claimToken: won.claimToken }),
    { outcome: "kept" }
  );
  // Someone else's account, even with the winner's proof, is forbidden.
  assert.deepEqual(
    await releaseSale(sale.id, "GINTRUDER", { startedAt: won.startedAt, claimToken: won.claimToken }),
    { outcome: "forbidden" }
  );
  assert.equal(await reserved(typeId), 1, "every wrong release left the seat held");
  assert.equal((await saleRow(sale.id)).status, "pending");

  assert.deepEqual(
    await releaseSale(sale.id, "GBUYER1", { startedAt: won.startedAt, claimToken: won.claimToken }),
    { outcome: "released" }
  );
  assert.equal(await reserved(typeId), 0);
});

test("a paid sale is never released, with proof or without", async () => {
  const { eventId, typeId } = await newEvent();
  const sale = await reservation(eventId, typeId, "GBUYER1");
  const won = await claimPayment(sale.id, "GBUYER1");
  await settlePayment(sale.id, eventId, HASH);
  const proof = won.outcome === "won" ? { startedAt: won.startedAt, claimToken: won.claimToken } : undefined;
  assert.deepEqual(await releaseSale(sale.id, "GBUYER1", proof), { outcome: "kept" });
  assert.equal((await saleRow(sale.id)).status, "paid");
});

// --- Expiring a sale at write time (confirm, sweep) -----------------------------

test("a claim taken after confirm read the sale survives the expiry confirm then asks for", async () => {
  const { eventId, typeId } = await newEvent(1);
  // Confirm reads an unstarted sale whose hold has seconds left...
  const sale = await reservation(eventId, typeId, "GBUYER1", 5_000);
  const observed = (await saleRow(sale.id)).pay_started_at;
  assert.equal(observed, null);
  // ...and while it waits on Horizon another tab wins /pay, which also stretches the hold.
  const claim = await claimPayment(sale.id, "GBUYER1");
  assert.equal(claim.outcome, "won");
  // Horizon answers "none" once the ORIGINAL hold is over: confirm judges by the stale row and asks to expire.
  const later = Date.now() + 5 * 60_000;
  assert.deepEqual(await releaseIfDead(sale.id, null, later), { released: false });
  assert.equal((await saleRow(sale.id)).status, "pending", "the live sender keeps its sale");
  assert.equal(await reserved(typeId), 1, "and its seat");
});

test("a hold that is truly over, with nobody started, is released exactly once", async () => {
  const { eventId, typeId } = await newEvent(2);
  const keep = await reservation(eventId, typeId, "GBUYER2");
  const sale = await reservation(eventId, typeId, "GBUYER1", -60_000);
  assert.equal(await reserved(typeId), 2);
  assert.deepEqual(await releaseIfDead(sale.id, null), { released: true });
  // Asking again changes nothing, and the answer still says the checkout is over.
  assert.deepEqual(await releaseIfDead(sale.id, null), { released: true });
  assert.equal(await reserved(typeId), 1, "one seat given back, not two");
  // A hold that is not over is not released.
  assert.deepEqual(await releaseIfDead(keep.id, null), { released: false });
  assert.equal((await saleRow(keep.id)).status, "pending");
});

test("a dead attempt is expired only if the caller still names that very attempt", async () => {
  const { eventId, typeId } = await newEvent(2);
  const sale = await reservation(eventId, typeId, "GBUYER1");
  // Started an hour ago: its transaction is long dead.
  const old = Date.now() - 60 * 60_000;
  const won = await claimPayment(sale.id, "GBUYER1", old);
  assert.equal(won.outcome, "won");
  const startedAt = won.outcome === "won" ? won.startedAt : "";

  // A caller that read some other start time (a stale or foreign read) expires nothing.
  assert.deepEqual(await releaseIfDead(sale.id, "2020-01-01T00:00:00.000Z"), { released: false });
  assert.deepEqual(await releaseIfDead(sale.id, null), { released: false }, "it read 'nobody started', no longer true");
  assert.equal((await saleRow(sale.id)).status, "pending");
  // The attempt it did read, dead, goes.
  assert.deepEqual(await releaseIfDead(sale.id, startedAt), { released: true });
  assert.equal((await saleRow(sale.id)).status, "expired");
  assert.equal(await reserved(typeId), 0);
});

test("an attempt that can still land is never expired, even when its hold reads over", async () => {
  const { eventId, typeId } = await newEvent(2);
  const sale = await reservation(eventId, typeId, "GBUYER1");
  const now = Date.now();
  const won = await claimPayment(sale.id, "GBUYER1", now);
  const startedAt = won.outcome === "won" ? won.startedAt : "";
  const deadline = attemptDeadlineMs(now);
  assert.deepEqual(await releaseIfDead(sale.id, startedAt, deadline), { released: false }, "the deadline itself is alive");
  assert.deepEqual(await releaseIfDead(sale.id, startedAt, deadline + 2_000), { released: true });
});

test("a sale released by its own winner still reads 'not over' while its transaction can land", async () => {
  const { eventId, typeId } = await newEvent(2);
  const sale = await reservation(eventId, typeId, "GBUYER1");
  const won = await claimPayment(sale.id, "GBUYER1");
  assert.equal(won.outcome, "won");
  if (won.outcome !== "won") return;
  await releaseSale(sale.id, "GBUYER1", { startedAt: won.startedAt, claimToken: won.claimToken });
  // `released` is read from the sale as it is now: expired, but the attempt is in flight until its deadline.
  assert.deepEqual(await releaseIfDead(sale.id, won.startedAt), { released: false });
  assert.deepEqual(await releaseIfDead(sale.id, won.startedAt, attemptDeadlineMs(Date.now()) + 2_000), {
    released: true,
  });
});

test("the sweep re-checks the expiry at write time: a hold stretched after its SELECT keeps its sale", async () => {
  const { eventId, typeId } = await newEvent(1);
  const sale = await reservation(eventId, typeId, "GBUYER1", -60_000);
  assert.equal(await reserved(typeId), 1);

  // Between the sweep's SELECT (it sees the sale as stale) and its UPDATE, another tab wins
  // /pay, which sets the start and stretches the hold. Interleaved deterministically here.
  const realExecute = db.execute.bind(db);
  let interleaved = false;
  (db as { execute: unknown }).execute = async (stmt: string | { sql: string; args?: unknown }) => {
    const result = await realExecute(stmt as Parameters<typeof realExecute>[0]);
    const sql = typeof stmt === "string" ? stmt : stmt.sql;
    if (!interleaved && /SELECT sales\.id FROM sales/.test(sql)) {
      interleaved = true;
      const now = Date.now();
      await realExecute({
        sql: "UPDATE sales SET pay_started_at = ?, pay_claim_token = 'tok', expires_at_utc = ? WHERE id = ?",
        args: [new Date(now).toISOString(), new Date(attemptDeadlineMs(now)).toISOString(), sale.id],
      });
    }
    return result;
  };
  let swept: number;
  try {
    swept = await sweepExpiredSales({ eventId });
  } finally {
    (db as { execute: unknown }).execute = realExecute;
  }
  assert.equal(interleaved, true, "the race was actually staged");
  assert.equal(swept, 0);
  assert.equal((await saleRow(sale.id)).status, "pending");
  assert.equal(await reserved(typeId), 1);
});

test("the sweep never takes a sale whose attempt can still land, whatever its hold says", async () => {
  const { eventId, typeId } = await newEvent(1);
  const sale = await reservation(eventId, typeId, "GBUYER1");
  assert.equal((await claimPayment(sale.id, "GBUYER1")).outcome, "won");
  // A hold that reads over while the attempt is alive (an arithmetic that should never happen,
  // which is why the sweep does not rely on it).
  await db.execute({
    sql: "UPDATE sales SET expires_at_utc = ? WHERE id = ?",
    args: [new Date(Date.now() - 60_000).toISOString(), sale.id],
  });
  assert.equal(await sweepExpiredSales({ eventId }), 0);
  assert.equal(await reserved(typeId), 1);
  // Once the attempt is dead too, it goes.
  await db.execute({
    sql: "UPDATE sales SET pay_started_at = ? WHERE id = ?",
    args: [new Date(Date.now() - 60 * 60_000).toISOString(), sale.id],
  });
  assert.equal(await sweepExpiredSales({ eventId }), 1);
  assert.equal(await reserved(typeId), 0);
});
