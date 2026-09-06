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
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
};

function normalizeAmount(value: string): string {
  const n = Number(value);
  if (Number.isNaN(n)) return value.trim();
  return n.toFixed(7);
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

/**
 * Confirms `hash` is a successful USDC payment to `organizerAddress` for
 * exactly `amountDecimal`, memo'd with this sale's unique `reference`
 * (Plan A: reference in memo, cross-checked here against the on-chain
 * operation — Plan C). Network/Horizon failures come back as "not_found",
 * never as a silent false — the caller must keep the sale pending, not
 * mark it un-paid.
 */
export async function verifyPaymentOnHorizon(opts: {
  hash: string;
  organizerAddress: string;
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
    if (op.to !== opts.organizerAddress) return false;
    if (!isUsdcPayment(op)) return false;
    if (normalizeAmount(op.amount ?? "") !== normalizeAmount(opts.amountDecimal)) {
      return false;
    }
    return true;
  });

  if (!payment) {
    return {
      ok: false,
      error: "El pago en Horizon no coincide (USDC al organizador, monto y memo)",
      code: "mismatch",
    };
  }

  return { ok: true };
}
