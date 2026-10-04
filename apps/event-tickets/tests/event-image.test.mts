/**
 * The event photo upload (lib/event-image.ts). The server never decodes the
 * image, so what it trusts is exactly what these check: that the bytes are a
 * JPEG, of the 4:5 shape the pages are laid out for, and not too big — and
 * that what goes into the database comes back byte for byte.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { after, before, test } from "node:test";

const DB_FILE = `test-event-image-${randomUUID()}.db`;
process.env.DATABASE_URL = `file:./${DB_FILE}`;
delete process.env.DATABASE_AUTH_TOKEN;

const { db, dbReady } = await import("../lib/db.ts");
const {
  MAX_IMAGE_BYTES,
  checkEventImage,
  deleteEventImage,
  eventImageVersion,
  jpegSize,
  loadEventImage,
  saveEventImage,
  wellFormedJpegSize,
} = await import("../lib/event-image.ts");

before(async () => {
  await dbReady();
});

after(() => {
  db.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    try {
      rmSync(`${DB_FILE}${suffix}`, { force: true });
    } catch {
      /* a leftover file is gitignored and harmless */
    }
  }
});

/**
 * The skeleton of a baseline JPEG: SOI, APP0, DQT, SOF, DHT, SOS, some
 * "compressed" bytes, EOI. Not decodable, but structurally what
 * `wellFormedJpegSize` walks. `tables: false` leaves out DQT and DHT;
 * `data` is how many entropy bytes sit between SOS and EOI (default: just
 * enough for the size claimed).
 */
function jpeg(
  width: number,
  height: number,
  { sof = 0xc0, padTo = 0, tables = true, data = Math.ceil((width * height) / 2000) + 8 } = {}
): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sofSegment = [
    0xff, sof, 0x00, 0x11, 0x08,
    height >> 8, height & 0xff, width >> 8, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ];
  const sos = [0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00];
  const dqt = [0xff, 0xdb, 0x00, 0x43, 0x00, ...new Array(64).fill(8)];
  const dht = [0xff, 0xc4, 0x00, 0x14, 0x00, ...new Array(16).fill(0).map((_, k) => (k === 0 ? 1 : 0)), 0x00];
  const bytes = [
    0xff, 0xd8, ...app0, ...(tables ? dqt : []), ...sofSegment, ...(tables ? dht : []), ...sos,
    ...new Array(data).fill(0x55),
  ];
  while (bytes.length < padTo - 2) bytes.push(0x55);
  return Uint8Array.from([...bytes, 0xff, 0xd9]);
}

test("reads the size from baseline and progressive JPEGs", () => {
  assert.deepEqual(jpegSize(jpeg(1080, 1350)), { width: 1080, height: 1350 });
  assert.deepEqual(jpegSize(jpeg(800, 1000, { sof: 0xc2 })), { width: 800, height: 1000 });
});

test("a JPEG from a real encoder passes the structure walk; it is refused only for its shape", () => {
  // tests/fixtures/pollar.jpg: a real 400 x 400 photo (10 KB), not a skeleton.
  const real = new Uint8Array(readFileSync(new URL("./fixtures/pollar.jpg", import.meta.url)));
  assert.deepEqual(jpegSize(real), { width: 400, height: 400 });
  assert.deepEqual(wellFormedJpegSize(real), { width: 400, height: 400 });
  // Square, and the pages are laid out for 4:5: refused for that and nothing else.
  assert.deepEqual(checkEventImage(real), { ok: false, code: "image_invalid" });
  // Cut anywhere short of its end, it is no longer well formed.
  assert.equal(wellFormedJpegSize(real.slice(0, real.length - 2)), null);
  assert.equal(wellFormedJpegSize(real.slice(0, Math.floor(real.length / 2))), null);
});

test("the picker's output is accepted", () => {
  assert.deepEqual(checkEventImage(jpeg(1080, 1350)), { ok: true, width: 1080, height: 1350 });
});

test("anything that isn't a JPEG is refused — an SVG above all", () => {
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  for (const bytes of [svg, png, new Uint8Array(0), Uint8Array.from([0xff, 0xd8])]) {
    assert.deepEqual(checkEventImage(bytes), { ok: false, code: "image_invalid" });
  }
});

test("a forged header with nothing behind it is refused", () => {
  const real = jpeg(1080, 1350);
  const invalid = { ok: false, code: "image_invalid" };
  // The frame header claims 1080 x 1350; no image data follows it.
  assert.deepEqual(checkEventImage(jpeg(1080, 1350, { data: 0 })), invalid);
  // No quantisation or Huffman tables: nothing could decode it.
  assert.deepEqual(checkEventImage(jpeg(1080, 1350, { tables: false })), invalid);
  // Cut short: the end-of-image marker is missing.
  assert.deepEqual(checkEventImage(real.slice(0, real.length - 2)), invalid);
  // Something appended after the end of the image.
  assert.deepEqual(checkEventImage(Uint8Array.from([...real, 0x00, 0x01, 0x02])), invalid);
  // A stray marker inside the data, which no decoder would take as image data.
  const withGarbage = Uint8Array.from(real);
  withGarbage[withGarbage.length - 10] = 0xff;
  withGarbage[withGarbage.length - 9] = 0x12;
  assert.deepEqual(checkEventImage(withGarbage), invalid);
  // A frame header whose length doesn't match its component count.
  const badFrame = Uint8Array.from(real);
  const sofAt = badFrame.findIndex((b, k) => b === 0xff && badFrame[k + 1] === 0xc0);
  badFrame[sofAt + 3] = 0x0b;
  assert.deepEqual(checkEventImage(badFrame), invalid);
  // And the genuine skeleton still passes.
  assert.equal(checkEventImage(real).ok, true);
});

test("a JPEG in the wrong shape is refused: the pages are laid out for 4:5", () => {
  for (const [w, h] of [[1920, 1080], [1080, 1080], [1080, 1920]]) {
    assert.deepEqual(checkEventImage(jpeg(w, h)), { ok: false, code: "image_invalid" }, `${w}×${h}`);
  }
  // Rounding from a crop lands a pixel or two off 4:5, and that's fine.
  assert.equal(checkEventImage(jpeg(1080, 1351)).ok, true);
});

test("too small to look right, or too large to be a phone photo, is refused", () => {
  assert.equal(checkEventImage(jpeg(240, 300)).ok, false);
  assert.equal(checkEventImage(jpeg(4000, 5000)).ok, false);
});

test("more than the byte ceiling is refused before anything else is read", () => {
  assert.deepEqual(checkEventImage(jpeg(1080, 1350, { padTo: MAX_IMAGE_BYTES + 1 })), {
    ok: false,
    code: "image_too_large",
  });
});

test("saved, replaced and deleted: the bytes come back exact, and each save gets a new version", async () => {
  const eventId = randomUUID();
  await db.execute({
    sql: `INSERT INTO events (id, organizer_pollar_id, name, datetime_utc, place, price_stroops, capacity)
          VALUES (?, 'GORG', 'Test', datetime('now'), 'La Paz', 10000000, 10)`,
    args: [eventId],
  });

  const first = jpeg(1080, 1350, { padTo: 4000 });
  const v1 = await saveEventImage(eventId, first, { width: 1080, height: 1350 });
  const loaded = await loadEventImage(eventId);
  assert.ok(loaded);
  assert.deepEqual(Array.from(loaded.data), Array.from(first));
  assert.equal(loaded.version, v1);

  const v2 = await saveEventImage(eventId, jpeg(800, 1000), { width: 800, height: 1000 });
  assert.notEqual(v2, v1, "a replaced photo needs a new URL, or caches keep the old one");
  assert.equal(await eventImageVersion(eventId), v2);

  await deleteEventImage(eventId);
  assert.equal(await loadEventImage(eventId), null);
  assert.equal(await eventImageVersion(eventId), null);
});
