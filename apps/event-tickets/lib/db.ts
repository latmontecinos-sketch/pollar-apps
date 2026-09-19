import { createClient, type Client, type Transaction } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Local: unset -> `file:./dev.db`, no setup beyond the Pollar key (bounty
 * acceptance criterion). Production: DATABASE_URL must point at a libSQL/
 * Turso database — a serverless filesystem is read-only and not shared
 * across invocations, so a silent fallback to `file:` there would look like
 * it works while quietly losing every write.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "file:./dev.db";
const DATABASE_AUTH_TOKEN = process.env.DATABASE_AUTH_TOKEN;
const IS_LOCAL_FILE_DB = DATABASE_URL.startsWith("file:");

function ensureLocalDbDir(): void {
  if (!IS_LOCAL_FILE_DB) return;
  const dir = dirname(DATABASE_URL.replace(/^file:/, ""));
  if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
}

/** One connection per process, kept on globalThis so Next's dev hot-reload doesn't open a new one on every edit. */
const globalDb = globalThis as {
  __eventTicketsDb?: Client;
  __eventTicketsDbReady?: Promise<void>;
};

function createDbClient(): Client {
  ensureLocalDbDir();
  return createClient({
    url: DATABASE_URL,
    authToken: DATABASE_AUTH_TOKEN,
    // Local file: only — makes SQLite itself wait for a released lock
    // instead of throwing SQLITE_BUSY immediately. Remote clients ignore it
    // (the Hrana/HTTP server already serializes writes, per Fase 0).
    timeout: 5000,
  });
}

export const db = (globalDb.__eventTicketsDb ??= createDbClient());

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS events (
     id TEXT PRIMARY KEY,
     organizer_pollar_id TEXT NOT NULL,
     name TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     datetime_utc TEXT NOT NULL,
     place TEXT NOT NULL,
     price_stroops INTEGER NOT NULL,
     capacity INTEGER NOT NULL,
     reserved INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS sales (
     id TEXT PRIMARY KEY,
     event_id TEXT NOT NULL REFERENCES events(id),
     buyer_pollar_id TEXT NOT NULL,
     reference TEXT NOT NULL UNIQUE,
     amount_stroops INTEGER NOT NULL,
     idempotency_key TEXT NOT NULL UNIQUE,
     status TEXT NOT NULL,
     tx_hash TEXT,
     expires_at_utc TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS sales_event_idx ON sales (event_id)`,
  `CREATE INDEX IF NOT EXISTS sales_status_idx ON sales (status)`,
  `CREATE INDEX IF NOT EXISTS sales_buyer_idx ON sales (buyer_pollar_id)`,
  `CREATE TABLE IF NOT EXISTS tickets (
     id TEXT PRIMARY KEY,
     sale_id TEXT NOT NULL UNIQUE REFERENCES sales(id),
     event_id TEXT NOT NULL REFERENCES events(id),
     code TEXT NOT NULL UNIQUE,
     door_code TEXT NOT NULL,
     used_at TEXT,
     used_by TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     UNIQUE (event_id, door_code)
   )`,
];

/**
 * Columns added after the first deploy. SQLite has no ADD COLUMN IF NOT
 * EXISTS, so each one is attempted and a "duplicate column" error (already
 * applied on an earlier boot) is the expected no-op.
 */
const ADDED_COLUMNS = [
  // Shown to buyers on the public page, so they know who they're paying and how to reach them.
  `ALTER TABLE events ADD COLUMN organizer_name TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE events ADD COLUMN organizer_contact TEXT NOT NULL DEFAULT ''`,
  // Bearer secret for the staff door link (/puerta/[id]#t=…); NULL = no staff link.
  `ALTER TABLE events ADD COLUMN door_token TEXT`,
  // `unclaimed` -> `refunded`: the organizer's refund payment, verified on Horizon.
  `ALTER TABLE sales ADD COLUMN refund_tx_hash TEXT`,
];

async function runMigrations(): Promise<void> {
  for (const statement of SCHEMA_STATEMENTS) {
    await db.execute(statement);
  }
  for (const statement of ADDED_COLUMNS) {
    try {
      await db.execute(statement);
    } catch (err) {
      if (!(err instanceof Error && /duplicate column/i.test(err.message))) throw err;
    }
  }
}

/**
 * Awaited by every route that touches the database. In production, refuses
 * to run at all if DATABASE_URL was left unset — see the comment above
 * DATABASE_URL. Locally, applies the (idempotent) schema on first use so a
 * fresh clone needs no separate migration step.
 */
export function dbReady(): Promise<void> {
  if (IS_LOCAL_FILE_DB && process.env.NODE_ENV === "production") {
    return Promise.reject(
      new Error(
        "DATABASE_URL no está configurada, así que la app caería a un archivo SQLite local — " +
          "eso no funciona en producción, donde el filesystem no persiste ni se comparte entre " +
          "invocaciones. Configurá DATABASE_URL y DATABASE_AUTH_TOKEN apuntando a tu base libSQL/Turso."
      )
    );
  }
  return (globalDb.__eventTicketsDbReady ??= runMigrations());
}

function isRetryable(err: unknown): boolean {
  return err instanceof Error && /SQLITE_BUSY/i.test(err.message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_BUSY_RETRIES = 5;
const BUSY_RETRY_BASE_MS = 20;

/**
 * Runs `fn` inside a libSQL write transaction, committing on success and
 * rolling back on any throw. Retries the whole attempt on SQLITE_BUSY —
 * observed in Fase 0 against a local file DB under concurrent writers (the
 * remote Turso DB didn't hit this, since Hrana-over-HTTP serializes writes
 * server-side, but the retry is cheap insurance either way).
 */
export async function withTransaction<T>(
  fn: (tx: Transaction) => Promise<T>
): Promise<T> {
  await dbReady();
  for (let attempt = 0; ; attempt++) {
    let tx: Transaction | undefined;
    try {
      // Opening the transaction itself can throw SQLITE_BUSY under
      // concurrent writers, so it has to be inside the retry's try, not
      // before it.
      tx = await db.transaction("write");
      const result = await fn(tx);
      await tx.commit();
      return result;
    } catch (err) {
      await tx?.rollback().catch(() => {});
      if (isRetryable(err) && attempt < MAX_BUSY_RETRIES) {
        await sleep(BUSY_RETRY_BASE_MS * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }
}
