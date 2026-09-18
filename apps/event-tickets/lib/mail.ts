import QRCode from "qrcode";
import { formatEventDateTime } from "@/lib/format";

const RESEND_API_URL = "https://api.resend.com/emails";
const PRIMARY = "#005db4";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function ticketEmailHtml(opts: {
  eventName: string;
  eventDateTime: string;
  eventPlace: string;
  doorCode: string;
  qrDataUrl: string;
}): string {
  const name = escapeHtml(opts.eventName);
  const place = escapeHtml(opts.eventPlace);
  const when = escapeHtml(formatEventDateTime(opts.eventDateTime));
  return `
<div style="background:#f4f6f8;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:420px;margin:0 auto;">
    <p style="text-align:center;margin:0 0 20px;font-size:15px;font-weight:800;color:${PRIMARY};letter-spacing:0.2px;">
      Pollar Pass
    </p>
    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:20px;padding:28px 24px;text-align:center;">
      <p style="margin:0;font-size:13px;color:#6b7280;">Tu pase para</p>
      <h1 style="margin:4px 0 14px;font-size:21px;line-height:1.3;color:#111827;">${name}</h1>
      <p style="margin:0 0 20px;font-size:13px;color:#6b7280;">${when} · ${place}</p>
      <img src="${opts.qrDataUrl}" width="200" height="200" alt="QR del pase" style="display:block;margin:0 auto;border-radius:12px;" />
      <p style="margin:20px 0 2px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.6px;">Código de puerta</p>
      <p style="margin:0;font-size:24px;font-weight:700;letter-spacing:3px;font-family:'SFMono-Regular',Consolas,Menlo,monospace;color:#111827;">${escapeHtml(opts.doorCode)}</p>
    </div>
    <p style="text-align:center;margin:18px 0 0;font-size:12px;color:#9ca3af;">
      Mostrá el código QR (o decí el código de puerta) en la entrada del evento.
    </p>
  </div>
</div>`.trim();
}

/**
 * Plain `fetch` to Resend's REST API — no SDK dependency needed for one
 * transactional email. Best-effort: a failed send never blocks or reverses
 * the purchase, since the buyer's ticket already lives in their own account
 * (this is a convenience copy, not the source of truth).
 */
export async function sendTicketEmail(opts: {
  to: string;
  eventName: string;
  eventDateTime: string;
  eventPlace: string;
  ticketCode: string;
  doorCode: string;
}): Promise<{ sent: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, error: "RESEND_API_KEY no está configurada" };

  try {
    const qrDataUrl = await QRCode.toDataURL(opts.ticketCode, { width: 200, margin: 1 });
    const html = ticketEmailHtml({
      eventName: opts.eventName,
      eventDateTime: opts.eventDateTime,
      eventPlace: opts.eventPlace,
      doorCode: opts.doorCode,
      qrDataUrl,
    });
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Pollar Pass <onboarding@resend.dev>",
        to: [opts.to],
        subject: `Tu pase para ${opts.eventName}`,
        html,
        text: `Tu pase para "${opts.eventName}" está confirmado.\n\n${formatEventDateTime(opts.eventDateTime)} · ${opts.eventPlace}\n\nCódigo del pase (QR): ${opts.ticketCode}\nCódigo de puerta: ${opts.doorCode}\n\nMostrá el código del pase en la entrada del evento.`,
      }),
    });
    if (!res.ok) {
      return { sent: false, error: `Resend respondió ${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : "fetch falló" };
  }
}
