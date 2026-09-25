import { randomInt, timingSafeEqual } from "node:crypto";

/**
 * Who can find an event.
 *
 * - `public`: listed in the app's showcase (/app) for anyone to browse.
 * - `private`: never listed, and the page, its photo and its checkout all
 *   ask for the event's access code — the organizer shares link and code
 *   together, or a link with the code in it.
 * - `link`: every event created before this existed. Opened by its link as
 *   always, not listed, no code; so old links keep working and the showcase
 *   doesn't fill up with past test events. Not offered for new events.
 *
 * Kept free of `next/server` so the tests can run it under `node --test`.
 */
export type Visibility = "public" | "private" | "link";

export function isVisibility(value: unknown): value is "public" | "private" {
  return value === "public" || value === "private";
}

/** No 0/O, 1/I/L: read aloud or copied off a flyer, it has to survive. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const ACCESS_CODE_LENGTH = 6;

export function newAccessCode(): string {
  let code = "";
  for (let i = 0; i < ACCESS_CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

/** What people type: spaces, dashes and lowercase forgiven. */
export function normalizeAccessCode(value: unknown): string {
  return String(value ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 16);
}

/** Whether this caller may see the event, given the code they brought (if any). */
export function canView(
  event: { visibility: string | null; access_code: string | null },
  offered: unknown
): boolean {
  if (event.visibility !== "private") return true;
  if (!event.access_code) return false;
  const given = Buffer.from(normalizeAccessCode(offered));
  const expected = Buffer.from(event.access_code);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
