/**
 * The sale state machine against a real (temporary) libSQL database: seat
 * holds per ticket tier, expiry, late payments and the "one live
 * reservation per buyer" rule that stops one account from holding a whole
 * event hostage.
 *
 * Uses its own file DB, so it never touches dev.db or production.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { after, before, test } from "node:test";

const DB_FILE = `test-sales-${randomUUID()}.db`;
process.env.DATABASE_URL = `file:./${DB_FILE}`;
delete process.env.DATABASE_AUTH_TOKEN;

const { db, dbReady } = await import("../lib/db.ts");
const { expireSale, reserveAndCreateSale, settlePayment, sweepExpiredSales, markRefunded, refundMemo } =
  await import("../lib/sales.ts");
const { createTicketTypes, extendCapacity, listTicketTypes, parseTicketTypes } = await import(
  "../lib/ticket-types.ts"
);

const TTL = 10 * 60 * 1000;

before(async () => {
  await dbReady();
});

after(() => {
  db.close();
  // Windows can still hold the handle for a moment after close(); a leftover
  // file is harmless (it's gitignored), so cleanup never fails the run.
  for (const suffix of ["", "-shm", "-wal"]) {
    try {
      rmSync(`${DB_FILE}${suffix}`, { force: true });
    } catch {
      /* left behind on purpose rather than failing the suite */
    }
  }
});

/** An event plus its tiers — where the seats actually live. */
async function newEvent(
  capacity: number,
  tiers?: { name: string; priceDecimal: string; capacity: number }[]
) {
  const id = randomUUID();
  await db.execute({
    sql: `INSERT INTO events (id, organizer_pollar_id, name, datetime_utc, place, price_stroops, capacity)
          VALUES (?, 'GORG', 'Test', datetime('now'), 'Test', 10000000, ?)`,
    args: [id, capacity],
  });
  await createTicketTypes(id, tiers ?? [{ name: "General", priceDecimal: "1.0000000", capacity }]);
  const types = await listTicketTypes(id);
  return { eventId: id, typeId: types[0].id, types };
}

async function reserved(eventId: string, typeId?: string): Promise<number> {
  const result = await db.execute({
    sql: typeId
      ? "SELECT reserved FROM ticket_types WHERE id = ?"
      : "SELECT COALESCE(sum(reserved), 0) AS reserved FROM ticket_types WHERE event_id = ?",
    args: [typeId ?? eventId],
  });
  return Number(result.rows[0].reserved);
}

function reservation(eventId: string, typeId: string, buyer: string, ttlMs = TTL) {
  return reserveAndCreateSale({
    eventId,
    ticketTypeId: typeId,
    buyerPollarId: buyer,
    reference: `r_${randomUUID()}`,
    amountStroops: 10_000_000n,
    idempotencyKey: `i_${randomUUID()}`,
    ttlMs,
  });
}

test("a reservation holds exactly one seat, and only while it lives", async () => {
  const { eventId, typeId } = await newEvent(3);
  const first = await reservation(eventId, typeId, "GBUYER_A");
  assert.ok(first.ok);
  assert.equal(await reserved(eventId), 1);

  assert.equal((await expireSale(first.sale.id)).expired, true);
  assert.equal(await reserved(eventId), 0, "an expired hold gives the seat back");
  assert.equal((await expireSale(first.sale.id)).expired, false, "expiring twice is a no-op");
  assert.equal(await reserved(eventId), 0);
});

test("one buyer cannot hold more than one seat of the same tier", async () => {
  const { eventId, typeId } = await newEvent(5);
  const buyer = `GBUYER_${randomUUID()}`;
  const first = await reservation(eventId, typeId, buyer);
  for (let i = 0; i < 4; i++) await reservation(eventId, typeId, buyer);
  assert.equal(await reserved(eventId), 1, "repeat taps reuse the same hold");

  const other = await reservation(eventId, typeId, `GOTHER_${randomUUID()}`);
  assert.ok(other.ok);
  assert.equal(await reserved(eventId), 2, "a different buyer still gets their own seat");

  assert.ok(first.ok);
  await expireSale(first.sale.id);
  const again = await reservation(eventId, typeId, buyer);
  assert.ok(again.ok && again.sale.id !== first.sale.id, "after expiry they can reserve again");
});

test("each tier keeps its own price and its own capacity", async () => {
  const { eventId, types } = await newEvent(3, [
    { name: "General", priceDecimal: "0.0200000", capacity: 1 },
    { name: "VIP", priceDecimal: "0.0300000", capacity: 2 },
  ]);
  const [general, vip] = types;
  assert.equal(general.priceDecimal, "0.0200000");
  assert.equal(vip.priceDecimal, "0.0300000");

  // One buyer may hold a seat in each tier: they're separate products.
  const buyer = `GBUYER_${randomUUID()}`;
  assert.ok((await reservation(eventId, general.id, buyer)).ok);
  assert.ok((await reservation(eventId, vip.id, buyer)).ok);
  assert.equal(await reserved(eventId, general.id), 1);
  assert.equal(await reserved(eventId, vip.id), 1);

  const generalFull = await reservation(eventId, general.id, `GOTHER_${randomUUID()}`);
  assert.equal(generalFull.ok, false, "the only General seat was taken");
  assert.ok((await reservation(eventId, vip.id, `GOTHER_${randomUUID()}`)).ok, "VIP is independent");
  assert.equal(await reserved(eventId), 3, "three seats held across both tiers");
});

test("capacity grows, never shrinks, and only twice", async () => {
  const { eventId, typeId } = await newEvent(10);
  assert.deepEqual(await extendCapacity(eventId, typeId, 5), { ok: false, code: "capacity_lower" });
  assert.deepEqual(await extendCapacity(eventId, typeId, 20), { ok: true });
  assert.deepEqual(await extendCapacity(eventId, typeId, 30), { ok: true });
  assert.deepEqual(await extendCapacity(eventId, typeId, 40), { ok: false, code: "capacity_limit" });

  const [type] = await listTicketTypes(eventId);
  assert.equal(type.capacity, 30);
  assert.equal(type.capacityIncreasesLeft, 0);
});

test("tier input is validated before anything is written", () => {
  assert.throws(() => parseTicketTypes([]), /al menos un tipo/);
  assert.throws(() => parseTicketTypes([{ name: "", priceDecimal: "1", capacity: 1 }]), /nombre/);
  assert.throws(
    () =>
      parseTicketTypes([
        { name: "General", priceDecimal: "1", capacity: 1 },
        { name: "general", priceDecimal: "2", capacity: 1 },
      ]),
    /mismo nombre/
  );
  assert.throws(() => parseTicketTypes([{ name: "VIP", priceDecimal: "0", capacity: 1 }]), /mayor a 0/);
  assert.throws(() => parseTicketTypes([{ name: "VIP", priceDecimal: "1", capacity: 0 }]), /cupo/i);

  const parsed = parseTicketTypes([{ name: " VIP ", priceDecimal: "0.03", capacity: 2 }]);
  assert.deepEqual(parsed, [{ name: "VIP", priceDecimal: "0.0300000", capacity: 2 }]);
});

test("an event with every seat held is sold out, until the holds lapse", async () => {
  const { eventId, typeId } = await newEvent(1);
  const taken = await reservation(eventId, typeId, "GBUYER_FIRST");
  assert.ok(taken.ok);
  const denied = await reservation(eventId, typeId, "GBUYER_SECOND");
  assert.equal(denied.ok, false);
  assert.equal(denied.ok === false && denied.reason, "sold_out");
});

test("expired holds are swept even on the same UTC day", async () => {
  const { eventId, typeId } = await newEvent(2);
  // Expired an hour ago: the bug this guards against compared an ISO string
  // against SQLite's "YYYY-MM-DD HH:MM:SS" as text, so nothing expired until
  // the date itself rolled over.
  const stale = await reservation(eventId, typeId, "GBUYER_STALE", -60 * 60 * 1000);
  assert.ok(stale.ok);
  assert.equal(await reserved(eventId), 1);

  const swept = await sweepExpiredSales({ eventId });
  assert.equal(swept, 1);
  assert.equal(await reserved(eventId), 0);
});

test("a payment that lands after expiry becomes unclaimed, never a ticket", async () => {
  const { eventId, typeId } = await newEvent(2);
  const sale = await reservation(eventId, typeId, "GBUYER_LATE");
  assert.ok(sale.ok);
  await expireSale(sale.sale.id);

  const settled = await settlePayment(sale.sale.id, eventId, "hash_late");
  assert.equal(settled.outcome, "unclaimed");

  const tickets = await db.execute({
    sql: "SELECT count(*) AS n FROM tickets WHERE sale_id = ?",
    args: [sale.sale.id],
  });
  assert.equal(Number(tickets.rows[0].n), 0, "no ticket for a seat that was already released");

  // …and the organizer can return it.
  assert.equal((await markRefunded(sale.sale.id, "hash_refund")).refunded, true);
  assert.equal((await markRefunded(sale.sale.id, "hash_refund")).refunded, false, "only once");
  assert.match(refundMemo(sale.sale.reference), /^dev-/);
});

test("settling twice issues the same ticket, not a second one", async () => {
  const { eventId, typeId } = await newEvent(2);
  const sale = await reservation(eventId, typeId, "GBUYER_PAID");
  assert.ok(sale.ok);

  const first = await settlePayment(sale.sale.id, eventId, "hash_ok");
  const second = await settlePayment(sale.sale.id, eventId, "hash_ok");
  assert.equal(first.outcome, "paid");
  assert.equal(second.outcome, "already_paid");
  assert.equal(
    first.outcome === "paid" && second.outcome === "already_paid" && first.ticket.code,
    second.outcome === "already_paid" ? second.ticket.code : undefined
  );
  assert.equal(await reserved(eventId), 1, "a paid seat stays taken");
});
