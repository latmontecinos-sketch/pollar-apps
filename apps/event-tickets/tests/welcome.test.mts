import test from "node:test";
import assert from "node:assert/strict";

import { claimFailure, pickWelcomeRule } from "../lib/welcome.ts";

const rule = (id: string, assetCode: string, claimable: boolean) => ({ id, assetCode, amount: "1", claimable });

test("offers the claimable USDC rule over an earlier claimable XLM one", () => {
  const picked = pickWelcomeRule([rule("xlm", "XLM", true), rule("usdc", "USDC", true)]);
  assert.equal(picked?.id, "usdc");
});

test("never offers a rule the server says this user can't claim", () => {
  assert.equal(pickWelcomeRule([rule("usdc", "USDC", false)]), null);
  assert.equal(pickWelcomeRule([rule("usdc", "USDC", false), rule("xlm", "XLM", true)])?.id, "xlm");
  assert.equal(pickWelcomeRule([]), null);
});

test("an already-used gift hides the card instead of showing an error", () => {
  assert.equal(claimFailure(new Error("DISTRIBUTION_RATE_LIMIT_EXCEEDED")), "claimed");
});

test("a rule nobody can claim right now is 'gone', not a retry", () => {
  for (const code of ["DISTRIBUTION_RULE_EXHAUSTED", "DISTRIBUTION_RULE_EXPIRED", "DISTRIBUTION_NO_DISTRIBUTION_WALLET"]) {
    assert.equal(claimFailure(new Error(code)), "gone", code);
  }
});

test("anything unknown — a network error, a failed Stellar tx — is worth retrying", () => {
  assert.equal(claimFailure(new Error("Failed to claim distribution rule")), "retry");
  assert.equal(claimFailure(new TypeError("fetch failed")), "retry");
  assert.equal(claimFailure("not even an error"), "retry");
});
