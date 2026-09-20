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
  refundSale: { limit: 30, windowSeconds: 60 * 60 },
  /** Rotating a door link is a once-in-a-while act. */
  doorLink: { limit: 10, windowSeconds: 60 * 60 },
  /** Per event: a busy door scans fast, and a wrong scan is retried. */
  door: { limit: 900, windowSeconds: 60 * 60 },
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
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || request.headers.get("x-real-ip")?.trim() || "unknown";
}
