import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db, dbReady } from "@/lib/db";
import { stroopsToDecimal } from "@/lib/money";
import { contactHref, formatAmount, formatEventDateTime, salesClosed } from "@/lib/format";
import { getDict } from "@/lib/i18n/server";
import type { Dict } from "@/lib/i18n";
import { sweepExpiredSales } from "@/lib/sales";
import { AppHeader } from "@/components/AppHeader";
import { BuyButton } from "@/components/BuyButton";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";

type EventRow = {
  id: string;
  name: string;
  description: string;
  datetime_utc: string;
  place: string;
  price_stroops: string;
  capacity: number;
  reserved: number;
  organizer_name: string;
  organizer_contact: string;
  paid: number;
};

/** Shared by generateMetadata and the page (one DB read per request). */
const loadPublicEvent = cache(async (id: string): Promise<EventRow | null> => {
  await dbReady();
  // Release seats held by abandoned checkouts, so "cupos disponibles" is honest.
  await sweepExpiredSales({ eventId: id });
  const result = await db.execute({
    sql: `SELECT id, name, description, datetime_utc, place, price_stroops, capacity, reserved,
                 organizer_name, organizer_contact,
                 (SELECT count(*) FROM sales
                  WHERE sales.event_id = events.id AND sales.status = 'paid') AS paid
          FROM events WHERE id = ?`,
    args: [id],
  });
  return result.rows.length > 0 ? (result.rows[0] as unknown as EventRow) : null;
});

/** What WhatsApp/Telegram/etc. show when the organizer shares the link. */
export async function generateMetadata({ params }: PageProps<"/e/[id]">): Promise<Metadata> {
  const { id } = await params;
  const [event, { locale, t }] = await Promise.all([loadPublicEvent(id), getDict()]);
  if (!event) return { title: t.meta.eventNotFound };
  const description = t.meta.eventDescription(
    formatEventDateTime(event.datetime_utc, locale),
    event.place,
    formatAmount(stroopsToDecimal(BigInt(event.price_stroops)), locale)
  );
  return {
    title: event.name,
    description,
    openGraph: { title: event.name, description },
  };
}

function OrganizerContact({ contact, t }: { contact: string; t: Dict }) {
  const href = contactHref(contact);
  if (!href) return <span className="truncate text-xs text-muted">{t.event.contactPlain(contact)}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex w-fit items-center gap-1 truncate text-xs font-semibold text-primary underline"
    >
      {t.event.contactLink(contact)} <Icon name="external" size={11} />
    </a>
  );
}

/**
 * Public event page: no login, link-only. Anyone with the URL sees name,
 * date, place, price, remaining seats and whatever name/contact the
 * organizer chose to publish — never their wallet or email.
 */
export default async function PublicEventPage({ params }: PageProps<"/e/[id]">) {
  const { id } = await params;
  const [event, { locale, t }] = await Promise.all([loadPublicEvent(id), getDict()]);
  if (!event) notFound();

  const remaining = Math.max(0, event.capacity - event.reserved);
  // "Sold out" means sold, not "held by someone mid-checkout": seats waiting
  // on an unpaid reservation come back in minutes, and saying "agotado" for
  // those turns a temporary hold into a lost sale.
  const held = Math.max(0, event.reserved - Number(event.paid));
  const soldOut = remaining <= 0 && held === 0;
  const onlyHeld = remaining <= 0 && held > 0;
  const closed = salesClosed(event.datetime_utc);
  const priceDecimal = stroopsToDecimal(BigInt(event.price_stroops));
  const takenPct = Math.min(100, Math.round((event.reserved / event.capacity) * 100));

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6 lg:max-w-lg lg:py-10">
      <AppHeader />

      <Card className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <span className="w-fit rounded-full bg-primary-light px-3 py-1 text-xs font-semibold text-primary">
            {t.event.ticketBadge(formatAmount(priceDecimal, locale))}
          </span>
          <h1 className="text-2xl font-extrabold leading-tight tracking-tight">{event.name}</h1>
          {event.description && (
            <p className="text-sm leading-6 text-muted">{event.description}</p>
          )}
        </div>

        <ul className="flex flex-col gap-3 text-sm">
          <li className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface text-primary">
              <Icon name="calendar" size={18} />
            </span>
            <span className="font-medium first-letter:uppercase">
              {formatEventDateTime(event.datetime_utc, locale)}
            </span>
          </li>
          <li className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface text-primary">
              <Icon name="pin" size={18} />
            </span>
            <span className="font-medium">{event.place}</span>
          </li>
          {(event.organizer_name || event.organizer_contact) && (
            <li className="flex items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface text-primary">
                <Icon name="users" size={18} />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">
                  {t.event.organizedBy(event.organizer_name || t.event.organizerFallback)}
                </span>
                {event.organizer_contact && (
                  <OrganizerContact contact={event.organizer_contact} t={t} />
                )}
              </span>
            </li>
          )}
        </ul>

        {closed ? (
          <div className="rounded-xl bg-surface px-4 py-3 text-center text-sm font-semibold text-muted">
            {t.event.closed}
          </div>
        ) : onlyHeld ? (
          <div className="flex flex-col gap-1 rounded-xl border border-warning-border bg-warning-light px-4 py-3 text-sm leading-6">
            <span className="font-semibold text-warning">{t.hold.heldSeats(held)}</span>
            <span className="text-muted">{t.hold.retryLater}</span>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-1.5 text-muted">
                <Icon name="users" size={16} /> {t.event.seats}
              </span>
              <span className={`font-semibold ${soldOut ? "text-error" : "text-foreground"}`}>
                {soldOut ? t.event.soldOut : t.event.remaining(remaining, event.capacity)}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-hover">
              <div
                className={`h-full rounded-full ${soldOut ? "bg-error" : "bg-primary"}`}
                style={{ width: `${takenPct}%` }}
              />
            </div>
          </div>
        )}

        {!soldOut && !onlyHeld && !closed && (
          <BuyButton eventId={event.id} eventName={event.name} priceDecimal={priceDecimal} />
        )}
      </Card>

      {!soldOut && !closed && (
        <Card className="flex flex-col gap-3 p-5">
          <h2 className="text-sm font-bold">{t.event.firstTimeTitle}</h2>
          <ol className="flex flex-col gap-2 text-sm text-muted">
            {t.event.firstTimeSteps.map((step, index) => (
              <li key={step} className="flex gap-2">
                <span className="font-bold text-primary">{index + 1}.</span> {step}
              </li>
            ))}
          </ol>
          <Link href="/como-funciona" className="text-sm font-semibold text-primary underline">
            {t.event.fullGuide}
          </Link>
        </Card>
      )}
    </main>
  );
}
