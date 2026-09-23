import type { SubmitOutcome, WalletBalanceRecord } from "@pollar/core";

/** Asset for `runTx('payment', …)`. */
export type PaymentAsset =
  | { type: "native" }
  | { type: "credit_alphanum4" | "credit_alphanum12"; code: string; issuer: string };

export type PaymentResult = Extract<
  SubmitOutcome,
  { status: "success" | "pending" }
>;

/**
 * The exact asset a sale is denominated in, as `runTx('payment', …)` wants it.
 *
 * The code and issuer come from the server (the sale response), never from
 * whatever the wallet happens to list first: a ticket priced in USDC has to
 * be paid in that USDC, and the client is not the right place to decide
 * which. Stellar picks the asset type purely by code length.
 */
export function creditAsset(asset: { code: string; issuer: string }): PaymentAsset {
  if (!asset.issuer) {
    throw new Error(`El activo ${asset.code} llegó sin emisor, así que no se puede pagar con él`);
  }
  return {
    type: asset.code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12",
    code: asset.code,
    issuer: asset.issuer,
  };
}

/**
 * The asset a payment should use, taken from a wallet balance record.
 *
 * Throws rather than falling back: the old fallback returned native XLM when
 * the record carried no issuer, which is not a fallback but a change of
 * currency — it would have sent XLM at a price quoted in USDC. Anything that
 * can't name its asset must stop, not guess.
 */
export function paymentAssetFrom(
  record: WalletBalanceRecord | null
): PaymentAsset {
  if (record?.type === "native") return { type: "native" };
  if (
    record &&
    (record.type === "credit_alphanum4" || record.type === "credit_alphanum12") &&
    record.issuer
  ) {
    return { type: record.type, code: record.code, issuer: record.issuer };
  }
  throw new Error(
    "No se pudo determinar el activo del pago desde el balance de la billetera"
  );
}

export function currencyOf(asset: PaymentAsset): string {
  return asset.type === "native" ? "XLM" : asset.code;
}

/** Loose G-address sanity check; the server does the real validation. */
export function looksLikeAddress(value: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(value.trim());
}
