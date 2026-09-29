/**
 * The two functions that decide whether an entry is valid at the door:
 * issuing a ticket for a paid sale, and spending it there. Against a real
 * (temporary) libSQL database, same as tests/sales.test.mts.
 *
 * Uses its own file DB, so it never touches dev.db or production.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { after, before, test } from "node:test";

const DB_FILE = `test-tickets-${randomUUID()}.db`;
process.env.DATABASE_URL = `file:./${DB_FILE}`;
delete process.env.DATABASE_AUTH_TOKEN;

const { db, dbReady } = await import("../lib/db.ts");
const { generateDoorCode, generateTicketCode, issueTicket, peekAtDoor, validateAtDoor } = await import(
  "../lib/tickets.ts"
);

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

/** A minimal event row — tickets only need `id` to exist for their event_id. */
async function newEvent(): Promise<string> {
  const id = randomUUID();
  await db.execute({
    sql: `INSERT INTO events (id, organizer_pollar_id, name, datetime_utc, place, price_stroops, capacity)
          VALUES (?, 'GORG', 'Test', datetime('now'), 'Test', 10000000, 10)`,
    args: [id],
  });
  return id;
}

/**
 * A minimal paid sale row — `tickets.sale_id` is `REFERENCES sales(id)` and
 * the FK is enforced by this libSQL client, so `issueTicket` needs a real
 * sale to hang the ticket off of, not just any UUID.
 */
async function newSale(eventId: string): Promise<string> {
  const id = randomUUID();
  await db.execute({
    sql: `INSERT INTO sales (id, event_id, buyer_pollar_id, reference, amount_stroops, idempotency_key, status, expires_at_utc)
          VALUES (?, ?, 'GBUYER', ?, 10000000, ?, 'paid', datetime('now', '+10 minutes'))`,
    args: [id, eventId, `r_${randomUUID()}`, `i_${randomUUID()}`],
  });
  return id;
}

async function ticketRow(saleId: string): Promise<Record<string, unknown>> {
  const result = await db.execute({
    sql: "SELECT * FROM tickets WHERE sale_id = ?",
    args: [saleId],
  });
  assert.equal(result.rows.length, 1, `expected exactly one ticket row for sale ${saleId}`);
  return result.rows[0];
}

async function ticketRowCount(saleId: string): Promise<number> {
  const result = await db.execute({
    sql: "SELECT count(*) AS n FROM tickets WHERE sale_id = ?",
    args: [saleId],
  });
  return Number(result.rows[0].n);
}

test("issuing a ticket twice for the same sale returns the same ticket, not a second one", async () => {
  const eventId = await newEvent();
  const saleId = await newSale(eventId);

  const first = await issueTicket(saleId, eventId);
  const second = await issueTicket(saleId, eventId);

  assert.equal(second.id, first.id);
  assert.equal(second.code, first.code);
  assert.equal(second.doorCode, first.doorCode);
  assert.equal(await ticketRowCount(saleId), 1, "the sale_id UNIQUE constraint keeps this to one row");
});

test("peeking at a ticket never spends it", async () => {
  const eventId = await newEvent();
  const saleId = await newSale(eventId);
  const ticket = await issueTicket(saleId, eventId);

  const peek = await peekAtDoor(eventId, ticket.code);
  assert.equal(peek.result, "VALID");
  assert.ok(peek.result === "VALID" && peek.ticket.usedAt === null);

  const row = await ticketRow(saleId);
  assert.equal(row.used_at, null, "used_at must still be NULL after a peek");

  // A real validation afterwards still succeeds — the peek left nothing spent.
  const validated = await validateAtDoor(eventId, ticket.code, "door-staff-1");
  assert.equal(validated.result, "VALID");
});

test("validating a ticket at the door marks it used and hands back the ticket", async () => {
  const eventId = await newEvent();
  const saleId = await newSale(eventId);
  const ticket = await issueTicket(saleId, eventId);

  const result = await validateAtDoor(eventId, ticket.doorCode, "door-staff-2");
  assert.equal(result.result, "VALID");
  assert.ok(result.result === "VALID" && result.ticket.code === ticket.code);

  const row = await ticketRow(saleId);
  assert.ok(row.used_at !== null, "used_at must be set once validated");
  assert.equal(row.used_by, "door-staff-2");
});

test("a used ticket is never accepted twice", async () => {
  const eventId = await newEvent();
  const saleId = await newSale(eventId);
  const ticket = await issueTicket(saleId, eventId);

  const first = await validateAtDoor(eventId, ticket.code, "door-staff-a");
  assert.equal(first.result, "VALID");

  const second = await validateAtDoor(eventId, ticket.code, "door-staff-b");
  assert.equal(second.result, "USED");
  assert.ok(second.result === "USED" && typeof second.usedAt === "string");

  const row = await ticketRow(saleId);
  assert.equal(row.used_by, "door-staff-a", "the rejected second attempt must not overwrite who used it");
  assert.equal(
    second.result === "USED" && second.usedAt,
    row.used_at,
    "the USED result reports the original use, not a new one"
  );
});

test("a code that was never issued reads as unknown", async () => {
  const eventId = await newEvent();
  assert.deepEqual(await peekAtDoor(eventId, "NOPE12345"), { result: "UNKNOWN" });
  assert.deepEqual(await validateAtDoor(eventId, "NOPE12345", "door-staff"), { result: "UNKNOWN" });
});

test("a real code from another event reads as unknown, not as taken", async () => {
  const eventA = await newEvent();
  const eventB = await newEvent();
  const saleId = await newSale(eventA);
  const ticket = await issueTicket(saleId, eventA);

  // Deliberate: this must be indistinguishable from a code that doesn't
  // exist at all — never leak "this code is real, just for another event".
  assert.deepEqual(await peekAtDoor(eventB, ticket.code), { result: "UNKNOWN" });
  assert.deepEqual(await validateAtDoor(eventB, ticket.code, "door-staff"), { result: "UNKNOWN" });

  // And nothing was consumed by the wrong-event attempts — it still works at its own door.
  const stillValid = await validateAtDoor(eventA, ticket.code, "door-staff");
  assert.equal(stillValid.result, "VALID");
});

test("ticket and door codes are the right length and never use an ambiguous character", () => {
  const ambiguous = /[0O1IL]/;
  const alphabet = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]+$/;

  for (let i = 0; i < 1000; i++) {
    const code = generateTicketCode();
    assert.equal(code.length, 26);
    assert.doesNotMatch(code, ambiguous);
    assert.match(code, alphabet);
  }

  for (let i = 0; i < 1000; i++) {
    const doorCode = generateDoorCode();
    assert.equal(doorCode.length, 8);
    assert.doesNotMatch(doorCode, ambiguous);
    assert.match(doorCode, alphabet);
  }
});

test("1000 generated ticket codes never collide", () => {
  const codes = new Set(Array.from({ length: 1000 }, () => generateTicketCode()));
  assert.equal(codes.size, 1000);
});

test("1000 generated door codes never collide", () => {
  const codes = new Set(Array.from({ length: 1000 }, () => generateDoorCode()));
  assert.equal(codes.size, 1000);
});

test("of two simultaneous validations of the same ticket, exactly one wins", async () => {
  const eventId = await newEvent();
  const saleId = await newSale(eventId);
  const ticket = await issueTicket(saleId, eventId);

  const [a, b] = await Promise.all([
    validateAtDoor(eventId, ticket.code, "door-staff-a"),
    validateAtDoor(eventId, ticket.code, "door-staff-b"),
  ]);

  assert.deepEqual([a.result, b.result].sort(), ["USED", "VALID"]);
});
