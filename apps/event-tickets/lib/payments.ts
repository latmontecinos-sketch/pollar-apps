import type { WalletBalanceRecord } from "@pollar/core";
import { decimalToStroops } from "./money.ts";

/** Asset for `runTx('payment', …)`. */
export type PaymentAsset =
  | { type: "native" }
  | { type: "credit_alphanum4" | "credit_alphanum12"; code: string; issuer: string };

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
 * What `runTx` told us about a submission:
 * - `sent`: it carries a hash, so the network saw it. Whether it *succeeded*
 *   is Horizon's call (via the server), never ours.
 * - `rejected`: it provably never left — a typed network/balance refusal
 *   (`TX_*`), no wallet to sign with, or the person declining in their wallet.
 *   Nothing was charged; the seat or the refund can be given back at once.
 * - `unknown`: an error with no hash and no such proof (a timeout, a dropped
 *   response, a bare server error). The submission may well have gone
 *   through, and the only honest next step is to look for it on the chain.
 *
 * The SDK RETURNS this kind of failure instead of throwing it, and its
 * `error` outcome without a hash is the same shape whether the request never
 * left or the answer never came back. Treating it as "not paid" is what let
 * a second payment go out.
 */
export type SubmitVerdict = "sent" | "rejected" | "unknown";

type OutcomeLike = {
  status?: string;
  hash?: string;
  code?: string;
  details?: string;
  message?: string;
};

/** Raised by the SDK before anything is submitted (see `buildAndSignAndSubmitTx`). */
const BEFORE_SUBMIT = [
  /no wallet connected/i,
  /wallet not connected/i,
  /missing unsigned transaction/i,
  /no prepared smart transaction/i,
  /build returned no unsigned transaction/i,
  // A person declining in their own wallet (Freighter, Albedo…).
  /\buser (declined|rejected|denied|refused|cancell?ed|closed)/i,
  /\b(declined|cancell?ed) by (the )?user/i,
];

export function classifySubmit(outcome: OutcomeLike | null | undefined): SubmitVerdict {
  if (!outcome) return "unknown";
  if (outcome.hash) return "sent";
  if (outcome.status !== "error") return "unknown";
  if (outcome.code && /^(SDK_)?TX_/.test(outcome.code)) return "rejected";
  const text = `${outcome.details ?? ""} ${outcome.message ?? ""}`;
  if (BEFORE_SUBMIT.some((pattern) => pattern.test(text))) return "rejected";
  return "unknown";
}

/**
 * Does the wallet hold at least `amountDecimal` of exactly this asset (code
 * AND issuer)? `null` when it can't be told (an unreadable balance).
 * Matching the issuer matters: anyone can issue an asset called USDC.
 */
export function holdsAtLeast(
  balances: WalletBalanceRecord[],
  asset: { code: string; issuer: string },
  amountDecimal: string
): boolean | null {
  const record = balances.find(
    (b) => b.type !== "native" && b.code === asset.code && b.issuer === asset.issuer
  );
  if (!record) return false;
  const held = record.available ?? record.balance;
  if (held === null || held === undefined) return null;
  try {
    return decimalToStroops(held) >= decimalToStroops(amountDecimal);
  } catch {
    return null;
  }
}
