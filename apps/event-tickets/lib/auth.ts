import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Keypair } from "@stellar/stellar-base";
import { authMessage, normalizeRoute, POLLAR_PROOF_HEADER } from "./auth-message.ts";
import { securityLog, shortAddressForLog } from "./security-log.ts";

/**
 * Server-side identity for a Pollar user, without an "Authorization: Bearer".
 *
 * Pollar sessions are DPoP-bound — the signing key lives on the user's device
 * and never reaches our server, so a forwarded token proves nothing here
 * (see SDK-NOTES.md §8). The proven alternative (already shipped in
 * apps/vendor-pay-link, a merged PR in this monorepo): the client signs a
 * short-lived message via `client.stellar.sep53.signMessage()`, and we
 * verify that signature purely cryptographically — no call to Pollar at all.
 *
 * Returns plain `Response`s rather than `NextResponse`: route handlers
 * accept either, and not importing `next/server` is what lets the abuse
 * cases in tests/security.test.mts run this module directly under `node
 * --test`, with no framework booted around it.
 */

export { POLLAR_PROOF_HEADER };
const SEP53_PREFIX = "Stellar Signed Message:\n";
/**
 * A proof is a bearer credential for its window: whoever holds the header
 * is the user until it expires. It's bound to one endpoint (see
 * `authMessage`), so the window is all that's left to shrink — the client
 * signs for 2 minutes, and anything claiming more than 3 is refused.
 *
 * Not single-use, deliberately: on an external wallet every signature is a
 * popup, so per-request signing would put a prompt in front of each tap.
 */
const MAX_TTL_MS = 3 * 60 * 1000;

function decodeSignature(signature: string): Buffer | null {
  const trimmed = signature.trim();
  try {
    const b64 = Buffer.from(trimmed, "base64");
    if (b64.length === 64) return b64;
  } catch {
    /* fall through to hex */
  }
  if (/^[0-9a-fA-F]{128}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  return null;
}

/** Verifies a SEP-53 message signature against a G… address. Pure crypto, no network call. */
export function verifySep53(opts: {
  address: string;
  message: string;
  signature: string;
}): boolean {
  if (!/^G[A-Z2-7]{55}$/.test(opts.address)) return false;
  const sig = decodeSignature(opts.signature);
  if (!sig) return false;
  const payload = Buffer.concat([
    Buffer.from(SEP53_PREFIX, "utf8"),
    Buffer.from(opts.message, "utf8"),
  ]);
  const digest = createHash("sha256").update(payload).digest();
  try {
    return Keypair.fromPublicKey(opts.address).verify(digest, sig);
  } catch {
    return false;
  }
}

export type ProofPayload = { address: string; exp: number; signature: string };

type AuthOutcome =
  | { ok: true; address: string }
  | { ok: false; response: Response };

function fail(status: number, error: string): AuthOutcome {
  return { ok: false, response: Response.json({ error }, { status }) };
}

/**
 * Verifies the caller's identity from the `x-pollar-proof` header. Never
 * trusts an address the client merely states in the body — only one that
 * survives signature verification.
 */
export function requireSignedAddress(request: Request): AuthOutcome {
  const raw = request.headers.get(POLLAR_PROOF_HEADER);
  if (!raw) return fail(401, "Sesión Pollar requerida");

  let proof: ProofPayload;
  try {
    proof = JSON.parse(raw) as ProofPayload;
  } catch {
    return reject(request, "malformed");
  }

  const address = proof.address?.trim() ?? "";
  const exp = Number(proof.exp);
  const signature = proof.signature?.trim() ?? "";
  if (!/^G[A-Z2-7]{55}$/.test(address) || !Number.isFinite(exp) || !signature) {
    return reject(request, "malformed");
  }

  const now = Date.now();
  if (exp < now || exp > now + MAX_TTL_MS) {
    securityLog("auth.rejected", {
      reason: "expired",
      route: routeOf(request),
      actor: shortAddressForLog(address),
    });
    return fail(401, "La sesión expiró. Recarga la página e intenta de nuevo.");
  }

  // The signature covers the endpoint being called, so a proof lifted from
  // one request can't be spent on another.
  const { method, path } = requestRoute(request);
  const message = authMessage(address, exp, method, path);
  if (!verifySep53({ address, message, signature })) {
    return reject(request, "bad_signature", address);
  }

  return { ok: true, address };
}

function requestRoute(request: Request): { method: string; path: string } {
  return { method: request.method, path: new URL(request.url).pathname };
}

function routeOf(request: Request): string {
  const { method, path } = requestRoute(request);
  return `${method} ${normalizeRoute(path)}`;
}

function reject(request: Request, reason: string, address?: string): AuthOutcome {
  securityLog("auth.rejected", {
    reason,
    route: routeOf(request),
    actor: address && shortAddressForLog(address),
  });
  return fail(
    401,
    "No se pudo verificar la sesión Pollar. Recarga la página e intenta de nuevo."
  );
}

export const DOOR_TOKEN_HEADER = "x-door-token";

/** 144-bit bearer secret for the staff door link. */
export function newDoorToken(): string {
  return randomBytes(18).toString("base64url");
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * How long a staff door link outlives the event it belongs to. A link that
 * works forever is a credential the organizer stops thinking about: it gets
 * forwarded, screenshotted and left in a WhatsApp group, and it still opens
 * the door months later. Tying it to the event means it dies on its own.
 */
export const DOOR_TOKEN_GRACE_MS = 24 * 60 * 60 * 1000;

export function doorTokenExpired(eventIsoUtc: string, now = Date.now()): boolean {
  const start = new Date(eventIsoUtc).getTime();
  return !Number.isNaN(start) && now > start + DOOR_TOKEN_GRACE_MS;
}

/**
 * Door check-in access: either the organizer's own signed session, or the
 * event's staff door token (what the organizer hands to whoever runs the
 * entrance). The token only ever unlocks check-in for *this* event — never
 * the panel, the sales list or edits — the organizer can revoke it, and it
 * lapses a day after the event whether they remember to or not.
 */
export function requireDoorAccess(
  request: Request,
  event: { organizer_pollar_id: string; door_token: string | null; datetime_utc: string }
): { ok: true; actor: string } | { ok: false; response: Response } {
  const token = request.headers.get(DOOR_TOKEN_HEADER)?.trim();
  if (token) {
    const expired = doorTokenExpired(event.datetime_utc);
    if (!expired && event.door_token && sameSecret(token, event.door_token)) {
      return { ok: true, actor: "staff" };
    }
    securityLog("door.token_rejected", {
      route: routeOf(request),
      reason: expired ? "event_over" : event.door_token ? "mismatch" : "revoked",
    });
    return {
      ok: false,
      response: Response.json(
        { error: "Este link de puerta ya no es válido. Pide uno nuevo al organizador." },
        { status: 403 }
      ),
    };
  }
  const got = requireAddress(request, event.organizer_pollar_id);
  return got.ok ? { ok: true, actor: got.address } : got;
}

/** Like {@link requireSignedAddress}, but also enforces the signer matches `expected` (ownership checks). */
export function requireAddress(request: Request, expected: string): AuthOutcome {
  const got = requireSignedAddress(request);
  if (!got.ok) return got;
  if (got.address !== expected) {
    return fail(403, "Esta sesión no corresponde a esa cuenta");
  }
  return got;
}
