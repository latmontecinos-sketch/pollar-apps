"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePollar } from "@pollar/react";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { useBalance } from "@/hooks/useBalance";
import { pollarFetch } from "@/lib/auth-client";
import { creditAsset } from "@/lib/payments";
import { USDC_CODE } from "@/lib/network";
import { isFreePrice } from "@/lib/price-label";
import { formatAmount } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n/client";
import { apiErrorMessage } from "@/lib/i18n/errors";
import { decimalToStroops } from "@/lib/money";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { LoginButton } from "@/components/LoginButton";
import { ReceiveModal } from "@/components/ReceiveModal";
/**
 * Loaded only once there is a ticket to draw. It pulls in the whole QR
 * encoder (~9 KB gzipped), and this component renders on the public event
 * page for every tier — so everyone who opened a shared link was paying for
 * a library that only matters after they have already bought something.
 */
const TicketQr = dynamic(() => import("@/components/TicketQr").then((m) => m.TicketQr), {
  ssr: false,
});

type Sale = {
  id: string;
  reference: string;
  amountDecimal: string;
  organizerAddress: string;
  /** What to pay with, decided by the server — never by this component. */
  asset: { code: string; issuer: string };
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
  /** `emailed`: the server says the copy went out, not that we asked for one. */
  | { step: "done"; ticket: Ticket; emailed: boolean; existing?: boolean }
  /** Nothing was paid: trying again means a fresh purchase. */
  | { step: "error"; message: string }
  /** A payment may have been sent: trying again only re-checks it. */
  | { step: "unverified"; message: string }
  | { step: "unclaimed"; message: string };

const MAX_VERIFY_ATTEMPTS = 6;

/** One in-flight checkout per tier: two tiers of the same event never collide. */
const storageKey = (key: string) => `pollarpass:compra:${key}`;

function readInFlight(key: string): InFlight | null {
  try {
    const raw = localStorage.getItem(storageKey(key));
    return raw ? (JSON.parse(raw) as InFlight) : null;
  } catch {
    return null;
  }
}

function writeInFlight(key: string, value: InFlight | null) {
  try {
    if (value) localStorage.setItem(storageKey(key), JSON.stringify(value));
    else localStorage.removeItem(storageKey(key));
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
 * 2. create a pending sale (the tier's seat, held 10 min),
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
  ticketTypeId,
  ticketTypeName,
  priceDecimal,
  accessCode,
}: {
  eventId: string;
  eventName: string;
  ticketTypeId: string;
  ticketTypeName: string;
  priceDecimal: string;
  /** A private event's code, checked again by the server on every sale. */
  accessCode?: string;
}) {
  const { user, verified } = usePollarAuth();
  const t = useT();
  const locale = useLocale();
  const pollar = usePollar();
  const pollarRef = useRef(pollar);
  useEffect(() => {
    pollarRef.current = pollar;
  });
  const { asset, balance, isLoading: balanceLoading, refresh } = useBalance();
  const [state, setState] = useState<State>({ step: "idle" });
  const [receiveOpen, setReceiveOpen] = useState(false);
  // Ticket prices are always USDC, so this checks the code instead of merely
  // "not XLM" — a wallet holding some other app-enabled asset first used to
  // satisfy this test and get billed in the wrong currency.
  const usdcAsset =
    asset && asset.code === USDC_CODE && asset.type !== "native" ? asset : null;
  const address = user?.address;
  // Remembered per tier, so a paused General checkout doesn't collide with a VIP one.
  const flightKey = `${eventId}:${ticketTypeId}`;

  async function verify(inFlight: InFlight, opts: { fromReload: boolean }) {
    if (!address) return;
    const client = pollarRef.current.getClient();
    for (let attempt = 1; attempt <= MAX_VERIFY_ATTEMPTS; attempt++) {
      setState({ step: "verifying", attempt });
      let res: Response;
      let data: { ticket?: Ticket; emailed?: boolean; error?: string; code?: string; status?: string };
      try {
        res = await pollarFetch(client, address, `/api/sales/${inFlight.saleId}/confirm`, {
          method: "POST",
          // `locale` so the ticket email arrives in the buyer's language.
          body: JSON.stringify({ hash: inFlight.hash, email: user?.profile?.mail, locale }),
        });
        data = (await res.json()) as typeof data;
      } catch {
        await sleep(1500 * attempt);
        continue;
      }

      if (res.ok && data.ticket) {
        writeInFlight(flightKey, null);
        void refresh();
        setState({ step: "done", ticket: data.ticket, emailed: data.emailed === true });
        return;
      }
      if (res.status === 409 && data.status === "unclaimed") {
        writeInFlight(flightKey, null);
        setState({ step: "unclaimed", message: apiErrorMessage(t, data, t.buy.errorExpired) });
        return;
      }
      if (res.status === 422 && data.code === "tx_failed") {
        writeInFlight(flightKey, null);
        setState({ step: "error", message: apiErrorMessage(t, data, t.buy.errorTxFailed) });
        return;
      }
      if (res.status === 404 && data.code === "no_payment" && opts.fromReload && !inFlight.hash) {
        // Came back to a checkout that never got paid: nothing to recover.
        writeInFlight(flightKey, null);
        setState({ step: "idle" });
        return;
      }
      if (res.status === 503 || res.status === 404) {
        await sleep(1500 * attempt);
        continue;
      }
      setState({ step: "unverified", message: apiErrorMessage(t, data, t.buy.errorVerify) });
      return;
    }
    setState({ step: "unverified", message: t.buy.errorNetworkLag });
  }

  // Resume a checkout interrupted by a reload / closed tab. Read through a
  // ref (like `pollarRef`) so the effect only reruns when the session does.
  const verifyRef = useRef(verify);
  useEffect(() => {
    verifyRef.current = verify;
  });
  // Someone who already bought and lands on the link again (shared twice,
  // back button) gets told so, instead of quietly buying a second ticket.
  const [alreadyOwned, setAlreadyOwned] = useState(0);
  useEffect(() => {
    if (!address || !verified) return;
    let cancelled = false;
    (async () => {
      const res = await pollarFetch(pollarRef.current.getClient(), address, "/api/sales/mine");
      if (cancelled || !res.ok) return;
      const data = (await res.json()) as {
        sales: { status: string; ticketTypeName: string | null; event: { id: string } }[];
      };
      if (cancelled) return;
      setAlreadyOwned(
        data.sales.filter(
          (sale) =>
            sale.event.id === eventId &&
            sale.status === "paid" &&
            (sale.ticketTypeName ?? null) === ticketTypeName
        ).length
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [address, verified, eventId, ticketTypeName]);

  const resumed = useRef(false);
  useEffect(() => {
    if (!address || !verified || resumed.current) return;
    const inFlight = readInFlight(flightKey);
    if (!inFlight) return;
    // Marked inside the timer, not before it: StrictMode's mount/unmount/mount
    // would otherwise cancel the only scheduled run.
    const timer = setTimeout(() => {
      resumed.current = true;
      void verifyRef.current(inFlight, { fromReload: true });
    }, 0);
    return () => clearTimeout(timer);
  }, [address, verified, flightKey]);

  /** Hands a held seat back to the event (pending -> expired). Fire-and-forget. */
  async function release(saleId: string) {
    if (!address) return;
    try {
      await pollarFetch(pollarRef.current.getClient(), address, `/api/sales/${saleId}/release`, {
        method: "POST",
      });
    } catch {
      // The seat expires on its own anyway; nothing to tell the buyer.
    }
  }

  async function buy() {
    if (!user || !usdcAsset) return;
    const client = pollarRef.current.getClient();
    setState({ step: "creating_sale" });
    let sale: Sale;
    try {
      const createRes = await pollarFetch(client, user.address, "/api/sales", {
        method: "POST",
        body: JSON.stringify({ eventId, ticketTypeId, idempotencyKey: crypto.randomUUID(), accessCode }),
      });
      const created = (await createRes.json()) as Sale & { error?: string; code?: string };
      if (!createRes.ok) {
        setState({ step: "error", message: apiErrorMessage(t, created, t.buy.errorReserve) });
        return;
      }
      sale = created;
    } catch (err) {
      setState({
        step: "error",
        message: err instanceof Error ? err.message : t.buy.errorReserveRetry,
      });
      return;
    }

    writeInFlight(flightKey, { saleId: sale.id });
    setState({ step: "paying" });
    let hash: string | undefined;
    try {
      const payResult = await pollarRef.current.runTx(
        "payment",
        {
          destination: sale.organizerAddress,
          amount: sale.amountDecimal,
          // From the sale, so the asset paid is the asset the server will
          // look for on Horizon. The wallet's balance list only decides
          // whether the buyer *can* pay, never with what.
          asset: creditAsset(sale.asset),
        },
        { memo: { type: "text", value: sale.reference } }
      );
      if (payResult.status === "error" && !payResult.hash) {
        // Rejected before reaching the network (no XLM for fees, user
        // cancelled…): nothing was charged, so give the seat back at once
        // instead of holding it for the whole window.
        writeInFlight(flightKey, null);
        void release(sale.id);
        setState({
          step: "error",
          message: payResult.message ?? payResult.details ?? t.buy.errorPay,
        });
        return;
      }
      hash = payResult.hash;
    } catch {
      // Unknown outcome: treat as possibly paid and only offer verification.
    }

    const inFlight = { saleId: sale.id, hash };
    writeInFlight(flightKey, inFlight);
    await verify(inFlight, { fromReload: false });
  }

  /** A free tier: one request, and the answer is the ticket. No balance, no payment, nothing to verify. */
  async function claimFree() {
    if (!user) return;
    setState({ step: "creating_sale" });
    try {
      const res = await pollarFetch(pollarRef.current.getClient(), user.address, "/api/sales/free", {
        method: "POST",
        body: JSON.stringify({
          eventId,
          ticketTypeId,
          idempotencyKey: crypto.randomUUID(),
          accessCode,
          email: user.profile?.mail,
          locale,
        }),
      });
      const data = (await res.json()) as {
        ticket?: Ticket;
        emailed?: boolean;
        existing?: boolean;
        error?: string;
        code?: string;
      };
      if (!res.ok || !data.ticket) {
        setState({ step: "error", message: apiErrorMessage(t, data, t.buy.errorReserve) });
        return;
      }
      setState({
        step: "done",
        ticket: data.ticket,
        emailed: data.emailed === true,
        existing: data.existing === true,
      });
    } catch {
      setState({ step: "error", message: t.buy.errorReserveRetry });
    }
  }

  if (!user) {
    return (
      <div className="flex flex-col gap-3">
        <LoginButton label={t.buy.loginCta} className="w-full py-3" />
        <p className="text-center text-xs leading-5 text-muted">{t.buy.loginNote}</p>
      </div>
    );
  }

  if (state.step === "done") {
    return (
      <div className="pollar-rise flex flex-col items-center gap-3 rounded-2xl border border-success-border bg-success-light px-4 py-5 text-center">
        <span className="pollar-pop flex h-14 w-14 items-center justify-center rounded-full bg-background text-success shadow-sm">
          <Icon name="check" size={30} strokeWidth={3} />
        </span>
        <span className="font-semibold text-success">{t.buy.doneTitle}</span>
        {state.existing && <span className="text-xs text-muted">{t.buy.freeExisting}</span>}
        <div className="rounded-xl bg-background p-2">
          <TicketQr value={state.ticket.code} size={180} />
        </div>
        <div className="flex flex-col">
          <span className="text-xs uppercase tracking-wide text-muted">{t.buy.doorCode}</span>
          <span className="font-mono text-xl font-bold tracking-[0.2em]">{state.ticket.doorCode}</span>
        </div>
        <p className="text-xs leading-5 text-muted">
          {t.buy.doneNote}
          {state.emailed && user.profile?.mail ? t.buy.doneNoteMail(user.profile.mail) : ""}.
        </p>
        <Link
          href="/mis-pases"
          className="rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary-hover"
        >
          {t.buy.seeTickets}
        </Link>
      </div>
    );
  }

  if (state.step === "verifying" || state.step === "creating_sale" || state.step === "paying") {
    const label =
      state.step === "creating_sale"
        ? t.buy.reserving
        : state.step === "paying"
          ? t.buy.sending
          : t.buy.verifying;
    return (
      <div className="flex flex-col gap-2">
        <Button disabled loading className="w-full py-3">
          {label}
        </Button>
        <p className="text-center text-xs text-muted">{t.buy.dontClose}</p>
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
            const inFlight = readInFlight(flightKey);
            if (inFlight) void verify(inFlight, { fromReload: false });
            else setState({ step: "idle" });
          }}
          className="w-full"
        >
          {t.buy.verifyAgain}
        </Button>
        <Link href="/mis-pases" className="text-center text-xs font-semibold text-primary underline">
          {t.buy.verifyLater}
        </Link>
      </div>
    );
  }

  if (state.step === "unclaimed") {
    return (
      <div className="flex flex-col gap-2 rounded-2xl border border-error-border bg-error-light p-4 text-sm leading-6 text-error">
        <p>{state.message}</p>
        <Link href="/mis-pases" className="font-semibold underline">
          {t.buy.seeDetail}
        </Link>
      </div>
    );
  }

  if (isFreePrice(priceDecimal)) {
    return (
      <div className="flex flex-col gap-2">
        <Button onClick={() => void claimFree()} disabled={!verified} className="w-full py-3">
          <Icon name="gift" size={17} />
          {t.buy.freeCta}
        </Button>
        <p className="text-center text-xs text-muted">{t.tiers.freeLimit}</p>
        {state.step === "error" && (
          <p className="rounded-xl border border-error-border bg-error-light px-3 py-2 text-sm text-error">
            {state.message}
          </p>
        )}
      </div>
    );
  }

  // A wallet in deferred funding mode has no XLM for fees yet, so the
  // payment would fail with a network error the buyer can't act on.
  const walletNotReady = user.wallet.existsOnStellar === false;
  const enough = covers(usdcAsset?.balance ?? (usdcAsset ? balance : null), priceDecimal);
  const balanceKnown = !balanceLoading && asset !== null;
  const noUsdc = balanceKnown && !usdcAsset;
  const short = balanceKnown && (noUsdc || enough === false);

  if (state.step === "confirm") {
    return (
      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4">
        <p className="text-sm font-semibold">{t.buy.confirmTitle}</p>
        <dl className="flex flex-col gap-1.5 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-muted">{t.buy.confirmTicket}</dt>
            <dd className="text-right font-medium">
              {eventName}
              <span className="block text-xs text-muted">{ticketTypeName}</span>
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted">{t.buy.confirmTotal}</dt>
            <dd className="font-mono font-semibold">{formatAmount(priceDecimal, locale)} USDC</dd>
          </div>
        </dl>
        <p className="text-xs leading-5 text-muted">{t.buy.confirmNote}</p>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={() => setState({ step: "idle" })}>
            {t.common.cancel}
          </Button>
          <Button onClick={() => void buy()}>{t.buy.pay}</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {alreadyOwned > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-success-border bg-success-light p-3 text-sm leading-6">
          <Icon name="check" size={17} className="mt-0.5 text-success" />
          <span>
            {t.buy.alreadyOwned(alreadyOwned)}{" "}
            <Link href="/mis-pases" className="font-semibold text-primary underline">
              {t.buy.alreadyOwnedLink}
            </Link>
            {t.buy.alreadyOwnedTail}
          </span>
        </div>
      )}
      {walletNotReady && (
        <div className="flex items-start gap-2 rounded-xl border border-warning-border bg-warning-light p-3 text-sm leading-6">
          <Icon name="alert" size={17} className="mt-0.5 text-warning" />
          <span>
            {t.buy.walletNotReady}{" "}
            <Link href="/como-funciona#comisiones" className="font-semibold text-primary underline">
              {t.buy.walletNotReadyLink}
            </Link>
          </span>
        </div>
      )}
      {short ? (
        <div className="flex flex-col gap-2 rounded-2xl border border-warning-border bg-warning-light p-4 text-sm leading-6">
          <p className="flex items-start gap-2">
            <Icon name="alert" size={18} className="mt-0.5 text-warning" />
            <span>
              {noUsdc
                ? t.buy.noUsdc
                : t.buy.missing(
                    formatAmount(priceDecimal, locale),
                    formatAmount(usdcAsset?.balance ?? balance, locale)
                  )}
            </span>
          </p>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => setReceiveOpen(true)}>
              {t.buy.receive}
            </Button>
            <Link
              href="/como-funciona#usdc"
              className="flex items-center justify-center rounded-xl bg-primary px-3 py-2.5 text-center text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary-hover"
            >
              {t.buy.getUsdc}
            </Link>
          </div>
          <button onClick={() => void refresh()} className="text-xs font-semibold text-primary underline">
            {t.buy.refreshBalance}
          </button>
        </div>
      ) : (
        <Button
          onClick={() => setState({ step: "confirm" })}
          disabled={!verified || !usdcAsset}
          loading={!balanceKnown}
          className="w-full py-3"
        >
          {balanceKnown ? t.buy.cta(formatAmount(priceDecimal, locale)) : t.buy.checkingBalance}
        </Button>
      )}
      {balanceKnown && usdcAsset && (
        <p className="text-center text-xs text-muted">
          {t.buy.yourBalance}{" "}
          <span className="font-mono">{formatAmount(usdcAsset.balance, locale)} USDC</span>
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
