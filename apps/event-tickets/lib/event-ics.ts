import { db, dbReady } from "./db.ts";
import { buildIcs } from "./event-links.ts";
import { canView } from "./visibility.ts";

export type EventIcs =
  | { ok: true; body: string; filename: string; isPrivate: boolean }
  /** No such event, a private one asked for without its code, or a date that can't be read: all the same answer, so nothing leaks. */
  | { ok: false };

/** ASCII-only file name from the event's name ("Noche de jazz" becomes "noche-de-jazz.ics"). */
export function icsFilename(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `${slug || "evento"}.ics`;
}

/**
 * The calendar file of an event, for whoever may see the event (`canView`):
 * a public or link-only event always, a private one only with its access
 * code. Without it nothing about the event is returned, not even its name.
 *
 * Read only. The route around it owns the wrong-code quota, as for the photo.
 */
export async function loadEventIcs(
  id: string,
  offeredCode: unknown,
  options: {
    /** The doors line in the reader's language, from the doors instant. */
    doorsLine?: (doorsOpenUtc: string) => string;
    /** The event page, without any code. */
    url?: string | null;
    now?: Date;
  } = {}
): Promise<EventIcs> {
  await dbReady();
  const result = await db.execute({
    sql: `SELECT id, name, description, place, city, datetime_utc, doors_open_utc, visibility, access_code
          FROM events WHERE id = ?`,
    args: [id],
  });
  if (result.rows.length === 0) return { ok: false };
  const row = result.rows[0] as unknown as {
    id: string;
    name: string;
    description: string;
    place: string;
    city: string | null;
    datetime_utc: string;
    doors_open_utc: string | null;
    visibility: string;
    access_code: string | null;
  };
  if (!canView(row, offeredCode)) return { ok: false };
  const body = buildIcs(
    {
      id: row.id,
      name: row.name,
      description: row.description,
      place: row.place,
      city: row.city,
      datetimeUtc: row.datetime_utc,
      doorsOpenUtc: row.doors_open_utc,
    },
    {
      now: options.now,
      url: options.url,
      doorsLine: row.doors_open_utc && options.doorsLine ? options.doorsLine(row.doors_open_utc) : null,
    }
  );
  if (!body) return { ok: false };
  return { ok: true, body, filename: icsFilename(row.name), isPrivate: row.visibility === "private" };
}
