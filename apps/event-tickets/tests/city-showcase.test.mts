/**
 * The city, "today / this week", doors-open, attendee-count and accent
 * features end to end: the pure normalisation and date windows, then the
 * database side (listing, filters, the guarded edit, the calendar file of a
 * private event), plus the query plans the new index is justified with.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { after, before, test } from "node:test";
import { createClient } from "@libsql/client";

const DB_FILE = `test-city-showcase-${randomUUID()}.db`;
process.env.DATABASE_URL = `file:./${DB_FILE}`;
delete process.env.DATABASE_AUTH_TOKEN;

const { db, dbReady } = await import("../lib/db.ts");
const { BOLIVIA_CITIES, MAX_CITY_CHARS, normalizeCity } = await import("../lib/city.ts");
const { parseShowcaseFilters, startOfLaPazDay, whenWindow } = await import("../lib/showcase-filters.ts");
const { listPublicCities, listPublicEvents, listShowcase } = await import("../lib/public-events.ts");
const { updateEventFields } = await import("../lib/event-update.ts");
const { createEventWithTypes } = await import("../lib/ticket-types.ts");
const { loadEventIcs, icsFilename } = await import("../lib/event-ics.ts");
const { countAttendees } = await import("../lib/event-attendees.ts");
const { deleteEventImage, saveEventImage } = await import("../lib/event-image.ts");
const { generateReference, claimFreeTicket } = await import("../lib/sales.ts");

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

// ── city ────────────────────────────────────────────────────────────────────

test("normalizeCity trims, collapses spaces, capitalises and caps", () => {
  assert.equal(normalizeCity("  santa   cruz  "), "Santa Cruz");
  assert.equal(normalizeCity("LA PAZ"), "La Paz");
  assert.equal(normalizeCity("buenos aires"), "Buenos Aires");
  assert.equal(normalizeCity("ciudad de méxico"), "Ciudad de México");
  assert.equal(normalizeCity("río de janeiro"), "Río de Janeiro");
  assert.equal(normalizeCity("guadalupe-hidalgo"), "Guadalupe-Hidalgo");
  assert.equal(normalizeCity("x".repeat(200))?.length, MAX_CITY_CHARS);
  assert.equal((normalizeCity("a".repeat(59) + " b" + "c".repeat(10)) ?? "").length <= MAX_CITY_CHARS, true);
});

test("normalizeCity gives a known suggestion its canonical spelling, accents included", () => {
  assert.equal(normalizeCity("potosi"), "Potosí");
  assert.equal(normalizeCity("POTOSÍ"), "Potosí");
  assert.equal(normalizeCity(" el alto "), "El Alto");
  for (const city of BOLIVIA_CITIES) assert.equal(normalizeCity(city.toUpperCase()), city);
  assert.equal(BOLIVIA_CITIES.length, 10);
});

test("normalizeCity says 'no city' for empty, blank, control-only or non-text input", () => {
  for (const empty of ["", "   ", "\n\t", "\u0000\u0007", null, undefined, 12, {}, ["La Paz"]]) {
    assert.equal(normalizeCity(empty), null, JSON.stringify(empty));
  }
  assert.equal(normalizeCity("La\u0000 Paz"), "La Paz");
  assert.equal(normalizeCity("La\nPaz"), "La Paz");
});

// ── today / this week ───────────────────────────────────────────────────────
// 2026-10-03 is a Saturday. La Paz is UTC-4 all year: a day starts at 04:00Z.

test("a La Paz day starts at 04:00 UTC", () => {
  assert.equal(startOfLaPazDay(new Date("2026-10-03T12:00:00Z")).toISOString(), "2026-10-03T04:00:00.000Z");
  assert.equal(startOfLaPazDay(new Date("2026-10-03T03:59:59Z")).toISOString(), "2026-10-02T04:00:00.000Z");
  assert.equal(startOfLaPazDay(new Date("2026-10-03T04:00:00Z")).toISOString(), "2026-10-03T04:00:00.000Z");
});

test("'today' ends at the next La Paz midnight, to the millisecond", () => {
  const at = (iso: string) => whenWindow("today", new Date(iso));
  assert.equal(at("2026-10-03T12:00:00Z").to, "2026-10-04T04:00:00.000Z");
  // One minute before La Paz midnight: still the 3rd, and the 4th 00:00 La Paz is already out.
  assert.equal(at("2026-10-04T03:59:00Z").to, "2026-10-04T04:00:00.000Z");
  // At La Paz midnight it is the 4th.
  assert.equal(at("2026-10-04T04:00:00Z").to, "2026-10-05T04:00:00.000Z");
  assert.equal(at("2026-10-03T12:00:00Z").from, "2026-10-03T12:00:00.000Z");
});

test("an event at 23:30 La Paz is today's even though it is tomorrow in UTC", () => {
  const w = whenWindow("today", new Date("2026-10-03T20:00:00Z")); // 16:00 La Paz
  const lateEvent = "2026-10-04T03:30:00.000Z"; // 23:30 La Paz on the 3rd
  const nextDay = "2026-10-04T04:00:00.000Z"; // 00:00 La Paz on the 4th
  assert.ok(lateEvent >= w.from && lateEvent < (w.to as string));
  assert.ok(!(nextDay < (w.to as string)));
});

test("'week' runs to the end of the coming Sunday (Monday to Sunday weeks)", () => {
  const to = (iso: string) => whenWindow("week", new Date(iso)).to;
  // Sat 3rd afternoon: the week ends with Sunday the 4th (= Mon 5th 00:00 La Paz).
  assert.equal(to("2026-10-03T12:00:00Z"), "2026-10-05T04:00:00.000Z");
  // Sunday 4th 00:00 La Paz: only that Sunday is left.
  assert.equal(to("2026-10-04T04:00:00Z"), "2026-10-05T04:00:00.000Z");
  // Sat 23:59 La Paz: still Saturday.
  assert.equal(to("2026-10-04T03:59:00Z"), "2026-10-05T04:00:00.000Z");
  // Sunday 23:59 La Paz: still that week.
  assert.equal(to("2026-10-05T03:59:00Z"), "2026-10-05T04:00:00.000Z");
  // Monday 00:00 La Paz: a whole new week, ending Sunday the 11th.
  assert.equal(to("2026-10-05T04:00:00Z"), "2026-10-12T04:00:00.000Z");
  // Wednesday 7th noon La Paz.
  assert.equal(to("2026-10-07T16:00:00Z"), "2026-10-12T04:00:00.000Z");
  // A year end: Thursday 31 Dec 2026 noon La Paz: the week ends Sunday 3 Jan 2027.
  assert.equal(to("2026-12-31T16:00:00Z"), "2027-01-04T04:00:00.000Z");
});

test("'all' has no upper bound", () => {
  assert.deepEqual(whenWindow("all", new Date("2026-10-03T12:00:00Z")), { from: "2026-10-03T12:00:00.000Z", to: null });
});

test("parseShowcaseFilters cleans what the query string says", () => {
  assert.deepEqual(parseShowcaseFilters({ city: " potosi ", when: "week" }), { city: "Potosí", when: "week" });
  assert.deepEqual(parseShowcaseFilters({ city: ["la paz", "x"], when: ["today"] }), { city: "La Paz", when: "today" });
  assert.deepEqual(parseShowcaseFilters({ city: "", when: "someday" }), { city: null, when: "all" });
  assert.deepEqual(parseShowcaseFilters({}), { city: null, when: "all" });
});

// ── the database side ───────────────────────────────────────────────────────

const TIERS = [{ name: "General", priceDecimal: "2", capacity: 50 }];
const FREE_TIER = [{ name: "Libre", priceDecimal: "0", capacity: 50 }];

async function newEvent(opts: {
  when: string;
  city?: string | null;
  visibility?: "public" | "private";
  doorsOpenUtc?: string | null;
  tiers?: typeof TIERS;
  name?: string;
}) {
  const id = randomUUID();
  await createEventWithTypes(
    {
      id,
      organizerPollarId: "GORG",
      name: opts.name ?? `Evento ${id.slice(0, 6)}`,
      description: "Descripción privada, con; signos",
      datetimeUtc: opts.when,
      place: "Café Mirador",
      organizerName: "Org",
      organizerContact: "",
      visibility: opts.visibility ?? "public",
      accessCode: opts.visibility === "private" ? "ABC234" : null,
      city: opts.city === undefined ? null : opts.city,
      doorsOpenUtc: opts.doorsOpenUtc ?? null,
    },
    opts.tiers ?? TIERS
  );
  return id;
}

const NOW = new Date("2026-10-03T12:00:00.000Z"); // Saturday 08:00 La Paz
const at = (iso: string) => iso;

test("the showcase filters by city and by today / this week, and keeps private events out", async () => {
  const sameDayLaPaz = await newEvent({ when: at("2026-10-04T03:30:00.000Z"), city: "La Paz" }); // 23:30 La Paz, the 3rd
  const midnightNext = await newEvent({ when: at("2026-10-04T04:00:00.000Z"), city: "La Paz" }); // Sunday 00:00 La Paz
  const sunday = await newEvent({ when: at("2026-10-05T03:59:00.000Z"), city: "Santa Cruz" }); // Sunday 23:59 La Paz
  const mondayNext = await newEvent({ when: at("2026-10-05T04:00:00.000Z"), city: "La Paz" }); // next week
  const secret = await newEvent({ when: at("2026-10-03T20:00:00.000Z"), city: "La Paz", visibility: "private" });
  const noCity = await newEvent({ when: at("2026-10-03T20:00:00.000Z") });
  const past = await newEvent({ when: at("2026-10-03T11:00:00.000Z"), city: "La Paz" });

  const ids = async (filters: Parameters<typeof listPublicEvents>[2]) =>
    new Set((await listPublicEvents(100, NOW, filters)).map((e) => e.id));

  const today = await ids({ when: "today" });
  assert.ok(today.has(sameDayLaPaz) && today.has(noCity));
  assert.ok(!today.has(midnightNext) && !today.has(mondayNext) && !today.has(past) && !today.has(secret));

  const week = await ids({ when: "week" });
  assert.ok(week.has(sameDayLaPaz) && week.has(midnightNext) && week.has(sunday) && week.has(noCity));
  assert.ok(!week.has(mondayNext), "Monday 00:00 La Paz is next week");

  const laPazWeek = await ids({ city: "La Paz", when: "week" });
  assert.deepEqual([...laPazWeek].sort(), [sameDayLaPaz, midnightNext].sort());

  const crucenos = await ids({ city: "Santa Cruz" });
  assert.deepEqual([...crucenos], [sunday]);

  const all = await ids({});
  assert.ok(all.has(mondayNext) && !all.has(secret) && !all.has(past));
  assert.deepEqual([...(await ids({ city: "Tarija" }))], []);
});

test("the city list counts public upcoming events per city, never private or past ones", async () => {
  const cities = await listPublicCities(NOW);
  const byName = new Map(cities.map((c) => [c.city, c.count]));
  assert.equal(byName.get("La Paz"), 3, "sameDay, midnightNext, mondayNext (not the private or the past one)");
  assert.equal(byName.get("Santa Cruz"), 1);
  assert.ok(!byName.has("Tarija"));
  assert.ok([...byName.keys()].every((name) => name === normalizeCity(name)));
  const sorted = [...cities].sort((a, b) => b.count - a.count || (a.city < b.city ? -1 : 1));
  assert.deepEqual(cities, sorted, "most events first, then by name");
  const both = await listShowcase({ city: "Santa Cruz" }, 40, NOW);
  assert.equal(both.events.length, 1);
  assert.deepEqual(both.cities, cities, "picking a city doesn't shrink the chips");
});

test("the index serves the city filter and the city list (the plans the CLAUDE.md rule 8 asks for)", async () => {
  // Its own connection, closed after each plan: an EXPLAIN on the shared one
  // leaves a read open that the next write transaction waits out as SQLITE_BUSY
  // (same as tests/showcase.test.mts).
  const plan = async (sql: string, args: (string | number)[]) => {
    const probe = createClient({ url: `file:./${DB_FILE}` });
    try {
      return (await probe.execute({ sql: `EXPLAIN QUERY PLAN ${sql}`, args })).rows.map((row) => String(row.detail)).join(" | ");
    } finally {
      probe.close();
    }
  };
  const filtered = await plan(
    `SELECT e.id FROM events e
     WHERE e.visibility = 'public' AND e.datetime_utc >= ? AND e.datetime_utc < ? AND e.city = ?
     ORDER BY e.datetime_utc LIMIT 40`,
    ["2026-10-03T12:00:00.000Z", "2026-10-05T04:00:00.000Z", "La Paz"]
  );
  assert.match(filtered, /events_visibility_city_date_idx \(visibility=\? AND city=\? AND datetime_utc>\? AND datetime_utc<\?\)/);
  assert.doesNotMatch(filtered, /TEMP B-TREE/, "already in date order");
  const list = await plan(
    `SELECT city, count(*) AS n FROM events
     WHERE visibility = 'public' AND city IS NOT NULL AND datetime_utc >= ? GROUP BY city ORDER BY n DESC, city`,
    ["2026-10-03T12:00:00.000Z"]
  );
  assert.match(list, /COVERING INDEX events_visibility_city_date_idx/);
  assert.doesNotMatch(list, /GROUP BY/, "grouping comes from the index order");
  const unfiltered = await plan(
    `SELECT e.id FROM events e WHERE e.visibility = 'public' AND e.datetime_utc >= ? ORDER BY e.datetime_utc LIMIT 40`,
    ["2026-10-03T12:00:00.000Z"]
  );
  assert.match(unfiltered, /events_visibility_date_idx/, "the plain showcase keeps its own index");
});

test("listings carry city, doors time, accent and the attendee number (never a name)", async () => {
  const id = await newEvent({ when: "2026-10-10T23:00:00.000Z", city: "Sucre", doorsOpenUtc: "2026-10-10T22:00:00.000Z", tiers: FREE_TIER });
  await saveEventImage(id, new Uint8Array([1, 2, 3]), { width: 1080, height: 1350 }, "#C81E28");
  const types = await db.execute({ sql: "SELECT id FROM ticket_types WHERE event_id = ?", args: [id] });
  const tierId = String(types.rows[0].id);
  const claim = (buyer: string) =>
    claimFreeTicket({ eventId: id, ticketTypeId: tierId, buyerPollarId: buyer, reference: generateReference(), idempotencyKey: randomUUID() });

  const find = async () => (await listPublicEvents(100, NOW, { city: "Sucre" })).find((e) => e.id === id)!;
  for (let i = 0; i < 4; i++) await claim(`GBUYER${i}`);
  let row = await find();
  assert.equal(row.city, "Sucre");
  assert.equal(row.doorsOpenUtc, "2026-10-10T22:00:00.000Z");
  assert.equal(row.accent, "#c81e28");
  assert.equal(row.attendees, null, "4 tickets: under the threshold, hidden");
  assert.equal(await countAttendees(id), 4);

  await claim("GBUYER4");
  row = await find();
  assert.equal(row.attendees, 5, "5 tickets: shown, as a bare number");
  assert.equal(await countAttendees(id), 5);
  assert.equal(JSON.stringify(row).includes("GBUYER"), false, "no account ever reaches the listing");

  // A refunded sale stops counting.
  await db.execute({ sql: "UPDATE sales SET status = 'refunded' WHERE event_id = ? AND buyer_pollar_id = 'GBUYER0'", args: [id] });
  assert.equal(await countAttendees(id), 4);
  assert.equal((await find()).attendees, null);
});

test("the accent follows the photo: set with it, replaced with it, gone without it, never anything but #rrggbb", async () => {
  const id = await newEvent({ when: "2026-10-12T20:00:00.000Z" });
  const accent = async () => String((await db.execute({ sql: "SELECT accent FROM events WHERE id = ?", args: [id] })).rows[0].accent);
  const size = { width: 1080, height: 1350 };
  await saveEventImage(id, new Uint8Array([1]), size, "#336699");
  assert.equal(await accent(), "#336699");
  await saveEventImage(id, new Uint8Array([2]), size, "red; background:url(//evil.example)");
  assert.equal(await accent(), "null", "a malformed accent clears it instead of being stored");
  await saveEventImage(id, new Uint8Array([3]), size, "#abcdef");
  await saveEventImage(id, new Uint8Array([4]), size);
  assert.equal(await accent(), "null", "a new photo without an accent drops the old photo's colour");
  await saveEventImage(id, new Uint8Array([5]), size, "#123456");
  await deleteEventImage(id);
  assert.equal(await accent(), "null", "no photo, no accent");
});

test("a doors time that no longer fits the start is refused by the UPDATE itself", async () => {
  const start = "2026-11-01T23:00:00.000Z";
  const id = await newEvent({ when: start, doorsOpenUtc: "2026-11-01T22:00:00.000Z" });
  const row = async () => (await db.execute({ sql: "SELECT datetime_utc, doors_open_utc, city FROM events WHERE id = ?", args: [id] })).rows[0];

  // Moving the start a week forward without touching the doors: they would be a week early.
  assert.equal(await updateEventFields(id, { datetimeUtc: "2026-11-08T23:00:00.000Z" }), false);
  assert.equal((await row()).datetime_utc, start, "nothing written");
  // Moving it 30 min later keeps them inside the day.
  assert.equal(await updateEventFields(id, { datetimeUtc: "2026-11-01T23:30:00.000Z" }), true);
  // Doors alone, after the start: refused. Within the window: accepted. Cleared: accepted.
  assert.equal(await updateEventFields(id, { doorsOpenUtc: "2026-11-02T00:00:00.000Z" }), false);
  assert.equal(await updateEventFields(id, { doorsOpenUtc: "2026-10-31T22:00:00.000Z" }), false, "more than 24 h before");
  assert.equal(await updateEventFields(id, { doorsOpenUtc: "2026-11-01T21:00:00.000Z" }), true);
  assert.equal((await row()).doors_open_utc, "2026-11-01T21:00:00.000Z");
  // Both together are checked by the route, so the UPDATE takes them as they are.
  assert.equal(await updateEventFields(id, { datetimeUtc: "2026-12-01T20:00:00.000Z", doorsOpenUtc: "2026-12-01T19:00:00.000Z" }), true);
  assert.equal(await updateEventFields(id, { doorsOpenUtc: null }), true);
  assert.equal((await row()).doors_open_utc, null);
  // With no doors time, any new start is fine; city edits don't care.
  assert.equal(await updateEventFields(id, { datetimeUtc: "2027-01-01T20:00:00.000Z", city: "Oruro" }), true);
  assert.equal((await row()).city, "Oruro");
  assert.equal(await updateEventFields(id, { city: null }), true);
  assert.equal((await row()).city, null);
  assert.equal(await updateEventFields(randomUUID(), { city: "Oruro" }), false, "no such event");
});

// ── the calendar file ───────────────────────────────────────────────────────

test("the .ics of a private event without its code returns nothing at all", async () => {
  const id = await newEvent({ when: "2026-10-20T23:00:00.000Z", visibility: "private", name: "Cena secreta del club", city: "La Paz", doorsOpenUtc: "2026-10-20T22:00:00.000Z" });
  for (const offered of [undefined, null, "", "WRONG1", "ABC235", "abc23"]) {
    const result = await loadEventIcs(id, offered);
    assert.deepEqual(result, { ok: false }, `code ${JSON.stringify(offered)}`);
    // A refusal carries nothing: no body, no filename (which is the event's name), no flag.
    assert.deepEqual(Object.keys(result), ["ok"]);
  }
  // A private event is indistinguishable from one that doesn't exist.
  assert.deepEqual(await loadEventIcs(randomUUID(), "ABC234"), { ok: false });
});

test("the .ics of a private event with its code (typed loosely) is the calendar file", async () => {
  const id = await newEvent({ when: "2026-10-20T23:00:00.000Z", visibility: "private", name: "Cena del club, 2ª", city: "La Paz", doorsOpenUtc: "2026-10-20T22:00:00.000Z" });
  const result = await loadEventIcs(id, " abc-234 ", {
    doorsLine: (doors) => `Puertas ${doors}`,
    url: `https://pass.example/e/${id}`,
    now: new Date("2026-10-03T12:00:00Z"),
  });
  assert.ok(result.ok);
  assert.equal(result.isPrivate, true);
  assert.equal(result.filename, "cena-del-club-2.ics");
  assert.ok(result.body.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(result.body.includes(`UID:${id}@pollar-pass\r\n`));
  assert.ok(result.body.includes("DTSTART:20261020T230000Z\r\n"));
  assert.match(result.body.replace(/\r\n /g, ""), /DESCRIPTION:.*Puertas 2026-10-20T22:00:00.000Z/);
  // The page's own URL is in the file, but the access code never is.
  assert.equal(result.body.includes("ABC234"), false);
});

test("public and link-only events give their .ics to anyone; a bad date gives none", async () => {
  const pub = await newEvent({ when: "2026-10-21T23:00:00.000Z" });
  assert.ok((await loadEventIcs(pub, null)).ok);
  const legacy = await newEvent({ when: "2026-10-21T23:00:00.000Z" });
  await db.execute({ sql: "UPDATE events SET visibility = 'link' WHERE id = ?", args: [legacy] });
  assert.ok((await loadEventIcs(legacy, undefined)).ok);
  await db.execute({ sql: "UPDATE events SET datetime_utc = 'garbage' WHERE id = ?", args: [pub] });
  assert.deepEqual(await loadEventIcs(pub, null), { ok: false });
});

test("icsFilename is plain ASCII and never empty", () => {
  assert.equal(icsFilename("Noche de jazz — Sopocachi"), "noche-de-jazz-sopocachi.ics");
  assert.equal(icsFilename("¡¡¡"), "evento.ics");
  assert.equal(icsFilename('a"b\r\nc'), "a-b-c.ics");
  assert.match(icsFilename("x".repeat(300)), /^x{40}\.ics$/);
});
