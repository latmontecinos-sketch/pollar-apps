import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { db, dbReady } from "@/lib/db";
import { formatAmount, formatEventDateTime } from "@/lib/format";
import { stroopsToDecimal } from "@/lib/money";

/**
 * The picture WhatsApp/Telegram/etc. show next to a shared event link.
 * Images can't read CSS variables, so the brand values are spelled out
 * here, mirroring the tokens in app/globals.css (like lib/mail.ts does).
 */
const PRIMARY = "#005db4"; // --primary
const PRIMARY_LIGHT = "#f0f7ff"; // --primary-light
const FOREGROUND = "#1a1a1a"; // --foreground
const MUTED = "#6b7280"; // --muted

export const alt = "Entrada para un evento en Pollar Pass";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

type Row = { name: string; datetime_utc: string; place: string; price_stroops: string };

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await dbReady();
  const result = await db.execute({
    sql: "SELECT name, datetime_utc, place, price_stroops FROM events WHERE id = ?",
    args: [id],
  });
  const event = result.rows[0] as unknown as Row | undefined;
  const logo = await readFile(join(process.cwd(), "public/pollar-logo-dark.svg"), "utf8");
  const logoSrc = `data:image/svg+xml;base64,${Buffer.from(logo).toString("base64")}`;

  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%", background: "white" }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            alignItems: "center",
            width: 300,
            background: PRIMARY,
            padding: "56px 0",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- rendered by ImageResponse, not the browser */}
          <img src={logoSrc} width={150} height={150} alt="" />
          <div style={{ display: "flex", color: "white", fontSize: 34, fontWeight: 700 }}>Pollar Pass</div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            flex: 1,
            padding: "0 72px",
            borderLeft: `6px dashed ${PRIMARY_LIGHT}`,
          }}
        >
          <div style={{ display: "flex", fontSize: 30, color: PRIMARY, fontWeight: 700 }}>
            ENTRADA
          </div>
          <div
            style={{
              display: "flex",
              marginTop: 12,
              fontSize: event && event.name.length > 32 ? 58 : 72,
              fontWeight: 800,
              color: FOREGROUND,
              lineHeight: 1.1,
            }}
          >
            {event?.name ?? "Evento"}
          </div>
          {event && (
            <div style={{ display: "flex", marginTop: 28, fontSize: 34, color: MUTED }}>
              {formatEventDateTime(event.datetime_utc)} · {event.place}
            </div>
          )}
          {event && (
            <div style={{ display: "flex", marginTop: 40 }}>
              <div
                style={{
                  display: "flex",
                  background: PRIMARY_LIGHT,
                  color: PRIMARY,
                  fontSize: 36,
                  fontWeight: 700,
                  padding: "14px 28px",
                  borderRadius: 999,
                }}
              >
                {formatAmount(stroopsToDecimal(BigInt(event.price_stroops)))} USDC · Compra tu entrada
              </div>
            </div>
          )}
        </div>
      </div>
    ),
    size
  );
}
