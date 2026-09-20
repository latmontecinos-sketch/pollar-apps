/**
 * One line per security-relevant event, on stderr, in a shape you can grep
 * and Vercel can alert on. Deliberately not a table: these are for whoever
 * is reading the logs after something looks wrong, not for the app itself.
 *
 * The rule for every field here: enough to recognize a pattern, never
 * enough to be useful if the logs leak. No ticket codes, no door tokens,
 * no full email addresses — those are credentials and personal data, and a
 * log is the easiest place in a system to read without anyone noticing.
 */

export type SecurityEvent =
  /** A request arrived without a valid SEP-53 proof. */
  | "auth.rejected"
  /** A door link was used after being revoked or rotated. */
  | "door.token_rejected"
  /** Someone asked for more than their share of an endpoint. */
  | "rate.limited"
  /** A payment exists on-chain but doesn't match the sale it claims. */
  | "payment.mismatch"
  /** An organizer recorded a refund. */
  | "refund.recorded"
  /** A ticket was spent at a door. */
  | "checkin.accepted";

/** `GABC…WXYZ`: enough to follow one actor across lines, not enough to be an address. */
export function shortAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** `a…@gmail.com`: tells you which provider bounced, not who the buyer is. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "…";
  return `${email[0]}…${email.slice(at)}`;
}

export function securityLog(
  event: SecurityEvent,
  details: Record<string, string | number | undefined> = {}
): void {
  const fields = Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  console.warn(`[security] ${event} ${fields}`.trimEnd());
}
