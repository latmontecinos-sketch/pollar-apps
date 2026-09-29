import { createPublicKey, type KeyObject } from "node:crypto";

/**
 * A Stellar `G…` address is an ed25519 public key in a checksummed base32
 * envelope. Reading it out is the only thing this app ever needed from
 * `@stellar/stellar-base` — a 3.1 MB dependency, deprecated upstream ("now
 * rolled into @stellar/stellar-sdk"), carrying the one primitive the whole
 * authorization model rests on. Node verifies ed25519 natively; this file is
 * the small piece that was missing.
 *
 * Nothing here is cryptography: it is an encoding, and the signature check
 * itself stays with `node:crypto`. The checksum guards against a mistyped
 * address, not against an attacker — a wrong key simply fails verification,
 * so every error path here is closed rather than permissive.
 *
 * The library is still a devDependency, and tests/security.test.mts signs
 * with it while the server verifies with this: a permanent cross-check
 * against the reference implementation.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, no padding — strkeys are always a whole number of bytes. */
function base32Decode(input: string): Uint8Array {
  const out = new Uint8Array(Math.floor((input.length * 5) / 8));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const character of input) {
    const position = BASE32_ALPHABET.indexOf(character);
    if (position === -1) throw new Error("La dirección tiene caracteres que no son base32");
    value = (value << 5) | position;
    bits += 5;
    if (bits >= 8) {
      out[index++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return out;
}

/** CRC16-XModem: polynomial 0x1021, zero seed, MSB first — what Stellar appends. */
function crc16xmodem(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** Version byte for an ed25519 public key, the one that renders as a leading "G". */
const ED25519_PUBLIC_KEY_VERSION = 0x30;

/**
 * `G…` (56 chars) -> the raw 32-byte ed25519 public key.
 * Throws on anything malformed; callers treat that as a failed verification.
 */
export function decodeStellarPublicKey(address: string): Buffer {
  if (!/^G[A-Z2-7]{55}$/.test(address)) {
    throw new Error("No tiene forma de dirección Stellar");
  }
  const decoded = base32Decode(address);
  if (decoded.length !== 35) {
    throw new Error("La dirección no decodifica a 35 bytes");
  }
  if (decoded[0] !== ED25519_PUBLIC_KEY_VERSION) {
    throw new Error("La dirección no es una clave pública ed25519");
  }
  // Checksum covers the version byte plus the key, and is stored little-endian.
  const payload = decoded.subarray(0, 33);
  const expected = decoded[33] | (decoded[34] << 8);
  if (crc16xmodem(payload) !== expected) {
    throw new Error("El checksum de la dirección no cierra");
  }
  return Buffer.from(decoded.subarray(1, 33));
}

/**
 * The fixed DER/SPKI header for an ed25519 public key. Node's `createPublicKey`
 * wants a structured key, and for this curve the structure is a constant
 * followed by the 32 raw bytes.
 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** A `G…` address as a key object `crypto.verify` can use. */
export function ed25519PublicKeyFrom(address: string): KeyObject {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, decodeStellarPublicKey(address)]),
    format: "der",
    type: "spki",
  });
}
