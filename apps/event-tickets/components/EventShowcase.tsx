"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import { PassMark } from "@/components/ui/PassMark";
import { eventImagePath } from "@/lib/event-image-path";
import { formatEventDateTime, formatEventDay, formatEventTime } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n/client";
import { priceLabel } from "@/lib/price-label";
import type { PublicEvent, ShowcaseCity } from "@/lib/public-events";
import { showcaseHref, type ShowcaseWhen } from "@/lib/showcase-filters";

const AUTO_ADVANCE_MS = 5000;
const FEATURED = 6;
/** From this many seats down, the card says how few are left. */
const FEW_SEATS = 10;

/** What the page's query string asked for (lib/showcase-filters.ts), already cleaned by the server. */
export type ActiveFilters = { city: string | null; when: ShowcaseWhen };

function Poster({
  event,
  sizes,
  priority = false,
  eager = false,
}: {
  event: PublicEvent;
  sizes: string;
  priority?: boolean;
  /** The slider's posters: offscreen until the next slide, but that's seconds away. */
  eager?: boolean;
}) {
  return event.imageVersion ? (
    <Image
      src={eventImagePath(event.id, event.imageVersion)}
      alt=""
      fill
      sizes={sizes}
      priority={priority}
      loading={priority ? undefined : eager ? "eager" : "lazy"}
      unoptimized
      className="object-cover"
    />
  ) : (
    // No photo yet: the brand band and the bear, so the card still reads as an event.
    <span className="flex h-full w-full items-center justify-center bg-band">
      <PassMark size={72} variant="band" />
    </span>
  );
}

/** A filter chip: a real link (the URL is the state), 44px tall, the pressed one filled. "Hoy" wears the ticket amber. */
function Chip({
  href,
  active,
  tone = "primary",
  children,
}: {
  href: string;
  active: boolean;
  tone?: "primary" | "amber";
  children: React.ReactNode;
}) {
  const on = tone === "amber" ? "bg-accent text-accent-foreground" : "bg-primary text-primary-foreground";
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={active ? "true" : undefined}
      className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full px-4 text-sm font-semibold transition-colors ${
        active
          ? `${on} shadow-sm`
          : "bg-background text-foreground ring-1 ring-foreground/15 hover:bg-surface-hover"
      }`}
    >
      {children}
    </Link>
  );
}

/** The small pills over a poster: solid, never a color the poster might share. */
const pill = "rounded-full px-2.5 py-1 text-xs font-bold leading-none shadow-sm";

/**
 * The showcase, poster first: every public event as its poster, with city and
 * "today / this week" chips above, and a slider of the featured ones.
 *
 * The chips are plain links that change the page's query string
 * (`?city=…&when=…`): the server filters (lib/public-events.ts), so the URL is
 * shareable and the back button undoes a filter. Only the search box is local.
 *
 * The slider is a native scroll-snap strip, so swiping, momentum and keyboard
 * scrolling are the browser's own; the timer only nudges it, and stops while
 * someone is touching it or asked for less motion.
 */
export function EventShowcase({
  events,
  cities = [],
  filters = { city: null, when: "all" },
}: {
  events: PublicEvent[];
  cities?: ShowcaseCity[];
  filters?: ActiveFilters;
}) {
  const t = useT();
  const locale = useLocale();
  const [query, setQuery] = useState("");
  const strip = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  /** The reader's own pause (WCAG 2.2.2): unlike hover or touch, it stays until they resume. */
  const [stopped, setStopped] = useState(false);

  const filtered = filters.city !== null || filters.when !== "all";

  const featured = useMemo(() => {
    const withPhoto = events.filter((event) => event.imageVersion);
    return (withPhoto.length > 0 ? withPhoto : events).slice(0, FEATURED);
  }, [events]);

  const visible = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    if (!q) return events;
    return events.filter(
      (event) => event.name.toLocaleLowerCase().includes(q) || event.place.toLocaleLowerCase().includes(q)
    );
  }, [events, query]);

  function goTo(index: number) {
    const node = strip.current;
    const slide = node?.children[index] as HTMLElement | undefined;
    if (!node || !slide) return;
    node.scrollTo({ left: slide.offsetLeft - node.offsetLeft - 16, behavior: "smooth" });
  }

  // Which slide is centered, from the scroll position — so the counter follows a swipe too.
  useEffect(() => {
    const node = strip.current;
    if (!node) return;
    const onScroll = () => {
      const center = node.scrollLeft + node.clientWidth / 2;
      let best = 0;
      let bestDistance = Infinity;
      Array.from(node.children).forEach((child, index) => {
        const el = child as HTMLElement;
        const distance = Math.abs(el.offsetLeft - node.offsetLeft + el.clientWidth / 2 - center);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      });
      setActive(best);
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, [featured.length]);

  useEffect(() => {
    if (paused || stopped || featured.length < 2) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(() => goTo((active + 1) % featured.length), AUTO_ADVANCE_MS);
    return () => clearInterval(timer);
  }, [active, paused, stopped, featured.length]);

  // Nothing public at all, and no filter to blame: the showcase has nothing to say yet.
  if (events.length === 0 && !filtered && cities.length === 0) {
    return <p className="rounded-3xl bg-background px-5 py-8 text-center text-sm text-muted shadow-sm">{t.showcase.empty}</p>;
  }

  const showFeatured = !query && !filtered && featured.length > 1;
  const whenOptions: { value: ShowcaseWhen; label: string }[] = [
    { value: "all", label: t.showcase.whenAll },
    { value: "today", label: t.showcase.whenToday },
    { value: "week", label: t.showcase.whenWeek },
  ];
  // A city from the link that has no events right now still gets its chip, so it can be turned off.
  const cityChips =
    filters.city && !cities.some((c) => c.city === filters.city)
      ? [{ city: filters.city, count: 0 }, ...cities]
      : cities;

  return (
    <section className="@container flex flex-col gap-5">
      <label className="relative flex items-center">
        <span className="sr-only">{t.showcase.search}</span>
        <Icon name="search" size={18} className="pointer-events-none absolute left-4 text-muted" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.showcase.search}
          className="min-h-12 w-full rounded-full border border-transparent bg-background py-3 pr-4 pl-11 text-sm shadow-sm ring-1 ring-foreground/10 placeholder:text-muted focus:border-primary"
        />
      </label>

      {/* Filters: one row for the city, one for the time. They scroll sideways on a phone and never wrap into a wall of chips. */}
      <div className="flex flex-col gap-2">
        {cityChips.length > 0 && (
          <nav
            aria-label={t.showcase.filterCity}
            className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            <Chip href={showcaseHref(filters, { city: null })} active={filters.city === null}>
              {t.showcase.cityAll}
            </Chip>
            {cityChips.map(({ city, count }) => (
              <Chip key={city} href={showcaseHref(filters, { city })} active={filters.city === city}>
                <Icon name="pin" size={14} />
                {city}
                {count > 0 && <span className="font-mono text-xs font-medium opacity-80">{count}</span>}
              </Chip>
            ))}
          </nav>
        )}
        <nav
          aria-label={t.showcase.filterWhen}
          className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {whenOptions.map(({ value, label }) => (
            <Chip
              key={value}
              href={showcaseHref(filters, { when: value })}
              active={filters.when === value}
              tone={value === "today" ? "amber" : "primary"}
            >
              {value === "today" && filters.when !== "today" && (
                <span aria-hidden="true" className="h-2 w-2 rounded-full bg-accent ring-1 ring-foreground/20" />
              )}
              {label}
            </Chip>
          ))}
        </nav>
      </div>

      {showFeatured && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3 px-1">
            <h2 className="text-lg font-bold tracking-tight">{t.showcase.featured}</h2>
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-muted" aria-hidden="true">
                {active + 1} / {featured.length}
              </span>
              <button
                type="button"
                onClick={() => setStopped((value) => !value)}
                aria-pressed={stopped}
                className="inline-flex min-h-11 items-center rounded-full px-3 text-xs font-semibold text-primary-text hover:bg-primary-light"
              >
                {stopped ? t.showcase.play : t.showcase.pause}
              </button>
              <button
                type="button"
                onClick={() => goTo((active - 1 + featured.length) % featured.length)}
                aria-label={t.showcase.previous}
                className="flex h-11 w-11 rotate-180 items-center justify-center rounded-full bg-background shadow-sm ring-1 ring-foreground/10 hover:text-primary"
              >
                <Icon name="chevron" size={18} />
              </button>
              <button
                type="button"
                onClick={() => goTo((active + 1) % featured.length)}
                aria-label={t.showcase.next}
                className="flex h-11 w-11 items-center justify-center rounded-full bg-background shadow-sm ring-1 ring-foreground/10 hover:text-primary"
              >
                <Icon name="chevron" size={18} />
              </button>
            </div>
          </div>
          <div
            ref={strip}
            onPointerDown={() => setPaused(true)}
            onMouseEnter={() => setPaused(true)}
            onMouseLeave={() => setPaused(false)}
            onFocus={() => setPaused(true)}
            className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {featured.map((event, index) => (
              <Link
                key={event.id}
                href={`/e/${event.id}`}
                className="group relative aspect-[4/5] w-[78%] shrink-0 snap-center overflow-hidden rounded-3xl bg-surface shadow-md @xl:w-[46%] @4xl:w-[31%]"
              >
                <Poster event={event} sizes="(min-width: 1024px) 30vw, (min-width: 640px) 46vw, 78vw" priority={index === 0} eager />
                {/* Legible over any poster: a scrim, not a color the poster might share. */}
                <span className="absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-gradient-to-t from-scrim/90 via-scrim/55 to-transparent px-4 pt-16 pb-4 text-on-scrim">
                  <span className={`${pill} w-fit bg-primary text-primary-foreground`}>
                    {priceLabel(t, locale, event.minPriceDecimal, event.maxPriceDecimal)}
                  </span>
                  <span className="line-clamp-2 text-lg font-bold leading-tight">{event.name}</span>
                  <span className="text-xs font-medium text-on-scrim first-letter:uppercase">
                    {formatEventDay(event.datetimeUtc, locale)} · {formatEventTime(event.datetimeUtc, locale)}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <h2 className="px-1 text-lg font-bold tracking-tight">{t.showcase.upcoming}</h2>

        {events.length === 0 && filtered && (
          // The filter is what found nothing: say so, and offer the way back.
          <div className="flex flex-col items-center gap-3 rounded-3xl bg-background px-5 py-10 text-center shadow-sm ring-1 ring-foreground/10">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-primary-light text-primary-text">
              <Icon name="calendar" size={26} />
            </span>
            <p className="max-w-xs text-sm leading-6 text-muted">{t.showcase.emptyFiltered}</p>
            <Link
              href={showcaseHref({ city: null, when: "all" }, {})}
              scroll={false}
              className="inline-flex min-h-11 items-center rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary-hover"
            >
              {t.showcase.clearFilters}
            </Link>
          </div>
        )}
        {events.length > 0 && visible.length === 0 && (
          <p className="px-1 text-sm text-muted">{t.showcase.emptySearch}</p>
        )}

        <div className="grid grid-cols-2 gap-x-3 gap-y-6 @2xl:grid-cols-3 @4xl:grid-cols-4">
          {visible.map((event) => (
            <Link key={event.id} href={`/e/${event.id}`} className="group flex flex-col gap-2.5 rounded-3xl">
              <span className="relative aspect-[4/5] w-full overflow-hidden rounded-3xl bg-surface shadow-sm ring-1 ring-foreground/10 transition-transform duration-200 group-hover:-translate-y-0.5 group-active:scale-[0.99]">
                <Poster event={event} sizes="(min-width: 1024px) 22vw, (min-width: 640px) 30vw, 46vw" />
                <span className="absolute inset-x-2 top-2 flex flex-wrap items-start justify-between gap-1">
                  <span className={`${pill} bg-background text-foreground`}>
                    {priceLabel(t, locale, event.minPriceDecimal, event.maxPriceDecimal)}
                  </span>
                  {event.seatsLeft === 0 ? (
                    <span className={`${pill} bg-error-light text-error`}>{t.showcase.soldOut}</span>
                  ) : (
                    event.seatsLeft <= FEW_SEATS && (
                      <span className={`${pill} bg-accent text-accent-foreground`}>{t.showcase.seatsLeft(event.seatsLeft)}</span>
                    )
                  )}
                </span>
              </span>
              <span className="flex flex-col gap-0.5 px-1">
                <span className="text-xs font-bold uppercase tracking-wide text-primary-text">
                  {formatEventDateTime(event.datetimeUtc, locale)}
                </span>
                <span className="line-clamp-2 font-bold leading-snug group-hover:text-primary-text">{event.name}</span>
                <span className="flex items-center gap-1 text-xs text-muted">
                  <Icon name="pin" size={12} className="shrink-0" />
                  <span className="truncate">{event.place}</span>
                </span>
              </span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
