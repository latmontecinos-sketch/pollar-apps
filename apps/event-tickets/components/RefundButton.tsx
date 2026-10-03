"use client";

import { useEffect, useRef, useState } from "react";
import { usePollar } from "@pollar/react";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { useBalance } from "@/hooks/useBalance";
import { pollarFetch } from "@/lib/auth-client";
import { canForgetRefundIntent, parseRefundIntent, type RefundIntent } from "@/lib/checkout";
import { withClaim } from "@/lib/claim";
import { formatAmount, shortAddress } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n/client";
import { apiErrorMessage } from "@/lib/i18n/errors";
import { classifySubmit, creditAsset, holdsAtLeast } from "@/lib/payments";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";

/** `asset` comes from the server: the sale's own USDC, never whatever the wallet lists first. */
type RefundPlan = {
  destination: string;
  amountDecimal: string;
  memo: string;
  asset: { code: string; issuer: string };
};

type State =
  | { step: "idle" }
  | { step: "loading_plan" }
  | { step: "confirm"; plan: RefundPlan }
  | { step: "paying" }
  | { step: "verifying" }
  | { step: "done" }
  | { step: "error"; message: string }
  /** The refund may already be on its way: only offer verification, never a second payment. */
  | { step: "unverified"; message: string };

/** One refund in flight per sale, remembered across reloads. */
const intentKey = (saleId: string) => `pollarpass:reembolso:${saleId}`;

function readIntent(saleId: string): RefundIntent | null {
  try {
    return parseRefundIntent(localStorage.getItem(intentKey(saleId)));
  } catch {
    return null;
  }
}

function writeIntent(saleId: string, value: RefundIntent | null) {
  try {
    if (value) localStorage.setItem(intentKey(saleId), JSON.stringify(value));
    else localStorage.removeItem(intentKey(saleId));
  } catch {
    // Blocked storage: the server still refuses a second refund it can see on the chain.
  }
}

/**
 * Returns a late payment (an `unclaimed` sale: the buyer paid after their
 * reservation expired, so no ticket was issued). The organizer sends it
 * from their own Pollar wallet with the sale's refund memo; our server
 * verifies it on Horizon before marking the sale `refunded`.
 *
 * Money safety, same as checkout: the intent is written BEFORE the SDK is
 * called, so a reload finds it and only ever verifies; the plan is fetched
 * again right before sending, so one loaded minutes ago (or in another tab)
 * can't become a second transfer; and a failure with no hash is only a
 * "never sent" when it provably is.
 */
export function RefundButton({ saleId, onRefunded }: { saleId: string; onRefunded: () => void }) {
  const { user } = usePollarAuth();
  const t = useT();
  const locale = useLocale();
  const pollar = usePollar();
  const pollarRef = useRef(pollar);
  useEffect(() => {
    pollarRef.current = pollar;
  });
  // Called for its side effect: it loads the wallet the funds check below reads.
  useBalance();
  const [state, setState] = useState<State>({ step: "idle" });
  // What this wallet holds, by asset code AND issuer: a "USDC" from another
  // issuer is not the sale's USDC. Only read once the wallet has loaded.
  const balances = pollar.walletBalance.step === "loaded" ? pollar.walletBalance.data.balances : null;

  /** Fetches the plan; the answer is also the last word on "is this still refundable?". */
  async function fetchPlan(): Promise<
    { ok: true; plan: RefundPlan } | { ok: false; code?: string; message: string }
  > {
    if (!user) return { ok: false, message: t.refund.errorPrepare };
    try {
      const res = await pollarFetch(
        pollarRef.current.getClient(),
        user.address,
        `/api/sales/${saleId}/refund`
      );
      const data = (await res.json()) as RefundPlan & { error?: string; code?: string };
      if (!res.ok) {
        return { ok: false, code: data.code, message: apiErrorMessage(t, data, t.refund.errorPrepare) };
      }
      return { ok: true, plan: data };
    } catch {
      return { ok: false, message: t.refund.errorPrepare };
    }
  }

  async function loadPlan() {
    if (!user) return;
    // A refund already on its way is verified first, never offered again.
    if (readIntent(saleId)) {
      await record();
      return;
    }
    setState({ step: "loading_plan" });
    const result = await fetchPlan();
    if (result.ok) return setState({ step: "confirm", plan: result.plan });
    if (result.code === "refund_already_sent") return void (await record());
    setState({ step: "error", message: result.message });
  }

  /** Asks the server to look the refund up (by hash, or by memo) and mark the sale. */
  async function record(hash?: string) {
    if (!user) return;
    setState({ step: "verifying" });
    const intent = readIntent(saleId);
    const knownHash = hash ?? intent?.hash;
    let data: { status?: string; error?: string; code?: string };
    try {
      const res = await pollarFetch(
        pollarRef.current.getClient(),
        user.address,
        `/api/sales/${saleId}/refund`,
        { method: "POST", body: JSON.stringify({ hash: knownHash }) }
      );
      data = (await res.json()) as typeof data;
      if (res.ok && data.status === "refunded") {
        writeIntent(saleId, null);
        setState({ step: "done" });
        onRefunded();
        return;
      }
    } catch {
      setState({ step: "unverified", message: t.refund.errorNotSeen });
      return;
    }
    // The network failed that transaction: nothing left the account.
    if (data.code === "tx_failed") {
      writeIntent(saleId, null);
      setState({ step: "error", message: apiErrorMessage(t, data, t.refund.errorSend) });
      return;
    }
    // A single "not seen" proves nothing; only a long enough silence does.
    if (data.code === "no_payment" && intent && canForgetRefundIntent(intent, Date.now())) {
      writeIntent(saleId, null);
      setState({ step: "idle" });
      return;
    }
    setState({
      step: "unverified",
      message: apiErrorMessage(t, data, t.refund.errorNotSeen),
    });
  }

  // A refund the organizer started before a reload or a closed tab: find out
  // what happened to it before anything else is offered.
  const resumed = useRef(false);
  useEffect(() => {
    if (!user || resumed.current || !readIntent(saleId)) return;
    const timer = setTimeout(() => {
      resumed.current = true;
      void record();
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- record() reads fresh state through refs; the session is what matters
  }, [user, saleId]);

  async function send() {
    // Under a claim, so a second tab can't send the same refund.
    const claimed = await withClaim(`refund:${saleId}`, async () => {
      // Plans loaded earlier are not trusted: ask again, right now.
      setState({ step: "loading_plan" });
      const fresh = await fetchPlan();
      if (!fresh.ok) {
        if (fresh.code === "refund_already_sent") return void (await record());
        setState({ step: "error", message: fresh.message });
        return;
      }
      const plan = fresh.plan;
      if (holdsAtLeast(balances ?? [], plan.asset, plan.amountDecimal) !== true) {
        setState({ step: "error", message: t.refund.errorNoFunds });
        return;
      }
      let asset;
      try {
        asset = creditAsset(plan.asset);
      } catch {
        setState({ step: "error", message: t.refund.errorSend });
        return;
      }

      // Before the SDK is called: from here on a refund may exist.
      const started: RefundIntent = { at: Date.now() };
      writeIntent(saleId, started);
      setState({ step: "paying" });
      let outcome: Awaited<ReturnType<typeof pollar.runTx>> | undefined;
      try {
        outcome = await pollarRef.current.runTx(
          "payment",
          { destination: plan.destination, amount: plan.amountDecimal, asset },
          { memo: { type: "text", value: plan.memo } }
        );
      } catch {
        // Unknown outcome: fall through to verification, never to a second send.
      }
      if (outcome && outcome.status === "error" && classifySubmit(outcome) === "rejected") {
        writeIntent(saleId, null);
        setState({
          step: "error",
          message: outcome.message ?? outcome.details ?? t.refund.errorSend,
        });
        return;
      }
      const hash = outcome?.hash;
      if (hash) writeIntent(saleId, { ...started, hash });
      await record(hash);
    });
    if (!claimed.held) setState({ step: "unverified", message: t.refund.otherTab });
  }

  if (state.step === "done") {
    return (
      <span className="flex items-center gap-1 text-xs font-semibold text-success">
        <Icon name="check" size={13} /> {t.refund.done}
      </span>
    );
  }

  if (state.step === "confirm") {
    const funds = balances ? holdsAtLeast(balances, state.plan.asset, state.plan.amountDecimal) : null;
    return (
      <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3 text-xs leading-5">
        <p>
          {t.refund.confirm(
            `${formatAmount(state.plan.amountDecimal, locale)} ${state.plan.asset.code}`,
            shortAddress(state.plan.destination)
          )}
        </p>
        {funds === false && <p className="text-error">{t.refund.errorNoFunds}</p>}
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={() => setState({ step: "idle" })}>
            {t.common.cancel}
          </Button>
          <Button disabled={funds !== true} onClick={() => void send()}>
            {t.refund.confirmCta}
          </Button>
        </div>
      </div>
    );
  }

  if (state.step === "unverified" || state.step === "error") {
    return (
      <div className="flex flex-col items-end gap-1">
        <p className="text-right text-xs text-error">{state.message}</p>
        <button
          onClick={() => void (state.step === "unverified" ? record() : loadPlan())}
          className="text-xs font-semibold text-primary underline"
        >
          {state.step === "unverified" ? t.refund.verifyAgain : t.refund.retry}
        </button>
      </div>
    );
  }

  const busy = state.step !== "idle";
  return (
    <Button
      variant="secondary"
      loading={busy}
      onClick={() => void loadPlan()}
      className="px-3 py-1.5 text-xs"
    >
      {state.step === "paying"
        ? t.refund.sending
        : state.step === "verifying"
          ? t.refund.verifying
          : t.refund.button}
    </Button>
  );
}
