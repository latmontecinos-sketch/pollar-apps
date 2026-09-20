import QRCode from "qrcode";

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
export async function GET(_request: Request, ctx: Ctx) {
  const { code } = await ctx.params;
  if (!/^[A-Z0-9]{8,64}$/.test(code)) {
    return new Response("Not found", { status: 404 });
  }

  const png = await QRCode.toBuffer(code, { width: 520, margin: 1 });
  return new Response(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Robots-Tag": "noindex",
    },
  });
}
