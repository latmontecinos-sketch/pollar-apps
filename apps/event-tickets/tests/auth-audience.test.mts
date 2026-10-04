/**
 * A proof is addressed to a network and a deployment. These check that one
 * signed for another host (a staging copy) or another network is refused,
 * while the host the request really arrived on (the public one a proxy
 * forwards) — or, when APP_ORIGIN is configured, only the hosts it lists —
 * still signs in.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test } from "node:test";
import { Keypair } from "@stellar/stellar-base";

import { authAudience, authMessage, POLLAR_PROOF_HEADER } from "../lib/auth-message.ts";
import { requireSignedAddress } from "../lib/auth.ts";

const SEP53_PREFIX = "Stellar Signed Message:\n";
const PRODUCTION = "https://pollarpass.vercel.app";

afterEach(() => {
  delete process.env.APP_ORIGIN;
});

function signedRequest(
  keypair: Keypair,
  audienceHost: string,
  requestOrigin = PRODUCTION,
  extraHeaders: Record<string, string> = {}
): Request {
  const exp = Date.now() + 60_000;
  const address = keypair.publicKey();
  const message = authMessage(address, exp, "POST", "/api/sales", authAudience(audienceHost));
  const payload = Buffer.concat([Buffer.from(SEP53_PREFIX, "utf8"), Buffer.from(message, "utf8")]);
  const signature = keypair.sign(createHash("sha256").update(payload).digest()).toString("base64");
  return new Request(`${requestOrigin}/api/sales`, {
    method: "POST",
    headers: { [POLLAR_PROOF_HEADER]: JSON.stringify({ address, exp, signature }), ...extraHeaders },
  });
}

test("a proof signed for the host the request arrived on is accepted", () => {
  const keypair = Keypair.random();
  assert.equal(requireSignedAddress(signedRequest(keypair, "pollarpass.vercel.app")).ok, true);
});

test("a proof signed for a staging copy is refused on production", () => {
  const keypair = Keypair.random();
  assert.equal(requireSignedAddress(signedRequest(keypair, "pollarpass-staging.vercel.app")).ok, false);
});

test("the audience carries the network, so a testnet proof is not a mainnet one", () => {
  const host = "pollarpass.vercel.app";
  assert.ok(authAudience(host).endsWith(`@${host}`));
  const message = (audience: string) => authMessage("GADDR", 1, "POST", "/api/sales", audience);
  assert.notEqual(message("testnet@pollarpass.vercel.app"), message("mainnet@pollarpass.vercel.app"));
  assert.ok(message(authAudience(host)).includes("pollarpass-auth:v3:"));
});

test("a configured APP_ORIGIN is the whole list (a proxy answering on an alias)", () => {
  process.env.APP_ORIGIN = "https://pollarpass.example, https://other.example";
  const keypair = Keypair.random();
  // The request reaches the app on an internal host; the browser signed the public one.
  const request = signedRequest(keypair, "pollarpass.example", "http://internal:3000");
  assert.equal(requireSignedAddress(request).ok, true);
  assert.equal(requireSignedAddress(signedRequest(keypair, "other.example", "http://internal:3000")).ok, true);
  assert.equal(requireSignedAddress(signedRequest(keypair, "evil.example", "http://internal:3000")).ok, false);
});

test("with APP_ORIGIN defined, the request's own host is not added to the list", () => {
  process.env.APP_ORIGIN = "https://pollarpass.example";
  const keypair = Keypair.random();
  // Arrives on, and is signed for, a host that is not listed: refused, even though it is the request's own.
  assert.equal(requireSignedAddress(signedRequest(keypair, "pollarpass.vercel.app", PRODUCTION)).ok, false);
  assert.equal(
    requireSignedAddress(
      signedRequest(keypair, "preview-123.vercel.app", PRODUCTION, { "x-forwarded-host": "preview-123.vercel.app" })
    ).ok,
    false
  );
  assert.equal(requireSignedAddress(signedRequest(keypair, "pollarpass.example", PRODUCTION)).ok, true);
});

test("without APP_ORIGIN, the host a proxy forwards is the one that counts", () => {
  const keypair = Keypair.random();
  const internal = "http://internal:3000";
  const forwarded = { "x-forwarded-host": "Pollarpass.Vercel.app, edge-1.internal" };
  // The browser signed the public host; the app sees an internal URL plus x-forwarded-host.
  assert.equal(requireSignedAddress(signedRequest(keypair, "pollarpass.vercel.app", internal, forwarded)).ok, true);
  // The internal host is no longer an accepted audience once a public one was forwarded.
  assert.equal(requireSignedAddress(signedRequest(keypair, "internal:3000", internal, forwarded)).ok, false);
  // No proxy header: the Host header / request URL, which is what a plain deploy and `next dev` have.
  assert.equal(requireSignedAddress(signedRequest(keypair, "localhost:3000", "http://localhost:3000")).ok, true);
});

test("an APP_ORIGIN with nothing usable in it behaves as unset, instead of locking everyone out", () => {
  process.env.APP_ORIGIN = " , ::: ,";
  const keypair = Keypair.random();
  const silence = console.error;
  console.error = () => {};
  try {
    assert.equal(requireSignedAddress(signedRequest(keypair, "pollarpass.vercel.app")).ok, true);
  } finally {
    console.error = silence;
  }
});

test("a proof from before the audience existed no longer verifies", () => {
  const keypair = Keypair.random();
  const exp = Date.now() + 60_000;
  const address = keypair.publicKey();
  const legacy = `pollarpass-auth:v2:POST /api/sales:${address}:${exp}`;
  const payload = Buffer.concat([Buffer.from(SEP53_PREFIX, "utf8"), Buffer.from(legacy, "utf8")]);
  const signature = keypair.sign(createHash("sha256").update(payload).digest()).toString("base64");
  const request = new Request(`${PRODUCTION}/api/sales`, {
    method: "POST",
    headers: { [POLLAR_PROOF_HEADER]: JSON.stringify({ address, exp, signature }) },
  });
  assert.equal(requireSignedAddress(request).ok, false);
});
