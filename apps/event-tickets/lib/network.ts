/**
 * Which Stellar network this deployment talks to — decided once, here.
 *
 * Before this module the answer lived in three places that could disagree:
 * the SDK read the publishable key's prefix, the expected USDC issuer read
 * that same prefix on its own, and Horizon read a `HORIZON_URL` that
 * defaulted to testnet. A mainnet key with `HORIZON_URL` forgotten meant
 * every payment got verified against a chain it was never on — `not_found`
 * forever, money taken, no ticket. Anything network-shaped (issuer, Horizon,
 * explorer links, "this money isn't real" copy) now comes from this file.
 */

export type StellarNetworkName = "testnet" | "mainnet";

/**
 * The publishable key is network-scoped (`pub_testnet_…` / `pub_mainnet_…`)
 * and it is the one value both the browser and the server can read, so it is
 * the root of the decision rather than one opinion among several.
 */
const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY ?? "";

export const NETWORK: StellarNetworkName = PUBLISHABLE_KEY.startsWith("pub_mainnet_")
  ? "mainnet"
  : "testnet";

/** Gate for anything that must not be said about real money (see lib/i18n). */
export const IS_MAINNET = NETWORK === "mainnet";

/** Circle USDC, the only asset this app prices tickets in. */
const USDC_ISSUERS: Record<StellarNetworkName, string> = {
  testnet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  mainnet: "GA5ZSEJYB37JRC5JMCP5ZJYS4ENFSOFAKTOWYFCLJXSN5M5X3TMXCY4I",
};

const DEFAULT_HORIZON: Record<StellarNetworkName, string> = {
  testnet: "https://horizon-testnet.stellar.org",
  mainnet: "https://horizon.stellar.org",
};

/** stellar.expert calls the public network "public", not "mainnet". */
const EXPLORER_BASE: Record<StellarNetworkName, string> = {
  testnet: "https://stellar.expert/explorer/testnet",
  mainnet: "https://stellar.expert/explorer/public",
};

/**
 * `HORIZON_URL` still overrides (a private Horizon, a local one for tests),
 * but an override that contradicts the key is refused loudly at import time
 * instead of quietly verifying payments on the wrong chain. A 500 on the
 * first request is a far better failure than a checkout that takes money
 * and never finds it.
 */
function resolveHorizon(): string {
  const override = process.env.HORIZON_URL?.trim().replace(/\/$/, "");
  if (!override) return DEFAULT_HORIZON[NETWORK];

  const pointsAtTestnet = /horizon-testnet\.stellar\.org/i.test(override);
  const pointsAtPublic = /\/\/horizon\.stellar\.org/i.test(override);
  if ((IS_MAINNET && pointsAtTestnet) || (!IS_MAINNET && pointsAtPublic)) {
    throw new Error(
      `HORIZON_URL (${override}) apunta a una red distinta de la que indica ` +
        `NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY (${NETWORK}). Con esta combinación los pagos ` +
        `se verificarían contra una cadena en la que nunca ocurrieron: el comprador paga ` +
        `y nunca recibe su entrada. Corregí una de las dos variables.`
    );
  }
  return override;
}

export const HORIZON_URL = resolveHorizon();

export const USDC_CODE = "USDC";

/**
 * Server-side only: `USDC_ISSUER` lets a deployment pin a different issuer
 * (a test asset, say). The browser never sees it, which is deliberate — the
 * client pays the asset the *sale* tells it to (see app/api/sales/route.ts),
 * never one it picked itself, so the two can't drift apart.
 */
export function expectedUsdcIssuer(): string {
  const override = process.env.USDC_ISSUER?.trim();
  return override || USDC_ISSUERS[NETWORK];
}

/** The asset a sale is denominated in, as the payment layer wants it. */
export function usdcAsset(): { code: string; issuer: string } {
  return { code: USDC_CODE, issuer: expectedUsdcIssuer() };
}

/** Where a buyer or organizer goes to see their own payment on-chain. */
export function explorerTxUrl(hash: string): string {
  return `${EXPLORER_BASE[NETWORK]}/tx/${hash}`;
}
