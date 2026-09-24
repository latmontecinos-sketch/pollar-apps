/**
 * Limits shared by the browser (the tier editor) and the server (validation).
 * Kept apart from `lib/ticket-types.ts`, which pulls in the database and so
 * can't be imported from a client component.
 */

/** Enough for "General / VIP / Estudiantes / Early bird"; more is a different product. */
export const MAX_TICKET_TYPES = 6;

/**
 * Upper bounds, which matter more than they look.
 *
 * Amounts are stored as stroops in an INTEGER column, and libSQL reads
 * integers as JS numbers: past 2^53 stroops (about 900,719,925 USDC) the read
 * throws RangeError rather than rounding. Because every tier of an event is
 * read by one SELECT, a single row above that ceiling makes the whole event
 * unreadable — public page, checkout and organizer panel all 500 — and
 * nothing in the app can fix it afterwards. Reachable by typing too many
 * zeros, so it needs a bound, not a comment.
 *
 * A million USDC a ticket and a hundred thousand seats are both absurd for
 * the events this is for, and both sit far below anything that overflows.
 */
export const MAX_PRICE_USDC = 1_000_000;
export const MAX_CAPACITY = 100_000;

/**
 * Free-text limits. `organizerName` and `organizerContact` were already
 * capped; the event's own name, place and description were not, which left a
 * public unauthenticated route — the OpenGraph image, rendered on every
 * WhatsApp preview of a shared link — interpolating a string of any size.
 */
export const MAX_NAME_CHARS = 120;
export const MAX_DESCRIPTION_CHARS = 2000;
