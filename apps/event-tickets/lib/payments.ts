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
 * - `rejected`: it provably never left — one of a short, explicit list of
 *   refusals (see `REJECTED_CODES`), no wallet to sign with, or the person
 *   declining in their wallet. Nothing was charged; the seat or the refund can
 *   be given back at once.
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

/**
 * Codes the backend returns when it refuses a transaction request outright.
 * They carry no hash and name a condition that stays true on a re-send
 * (nothing to pay it with, a fee above the cap, a destination that can't
 * receive it).
 *
 * This is an allowlist on purpose. The SDK forwards whatever code the backend
 * sends (`_resolveTxApiError`), and its own catalogue
 * (`@pollar/core` errorMessages: TX_INSUFFICIENT_BALANCE, TX_INSUFFICIENT_FEE,
 * TX_FEE_LIMIT_EXCEEDED, TX_DESTINATION_NOT_FOUND, TX_NO_TRUSTLINE,
 * TX_CONTRACT_FAILED, TX_BAD_SEQUENCE) is not a promise that each one comes
 * before submission. The two left out can follow a submission: a bad sequence
 * is exactly what re-sending a transaction that already landed produces, and a
 * contract failure comes out of a simulation that may sit on either side.
 * Anything not listed here is `unknown`, which only ever costs the buyer a
 * wait. The five below are a judgement from their names and the catalogue: the
 * client source cannot prove the order the backend checks things in.
 */
const REJECTED_CODES = {
  TX_INSUFFICIENT_BALANCE: "balance",
  TX_INSUFFICIENT_FEE: "fee",
  TX_FEE_LIMIT_EXCEEDED: "fee",
  TX_DESTINATION_NOT_FOUND: "destination",
  TX_NO_TRUSTLINE: "destination",
} as const satisfies Record<string, RejectionReason>;

/**
 * Exact messages the SDK itself raises on the client before anything is sent
 * (`buildAndSignAndSubmitTx`, `signAndSubmitTx`, `_externalSignerMissing`),
 * compared whole and case-insensitively, never as a substring.
 */
const SDK_BEFORE_SUBMIT = new Set(
  [
    "No wallet connected",
    "Wallet not connected. Reconnect your wallet to sign.",
    "missing unsigned transaction",
    "build returned no unsigned transaction",
    "no prepared smart transaction; call buildTx first",
  ].map((message) => message.toLowerCase())
);

/**
 * A person declining in their own wallet (Freighter, Albedo…): the adapter's
 * short message, whole. Wallets word it differently, so an unrecognised one
 * stays `unknown`; the cost is a wait, never a second payment.
 */
const WALLET_DECLINED =
  /^(the )?user (declined|rejected|denied|refused|cancell?ed|closed)\b[^.\n]{0,60}\.?$/i;

/** Why a payment provably never left, in terms the UI has words for (`t.payRejected`). */
export type RejectionReason = "noWallet" | "declined" | "balance" | "fee" | "destination" | "other";

/**
 * Why `outcome` is a proven non-submission, or `null` when it isn't one. The
 * single place that decides it: `classifySubmit` is just this plus the hash.
 */
export function rejectionReason(outcome: OutcomeLike | null | undefined): RejectionReason | null {
  if (!outcome || outcome.hash || outcome.status !== "error") return null;
  if (outcome.code && Object.prototype.hasOwnProperty.call(REJECTED_CODES, outcome.code)) {
    return REJECTED_CODES[outcome.code as keyof typeof REJECTED_CODES];
  }
  const details = (outcome.details ?? "").trim();
  if (details) {
    const lower = details.toLowerCase();
    if (SDK_BEFORE_SUBMIT.has(lower)) {
      return lower.includes("wallet") ? "noWallet" : "other";
    }
    if (WALLET_DECLINED.test(details)) return "declined";
  }
  return null;
}

export function classifySubmit(outcome: OutcomeLike | null | undefined): SubmitVerdict {
  if (!outcome) return "unknown";
  if (outcome.hash) return "sent";
  if (outcome.status !== "error") return "unknown";
  return rejectionReason(outcome) === null ? "unknown" : "rejected";
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
