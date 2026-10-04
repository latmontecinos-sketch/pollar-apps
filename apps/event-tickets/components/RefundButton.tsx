"use client";

import { useEffect, useRef, useState } from "react";
import { usePollar } from "@pollar/react";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { useBalance } from "@/hooks/useBalance";
import { pollarFetch } from "@/lib/auth-client";
import { parseRefundIntent, refundKey, serializeRefundIntent, type RefundIntent } from "@/lib/checkout";
import { paymentOptions, sendUnderClaim, type ClaimAnswer } from "@/lib/claimed-send";
import { formatAmount, shortAddress } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n/client";
import { apiErrorMessage } from "@/lib/i18n/errors";
import { creditAsset, holdsAtLeast } from "@/lib/payments";
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

type ApiBody = { error?: string; code?: string };

/** The browser's memory of a refund in flight, per account and sale. It only lets a reload resume verifying. */
function readIntent(address: string | undefined, saleId: string): RefundIntent | null {
  if (!address) return null;
  try {
    return parseRefundIntent(localStorage.getItem(refundKey(address, saleId)), address);
  } catch {
    return null;
  }
}

function writeIntent(address: string | undefined, saleId: string, value: RefundIntent | null) {
  if (!address) return;
  try {
    if (value) localStorage.setItem(refundKey(address, saleId), serializeRefundIntent(value, address));
    else localStorage.removeItem(refundKey(address, saleId));
  } catch {
    // Blocked storage: the server still holds the claim and still refuses a second refund it can see on the chain.
  }
}

/**
 * Returns a late payment (an `unclaimed` sale: the buyer paid after their
 * reservation expired, so no ticket was issued). The organizer sends it
 * from their own Pollar wallet with the sale's refund memo; our server
 * verifies it on Horizon before marking the sale `refunded`.
 *
 * Money safety, same as checkout: before sending, the server is asked for the
 * exclusive right to (`/refund/start`, one conditional UPDATE), so a second
 * tab or device, or a page whose plan was loaded minutes ago, loses and goes
 * to reconcile instead of sending a second transfer. A failure with no hash is
 * only a "never sent" when it provably is; otherwise the refund is looked up
 * on the chain. The browser never decides from a clock that nothing was sent:
 * the server says (`retryable`).
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
  const address = user?.address;
  // What this wallet holds, by asset code AND issuer: a "USDC" from another
  // issuer is not the sale's USDC. Only read once the wallet has loaded.
  const balances = pollar.walletBalance.step === "loaded" ? pollar.walletBalance.data.balances : null;

  /** Reads the plan; `started` says the refund was already taken by someone. */
  async function fetchPlan(): Promise<
    { ok: true; plan: RefundPlan; started: boolean } | { ok: false; message: string }
  > {
    if (!user) return { ok: false, message: t.refund.errorPrepare };
    try {
      const res = await pollarFetch(pollarRef.current.getClient(), user.address, `/api/sales/${saleId}/refund`);
      const data = (await res.json()) as RefundPlan & ApiBody & { started?: boolean };
      if (!res.ok) return { ok: false, message: apiErrorMessage(t, data, t.refund.errorPrepare) };
      return { ok: true, plan: data, started: data.started === true };
    } catch {
      return { ok: false, message: t.refund.errorPrepare };
    }
  }

  async function loadPlan() {
    if (!user) return;
    // A refund already on its way is verified first, never offered again.
    if (readIntent(address, saleId)) {
      await record();
      return;
    }
    setState({ step: "loading_plan" });
    const result = await fetchPlan();
    if (!result.ok) return setState({ step: "error", message: result.message });
    // Someone (another tab, another device) already took this refund: reconcile.
    if (result.started) return void (await record());
    setState({ step: "confirm", plan: result.plan });
  }

  /**
   * Asks the server to look the refund up (by hash, or by memo) and mark the
   * sale. `heldNote`: this tab lost the claim, so a refund still missing is
   * the other sender's to finish.
   */
  async function record(hash?: string, opts: { heldNote?: boolean } = {}) {
    if (!user) return;
    setState({ step: "verifying" });
    const intent = readIntent(address, saleId);
    const knownHash = hash ?? intent?.hash;
    let data: ApiBody & { status?: string; retryable?: boolean };
    try {
      const res = await pollarFetch(
        pollarRef.current.getClient(),
        user.address,
        `/api/sales/${saleId}/refund`,
        { method: "POST", body: JSON.stringify({ hash: knownHash }) }
      );
      data = (await res.json()) as typeof data;
      if (res.ok && data.status === "refunded") {
        writeIntent(address, saleId, null);
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
      writeIntent(address, saleId, null);
      setState({ step: "error", message: apiErrorMessage(t, data, t.refund.errorSend) });
      return;
    }
    // Nothing on the chain, and the server — which knows whose attempt this is
    // and when its transaction dies — says it may be tried again.
    if (data.code === "no_payment" && data.retryable === true) {
      writeIntent(address, saleId, null);
      setState({ step: "idle" });
      return;
    }
    setState({
      step: "unverified",
      message:
        data.code === "no_payment" && opts.heldNote && !knownHash
          ? t.refund.otherTab
          : apiErrorMessage(t, data, t.refund.errorNotSeen),
    });
  }

  // A refund the organizer started before a reload or a closed tab: find out
  // what happened to it before anything else is offered.
  const resumedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!address || resumedFor.current === `${address}:${saleId}` || !readIntent(address, saleId)) return;
    const timer = setTimeout(() => {
      resumedFor.current = `${address}:${saleId}`;
      void record();
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- record() reads fresh state through refs; the session is what matters
  }, [address, saleId]);

  /** Asks the server for the exclusive right to send; its answer carries the plan to send. */
  async function claimRefund(): Promise<ClaimAnswer<RefundPlan>> {
    if (!user) return { kind: "unreachable" };
    try {
      const res = await pollarFetch(
        pollarRef.current.getClient(),
        user.address,
        `/api/sales/${saleId}/refund/start`,
        { method: "POST" }
      );
      const data = (await res.json()) as RefundPlan &
        ApiBody & { claimed?: boolean; startedAt?: string; claimToken?: string; remainingSec?: number };
      if (
        res.ok &&
        data.claimed === true &&
        typeof data.startedAt === "string" &&
        typeof data.claimToken === "string" &&
        typeof data.remainingSec === "number"
      ) {
        return {
          kind: "won",
          startedAt: data.startedAt,
          claimToken: data.claimToken,
          remainingSec: data.remainingSec,
          value: data,
        };
      }
      if (res.status === 409 && (data.code === "refund_already_started" || data.code === "refund_already_sent")) {
        return { kind: "held" };
      }
      // A server error says nothing about whether the claim was taken.
      if (res.status >= 500) return { kind: "unreachable" };
      return { kind: "refused", code: data.code, error: data.error };
    } catch {
      return { kind: "unreachable" };
    }
  }

  /** Hands the claim back after a refusal proven before anything was sent. Needs the winner's token. */
  async function releaseRefund(startedAt: string, claimToken: string) {
    if (!user) return;
    try {
      await pollarFetch(pollarRef.current.getClient(), user.address, `/api/sales/${saleId}/refund/release`, {
        method: "POST",
        body: JSON.stringify({ startedAt, claimToken }),
      });
    } catch {
      // The attempt's deadline hands it back anyway.
    }
  }

  async function send(confirmed: RefundPlan) {
    // Checked before taking the claim, so a refused send never has to give one back.
    if (holdsAtLeast(balances ?? [], confirmed.asset, confirmed.amountDecimal) !== true) {
      setState({ step: "error", message: t.refund.errorNoFunds });
      return;
    }
    try {
      creditAsset(confirmed.asset);
    } catch {
      setState({ step: "error", message: t.refund.errorSend });
      return;
    }

    setState({ step: "loading_plan" });
    const result = await sendUnderClaim<RefundPlan>({
      claim: claimRefund,
      // Before the SDK is called: from here on a refund may exist.
      remember: ({ startedAt }) => {
        writeIntent(address, saleId, { at: Date.now(), startedAt });
        setState({ step: "paying" });
      },
      // The plan the server returned with the claim, not the one on screen.
      // `timeoutSec` is what is left of the claim's lifetime, never a fresh full window.
      send: ({ value: plan, timeoutSec }) =>
        pollarRef.current.runTx(
          "payment",
          { destination: plan.destination, amount: plan.amountDecimal, asset: creditAsset(plan.asset) },
          paymentOptions(plan.memo, timeoutSec)
        ),
      release: ({ startedAt, claimToken }) => releaseRefund(startedAt, claimToken),
    });

    switch (result.kind) {
      case "not_claimed": {
        const answer = result.answer;
        if (answer.kind === "held") {
          // Someone else holds it (another tab or device, or it is already on the chain): reconcile.
          await record(undefined, { heldNote: true });
        } else if (answer.kind === "refused") {
          setState({ step: "error", message: apiErrorMessage(t, answer, t.refund.errorSend) });
        } else {
          setState({ step: "error", message: t.refund.errorPrepare });
        }
        return;
      }
      case "rejected":
        // Provably never left, and the claim was handed back.
        writeIntent(address, saleId, null);
        setState({ step: "error", message: t.payRejected[result.reason] });
        return;
      case "stale":
        // This tab held the claim too long to send safely: nothing left and the
        // claim was handed back, so "retry" asks for a new one.
        writeIntent(address, saleId, null);
        setState({ step: "error", message: t.refund.errorClaimStale });
        return;
      case "submitted":
        if (result.hash) writeIntent(address, saleId, { at: Date.now(), startedAt: result.startedAt, hash: result.hash });
        await record(result.hash);
        return;
    }
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
          <Button disabled={funds !== true} onClick={() => void send(state.plan)}>
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
