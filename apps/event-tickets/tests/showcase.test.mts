/**
 * The showcase and what feeds it: who can see an event (lib/visibility.ts),
 * which events get listed (lib/public-events.ts), and free tickets
 * (claimFreeTicket in lib/sales.ts) — the one checkout with no payment to
 * slow anyone down, so the one where "limited seats" has to hold on its own.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { after, before, test } from "node:test";
import { createClient } from "@libsql/client";

const DB_FILE = `test-showcase-${randomUUID()}.db`;
process.env.DATABASE_URL = `file:./${DB_FILE}`;
delete process.env.DATABASE_AUTH_TOKEN;

const { db, dbReady } = await import("../lib/db.ts");
const { createTicketTypes, listTicketTypes } = await import("../lib/ticket-types.ts");
const { claimFreeTicket, generateReference } = await import("../lib/sales.ts");
const { listPublicEvents } = await import("../lib/public-events.ts");
const { ACCESS_CODE_LENGTH, canView, newAccessCode, normalizeAccessCode } = await import("../lib/visibility.ts");

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

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

async function newEvent(opts: {
  visibility?: string;
  when?: string;
  tiers?: { name: string; priceDecimal: string; capacity: number }[];
}) {
  const id = randomUUID();
  await db.execute({
    sql: `INSERT INTO events (id, organizer_pollar_id, name, datetime_utc, place, price_stroops, capacity,
                              visibility, access_code)
          VALUES (?, 'GORG', ?, ?, 'La Paz', 0, 10, ?, ?)`,
    args: [
      id,
      `Evento ${id.slice(0, 6)}`,
      opts.when ?? inDays(7),
      opts.visibility ?? "public",
      opts.visibility === "private" ? "ABC234" : null,
    ],
  });
  await createTicketTypes(id, opts.tiers ?? [{ name: "Libre", priceDecimal: "0", capacity: 10 }]);
  const types = await listTicketTypes(id);
  return { eventId: id, ticketTypeId: types[0].id, types };
}

const claim = (eventId: string, ticketTypeId: string, buyer: string) =>
  claimFreeTicket({
    eventId,
    ticketTypeId,
    buyerPollarId: buyer,
    reference: generateReference(),
    idempotencyKey: randomUUID(),
  });

// ── visibility ──────────────────────────────────────────────────────────────

test("a private event opens only with its code; public and link-only ones need none", () => {
  const priv = { visibility: "private", access_code: "ABC234" };
  assert.equal(canView(priv, "ABC234"), true);
  assert.equal(canView(priv, " abc-234 "), true, "typed loosely, still the code");
  assert.equal(canView(priv, "ABC235"), false);
  assert.equal(canView(priv, ""), false);
  assert.equal(canView(priv, undefined), false);
  assert.equal(canView({ visibility: "private", access_code: null }, ""), false, "no code set opens nothing");
  assert.equal(canView({ visibility: "public", access_code: null }, undefined), true);
  assert.equal(canView({ visibility: "link", access_code: null }, undefined), true);
});

test("access codes are short, unambiguous, and normalize the way people type them", () => {
  for (let i = 0; i < 200; i++) {
    const code = newAccessCode();
    assert.equal(code.length, ACCESS_CODE_LENGTH);
    assert.match(code, /^[2-9A-HJKMNP-Z]+$/, "no 0/O/1/I/L");
  }
  assert.equal(normalizeAccessCode("ab c-2 3 4"), "ABC234");
});

// ── showcase ────────────────────────────────────────────────────────────────

test("the showcase lists public events that haven't started, soonest first", async () => {
  const later = await newEvent({ when: inDays(20) });
  const sooner = await newEvent({ when: inDays(2) });
  const priv = await newEvent({ visibility: "private" });
  const legacy = await newEvent({ visibility: "link" });
  const past = await newEvent({ when: inDays(-1) });

  const ids = (await listPublicEvents()).map((event) => event.id);
  assert.ok(ids.indexOf(sooner.eventId) < ids.indexOf(later.eventId), "soonest first");
  for (const hidden of [priv, legacy, past]) {
    assert.ok(!ids.includes(hidden.eventId), "private, link-only and past events stay out");
  }
});

test("each card carries its price range and the seats actually left", async () => {
  const mixed = await newEvent({
    tiers: [
      { name: "Libre", priceDecimal: "0", capacity: 3 },
      { name: "Platea", priceDecimal: "0.1", capacity: 2 },
    ],
  });
  await claim(mixed.eventId, mixed.types[0].id, "GBUYER_A");
  const card = (await listPublicEvents()).find((event) => event.id === mixed.eventId);
  assert.ok(card);
  assert.equal(card.minPriceDecimal, "0.0000000");
  assert.equal(card.maxPriceDecimal, "0.1000000");
  assert.equal(card.seatsLeft, 4, "5 seats, 1 claimed");
  assert.equal(card.imageVersion, null);
});

test("the showcase query walks the (visibility, datetime_utc) index, not the table", async () => {
  // Its own connection: an EXPLAIN on the shared one leaves a read open that
  // the next write transaction then waits out as SQLITE_BUSY.
  const probe = createClient({ url: `file:./${DB_FILE}` });
  const plan = await probe.execute({
    sql: `EXPLAIN QUERY PLAN
          SELECT e.id FROM events e LEFT JOIN event_images i ON i.event_id = e.id
          WHERE e.visibility = 'public' AND e.datetime_utc >= ? ORDER BY e.datetime_utc LIMIT 40`,
    args: [new Date().toISOString()],
  });
  probe.close();
  const detail = plan.rows.map((row) => String(row.detail)).join(" | ");
  assert.match(detail, /events_visibility_date_idx/);
  assert.doesNotMatch(detail, /SCAN e\b(?! USING)/);
  assert.doesNotMatch(detail, /TEMP B-TREE/, "the index already gives the order");
});

// ── free tickets ────────────────────────────────────────────────────────────

test("a free ticket is issued at once, and asking again hands back the same one", async () => {
  const ev = await newEvent({});
  const first = await claim(ev.eventId, ev.ticketTypeId, "GBUYER_1");
  assert.ok(first.ok && !first.existing);
  const again = await claim(ev.eventId, ev.ticketTypeId, "GBUYER_1");
  assert.ok(again.ok && again.existing);
  assert.equal(again.ticket.code, first.ticket.code);
  const [tier] = await listTicketTypes(ev.eventId);
  assert.equal(tier.reserved, 1, "one account, one seat");
  assert.equal(tier.paid, 1);
});

test("limited free seats hold under a rush: exactly capacity tickets, then sold out", async () => {
  const ev = await newEvent({ tiers: [{ name: "Libre", priceDecimal: "0", capacity: 3 }] });
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => claim(ev.eventId, ev.ticketTypeId, `GRUSH_${i}`))
  );
  assert.equal(results.filter((r) => r.ok).length, 3);
  assert.ok(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "sold_out"));
  const [tier] = await listTicketTypes(ev.eventId);
  assert.equal(tier.reserved, 3);
});

test("a paid tier can't be claimed for free", async () => {
  const ev = await newEvent({ tiers: [{ name: "Platea", priceDecimal: "0.05", capacity: 5 }] });
  assert.deepEqual(await claim(ev.eventId, ev.ticketTypeId, "GBUYER_2"), { ok: false, reason: "not_free" });
  const [tier] = await listTicketTypes(ev.eventId);
  assert.equal(tier.reserved, 0);
});
