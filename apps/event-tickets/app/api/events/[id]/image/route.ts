import { NextResponse } from "next/server";
import { ACCENT_HEADER } from "@/lib/accent";
import { requireAddress } from "@/lib/auth";
import { db, dbReady } from "@/lib/db";
import { organizerOf } from "@/lib/event-owner";
import {
  checkEventImage,
  deleteEventImage,
  loadEventImage,
  MAX_IMAGE_BYTES,
  saveEventImage,
} from "@/lib/event-image";
import { clientIp, consume, enforce, isOverLimit, tooManyRequests } from "@/lib/rate-limit";
import { shortAddressForLog } from "@/lib/security-log";
import { canView, normalizeAccessCode } from "@/lib/visibility";

type Ctx = { params: Promise<{ id: string }> };

const notFound = () =>
  NextResponse.json({ error: "No encontrado", code: "event_not_found" }, { status: 404 });

/**
 * Public, like the event page it illustrates. Asked for with the current
 * `?v=`, the bytes can never change under that URL, so browsers and the CDN
 * keep them for a year; anything else gets a short cache.
 */
export async function GET(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const params = new URL(request.url).searchParams;
  // A private event's photo is part of the event: same code as its page.
  await dbReady();
  const gate = await db.execute({ sql: "SELECT visibility, access_code FROM events WHERE id = ?", args: [id] });
  if (gate.rows.length === 0) return new Response(null, { status: 404 });
  const event = gate.rows[0] as unknown as { visibility: string; access_code: string | null };
  // Same ceiling as the page's code form, per IP and event (lib/rate-limit.ts):
  // this URL takes the code too, so it would otherwise be a way around it. Only
  // a wrong code counts; every viewer of a private event loads this with the
  // right one.
  if (event.visibility === "private" && normalizeAccessCode(params.get("c"))) {
    const subject = `${clientIp(request)}:${id}`;
    const over = await isOverLimit("accessCode", subject);
    if (!over.ok) return tooManyRequests(over);
    if (!canView(event, params.get("c"))) {
      await consume("accessCode", subject);
      return new Response(null, { status: 404 });
    }
  }
  if (!canView(event, params.get("c"))) return new Response(null, { status: 404 });
  const image = await loadEventImage(id);
  if (!image) return new Response(null, { status: 404 });
  const pinned = params.get("v") === image.version;
  return new Response(Buffer.from(image.data), {
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(image.data.length),
      // A private photo stays out of shared caches: the code in its URL is the only key.
      "Cache-Control": event.visibility === "private"
        ? "private, max-age=3600"
        : pinned
        ? "public, max-age=31536000, immutable"
        : "public, max-age=60, s-maxage=300",
      // The bytes were only checked to be a JPEG; nothing here should render as anything else.
      "Content-Disposition": "inline",
    },
  });
}

/** Owner-only: replaces the photo with the raw JPEG in the body (already cropped by the browser). */
export async function PUT(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const organizer = await organizerOf(id);
  if (!organizer) return notFound();
  const auth = requireAddress(request, organizer);
  if (!auth.ok) return auth.response;

  const limited = await enforce("eventImage", auth.address, { actor: shortAddressForLog(auth.address) });
  if (limited) return limited;

  // Refuse an oversized body from its header, before reading a byte of it.
  if (Number(request.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: "La imagen pesa demasiado", code: "image_too_large" }, { status: 413 });
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  const checked = checkEventImage(bytes);
  if (!checked.ok) {
    return NextResponse.json(
      {
        error: checked.code === "image_too_large" ? "La imagen pesa demasiado" : "La imagen no es un JPEG 4:5 válido",
        code: checked.code,
      },
      { status: checked.code === "image_too_large" ? 413 : 400 }
    );
  }

  // The browser reads a representative colour off the framed photo and sends it along
  // (components/EventImagePicker.tsx). It ends up in CSS, so only `#rrggbb` is kept.
  const version = await saveEventImage(id, bytes, checked, request.headers.get(ACCENT_HEADER));
  return NextResponse.json({ version });
}

/** Owner-only: removes the photo; the page falls back to its text-only look. */
export async function DELETE(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const organizer = await organizerOf(id);
  if (!organizer) return notFound();
  const auth = requireAddress(request, organizer);
  if (!auth.ok) return auth.response;

  const limited = await enforce("eventImage", auth.address, { actor: shortAddressForLog(auth.address) });
  if (limited) return limited;

  await deleteEventImage(id);
  return NextResponse.json({ version: null });
}
