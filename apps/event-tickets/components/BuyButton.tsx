"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePollar } from "@pollar/react";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { useBalance } from "@/hooks/useBalance";
import { pollarFetch } from "@/lib/auth-client";
import { creditAsset, classifySubmit } from "@/lib/payments";
import { canForgetUnpaid, parseInFlight, type InFlight } from "@/lib/checkout";
import { withClaim } from "@/lib/claim";
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
  expiresAtUtc: string;
  /** An existing sale came back: a payment on it may already exist. */
  reused?: boolean;
};

type ApiBody = { error?: string; code?: string };

/** What one ask of `/confirm` came to. */
type ConfirmResult =
  | { kind: "ticket"; ticket: Ticket; emailed: boolean }
  | { kind: "unclaimed"; data: ApiBody }
  | { kind: "tx_failed"; data: ApiBody }
  /** The server looked everywhere it can and found no payment (yet). */
  | { kind: "no_payment" }
  /** Network, Horizon or a transient server error: ask again. */
  | { kind: "retry" }
  | { kind: "fail"; data: ApiBody };

type Ticket = { code: string; doorCode: string };

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
    return parseInFlight(localStorage.getItem(storageKey(key)));
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
  const { asset, balance, isLoading: balanceLoading, loaded: balanceLoaded, error: balanceError, refresh } =
    useBalance();
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

  /** One ask of the server. A hash settles that payment; none makes it look the sale's memo up on Stellar. */
  async function confirmOnce(saleId: string, hash?: string): Promise<ConfirmResult> {
    if (!address) return { kind: "retry" };
    try {
      const res = await pollarFetch(pollarRef.current.getClient(), address, `/api/sales/${saleId}/confirm`, {
        method: "POST",
        // `locale` so the ticket email arrives in the buyer's language.
        body: JSON.stringify({ hash, email: user?.profile?.mail, locale }),
      });
      const data = (await res.json()) as ApiBody & {
        ticket?: Ticket;
        emailed?: boolean;
        status?: string;
      };
      if (res.ok && data.ticket) return { kind: "ticket", ticket: data.ticket, emailed: data.emailed === true };
      if (res.status === 409 && data.status === "unclaimed") return { kind: "unclaimed", data };
      if (res.status === 422 && data.code === "tx_failed") return { kind: "tx_failed", data };
      if (res.status === 404 && data.code === "no_payment") return { kind: "no_payment" };
      if (res.status === 503 || res.status === 404) return { kind: "retry" };
      return { kind: "fail", data };
    } catch {
      return { kind: "retry" };
    }
  }

  /**
   * Asks until the payment is found, with backoff (Horizon can lag a few
   * seconds behind a just-submitted payment). The ONLY ways out are a ticket,
   * a transaction the network failed, an expired reservation, or — for a
   * checkout that never got a hash — a deadline long enough that a payment
   * still missing is the refund flow's problem (see `canForgetUnpaid`). A
   * single "no payment" is never taken as "nothing was sent".
   */
  async function verify(inFlight: InFlight) {
    if (!address) return;
    let sawNoPayment = false;
    for (let attempt = 1; attempt <= MAX_VERIFY_ATTEMPTS; attempt++) {
      setState({ step: "verifying", attempt });
      const result = await confirmOnce(inFlight.saleId, inFlight.hash);
      switch (result.kind) {
        case "ticket":
          writeInFlight(flightKey, null);
          void refresh();
          setState({ step: "done", ticket: result.ticket, emailed: result.emailed });
          return;
        case "unclaimed":
          writeInFlight(flightKey, null);
          setState({ step: "unclaimed", message: apiErrorMessage(t, result.data, t.buy.errorExpired) });
          return;
        case "tx_failed":
          writeInFlight(flightKey, null);
          setState({ step: "error", message: apiErrorMessage(t, result.data, t.buy.errorTxFailed) });
          return;
        case "fail":
          setState({ step: "unverified", message: apiErrorMessage(t, result.data, t.buy.errorVerify) });
          return;
        case "no_payment":
          sawNoPayment = true;
          if (canForgetUnpaid(inFlight, Date.now())) {
            writeInFlight(flightKey, null);
            setState({ step: "idle" });
            return;
          }
          break;
        case "retry":
          break;
      }
      await sleep(1500 * attempt);
    }
    setState({
      step: "unverified",
      message: inFlight.hash || !sawNoPayment ? t.buy.errorNetworkLag : t.buy.errorNotSeenYet,
    });
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
      void verifyRef.current(inFlight);
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

  /**
   * Sends the payment for `sale`. Runs under a claim named after the sale, so
   * a second tab holding the same reservation cannot send a second payment.
   */
  async function pay(sale: Sale) {
    // Another tab may have started this very sale in the instant before the claim.
    const raced = readInFlight(flightKey);
    if (raced) {
      await verify(raced);
      return;
    }

    // An existing sale came back (a reload, a second tab, a repeated tap):
    // a payment for it may already be on the chain, so look before sending.
    if (sale.reused) {
      setState({ step: "verifying", attempt: 1 });
      const probe = await confirmOnce(sale.id);
      if (probe.kind === "ticket") {
        void refresh();
        setState({ step: "done", ticket: probe.ticket, emailed: probe.emailed });
        return;
      }
      if (probe.kind === "unclaimed") {
        setState({ step: "unclaimed", message: apiErrorMessage(t, probe.data, t.buy.errorExpired) });
        return;
      }
      if (probe.kind !== "no_payment") {
        // Couldn't rule a payment out: never send into the doubt.
        writeInFlight(flightKey, { saleId: sale.id, expiresAtUtc: sale.expiresAtUtc, at: Date.now() });
        setState({ step: "unverified", message: t.buy.errorVerify });
        return;
      }
    }

    let asset;
    try {
      // From the sale, so the asset paid is the asset the server will look
      // for on Horizon. The wallet's balance list only decides whether the
      // buyer *can* pay, never with what.
      asset = creditAsset(sale.asset);
    } catch {
      void release(sale.id);
      setState({ step: "error", message: t.buy.errorPay });
      return;
    }

    // Written BEFORE the SDK is called: from here on a payment may exist, and
    // a reload, a crash or a second tab must find that out instead of paying.
    const started: InFlight = { saleId: sale.id, expiresAtUtc: sale.expiresAtUtc, at: Date.now() };
    writeInFlight(flightKey, started);
    setState({ step: "paying" });

    let outcome: Awaited<ReturnType<typeof pollar.runTx>> | undefined;
    try {
      outcome = await pollarRef.current.runTx(
        "payment",
        { destination: sale.organizerAddress, amount: sale.amountDecimal, asset },
        { memo: { type: "text", value: sale.reference } }
      );
    } catch {
      // Unknown outcome: possibly paid, so only verification is offered.
    }

    // The SDK returns most failures instead of throwing them, and a failure
    // with no hash is the same shape whether the request never left or only
    // its answer never came back. Only a provable "never left" gives the
    // seat back; anything else is looked up on the chain by memo.
    if (outcome && outcome.status === "error" && classifySubmit(outcome) === "rejected") {
      writeInFlight(flightKey, null);
      void release(sale.id);
      setState({
        step: "error",
        message: outcome.message ?? outcome.details ?? t.buy.errorPay,
      });
      return;
    }

    const hash = outcome?.hash;
    const next: InFlight = hash ? { ...started, hash } : started;
    writeInFlight(flightKey, next);
    await verify(next);
  }

  async function buy() {
    if (!user || !usdcAsset) return;
    const client = pollarRef.current.getClient();

    // Something may already be in flight for this tier (a reload that hasn't
    // resumed yet, another tab): look at it, never open a checkout beside it.
    const pending = readInFlight(flightKey);
    if (pending) {
      await verify(pending);
      return;
    }

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

    const claimed = await withClaim(`pay:${sale.id}`, () => pay(sale));
    if (!claimed.held) {
      // Another tab is paying this same reservation: it, not this one, sends.
      setState({ step: "unverified", message: t.buy.otherTab });
    }
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
            if (inFlight) void verify(inFlight);
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
  // "Known" means the wallet was read, even if it came back empty. It used to
  // mean "an asset is present", so a failed read (or a brand-new wallet with
  // no balances) left the button on "checking your balance" forever.
  const balanceKnown = balanceLoaded;
  const balanceFailed = !balanceLoaded && !balanceLoading && balanceError !== null;
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

  if (balanceFailed) {
    return (
      <div className="flex flex-col gap-2 rounded-2xl border border-warning-border bg-warning-light p-4 text-sm leading-6">
        <p className="flex items-start gap-2">
          <Icon name="alert" size={18} className="mt-0.5 text-warning" />
          <span>{t.buy.balanceError}</span>
        </p>
        <Button onClick={() => void refresh()} className="w-full">
          {t.buy.balanceRetry}
        </Button>
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
