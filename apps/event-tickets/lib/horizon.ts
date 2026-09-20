import { decimalToStroops } from "./money.ts";
import { isUsdcPayment } from "./usdc.ts";

const HORIZON =
  process.env.HORIZON_URL?.replace(/\/$/, "") ??
  "https://horizon-testnet.stellar.org";

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

async function horizonGet<T>(path: string): Promise<T | null> {
  const res = await fetch(`${HORIZON}${path}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
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
      transaction_hash?: string;
      transaction?: { memo?: string | null; memo_type?: string | null };
    }>;
  };
};

/**
 * Recovery path when the client never delivered a hash (closed the tab,
 * lost signal, Horizon hadn't indexed it yet): scans `account`'s most recent
 * payments (the organizer's for a sale, the buyer's for a refund) for the
 * unique `memo`. Returns the hash to feed into `verifyPaymentOnHorizon` —
 * the full check (amount, asset, parties) still runs there, this only finds
 * the tx. `undefined` = Horizon unreachable (retry later), `null` = none.
 */
export async function findPaymentHashByMemo(opts: {
  account: string;
  memo: string;
}): Promise<string | null | undefined> {
  let page: PaymentsPage | null;
  try {
    page = await horizonGet<PaymentsPage>(
      `/accounts/${encodeURIComponent(opts.account)}/payments?order=desc&limit=200&join=transactions`
    );
  } catch {
    return undefined;
  }
  const match = page?._embedded?.records?.find(
    (record) =>
      record.type === "payment" &&
      record.transaction?.memo_type === "text" &&
      (record.transaction.memo ?? "").trim() === opts.memo
  );
  return match?.transaction_hash ?? null;
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
}): Promise<HorizonCheck> {
  const hash = opts.hash.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    return { ok: false, error: "Hash de transacción inválido", code: "mismatch" };
  }

  let tx: HorizonTx | null;
  try {
    tx = await horizonGet<HorizonTx>(`/transactions/${hash}`);
  } catch {
    return { ok: false, error: "No se pudo consultar Horizon", code: "not_found" };
  }
  if (!tx) {
    return { ok: false, error: "Transacción no encontrada en testnet", code: "not_found" };
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

  type OpsPage = { _embedded?: { records?: HorizonOp[] } };
  let ops: OpsPage | null;
  try {
    ops = await horizonGet<OpsPage>(`/transactions/${hash}/operations?limit=50`);
  } catch {
    return { ok: false, error: "No se pudieron leer las operaciones", code: "not_found" };
  }

  const records = ops?._embedded?.records ?? [];
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
