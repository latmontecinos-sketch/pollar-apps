/**
 * Links that take an event out of the app: the place on a map, the date in a
 * calendar. Pure and dependency free (rule 10); the tests run it directly.
 *
 * The place is free text the organizer typed, so it only ever travels as a
 * search query, URL-encoded: nothing here builds a path or a host from it.
 */

/** What the links need of an event. */
export type LinkableEvent = {
  id: string;
  name: string;
  description?: string | null;
  place: string;
  city?: string | null;
  datetimeUtc: string;
  doorsOpenUtc?: string | null;
};

/** The event has no end time; calendars get a block this long. */
export const DEFAULT_EVENT_DURATION_MS = 3 * 60 * 60 * 1000;

/** "Café Mirador" + "La Paz" gives "Café Mirador, La Paz"; the city isn't repeated when the place already says it. */
function mapQuery(place: string, city?: string | null): string {
  const p = place.trim();
  const c = city?.trim() ?? "";
  if (!c) return p;
  return p.toLocaleLowerCase().includes(c.toLocaleLowerCase()) ? p : `${p}, ${c}`;
}

/** Search links for Google Maps, Apple Maps and Waze. */
export function mapsLinks(place: string, city?: string | null): { google: string; apple: string; waze: string } {
  const q = encodeURIComponent(mapQuery(place, city));
  return {
    google: `https://www.google.com/maps/search/?api=1&query=${q}`,
    apple: `https://maps.apple.com/?q=${q}`,
    waze: `https://waze.com/ul?q=${q}&navigate=yes`,
  };
}

/** 2026-10-24T23:30:00.000Z becomes "20261024T233000Z" (the calendar formats' UTC basic form). */
export function icsUtc(instant: Date): string {
  return instant.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function validStart(event: LinkableEvent): Date | null {
  const start = new Date(event.datetimeUtc);
  return Number.isNaN(start.getTime()) ? null : start;
}

/** The text a calendar entry carries: the description, then the doors line (already in the reader's language). */
function details(event: LinkableEvent, doorsLine?: string | null): string {
  return [event.description?.trim(), doorsLine?.trim()].filter(Boolean).join("\n\n");
}

/** "Add to Google Calendar". Null when the event's date can't be read. */
export function googleCalendarUrl(event: LinkableEvent, doorsLine?: string | null): string | null {
  const start = validStart(event);
  if (!start) return null;
  const end = new Date(start.getTime() + DEFAULT_EVENT_DURATION_MS);
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.name,
    dates: `${icsUtc(start)}/${icsUtc(end)}`,
    location: mapQuery(event.place, event.city),
  });
  const text = details(event, doorsLine);
  if (text) params.set("details", text);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** RFC 5545 section 3.3.11: backslash, semicolon, comma and line breaks are escaped in TEXT values. */
export function escapeIcsText(value: string): string {
  return (
    value
      .replace(/\r\n|\r|\n/g, "\n")
      // Other control characters have no place in a calendar entry.
       
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\n/g, "\\n")
  );
}

/** RFC 5545 section 3.1: content lines fold at 75 octets (never inside a UTF-8 character); continuation lines start with a space. */
export function foldIcsLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let bytes = 0;
  // The first line holds 75 octets, each continuation 74 (the leading space counts).
  let limit = 75;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (bytes + size > limit) {
      parts.push(current);
      current = "";
      bytes = 0;
      limit = 74;
    }
    current += char;
    bytes += size;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

export type IcsOptions = {
  /** DTSTAMP; the moment the file was made. Injected so a test gets the same bytes twice. */
  now?: Date;
  /** "Puertas: 19:00", in the reader's language; goes into DESCRIPTION after the event's own text. */
  doorsLine?: string | null;
  /** Link back to the event page. Never carries an access code. */
  url?: string | null;
};

/** The stable id of an event in any calendar: importing the file twice updates the entry instead of duplicating it. */
export function icsUid(eventId: string): string {
  return `${eventId}@pollar-pass`;
}

/** A VCALENDAR with one VEVENT, CRLF-terminated lines. Null when the event's date can't be read. */
export function buildIcs(event: LinkableEvent, options: IcsOptions = {}): string | null {
  const start = validStart(event);
  if (!start) return null;
  const end = new Date(start.getTime() + DEFAULT_EVENT_DURATION_MS);
  const text = details(event, options.doorsLine);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Pollar Pass//Event tickets//ES",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${icsUid(event.id)}`,
    `DTSTAMP:${icsUtc(options.now ?? new Date())}`,
    `DTSTART:${icsUtc(start)}`,
    `DTEND:${icsUtc(end)}`,
    `SUMMARY:${escapeIcsText(event.name)}`,
    `LOCATION:${escapeIcsText(mapQuery(event.place, event.city))}`,
  ];
  if (text) lines.push(`DESCRIPTION:${escapeIcsText(text)}`);
  if (options.url) lines.push(`URL:${options.url.replace(/[\r\n]/g, "")}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}
