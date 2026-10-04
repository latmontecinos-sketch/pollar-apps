/**
 * Rows from before the claim columns existed must not read as "nobody ever
 * sent": a payment may have left from the old client and not been recorded
 * yet. The migration that adds `pay_started_at` / `refund_started_at` writes
 * those rows as if an attempt had started, in the same transaction as the
 * ALTER, and only the first time.
 *
 * Builds a database shaped like the one before the claims (a `sales` table
 * without the new columns), then lets the app's own migration run on it. Its
 * own file DB: it never touches dev.db or production, and nothing here reaches
 * the network.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { after, before, test } from "node:test";
import { createClient } from "@libsql/client";

const DB_FILE = `test-migration-${randomUUID()}.db`;
const URL = `file:./${DB_FILE}`;
process.env.DATABASE_URL = URL;
delete process.env.DATABASE_AUTH_TOKEN;

const LEGACY_SALES = `CREATE TABLE sales (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  buyer_pollar_id TEXT NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  amount_stroops INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  tx_hash TEXT,
  expires_at_utc TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

/** `created`: SQLite's own "YYYY-MM-DD HH:MM:SS", the way the old code stored it. */
async function legacyRow(
  client: ReturnType<typeof createClient>,
  id: string,
  status: string,
  createdMinutesAgo: number,
  holdMinutesFromCreation: number
) {
  await client.execute({
    sql: `INSERT INTO sales (id, event_id, buyer_pollar_id, reference, amount_stroops, idempotency_key,
                             status, expires_at_utc, created_at)
          VALUES (?, 'E1', 'GBUYER', ?, 10000000, ?, ?,
                  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?, ?),
                  datetime('now', ?))`,
    args: [
      id,
      `ref-${id}`,
      `key-${id}`,
      status,
      `-${createdMinutesAgo} minutes`,
      `+${holdMinutesFromCreation} minutes`,
      `-${createdMinutesAgo} minutes`,
    ],
  });
}

before(async () => {
  const legacy = createClient({ url: URL });
  await legacy.execute(LEGACY_SALES);
  await legacyRow(legacy, "pending-live", "pending", 5, 10);
  await legacyRow(legacy, "pending-old", "pending", 120, 10);
  await legacyRow(legacy, "paid", "paid", 30, 10);
  await legacyRow(legacy, "unclaimed", "unclaimed", 60, 10);
  await legacyRow(legacy, "expired", "expired", 60, 10);
  legacy.close();
});

const { db, dbReady } = await import("../lib/db.ts");
const { ATTEMPT_SLACK_MS, ATTEMPT_TX_TIMEOUT_SEC, attemptState } = await import("../lib/pay-attempt.ts");

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

async function row(id: string) {
  return (await db.execute({ sql: "SELECT * FROM sales WHERE id = ?", args: [id] })).rows[0];
}

test("a pending sale from before the claims reads as an attempt started at its creation", async () => {
  await dbReady();
  const live = await row("pending-live");
  const startedAt = String(live.pay_started_at);
  // An ISO string like every value the claim writes, taken from the sale's creation.
  assert.match(startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const created = Date.parse(`${String(live.created_at).replace(" ", "T")}Z`);
  assert.equal(Date.parse(startedAt), created);

  // NULL no longer means "never sent": the sale is in flight until the attempt's deadline...
  assert.equal(attemptState(startedAt, Date.now()), "in_flight");
  // ...and dead only after it, which is when the normal rules (a chain search, then a release) apply.
  const deadline = created + ATTEMPT_TX_TIMEOUT_SEC * 1000 + ATTEMPT_SLACK_MS;
  assert.equal(attemptState(startedAt, deadline + 1), "dead");
  // The hold is stretched to that deadline, like a claim would have, and never shortened.
  assert.equal(Date.parse(String(live.expires_at_utc)), deadline);
  // Nobody holds a token for it, so no release can name this attempt.
  assert.equal(live.pay_claim_token, null);
});

test("an old pending sale is started in the past, so it is dead and goes through the normal rules", async () => {
  const old = await row("pending-old");
  assert.notEqual(old.pay_started_at, null);
  assert.equal(attemptState(String(old.pay_started_at), Date.now()), "dead");
});

test("only pending sales are marked as purchases in flight", async () => {
  for (const id of ["paid", "unclaimed", "expired"]) {
    assert.equal((await row(id)).pay_started_at, null, id);
  }
});

test("an unclaimed sale from before the claims reads as a refund that may be on its way", async () => {
  const unclaimed = await row("unclaimed");
  const startedAt = String(unclaimed.refund_started_at);
  assert.match(startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  // Fenced as of the migration: the old client kept no start time, so "now" is the safe reading.
  assert.ok(Math.abs(Date.parse(startedAt) - Date.now()) < 60_000);
  assert.equal(attemptState(startedAt, Date.now()), "in_flight");
  assert.equal(unclaimed.refund_claim_token, null);
  // Nothing else gets a refund start.
  for (const id of ["pending-live", "paid", "expired"]) {
    assert.equal((await row(id)).refund_started_at, null, id);
  }
});

test("running the migration again changes nothing: the backfill is for the first time only", async () => {
  // A row the app wrote after the migration: nobody has started it, and it must stay that way.
  await db.execute({
    sql: `INSERT INTO sales (id, event_id, buyer_pollar_id, reference, amount_stroops, idempotency_key,
                             status, expires_at_utc)
          VALUES ('fresh', 'E1', 'GBUYER', 'ref-fresh', 10000000, 'key-fresh', 'pending', ?)`,
    args: [new Date(Date.now() + 10 * 60_000).toISOString()],
  });
  const before = (await row("pending-live")).pay_started_at;
  // A second boot, as its own process, over the same file.
  execFileSync(
    process.execPath,
    ["--input-type=module", "-e", "const { dbReady } = await import('./lib/db.ts'); await dbReady();"],
    { env: { ...process.env, DATABASE_URL: URL }, stdio: "pipe" }
  );
  assert.equal((await row("fresh")).pay_started_at, null, "a sale nobody started is not rewritten");
  assert.equal((await row("pending-live")).pay_started_at, before);
});
