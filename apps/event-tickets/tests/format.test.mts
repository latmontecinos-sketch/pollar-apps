/**
 * Dates and amounts. Every bug fixed here was a real one: SQLite timestamps
 * read as local time, the device's timezone leaking into an event's hour,
 * and amounts rendered in the wrong language's notation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contactHref,
  formatAmount,
  formatEventDateTime,
  formatTimestamp,
  laPazLocalToUtcIso,
  normalizeDecimalInput,
  salesClosed,
  sqlUtcToIso,
  utcIsoToLaPazLocal,
} from "../lib/format.ts";

test("SQLite's datetime('now') is read as UTC, not as local time", () => {
  assert.equal(sqlUtcToIso("2026-09-19 21:29:49"), "2026-09-19T21:29:49Z");
  // Already-ISO values and nulls pass through untouched.
  assert.equal(sqlUtcToIso("2026-09-19T21:29:49.000Z"), "2026-09-19T21:29:49.000Z");
  assert.equal(sqlUtcToIso(null), null);
});

test("a check-in at 21:29 UTC reads as 17:29 in Bolivia", () => {
  const shown = formatTimestamp(sqlUtcToIso("2026-09-19 21:29:49"), "es");
  assert.match(shown, /05:29 p\. m\.|17:29/);
});

test("event times are La Paz time whatever the device's timezone", () => {
  const iso = laPazLocalToUtcIso("2026-10-09T20:00");
  assert.equal(iso, "2026-10-10T00:00:00.000Z");
  assert.equal(utcIsoToLaPazLocal(iso), "2026-10-09T20:00");
  // Same instant, read from three languages: the hour never moves.
  for (const locale of ["es", "en", "fr"] as const) {
    assert.match(formatEventDateTime(iso, locale), /8|20/);
  }
});

test("amounts follow the reader's language", () => {
  assert.equal(formatAmount("2.5000000", "es"), "2,50");
  assert.equal(formatAmount("2.5000000", "en"), "2.50");
  assert.equal(formatAmount("2.5000000", "fr"), "2,50");
  assert.equal(formatAmount(null, "es"), "—");
});

test("buyers may type a comma for the decimal point", () => {
  assert.equal(normalizeDecimalInput("2,50"), "2.50");
  assert.equal(normalizeDecimalInput(" 2.50 "), "2.50");
});

test("sales close three hours after the event starts, not before", () => {
  const start = Date.parse("2026-10-10T00:00:00.000Z");
  assert.equal(salesClosed("2026-10-10T00:00:00.000Z", start - 60_000), false);
  assert.equal(salesClosed("2026-10-10T00:00:00.000Z", start + 60_000), false, "late arrivals still buy");
  assert.equal(salesClosed("2026-10-10T00:00:00.000Z", start + 4 * 3600_000), true);
});

test("organizer contact becomes a tappable link when it can", () => {
  assert.equal(contactHref("70012345"), "https://wa.me/59170012345");
  assert.equal(contactHref("+591 70012345"), "https://wa.me/59170012345");
  assert.equal(contactHref("@mi_evento"), "https://instagram.com/mi_evento");
  assert.equal(contactHref("https://example.com/evento"), "https://example.com/evento");
  assert.equal(contactHref("pregunta en la puerta"), null);
});
