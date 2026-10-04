import { db, dbReady } from "./db.ts";
import { securityLog } from "./security-log.ts";

/**
 * Fixed-window counters kept in the same libSQL database as everything
 * else. No Redis, no new service: this app already pays for a round trip
 * to that database on every route that matters, and one more statement is
 * cheaper than an extra dependency to operate.
 *
 * What this is for: none of these limits stop a determined attacker with
 * many accounts or many IPs — that's the platform's job. They stop one
 * account or one script from turning a cheap request into an expensive
 * one. `confirm` is the sharp case: each call fans out up to three
 * requests to Horizon, so a loop from a single account would get *our*
 * server rate-limited by Horizon and break checkout for every buyer.
 */

export type Quota = { limit: number; windowSeconds: number };

/** Per authenticated address unless noted. Tuned to be invisible to a real user. */
export const QUOTAS = {
  /** An organizer publishing more than this in a day is a script. */
  createEvent: { limit: 20, windowSeconds: 24 * 60 * 60 },
  /** A buyer browsing tiers and retrying a payment never gets near this. */
  createSale: { limit: 30, windowSeconds: 60 * 60 },
  /** Each one can hit Horizon three times; the buy screen polls a handful of times. */
  confirmSale: { limit: 60, windowSeconds: 60 * 60 },
  /**
   * Taking the right to pay a reservation (POST /api/sales/:id/pay): once per
   * purchase, plus the tabs that lose it. Writes a row, calls nothing external.
   */
  payStart: { limit: 60, windowSeconds: 60 * 60 },
  /**
   * A refund is three calls that must not eat each other's quota: starting it
   * (claim + a Horizon look), handing the claim back, and recording it. Each
   * has its own bucket, sized for an organizer refunding in bulk.
   */
  refundStart: { limit: 120, windowSeconds: 60 * 60 },
  /**
   * Recording a refund that already left (verifying it on Horizon). Its own,
   * generous bucket: money has moved by the time this is called, and it must
   * not be refused because plans were browsed or an earlier refund retried.
   */
  refundRecord: { limit: 600, windowSeconds: 60 * 60 },
  /** Giving a held seat back: once per abandoned checkout, so a few a day is already a lot. */
  releaseSale: { limit: 60, windowSeconds: 60 * 60 },
  /**
   * Editing an event is normal; editing it hundreds of times an hour is a
   * stuck client. Without a ceiling here, the fields that have no length
   * limit could be rewritten in a loop, and the seat-extension rule had
   * nothing slowing down an attempt to race it.
   */
  editEvent: { limit: 60, windowSeconds: 60 * 60 },
  /**
   * Each capacity code is an email sent and five fresh guesses. An organizer
   * adding a batch or two never comes close; ten an hour also keeps guessing
   * a six-digit code at 50 tries in a million.
   */
  capacityCode: { limit: 10, windowSeconds: 60 * 60 },
  /** Replacing the event photo: a few tries to get the crop right, not a stream of megabytes. */
  eventImage: { limit: 20, windowSeconds: 60 * 60 },
  /** Rotating a door link is a once-in-a-while act. */
  doorLink: { limit: 10, windowSeconds: 60 * 60 },
  /**
   * The door has two buckets per step and per event. A check-in is two calls
   * (peek, then spend), each with its own budget, and the ceilings sit far
   * above what a real door does (a person a second is already a stampede)
   * and far below what guessing an 8-character door code would need.
   *
   * - `doorCheckActor` / `doorActor`: per event AND per actor (the organizer's
   *   address, or `staff` for whoever holds the door link). Where the
   *   day-to-day limit lives: a staff token that burns its budget never
   *   locks the organizer out of their own door. 7200 peeks and 3600
   *   check-ins an hour from one actor is two a second, which a door with
   *   several scanners behind one link does not reach.
   * - `doorCheck` / `door`: per event, the backstop over every actor
   *   together. Sized as the sum of the actor budgets, so no single actor
   *   can starve another one; it only bites if the number of actors ever
   *   grows (more than one live link, say).
   *
   * Use {@link enforceDoor}, which charges both.
   */
  doorCheckActor: { limit: 7200, windowSeconds: 60 * 60 },
  doorActor: { limit: 3600, windowSeconds: 60 * 60 },
  doorCheck: { limit: 14400, windowSeconds: 60 * 60 },
  door: { limit: 7200, windowSeconds: 60 * 60 },
  /**
   * Per IP and event, for WRONG tries at a private event's access code (page
   * or photo); a right code never counts, so a crowd behind one carrier IP
   * opening the shared link doesn't lock itself out. Six characters out of 31
   * is ~887 million codes; at 60 misses an hour from one address that is
   * unreachable. Past the ceiling no code is checked from that address.
   *
   * The check (`isOverLimit`) and the count (`consume`) are two statements,
   * not one: requests that arrive together all pass the check before any of
   * them counts. Accepted on purpose: the excess is bounded by how many
   * requests are in flight at once (one carrier IP, one event), a few dozen
   * at the very most, and not by anything an attacker can keep growing,
   * since each later request sees the counter already past the ceiling. What
   * is not allowed to change is that only WRONG tries count.
   */
  accessCode: { limit: 60, windowSeconds: 60 * 60 },
  sweep: { limit: 60, windowSeconds: 60 * 60 },
  /** Per IP, unauthenticated: renders a PNG, so it's CPU someone else can spend. */
  ticketQr: { limit: 120, windowSeconds: 60 * 60 },
} as const satisfies Record<string, Quota>;

export type QuotaName = keyof typeof QUOTAS;

/** One in this many calls also clears out windows nobody will look at again. */
const SWEEP_ODDS = 200;

export type RateResult = { ok: true } | { ok: false; retryAfterSeconds: number };

/**
 * Counts one hit against `name:subject` and says whether it fits in the
 * window. The whole decision is a single UPSERT, so two concurrent requests
 * can't both read "59 of 60" and both proceed.
 *
 * Fails open: if the database is unreachable the limiter is the least
 * important thing that just broke, and refusing traffic on top of that
 * turns a degraded service into a dead one.
 */
export async function consume(name: QuotaName, subject: string): Promise<RateResult> {
  const { limit, windowSeconds } = QUOTAS[name];
  const bucket = `${name}:${subject}`;
  const windowModifier = `-${windowSeconds} seconds`;

  try {
    await dbReady();
    const result = await db.execute({
      sql: `INSERT INTO rate_limits (bucket, hits, window_start)
            VALUES (?, 1, datetime('now'))
            ON CONFLICT(bucket) DO UPDATE SET
              hits = CASE WHEN datetime(window_start) <= datetime('now', ?)
                          THEN 1 ELSE hits + 1 END,
              window_start = CASE WHEN datetime(window_start) <= datetime('now', ?)
                                  THEN datetime('now') ELSE window_start END
            RETURNING hits, window_start`,
      args: [bucket, windowModifier, windowModifier],
    });

    if (Math.floor(Math.random() * SWEEP_ODDS) === 0) {
      await db
        .execute("DELETE FROM rate_limits WHERE datetime(window_start) < datetime('now', '-2 days')")
        .catch(() => {});
    }

    const hits = Number(result.rows[0].hits);
    if (hits <= limit) return { ok: true };

    const startedAt = Date.parse(`${String(result.rows[0].window_start).replace(" ", "T")}Z`);
    const elapsed = Number.isNaN(startedAt) ? 0 : Math.floor((Date.now() - startedAt) / 1000);
    return { ok: false, retryAfterSeconds: Math.max(1, windowSeconds - elapsed) };
  } catch (err) {
    console.error(`[rate-limit] ${bucket} failed open: ${err instanceof Error ? err.message : err}`);
    return { ok: true };
  }
}

/**
 * Says whether `name:subject` is already at its ceiling, without counting a
 * hit. For limits that only count failures (a wrong access code): the caller
 * checks this first, then {@link consume}s only when the attempt fails, so a
 * right answer never spends quota. Fails open, like {@link consume}.
 */
export async function isOverLimit(name: QuotaName, subject: string): Promise<RateResult> {
  const { limit, windowSeconds } = QUOTAS[name];
  try {
    await dbReady();
    const result = await db.execute({
      sql: `SELECT hits, window_start FROM rate_limits
            WHERE bucket = ? AND datetime(window_start) > datetime('now', ?)`,
      args: [`${name}:${subject}`, `-${windowSeconds} seconds`],
    });
    if (result.rows.length === 0 || Number(result.rows[0].hits) < limit) return { ok: true };
    const startedAt = Date.parse(`${String(result.rows[0].window_start).replace(" ", "T")}Z`);
    const elapsed = Number.isNaN(startedAt) ? 0 : Math.floor((Date.now() - startedAt) / 1000);
    return { ok: false, retryAfterSeconds: Math.max(1, windowSeconds - elapsed) };
  } catch (err) {
    console.error(`[rate-limit] ${name}:${subject} check failed open: ${err instanceof Error ? err.message : err}`);
    return { ok: true };
  }
}

/**
 * The door's two budgets for one call (see `doorCheckActor` in {@link QUOTAS}):
 * the actor's own, then the event's. The actor's goes first, so a caller that
 * is already over its own budget does not also spend the event's. `actor` is
 * what `requireDoorAccess` returned: the organizer's address, or `staff`.
 */
export async function enforceDoor(
  step: "check" | "checkin",
  eventId: string,
  actor: string
): Promise<Response | null> {
  const [actorQuota, eventQuota] = step === "check" ? (["doorCheckActor", "doorCheck"] as const) : (["doorActor", "door"] as const);
  const context = { event: eventId };
  return (await enforce(actorQuota, `${eventId}:${actor}`, context)) ?? (await enforce(eventQuota, eventId, context));
}

/**
 * The 429 to return when {@link consume} says no. Deliberately vague about
 * which limit was hit and how much is left — that's a map of our defences.
 */
export function tooManyRequests(result: { retryAfterSeconds: number }): Response {
  return Response.json(
    { error: "Demasiados intentos seguidos. Espera un momento y volvé a intentar.", code: "rate_limited" },
    { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } }
  );
}

/** Convenience for the common shape: check, and hand back the 429 if it's over. */
export async function enforce(
  name: QuotaName,
  subject: string,
  context: Record<string, string | number | undefined> = {}
): Promise<Response | null> {
  const result = await consume(name, subject);
  if (result.ok) return null;
  securityLog("rate.limited", { quota: name, ...context });
  return tooManyRequests(result);
}

/**
 * Best-effort client address for unauthenticated limits. Vercel sets
 * x-forwarded-for and strips anything the client sent, so the first entry
 * is the real peer there; behind anything else this is a hint, not proof,
 * which is why it only ever guards a PNG.
 */
export function clientIp(request: Request): string {
  return clientIpFrom(request.headers);
}

/** Same, for callers that only have headers (a page reads them from `next/headers`). */
export function clientIpFrom(headers: { get(name: string): string | null }): string {
  const forwarded = headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || headers.get("x-real-ip")?.trim() || "unknown";
}
