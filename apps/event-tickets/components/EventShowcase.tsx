"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import { eventImagePath } from "@/lib/event-image-path";
import { formatEventDay, formatEventTime } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n/client";
import { priceLabel } from "@/lib/price-label";
import type { PublicEvent } from "@/lib/public-events";

const AUTO_ADVANCE_MS = 5000;
const FEATURED = 6;

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
    // No photo yet: the brand band, so the card still reads as an event.
    <span className="flex h-full w-full items-center justify-center bg-band text-band-foreground/80">
      <Icon name="ticket" size={40} />
    </span>
  );
}

/**
 * The showcase: public events the way ticket sites show them — a slider of
 * featured posters that moves on its own and follows a swipe, then every
 * upcoming event as a row. Each opens the event's own page.
 *
 * The slider is a native scroll-snap strip, so swiping, momentum and
 * keyboard scrolling are the browser's own; the timer only nudges it, and
 * stops while someone is touching it or asked for less motion.
 */
export function EventShowcase({ events }: { events: PublicEvent[] }) {
  const t = useT();
  const locale = useLocale();
  const [query, setQuery] = useState("");
  const strip = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);

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

  // Which slide is centered, from the scroll position — so dots follow a swipe too.
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
    if (paused || featured.length < 2) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(() => goTo((active + 1) % featured.length), AUTO_ADVANCE_MS);
    return () => clearInterval(timer);
  }, [active, paused, featured.length]);

  if (events.length === 0) {
    return <p className="rounded-3xl bg-background px-5 py-8 text-center text-sm text-muted shadow-sm">{t.showcase.empty}</p>;
  }

  return (
    <section className="flex flex-col gap-5">
      <label className="relative flex items-center">
        <span className="sr-only">{t.showcase.search}</span>
        <Icon name="search" size={18} className="pointer-events-none absolute left-4 text-muted" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.showcase.search}
          className="w-full rounded-full border border-transparent bg-background py-3 pr-4 pl-11 text-sm shadow-sm placeholder:text-muted-light focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/25"
        />
      </label>

      {!query && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-lg font-bold tracking-tight">{t.showcase.featured}</h2>
            {featured.length > 1 && (
              <div className="hidden gap-2 sm:flex">
                <button
                  type="button"
                  onClick={() => goTo((active - 1 + featured.length) % featured.length)}
                  aria-label={t.showcase.previous}
                  className="flex h-9 w-9 rotate-180 items-center justify-center rounded-full bg-background shadow-sm hover:text-primary"
                >
                  <Icon name="chevron" size={18} />
                </button>
                <button
                  type="button"
                  onClick={() => goTo((active + 1) % featured.length)}
                  aria-label={t.showcase.next}
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-background shadow-sm hover:text-primary"
                >
                  <Icon name="chevron" size={18} />
                </button>
              </div>
            )}
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
                className="group relative aspect-[4/5] w-[78%] shrink-0 snap-center overflow-hidden rounded-3xl bg-surface shadow-md sm:w-[60%]"
              >
                <Poster event={event} sizes="(min-width: 640px) 60vw, 78vw" priority={index === 0} eager />
                {/* Legible over any poster: a scrim, not a color the poster might share. */}
                <span className="absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-gradient-to-t from-scrim/85 via-scrim/50 to-transparent px-4 pt-16 pb-4 text-on-scrim">
                  <span className="w-fit rounded-full bg-primary px-2.5 py-0.5 text-[11px] font-semibold text-primary-foreground">
                    {priceLabel(t, locale, event.minPriceDecimal, event.maxPriceDecimal)}
                  </span>
                  <span className="line-clamp-2 text-lg font-bold leading-tight">{event.name}</span>
                  <span className="text-xs font-medium text-on-scrim/85 first-letter:uppercase">
                    {formatEventDay(event.datetimeUtc, locale)} · {formatEventTime(event.datetimeUtc, locale)}
                  </span>
                </span>
              </Link>
            ))}
          </div>
          {featured.length > 1 && (
            <div className="flex justify-center gap-1.5">
              {featured.map((event, index) => (
                <button
                  key={event.id}
                  type="button"
                  onClick={() => {
                    setPaused(true);
                    goTo(index);
                  }}
                  aria-label={t.showcase.goTo(index + 1)}
                  aria-current={index === active}
                  className={`h-2 rounded-full transition-all ${
                    index === active ? "w-6 bg-primary" : "w-2 bg-tile-soft hover:bg-tile-mid"
                  }`}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-3">
        <h2 className="px-1 text-lg font-bold tracking-tight">{t.showcase.upcoming}</h2>
        {visible.length === 0 && <p className="px-1 text-sm text-muted">{t.showcase.emptySearch}</p>}
        {visible.map((event) => (
          <Link
            key={event.id}
            href={`/e/${event.id}`}
            className="flex items-center gap-3.5 rounded-3xl bg-background p-3 shadow-sm transition-transform active:scale-[0.99]"
          >
            <span className="relative aspect-[4/5] w-16 shrink-0 overflow-hidden rounded-2xl bg-surface">
              <Poster event={event} sizes="64px" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate font-semibold">{event.name}</span>
              <span className="text-xs font-medium text-primary-text first-letter:uppercase">
                {formatEventDay(event.datetimeUtc, locale)} · {formatEventTime(event.datetimeUtc, locale)}
              </span>
              <span className="truncate text-xs text-muted">{event.place}</span>
              <span className="mt-1 flex flex-wrap items-center gap-1.5">
                <span className="rounded-full bg-tile-soft px-2 py-0.5 text-[11px] font-semibold text-tile-soft-foreground">
                  {priceLabel(t, locale, event.minPriceDecimal, event.maxPriceDecimal)}
                </span>
                <span className={`text-[11px] font-medium ${event.seatsLeft > 0 ? "text-muted" : "text-error"}`}>
                  {event.seatsLeft > 0 ? t.showcase.seatsLeft(event.seatsLeft) : t.showcase.soldOut}
                </span>
              </span>
            </span>
            <Icon name="chevron" size={18} className="shrink-0 text-muted-light" />
          </Link>
        ))}
      </div>
    </section>
  );
}
