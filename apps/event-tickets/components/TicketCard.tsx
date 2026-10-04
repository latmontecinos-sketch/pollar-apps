"use client";

import Link from "next/link";
import { CalendarLinks } from "@/components/CalendarLinks";
import { HoldCountdown } from "@/components/HoldCountdown";
import { SaveTicketButton } from "@/components/SaveTicketButton";
import { TicketQr } from "@/components/TicketQr";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { eventDayParts, formatEventDateTime, formatTimestamp, salesClosed } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n/client";
import { explorerTxUrl } from "@/lib/network";
import { tierPrice } from "@/lib/price-label";

export type Sale = {
  id: string;
  status: "pending" | "paid" | "expired" | "unclaimed" | "refunded";
  amountDecimal: string;
  expiresAtUtc: string;
  refundTxHash: string | null;
  ticketTypeName: string | null;
  event: { id: string; name: string; datetimeUtc: string; place: string; city: string | null; doorsOpenUtc: string | null };
  ticket: { code: string; doorCode: string | null; usedAt: string | null } | null;
};

export type VerifyState = { busy: boolean; message?: string; tone?: "info" | "error" };

/**
 * One purchase in "Mis entradas", drawn as a ticket: the date block and the
 * event on top, then (past a dashed tear-off line) the QR, the door code and
 * the calendar links; or, when there is no ticket yet, what is going on with
 * the payment. Purely presentational: the page owns loading and verifying.
 */
export function TicketCard({
  sale,
  check,
  onVerify,
  onExpired,
}: {
  sale: Sale;
  check?: VerifyState;
  onVerify: () => void;
  onExpired: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const past = salesClosed(sale.event.datetimeUtc);
  const dayParts = eventDayParts(sale.event.datetimeUtc, locale);
  // A ticket worth showing a QR for: not used, not past.
  const live = !!sale.ticket && !sale.ticket.usedAt && !past;
  return (
    <Card className="relative flex flex-col overflow-hidden p-0">
      <div className="flex items-start gap-3.5 px-5 py-5">
        {/* The date block: the day is what people look for in a wallet of tickets. */}
        <span
          className={`flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-2xl ${
            live ? "bg-tile-strong text-tile-foreground" : "bg-tile-soft text-tile-soft-foreground"
          }`}
        >
          <span className="text-xs font-bold uppercase leading-none">{dayParts.month}</span>
          <span className="text-xl font-extrabold leading-tight tabular-nums">{dayParts.day}</span>
        </span>
        <div className="min-w-0 flex-1">
          <Link
            href={`/e/${sale.event.id}`}
            className="line-clamp-2 min-h-11 font-bold leading-snug hover:text-primary-text"
          >
            {sale.event.name}
          </Link>
          <p className="text-xs font-semibold text-primary-text first-letter:uppercase">
            {formatEventDateTime(sale.event.datetimeUtc, locale)}
          </p>
          <p className="truncate text-xs text-muted">{sale.event.place}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="whitespace-nowrap font-mono text-xs font-semibold text-muted">
            {tierPrice(t, locale, sale.amountDecimal)}
          </span>
          {sale.ticketTypeName && (
            <span className="rounded-full bg-primary-light px-2 py-0.5 text-xs font-semibold text-primary-text">
              {sale.ticketTypeName}
            </span>
          )}
        </div>
      </div>
  
      {sale.ticket ? (
        <div className="relative flex flex-col items-center gap-4 border-t-2 border-dashed border-border bg-surface px-5 pb-5 pt-7">
          {/* The tear-off notches: the page's own color, half hidden by the card's edge. */}
          <span aria-hidden="true" className="absolute -top-3 -left-3 h-6 w-6 rounded-full bg-sheet" />
          <span aria-hidden="true" className="absolute -top-3 -right-3 h-6 w-6 rounded-full bg-sheet" />
          {sale.ticket.usedAt ? (
            <span className="flex items-center gap-2 rounded-full bg-success-light px-3 py-1.5 text-sm font-semibold text-success">
              <Icon name="check" size={16} /> {t.tickets.usedAt(formatTimestamp(sale.ticket.usedAt, locale))}
            </span>
          ) : past ? (
            <span className="text-sm text-muted">{t.tickets.past}</span>
          ) : (
            <>
              <div className="rounded-2xl bg-background p-3 shadow-sm ring-1 ring-foreground/10">
                <TicketQr value={sale.ticket.code} size={180} />
              </div>
              <p className="text-center text-xs text-muted">{t.tickets.showQr}</p>
            </>
          )}
          <div className="flex flex-col items-center gap-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">
              {t.tickets.doorCode}
            </span>
            <span className="font-mono text-xl font-bold tracking-[0.2em]">
              {sale.ticket.doorCode}
            </span>
          </div>
          {live && (
            <div className="flex w-full flex-col items-center gap-2 border-t border-border pt-4">
              <CalendarLinks
                event={{
                  id: sale.event.id,
                  name: sale.event.name,
                  place: sale.event.place,
                  city: sale.event.city,
                  datetimeUtc: sale.event.datetimeUtc,
                  doorsOpenUtc: sale.event.doorsOpenUtc,
                }}
              />
              {sale.ticket.doorCode && (
                <SaveTicketButton
                  code={sale.ticket.code}
                  doorCode={sale.ticket.doorCode}
                  eventName={sale.event.name}
                  eventDateTime={sale.event.datetimeUtc}
                  eventPlace={sale.event.place}
                />
              )}
            </div>
          )}
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
              <HoldCountdown expiresAtUtc={sale.expiresAtUtc} onExpired={onExpired} />
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
              onClick={onVerify}
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
  );
}
