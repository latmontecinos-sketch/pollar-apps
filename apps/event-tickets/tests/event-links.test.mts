/**
 * Links out of the app (lib/event-links.ts) and the two small validity
 * functions that feed them: the doors-open window (lib/doors-open.ts) and the
 * attendee counter's threshold (lib/attendees.ts). All pure.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ATTENDEE_THRESHOLD, attendeesToShow, shouldShowAttendees } from "../lib/attendees.ts";
import { checkDoorsOpen, MAX_DOORS_LEAD_MS } from "../lib/doors-open.ts";
import {
  buildIcs,
  escapeIcsText,
  foldIcsLine,
  googleCalendarUrl,
  icsUid,
  icsUtc,
  mapsLinks,
} from "../lib/event-links.ts";

const EVENT = {
  id: "0b6c1f0a-1111-4222-8333-444455556666",
  name: "Noche de jazz, vol. 2; en vivo",
  description: "Quién toca: el trío.\nLlevar abrigo \\ y ganas",
  place: "Café Mirador, Av. 20 de Octubre",
  city: "La Paz",
  datetimeUtc: "2026-10-24T23:30:00.000Z",
  doorsOpenUtc: "2026-10-24T22:30:00.000Z",
};
const STAMP = new Date("2026-10-03T12:00:00.000Z");

// ── maps ────────────────────────────────────────────────────────────────────

test("mapsLinks encodes the place and the city into search URLs of the three apps", () => {
  const links = mapsLinks("Café Mirador & Bar #1", "La Paz");
  const q = encodeURIComponent("Café Mirador & Bar #1, La Paz");
  assert.equal(links.google, `https://www.google.com/maps/search/?api=1&query=${q}`);
  assert.equal(links.apple, `https://maps.apple.com/?q=${q}`);
  assert.equal(links.waze, `https://waze.com/ul?q=${q}&navigate=yes`);
  // The & and # of the place can't break out of the query.
  for (const url of Object.values(links)) assert.equal(new URL(url).searchParams.get("q") ?? new URL(url).searchParams.get("query"), "Café Mirador & Bar #1, La Paz");
});

test("mapsLinks leaves the city out when there is none or the place already says it", () => {
  assert.equal(new URL(mapsLinks("Plaza Murillo", null).google).searchParams.get("query"), "Plaza Murillo");
  assert.equal(new URL(mapsLinks("Plaza Murillo", "  ").google).searchParams.get("query"), "Plaza Murillo");
  assert.equal(new URL(mapsLinks("Café, la paz centro", "La Paz").google).searchParams.get("query"), "Café, la paz centro");
});

test("a place cannot smuggle another host or parameter into the links", () => {
  const links = mapsLinks("x&evil=1#frag https://evil.example", "");
  assert.equal(new URL(links.google).hostname, "www.google.com");
  assert.equal(new URL(links.waze).hostname, "waze.com");
  assert.equal(new URL(links.apple).hostname, "maps.apple.com");
  assert.equal(new URL(links.google).searchParams.has("evil"), false);
  assert.equal(new URL(links.google).hash, "");
});

// ── calendar ────────────────────────────────────────────────────────────────

test("icsUtc writes the basic UTC form", () => {
  assert.equal(icsUtc(new Date("2026-10-24T23:30:00.000Z")), "20261024T233000Z");
});

test("googleCalendarUrl carries name, UTC dates, place and the doors line", () => {
  const url = googleCalendarUrl(EVENT, "Puertas: 18:30");
  assert.ok(url);
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, "https://calendar.google.com/calendar/render");
  assert.equal(parsed.searchParams.get("action"), "TEMPLATE");
  assert.equal(parsed.searchParams.get("text"), EVENT.name);
  assert.equal(parsed.searchParams.get("dates"), "20261024T233000Z/20261025T023000Z");
  assert.equal(parsed.searchParams.get("location"), "Café Mirador, Av. 20 de Octubre, La Paz");
  assert.match(parsed.searchParams.get("details") ?? "", /Puertas: 18:30$/);
  assert.equal(googleCalendarUrl({ ...EVENT, datetimeUtc: "not a date" }), null);
});

test("buildIcs: CRLF everywhere, a VEVENT, a stable UID and the doors line in DESCRIPTION", () => {
  const ics = buildIcs(EVENT, { now: STAMP, doorsLine: "Puertas: 18:30", url: "https://pass.example/e/abc" });
  assert.ok(ics);
  // Every line ends CRLF, and no bare LF exists.
  assert.ok(ics.endsWith("\r\n"));
  assert.equal(ics.replace(/\r\n/g, "").includes("\n"), false);
  const lines = ics.split("\r\n");
  assert.equal(lines[0], "BEGIN:VCALENDAR");
  assert.ok(lines.includes("VERSION:2.0"));
  assert.ok(lines.includes("BEGIN:VEVENT"));
  assert.ok(lines.includes("END:VEVENT"));
  assert.equal(lines[lines.length - 2], "END:VCALENDAR");
  assert.ok(lines.includes(`UID:${icsUid(EVENT.id)}`));
  assert.ok(lines.includes("DTSTAMP:20261003T120000Z"));
  assert.ok(lines.includes("DTSTART:20261024T233000Z"));
  assert.ok(lines.includes("DTEND:20261025T023000Z"));
  assert.ok(lines.includes("URL:https://pass.example/e/abc"));
  const unfolded = ics.replace(/\r\n /g, "");
  assert.match(unfolded, /DESCRIPTION:.*Puertas: 18:30/);
});

test("buildIcs: the UID is the same on every build, whatever else changes", () => {
  const a = buildIcs(EVENT, { now: new Date("2026-01-01T00:00:00Z") });
  const b = buildIcs({ ...EVENT, name: "Otro nombre", place: "Otro lugar" }, { now: new Date("2027-01-01T00:00:00Z") });
  const uid = (ics: string | null) => ics?.split("\r\n").find((line) => line.startsWith("UID:"));
  assert.equal(uid(a), uid(b));
  assert.equal(uid(a), `UID:${EVENT.id}@pollar-pass`);
});

test("buildIcs escapes commas, semicolons, backslashes and newlines (RFC 5545)", () => {
  const ics = buildIcs(EVENT, { now: STAMP });
  assert.ok(ics);
  const unfolded = ics.replace(/\r\n /g, "");
  assert.ok(unfolded.includes("SUMMARY:Noche de jazz\\, vol. 2\\; en vivo\r\n"));
  assert.ok(unfolded.includes("LOCATION:Café Mirador\\, Av. 20 de Octubre\\, La Paz\r\n"));
  assert.ok(unfolded.includes("DESCRIPTION:Quién toca: el trío.\\nLlevar abrigo \\\\ y ganas\r\n"));
  assert.equal(escapeIcsText("a\r\nb\rc\nd"), "a\\nb\\nc\\nd");
  assert.equal(escapeIcsText("x\u0000y\u0007z"), "xyz", "control characters are dropped");
});

test("buildIcs can't be split into extra properties by a name with line breaks", () => {
  const ics = buildIcs({ ...EVENT, name: "Hola\r\nATTENDEE:mailto:x@evil.example", description: "" }, { now: STAMP });
  assert.ok(ics);
  const lines = ics.replace(/\r\n /g, "").split("\r\n");
  assert.equal(lines.some((line) => line.startsWith("ATTENDEE")), false);
  assert.ok(lines.some((line) => line.startsWith("SUMMARY:Hola\\nATTENDEE")));
});

test("foldIcsLine folds at 75 octets, never inside a character, and unfolds to the original", () => {
  const long = `DESCRIPTION:${"ñandú ".repeat(40)}`;
  const folded = foldIcsLine(long);
  const encoder = new TextEncoder();
  const parts = folded.split("\r\n");
  assert.ok(parts.length > 1);
  parts.forEach((part, i) => assert.ok(encoder.encode(part).length <= 75, `part ${i} too long`));
  assert.ok(parts.slice(1).every((part) => part.startsWith(" ")));
  assert.equal(folded.replace(/\r\n /g, ""), long);
  assert.equal(foldIcsLine("short"), "short");
});

test("buildIcs returns null for a date that can't be read", () => {
  assert.equal(buildIcs({ ...EVENT, datetimeUtc: "mañana" }), null);
});

// ── doors open ──────────────────────────────────────────────────────────────

test("checkDoorsOpen: none is fine, up to 24 h before the start is fine", () => {
  const start = "2026-10-24T23:30:00.000Z";
  assert.deepEqual(checkDoorsOpen(undefined, start), { ok: true, value: null });
  assert.deepEqual(checkDoorsOpen("", start), { ok: true, value: null });
  assert.deepEqual(checkDoorsOpen(null, start), { ok: true, value: null });
  assert.deepEqual(checkDoorsOpen(start, start), { ok: true, value: start }, "at the start");
  assert.deepEqual(checkDoorsOpen("2026-10-24T22:30:00Z", start), { ok: true, value: "2026-10-24T22:30:00.000Z" });
  const exactly24h = new Date(new Date(start).getTime() - MAX_DOORS_LEAD_MS).toISOString();
  assert.deepEqual(checkDoorsOpen(exactly24h, start), { ok: true, value: exactly24h }, "the limit itself");
});

test("checkDoorsOpen: after the start, more than 24 h before, or not a date, is refused", () => {
  const start = "2026-10-24T23:30:00.000Z";
  assert.deepEqual(checkDoorsOpen("2026-10-24T23:30:00.001Z", start), { ok: false, code: "doors_after_start" });
  const tooEarly = new Date(new Date(start).getTime() - MAX_DOORS_LEAD_MS - 1).toISOString();
  assert.deepEqual(checkDoorsOpen(tooEarly, start), { ok: false, code: "doors_too_early" });
  assert.deepEqual(checkDoorsOpen("pronto", start), { ok: false, code: "doors_invalid" });
  assert.deepEqual(checkDoorsOpen(12345, start), { ok: false, code: "doors_invalid" });
  assert.deepEqual(checkDoorsOpen(start, "no date"), { ok: false, code: "doors_invalid" });
});

// ── attendee counter ────────────────────────────────────────────────────────

test("the attendee counter stays hidden below the threshold and shows the bare number from it up", () => {
  assert.equal(ATTENDEE_THRESHOLD, 5);
  for (const n of [0, 1, 4]) {
    assert.equal(shouldShowAttendees(n), false, `${n} is hidden`);
    assert.equal(attendeesToShow(n), null);
  }
  assert.equal(shouldShowAttendees(5), true);
  assert.equal(attendeesToShow(5), 5);
  assert.equal(attendeesToShow(1234), 1234);
  assert.equal(shouldShowAttendees(-3), false);
  assert.equal(shouldShowAttendees(7.5), false);
  assert.equal(shouldShowAttendees(Number.NaN), false);
  assert.equal(shouldShowAttendees(3, 3), true, "a custom threshold");
});
