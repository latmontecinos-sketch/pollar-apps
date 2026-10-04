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
  expireSale,
  markRefunded,
  reopenRefund,
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
  const startedAt = winners[0].outcome === "won" ? winners[0].startedAt : "";
  for (const loser of held) {
    assert.equal(loser.outcome === "held" && loser.startedAt, startedAt);
  }
  assert.equal((await saleRow(sale.id)).pay_started_at, startedAt);
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
  await expireSale(released.id);
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
  assert.equal((await claimPayment(sale.id, "GBUYER1")).outcome, "won");
  assert.equal(await reserved(typeId), 1);

  assert.deepEqual(await expireSale(sale.id), { expired: true });
  assert.deepEqual(await expireSale(sale.id), { expired: false });
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
  await expireSale(sale.id);
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

test("a refund claim is handed back only by the attempt that named it", async () => {
  const sale = await unclaimedSale();
  const won = await claimRefund(sale.id, ORGANIZER);
  assert.equal(won.outcome, "won");
  const startedAt = won.outcome === "won" ? won.startedAt : "";

  // A late "release" from some older attempt changes nothing.
  assert.equal(await reopenRefund(sale.id, ORGANIZER, "2020-01-01T00:00:00.000Z"), false);
  assert.equal((await claimRefund(sale.id, ORGANIZER)).outcome, "held");
  // Nor can someone else's account release it.
  assert.equal(await reopenRefund(sale.id, "GSOMEONEELSE", startedAt), false);

  // The attempt's own rejection does, once.
  assert.equal(await reopenRefund(sale.id, ORGANIZER, startedAt), true);
  assert.equal(await reopenRefund(sale.id, ORGANIZER, startedAt), false);
  assert.equal((await claimRefund(sale.id, ORGANIZER)).outcome, "won");
});

test("a dead refund attempt is taken over by exactly one caller", async () => {
  const sale = await unclaimedSale();
  const won = await claimRefund(sale.id, ORGANIZER, Date.now() - 60 * 60_000);
  assert.equal(won.outcome, "won");
  const old = won.outcome === "won" ? won.startedAt : "";

  // The route has already searched the chain and found nothing; both racers try the swap.
  const swaps = await Promise.all([
    reopenRefund(sale.id, ORGANIZER, old),
    reopenRefund(sale.id, ORGANIZER, old),
    reopenRefund(sale.id, ORGANIZER, old),
  ]);
  assert.equal(swaps.filter(Boolean).length, 1);
  const next = await Promise.all([claimRefund(sale.id, ORGANIZER), claimRefund(sale.id, ORGANIZER)]);
  assert.equal(next.filter((r) => r.outcome === "won").length, 1);
});
