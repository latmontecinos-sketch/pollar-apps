import { decimalToStroops } from "./money.ts";
import { HORIZON_URL, NETWORK } from "./network.ts";
import { isUsdcPayment } from "./usdc.ts";

/**
 * Which Horizon, and therefore which network, is decided in lib/network.ts —
 * together with the expected USDC issuer, so the two can't contradict.
 */
const HORIZON = HORIZON_URL;

/**
 * Every call here sits in the buyer's critical path, right after their money
 * left. Without a deadline a hung Horizon holds the serverless function until
 * the platform kills it (~300s of undici default), which reaches the buyer as
 * a 504 instead of the retryable error this module is careful to return.
 */
const HORIZON_TIMEOUT_MS = 6000;

export type HorizonCheck =
  | { ok: true }
  | {
      ok: false;
      error: string;
      /** "not_found"/"failed": infra or not-yet-settled, never treat as "no payment". "mismatch": the tx is real but doesn't match this sale. */
      code: "not_found" | "failed" | "mismatch";
    };

type HorizonTx = {
  successful?: boolean;
  memo?: string | null;
  memo_type?: string | null;
};

type HorizonOp = {
  type?: string;
  to?: string;
  from?: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
};

/**
 * Amounts are compared in stroops, never as floats. Everything else in this
 * codebase already refuses to put money through a `number`, and this was the
 * one place that didn't: past ~9·10⁹ USDC two different amounts collapse
 * onto the same double, which is exactly the kind of "can't happen at our
 * prices" that stops being true the day it matters.
 */
function sameAmount(a: string, b: string): boolean {
  try {
    return decimalToStroops(a.trim()) === decimalToStroops(b.trim());
  } catch {
    return false;
  }
}

/**
 * A point in time (ms since epoch) that every request of one operation
 * shares, with the clock it is read against. One deadline for the whole
 * search, passed down to each request, is what keeps the number of candidates
 * from multiplying the wait.
 */
export type Deadline = { at: number; now: () => number };

async function horizonGet<T>(path: string, deadline?: Deadline): Promise<T | null> {
  // Each request gets the smaller of its own timeout and what is left of the
  // operation's budget, so the last one can't overrun it.
  const left = deadline ? deadline.at - deadline.now() : Number.POSITIVE_INFINITY;
  if (left <= 0) throw new Error("Horizon: the search budget is spent");
  const res = await fetch(`${HORIZON}${path}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    // An abort surfaces as a throw, which every caller already maps to the
    // retryable "not_found" — a timeout must never read as "no payment".
    signal: AbortSignal.timeout(Math.min(HORIZON_TIMEOUT_MS, left)),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Horizon ${res.status} on ${path}`);
  }
  return (await res.json()) as T;
}

type PaymentsPage = {
  _embedded?: {
    records?: Array<{
      type?: string;
      paging_token?: string;
      created_at?: string;
      transaction_hash?: string;
      from?: string;
      to?: string;
      transaction?: { memo?: string | null; memo_type?: string | null };
    }>;
  };
};

/** Horizon's page size ceiling. */
const PAGE_LIMIT = 200;
/** 5 x 200 = 1,000 payments looked at, at most: the search is bounded in requests... */
const MAX_PAGES = 5;
/** ...and in time, so a slow Horizon can't hold the buyer's request open. */
export const SEARCH_BUDGET_MS = 20_000;
/** Slack between our clock (sale created_at) and the ledger's. */
const CLOCK_SLACK_MS = 5 * 60 * 1000;

/**
 * Lower bound for a search: the sale's `created_at` (SQLite's
 * "YYYY-MM-DD HH:MM:SS" in UTC, or an ISO string) minus a little clock slack.
 * A payment older than its own sale can't belong to it, which is what lets
 * a search reach a definite "nothing there" instead of paging forever.
 */
export function searchSince(createdAt: string | null | undefined): number | undefined {
  if (!createdAt) return undefined;
  const text = createdAt.includes("T") ? createdAt : `${createdAt.replace(" ", "T")}Z`;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : ms - CLOCK_SLACK_MS;
}

export type MemoSearch =
  | { status: "found"; hash: string }
  /** Looked through everything that could be this payment, and it isn't there. */
  | { status: "none" }
  /**
   * Couldn't tell: Horizon failed, the history was longer than we're willing
   * to read, a candidate couldn't be checked, or (when the caller asked for
   * it) Horizon's ingested history does not yet reach past the attempt's
   * deadline. Never "unpaid": retry.
   */
  | { status: "inconclusive" };

/**
 * May an empty memo search be believed? Only when Horizon's ingested history
 * (`history_latest_ledger_closed_at` of its root document, as ms since epoch,
 * `null` when it could not be read) closed AFTER `pastMs`, the instant after
 * which the attempt being judged can no longer land. A ledger that closed
 * after that instant cannot contain the attempt's transaction, so everything
 * that could have carried it is already in the history we just searched.
 * Without this, a Horizon that answers 200 while its ingestion lags reads as
 * "nothing was sent" and a second payment goes out.
 *
 * Pure on purpose: it is the "may another payment go out" half of the search.
 */
export function historyReaches(historyClosedAtMs: number | null, pastMs: number): boolean {
  return historyClosedAtMs !== null && Number.isFinite(historyClosedAtMs) && historyClosedAtMs > pastMs;
}

/** Applies {@link historyReaches} to a finished search: only `none` can be downgraded. */
export function settleSearch(
  search: MemoSearch,
  historyClosedAtMs: number | null,
  pastMs: number | undefined
): MemoSearch {
  if (search.status !== "none" || pastMs === undefined) return search;
  return historyReaches(historyClosedAtMs, pastMs) ? search : { status: "inconclusive" };
}

type HorizonRoot = { history_latest_ledger_closed_at?: unknown };

/**
 * When the newest ledger Horizon has INGESTED into its history closed (ms), or
 * `null` when it can't be told (the request failed, an older Horizon without
 * the field, an unreadable date). Not the network's latest ledger: what the
 * payment queries can actually see.
 */
export async function horizonHistoryClosedAt(deadline?: Deadline): Promise<number | null> {
  try {
    const root = await horizonGet<HorizonRoot>("/", deadline);
    const closedAt = root?.history_latest_ledger_closed_at;
    if (typeof closedAt !== "string") return null;
    const ms = Date.parse(closedAt);
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

/**
 * Recovery path when the client never delivered a hash (closed the tab,
 * lost signal, Horizon hadn't indexed it yet): scans `account`'s payments for
 * ones carrying the unique `memo`, newest first, and returns the first that
 * passes the FULL check (`verifyPaymentOnHorizon`: destination, asset,
 * amount, memo, success).
 *
 * It used to take the first record with a matching memo and stop. The memo
 * is public on-chain, so anyone could send the buyer a 1-stroop payment
 * carrying it; that newer record then shadowed the real payment, the full
 * check rejected it, and recovery never looked at the older one. Candidates
 * that don't verify are now skipped, not believed.
 */
export async function findVerifiedPaymentByMemo(opts: MemoSearchOptions): Promise<MemoSearch> {
  if (opts.historyPast === undefined) return searchByMemo(opts);
  // The watermark is read BEFORE the search: history that was ingested when
  // the search ran includes everything up to it. Read after, it could be
  // newer than what the search actually saw, and vouch for a lag it missed.
  const now = opts.now ?? Date.now;
  const closedAt = await horizonHistoryClosedAt({ at: now() + HORIZON_TIMEOUT_MS, now });
  return settleSearch(await searchByMemo(opts), closedAt, opts.historyPast);
}

type MemoSearchOptions = {
  account: string;
  memo: string;
  destination: string;
  source?: string;
  amountDecimal: string;
  /** From {@link searchSince}: stop reading history older than this. */
  since?: number;
  /** Total time for the whole search, every request included. Defaults to {@link SEARCH_BUDGET_MS}. */
  budgetMs?: number;
  /** The clock the budget is read against (tests inject one). */
  now?: () => number;
  /**
   * Set when an empty search will be used to let a SECOND payment go out (a
   * takeover, a reopened claim, a start-over): the instant after which the
   * attempt being judged can no longer land. A `none` is then returned only if
   * Horizon's ingested history closed after it (see {@link historyReaches});
   * otherwise it is `inconclusive`.
   */
  historyPast?: number;
};

async function searchByMemo(opts: MemoSearchOptions): Promise<MemoSearch> {
  const now = opts.now ?? Date.now;
  const deadline: Deadline = { at: now() + (opts.budgetMs ?? SEARCH_BUDGET_MS), now };
  let cursor = "";
  let sawProblem = false;
  // A transaction with several payment operations shows up once per
  // operation; it is checked once, whatever it says the first time.
  const checked = new Set<string>();

  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
    if (now() >= deadline.at) return { status: "inconclusive" };

    let page: PaymentsPage | null;
    try {
      page = await horizonGet<PaymentsPage>(
        `/accounts/${encodeURIComponent(opts.account)}/payments?order=desc&limit=${PAGE_LIMIT}&join=transactions` +
          (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""),
        deadline
      );
    } catch {
      return { status: "inconclusive" };
    }
    const records = page?._embedded?.records ?? [];

    for (const record of records) {
      if (
        record.type !== "payment" ||
        record.transaction?.memo_type !== "text" ||
        (record.transaction.memo ?? "").trim() !== opts.memo ||
        record.to !== opts.destination ||
        (opts.source && record.from !== opts.source) ||
        !record.transaction_hash
      ) {
        continue;
      }
      if (checked.has(record.transaction_hash)) continue;
      // The budget is the whole search's, not each page's: a page can hold
      // 200 candidates and each one costs two requests.
      if (now() >= deadline.at) return { status: "inconclusive" };
      checked.add(record.transaction_hash);
      const check = await verifyPaymentOnHorizon({
        hash: record.transaction_hash,
        destination: opts.destination,
        source: opts.source,
        amountDecimal: opts.amountDecimal,
        reference: opts.memo,
        deadline,
      });
      if (check.ok) return { status: "found", hash: record.transaction_hash };
      // A real transaction that doesn't match is just not ours; one we
      // couldn't read leaves the answer open.
      if (check.code !== "mismatch") sawProblem = true;
    }

    const last = records[records.length - 1];
    const reachedEnd = records.length < PAGE_LIMIT || !last?.paging_token;
    const lastAt = last?.created_at ? Date.parse(last.created_at) : Number.NaN;
    const olderThanSale = opts.since !== undefined && !Number.isNaN(lastAt) && lastAt < opts.since;
    if (reachedEnd || olderThanSale) {
      return sawProblem ? { status: "inconclusive" } : { status: "none" };
    }
    cursor = last.paging_token as string;
  }
  // Ran out of pages with history still ahead: not evidence of anything.
  return { status: "inconclusive" };
}

/**
 * Confirms `hash` is a successful USDC payment to `destination` (and, when
 * given, from `source`) for exactly `amountDecimal`, memo'd with `reference`
 * (Plan A: reference in memo, cross-checked here against the on-chain
 * operation — Plan C). Network/Horizon failures come back as "not_found",
 * never as a silent false — the caller must keep the sale pending, not
 * mark it un-paid.
 */
export async function verifyPaymentOnHorizon(opts: {
  hash: string;
  destination: string;
  source?: string;
  amountDecimal: string;
  reference: string;
  /** Shared by a caller that makes several of these (the memo search); a lone check keeps each request's own timeout. */
  deadline?: Deadline;
}): Promise<HorizonCheck> {
  const hash = opts.hash.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    return { ok: false, error: "Hash de transacción inválido", code: "mismatch" };
  }

  type OpsPage = { _embedded?: { records?: HorizonOp[] } };

  // Both lookups are keyed only by `hash`, so the second never needed the
  // first's answer — they were sequential for no reason, doubling the wait in
  // the happy path while the buyer stares at "verificando". `allSettled` so a
  // failure on one still lets the other produce the more specific verdict.
  const [txResult, opsResult] = await Promise.allSettled([
    horizonGet<HorizonTx>(`/transactions/${hash}`, opts.deadline),
    horizonGet<OpsPage>(`/transactions/${hash}/operations?limit=50`, opts.deadline),
  ]);

  if (txResult.status === "rejected") {
    return { ok: false, error: "No se pudo consultar Horizon", code: "not_found" };
  }
  const tx = txResult.value;
  if (!tx) {
    return {
      ok: false,
      error: `Transacción no encontrada en la red de Stellar (${NETWORK})`,
      code: "not_found",
    };
  }
  if (!tx.successful) {
    return { ok: false, error: "La transacción no fue exitosa", code: "failed" };
  }

  const memo = (tx.memo ?? "").trim();
  if (tx.memo_type !== "text" || memo !== opts.reference) {
    return {
      ok: false,
      error: "El memo de la transacción no corresponde a esta venta",
      code: "mismatch",
    };
  }

  if (opsResult.status === "rejected") {
    return { ok: false, error: "No se pudieron leer las operaciones", code: "not_found" };
  }
  const records = opsResult.value?._embedded?.records ?? [];
  const payment = records.find((op) => {
    if (op.type !== "payment") return false;
    if (op.to !== opts.destination) return false;
    if (opts.source && op.from !== opts.source) return false;
    if (!isUsdcPayment(op)) return false;
    if (!sameAmount(op.amount ?? "", opts.amountDecimal)) return false;
    return true;
  });

  if (!payment) {
    return {
      ok: false,
      error: "El pago en Horizon no coincide (destinatario, USDC, monto y memo)",
      code: "mismatch",
    };
  }

  return { ok: true };
}
