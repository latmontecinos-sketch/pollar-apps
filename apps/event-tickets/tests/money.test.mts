/** Money is integer stroops end to end; these are the conversions everything else trusts. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { decimalToStroops, stroopsToDecimal } from "../lib/money.ts";

test("decimal -> stroops keeps 7 decimals exactly", () => {
  assert.equal(decimalToStroops("0"), 0n);
  assert.equal(decimalToStroops("0.01"), 100_000n);
  assert.equal(decimalToStroops("12.50"), 125_000_000n);
  assert.equal(decimalToStroops("0.0000001"), 1n);
});

test("stroops -> decimal round-trips", () => {
  for (const value of ["0.0100000", "12.5000000", "0.0000001", "1000000.0000000"]) {
    assert.equal(stroopsToDecimal(decimalToStroops(value)), value);
  }
});

test("amounts a float would get wrong", () => {
  // 0.1 + 0.2 !== 0.3 in floating point; in stroops it is exact.
  assert.equal(decimalToStroops("0.1") + decimalToStroops("0.2"), decimalToStroops("0.3"));
  // A price × capacity that would drift as a float.
  assert.equal(decimalToStroops("0.07") * 3n, decimalToStroops("0.21"));
});

test("rejects anything that isn't a plain non-negative decimal", () => {
  for (const bad of ["", "-1", "1,5", "1.23456789", "abc", "1e3", " 1 .5"]) {
    assert.throws(() => decimalToStroops(bad), /Invalid decimal amount/, `accepted "${bad}"`);
  }
});

test("negative stroops never render as an amount", () => {
  assert.throws(() => stroopsToDecimal(-1n), /negative/);
});
