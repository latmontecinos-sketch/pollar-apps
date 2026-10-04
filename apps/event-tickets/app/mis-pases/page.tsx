"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePollar } from "@pollar/react";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { pollarFetch } from "@/lib/auth-client";
import { formatEventMonth, formatTimestamp, salesClosed } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n/client";
import { apiErrorMessage } from "@/lib/i18n/errors";
import { AppShell } from "@/components/AppShell";
import { ScreenLoading } from "@/components/ScreenLoading";
import { Card } from "@/components/ui/Card";
import { LoadError } from "@/components/LoadError";
import { EmptyState } from "@/components/ui/EmptyState";
import { TicketCard, type Sale, type VerifyState } from "@/components/TicketCard";
import { Segmented } from "@/components/ui/Segmented";
import { LoginButton } from "@/components/LoginButton";
import { PassLogo } from "@/components/ui/PassLogo";
import { Spinner } from "@/components/ui/Spinner";
import { Stat } from "@/components/ui/Stat";

type LoadState = { step: "loading" } | { step: "loaded"; sales: Sale[] } | { step: "error" };

type Filter = "upcoming" | "past";

const byDate = (a: Sale, b: Sale) => a.event.datetimeUtc.localeCompare(b.event.datetimeUtc);

/** One of the band's two light stat cards. */
export default function MisPasesPage() {
  const { user, isLoading: authLoading } = usePollarAuth();
  const t = useT();
  const locale = useLocale();
  const pollar = usePollar();
  const pollarRef = useRef(pollar);
  useEffect(() => {
    pollarRef.current = pollar;
  });

  const [state, setState] = useState<LoadState>({ step: "loading" });
  const [verifying, setVerifying] = useState<Record<string, VerifyState>>({});
  /** null until the reader picks: then it opens on whichever list has something. */
  const [filter, setFilter] = useState<Filter | null>(null);
  const address = user?.address;

  const load = useCallback(async () => {
    if (!address) return;
    // A failed reload (after "Ya pagué") keeps the list already on screen.
    const failed = () => setState((current) => (current.step === "loaded" ? current : { step: "error" }));
    try {
      const res = await pollarFetch(pollarRef.current.getClient(), address, "/api/sales/mine");
      if (!res.ok) return failed();
      const data = (await res.json()) as { sales: Sale[] };
      setState({ step: "loaded", sales: data.sales });
    } catch {
      failed();
    }
  }, [address]);

  const retry = useCallback(() => {
    setState({ step: "loading" });
    void load();
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  /** "Ya pagué": the server looks the payment up on Stellar by this sale's memo. Never pays again. */
  async function verify(sale: Sale) {
    if (!address) return;
    setVerifying((v) => ({ ...v, [sale.id]: { busy: true } }));
    try {
      const res = await pollarFetch(
        pollarRef.current.getClient(),
        address,
        `/api/sales/${sale.id}/confirm`,
        { method: "POST", body: JSON.stringify({ email: user?.profile?.mail, locale }) }
      );
      const data = (await res.json()) as { ticket?: unknown; error?: string; code?: string };
      if (res.ok && data.ticket) {
        setVerifying((v) => ({ ...v, [sale.id]: { busy: false } }));
        await load();
        return;
      }
      const message =
        data.code === "no_payment"
          ? sale.status === "pending"
            ? t.tickets.noPaymentPending(formatTimestamp(sale.expiresAtUtc, locale))
            : t.tickets.noPaymentOther
          : apiErrorMessage(t, data, t.tickets.verifyRetry);
      setVerifying((v) => ({
        ...v,
        [sale.id]: { busy: false, message, tone: data.code === "no_payment" ? "info" : "error" },
      }));
      if (res.status === 409) await load();
    } catch {
      setVerifying((v) => ({
        ...v,
        [sale.id]: { busy: false, message: t.tickets.offline, tone: "error" },
      }));
    }
  }

  if (authLoading) return <ScreenLoading title={t.tickets.title} back={{ href: "/app", label: t.common.home }} />;

  if (!user) {
    return (
      <AppShell title={t.tickets.title} back={{ href: "/app", label: t.common.home }}>
        <div className="flex flex-1 flex-col items-center justify-center gap-5 py-10 text-center">
          <PassLogo size={64} layout="stacked" />
          <p className="max-w-sm text-muted">{t.tickets.loginNote}</p>
          <LoginButton />
        </div>
      </AppShell>
    );
  }

  const sales = state.step === "loaded" ? state.sales : [];
  // Next event first; for past ones, the most recent first.
  const upcoming = sales.filter((sale) => !salesClosed(sale.event.datetimeUtc)).sort(byDate);
  const past = sales.filter((sale) => salesClosed(sale.event.datetimeUtc)).sort((a, b) => byDate(b, a));
  const shown: Filter = filter ?? (upcoming.length > 0 || past.length === 0 ? "upcoming" : "past");
  const visible = shown === "upcoming" ? upcoming : past;
  const activeCount = upcoming.filter((sale) => sale.ticket && !sale.ticket.usedAt).length;
  const usedCount = sales.filter((sale) => sale.ticket?.usedAt).length;

  return (
    <AppShell
      title={t.tickets.title}
      back={{ href: "/app", label: t.common.home }}
      hero={
        sales.length > 0 ? (
          <div className="grid grid-cols-2 gap-2">
            <Stat icon="ticket" label={t.tickets.statActive} value={activeCount} />
            <Stat icon="check" label={t.tickets.statUsed} value={usedCount} />
          </div>
        ) : undefined
      }
    >

      {state.step === "loading" && (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      )}

      {state.step === "error" && <LoadError message={t.tickets.loadError} onRetry={retry} />}

      {state.step === "loaded" && state.sales.length === 0 && (
        <Card>
          <EmptyState
            title={t.tickets.emptyTitle}
            description={t.tickets.emptyBody}
            action={
              <Link href="/como-funciona" className="text-sm font-semibold text-primary underline">
                {t.tickets.emptyCta}
              </Link>
            }
          />
        </Card>
      )}

      {sales.length > 0 && (
        <Segmented
          label={t.tickets.title}
          value={shown}
          onChange={setFilter}
          options={[
            { value: "upcoming", label: `${t.tickets.filterUpcoming} · ${upcoming.length}` },
            { value: "past", label: `${t.tickets.filterPast} · ${past.length}` },
          ]}
        />
      )}

      {sales.length > 0 && visible.length === 0 && (
        <p className="py-8 text-center text-sm text-muted">{t.tickets.emptyFilter}</p>
      )}

      {visible.map((sale, index) => {
        const check = verifying[sale.id];
        const month = formatEventMonth(sale.event.datetimeUtc, locale);
        const newMonth =
          index === 0 || month !== formatEventMonth(visible[index - 1].event.datetimeUtc, locale);
        return (
          <Fragment key={sale.id}>
            {newMonth && (
              <h2 className="px-1 pt-1 text-sm font-semibold first-letter:uppercase">{month}</h2>
            )}
            <TicketCard
              sale={sale}
              check={check}
              onVerify={() => void verify(sale)}
              onExpired={() => void load()}
            />
          </Fragment>
        );
      })}
    </AppShell>
  );
}
