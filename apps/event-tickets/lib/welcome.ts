import { USDC_CODE } from "./network.ts";

/**
 * The welcome gift is a Pollar distribution rule (Dashboard → Treasury →
 * Token Distribution), claimed by the user from the SDK. These two decisions
 * are kept out of the component so they can be tested without React or the
 * network: which rule to offer, and what a failed claim means for the card.
 */

export type ClaimableRule = { id: string; assetCode: string; amount: string; claimable: boolean };

/** The rule the card offers: a claimable USDC one first (it pays for a ticket), else any claimable one. */
export function pickWelcomeRule<T extends ClaimableRule>(rules: readonly T[]): T | null {
  const open = rules.filter((rule) => rule.claimable);
  return open.find((rule) => rule.assetCode === USDC_CODE) ?? open[0] ?? null;
}

/**
 * The SDK throws `new Error(code)` on a failed claim.
 * - `claimed`: this user already took it — the card just goes away.
 * - `gone`: nobody can claim it right now (ran out, ended, switched off).
 * - `retry`: anything else, including a network or Stellar failure.
 */
export type ClaimFailure = "claimed" | "gone" | "retry";

const GONE = new Set([
  "DISTRIBUTION_RULE_NOT_FOUND",
  "DISTRIBUTION_RULE_DISABLED",
  "DISTRIBUTION_RULE_NOT_STARTED",
  "DISTRIBUTION_RULE_EXPIRED",
  "DISTRIBUTION_RULE_EXHAUSTED",
  "DISTRIBUTION_NO_DISTRIBUTION_WALLET",
  "DISTRIBUTION_ASSET_NOT_ENABLED",
]);

export function claimFailure(err: unknown): ClaimFailure {
  const code = err instanceof Error ? err.message.trim() : "";
  if (code === "DISTRIBUTION_RATE_LIMIT_EXCEEDED") return "claimed";
  return GONE.has(code) ? "gone" : "retry";
}
