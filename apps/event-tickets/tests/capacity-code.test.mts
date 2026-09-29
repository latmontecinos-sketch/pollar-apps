/**
 * Raising capacity by email code (lib/capacity-code.ts). What each test pins
 * is something that would let seats be added without the organizer's inbox,
 * or lock a real organizer out of adding them.
 *
 * The code is read straight from `requestCapacityCode`'s return value — the
 * route emails it; nothing here sends mail.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { after, before, test } from "node:test";

const DB_FILE = `test-capacity-code-${randomUUID()}.db`;
process.env.DATABASE_URL = `file:./${DB_FILE}`;
delete process.env.DATABASE_AUTH_TOKEN;

const { db, dbReady } = await import("../lib/db.ts");
const { createTicketTypes, listTicketTypes } = await import("../lib/ticket-types.ts");
const { CODE_TTL_MS, MAX_CODE_ATTEMPTS, confirmCapacityCode, requestCapacityCode } = await import(
  "../lib/capacity-code.ts"
);
const { purgeStaleOrganizerData } = await import("../lib/retention.ts");

before(async () => {
  await dbReady();
});

after(() => {
  db.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    try {
      rmSync(`${DB_FILE}${suffix}`, { force: true });
    } catch {
      /* a leftover file is gitignored and harmless */
    }
  }
});

async function newEvent(capacity = 10) {
  const eventId = randomUUID();
  const organizer = `GORG_${randomUUID()}`;
  await db.execute({
    sql: `INSERT INTO events (id, organizer_pollar_id, name, datetime_utc, place, price_stroops, capacity)
          VALUES (?, ?, 'Test', datetime('now', '+7 days'), 'La Paz', 10000000, ?)`,
    args: [eventId, organizer, capacity],
  });
  await createTicketTypes(eventId, [{ name: "General", priceDecimal: "1.0000000", capacity }]);
  const [type] = await listTicketTypes(eventId);
  return { eventId, ticketTypeId: type.id, organizer };
}

async function capacityOf(eventId: string): Promise<number> {
  const [type] = await listTicketTypes(eventId);
  return type.capacity;
}

async function issue(ev: Awaited<ReturnType<typeof newEvent>>, capacity: number, offeredEmail: string | null = "org@example.com") {
  const request = await requestCapacityCode({ ...ev, capacity, offeredEmail });
  assert.ok(request.ok, `code for ${capacity} was refused: ${JSON.stringify(request)}`);
  return request;
}

/** A six-digit code that is certainly not `code`. */
const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

test("the right code raises capacity, once", async () => {
  const ev = await newEvent(10);
  const { challengeId, code, email } = await issue(ev, 25);
  assert.match(code, /^\d{6}$/);
  assert.equal(email, "org@example.com");

  assert.deepEqual(await confirmCapacityCode({ ...ev, capacity: 25, challengeId, code }), {
    ok: true,
    capacity: 25,
  });
  assert.equal(await capacityOf(ev.eventId), 25);

  // Spent: replaying it (a double tap, a lifted request) adds nothing.
  assert.deepEqual(await confirmCapacityCode({ ...ev, capacity: 25, challengeId, code }), {
    ok: false,
    code: "code_invalid",
  });
});

test("nothing changes without the code", async () => {
  const ev = await newEvent(10);
  const { challengeId, code } = await issue(ev, 30);
  const result = await confirmCapacityCode({ ...ev, capacity: 30, challengeId, code: wrong(code) });
  assert.deepEqual(result, { ok: false, code: "code_invalid" });
  assert.equal(await capacityOf(ev.eventId), 10);
});

test("a code only confirms the exact change it was sent for", async () => {
  const ev = await newEvent(10);
  const { challengeId, code } = await issue(ev, 20);

  // Same code, bigger number: the email said 20, so 2000 is not what was confirmed.
  assert.equal((await confirmCapacityCode({ ...ev, capacity: 2000, challengeId, code })).ok, false);
  // Same code, another organizer's session.
  assert.equal(
    (await confirmCapacityCode({ ...ev, organizer: "GSOMEONE_ELSE", capacity: 20, challengeId, code })).ok,
    false
  );
  // Same code, another event.
  const other = await newEvent(10);
  assert.equal(
    (await confirmCapacityCode({ ...other, organizer: ev.organizer, capacity: 20, challengeId, code })).ok,
    false
  );
  assert.equal(await capacityOf(ev.eventId), 10);

  // And it still works for what it was issued for.
  assert.equal((await confirmCapacityCode({ ...ev, capacity: 20, challengeId, code })).ok, true);
});

test(`${MAX_CODE_ATTEMPTS} wrong guesses burn the code, even for the right one after`, async () => {
  const ev = await newEvent(10);
  const { challengeId, code } = await issue(ev, 40);

  const answers = [];
  for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
    answers.push((await confirmCapacityCode({ ...ev, capacity: 40, challengeId, code: wrong(code) })) as { code: string });
  }
  assert.deepEqual(
    answers.map((a) => a.code),
    [...Array(MAX_CODE_ATTEMPTS - 1).fill("code_invalid"), "code_attempts"]
  );
  assert.deepEqual(await confirmCapacityCode({ ...ev, capacity: 40, challengeId, code }), {
    ok: false,
    code: "code_attempts",
  });
  assert.equal(await capacityOf(ev.eventId), 10);
});

test("an expired code is refused and says so", async () => {
  const ev = await newEvent(10);
  const issuedAt = Date.now() - CODE_TTL_MS - 1000;
  const request = await requestCapacityCode({ ...ev, capacity: 15, offeredEmail: "org@example.com", now: issuedAt });
  assert.ok(request.ok);
  assert.deepEqual(
    await confirmCapacityCode({ ...ev, capacity: 15, challengeId: request.challengeId, code: request.code }),
    { ok: false, code: "code_expired" }
  );
  assert.equal(await capacityOf(ev.eventId), 10);
});

test("two requests racing with the right code raise capacity once", async () => {
  const ev = await newEvent(10);
  const { challengeId, code } = await issue(ev, 60);
  const results = await Promise.all(
    [1, 2, 3].map(() => confirmCapacityCode({ ...ev, capacity: 60, challengeId, code }))
  );
  assert.equal(results.filter((r) => r.ok).length, 1);
});

test("once an inbox is confirmed, codes always go there — whatever the client offers", async () => {
  const ev = await newEvent(10);
  const first = await issue(ev, 20, "real@example.com");
  assert.ok((await confirmCapacityCode({ ...ev, capacity: 20, challengeId: first.challengeId, code: first.code })).ok);

  // Someone holding the session asks for a code to *their* inbox: it still goes to the bound one.
  const second = await issue(ev, 30, "attacker@example.com");
  assert.equal(second.email, "real@example.com");
});

test("an address nobody confirmed binds nothing, so a typo can't lock the organizer out", async () => {
  const ev = await newEvent(10);
  await issue(ev, 20, "typo@exmaple.com"); // never confirmed
  const retry = await issue(ev, 20, "real@example.com");
  assert.equal(retry.email, "real@example.com");
});

test("no email bound and none offered: asks for one instead of issuing a code", async () => {
  const ev = await newEvent(10);
  assert.deepEqual(await requestCapacityCode({ ...ev, capacity: 20, offeredEmail: null }), {
    ok: false,
    code: "email_required",
  });
});

test("no code is issued for a change that couldn't happen", async () => {
  const ev = await newEvent(10);
  for (const capacity of [10, 5, 0, 2.5]) {
    const result = await requestCapacityCode({ ...ev, capacity, offeredEmail: "org@example.com" });
    assert.deepEqual(result, { ok: false, code: "capacity_lower" }, String(capacity));
  }
  assert.deepEqual(await requestCapacityCode({ ...ev, capacity: 100_001, offeredEmail: "org@example.com" }), {
    ok: false,
    code: "capacity_limit",
  });
  assert.deepEqual(
    await requestCapacityCode({ ...ev, ticketTypeId: "nope", capacity: 20, offeredEmail: "org@example.com" }),
    { ok: false, code: "not_found" }
  );
});

test("the code's hash is stored, never the code", async () => {
  const ev = await newEvent(10);
  const { challengeId, code } = await issue(ev, 20);
  const row = await db.execute({ sql: "SELECT * FROM capacity_codes WHERE id = ?", args: [challengeId] });
  assert.ok(!Object.values(row.rows[0]).some((value) => String(value).includes(code)));
});

test("an organizer's email is forgotten a month after their last event, and old codes go", async () => {
  // Bound for an organizer whose only event is upcoming: kept.
  const active = await newEvent(10);
  const a = await issue(active, 20, "active@example.com");
  assert.ok((await confirmCapacityCode({ ...active, capacity: 20, challengeId: a.challengeId, code: a.code })).ok);

  // Bound for one whose event ended 40 days ago: purged.
  const past = await newEvent(10);
  const p = await issue(past, 20, "past@example.com");
  assert.ok((await confirmCapacityCode({ ...past, capacity: 20, challengeId: p.challengeId, code: p.code })).ok);
  await db.execute({
    sql: "UPDATE events SET datetime_utc = datetime('now', '-40 days') WHERE id = ?",
    args: [past.eventId],
  });
  // A code from two days ago: purged whatever its event.
  await db.execute({
    sql: "UPDATE capacity_codes SET created_at = datetime('now', '-2 days') WHERE id = ?",
    args: [a.challengeId],
  });

  await purgeStaleOrganizerData();

  const emails = await db.execute({
    sql: "SELECT organizer_pollar_id FROM organizer_emails WHERE organizer_pollar_id IN (?, ?)",
    args: [active.organizer, past.organizer],
  });
  assert.deepEqual(emails.rows.map((row) => String(row.organizer_pollar_id)), [active.organizer]);
  const code = await db.execute({ sql: "SELECT 1 FROM capacity_codes WHERE id = ?", args: [a.challengeId] });
  assert.equal(code.rows.length, 0);
});
