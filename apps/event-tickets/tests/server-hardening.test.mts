/**
 * Server-side fixes from the adversarial review (Fase 2): atomic event
 * creation, edits that cannot undo each other, revenue summed in BigInt, a
 * check-in that survives a failed notification, door quotas that fit a real
 * door, a ceiling on access-code guesses, and one `organizerOf`.
 *
 * Uses its own file DB, so it never touches dev.db or production.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

const DB_FILE = `test-hardening-${randomUUID()}.db`;
process.env.DATABASE_URL = `file:./${DB_FILE}`;
delete process.env.DATABASE_AUTH_TOKEN;

const { db, dbReady } = await import("../lib/db.ts");
const { notifyCheckin } = await import("../lib/checkin-notify.ts");
const { organizerOf } = await import("../lib/event-owner.ts");
const { updateEventFields } = await import("../lib/event-update.ts");
const { QUOTAS, clientIpFrom, consume, isOverLimit } = await import("../lib/rate-limit.ts");
const { collectedByEvent, collectedForEvent, sumStroops } = await import("../lib/revenue.ts");
const { createEventWithTypes, listTicketTypes } = await import("../lib/ticket-types.ts");
const { canView } = await import("../lib/visibility.ts");

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

function newEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    organizerPollarId: "GORG",
    name: "Fiesta",
    description: "",
    datetimeUtc: new Date(Date.now() + 86_400_000).toISOString(),
    place: "La Paz",
    organizerName: "",
    organizerContact: "",
    visibility: "public" as "public" | "private",
    accessCode: null as string | null,
    ...overrides,
  };
}

const TIERS = [
  { name: "General", priceDecimal: "1.0000000", capacity: 10 },
  { name: "VIP", priceDecimal: "5.0000000", capacity: 4 },
];

// ── event creation is atomic ────────────────────────────────────────────────

test("an event is created together with exactly the tiers the organizer chose", async () => {
  const event = newEvent();
  await createEventWithTypes(event, TIERS);
  const types = await listTicketTypes(event.id);
  assert.deepEqual(
    types.map((type) => [type.name, type.capacity]),
    [["General", 10], ["VIP", 4]]
  );
  const row = await db.execute({ sql: "SELECT capacity, price_stroops FROM events WHERE id = ?", args: [event.id] });
  assert.equal(Number(row.rows[0].capacity), 14);
  assert.equal(Number(row.rows[0].price_stroops), 10_000_000);
});

test("if a tier fails to insert, the event does not exist either (nothing for a backfill to fill)", async () => {
  const event = newEvent();
  const broken = [
    { name: "General", priceDecimal: "1.0000000", capacity: 10 },
    { name: "Roto", priceDecimal: "1.0000000", capacity: null as unknown as number },
  ];
  await assert.rejects(createEventWithTypes(event, broken));
  const events = await db.execute({ sql: "SELECT 1 FROM events WHERE id = ?", args: [event.id] });
  const tiers = await db.execute({ sql: "SELECT 1 FROM ticket_types WHERE event_id = ?", args: [event.id] });
  assert.equal(events.rows.length, 0);
  assert.equal(tiers.rows.length, 0);
});

// ── edits cannot undo each other ────────────────────────────────────────────

test("an edit that does not mention visibility never changes it, however it races one that does", async () => {
  for (let round = 0; round < 15; round++) {
    const event = newEvent();
    await createEventWithTypes(event, TIERS);
    await Promise.all([
      updateEventFields(event.id, { visibility: "private" }),
      updateEventFields(event.id, { name: `Renombrada ${round}` }),
      updateEventFields(event.id, { description: "otra cosa", place: "Sucre" }),
    ]);
    const row = await db.execute({
      sql: "SELECT visibility, access_code, name, place FROM events WHERE id = ?",
      args: [event.id],
    });
    assert.equal(row.rows[0].visibility, "private", `round ${round}`);
    assert.ok(row.rows[0].access_code, "going private minted a code");
    assert.equal(row.rows[0].name, `Renombrada ${round}`);
    assert.equal(row.rows[0].place, "Sucre");
  }
});

test("going private again keeps the code, and going public leaves it for later", async () => {
  const event = newEvent();
  await createEventWithTypes(event, TIERS);
  const code = async () =>
    String((await db.execute({ sql: "SELECT access_code FROM events WHERE id = ?", args: [event.id] })).rows[0].access_code);
  await updateEventFields(event.id, { visibility: "private" });
  const first = await code();
  await updateEventFields(event.id, { visibility: "public" });
  await updateEventFields(event.id, { visibility: "private" });
  await Promise.all([
    updateEventFields(event.id, { visibility: "private" }),
    updateEventFields(event.id, { visibility: "private" }),
  ]);
  assert.equal(await code(), first);
});

test("the capacity summary follows the tiers, not whatever was read earlier", async () => {
  const event = newEvent();
  await createEventWithTypes(event, TIERS);
  await db.execute({ sql: "UPDATE ticket_types SET capacity = capacity + 6 WHERE event_id = ? AND name = 'VIP'", args: [event.id] });
  await updateEventFields(event.id, { name: "Otra" });
  const row = await db.execute({ sql: "SELECT capacity FROM events WHERE id = ?", args: [event.id] });
  assert.equal(Number(row.rows[0].capacity), 20);
});

// ── revenue: BigInt, per real sale ──────────────────────────────────────────

async function addSale(eventId: string, amount: bigint | number, status = "paid") {
  await db.execute({
    sql: `INSERT INTO sales (id, event_id, buyer_pollar_id, reference, amount_stroops, idempotency_key, status, expires_at_utc)
          VALUES (?, ?, 'GBUYER', ?, ?, ?, ?, datetime('now', '+1 hour'))`,
    args: [randomUUID(), eventId, randomUUID(), amount, randomUUID(), status],
  });
}

test("sumStroops adds past 2^53 and 2^63 without rounding or throwing", () => {
  assert.equal(sumStroops([]), 0n);
  assert.equal(sumStroops(["9007199254740993", 1]), 9007199254740994n);
  assert.equal(sumStroops(["4611686018427387904", 4611686018427387904n]), 9223372036854775808n);
});

test("collected revenue is the sum of the paid sales, whatever tier each one was, exact even where SQL SUM overflows", async () => {
  const event = newEvent();
  await createEventWithTypes(event, TIERS);
  const half = 4611686018427387904n; // 2^62
  await addSale(event.id, half);
  await addSale(event.id, half);
  await addSale(event.id, 5_000_000, "pending"); // not paid: not collected
  await addSale(event.id, 5_000_000, "expired");

  // What the old query did: SQLite refuses to add these up at all.
  await assert.rejects(
    db.execute({ sql: "SELECT SUM(amount_stroops) FROM sales WHERE event_id = ? AND status = 'paid'", args: [event.id] }),
    /overflow/i
  );
  assert.equal(await collectedForEvent(event.id), 2n * half);
  assert.equal((await collectedByEvent("GORG")).get(event.id), 2n * half);
});

test("a mixed event adds what each ticket really cost, not price of the cheapest tier times sales", async () => {
  const event = newEvent({ organizerPollarId: "GMIXED" });
  await createEventWithTypes(event, TIERS);
  await addSale(event.id, 10_000_000); // General, 1 USDC
  await addSale(event.id, 50_000_000); // VIP, 5 USDC
  await addSale(event.id, 50_000_000);
  assert.equal(await collectedForEvent(event.id), 110_000_000n);
  const byEvent = await collectedByEvent("GMIXED");
  assert.equal(byEvent.get(event.id), 110_000_000n);
  assert.equal(byEvent.size, 1, "only this organizer's events");
});

// ── the door ────────────────────────────────────────────────────────────────

test("the door's quotas leave room for a busy event, and check and approve do not share one", async () => {
  // A check-in is two calls. Both budgets must clear 1,000 people an hour with retries to spare.
  assert.ok(QUOTAS.doorCheck.limit >= 2000, "peeking");
  assert.ok(QUOTAS.door.limit >= 1000, "spending");

  const event = randomUUID();
  for (let i = 0; i < 5; i++) assert.equal((await consume("doorCheck", event)).ok, true);
  // Five peeks were counted against doorCheck only.
  const buckets = await db.execute({
    sql: "SELECT bucket, hits FROM rate_limits WHERE bucket IN (?, ?)",
    args: [`doorCheck:${event}`, `door:${event}`],
  });
  assert.deepEqual(
    buckets.rows.map((row) => [row.bucket, Number(row.hits)]),
    [[`doorCheck:${event}`, 5]]
  );
});

test("a failed notification never undoes an admission", async () => {
  const eventId = randomUUID();
  await createEventWithTypes(newEvent({ id: eventId }), TIERS);
  const saleId = randomUUID();
  await db.execute({
    sql: `INSERT INTO sales (id, event_id, buyer_pollar_id, reference, amount_stroops, idempotency_key, status,
                             expires_at_utc, buyer_email, buyer_locale)
          VALUES (?, ?, 'GBUYER', ?, 1, ?, 'paid', datetime('now', '+1 hour'), 'comprador@example.com', 'en')`,
    args: [saleId, eventId, randomUUID(), randomUUID()],
  });
  const silence = console.error;
  console.error = () => {};
  try {
    let seen: { to: string; locale: string } | undefined;
    assert.equal(
      await notifyCheckin(saleId, "Fiesta", async (opts) => {
        seen = opts;
        return { sent: true };
      }),
      "sent"
    );
    assert.deepEqual(seen && { to: seen.to, locale: seen.locale }, { to: "comprador@example.com", locale: "en" });
    // The provider says no: reported, not thrown.
    assert.equal(await notifyCheckin(saleId, "Fiesta", async () => ({ sent: false, error: "smtp down" })), "failed");
    // The provider blows up: still not thrown.
    assert.equal(
      await notifyCheckin(saleId, "Fiesta", async () => {
        throw new Error("boom");
      }),
      "failed"
    );
    // Nobody to tell, or a sale that is gone: nothing to fail.
    assert.equal(await notifyCheckin(randomUUID(), "Fiesta", async () => ({ sent: true })), "none");
  } finally {
    console.error = silence;
  }
});

// ── private events: guessing the code ───────────────────────────────────────

test("wrong tries at a private event's code count, and past the ceiling it stops", async () => {
  const subject = `203.0.113.7:${randomUUID()}`;
  const { limit } = QUOTAS.accessCode;
  // Checking spends nothing: a crowd opening the link with the right code never fills it.
  for (let i = 0; i < 3 * limit; i++) assert.equal((await isOverLimit("accessCode", subject)).ok, true);
  for (let i = 0; i < limit; i++) assert.equal((await consume("accessCode", subject)).ok, true, `miss ${i + 1}`);
  assert.equal((await isOverLimit("accessCode", subject)).ok, false, "past the ceiling no code is checked");
  const over = await consume("accessCode", subject);
  assert.equal(over.ok, false);
  // Another address, or another event, has its own budget.
  assert.equal((await consume("accessCode", `203.0.113.8:${subject.split(":")[1]}`)).ok, true);
});

test("a private event gives nothing to a caller with no code (what the link preview is)", () => {
  const event = { visibility: "private", access_code: "ABC234" };
  assert.equal(canView(event, null), false);
  assert.equal(canView(event, ""), false);
  assert.equal(canView(event, "abc-234"), true);
});

test("the client address comes from the first x-forwarded-for entry, from a Request or a Headers", () => {
  const headers = new Headers({ "x-forwarded-for": "198.51.100.4, 10.0.0.1" });
  assert.equal(clientIpFrom(headers), "198.51.100.4");
  assert.equal(clientIpFrom(new Headers({ "x-real-ip": "198.51.100.9" })), "198.51.100.9");
  assert.equal(clientIpFrom(new Headers()), "unknown");
});

// ── one organizerOf ─────────────────────────────────────────────────────────

test("organizerOf says who owns an event, or null when there is none", async () => {
  const event = newEvent({ organizerPollarId: "GOWNER" });
  await createEventWithTypes(event, TIERS);
  assert.equal(await organizerOf(event.id), "GOWNER");
  assert.equal(await organizerOf(randomUUID()), null);
});

test("no route keeps its own copy of organizerOf", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name === "route.ts" && /function organizerOf\b/.test(readFileSync(path, "utf8"))) offenders.push(path);
    }
  };
  walk("app");
  assert.deepEqual(offenders, []);
});

// ── rule 4: every endpoint that writes carries enforce() ────────────────────

test("every API route that writes carries enforce()", () => {
  const missing: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name === "route.ts") {
        const source = readFileSync(path, "utf8");
        const writes = /export (async )?function (POST|PUT|PATCH|DELETE)\b/.test(source);
        if (writes && !source.includes("enforce(")) missing.push(path);
      }
    }
  };
  walk(join("app", "api"));
  assert.deepEqual(missing, []);
});
