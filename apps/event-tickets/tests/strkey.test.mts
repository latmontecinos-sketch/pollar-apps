import test from "node:test";
import assert from "node:assert/strict";
import { verify } from "node:crypto";
import { Keypair } from "@stellar/stellar-base";

import { decodeStellarPublicKey, ed25519PublicKeyFrom } from "../lib/strkey.ts";

/**
 * `lib/strkey.ts` replaced a deprecated 3.1 MB dependency in the one place
 * that decides who the caller is, so it gets checked against the very
 * library it replaced: the reference implementation generates the addresses,
 * ours has to agree on every one of them.
 *
 * The failure mode that matters is not "rejects something valid" — that just
 * logs the user out. It is "accepts something it shouldn't", so most of these
 * are about what must be refused.
 */

test("a thousand real addresses decode to exactly what the reference says", () => {
  for (let i = 0; i < 1000; i++) {
    const keypair = Keypair.random();
    assert.deepEqual(
      decodeStellarPublicKey(keypair.publicKey()),
      keypair.rawPublicKey(),
      `mismatch on ${keypair.publicKey()}`
    );
  }
});

test("a single altered character is refused", () => {
  // What the checksum is for: a mistyped address, not an attacker.
  const address = Keypair.random().publicKey();
  const swapped = address[30] === "A" ? "B" : "A";
  const mutated = address.slice(0, 30) + swapped + address.slice(31);
  assert.throws(() => decodeStellarPublicKey(mutated), /checksum|base32|ed25519/i);
});

test("a secret seed is never read as a public key", () => {
  // Same length, same alphabet, different version byte. Accepting one would
  // mean treating a secret someone pasted by accident as an identity.
  const secret = Keypair.random().secret();
  assert.equal(secret[0], "S");
  assert.throws(() => decodeStellarPublicKey(secret), /forma de dirección|ed25519/i);
});

test("the shapes that are not addresses are all refused", () => {
  for (const bad of [
    "",
    "G",
    "GABC",
    Keypair.random().publicKey().toLowerCase(),
    Keypair.random().publicKey().slice(0, 55),
    Keypair.random().publicKey() + "A",
    "G" + "1".repeat(55), // 0 and 1 are not in the base32 alphabet
    "../../etc/passwd",
  ]) {
    assert.throws(() => decodeStellarPublicKey(bad), `should have refused ${JSON.stringify(bad)}`);
  }
});

test("a decoded address verifies a signature the reference produced", () => {
  // End to end, the way lib/auth.ts uses it: sign there, verify here.
  const keypair = Keypair.random();
  const message = Buffer.from("pollarpass-auth:v2:GET /api/sales/mine:addr:123", "utf8");
  const signature = keypair.sign(message);

  const key = ed25519PublicKeyFrom(keypair.publicKey());
  assert.equal(verify(null, message, key, signature), true);

  // And a signature from a different key over the same bytes does not.
  assert.equal(verify(null, message, key, Keypair.random().sign(message)), false);
});
