import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { db, dbReady } from "@/lib/db";
import { loadEventImage } from "@/lib/event-image";
import { formatEventDay, formatEventTime } from "@/lib/format";
import { getDict } from "@/lib/i18n/server";
import { priceLabel, priceRange } from "@/lib/price-label";
import { listTicketTypes } from "@/lib/ticket-types";
import { canView } from "@/lib/visibility";

/**
 * The picture WhatsApp/Telegram/etc. show next to a shared event link. With
 * a photo, the organizer's 4:5 poster fills the left and the facts sit
 * beside it; without one, the brand band takes its place.
 *
 * Images can't read CSS variables, so the brand values are spelled out
 * here, mirroring the tokens in app/globals.css (like lib/mail.ts does).
 */
const PRIMARY = "#005db4"; // --primary / --band
const TILE_SOFT = "#d3e5f7"; // --tile-soft
const SHEET = "#f2f7fc"; // --sheet
const FOREGROUND = "#1a1a1a"; // --foreground
const MUTED = "#6b7280"; // --muted
const TICKET = "#ffb020"; // --ticket (the wordmark's "Pass", 3.6:1 on the band: large bold text)

export const alt = "Evento en Pollar Pass";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

type Row = {
  name: string;
  datetime_utc: string;
  place: string;
  visibility: string;
  access_code: string | null;
};

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { locale, t } = await getDict();
  await dbReady();
  const result = await db.execute({
    sql: "SELECT name, datetime_utc, place, visibility, access_code FROM events WHERE id = ?",
    args: [id],
  });
  const row = result.rows[0] as unknown as Row | undefined;
  // Same rule as the page: a private event needs its code, and a link preview
  // is fetched with no way to carry one (this route gets no query string), so a
  // private event — or one that doesn't exist — gets the generic Pollar Pass
  // card: no name, date, place, price or photo.
  const event = row && canView(row, null) ? row : undefined;
  // The same phrase as the page's price pill ("Desde 0,05 USDC", "Gratis"), from
  // the tiers — never "Desde 0,00 USDC", never the event's legacy price column.
  const types = event ? await listTicketTypes(id) : [];
  const range = priceRange(types);
  const price = priceLabel(t, locale, range.minDecimal, range.maxDecimal);
  const photo = event ? await loadEventImage(id) : null;
  const logo = await readFile(join(process.cwd(), "public/pollar-pass-mark-on-band.svg"), "utf8");
  const logoSrc = `data:image/svg+xml;base64,${Buffer.from(logo).toString("base64")}`;
  const name = event?.name ?? "Pollar Pass";

  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%", background: SHEET }}>
        {photo ? (
          // eslint-disable-next-line @next/next/no-img-element -- rendered by ImageResponse, not the browser
          <img
            src={`data:image/jpeg;base64,${Buffer.from(photo.data).toString("base64")}`}
            width={504}
            height={630}
            alt=""
            style={{ objectFit: "cover" }}
          />
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              alignItems: "center",
              width: 360,
              background: PRIMARY,
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- rendered by ImageResponse, not the browser */}
            <img src={logoSrc} width={210} height={210} alt="" />
            <div style={{ display: "flex", marginTop: 14, fontSize: 46, fontWeight: 800, color: "#ffffff" }}>
              Pollar&nbsp;<span style={{ color: TICKET }}>Pass</span>
            </div>
          </div>
        )}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            flex: 1,
            padding: "0 64px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", fontSize: 26, fontWeight: 700, color: PRIMARY }}>
            {photo && (
              // eslint-disable-next-line @next/next/no-img-element -- rendered by ImageResponse, not the browser
              <img
                src={logoSrc}
                width={40}
                height={40}
                alt=""
                style={{ marginRight: 12, background: PRIMARY, borderRadius: 10, padding: 6 }}
              />
            )}
            {t.meta.ogCta.toUpperCase()}
          </div>
          <div
            style={{
              display: "flex",
              marginTop: 14,
              fontSize: name.length > 40 ? 50 : name.length > 24 ? 60 : 70,
              fontWeight: 800,
              color: FOREGROUND,
              lineHeight: 1.08,
            }}
          >
            {name}
          </div>
          {event && (
            <div style={{ display: "flex", flexDirection: "column", marginTop: 26, fontSize: 32, color: MUTED }}>
              <div style={{ display: "flex" }}>
                {formatEventDay(event.datetime_utc, locale)} · {formatEventTime(event.datetime_utc, locale)}
              </div>
              <div style={{ display: "flex", marginTop: 6 }}>{event.place}</div>
            </div>
          )}
          {event && types.length > 0 && (
            <div style={{ display: "flex", marginTop: 34 }}>
              <div
                style={{
                  display: "flex",
                  background: TILE_SOFT,
                  color: PRIMARY,
                  fontSize: 32,
                  fontWeight: 700,
                  padding: "12px 28px",
                  borderRadius: 999,
                }}
              >
                {price}
              </div>
            </div>
          )}
        </div>
      </div>
    ),
    size
  );
}
