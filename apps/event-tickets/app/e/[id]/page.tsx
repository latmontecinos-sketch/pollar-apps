import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db, dbReady } from "@/lib/db";
import Image from "next/image";
import { eventImageVersion } from "@/lib/event-image";
import { eventImagePath } from "@/lib/event-image-path";
import {
  contactHref,
  formatAmount,
  formatEventDateTime,
  formatEventDay,
  formatEventTime,
  salesClosed,
} from "@/lib/format";
import { getDict } from "@/lib/i18n/server";
import type { Dict } from "@/lib/i18n";
import { sweepExpiredSales } from "@/lib/sales";
import { listTicketTypes, summarize, type TicketType } from "@/lib/ticket-types";
import { stroopsToDecimal } from "@/lib/money";
import { AppShell } from "@/components/AppShell";
import { BuyButton } from "@/components/BuyButton";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { IconTile } from "@/components/ui/ListRow";

type EventRow = {
  id: string;
  name: string;
  description: string;
  datetime_utc: string;
  place: string;
  organizer_name: string;
  organizer_contact: string;
};

/** Shared by generateMetadata and the page (one DB read per request). */
const loadPublicEvent = cache(
  async (
    id: string
  ): Promise<{ event: EventRow; types: TicketType[]; imageVersion: string | null } | null> => {
    await dbReady();
    // Release seats held by abandoned checkouts, so the counts are honest.
    await sweepExpiredSales({ eventId: id });
    const result = await db.execute({
      sql: `SELECT id, name, description, datetime_utc, place, organizer_name, organizer_contact
            FROM events WHERE id = ?`,
      args: [id],
    });
    if (result.rows.length === 0) return null;
    return {
      event: result.rows[0] as unknown as EventRow,
      types: await listTicketTypes(id),
      imageVersion: await eventImageVersion(id),
    };
  }
);

/**
 * What WhatsApp/Telegram/etc. show when the organizer shares the link: the
 * name as the title, a sentence that sells it ("Compra tus entradas para…
 * Será el sábado 24 de octubre a las 19:00, en…"), and the image from
 * ./opengraph-image.tsx, which carries the event's photo when it has one.
 */
export async function generateMetadata({ params }: PageProps<"/e/[id]">): Promise<Metadata> {
  const { id } = await params;
  const [data, { locale, t }] = await Promise.all([loadPublicEvent(id), getDict()]);
  if (!data) return { title: t.meta.eventNotFound };
  const price = formatAmount(stroopsToDecimal(summarize(data.types).priceStroops), locale);
  const description = t.meta.eventDescription(
    data.event.name,
    formatEventDay(data.event.datetime_utc, locale),
    formatEventTime(data.event.datetime_utc, locale),
    data.event.place,
    price
  );
  return {
    title: data.event.name,
    description,
    openGraph: { title: data.event.name, description, type: "website" },
    twitter: { card: "summary_large_image", title: data.event.name, description },
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
 * Public event page: no login, link-only. Anyone with the URL sees the
 * event, every ticket tier with its own price and remaining seats, and
 * whatever name/contact the organizer chose to publish.
 */
export default async function PublicEventPage({ params }: PageProps<"/e/[id]">) {
  const { id } = await params;
  const [data, { locale, t }] = await Promise.all([loadPublicEvent(id), getDict()]);
  if (!data) notFound();
  const { event, types, imageVersion } = data;

  const closed = salesClosed(event.datetime_utc);
  const totals = summarize(types);
  const anySeats = types.some((type) => type.capacity - type.reserved > 0);
  // "Sold out" means sold, not "held by someone mid-checkout": seats waiting
  // on an unpaid reservation come back in minutes.
  const heldOverall = Math.max(0, totals.reserved - totals.paid);
  const soldOut = !anySeats && heldOverall === 0;
  const onlyHeld = !anySeats && heldOverall > 0;
  const buyable = !closed && !soldOut && !onlyHeld;

  return (
    <AppShell
      hero={
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <span className="w-fit rounded-full bg-background px-3 py-1 text-xs font-semibold text-primary-text shadow-sm">
              {t.tiers.from(formatAmount(stroopsToDecimal(totals.priceStroops), locale))}
            </span>
            <h1 className="text-[1.75rem] font-extrabold leading-tight tracking-tight">{event.name}</h1>
          </div>
          {/* The two facts people come for, as the band's light stat cards. */}
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1.5 rounded-2xl bg-background px-3.5 py-3 text-foreground shadow-sm">
              <Icon name="calendar" size={18} className="text-primary-text" />
              <span className="text-sm font-semibold leading-5 first-letter:uppercase">
                {formatEventDateTime(event.datetime_utc, locale)}
              </span>
            </div>
            <div className="flex flex-col gap-1.5 rounded-2xl bg-background px-3.5 py-3 text-foreground shadow-sm">
              <Icon name="pin" size={18} className="text-primary-text" />
              <span className="text-sm font-semibold leading-5">{event.place}</span>
            </div>
          </div>
        </div>
      }
    >
      {imageVersion && (
        // The poster, as the organizer framed it: 4:5, the full width of a phone.
        <div className="relative aspect-[4/5] w-full overflow-hidden rounded-3xl bg-surface shadow-md">
          <Image
            src={eventImagePath(event.id, imageVersion)}
            alt={t.eventImage.alt(event.name)}
            fill
            priority
            unoptimized
            sizes="(min-width: 1024px) 32rem, 100vw"
            className="object-cover"
          />
        </div>
      )}

      {/* Only when there's something to say: date and place already live in the band. */}
      {(event.description || event.organizer_name || event.organizer_contact || !buyable) && (
        <Card className="flex flex-col gap-5">
          {event.description && <p className="text-sm leading-6 text-muted">{event.description}</p>}

          {(event.organizer_name || event.organizer_contact) && (
            <div className="flex items-center gap-3 text-sm">
              <IconTile icon="users" tone="soft" size={40} />
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">
                  {t.event.organizedBy(event.organizer_name || t.event.organizerFallback)}
                </span>
                {event.organizer_contact && <OrganizerContact contact={event.organizer_contact} t={t} />}
              </span>
            </div>
          )}

          {closed && (
            <div className="rounded-xl bg-surface px-4 py-3 text-center text-sm font-semibold text-muted">
              {t.event.closed}
            </div>
          )}
          {!closed && soldOut && (
            <div className="rounded-xl bg-error-light px-4 py-3 text-center text-sm font-semibold text-error">
              {t.event.soldOut}
            </div>
          )}
          {!closed && onlyHeld && (
            <div className="flex flex-col gap-1 rounded-xl border border-warning-border bg-warning-light px-4 py-3 text-sm leading-6">
              <span className="font-semibold text-warning">{t.hold.heldSeats(heldOverall)}</span>
              <span className="text-muted">{t.hold.retryLater}</span>
            </div>
          )}
        </Card>
      )}

      {buyable && (
        <section className="flex flex-col gap-3">
          <h2 className="px-1 text-sm font-bold">
            {types.length > 1 ? t.tiers.choose : t.tiers.sectionTitle}
          </h2>
          {types.map((type) => {
            const remaining = Math.max(0, type.capacity - type.reserved);
            const held = Math.max(0, type.reserved - type.paid);
            return (
              <Card key={type.id} className="flex flex-col gap-4 p-5">
                <div className="flex items-center gap-3.5">
                  <IconTile icon="ticket" tone={remaining > 0 ? "strong" : "soft"} />
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate font-semibold">{type.name}</h3>
                    <p className={`text-xs font-medium ${remaining > 0 ? "text-primary-text" : "text-muted"}`}>
                      {remaining > 0
                        ? t.tiers.remaining(remaining)
                        : held > 0
                          ? `${t.tiers.held}: ${held}`
                          : t.tiers.soldOut}
                    </p>
                  </div>
                  <span className="shrink-0 border-l border-tile-soft pl-3 text-right font-mono text-lg font-bold">
                    {formatAmount(type.priceDecimal, locale)}
                    <span className="block font-sans text-[11px] font-medium text-muted">USDC</span>
                  </span>
                </div>
                {remaining > 0 ? (
                  <BuyButton
                    eventId={event.id}
                    eventName={event.name}
                    ticketTypeId={type.id}
                    ticketTypeName={type.name}
                    priceDecimal={type.priceDecimal}
                  />
                ) : (
                  <p className="rounded-xl bg-surface px-3 py-2 text-center text-xs font-semibold text-muted">
                    {held > 0 ? t.hold.heldSeats(held) : t.tiers.soldOut}
                  </p>
                )}
              </Card>
            );
          })}
        </section>
      )}

      {buyable && (
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
    </AppShell>
  );
}
