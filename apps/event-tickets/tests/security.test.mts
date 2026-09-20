/**
 * The abuse cases, as tests. Everything here is something an attacker would
 * try, written so that a future change that quietly re-opens the door fails
 * the build instead of shipping.
 *
 * Uses its own file DB, so it never touches dev.db or production.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { after, before, test } from "node:test";
import { Keypair } from "@stellar/stellar-base";

const DB_FILE = `test-sales-${randomUUID()}.db`;
process.env.DATABASE_URL = `file:./${DB_FILE}`;
delete process.env.DATABASE_AUTH_TOKEN;

const { db, dbReady } = await import("../lib/db.ts");
const { authMessage, normalizeRoute, POLLAR_PROOF_HEADER } = await import("../lib/auth-message.ts");
const { DOOR_TOKEN_HEADER, doorTokenExpired, newDoorToken, requireDoorAccess, requireSignedAddress } =
  await import("../lib/auth.ts");
const { isDeliverableEmail } = await import("../lib/mail.ts");
const { QUOTAS, consume } = await import("../lib/rate-limit.ts");
const { maskEmail, shortAddress } = await import("../lib/security-log.ts");

const ORIGIN = "https://pollarpass.vercel.app";
const SEP53_PREFIX = "Stellar Signed Message:\n";

before(async () => {
  await dbReady();
});

after(() => {
  db.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    try {
      rmSync(`${DB_FILE}${suffix}`, { force: true });
    } catch {
      /* left behind on purpose rather than failing the suite */
    }
  }
});

/** What the browser does in lib/auth-client.ts, minus the Pollar round trip. */
function sign(keypair: Keypair, message: string): string {
  const payload = Buffer.concat([Buffer.from(SEP53_PREFIX, "utf8"), Buffer.from(message, "utf8")]);
  return keypair.sign(createHash("sha256").update(payload).digest()).toString("base64");
}

type ProofOptions = { method?: string; path?: string; exp?: number; signedAs?: string };

/** A request carrying a proof — by default a valid one for the route it calls. */
function requestWithProof(
  keypair: Keypair,
  method: string,
  path: string,
  options: ProofOptions = {}
): Request {
  const exp = options.exp ?? Date.now() + 60_000;
  const message = authMessage(
    options.signedAs ?? keypair.publicKey(),
    exp,
    options.method ?? method,
    options.path ?? path
  );
  const proof = {
    address: options.signedAs ?? keypair.publicKey(),
    exp,
    signature: sign(keypair, message),
  };
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { [POLLAR_PROOF_HEADER]: JSON.stringify(proof) },
  });
}

test("a proof signed for the endpoint being called is accepted", () => {
  const keypair = Keypair.random();
  const got = requireSignedAddress(requestWithProof(keypair, "POST", "/api/events"));
  assert.equal(got.ok, true);
  assert.equal(got.ok && got.address, keypair.publicKey());
});

test("a proof lifted from one endpoint cannot be spent on another", () => {
  const keypair = Keypair.random();
  // Signed for a harmless read, replayed against the route that rotates the
  // door link — the whole reason the route is part of the message.
  const stolen = requestWithProof(keypair, "POST", `/api/events/${randomUUID()}/door-link`, {
    method: "GET",
    path: "/api/sales/mine",
  });
  assert.equal(requireSignedAddress(stolen).ok, false);
});

test("a proof cannot be replayed with a different method on the same path", () => {
  const keypair = Keypair.random();
  const path = `/api/events/${randomUUID()}`;
  const escalated = requestWithProof(keypair, "PATCH", path, { method: "GET", path });
  assert.equal(requireSignedAddress(escalated).ok, false);
});

test("one signature covers every id of the same route, and nothing else", () => {
  const keypair = Keypair.random();
  const other = randomUUID();
  // Deliberate: binding the exact id would mean a wallet popup per sale.
  const reused = requestWithProof(keypair, "POST", `/api/sales/${other}/confirm`, {
    path: `/api/sales/${randomUUID()}/confirm`,
  });
  assert.equal(requireSignedAddress(reused).ok, true);

  assert.equal(normalizeRoute("/api/sales/4f8e/confirm"), "/api/sales/:id/confirm");
  assert.equal(normalizeRoute("/api/sales/mine"), "/api/sales/mine");
  assert.equal(normalizeRoute("/api/events/mine"), "/api/events/mine");
  assert.equal(normalizeRoute("/api/notifications"), "/api/notifications");
});

test("an expired proof is refused, and so is one that claims a long life", () => {
  const keypair = Keypair.random();
  const stale = requestWithProof(keypair, "GET", "/api/sales/mine", { exp: Date.now() - 1 });
  assert.equal(requireSignedAddress(stale).ok, false);

  // Signing "valid for a week" must not buy a week.
  const greedy = requestWithProof(keypair, "GET", "/api/sales/mine", {
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
  });
  assert.equal(requireSignedAddress(greedy).ok, false);
});

test("a proof cannot claim to be someone else's address", () => {
  const keypair = Keypair.random();
  const victim = Keypair.random().publicKey();
  const forged = requestWithProof(keypair, "GET", "/api/sales/mine", { signedAs: victim });
  assert.equal(requireSignedAddress(forged).ok, false);
});

test("a request with no proof at all is refused", () => {
  const bare = new Request(`${ORIGIN}/api/sales/mine`, { method: "GET" });
  assert.equal(requireSignedAddress(bare).ok, false);

  const junk = new Request(`${ORIGIN}/api/sales/mine`, {
    method: "GET",
    headers: { [POLLAR_PROOF_HEADER]: "not json" },
  });
  assert.equal(requireSignedAddress(junk).ok, false);
});

test("the staff door token opens its own event and nothing else", () => {
  const token = newDoorToken();
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const event = {
    organizer_pollar_id: Keypair.random().publicKey(),
    door_token: token,
    datetime_utc: tomorrow,
  };
  const withToken = (value: string) =>
    new Request(`${ORIGIN}/api/events/x/door`, {
      method: "POST",
      headers: { [DOOR_TOKEN_HEADER]: value },
    });

  assert.equal(requireDoorAccess(withToken(token), event).ok, true);
  assert.equal(requireDoorAccess(withToken(newDoorToken()), event).ok, false);
  // Revoked from the organizer's panel.
  assert.equal(requireDoorAccess(withToken(token), { ...event, door_token: null }).ok, false);
});

test("a door link stops working a day after its event", () => {
  const token = newDoorToken();
  const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const event = {
    organizer_pollar_id: Keypair.random().publicKey(),
    door_token: token,
    datetime_utc: lastWeek,
  };
  const request = new Request(`${ORIGIN}/api/events/x/door`, {
    method: "POST",
    headers: { [DOOR_TOKEN_HEADER]: token },
  });
  assert.equal(requireDoorAccess(request, event).ok, false);

  const start = new Date("2026-05-01T20:00:00.000Z").toISOString();
  assert.equal(doorTokenExpired(start, Date.parse("2026-05-02T19:00:00.000Z")), false);
  assert.equal(doorTokenExpired(start, Date.parse("2026-05-02T21:00:00.000Z")), true);
});

test("the door token is a real secret, not a guessable id", () => {
  const tokens = new Set(Array.from({ length: 200 }, () => newDoorToken()));
  assert.equal(tokens.size, 200);
  // 18 random bytes, base64url: 144 bits.
  assert.equal(newDoorToken().length, 24);
});

test("a quota lets the honest case through and stops the loop", async () => {
  const subject = `test-${randomUUID()}`;
  const { limit } = QUOTAS.createEvent;

  for (let attempt = 0; attempt < limit; attempt++) {
    const result = await consume("createEvent", subject);
    assert.equal(result.ok, true, `hit ${attempt + 1} of ${limit} should pass`);
  }

  const blocked = await consume("createEvent", subject);
  assert.equal(blocked.ok, false);
  assert.ok(!blocked.ok && blocked.retryAfterSeconds > 0);

  // Quotas are per subject: one noisy account never blocks anyone else.
  assert.equal((await consume("createEvent", `test-${randomUUID()}`)).ok, true);
});

test("addresses and emails are shortened before they reach a log", () => {
  const address = Keypair.random().publicKey();
  const short = shortAddress(address);
  assert.ok(!short.includes(address.slice(8, 40)));
  assert.match(short, /^G[A-Z2-7]{3}…[A-Z2-7]{4}$/);

  assert.equal(maskEmail("comprador@gmail.com"), "c…@gmail.com");
  assert.equal(maskEmail("sin-arroba"), "…");
});

test("only something shaped like a mailbox is stored and mailed", () => {
  assert.equal(isDeliverableEmail("alguien@ejemplo.com"), true);
  assert.equal(isDeliverableEmail("a@b.co"), true);
  assert.equal(isDeliverableEmail("sin-arroba"), false);
  assert.equal(isDeliverableEmail("dos@destinos.com, otro@destino.com"), false);
  assert.equal(isDeliverableEmail("con espacio@ejemplo.com"), false);
  assert.equal(isDeliverableEmail(`${"a".repeat(250)}@ejemplo.com`), false);
});
