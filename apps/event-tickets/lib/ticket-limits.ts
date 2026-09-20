/**
 * Limits shared by the browser (the tier editor) and the server (validation).
 * Kept apart from `lib/ticket-types.ts`, which pulls in the database and so
 * can't be imported from a client component.
 */

/** Enough for "General / VIP / Estudiantes / Early bird"; more is a different product. */
export const MAX_TICKET_TYPES = 6;

/** Events routinely add a second batch of tickets; twice is enough to stay honest about "cupo". */
export const MAX_CAPACITY_INCREASES = 2;
