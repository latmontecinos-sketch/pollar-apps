// Spike: verifyPaymentOnHorizon against REAL testnet transactions already on
// chain (no new payment sent). Confirms the Horizon integration itself works
// before it's exercised end-to-end by a real purchase.
import { verifyPaymentOnHorizon } from "../lib/horizon.ts";

const REAL_HASH = "04416794dcd1b82bfa04b51c856d3f57375adb94a6d5ecbdf968a7a8e54ee50c";
const REAL_RECIPIENT = "GAHU3GHKWDY6AGO4E3ZNGDH427J5ISLNEKFZP5NND7V2RVOV2XULYL5K";
const REAL_AMOUNT = "5.0000000";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}`);
  if (ok) passed++;
  else failed++;
}

async function main() {
  // 1. Real tx, correct recipient + amount, but wrong reference (this was a
  // plain transfer with no memo) -> must reject as mismatch, not crash.
  const wrongMemo = await verifyPaymentOnHorizon({
    hash: REAL_HASH,
    organizerAddress: REAL_RECIPIENT,
    amountDecimal: REAL_AMOUNT,
    reference: "p_does_not_exist",
  });
  check("real tx + wrong memo -> mismatch", !wrongMemo.ok && wrongMemo.code === "mismatch");

  // 2. Real tx, correct recipient, but wrong amount -> mismatch.
  const wrongAmount = await verifyPaymentOnHorizon({
    hash: REAL_HASH,
    organizerAddress: REAL_RECIPIENT,
    amountDecimal: "0.1000000",
    reference: "p_does_not_exist",
  });
  check("real tx + wrong amount -> mismatch", !wrongAmount.ok && wrongAmount.code === "mismatch");

  // 3. Real tx, wrong recipient -> mismatch (never matches someone else's payment).
  const wrongRecipient = await verifyPaymentOnHorizon({
    hash: REAL_HASH,
    organizerAddress: "GBVBN3PX3R6DJTVJE5C65LAGFECSDHGNYEUZY6KOQWXP7G5PIMD35IOS",
    amountDecimal: REAL_AMOUNT,
    reference: "p_does_not_exist",
  });
  check("real tx + wrong recipient -> mismatch", !wrongRecipient.ok && wrongRecipient.code === "mismatch");

  // 4. Nonexistent hash -> not_found, never treated as "invalid" outright.
  const notFound = await verifyPaymentOnHorizon({
    hash: "00".repeat(32),
    organizerAddress: REAL_RECIPIENT,
    amountDecimal: REAL_AMOUNT,
    reference: "p_does_not_exist",
  });
  check("nonexistent hash -> not_found", !notFound.ok && notFound.code === "not_found");

  // 5. Malformed hash -> rejected before ever calling Horizon.
  const malformed = await verifyPaymentOnHorizon({
    hash: "not-a-hash",
    organizerAddress: REAL_RECIPIENT,
    amountDecimal: REAL_AMOUNT,
    reference: "p_does_not_exist",
  });
  check("malformed hash -> mismatch (no network call)", !malformed.ok && malformed.code === "mismatch");

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) process.exit(1);
}

void main();
