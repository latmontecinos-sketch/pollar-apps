"use client";

import { useState } from "react";
import { usePollar } from "@pollar/react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { useBalance } from "@/hooks/useBalance";
import { formatAmount, middleTruncate } from "@/lib/format";
import { useLocale } from "@/lib/i18n/client";
import {
  currencyOf,
  looksLikeAddress,
  paymentAssetFrom,
  type PaymentResult,
} from "@/lib/payments";

type Step = "amount" | "details" | "review" | "done";

/**
 * Send-money flow: amount → recipient (+ optional memo) → review → done.
 * Payments run through the same SDK method as PayButton
 * (`runTx('payment', …)`); the memo travels in the tx options.
 */
export function SendModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { runTx } = usePollar();
  const { balance, asset } = useBalance();
  const locale = useLocale();
  const [step, setStep] = useState<Step>("amount");
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [memo, setMemo] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PaymentResult | null>(null);

  const payAsset = paymentAssetFrom(asset);
  const currency = currencyOf(payAsset);

  // Fresh flow every time the sheet opens (state-adjust-during-render pattern).
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setStep("amount");
      setAmount("");
      setRecipient(process.env.NEXT_PUBLIC_DEMO_RECIPIENT ?? "");
      setMemo("");
      setError(null);
      setResult(null);
    }
  }

  const amountNumber = Number(amount);
  const amountValid =
    /^\d+(\.\d{1,7})?$/.test(amount) &&
    amountNumber > 0 &&
    (balance === null || amountNumber <= Number(balance));
  const overBalance =
    amount !== "" && balance !== null && amountNumber > Number(balance);

  async function confirm() {
    setSending(true);
    setError(null);
    try {
      const res = await runTx(
        "payment",
        { destination: recipient.trim(), amount, asset: payAsset },
        memo ? { memo: { type: "text", value: memo } } : undefined
      );
      if (res.status === "error") {
        setError(
          res.message ??
            res.details ??
            "The payment didn't go through. Check the address and your balance, then try again."
        );
      } else {
        setResult(res);
        setStep("done");
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "The payment didn't go through. Check your connection and try again."
      );
    } finally {
      setSending(false);
    }
  }

  const titles: Record<Step, string> = {
    amount: "Send money",
    details: "Who's it for?",
    review: "Confirm payment",
    done: "Payment sent",
  };
  const backOf: Partial<Record<Step, Step>> = {
    details: "amount",
    review: "details",
  };
  const back = backOf[step];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={titles[step]}
      onBack={back ? () => setStep(back) : undefined}
    >
      {step === "amount" && (
        <div className="flex flex-col items-center gap-6 py-4">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted">
            Amount in {currency}
          </span>
          <input
            autoFocus
            inputMode="decimal"
            placeholder="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(",", "."))}
            className="w-full bg-transparent text-center font-mono text-6xl font-semibold tabular-nums tracking-tight outline-none placeholder:text-muted-light"
          />
          <div className="flex flex-col items-center gap-1 text-sm text-muted">
            <span>
              Balance:{" "}
              <span className="font-mono">
                {formatAmount(balance, locale)} {currency}
              </span>
            </span>
            <span className="text-muted-light">
              Fee: covered by the app · Instant
            </span>
          </div>
          {overBalance && (
            <p className="text-sm text-error">
              That&apos;s more than you have. Your balance is{" "}
              {formatAmount(balance, locale)} {currency}.
            </p>
          )}
          <Button
            onClick={() => setStep("details")}
            disabled={!amountValid}
            className="w-full py-3"
          >
            Continue
          </Button>
        </div>
      )}

      {step === "details" && (
        <div className="flex flex-col gap-4 py-2">
          <Input
            label="Recipient address"
            placeholder="G…"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            error={
              recipient && !looksLikeAddress(recipient)
                ? "That doesn't look like a Pollar address. It starts with G and has 56 characters."
                : undefined
            }
            className="font-mono"
          />
          <Input
            label="Memo (optional)"
            placeholder="What's it for?"
            value={memo}
            maxLength={28}
            onChange={(e) => setMemo(e.target.value)}
          />
          <Button
            onClick={() => setStep("review")}
            disabled={!looksLikeAddress(recipient)}
            className="w-full py-3"
          >
            Review
          </Button>
        </div>
      )}

      {step === "review" && (
        <div className="flex flex-col gap-5 py-2">
          <div className="flex flex-col items-center gap-1 py-2">
            <span className="text-sm text-muted">Amount</span>
            <span className="font-mono text-4xl font-semibold tabular-nums tracking-tight">
              {amount} {currency}
            </span>
          </div>
          <div className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface">
            <div className="flex items-center justify-between gap-4 px-4 py-3.5">
              <span className="text-sm text-muted">To</span>
              <span
                className="font-mono text-sm font-medium"
                title={recipient}
              >
                {middleTruncate(recipient.trim(), 6, 6)}
              </span>
            </div>
            {memo && (
              <div className="flex items-center justify-between gap-4 px-4 py-3.5">
                <span className="text-sm text-muted">Memo</span>
                <span className="min-w-0 truncate text-sm font-medium">
                  {memo}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between gap-4 px-4 py-3.5">
              <span className="text-sm text-muted">Fee</span>
              <span className="text-sm font-medium">Covered by the app</span>
            </div>
          </div>
          {error && (
            <p className="rounded-xl border border-error-border bg-error-light px-4 py-3 text-sm text-error">
              {error}
            </p>
          )}
          <Button
            onClick={() => void confirm()}
            loading={sending}
            className="w-full py-3"
          >
            {sending ? "Sending…" : "Confirm"}
          </Button>
        </div>
      )}

      {step === "done" && result && (
        <div className="flex flex-col gap-4">
          <EmptyState
            title="Payment sent!"
            description={`${amount} ${currency} went to ${middleTruncate(recipient.trim(), 6, 6)}. ${
              result.status === "pending"
                ? "It settles in a few seconds."
                : "It's confirmed on the network."
            } Your balance is already up to date.`}
          />
          <Button onClick={onClose} variant="secondary" className="w-full py-3">
            Done
          </Button>
        </div>
      )}
    </Modal>
  );
}
