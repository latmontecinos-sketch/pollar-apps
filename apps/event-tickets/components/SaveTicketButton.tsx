"use client";

import { useState } from "react";
import QRCode from "qrcode";
import { Icon } from "@/components/ui/Icon";
import { formatEventDateTime } from "@/lib/format";

/** Reads a design token so the drawn ticket matches the app's theme. */
function token(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

/**
 * Saves the ticket as an image, so it works at the door with no signal
 * (the QR is all the door needs — it's read from the buyer's screen).
 */
export function SaveTicketButton({
  code,
  doorCode,
  eventName,
  eventDateTime,
  eventPlace,
}: {
  code: string;
  doorCode: string;
  eventName: string;
  eventDateTime: string;
  eventPlace: string;
}) {
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const qr = new Image();
      qr.src = await QRCode.toDataURL(code, { width: 520, margin: 1 });
      await qr.decode();

      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 900;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const primary = token("--primary", "#005db4");
      ctx.fillStyle = token("--background", "#ffffff");
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = primary;
      ctx.fillRect(0, 0, canvas.width, 96);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 34px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Pollar Pass", canvas.width / 2, 60);

      ctx.fillStyle = token("--foreground", "#1a1a1a");
      ctx.font = "bold 40px system-ui, sans-serif";
      let y = 170;
      for (const line of wrap(ctx, eventName, canvas.width - 80)) {
        ctx.fillText(line, canvas.width / 2, y);
        y += 48;
      }

      ctx.fillStyle = token("--muted", "#6b7280");
      ctx.font = "24px system-ui, sans-serif";
      ctx.fillText(formatEventDateTime(eventDateTime), canvas.width / 2, y + 10);
      for (const line of wrap(ctx, eventPlace, canvas.width - 80)) {
        y += 34;
        ctx.fillText(line, canvas.width / 2, y + 10);
      }

      ctx.drawImage(qr, (canvas.width - 520) / 2, y + 50, 520, 520);

      ctx.fillStyle = token("--muted", "#6b7280");
      ctx.font = "20px system-ui, sans-serif";
      ctx.fillText("CÓDIGO DE PUERTA", canvas.width / 2, y + 620);
      ctx.fillStyle = token("--foreground", "#1a1a1a");
      ctx.font = "bold 44px ui-monospace, monospace";
      ctx.fillText(doorCode, canvas.width / 2, y + 672);

      const link = document.createElement("a");
      link.download = `entrada-${eventName.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={() => void save()}
      disabled={busy}
      className="flex items-center gap-1.5 text-xs font-semibold text-primary underline disabled:opacity-50"
    >
      <Icon name="share" size={14} />
      {busy ? "Guardando…" : "Guardar entrada como imagen"}
    </button>
  );
}
