"use client";

import { useEffect, useRef, useState } from "react";
import { usePollar } from "@pollar/react";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { useBalance } from "@/hooks/useBalance";
import { pollarFetch } from "@/lib/auth-client";
import { formatAmount, shortAddress } from "@/lib/format";
import { paymentAssetFrom } from "@/lib/payments";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";

type RefundPlan = { destination: string; amountDecimal: string; memo: string };

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

/**
 * Returns a late payment (an `unclaimed` sale: the buyer paid after their
 * reservation expired, so no ticket was issued). The organizer sends it
 * from their own Pollar wallet with the sale's refund memo; our server
 * verifies it on Horizon before marking the sale `refunded`.
 */
export function RefundButton({ saleId, onRefunded }: { saleId: string; onRefunded: () => void }) {
  const { user } = usePollarAuth();
  const pollar = usePollar();
  const pollarRef = useRef(pollar);
  useEffect(() => {
    pollarRef.current = pollar;
  });
  const { asset } = useBalance();
  const [state, setState] = useState<State>({ step: "idle" });
  const usdcAsset = asset && asset.type !== "native" ? asset : null;

  async function loadPlan() {
    if (!user) return;
    setState({ step: "loading_plan" });
    const res = await pollarFetch(
      pollarRef.current.getClient(),
      user.address,
      `/api/sales/${saleId}/refund`
    );
    const data = (await res.json()) as RefundPlan & { error?: string };
    if (!res.ok) return setState({ step: "error", message: data.error ?? "No se pudo preparar la devolución" });
    setState({ step: "confirm", plan: data });
  }

  async function record(hash?: string) {
    if (!user) return;
    setState({ step: "verifying" });
    const res = await pollarFetch(
      pollarRef.current.getClient(),
      user.address,
      `/api/sales/${saleId}/refund`,
      { method: "POST", body: JSON.stringify({ hash }) }
    );
    const data = (await res.json()) as { status?: string; error?: string };
    if (res.ok && data.status === "refunded") {
      setState({ step: "done" });
      onRefunded();
      return;
    }
    setState({
      step: "unverified",
      message:
        data.error ??
        "Todavía no vemos la devolución en la red. No pagues de nuevo: verifica en unos segundos.",
    });
  }

  async function send(plan: RefundPlan) {
    if (!usdcAsset) return;
    setState({ step: "paying" });
    let hash: string | undefined;
    try {
      const result = await pollarRef.current.runTx(
        "payment",
        { destination: plan.destination, amount: plan.amountDecimal, asset: paymentAssetFrom(usdcAsset) },
        { memo: { type: "text", value: plan.memo } }
      );
      if (result.status === "error" && !result.hash) {
        setState({
          step: "error",
          message: result.message ?? result.details ?? "No se pudo enviar la devolución.",
        });
        return;
      }
      hash = result.hash;
    } catch {
      // Unknown outcome: fall through to verification, never to a second send.
    }
    await record(hash);
  }

  if (state.step === "done") {
    return (
      <span className="flex items-center gap-1 text-xs font-semibold text-success">
        <Icon name="check" size={13} /> Devuelto
      </span>
    );
  }

  if (state.step === "confirm") {
    return (
      <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3 text-xs leading-5">
        <p>
          Vas a devolver{" "}
          <span className="font-mono font-semibold">{formatAmount(state.plan.amountDecimal)} USDC</span> a{" "}
          <span className="font-mono">{shortAddress(state.plan.destination)}</span>.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={() => setState({ step: "idle" })}>
            Cancelar
          </Button>
          <Button disabled={!usdcAsset} onClick={() => void send(state.plan)}>
            Devolver
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
          {state.step === "unverified" ? "Verificar de nuevo" : "Intentar otra vez"}
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
        ? "Enviando…"
        : state.step === "verifying"
          ? "Verificando…"
          : "Devolver pago"}
    </Button>
  );
}
