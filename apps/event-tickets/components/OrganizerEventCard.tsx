"use client";

import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import type { MyEvent } from "@/hooks/useMyEvents";
import { formatEventDateTime, salesClosed } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n/client";
import { priceLabel } from "@/lib/price-label";

/** The organizer's main action, as a full-width pill. */
export function CreateEventButton({ label }: { label: string }) {
  return (
    <Link
      href="/organizador/nuevo"
      className="flex h-12 items-center justify-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary-hover"
    >
      <Icon name="plus" size={18} />
      {label}
    </Link>
  );
}

/** One of the organizer's events: when and where, on sale or over, how full, and its price range. */
export function OrganizerEventCard({ event }: { event: MyEvent }) {
  const t = useT();
  const locale = useLocale();
  const closed = salesClosed(event.datetimeUtc);
  const soldPct = event.capacity > 0 ? Math.min(100, Math.round((event.paid / event.capacity) * 100)) : 0;

  return (
    <Link href={`/organizador/eventos/${event.id}`}>
      <Card className="flex flex-col gap-3 p-5 transition-colors hover:border-primary/40 hover:bg-surface-hover">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-semibold">{event.name}</h2>
            <p className="text-sm text-muted first-letter:uppercase">
              {formatEventDateTime(event.datetimeUtc, locale)} · {event.place}
            </p>
          </div>
          <span
            className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${
              closed ? "bg-surface text-muted" : "bg-success-light text-success"
            }`}
          >
            {closed ? t.myEvents.finished : t.myEvents.onSale}
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex justify-between gap-3 text-xs text-muted">
            <span>{t.myEvents.sold(event.paid, event.capacity)}</span>
            <span className="text-right font-medium">
              {priceLabel(t, locale, event.minPriceDecimal, event.maxPriceDecimal)}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-hover">
            <div className="h-full rounded-full bg-primary" style={{ width: `${soldPct}%` }} />
          </div>
        </div>
      </Card>
    </Link>
  );
}
