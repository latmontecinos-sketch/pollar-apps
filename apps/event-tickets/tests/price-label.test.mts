import assert from "node:assert/strict";
import { test } from "node:test";
import { DICTIONARIES } from "../lib/i18n/index.ts";
import { priceLabel, priceRange, tierPrice } from "../lib/price-label.ts";

const es = DICTIONARIES.es;

test("an event's price reads right whether its tiers are paid, free or both", () => {
  assert.equal(priceLabel(es, "es", "0.0500000", "0.1000000"), "Desde 0,05 USDC");
  assert.equal(priceLabel(es, "es", "0.0000000", "0.0000000"), "Gratis");
  assert.equal(priceLabel(es, "es", "0.0000000", "0.1000000"), "Gratis y hasta 0,10 USDC");
  assert.equal(priceLabel(DICTIONARIES.en, "en", "0", "0"), "Free");
});

test("a single tier says Gratis instead of 0,00 USDC", () => {
  assert.equal(tierPrice(es, "es", "0.0000000"), "Gratis");
  assert.equal(tierPrice(es, "es", "0.1000000"), "0,10 USDC");
});

test("the advertised range counts only tiers with a seat left, and all of them once none has", () => {
  const free = { priceDecimal: "0.0000000", capacity: 1, reserved: 1 };
  const general = { priceDecimal: "0.0500000", capacity: 10, reserved: 3 };
  const platea = { priceDecimal: "0.1000000", capacity: 5, reserved: 0 };
  assert.deepEqual(priceRange([free, general, platea]), { minDecimal: "0.0500000", maxDecimal: "0.1000000" });
  assert.deepEqual(priceRange([{ ...free, reserved: 0 }, platea]), { minDecimal: "0.0000000", maxDecimal: "0.1000000" });
  const allGone = [free, { ...platea, reserved: 5 }];
  assert.deepEqual(priceRange(allGone), { minDecimal: "0.0000000", maxDecimal: "0.1000000" });
  assert.deepEqual(priceRange([]), { minDecimal: "0", maxDecimal: "0" });
  // Compared as amounts, not as strings: "0.5" > "0.10".
  const range = priceRange([
    { priceDecimal: "0.5", capacity: 1, reserved: 0 },
    { priceDecimal: "0.10", capacity: 1, reserved: 0 },
  ]);
  assert.deepEqual(range, { minDecimal: "0.10", maxDecimal: "0.5" });
});
