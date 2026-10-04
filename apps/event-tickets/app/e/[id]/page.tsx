import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { db, dbReady } from "@/lib/db";
import Image from "next/image";
import { eventImageVersion } from "@/lib/event-image";
import { eventImagePath } from "@/lib/event-image-path";
import { accentStyle } from "@/lib/accent";
import { attendeesForPage } from "@/lib/event-attendees";
import { googleCalendarUrl, mapsLinks } from "@/lib/event-links";
import {
  contactHref,
  formatAmount,
  formatEventDay,
  formatEventTime,
  salesClosed,
} from "@/lib/format";
import { getDict } from "@/lib/i18n/server";
import type { Dict } from "@/lib/i18n";
import { sweepExpiredSales } from "@/lib/sales";
import { clientIpFrom, consume, isOverLimit } from "@/lib/rate-limit";
import { listTicketTypes, summarize } from "@/lib/ticket-types";
import { isFreePrice, priceLabel, priceRange } from "@/lib/price-label";
import { canView, normalizeAccessCode } from "@/lib/visibility";
import { AppShell } from "@/components/AppShell";
import { BuyButton } from "@/components/BuyButton";
import { Card } from "@/components/ui/Card";
import { Icon, type IconName } from "@/components/ui/Icon";
import { IconTile } from "@/components/ui/ListRow";
import { PassMark } from "@/components/ui/PassMark";
import { EventTintStyle } from "@/components/EventTintStyle";

type EventRow = {
  id: string;
  name: string;
  description: string;
  datetime_utc: string;
  place: string;
  organizer_name: string;
  organizer_contact: string;
  visibility: string;
  access_code: string | null;
  city: string | null;
  doors_open_utc: string | null;
  accent: string | null;
};

/**
 * The event row alone, shared by generateMetadata and the page (one DB read
 * per request). Nothing about its tiers or photo, and no writes: a private
 * event has to clear the access gate before the page touches any of that.
 */
const loadPublicEvent = cache(async (id: string): Promise<EventRow | null> => {
  await dbReady();
  const result = await db.execute({
    sql: `SELECT id, name, description, datetime_utc, place, organizer_name, organizer_contact,
                 visibility, access_code, city, doors_open_utc, accent
          FROM events WHERE id = ?`,
    args: [id],
  });
  return result.rows.length === 0 ? null : (result.rows[0] as unknown as EventRow);
});

/** The tiers, read only. For the link preview of a public event; the page reads them after its gate. */
const loadTypesForPreview = cache((id: string) => listTicketTypes(id));

/**
 * What WhatsApp/Telegram/etc. show when the organizer shares the link: the
 * name as the title, a sentence that sells it ("Compra tus entradas para…
 * Será el sábado 24 de octubre a las 19:00, en…"), and the image from
 * ./opengraph-image.tsx, which carries the event's photo when it has one.
 */
export async function generateMetadata({ params }: PageProps<"/e/[id]">): Promise<Metadata> {
  const { id } = await params;
  const [event, { locale, t }] = await Promise.all([loadPublicEvent(id), getDict()]);
  if (!event) return { title: t.meta.eventNotFound };
  // A private event's preview says only that it's private — even a link with
  // the code in it, since the preview image can't carry the code along. Its
  // tiers are not even read.
  if (event.visibility === "private") {
    return {
      title: t.meta.privateTitle,
      description: t.meta.privateDescription,
      robots: { index: false },
      openGraph: { title: t.meta.privateTitle, description: t.meta.privateDescription },
    };
  }
  const range = priceRange(await loadTypesForPreview(id));
  const price = priceLabel(t, locale, range.minDecimal, range.maxDecimal);
  const description = t.meta.eventDescription(
    event.name,
    formatEventDay(event.datetime_utc, locale),
    formatEventTime(event.datetime_utc, locale),
    event.place,
    price
  );
  return {
    title: event.name,
    description,
    openGraph: { title: event.name, description, type: "website" },
    twitter: { card: "summary_large_image", title: event.name, description },
  };
}

/** A private event, asked for without its code (or with a wrong one). */
function AccessGate({ t, tried, limited = false }: { t: Dict; tried: boolean; limited?: boolean }) {
  return (
    <AppShell tone="poster" title={t.gate.title}>
      <Card className="flex max-w-md flex-col gap-4">
        <p className="text-sm leading-6 text-muted">{t.gate.body}</p>
        {/* A plain GET form: the code rides in the URL, the same link an organizer shares. */}
        <form method="get" className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t.gate.field}
            <input
              name="codigo"
              required
              autoComplete="off"
              autoCapitalize="characters"
              maxLength={16}
              className="min-h-12 w-full rounded-2xl border border-transparent bg-field px-4 py-3 font-mono text-base uppercase tracking-[0.3em] focus:border-primary"
            />
          </label>
          {(tried || limited) && (
            <p className="rounded-xl border border-error-border bg-error-light px-3 py-2 text-sm text-error" role="alert">
              {limited ? t.gate.tooMany : t.gate.wrong}
            </p>
          )}
          <button
            type="submit"
            className="min-h-11 rounded-full bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary-hover"
          >
            {t.gate.submit}
          </button>
        </form>
      </Card>
    </AppShell>
  );
}

function OrganizerContact({ contact, t }: { contact: string; t: Dict }) {
  const href = contactHref(contact);
  if (!href) return <span className="truncate text-xs text-muted">{t.event.contactPlain(contact)}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex min-h-11 w-fit items-center gap-1 truncate text-xs font-semibold text-primary-text underline"
    >
      {t.event.contactLink(contact)} <Icon name="external" size={11} />
    </a>
  );
}

/** A small outlined button for an action that leaves the page (a map, a calendar): 44px tall. */
const actionLink =
  "inline-flex min-h-11 items-center gap-1.5 rounded-full bg-background px-4 text-sm font-semibold text-primary-text ring-1 ring-foreground/15 transition-colors hover:bg-surface-hover";

/** One fact about the event (when, where, who's going): an icon tile, the fact, and the actions that go with it. */
function Fact({
  icon,
  title,
  subtitle,
  label,
  children,
}: {
  icon: IconName;
  title: string;
  subtitle?: string | null;
  /** Names the group of actions for a screen reader. */
  label?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex gap-3.5 p-4 sm:p-5">
      <IconTile icon={icon} tone="soft" />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <p className="font-bold leading-snug first-letter:uppercase">{title}</p>
          {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
        </div>
        {children && (
          <div role="group" aria-label={label} className="flex flex-wrap gap-2">
            {children}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Public event page: no login, link-only. Anyone with the URL sees the
 * event, every ticket tier with its own price and remaining seats, and
 * whatever name/contact the organizer chose to publish.
 *
 * Poster first: the photo is the biggest thing on the page and the page takes
 * its tint from it (the event's accent, lib/accent.ts). On a phone the poster
 * comes first and everything stacks under it; from `lg` the poster stays put
 * on the left while the facts and the tickets scroll on the right.
 */
export default async function PublicEventPage({ params, searchParams }: PageProps<"/e/[id]">) {
  const { id } = await params;
  const { codigo } = await searchParams;
  const [loaded, { locale, t }] = await Promise.all([loadPublicEvent(id), getDict()]);
  if (!loaded) notFound();
  const event = loaded;
  const offered = typeof codigo === "string" ? codigo : "";
  // Wrong codes for a private event count per IP and event; past the ceiling no
  // code is checked from that address until the window passes, so the limit
  // bounds guessing instead of slowing it. A right code never counts: many
  // phones share one carrier IP, and they all open the same shared link. The
  // miss writes one counter row from a page a stranger can open (rule 7) — the
  // exception on purpose, since a throwaway counter is the whole point. The
  // check and the count are two statements, so requests in flight together can
  // all pass the check: the overshoot is bounded by that concurrency and is
  // accepted (see `accessCode` in lib/rate-limit.ts).
  if (event.visibility === "private" && normalizeAccessCode(offered)) {
    const subject = `${clientIpFrom(await headers())}:${id}`;
    if (!(await isOverLimit("accessCode", subject)).ok) return <AccessGate t={t} tried={false} limited />;
    if (!canView(event, offered)) {
      await consume("accessCode", subject);
      return <AccessGate t={t} tried />;
    }
  }
  if (!canView(event, offered)) return <AccessGate t={t} tried={offered !== ""} />;
  // Past the gate: this visitor may see the event, so only now do its tiers,
  // photo and seat counts get read.
  //
  // The sweep is the one write left on this read path (rule 7), kept on
  // purpose and only for a viewer the gate let in. Without it, seats held by
  // abandoned checkouts keep reading as "held" on a page nobody can buy from:
  // the buy routes sweep too, but only for someone who can still press the
  // button. It writes only when something has already expired.
  await sweepExpiredSales({ eventId: id });
  const [types, imageVersion, attendees] = await Promise.all([
    listTicketTypes(id),
    eventImageVersion(id),
    // Only a number, and only from the threshold up (lib/attendees.ts).
    attendeesForPage(id),
  ]);
  // Carried into the checkout and the photo URL, which check it again.
  const accessCode = event.visibility === "private" ? normalizeAccessCode(offered) : undefined;
  const range = priceRange(types);
  // Data for the screen's extras: where it is, how to add it to a calendar, the poster's colours.
  const maps = mapsLinks(event.place, event.city);
  const calendarEvent = {
    id: event.id,
    name: event.name,
    description: event.description,
    place: event.place,
    city: event.city,
    datetimeUtc: event.datetime_utc,
    doorsOpenUtc: event.doors_open_utc,
  };
  const doorsLine = event.doors_open_utc ? t.event.doorsOpen(formatEventTime(event.doors_open_utc, locale)) : null;
  const googleCalendar = googleCalendarUrl(calendarEvent, doorsLine);
  // The file's URL carries the code for a private event, like the photo's.
  const icsHref = `/api/events/${encodeURIComponent(event.id)}/ics${accessCode ? `?c=${encodeURIComponent(accessCode)}` : ""}`;
  const accentVars = accentStyle(event.accent);

  const closed = salesClosed(event.datetime_utc);
  const totals = summarize(types);
  const anySeats = types.some((type) => type.capacity - type.reserved > 0);
  // "Sold out" means sold, not "held by someone mid-checkout": seats waiting
  // on an unpaid reservation come back in minutes.
  const heldOverall = Math.max(0, totals.reserved - totals.paid);
  const soldOut = !anySeats && heldOverall === 0;
  const onlyHeld = !anySeats && heldOverall > 0;
  const buyable = !closed && !soldOut && !onlyHeld;
  // The city under the place, unless the place already says it ("Teatro de La Paz, La Paz").
  const cityNote =
    event.city && !event.place.toLocaleLowerCase().includes(event.city.toLocaleLowerCase()) ? event.city : null;
  const priceText = priceLabel(t, locale, range.minDecimal, range.maxDecimal);

  return (
    <AppShell tone="poster" accent={accentVars}>
      {/* The page's own wash reaches the footer too (a bare `body` would show a seam). */}
      <EventTintStyle accent={event.accent} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] lg:gap-12">
        {/* The poster, as the organizer framed it (4:5). On a desktop it stays in view while the rest scrolls. */}
        <div className="lg:sticky lg:top-6 lg:self-start">
          {imageVersion ? (
            <div className="relative mx-auto aspect-[4/5] w-full max-w-md overflow-hidden rounded-3xl bg-surface shadow-[0_24px_60px_-24px_var(--tint-edge)] ring-1 ring-foreground/10 lg:max-w-none">
              <Image
                src={eventImagePath(event.id, imageVersion, accessCode)}
                alt={t.eventImage.alt(event.name)}
                fill
                priority
                unoptimized
                sizes="(min-width: 1024px) 24rem, (min-width: 448px) 28rem, 100vw"
                className="object-cover"
              />
            </div>
          ) : (
            // No photo: the brand band and the bear, a banner on a phone and a poster-shaped panel on a desktop.
            <div className="flex aspect-[16/9] w-full items-center justify-center rounded-3xl bg-band shadow-md lg:aspect-[4/5]">
              <PassMark size={96} variant="band" />
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          <header className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-background px-3 py-1.5 text-xs font-bold text-foreground shadow-sm ring-1 ring-foreground/10">
                {priceText}
              </span>
              {event.city && (
                <span className="flex items-center gap-1 rounded-full bg-background/70 px-3 py-1.5 text-xs font-semibold text-tint-text ring-1 ring-foreground/10">
                  <Icon name="pin" size={12} /> {event.city}
                </span>
              )}
            </div>
            <h1 className="text-[1.9rem] font-extrabold leading-tight tracking-tight sm:text-4xl lg:text-5xl">
              {event.name}
            </h1>
            {buyable && (
              <a
                href="#entradas"
                className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-primary px-6 text-base font-semibold text-primary-foreground shadow-sm transition-all hover:bg-primary-hover active:scale-[0.98] lg:hidden"
              >
                <Icon name="ticket" size={18} />
                {t.event.seeTickets}
              </a>
            )}
          </header>

          {/* When and where, with what to do about each. */}
          <Card className="flex flex-col divide-y divide-border p-0">
            <Fact
              icon="calendar"
              title={formatEventDay(event.datetime_utc, locale)}
              subtitle={[formatEventTime(event.datetime_utc, locale), doorsLine].filter(Boolean).join(" · ")}
              label={t.event.addToCalendar}
            >
              {googleCalendar && (
                <a href={googleCalendar} target="_blank" rel="noopener noreferrer" className={actionLink}>
                  <Icon name="calendar" size={15} /> {t.event.googleCalendar}
                </a>
              )}
              <a href={icsHref} className={actionLink}>
                <Icon name="share" size={15} /> {t.event.downloadIcs}
              </a>
            </Fact>
            <Fact icon="pin" title={event.place} subtitle={cityNote} label={t.event.openInMaps}>
              <a href={maps.google} target="_blank" rel="noopener noreferrer" className={actionLink}>
                {t.event.googleMaps} <Icon name="external" size={13} />
              </a>
              <a href={maps.waze} target="_blank" rel="noopener noreferrer" className={actionLink}>
                {t.event.waze} <Icon name="external" size={13} />
              </a>
              <a href={maps.apple} target="_blank" rel="noopener noreferrer" className={actionLink}>
                {t.event.appleMaps} <Icon name="external" size={13} />
              </a>
            </Fact>
            {attendees !== null && <Fact icon="users" title={t.event.attendees(attendees)} />}
          </Card>

          {/* Tickets: one card per tier. The anchor is where "Ver entradas" lands. */}
          <section id="entradas" className="flex scroll-mt-6 flex-col gap-3">
            <h2 className="px-1 text-lg font-bold tracking-tight">
              {types.length > 1 ? t.tiers.choose : t.tiers.sectionTitle}
            </h2>

            {closed && (
              <div className="rounded-2xl bg-background px-4 py-3 text-center text-sm font-semibold text-muted ring-1 ring-foreground/10">
                {t.event.closed}
              </div>
            )}
            {!closed && soldOut && (
              <div className="rounded-2xl bg-error-light px-4 py-3 text-center text-sm font-semibold text-error">
                {t.event.soldOut}
              </div>
            )}
            {!closed && onlyHeld && (
              <div className="flex flex-col gap-1 rounded-2xl border border-warning-border bg-warning-light px-4 py-3 text-sm leading-6">
                <span className="font-semibold text-warning">{t.hold.heldSeats(heldOverall)}</span>
                <span className="text-muted">{t.hold.retryLater}</span>
              </div>
            )}

            {buyable &&
              types.map((type) => {
                const remaining = Math.max(0, type.capacity - type.reserved);
                const held = Math.max(0, type.reserved - type.paid);
                return (
                  <Card key={type.id} className="flex flex-col gap-4 p-4 sm:p-5">
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
                        {isFreePrice(type.priceDecimal) ? (
                          <span className="font-sans text-base text-success">{t.tiers.free}</span>
                        ) : (
                          <>
                            {formatAmount(type.priceDecimal, locale)}
                            <span className="block font-sans text-xs font-medium text-muted">USDC</span>
                          </>
                        )}
                      </span>
                    </div>
                    {remaining > 0 ? (
                      <BuyButton
                        eventId={event.id}
                        eventName={event.name}
                        ticketTypeId={type.id}
                        ticketTypeName={type.name}
                        priceDecimal={type.priceDecimal}
                        accessCode={accessCode}
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

          {(event.description || event.organizer_name || event.organizer_contact) && (
            <Card className="flex flex-col gap-5">
              <h2 className="text-lg font-bold tracking-tight">{t.event.aboutTitle}</h2>
              {event.description && <p className="whitespace-pre-line text-sm leading-6 text-muted">{event.description}</p>}
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
            </Card>
          )}

          {buyable && (
            <Card className="flex flex-col gap-3 p-5">
              <h2 className="text-sm font-bold">{t.event.firstTimeTitle}</h2>
              <ol className="flex flex-col gap-2 text-sm text-muted">
                {t.event.firstTimeSteps.map((step, index) => (
                  <li key={step} className="flex gap-2">
                    <span className="font-bold text-primary-text">{index + 1}.</span> {step}
                  </li>
                ))}
              </ol>
              <Link href="/como-funciona" className="inline-flex min-h-11 w-fit items-center text-sm font-semibold text-primary-text underline">
                {t.event.fullGuide}
              </Link>
            </Card>
          )}
        </div>
      </div>
    </AppShell>
  );
}
