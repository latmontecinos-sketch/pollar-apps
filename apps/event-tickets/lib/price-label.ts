import { formatAmount } from "./format.ts";
import type { Dict, Locale } from "./i18n/index.ts";
import { decimalToStroops } from "./money.ts";

/**
 * How an event's price reads in one phrase: "Desde 0,05 USDC", "Gratis", or
 * "Gratis y hasta 0,10 USDC" when free and paid tiers mix. "Desde 0,00 USDC"
 * would be true and read as a bug.
 */
export function priceLabel(t: Dict, locale: Locale, minDecimal: string, maxDecimal: string): string {
  const freeFloor = decimalToStroops(minDecimal) === 0n;
  if (freeFloor && decimalToStroops(maxDecimal) === 0n) return t.tiers.free;
  if (freeFloor) return t.tiers.freeAndPaid(formatAmount(maxDecimal, locale));
  return t.tiers.from(formatAmount(minDecimal, locale));
}

/** One tier's price: "0,10 USDC", or "Gratis". */
export function tierPrice(t: Dict, locale: Locale, priceDecimal: string): string {
  return decimalToStroops(priceDecimal) === 0n ? t.tiers.free : `${formatAmount(priceDecimal, locale)} USDC`;
}

export function isFreePrice(priceDecimal: string): boolean {
  return decimalToStroops(priceDecimal) === 0n;
}
