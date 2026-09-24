import { INTL_LOCALE, type Locale } from "./i18n/locales.ts";

/**
 * "0.0000000" → "0.00", "12.5000000" → "12.50", written the way the reader's
 * language writes numbers ("2,50" in Spanish and French, "2.50" in English).
 * The locale is always passed in: falling back to the device's own locale
 * would make the server and the browser render different strings.
 */
export function formatAmount(value: string | null, locale: Locale): string {
  if (value === null) return "—";
  const n = Number(value);
  if (Number.isNaN(n)) return value;
  return n.toLocaleString(INTL_LOCALE[locale], {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** "GDDH372S…203WJY": keeps both ends, trims the middle. */
export function middleTruncate(value: string, start = 8, end = 6): string {
  if (value.length <= start + end + 1) return value;
  return `${value.slice(0, start)}…${value.slice(-end)}`;
}

export function shortAddress(address: string) {
  return middleTruncate(address, 4, 4);
}

const BUSINESS_TIMEZONE = "America/La_Paz";

/**
 * SQLite's `datetime('now')` stores UTC as "YYYY-MM-DD HH:MM:SS" with no
 * zone marker, and `new Date()` reads that shape as *local* time — 4 hours
 * off in Bolivia. Normalizes it to real ISO UTC; anything else passes through.
 */
export function sqlUtcToIso(value: string): string;
export function sqlUtcToIso(value: string | null): string | null;
export function sqlUtcToIso(value: string | null): string | null {
  if (value === null) return null;
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
}

/** "18 sep, 14:05" in America/La_Paz — for timestamps like a sale or a check-in. */
export function formatTimestamp(isoUtc: string, locale: Locale): string {
  const date = new Date(isoUtc);
  if (Number.isNaN(date.getTime())) return isoUtc;
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    timeZone: BUSINESS_TIMEZONE,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Bolivia is UTC-4 all year (no DST), so a wall-clock time there maps to UTC with a fixed offset. */
const LA_PAZ_OFFSET = "-04:00";

/** `<input type="datetime-local">` value, read as La Paz time (not the device's zone) -> UTC ISO. */
export function laPazLocalToUtcIso(local: string): string {
  const withSeconds = /T\d{2}:\d{2}$/.test(local) ? `${local}:00` : local;
  return new Date(`${withSeconds}${LA_PAZ_OFFSET}`).toISOString();
}

/** UTC ISO -> `<input type="datetime-local">` value in La Paz time. */
export function utcIsoToLaPazLocal(isoUtc: string): string {
  const date = new Date(isoUtc);
  if (Number.isNaN(date.getTime())) return "";
  const shifted = new Date(date.getTime() - 4 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 16);
}

/** Buyers may type "2,50" (comma decimal, as usual in Bolivia); the API wants "2.50". */
export function normalizeDecimalInput(value: string): string {
  return value.trim().replace(",", ".");
}

/**
 * Organizer contact as typed ("+591 70012345", "@mi_evento", a URL) -> a
 * link buyers can tap: WhatsApp for phone numbers (how people reach an
 * organizer in Bolivia), Instagram for @handles. Null when it's neither.
 */
export function contactHref(contact: string): string | null {
  const value = contact.trim();
  if (/^https?:\/\//i.test(value)) return value;
  if (/^@[\w.]{2,30}$/.test(value)) return `https://instagram.com/${value.slice(1)}`;
  const digits = value.replace(/[\s()+-]/g, "");
  if (/^\d{7,15}$/.test(digits)) {
    // Bare 8-digit Bolivian mobile numbers get the country code WhatsApp needs.
    return `https://wa.me/${digits.length === 8 ? `591${digits}` : digits}`;
  }
  return null;
}

/** How long after an event's start tickets stay on sale (late arrivals still buy at the door). */
export const SALES_GRACE_MS = 3 * 60 * 60 * 1000;

export function salesClosed(eventIsoUtc: string, now = Date.now()): boolean {
  const start = new Date(eventIsoUtc).getTime();
  return !Number.isNaN(start) && now > start + SALES_GRACE_MS;
}

/**
 * Stored as UTC always; only the view converts. E.g. "vie 12 sep, 19:00".
 * The zone stays America/La_Paz whatever the language: the event happens in
 * Bolivia, so a reader in Paris still needs the door time in La Paz.
 */
export function formatEventDateTime(isoUtc: string, locale: Locale): string {
  const date = new Date(isoUtc);
  if (Number.isNaN(date.getTime())) return isoUtc;
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    timeZone: BUSINESS_TIMEZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/**
 * "octubre de 2026": the heading a list of tickets is grouped under. In La
 * Paz time like every other event date, so a 23:30 event on the 31st stays
 * in its own month for a reader anywhere.
 */
export function formatEventMonth(isoUtc: string, locale: Locale): string {
  const date = new Date(isoUtc);
  if (Number.isNaN(date.getTime())) return isoUtc;
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    timeZone: BUSINESS_TIMEZONE,
    month: "long",
    year: "numeric",
  }).format(date);
}

/** "sábado, 24 de octubre": the day alone, for sentences like the link preview's. */
export function formatEventDay(isoUtc: string, locale: Locale): string {
  const date = new Date(isoUtc);
  if (Number.isNaN(date.getTime())) return isoUtc;
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    timeZone: BUSINESS_TIMEZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(date);
}

/** "19:00" / "7:00 PM": the door time alone, in La Paz like every event time. */
export function formatEventTime(isoUtc: string, locale: Locale): string {
  const date = new Date(isoUtc);
  if (Number.isNaN(date.getTime())) return isoUtc;
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    timeZone: BUSINESS_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
