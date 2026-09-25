/**
 * Where the page and the link preview point for an event's photo. Versioned,
 * so the URL can be cached forever (see the GET in
 * app/api/events/[id]/image/route.ts). Its own module because
 * lib/event-image.ts reaches the database and can't come to the browser.
 */
export function eventImagePath(eventId: string, version: string, accessCode?: string | null): string {
  const code = accessCode ? `&c=${encodeURIComponent(accessCode)}` : "";
  return `/api/events/${encodeURIComponent(eventId)}/image?v=${encodeURIComponent(version)}${code}`;
}
