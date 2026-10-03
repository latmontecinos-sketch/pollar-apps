/**
 * An idempotency key names ONE purchase: replaying it returns that sale,
 * and offering it for another event or tier is refused — never an old sale's
 * reference glued to a new destination.
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
const { reserveAndCreateSale } = await import("../lib/sales.ts");
const { createTicketTypes, listTicketTypes } = await import("../lib/ticket-types.ts");

const TTL = 10 * 60 * 1000;

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

async function newEvent(tiers: { name: string; priceDecimal: string; capacity: number }[]) {
  const id = randomUUID();
  await db.execute({
    sql: `INSERT INTO events (id, organizer_pollar_id, name, datetime_utc, place, price_stroops, capacity)
          VALUES (?, 'GORG', 'Test', datetime('now'), 'Test', 10000000, 10)`,
    args: [id],
  });
  await createTicketTypes(id, tiers);
  const types = await listTicketTypes(id);
  return { eventId: id, types };
}

function reserve(eventId: string, ticketTypeId: string, buyer: string, idempotencyKey: string) {
  return reserveAndCreateSale({
    eventId,
    ticketTypeId,
    buyerPollarId: buyer,
    reference: `r_${randomUUID()}`,
    amountStroops: 10_000_000n,
    idempotencyKey,
    ttlMs: TTL,
  });
}

test("replaying a key for the same purchase returns that sale, flagged as reused", async () => {
  const { eventId, types } = await newEvent([{ name: "General", priceDecimal: "1.0000000", capacity: 5 }]);
  const key = `k_${randomUUID()}`;
  const first = await reserve(eventId, types[0].id, "GBUYER", key);
  const again = await reserve(eventId, types[0].id, "GBUYER", key);
  assert.ok(first.ok && again.ok);
  assert.equal(first.sale.id, again.sale.id);
  assert.equal(first.reused, undefined, "a newly held seat is not a reuse");
  assert.equal(again.reused, true, "the client must look for a payment before paying a returning sale");
});

test("a key already used for another event is a conflict, not that event's sale", async () => {
  const a = await newEvent([{ name: "General", priceDecimal: "1.0000000", capacity: 5 }]);
  const b = await newEvent([{ name: "General", priceDecimal: "1.0000000", capacity: 5 }]);
  const key = `k_${randomUUID()}`;
  const first = await reserve(a.eventId, a.types[0].id, "GBUYER", key);
  assert.ok(first.ok);

  const other = await reserve(b.eventId, b.types[0].id, "GBUYER", key);
  assert.deepEqual(other, { ok: false, reason: "key_conflict" });
});

test("a key already used for another tier of the same event is a conflict too", async () => {
  const { eventId, types } = await newEvent([
    { name: "General", priceDecimal: "1.0000000", capacity: 5 },
    { name: "VIP", priceDecimal: "3.0000000", capacity: 5 },
  ]);
  const key = `k_${randomUUID()}`;
  const first = await reserve(eventId, types[0].id, "GBUYER", key);
  assert.ok(first.ok);
  const other = await reserve(eventId, types[1].id, "GBUYER", key);
  assert.deepEqual(other, { ok: false, reason: "key_conflict" });
});

test("a conflicting key holds no seat for the tier it was refused on", async () => {
  const { eventId, types } = await newEvent([
    { name: "General", priceDecimal: "1.0000000", capacity: 5 },
    { name: "VIP", priceDecimal: "3.0000000", capacity: 5 },
  ]);
  const key = `k_${randomUUID()}`;
  await reserve(eventId, types[0].id, "GBUYER", key);
  await reserve(eventId, types[1].id, "GBUYER", key);
  const vip = await db.execute({ sql: "SELECT reserved FROM ticket_types WHERE id = ?", args: [types[1].id] });
  assert.equal(Number(vip.rows[0].reserved), 0);
});

test("someone else's key is still just taken", async () => {
  const { eventId, types } = await newEvent([{ name: "General", priceDecimal: "1.0000000", capacity: 5 }]);
  const key = `k_${randomUUID()}`;
  await reserve(eventId, types[0].id, "GBUYER", key);
  assert.deepEqual(await reserve(eventId, types[0].id, "GSTRANGER", key), { ok: false, reason: "key_taken" });
});
