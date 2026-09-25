import assert from "node:assert/strict";
import { test } from "node:test";
import { DICTIONARIES } from "../lib/i18n/index.ts";
import { priceLabel, tierPrice } from "../lib/price-label.ts";

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
