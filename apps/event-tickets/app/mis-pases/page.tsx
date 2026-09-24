"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePollar } from "@pollar/react";
import { usePollarAuth } from "@/hooks/usePollarAuth";
import { pollarFetch } from "@/lib/auth-client";
import {
  formatAmount,
  formatEventDateTime,
  formatEventMonth,
  formatTimestamp,
  salesClosed,
} from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n/client";
import { apiErrorMessage } from "@/lib/i18n/errors";
import { explorerTxUrl } from "@/lib/network";
import { AppShell } from "@/components/AppShell";
import { HoldCountdown } from "@/components/HoldCountdown";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Icon, type IconName } from "@/components/ui/Icon";
import { IconTile } from "@/components/ui/ListRow";
import { Segmented } from "@/components/ui/Segmented";
import { LoginButton } from "@/components/LoginButton";
import { PollarLogo } from "@/components/ui/PollarLogo";
import { Spinner } from "@/components/ui/Spinner";
import { SaveTicketButton } from "@/components/SaveTicketButton";
import { TicketQr } from "@/components/TicketQr";

type Sale = {
  id: string;
  status: "pending" | "paid" | "expired" | "unclaimed" | "refunded";
  amountDecimal: string;
  expiresAtUtc: string;
  refundTxHash: string | null;
  ticketTypeName: string | null;
  event: { id: string; name: string; datetimeUtc: string; place: string };
  ticket: { code: string; doorCode: string | null; usedAt: string | null } | null;
};

type LoadState = { step: "loading" } | { step: "loaded"; sales: Sale[] } | { step: "error" };

type VerifyState = { busy: boolean; message?: string; tone?: "info" | "error" };

type Filter = "upcoming" | "past";

const byDate = (a: Sale, b: Sale) => a.event.datetimeUtc.localeCompare(b.event.datetimeUtc);

/** One of the band's two light stat cards. */
function Stat({ icon, label, value }: { icon: IconName; label: string; value: number }) {
  return (
    <div className="flex flex-col items-center gap-0.5 rounded-2xl bg-background px-3 py-3 text-foreground shadow-sm">
      <Icon name={icon} size={20} className="text-primary-text" />
      <span className="text-xs font-medium text-muted">{label}</span>
      <span className="text-2xl font-bold tabular-nums">{value}</span>
    </div>
  );
}

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
    const res = await pollarFetch(pollarRef.current.getClient(), address, "/api/sales/mine");
    if (!res.ok) return setState({ step: "error" });
    const data = (await res.json()) as { sales: Sale[] };
    setState({ step: "loaded", sales: data.sales });
  }, [address]);

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

  if (authLoading) return null;

  if (!user) {
    return (
      <AppShell title={t.tickets.title} back={{ href: "/app", label: t.common.home }}>
        <div className="flex flex-1 flex-col items-center justify-center gap-5 py-10 text-center">
          <PollarLogo size={64} />
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

      {state.step === "error" && (
        <Card>
          <p className="text-center text-sm text-error">{t.tickets.loadError}</p>
        </Card>
      )}

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
        const past = salesClosed(sale.event.datetimeUtc);
        const month = formatEventMonth(sale.event.datetimeUtc, locale);
        const newMonth =
          index === 0 || month !== formatEventMonth(visible[index - 1].event.datetimeUtc, locale);
        return (
          <Fragment key={sale.id}>
            {newMonth && (
              <h2 className="px-1 pt-1 text-sm font-semibold first-letter:uppercase">{month}</h2>
            )}
            <Card className="flex flex-col gap-4 overflow-hidden p-0">
              <div className="flex items-center gap-3.5 px-5 pt-5">
                <IconTile icon="ticket" tone={sale.ticket && !sale.ticket.usedAt && !past ? "strong" : "soft"} />
                <div className="min-w-0 flex-1">
                  <Link href={`/e/${sale.event.id}`} className="block truncate font-semibold hover:text-primary">
                    {sale.event.name}
                  </Link>
                  <p className="text-xs font-medium text-primary-text first-letter:uppercase">
                    {formatEventDateTime(sale.event.datetimeUtc, locale)}
                  </p>
                  <p className="truncate text-xs text-muted">{sale.event.place}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1 border-l border-tile-soft pl-3">
                  <span className="whitespace-nowrap font-mono text-xs font-semibold text-muted">
                    {formatAmount(sale.amountDecimal, locale)} USDC
                  </span>
                  {sale.ticketTypeName && (
                    <span className="rounded-full bg-primary-light px-2 py-0.5 text-[11px] font-semibold text-primary">
                      {sale.ticketTypeName}
                    </span>
                  )}
                </div>
              </div>

              {sale.ticket ? (
                <div className="flex flex-col items-center gap-3 border-t border-dashed border-border bg-surface px-5 py-5">
                  {sale.ticket.usedAt ? (
                    <span className="flex items-center gap-2 rounded-full bg-success-light px-3 py-1 text-sm font-semibold text-success">
                      <Icon name="check" size={16} /> {t.tickets.usedAt(formatTimestamp(sale.ticket.usedAt, locale))}
                    </span>
                  ) : past ? (
                    <span className="text-sm text-muted">{t.tickets.past}</span>
                  ) : (
                    <>
                      <div className="rounded-xl bg-background p-2 shadow-sm">
                        <TicketQr value={sale.ticket.code} size={180} />
                      </div>
                      <p className="text-center text-xs text-muted">{t.tickets.showQr}</p>
                    </>
                  )}
                  <div className="flex flex-col items-center gap-2">
                    <span className="text-[11px] uppercase tracking-wide text-muted">
                      {t.tickets.doorCode}
                    </span>
                    <span className="font-mono text-lg font-bold tracking-[0.2em]">
                      {sale.ticket.doorCode}
                    </span>
                    {!sale.ticket.usedAt && !past && sale.ticket.doorCode && (
                      <SaveTicketButton
                        code={sale.ticket.code}
                        doorCode={sale.ticket.doorCode}
                        eventName={sale.event.name}
                        eventDateTime={sale.event.datetimeUtc}
                        eventPlace={sale.event.place}
                      />
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-3 border-t border-border bg-surface px-5 py-4 text-sm">
                  {sale.status === "pending" && (
                    <>
                      <p className="flex items-start gap-2">
                        <Icon name="clock" size={17} className="mt-0.5 text-primary" />
                        <span>
                          <span className="font-semibold">{t.tickets.pendingStrong}</span>{" "}
                          <span className="text-muted">
                            {t.tickets.pendingBody(formatTimestamp(sale.expiresAtUtc, locale))}
                          </span>
                        </span>
                      </p>
                      <HoldCountdown expiresAtUtc={sale.expiresAtUtc} onExpired={() => void load()} />
                    </>
                  )}
                  {sale.status === "expired" && (
                    <p className="flex items-start gap-2 text-muted">
                      <Icon name="x" size={17} className="mt-0.5" />
                      <span>{t.tickets.expired}</span>
                    </p>
                  )}
                  {sale.status === "refunded" && (
                    <p className="flex items-start gap-2 text-muted">
                      <Icon name="check" size={17} className="mt-0.5 text-success" />
                      <span>
                        {t.tickets.refunded}
                        {sale.refundTxHash && (
                          <>
                            {" "}
                            <a
                              href={explorerTxUrl(sale.refundTxHash)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-semibold text-primary underline"
                            >
                              {t.tickets.receipt}
                            </a>
                          </>
                        )}
                      </span>
                    </p>
                  )}
                  {sale.status === "unclaimed" && (
                    <p className="flex items-start gap-2 text-error">
                      <Icon name="alert" size={17} className="mt-0.5" />
                      <span>{t.tickets.unclaimed}</span>
                    </p>
                  )}

                  {(sale.status === "pending" || sale.status === "expired") && (
                    <Button
                      variant={sale.status === "pending" ? "primary" : "ghost"}
                      loading={check?.busy}
                      onClick={() => void verify(sale)}
                      className={sale.status === "pending" ? "w-full" : "w-fit px-0 underline"}
                    >
                      {sale.status === "pending" ? t.tickets.verifyPending : t.tickets.verifyExpired}
                    </Button>
                  )}
                  {check?.message && (
                    <p
                      className={`rounded-xl border px-3 py-2 text-xs leading-5 ${
                        check.tone === "error"
                          ? "border-error-border bg-error-light text-error"
                          : "border-border bg-background text-muted"
                      }`}
                    >
                      {check.message}
                    </p>
                  )}
                </div>
              )}
            </Card>
          </Fragment>
        );
      })}
    </AppShell>
  );
}
