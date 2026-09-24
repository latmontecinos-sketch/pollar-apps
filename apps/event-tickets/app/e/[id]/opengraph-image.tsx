import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { db, dbReady } from "@/lib/db";
import { loadEventImage } from "@/lib/event-image";
import { formatAmount, formatEventDay, formatEventTime } from "@/lib/format";
import { getDict } from "@/lib/i18n/server";
import { stroopsToDecimal } from "@/lib/money";
import { listTicketTypes, summarize } from "@/lib/ticket-types";

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

export const alt = "Evento en Pollar Pass";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

type Row = { name: string; datetime_utc: string; place: string };

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { locale, t } = await getDict();
  await dbReady();
  const result = await db.execute({
    sql: "SELECT name, datetime_utc, place FROM events WHERE id = ?",
    args: [id],
  });
  const event = result.rows[0] as unknown as Row | undefined;
  // The cheapest tier, as the page's "Desde" says — not the event's legacy price column.
  const types = event ? await listTicketTypes(id) : [];
  const price = formatAmount(stroopsToDecimal(summarize(types).priceStroops), locale);
  const photo = event ? await loadEventImage(id) : null;
  const logo = await readFile(join(process.cwd(), "public/pollar-logo-dark.svg"), "utf8");
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
            <img src={logoSrc} width={170} height={170} alt="" />
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
                {t.tiers.from(price)} · Pollar Pass
              </div>
            </div>
          )}
        </div>
      </div>
    ),
    size
  );
}
