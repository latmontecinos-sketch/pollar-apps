"use client";

import { Icon } from "@/components/ui/Icon";
import { buildIcs, googleCalendarUrl, type LinkableEvent } from "@/lib/event-links";
import { formatEventTime } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n/client";

/**
 * "Add to calendar" for a ticket someone already holds: a Google Calendar link and an .ics
 * file, both built here from the event's own data (lib/event-links.ts). Nothing is fetched,
 * so it works for a private event too: the holder already has what the file would say, and
 * the file carries no access code.
 */
export function CalendarLinks({ event }: { event: LinkableEvent }) {
  const t = useT();
  const locale = useLocale();
  const doorsLine = event.doorsOpenUtc ? t.event.doorsOpen(formatEventTime(event.doorsOpenUtc, locale)) : null;
  const google = googleCalendarUrl(event, doorsLine);
  const ics = buildIcs(event, { doorsLine });
  if (!google && !ics) return null;
  const link =
    "inline-flex min-h-11 items-center gap-1.5 rounded-full bg-background px-4 text-sm font-semibold text-primary-text ring-1 ring-foreground/15 transition-colors hover:bg-surface-hover";
  return (
    <div role="group" aria-label={t.event.addToCalendar} className="flex flex-wrap justify-center gap-2">
      {google && (
        <a href={google} target="_blank" rel="noopener noreferrer" className={link}>
          <Icon name="calendar" size={15} /> {t.event.googleCalendar}
        </a>
      )}
      {ics && (
        <a href={`data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`} download="evento.ics" className={link}>
          <Icon name="share" size={15} /> {t.event.downloadIcs}
        </a>
      )}
    </div>
  );
}
