/** Circle USDC on Stellar testnet. */
export const TESTNET_USDC_ISSUER =
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

/** Circle USDC on Stellar public network. */
export const MAINNET_USDC_ISSUER =
  "GA5ZSEJYB37JRC5JMCP5ZJYS4ENFSOFAKTOWYFCLJXSN5M5X3TMXCY4I";

export function expectedUsdcIssuer(): string {
  const override = process.env.USDC_ISSUER?.trim();
  if (override) return override;
  const key = process.env.NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY ?? "";
  return key.startsWith("pub_mainnet_")
    ? MAINNET_USDC_ISSUER
    : TESTNET_USDC_ISSUER;
}

export function isUsdcPayment(op: {
  asset_code?: string;
  asset_issuer?: string;
  asset_type?: string;
}): boolean {
  if (op.asset_code !== "USDC") return false;
  if (op.asset_type === "native") return false;
  return op.asset_issuer === expectedUsdcIssuer();
}
