"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePollar } from "@pollar/react";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { useBalance } from "@/hooks/useBalance";
import { pollarFetch } from "@/lib/auth-client";
import { creditAsset } from "@/lib/payments";
import { checkoutKey, parseInFlight, serializeInFlight, type InFlight } from "@/lib/checkout";
import { paymentOptions, sendUnderClaim, type ClaimAnswer } from "@/lib/claimed-send";
import { USDC_CODE } from "@/lib/network";
import { isFreePrice } from "@/lib/price-label";
import { formatAmount } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n/client";
import { apiErrorMessage } from "@/lib/i18n/errors";
import { decimalToStroops } from "@/lib/money";
import { BuyConfirm } from "@/components/BuyConfirm";
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
  /** Set when someone already won the right to pay this reservation: verify it, never pay it. */
  payStartedAt?: string | null;
};

type ApiBody = { error?: string; code?: string };

/** What one ask of `/confirm` came to. */
type ConfirmResult =
  | { kind: "ticket"; ticket: Ticket; emailed: boolean }
  | { kind: "unclaimed"; data: ApiBody }
  | { kind: "tx_failed"; data: ApiBody }
  /**
   * The server looked everywhere it can and found no payment (yet).
   * `released`: and, by its own reading of the sale, nobody can still pay it,
   * so this checkout may be forgotten. Never inferred here from a clock.
   */
  | { kind: "no_payment"; released: boolean }
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

/**
 * The browser's memory of a purchase in flight, per account and tier (the key
 * carries the buyer's address). It only lets a reload resume verifying; who may
 * pay is the server's claim.
 */
function readInFlight(key: string | null, owner: string | undefined): InFlight | null {
  if (!key || !owner) return null;
  try {
    return parseInFlight(localStorage.getItem(key), owner);
  } catch {
    return null;
  }
}

function writeInFlight(key: string | null, owner: string | undefined, value: InFlight | null) {
  if (!key || !owner) return;
  try {
    if (value) localStorage.setItem(key, serializeInFlight(value, owner));
    else localStorage.removeItem(key);
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
 * Money safety: before paying, the server is asked for the exclusive right to
 * (`/pay`, one conditional UPDATE): only the tab, browser or device that wins
 * it sends, everyone else verifies. From then on the purchase is remembered in
 * localStorage (per account), and once a payment may have been sent the only
 * action offered is "verificar" — never "comprar" again, which would charge
 * twice. It is forgotten only when the server says nobody can still pay that
 * sale.
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
  // Remembered per account and tier: a paused General checkout doesn't collide
  // with a VIP one, nor one person's with another's on the same browser.
  const flightKey = address ? checkoutKey(address, eventId, ticketTypeId) : null;
  const readFlight = () => readInFlight(flightKey, address);
  const writeFlight = (value: InFlight | null) => writeInFlight(flightKey, address, value);

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
      if (res.status === 404 && data.code === "no_payment") {
        return { kind: "no_payment", released: (data as { released?: boolean }).released === true };
      }
      if (res.status === 503 || res.status === 404) return { kind: "retry" };
      return { kind: "fail", data };
    } catch {
      return { kind: "retry" };
    }
  }

  /**
   * Asks until the payment is found, with backoff (Horizon can lag a few
   * seconds behind a just-submitted payment). The ONLY ways out are a ticket,
   * a transaction the network failed, or the server saying nobody can still
   * pay this sale (`released`: its attempt's transaction is dead, or it was
   * never started and its hold is over). A single "no payment" is never taken
   * as "nothing was sent", and no clock in this browser decides it.
   *
   * `heldNote`: this tab lost the claim to another sender, so a payment that
   * is still missing is theirs to finish, not ours to repeat.
   */
  async function verify(inFlight: InFlight, opts: { heldNote?: boolean } = {}) {
    if (!address) return;
    let sawNoPayment = false;
    for (let attempt = 1; attempt <= MAX_VERIFY_ATTEMPTS; attempt++) {
      setState({ step: "verifying", attempt });
      const result = await confirmOnce(inFlight.saleId, inFlight.hash);
      switch (result.kind) {
        case "ticket":
          writeFlight(null);
          void refresh();
          setState({ step: "done", ticket: result.ticket, emailed: result.emailed });
          return;
        case "unclaimed":
          writeFlight(null);
          setState({ step: "unclaimed", message: apiErrorMessage(t, result.data, t.buy.errorExpired) });
          return;
        case "tx_failed":
          // The network failed that transaction, so nothing left the account.
          // The claim on the sale stays until its deadline, which is why the
          // buy button may say "verificar" for a few minutes before it offers
          // a fresh purchase.
          writeFlight(null);
          setState({ step: "error", message: apiErrorMessage(t, result.data, t.buy.errorTxFailed) });
          return;
        case "fail":
          setState({ step: "unverified", message: apiErrorMessage(t, result.data, t.buy.errorVerify) });
          return;
        case "no_payment":
          sawNoPayment = true;
          if (result.released) {
            writeFlight(null);
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
      message:
        inFlight.hash || !sawNoPayment
          ? t.buy.errorNetworkLag
          : opts.heldNote
            ? t.buy.otherTab
            : t.buy.errorNotSeenYet,
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

  // Which account's checkout was resumed: another account signing in on this
  // browser resumes its own.
  const resumedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!address || !verified || resumedFor.current === flightKey) return;
    const inFlight = readInFlight(flightKey, address);
    if (!inFlight) return;
    // Marked inside the timer, not before it: StrictMode's mount/unmount/mount
    // would otherwise cancel the only scheduled run.
    const timer = setTimeout(() => {
      resumedFor.current = flightKey;
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

  /** Asks the server for the exclusive right to pay this reservation. Only a win may send. */
  async function claimPay(saleId: string): Promise<ClaimAnswer<undefined>> {
    if (!address) return { kind: "unreachable" };
    try {
      const res = await pollarFetch(pollarRef.current.getClient(), address, `/api/sales/${saleId}/pay`, {
        method: "POST",
      });
      const data = (await res.json()) as ApiBody & { claimed?: boolean; startedAt?: string; saleStatus?: string };
      if (res.ok && data.claimed === true && typeof data.startedAt === "string") {
        return { kind: "won", startedAt: data.startedAt, value: undefined };
      }
      if (res.status === 409 && data.code === "pay_already_started") {
        return { kind: "held", startedAt: data.startedAt };
      }
      // A server error says nothing about whether the claim was taken.
      if (res.status >= 500) return { kind: "unreachable" };
      return { kind: "refused", code: data.code, error: data.error, saleStatus: data.saleStatus };
    } catch {
      return { kind: "unreachable" };
    }
  }

  /**
   * Another sender holds this reservation (another tab, another device, an
   * earlier tap, a reload): remember it and go look for their payment. Never
   * pay from here.
   */
  async function verifyHeld(saleId: string, startedAt: string | null | undefined) {
    const record: InFlight = { saleId, startedAt: startedAt ?? undefined, at: Date.now() };
    writeFlight(record);
    await verify(record, { heldNote: true });
  }

  /**
   * Sends the payment for `sale`, but only if the server says this caller won
   * the right to (see `claimPay`): a tab, browser or device that loses it
   * verifies instead, so one reservation is never paid twice.
   */
  async function pay(sale: Sale) {
    // Someone already started this one (the sale came back with it set).
    if (sale.payStartedAt) {
      await verifyHeld(sale.id, sale.payStartedAt);
      return;
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

    const result = await sendUnderClaim<undefined>({
      claim: () => claimPay(sale.id),
      // Written BEFORE the SDK is called: from here on a payment may exist, and
      // a reload or a crash must find that out instead of paying again.
      remember: ({ startedAt }) => {
        writeFlight({ saleId: sale.id, startedAt, at: Date.now() });
        setState({ step: "paying" });
      },
      send: () =>
        pollarRef.current.runTx(
          "payment",
          { destination: sale.organizerAddress, amount: sale.amountDecimal, asset },
          paymentOptions(sale.reference)
        ),
      release: () => release(sale.id),
    });

    switch (result.kind) {
      case "not_claimed": {
        const answer = result.answer;
        if (answer.kind === "held") {
          await verifyHeld(sale.id, answer.startedAt);
        } else if (answer.kind === "refused") {
          // A sale that is already paid (or paid late) has a payment to verify, not a retry to offer.
          if (answer.saleStatus === "paid" || answer.saleStatus === "unclaimed") {
            await verifyHeld(sale.id, undefined);
          } else {
            setState({ step: "error", message: apiErrorMessage(t, answer, t.buy.errorReserve) });
          }
        } else {
          // No answer: nothing was sent. If the claim was in fact taken, the next
          // try finds it held and verifies instead of paying.
          setState({ step: "error", message: t.buy.errorReserveRetry });
        }
        return;
      }
      case "rejected":
        // Provably never left, and the seat was handed back.
        writeFlight(null);
        setState({ step: "error", message: t.payRejected[result.reason] });
        return;
      case "submitted": {
        // A failure with no hash is the same shape whether the request never
        // left or only its answer never came back: it is looked up by memo.
        const next: InFlight = { saleId: sale.id, startedAt: result.startedAt, hash: result.hash, at: Date.now() };
        writeFlight(next);
        await verify(next);
        return;
      }
    }
  }

  async function buy() {
    if (!user || !usdcAsset) return;
    const client = pollarRef.current.getClient();

    // Something may already be in flight for this tier (a reload that hasn't
    // resumed yet, another tab): look at it, never open a checkout beside it.
    const pending = readFlight();
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
    } catch {
      // Never the SDK's or the network's own text: it isn't in the reader's language.
      setState({ step: "error", message: t.buy.errorReserveRetry });
      return;
    }

    await pay(sale);
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
          className="inline-flex min-h-11 items-center rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary-hover"
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
        <p className="flex items-center justify-center gap-1.5 text-center text-xs font-medium text-accent-text">
          <Icon name="clock" size={13} className="shrink-0" />
          {t.buy.holdTitle(t.hold.minutes)}
        </p>
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
            const inFlight = readFlight();
            if (inFlight) void verify(inFlight);
            else setState({ step: "idle" });
          }}
          className="w-full"
        >
          {t.buy.verifyAgain}
        </Button>
        <Link href="/mis-pases" className="flex min-h-11 items-center justify-center text-center text-xs font-semibold text-primary underline">
          {t.buy.verifyLater}
        </Link>
      </div>
    );
  }

  if (state.step === "unclaimed") {
    return (
      <div className="flex flex-col gap-2 rounded-2xl border border-error-border bg-error-light p-4 text-sm leading-6 text-error">
        <p>{state.message}</p>
        <Link href="/mis-pases" className="inline-flex min-h-11 items-center font-semibold underline">
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
      <BuyConfirm
        eventName={eventName}
        ticketTypeName={ticketTypeName}
        priceDecimal={priceDecimal}
        onCancel={() => setState({ step: "idle" })}
        onPay={() => void buy()}
      />
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
              className="flex min-h-11 items-center justify-center rounded-xl bg-primary px-3 py-2.5 text-center text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary-hover"
            >
              {t.buy.getUsdc}
            </Link>
          </div>
          <button onClick={() => void refresh()} className="flex min-h-11 items-center justify-center text-xs font-semibold text-primary underline">
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
