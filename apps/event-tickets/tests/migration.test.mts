/**
 * Rows from before the claim protocol must not read as "nobody ever sent": a
 * payment may have left from an older client and not been recorded yet. A
 * one-time, versioned fence (`claim-fence-v1` in `schema_migrations`) writes
 * those rows as if an attempt had started, in one transaction that also records
 * itself, and is a no-op on every later boot.
 *
 * It must work from BOTH shapes a database can be in:
 *  - the pre-claims schema (no `pay_started_at` / `refund_started_at`), and
 *  - the shape an intermediate version (0726ee6 / a68f478) left: the columns
 *    exist and every old row has NULL there, so the ALTERs are no-ops.
 *
 * Each scenario builds its own file DB and lets the app's own migration run on
 * it in a child process (the app keeps one DB connection per process). Nothing
 * here touches dev.db or production, or the network.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { after, test } from "node:test";
import { createClient, type Client } from "@libsql/client";

import { ATTEMPT_SLACK_MS, ATTEMPT_TX_TIMEOUT_SEC, attemptState } from "../lib/pay-attempt.ts";

const files: string[] = [];

after(() => {
  for (const file of files) {
    for (const suffix of ["", "-shm", "-wal"]) {
      try {
        rmSync(`${file}${suffix}`, { force: true });
      } catch {
        /* left behind on purpose rather than failing the suite */
      }
    }
  }
});

const PRE_CLAIMS_SALES = `CREATE TABLE sales (
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

/** What 0726ee6 left: the claim columns exist (the tokens came later), old rows hold NULL. */
const INTERMEDIATE_COLUMNS = [
  "ALTER TABLE sales ADD COLUMN ticket_type_id TEXT",
  "ALTER TABLE sales ADD COLUMN refund_tx_hash TEXT",
  "ALTER TABLE sales ADD COLUMN buyer_email TEXT",
  "ALTER TABLE sales ADD COLUMN buyer_locale TEXT",
  "ALTER TABLE sales ADD COLUMN pay_started_at TEXT",
  "ALTER TABLE sales ADD COLUMN refund_started_at TEXT",
];

type Shape = "pre-claims" | "intermediate";

/** `created`: SQLite's own "YYYY-MM-DD HH:MM:SS", the way the app stores it. */
async function oldRow(client: Client, id: string, status: string, createdMinutesAgo: number) {
  await client.execute({
    sql: `INSERT INTO sales (id, event_id, buyer_pollar_id, reference, amount_stroops, idempotency_key,
                             status, expires_at_utc, created_at)
          VALUES (?, 'E1', 'GBUYER', ?, 10000000, ?, ?,
                  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?, '+10 minutes'),
                  datetime('now', ?))`,
    args: [id, `ref-${id}`, `key-${id}`, status, `-${createdMinutesAgo} minutes`, `-${createdMinutesAgo} minutes`],
  });
}

/** A database of the given shape holding the rows below, then migrated by the app (a child process). */
async function upgraded(shape: Shape) {
  const file = `test-migration-${randomUUID()}.db`;
  files.push(file);
  const url = `file:./${file}`;
  const client = createClient({ url });
  await client.execute(PRE_CLAIMS_SALES);
  if (shape === "intermediate") for (const statement of INTERMEDIATE_COLUMNS) await client.execute(statement);

  await oldRow(client, "pending-live", "pending", 5);
  await oldRow(client, "pending-old", "pending", 120);
  await oldRow(client, "paid", "paid", 30);
  await oldRow(client, "unclaimed", "unclaimed", 60);
  await oldRow(client, "expired", "expired", 60);
  if (shape === "intermediate") {
    // An attempt the intermediate version already recorded: the fence must not rewrite it.
    await oldRow(client, "already-started", "pending", 3);
    await client.execute(
      "UPDATE sales SET pay_started_at = '2026-01-01T00:00:00.000Z' WHERE id = 'already-started'"
    );
    await oldRow(client, "refund-started", "unclaimed", 3);
    await client.execute(
      "UPDATE sales SET refund_started_at = '2026-01-02T00:00:00.000Z' WHERE id = 'refund-started'"
    );
  }

  client.close();

  const boot = () =>
    execFileSync(
      process.execPath,
      ["--input-type=module", "-e", "const { dbReady } = await import('./lib/db.ts'); await dbReady();"],
      { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" }
    );
  boot();
  // A fresh connection: the one that built the old shape would keep reading its old schema.
  const after = createClient({ url });
  const row = async (id: string) =>
    (await after.execute({ sql: "SELECT * FROM sales WHERE id = ?", args: [id] })).rows[0];
  return { client: after, row, boot };
}

for (const shape of ["pre-claims", "intermediate"] as const) {
  test(`${shape}: a pending sale reads as an attempt started at its creation`, async () => {
    const { client, row } = await upgraded(shape);
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

    const old = await row("pending-old");
    assert.equal(attemptState(String(old.pay_started_at), Date.now()), "dead");
    client.close();
  });

  test(`${shape}: only pending sales are marked as purchases in flight`, async () => {
    const { client, row } = await upgraded(shape);
    for (const id of ["paid", "unclaimed", "expired"]) assert.equal((await row(id)).pay_started_at, null, id);
    client.close();
  });

  test(`${shape}: an unclaimed sale reads as a refund that may be on its way`, async () => {
    const { client, row } = await upgraded(shape);
    const unclaimed = await row("unclaimed");
    const startedAt = String(unclaimed.refund_started_at);
    assert.match(startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // Fenced as of the migration: the old client kept no start time, so "now" is the safe reading.
    assert.ok(Math.abs(Date.parse(startedAt) - Date.now()) < 60_000);
    assert.equal(attemptState(startedAt, Date.now()), "in_flight");
    assert.equal(unclaimed.refund_claim_token, null);
    for (const id of ["pending-live", "paid", "expired"]) assert.equal((await row(id)).refund_started_at, null, id);
    client.close();
  });

  test(`${shape}: the fence is recorded once and later boots change nothing`, async () => {
    const { client, row, boot } = await upgraded(shape);
    const recorded = await client.execute("SELECT name FROM schema_migrations");
    assert.deepEqual(recorded.rows.map((r) => String(r.name)), ["claim-fence-v1"]);

    // Rows the app writes after the migration: nobody started them, and they must stay that way.
    await oldRow(client, "fresh-pending", "pending", 0);
    await oldRow(client, "fresh-unclaimed", "unclaimed", 0);
    const before = (await row("pending-live")).pay_started_at;
    boot();
    assert.equal((await row("fresh-pending")).pay_started_at, null, "a sale nobody started is not rewritten");
    assert.equal((await row("fresh-unclaimed")).refund_started_at, null);
    assert.equal((await row("pending-live")).pay_started_at, before);
    assert.equal((await client.execute("SELECT count(*) AS n FROM schema_migrations")).rows[0].n, 1);
    client.close();
  });
}

test("intermediate: an attempt the older version already recorded is left exactly as it was", async () => {
  const { client, row } = await upgraded("intermediate");
  assert.equal((await row("already-started")).pay_started_at, "2026-01-01T00:00:00.000Z");
  assert.equal((await row("refund-started")).refund_started_at, "2026-01-02T00:00:00.000Z");
  client.close();
});

test("a brand new database records the fence and has nothing to fence", async () => {
  const file = `test-migration-${randomUUID()}.db`;
  files.push(file);
  const url = `file:./${file}`;
  execFileSync(
    process.execPath,
    ["--input-type=module", "-e", "const { dbReady } = await import('./lib/db.ts'); await dbReady();"],
    { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" }
  );
  const client = createClient({ url });
  assert.equal((await client.execute("SELECT count(*) AS n FROM schema_migrations")).rows[0].n, 1);
  assert.equal((await client.execute("SELECT count(*) AS n FROM sales")).rows[0].n, 0);
  client.close();
});
