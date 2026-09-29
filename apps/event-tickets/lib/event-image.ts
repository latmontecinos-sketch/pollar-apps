import { db, dbReady } from "./db.ts";
import { newId } from "./ids.ts";

/**
 * The event's photo: a 4:5 portrait (1080 × 1350), the shape of a feed post,
 * so the flyers organizers already make fit as they are and fill a phone
 * screen's width without cropping the text off.
 *
 * The browser does the cropping and the JPEG encoding (components/
 * EventImagePicker.tsx); the server only accepts what it can verify from the
 * bytes themselves — a JPEG, of the right shape, not too big — and never
 * decodes or re-encodes it. JPEG only: it's what the canvas exports, what
 * the link-preview renderer can draw, and it can't carry script the way an
 * SVG can.
 *
 * Stored in the database rather than a bucket so the app keeps running from
 * a fresh clone with nothing but the Pollar key.
 */

export const IMAGE_WIDTH = 1080;
export const IMAGE_HEIGHT = 1350;
/** Comfortably above what the picker produces (~150–400 KB), far below a request's limit. */
export const MAX_IMAGE_BYTES = 1_000_000;
const MIN_WIDTH = 320;
const MAX_WIDTH = 2160;
const ASPECT = IMAGE_WIDTH / IMAGE_HEIGHT;

/** Width and height from a JPEG's frame header, or null when these bytes aren't one. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    // Fill bytes, and markers that carry no length.
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    // Image data began, or ended, before any frame header: not a JPEG we can size.
    if (marker === 0xda || marker === 0xd9) return null;
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (length < 2) return null;
    // SOF0–SOF15, minus DHT (C4), JPG (C8) and DAC (CC), which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + length;
  }
  return null;
}

export type ImageCheck =
  | { ok: true; width: number; height: number }
  | { ok: false; code: "image_invalid" | "image_too_large" };

/** What the upload route accepts: a JPEG, 4:5 within 2%, between 320 and 2160 px wide. */
export function checkEventImage(bytes: Uint8Array): ImageCheck {
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, code: "image_too_large" };
  const size = jpegSize(bytes);
  if (!size) return { ok: false, code: "image_invalid" };
  if (size.width < MIN_WIDTH || size.width > MAX_WIDTH) return { ok: false, code: "image_invalid" };
  if (Math.abs(size.width / size.height - ASPECT) > 0.02) return { ok: false, code: "image_invalid" };
  return { ok: true, ...size };
}

/** Replaces the event's photo; the new `version` busts every cached copy of the old one. */
export async function saveEventImage(
  eventId: string,
  bytes: Uint8Array,
  size: { width: number; height: number }
): Promise<string> {
  await dbReady();
  const version = newId().replace(/-/g, "").slice(0, 12);
  await db.execute({
    sql: `INSERT INTO event_images (event_id, data, width, height, bytes, version)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(event_id) DO UPDATE SET
            data = excluded.data, width = excluded.width, height = excluded.height,
            bytes = excluded.bytes, version = excluded.version, updated_at = datetime('now')`,
    args: [eventId, bytes, size.width, size.height, bytes.length, version],
  });
  return version;
}

export async function deleteEventImage(eventId: string): Promise<void> {
  await dbReady();
  await db.execute({ sql: "DELETE FROM event_images WHERE event_id = ?", args: [eventId] });
}

/** Just the version, for building the image URL without reading the bytes. */
export async function eventImageVersion(eventId: string): Promise<string | null> {
  await dbReady();
  const result = await db.execute({
    sql: "SELECT version FROM event_images WHERE event_id = ?",
    args: [eventId],
  });
  return result.rows.length > 0 ? String(result.rows[0].version) : null;
}

export async function loadEventImage(
  eventId: string
): Promise<{ data: Uint8Array; version: string } | null> {
  await dbReady();
  const result = await db.execute({
    sql: "SELECT data, version FROM event_images WHERE event_id = ?",
    args: [eventId],
  });
  if (result.rows.length === 0) return null;
  const data = result.rows[0].data as ArrayBuffer | Uint8Array;
  return {
    data: data instanceof Uint8Array ? data : new Uint8Array(data),
    version: String(result.rows[0].version),
  };
}
