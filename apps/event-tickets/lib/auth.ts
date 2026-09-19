import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Keypair } from "@stellar/stellar-base";
import { NextResponse } from "next/server";
import { authMessage, POLLAR_PROOF_HEADER } from "./auth-message.ts";

/**
 * Server-side identity for a Pollar user, without an "Authorization: Bearer".
 *
 * Pollar sessions are DPoP-bound — the signing key lives on the user's device
 * and never reaches our server, so a forwarded token proves nothing here
 * (see SDK-NOTES.md §8). The proven alternative (already shipped in
 * apps/vendor-pay-link, a merged PR in this monorepo): the client signs a
 * short-lived message via `client.stellar.sep53.signMessage()`, and we
 * verify that signature purely cryptographically — no call to Pollar at all.
 */

export { POLLAR_PROOF_HEADER };
const SEP53_PREFIX = "Stellar Signed Message:\n";
const MAX_TTL_MS = 10 * 60 * 1000;

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
  | { ok: false; response: NextResponse };

function fail(status: number, error: string): AuthOutcome {
  return { ok: false, response: NextResponse.json({ error }, { status }) };
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
    return fail(401, "Prueba de sesión inválida");
  }

  const address = proof.address?.trim() ?? "";
  const exp = Number(proof.exp);
  const signature = proof.signature?.trim() ?? "";
  if (!/^G[A-Z2-7]{55}$/.test(address) || !Number.isFinite(exp) || !signature) {
    return fail(401, "Prueba de sesión inválida");
  }

  const now = Date.now();
  if (exp < now || exp > now + MAX_TTL_MS) {
    return fail(401, "La sesión expiró. Recarga la página e intenta de nuevo.");
  }

  const message = authMessage(address, exp);
  if (!verifySep53({ address, message, signature })) {
    return fail(401, "No se pudo verificar la sesión Pollar");
  }

  return { ok: true, address };
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
 * Door check-in access: either the organizer's own signed session, or the
 * event's staff door token (what the organizer hands to whoever runs the
 * entrance). The token only ever unlocks check-in for *this* event — never
 * the panel, the sales list or edits — and the organizer can revoke it.
 */
export function requireDoorAccess(
  request: Request,
  event: { organizer_pollar_id: string; door_token: string | null }
): { ok: true; actor: string } | { ok: false; response: NextResponse } {
  const token = request.headers.get(DOOR_TOKEN_HEADER)?.trim();
  if (token) {
    if (event.door_token && sameSecret(token, event.door_token)) {
      return { ok: true, actor: "staff" };
    }
    return {
      ok: false,
      response: NextResponse.json(
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
