import QRCode from "qrcode";
import { clientIp, consume, tooManyRequests } from "@/lib/rate-limit";

type Ctx = { params: Promise<{ code: string }> };

/**
 * The ticket's QR as a real PNG over HTTPS. Email clients (Gmail above
 * all) refuse to render `data:` images, so the ticket email points here
 * instead of embedding the QR inline.
 *
 * The URL contains the ticket code, which is the ticket: whoever holds it
 * can already check in, so this exposes nothing new. It stays out of search
 * engines and caches per-code.
 */
export async function GET(request: Request, ctx: Ctx) {
  const { code } = await ctx.params;
  if (!/^[A-Z0-9]{8,64}$/.test(code)) {
    return new Response("Not found", { status: 404 });
  }

  // The only route here with no login at all, and it renders an image for
  // whatever string you pass. A mail client fetches it once or twice; a
  // script would happily spend our CPU all day.
  const allowed = await consume("ticketQr", clientIp(request));
  if (!allowed.ok) return tooManyRequests(allowed);

  const png = await QRCode.toBuffer(code, { width: 520, margin: 1 });
  return new Response(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      // `private`: the URL *is* the ticket, so it belongs in the reader's
      // own cache and never in a shared proxy's.
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Robots-Tag": "noindex",
    },
  });
}
