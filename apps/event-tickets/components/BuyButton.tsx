"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePollar } from "@pollar/react";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { useBalance } from "@/hooks/useBalance";
import { pollarFetch } from "@/lib/auth-client";
import { paymentAssetFrom } from "@/lib/payments";
import { formatAmount } from "@/lib/format";
import { decimalToStroops } from "@/lib/money";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { LoginButton } from "@/components/LoginButton";
import { ReceiveModal } from "@/components/ReceiveModal";
import { TicketQr } from "@/components/TicketQr";

type Sale = {
  id: string;
  reference: string;
  amountDecimal: string;
  organizerAddress: string;
};

type Ticket = { code: string; doorCode: string };

/** A checkout that may already have money in flight: only ever *verified* again, never re-paid. */
type InFlight = { saleId: string; hash?: string };

type State =
  | { step: "idle" }
  | { step: "confirm" }
  | { step: "creating_sale" }
  | { step: "paying" }
  | { step: "verifying"; attempt: number }
  | { step: "done"; ticket: Ticket }
  /** Nothing was paid: trying again means a fresh purchase. */
  | { step: "error"; message: string }
  /** A payment may have been sent: trying again only re-checks it. */
  | { step: "unverified"; message: string }
  | { step: "unclaimed"; message: string };

const MAX_VERIFY_ATTEMPTS = 6;

const storageKey = (eventId: string) => `pollarpass:compra:${eventId}`;

function readInFlight(eventId: string): InFlight | null {
  try {
    const raw = localStorage.getItem(storageKey(eventId));
    return raw ? (JSON.parse(raw) as InFlight) : null;
  } catch {
    return null;
  }
}

function writeInFlight(eventId: string, value: InFlight | null) {
  try {
    if (value) localStorage.setItem(storageKey(eventId), JSON.stringify(value));
    else localStorage.removeItem(storageKey(eventId));
  } catch {
    // Private mode / blocked storage: "Mis pases → Ya pagué, verificar" still recovers it.
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function covers(balance: string | null, price: string): boolean | null {
  if (balance === null) return null;
  try {
    return decimalToStroops(balance) >= decimalToStroops(price);
  } catch {
    return null;
  }
}

/**
 * Buy flow for the public event page:
 * 1. review step (a single tap would otherwise send a real payment),
 * 2. create a pending sale (seat reserved 15 min),
 * 3. pay it with the sale's unique memo (`runTx('payment', …)`, the same SDK
 *    method `SendModal` uses — `PayButton` can't carry a memo),
 * 4. hand the hash to our server, which verifies it against Horizon before
 *    issuing a ticket — retried with backoff, since Horizon can lag a few
 *    seconds behind a just-submitted payment.
 *
 * Money safety: from the moment a sale exists it's remembered in
 * localStorage, and once a payment may have been sent the only action
 * offered is "verificar" — never "comprar" again, which would charge twice.
 */
export function BuyButton({
  eventId,
  eventName,
  priceDecimal,
}: {
  eventId: string;
  eventName: string;
  priceDecimal: string;
}) {
  const { user, verified } = usePollarAuth();
  const pollar = usePollar();
  const pollarRef = useRef(pollar);
  useEffect(() => {
    pollarRef.current = pollar;
  });
  const { asset, balance, isLoading: balanceLoading, refresh } = useBalance();
  const [state, setState] = useState<State>({ step: "idle" });
  const [receiveOpen, setReceiveOpen] = useState(false);
  // Ticket prices are always USDC (see lib/money.ts); never fall back to XLM.
  const usdcAsset = asset && asset.type !== "native" ? asset : null;
  const address = user?.address;

  async function verify(inFlight: InFlight, opts: { fromReload: boolean }) {
    if (!address) return;
    const client = pollarRef.current.getClient();
    for (let attempt = 1; attempt <= MAX_VERIFY_ATTEMPTS; attempt++) {
      setState({ step: "verifying", attempt });
      let res: Response;
      let data: { ticket?: Ticket; error?: string; code?: string; status?: string };
      try {
        res = await pollarFetch(client, address, `/api/sales/${inFlight.saleId}/confirm`, {
          method: "POST",
          body: JSON.stringify({ hash: inFlight.hash, email: user?.profile?.mail }),
        });
        data = (await res.json()) as typeof data;
      } catch {
        await sleep(1500 * attempt);
        continue;
      }

      if (res.ok && data.ticket) {
        writeInFlight(eventId, null);
        void refresh();
        setState({ step: "done", ticket: data.ticket });
        return;
      }
      if (res.status === 409 && data.status === "unclaimed") {
        writeInFlight(eventId, null);
        setState({ step: "unclaimed", message: data.error ?? "La reserva expiró antes del pago." });
        return;
      }
      if (res.status === 422 && data.code === "tx_failed") {
        writeInFlight(eventId, null);
        setState({ step: "error", message: data.error ?? "El pago no se completó. No se te cobró." });
        return;
      }
      if (res.status === 404 && data.code === "no_payment" && opts.fromReload && !inFlight.hash) {
        // Came back to a checkout that never got paid: nothing to recover.
        writeInFlight(eventId, null);
        setState({ step: "idle" });
        return;
      }
      if (res.status === 503 || res.status === 404) {
        await sleep(1500 * attempt);
        continue;
      }
      setState({
        step: "unverified",
        message: data.error ?? "No pudimos verificar el pago.",
      });
      return;
    }
    setState({
      step: "unverified",
      message:
        "La red de Stellar todavía no confirma tu pago. No vuelvas a pagar: toca “Verificar de nuevo” en unos segundos.",
    });
  }

  // Resume a checkout interrupted by a reload / closed tab. Read through a
  // ref (like `pollarRef`) so the effect only reruns when the session does.
  const verifyRef = useRef(verify);
  useEffect(() => {
    verifyRef.current = verify;
  });
  const resumed = useRef(false);
  useEffect(() => {
    if (!address || !verified || resumed.current) return;
    const inFlight = readInFlight(eventId);
    if (!inFlight) return;
    // Marked inside the timer, not before it: StrictMode's mount/unmount/mount
    // would otherwise cancel the only scheduled run.
    const timer = setTimeout(() => {
      resumed.current = true;
      void verifyRef.current(inFlight, { fromReload: true });
    }, 0);
    return () => clearTimeout(timer);
  }, [address, verified, eventId]);

  async function buy() {
    if (!user || !usdcAsset) return;
    const client = pollarRef.current.getClient();
    setState({ step: "creating_sale" });
    let sale: Sale;
    try {
      const createRes = await pollarFetch(client, user.address, "/api/sales", {
        method: "POST",
        body: JSON.stringify({ eventId, idempotencyKey: crypto.randomUUID() }),
      });
      const created = (await createRes.json()) as Sale & { error?: string };
      if (!createRes.ok) {
        setState({ step: "error", message: created.error ?? "No se pudo reservar tu cupo." });
        return;
      }
      sale = created;
    } catch (err) {
      setState({
        step: "error",
        message: err instanceof Error ? err.message : "No se pudo reservar tu cupo. Intenta de nuevo.",
      });
      return;
    }

    writeInFlight(eventId, { saleId: sale.id });
    setState({ step: "paying" });
    let hash: string | undefined;
    try {
      const payResult = await pollarRef.current.runTx(
        "payment",
        {
          destination: sale.organizerAddress,
          amount: sale.amountDecimal,
          asset: paymentAssetFrom(usdcAsset),
        },
        { memo: { type: "text", value: sale.reference } }
      );
      if (payResult.status === "error" && !payResult.hash) {
        // Rejected before reaching the network: nothing was charged.
        writeInFlight(eventId, null);
        setState({
          step: "error",
          message:
            payResult.message ?? payResult.details ?? "El pago no se pudo enviar. No se te cobró nada.",
        });
        return;
      }
      hash = payResult.hash;
    } catch {
      // Unknown outcome: treat as possibly paid and only offer verification.
    }

    const inFlight = { saleId: sale.id, hash };
    writeInFlight(eventId, inFlight);
    await verify(inFlight, { fromReload: false });
  }

  if (!user) {
    return (
      <div className="flex flex-col gap-3">
        <LoginButton label="Ingresar para comprar" className="w-full py-3" />
        <p className="text-center text-xs leading-5 text-muted">
          Ingresas con tu correo. Si es tu primera vez, Pollar te crea una cuenta con billetera
          automáticamente — no necesitas instalar nada.
        </p>
      </div>
    );
  }

  if (state.step === "done") {
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-success-border bg-success-light px-4 py-5 text-center">
        <span className="flex items-center gap-2 font-semibold text-success">
          <Icon name="check" size={20} /> ¡Listo! Ya tienes tu entrada
        </span>
        <div className="rounded-xl bg-background p-2">
          <TicketQr value={state.ticket.code} size={180} />
        </div>
        <div className="flex flex-col">
          <span className="text-xs uppercase tracking-wide text-muted">Código de puerta</span>
          <span className="font-mono text-xl font-bold tracking-[0.2em]">{state.ticket.doorCode}</span>
        </div>
        <p className="text-xs leading-5 text-muted">
          Muestra este QR en la puerta. Queda guardado en “Mis entradas”
          {user.profile?.mail ? ` y te lo mandamos a ${user.profile.mail}` : ""}.
        </p>
        <Link
          href="/mis-pases"
          className="rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary-hover"
        >
          Ver mis entradas
        </Link>
      </div>
    );
  }

  if (state.step === "verifying" || state.step === "creating_sale" || state.step === "paying") {
    const label =
      state.step === "creating_sale"
        ? "Reservando tu cupo…"
        : state.step === "paying"
          ? "Enviando el pago…"
          : "Verificando el pago en la red de Stellar…";
    return (
      <div className="flex flex-col gap-2">
        <Button disabled loading className="w-full py-3">
          {label}
        </Button>
        <p className="text-center text-xs text-muted">No cierres esta página.</p>
      </div>
    );
  }

  if (state.step === "unverified") {
    return (
      <div className="flex flex-col gap-3 rounded-2xl border border-warning-border bg-warning-light p-4 text-sm leading-6">
        <p className="flex items-start gap-2">
          <Icon name="clock" size={18} className="mt-0.5 text-warning" />
          <span>{state.message}</span>
        </p>
        <Button
          onClick={() => {
            const inFlight = readInFlight(eventId);
            if (inFlight) void verify(inFlight, { fromReload: false });
            else setState({ step: "idle" });
          }}
          className="w-full"
        >
          Verificar de nuevo
        </Button>
        <Link href="/mis-pases" className="text-center text-xs font-semibold text-primary underline">
          También puedes verificarlo después desde Mis entradas
        </Link>
      </div>
    );
  }

  if (state.step === "unclaimed") {
    return (
      <div className="flex flex-col gap-2 rounded-2xl border border-error-border bg-error-light p-4 text-sm leading-6 text-error">
        <p>{state.message}</p>
        <Link href="/mis-pases" className="font-semibold underline">
          Ver el detalle en Mis entradas
        </Link>
      </div>
    );
  }

  const enough = covers(usdcAsset?.balance ?? (usdcAsset ? balance : null), priceDecimal);
  const balanceKnown = !balanceLoading && asset !== null;
  const noUsdc = balanceKnown && !usdcAsset;
  const short = balanceKnown && (noUsdc || enough === false);

  if (state.step === "confirm") {
    return (
      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4">
        <p className="text-sm font-semibold">Revisa tu compra</p>
        <dl className="flex flex-col gap-1.5 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-muted">Entrada</dt>
            <dd className="text-right font-medium">{eventName}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted">Total</dt>
            <dd className="font-mono font-semibold">{formatAmount(priceDecimal)} USDC</dd>
          </div>
        </dl>
        <p className="text-xs leading-5 text-muted">
          El pago va directo al organizador. Tu cupo queda reservado 15 minutos mientras se confirma.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={() => setState({ step: "idle" })}>
            Cancelar
          </Button>
          <Button onClick={() => void buy()}>Pagar</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {short ? (
        <div className="flex flex-col gap-2 rounded-2xl border border-warning-border bg-warning-light p-4 text-sm leading-6">
          <p className="flex items-start gap-2">
            <Icon name="alert" size={18} className="mt-0.5 text-warning" />
            <span>
              {noUsdc
                ? "Tu cuenta todavía no tiene USDC."
                : `Te faltan USDC: la entrada cuesta ${formatAmount(priceDecimal)} y tienes ${formatAmount(usdcAsset?.balance ?? balance)}.`}
            </span>
          </p>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => setReceiveOpen(true)}>
              Recibir USDC
            </Button>
            <Link
              href="/como-funciona#usdc"
              className="flex items-center justify-center rounded-xl bg-primary px-3 py-2.5 text-center text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary-hover"
            >
              Conseguir USDC
            </Link>
          </div>
          <button onClick={() => void refresh()} className="text-xs font-semibold text-primary underline">
            Ya cargué saldo, actualizar
          </button>
        </div>
      ) : (
        <Button
          onClick={() => setState({ step: "confirm" })}
          disabled={!verified || !usdcAsset}
          loading={!balanceKnown}
          className="w-full py-3"
        >
          {balanceKnown ? `Comprar entrada · ${formatAmount(priceDecimal)} USDC` : "Revisando tu saldo…"}
        </Button>
      )}
      {balanceKnown && usdcAsset && (
        <p className="text-center text-xs text-muted">
          Tu saldo: <span className="font-mono">{formatAmount(usdcAsset.balance)} USDC</span>
        </p>
      )}
      {state.step === "error" && (
        <p className="rounded-xl border border-error-border bg-error-light px-3 py-2 text-sm text-error">
          {state.message}
        </p>
      )}
      <ReceiveModal open={receiveOpen} onClose={() => setReceiveOpen(false)} />
    </div>
  );
}
