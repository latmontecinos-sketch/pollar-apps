/**
 * An exclusive claim shared by every tab and window of this browser.
 *
 * Why it exists: a button that disables itself protects one component in one
 * tab. Two tabs of the same account can both press "pay" for the same
 * reservation, and the second payment is real money with nothing to settle
 * it. Whoever is about to send a payment first takes a claim named after
 * what it pays; a second tab is told "held" and must not send.
 *
 * Web Locks is the real thing (released by the browser even if the tab
 * crashes). The `localStorage` fallback is best-effort for browsers without
 * it: a claim older than `CLAIM_TTL_MS` is treated as abandoned.
 */

type LockManagerLike = {
  request: (
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: object | null) => Promise<unknown>
  ) => Promise<unknown>;
};

type StorageLike = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

export type ClaimDeps = {
  locks?: LockManagerLike | null;
  storage?: StorageLike | null;
  now?: () => number;
  token?: () => string;
};

/** Longer than a submit (30 s) plus its confirmation polling (~40 s). */
export const CLAIM_TTL_MS = 2 * 60 * 1000;

export type Claimed<T> = { held: false } | { held: true; value: T };

function browserLocks(): LockManagerLike | null {
  if (typeof navigator === "undefined") return null;
  const locks = (navigator as { locks?: LockManagerLike }).locks;
  return locks && typeof locks.request === "function" ? locks : null;
}

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Runs `fn` only if nobody else holds `name`. `{ held: false }` means another
 * tab is on it: the caller must NOT proceed to send anything.
 */
export async function withClaim<T>(
  name: string,
  fn: () => Promise<T>,
  deps: ClaimDeps = {}
): Promise<Claimed<T>> {
  const locks = deps.locks === undefined ? browserLocks() : deps.locks;
  if (locks) {
    let outcome: Claimed<T> = { held: false };
    await locks.request(`pollarpass:${name}`, { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      outcome = { held: true, value: await fn() };
    });
    return outcome;
  }

  const storage = deps.storage === undefined ? browserStorage() : deps.storage;
  if (!storage) {
    // Nothing to coordinate with (private mode, blocked storage): the caller's
    // other guards (the in-flight record, verify-first) still apply.
    return { held: true, value: await fn() };
  }
  const now = deps.now ?? Date.now;
  const key = `pollarpass:claim:${name}`;
  const mine = (deps.token ?? (() => Math.random().toString(36).slice(2)))();

  const read = (): { token: string; at: number } | null => {
    try {
      const raw = storage.getItem(key);
      return raw ? (JSON.parse(raw) as { token: string; at: number }) : null;
    } catch {
      return null;
    }
  };
  const current = read();
  if (current && now() - current.at < CLAIM_TTL_MS) return { held: false };
  try {
    storage.setItem(key, JSON.stringify({ token: mine, at: now() }));
  } catch {
    return { held: true, value: await fn() };
  }
  // Two tabs can both pass the check above in the same instant; the one
  // whose write survives is the one that goes on.
  if (read()?.token !== mine) return { held: false };
  try {
    return { held: true, value: await fn() };
  } finally {
    if (read()?.token === mine) {
      try {
        storage.removeItem(key);
      } catch {
        /* the TTL frees it */
      }
    }
  }
}
