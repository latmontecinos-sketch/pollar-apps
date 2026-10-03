/**
 * Removes the temporary databases earlier test runs left behind.
 *
 * Each DB-backed test deletes its own file in `after()`, but on Windows the
 * handle can outlive `db.close()` for a moment, so the delete fails and the
 * file stays. Clearing them before a run keeps the app folder clean without
 * making cleanup able to fail the suite. Only files named by the tests
 * (`test-<suite>-<uuid>.db`, plus their -shm/-wal/-journal) are touched.
 */
import { readdirSync, rmSync } from "node:fs";

const TEST_DB = /^test-[a-z-]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.db(-shm|-wal|-journal)?$/;

let removed = 0;
for (const name of readdirSync(".")) {
  if (!TEST_DB.test(name)) continue;
  try {
    rmSync(name, { force: true });
    removed++;
  } catch {
    /* still locked by another process: the next run gets it */
  }
}
if (removed > 0) console.log(`clean-test-dbs: removed ${removed} leftover test database file(s)`);
