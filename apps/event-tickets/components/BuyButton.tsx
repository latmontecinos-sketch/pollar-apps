"use client";

import { useEffect, useRef, useState } from "react";
import { usePollar } from "@pollar/react";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { useBalance } from "@/hooks/useBalance";
import { pollarFetch } from "@/lib/auth-client";
import { paymentAssetFrom } from "@/lib/payments";
import { Button } from "@/components/ui/Button";
import { LoginButton } from "@/components/LoginButton";
import { TicketQr } from "@/components/TicketQr";

type Sale = {
  id: string;
  reference: string;
  amountDecimal: string;
  organizerAddress: string;
};

type Ticket = { code: string; doorCode: string };

type State =
  | { step: "idle" }
  | { step: "creating_sale" }
  | { step: "paying"; sale: Sale }
  | { step: "confirming"; sale: Sale }
  | { step: "done"; ticket: Ticket }
  | { step: "error"; message: string };

/**
 * Buy flow for the public event page: create a pending sale, pay it with a
 * unique memo (`runTx('payment', …)`, the same SDK method `SendModal` uses —
 * `PayButton` can't carry a memo), then hand the hash to our own server to
 * verify against Horizon before it ever issues a ticket.
 */
export function BuyButton({ eventId, disabled }: { eventId: string; disabled?: boolean }) {
  const { user, verified } = usePollarAuth();
  const pollar = usePollar();
  const pollarRef = useRef(pollar);
  useEffect(() => {
    pollarRef.current = pollar;
  });
  const { asset } = useBalance();
  const [state, setState] = useState<State>({ step: "idle" });
  // Ticket prices are always USDC (see lib/money.ts); refuse to fall back to
  // native XLM just because the balance hasn't loaded yet.
  const usdcAsset = asset && asset.type !== "native" ? asset : null;

  async function buy() {
    if (!user || !usdcAsset) return;
    const client = pollarRef.current.getClient();
    setState({ step: "creating_sale" });
    try {
      const idempotencyKey =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random()}`;
      const createRes = await pollarFetch(client, user.address, "/api/sales", {
        method: "POST",
        body: JSON.stringify({ eventId, idempotencyKey }),
      });
      const created = (await createRes.json()) as Sale & { error?: string };
      if (!createRes.ok) {
        setState({ step: "error", message: created.error ?? "No se pudo crear la venta" });
        return;
      }

      setState({ step: "paying", sale: created });
      const payResult = await pollarRef.current.runTx(
        "payment",
        {
          destination: created.organizerAddress,
          amount: created.amountDecimal,
          asset: paymentAssetFrom(usdcAsset),
        },
        { memo: { type: "text", value: created.reference } }
      );
      if (payResult.status === "error") {
        setState({
          step: "error",
          message:
            payResult.message ?? payResult.details ?? "El pago no se pudo enviar. Probá de nuevo.",
        });
        return;
      }

      setState({ step: "confirming", sale: created });
      const confirmRes = await pollarFetch(
        client,
        user.address,
        `/api/sales/${created.id}/confirm`,
        {
          method: "POST",
          body: JSON.stringify({ hash: payResult.hash, email: user.profile?.mail }),
        }
      );
      const confirmed = (await confirmRes.json()) as { ticket?: Ticket; error?: string };
      if (!confirmRes.ok || !confirmed.ticket) {
        setState({
          step: "error",
          message:
            confirmed.error ??
            "El pago se envió pero no pudimos confirmarlo todavía. Recargá esta página en un momento.",
        });
        return;
      }
      setState({ step: "done", ticket: confirmed.ticket });
    } catch (err) {
      setState({
        step: "error",
        message: err instanceof Error ? err.message : "Algo salió mal. Probá de nuevo.",
      });
    }
  }

  if (!user) {
    return <LoginButton />;
  }

  if (state.step === "done") {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-success-border bg-success-light px-4 py-3 text-center">
        <span className="text-sm font-semibold text-success">✓ Pase comprado</span>
        <TicketQr value={state.ticket.code} size={180} />
        <span className="font-mono text-xs text-muted">Código de puerta: {state.ticket.doorCode}</span>
        {user.profile?.mail && (
          <span className="text-xs text-muted">También te lo mandamos a {user.profile.mail}</span>
        )}
      </div>
    );
  }

  const labels: Record<State["step"], string> = {
    idle: usdcAsset ? "Comprar pase" : "Cargando saldo USDC…",
    creating_sale: "Reservando…",
    paying: "Confirmá el pago en tu wallet…",
    confirming: "Verificando el pago…",
    done: "",
    error: "Comprar pase",
  };
  const busy = state.step === "creating_sale" || state.step === "paying" || state.step === "confirming";

  return (
    <div className="flex flex-col items-center gap-2">
      <Button
        onClick={() => void buy()}
        disabled={disabled || busy || !verified || !usdcAsset}
        loading={busy}
      >
        {labels[state.step]}
      </Button>
      {state.step === "error" && (
        <p className="rounded-xl border border-error-border bg-error-light px-3 py-2 text-sm text-error">
          {state.message}
        </p>
      )}
    </div>
  );
}
