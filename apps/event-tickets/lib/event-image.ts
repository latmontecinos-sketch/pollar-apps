import { parseAccent } from "./accent.ts";
import { db, dbReady, withTransaction } from "./db.ts";
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

/**
 * Fewest bytes of compressed image data a real photo of this size can have.
 * A flat, single-colour frame still spends a few bits on every 8×8 block (a
 * zero DC difference plus an end-of-block), which for 4:2:0 is ~12 KB at
 * 1080 × 1350; this asks for a sixth of that, so only a header with nothing
 * behind it — what someone forges to pass the size check — falls short.
 */
const MIN_BYTES_PER_PIXEL = 1 / 2000;

/**
 * The size from a JPEG that is well formed *as far as it can be told without
 * decoding it* (no dependency: rule 10), or null. Where {@link jpegSize} only
 * reads the first frame header it meets, this walks the whole file:
 *
 * - every marker segment is in bounds, and the frame header is coherent
 *   (8-bit samples, 1, 3 or 4 components, a length that matches them);
 * - quantisation and Huffman tables are present before the first scan, and
 *   every scan lists exactly the frame's components;
 * - the compressed data is made of bytes and legal markers only (an `FF`
 *   is followed by `00`, a restart or a segment — never by garbage);
 * - it ends with exactly one end-of-image marker, with enough data in front
 *   of it for the size the header claims.
 *
 * Honest limit: this never decodes the entropy-coded data (Huffman symbols,
 * restart intervals, run lengths), so it cannot prove the picture decodes.
 * Bytes that are structurally clean but not a real image still pass, and the
 * viewer's browser shows a broken photo. That costs the person who uploaded
 * it (an organizer, for their own event) and nobody else: the response is
 * served as `image/jpeg` with `Content-Disposition: inline`, and a JPEG
 * cannot carry script. Telling a real image from a forged one would need a
 * real decoder (sharp, jpeg-js), which rule 10 asks us not to pull in for
 * this. tests/event-image.test.mts runs a JPEG from a real encoder through
 * it, so the walk is checked against what a camera or canvas produces and
 * not only against the skeletons the tests build by hand.
 */
export function wellFormedJpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  const n = bytes.length;
  if (n < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[n - 2] !== 0xff || bytes[n - 1] !== 0xd9) {
    return null;
  }
  let i = 2;
  let size: { width: number; height: number } | null = null;
  let components = 0;
  let sawDqt = false;
  let sawDht = false;
  let scans = 0;
  let entropyBytes = 0;

  while (i < n) {
    // A segment: FF, marker, big-endian length that counts itself.
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0xd9) {
      // The end of the image has to be the end of the file, and something has to precede it.
      const enough = size !== null && entropyBytes >= size.width * size.height * MIN_BYTES_PER_PIXEL;
      return i + 2 === n && scans > 0 && enough ? size : null;
    }
    if (marker === 0x00 || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) return null;
    if (i + 4 > n) return null;
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (length < 2 || i + 2 + length > n) return null;
    const body = i + 4;

    if (marker === 0xdb) sawDqt = true;
    if (marker === 0xc4) sawDht = true;
    if (marker === 0xdd && length !== 4) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (size || length < 8) return null;
      components = bytes[body + 5];
      const height = (bytes[body + 1] << 8) | bytes[body + 2];
      const width = (bytes[body + 3] << 8) | bytes[body + 4];
      if (bytes[body] !== 8 || ![1, 3, 4].includes(components) || length !== 8 + 3 * components) return null;
      if (width === 0 || height === 0) return null;
      for (let c = 0; c < components; c++) {
        const sampling = bytes[body + 7 + 3 * c];
        if (sampling >> 4 === 0 || (sampling & 0x0f) === 0) return null;
      }
      size = { width, height };
    }
    if (marker === 0xda) {
      // A scan needs the frame, the tables, and its own component list to add up.
      if (!size || !sawDqt || !sawDht) return null;
      const inScan = bytes[body];
      if (inScan < 1 || inScan > components || length !== 6 + 2 * inScan) return null;
      scans++;
      i += 2 + length;
      // Entropy-coded data: runs until a marker that is not a stuffed 00 or a restart.
      const dataStart = i;
      while (i < n) {
        if (bytes[i] !== 0xff) {
          i += 1;
          continue;
        }
        const next = bytes[i + 1];
        if (next === undefined) return null;
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          i += 2; // a stuffed FF, or a restart marker
          continue;
        }
        break; // a real marker: the next segment, or the end
      }
      entropyBytes += i - dataStart;
      continue;
    }
    i += 2 + length;
  }
  return null;
}

export type ImageCheck =
  | { ok: true; width: number; height: number }
  | { ok: false; code: "image_invalid" | "image_too_large" };

/** What the upload route accepts: a well-formed JPEG, 4:5 within 2%, between 320 and 2160 px wide. */
export function checkEventImage(bytes: Uint8Array): ImageCheck {
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, code: "image_too_large" };
  const size = wellFormedJpegSize(bytes);
  if (!size) return { ok: false, code: "image_invalid" };
  if (size.width < MIN_WIDTH || size.width > MAX_WIDTH) return { ok: false, code: "image_invalid" };
  if (Math.abs(size.width / size.height - ASPECT) > 0.02) return { ok: false, code: "image_invalid" };
  return { ok: true, ...size };
}

/**
 * Replaces the event's photo; the new `version` busts every cached copy of the
 * old one. The photo's accent colour (lib/accent.ts) goes in the same
 * transaction, so a page never shows a new photo with the old one's colour:
 * a missing or malformed `accent` clears it (the UI then uses its tokens).
 */
export async function saveEventImage(
  eventId: string,
  bytes: Uint8Array,
  size: { width: number; height: number },
  accent?: unknown
): Promise<string> {
  const version = newId().replace(/-/g, "").slice(0, 12);
  await withTransaction(async (tx) => {
    await tx.execute({
      sql: `INSERT INTO event_images (event_id, data, width, height, bytes, version)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(event_id) DO UPDATE SET
              data = excluded.data, width = excluded.width, height = excluded.height,
              bytes = excluded.bytes, version = excluded.version, updated_at = datetime('now')`,
      args: [eventId, bytes, size.width, size.height, bytes.length, version],
    });
    await tx.execute({
      sql: "UPDATE events SET accent = ? WHERE id = ?",
      args: [parseAccent(accent), eventId],
    });
  });
  return version;
}

export async function deleteEventImage(eventId: string): Promise<void> {
  await withTransaction(async (tx) => {
    await tx.execute({ sql: "DELETE FROM event_images WHERE event_id = ?", args: [eventId] });
    // No photo, no accent.
    await tx.execute({ sql: "UPDATE events SET accent = NULL WHERE id = ?", args: [eventId] });
  });
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
