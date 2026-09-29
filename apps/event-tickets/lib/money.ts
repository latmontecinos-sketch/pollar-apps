/**
 * stroops <-> decimal, string-based (never `number`/`parseFloat`).
 * Stellar/USDC use 7 decimals: 1 stroop = 0.0000001.
 */

const DECIMALS = 7;
const SCALE = 10_000_000n; // 10^DECIMALS

/** "12.50" -> 125000000n. Throws on anything that isn't a plain non-negative decimal. */
export function decimalToStroops(decimal: string): bigint {
  const trimmed = decimal.trim();
  if (!/^\d+(\.\d{1,7})?$/.test(trimmed)) {
    throw new Error(`Invalid decimal amount: "${decimal}"`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  return BigInt(whole) * SCALE + BigInt(frac.padEnd(DECIMALS, "0"));
}

/** 125000000n -> "12.5000000" (the decimal string the Pollar SDK / Horizon expect). */
export function stroopsToDecimal(stroops: bigint): string {
  if (stroops < 0n) throw new Error("stroops amount cannot be negative");
  const whole = stroops / SCALE;
  const frac = stroops % SCALE;
  return `${whole}.${frac.toString().padStart(DECIMALS, "0")}`;
}
