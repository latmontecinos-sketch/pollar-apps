import { expectedUsdcIssuer, USDC_CODE } from "./network.ts";

export { expectedUsdcIssuer };

/**
 * Is this Horizon operation a payment in the USDC we price tickets in?
 *
 * The issuer comes from lib/network.ts, which derives it from the same
 * publishable key the SDK and Horizon are derived from — so "which USDC"
 * can no longer disagree with "which network".
 */
export function isUsdcPayment(op: {
  asset_code?: string;
  asset_issuer?: string;
  asset_type?: string;
}): boolean {
  if (op.asset_code !== USDC_CODE) return false;
  if (op.asset_type === "native") return false;
  return op.asset_issuer === expectedUsdcIssuer();
}
