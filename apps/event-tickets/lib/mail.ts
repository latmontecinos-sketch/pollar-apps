import { formatEventDateTime, formatTimestamp } from "./format.ts";
import { dictFor, type Locale } from "./i18n/index.ts";
import { maskEmail } from "./security-log.ts";

const RESEND_API_URL = "https://api.resend.com/emails";
/**
 * Resend's testing sender only delivers to the email that owns the Resend
 * account; every other recipient gets a 403. Production needs a verified
 * domain, set here without a code change.
 */
const DEFAULT_FROM = "Pollar Pass <onboarding@resend.dev>";

/** Email can't read CSS variables; these mirror the tokens in app/globals.css. */
const PRIMARY = "#005db4";
const INK = "#111827";
const MUTED = "#6b7280";

/**
 * Quotes included: today every interpolation below lands in text, but the
 * one attribute here is a URL, and "this value never goes in an attribute"
 * is a property one edit away from stopping being true.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shell(inner: string): string {
  return `
<div style="background:#f4f6f8;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:440px;margin:0 auto;">
    <p style="text-align:center;margin:0 0 20px;font-size:15px;font-weight:800;color:${PRIMARY};letter-spacing:0.2px;">
      Pollar Pass
    </p>
    ${inner}
  </div>
</div>`.trim();
}

function ticketEmailHtml(opts: {
  locale: Locale;
  eventName: string;
  eventDateTime: string;
  eventPlace: string;
  doorCode: string;
  qrUrl: string;
}): string {
  const t = dictFor(opts.locale);
  const name = escapeHtml(opts.eventName);
  const place = escapeHtml(opts.eventPlace);
  const when = escapeHtml(formatEventDateTime(opts.eventDateTime, opts.locale));
  return shell(`
    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:20px;overflow:hidden;">
      <div style="background:${PRIMARY};padding:18px 24px;text-align:center;">
        <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.85);">${escapeHtml(t.email.ticketFor)}</p>
        <h1 style="margin:4px 0 0;font-size:22px;line-height:1.3;color:#ffffff;">${name}</h1>
      </div>
      <div style="padding:24px;text-align:center;">
        <p style="margin:0 0 18px;font-size:14px;color:${MUTED};">${when} · ${place}</p>
        <!-- Hosted PNG, not a data: URI: Gmail and Outlook drop inline base64 images. -->
        <img src="${escapeHtml(opts.qrUrl)}" width="240" height="240" alt="QR"
             style="display:block;margin:0 auto;border:1px solid #e5e7eb;border-radius:16px;" />
        <p style="margin:22px 0 2px;font-size:12px;color:${MUTED};text-transform:uppercase;letter-spacing:0.6px;">
          ${escapeHtml(t.email.doorCode)}
        </p>
        <p style="margin:0;font-size:26px;font-weight:700;letter-spacing:4px;font-family:'SFMono-Regular',Consolas,Menlo,monospace;color:${INK};">
          ${escapeHtml(opts.doorCode)}
        </p>
      </div>
    </div>
    <p style="text-align:center;margin:18px 0 0;font-size:12px;line-height:1.6;color:#9ca3af;">
      ${escapeHtml(t.email.footer)}
    </p>`);
}

function checkinEmailHtml(opts: {
  locale: Locale;
  eventName: string;
  checkedInAt: string;
}): string {
  const t = dictFor(opts.locale);
  const name = escapeHtml(opts.eventName);
  return shell(`
    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:20px;padding:28px 24px;text-align:center;">
      <div style="width:64px;height:64px;margin:0 auto 16px;border-radius:999px;background:#f0fdf4;line-height:64px;font-size:30px;color:#16a34a;">&#10003;</div>
      <h1 style="margin:0 0 8px;font-size:21px;line-height:1.3;color:${INK};">${escapeHtml(t.email.checkinHeading)}</h1>
      <p style="margin:0 0 6px;font-size:14px;color:${MUTED};">${escapeHtml(t.email.checkinBody(name))}</p>
      <p style="margin:0;font-size:13px;color:#9ca3af;">${escapeHtml(formatTimestamp(opts.checkedInAt, opts.locale))}</p>
      <p style="margin:20px 0 0;font-size:16px;font-weight:700;color:${PRIMARY};">
        ${escapeHtml(t.email.checkinEnjoy(name))}
      </p>
    </div>`);
}

/** RFC-max length; anything longer is someone probing, not a mailbox. */
const MAX_EMAIL_LENGTH = 254;

/**
 * Deliberately loose — one @, no spaces, something either side, a dot in
 * the domain. Enough to keep junk out of the database and out of Resend's
 * "to" field; the real validation is whether the mail arrives.
 */
export function isDeliverableEmail(value: string): boolean {
  return value.length <= MAX_EMAIL_LENGTH && /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/.test(value);
}

/**
 * Where the QR in the email points. Taken from configuration, not from the
 * request's Host header: that header is attacker-controlled, and an email
 * we send should never take a stranger's word for which host to embed.
 */
export function appOrigin(request: Request): string {
  const configured = process.env.APP_ORIGIN?.trim().replace(/\/$/, "");
  return configured || new URL(request.url).origin;
}

type SendResult = { sent: boolean; error?: string };

async function send(payload: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, error: "RESEND_API_KEY no está configurada" };
  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.MAIL_FROM?.trim() || DEFAULT_FROM,
        to: [payload.to],
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
      }),
    });
    if (res.ok) return { sent: true };
    return { sent: false, error: `Resend respondió ${res.status}${await resendReason(res)}` };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : "fetch falló" };
  }
}

/**
 * The status alone can't tell a testing-domain rejection from a revoked key —
 * both are 403 — and that difference is the whole diagnosis. Resend's
 * message quotes an address (the account owner's), so it's masked like
 * every other email in our logs.
 */
async function resendReason(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { name?: unknown; message?: unknown };
    const name = typeof body.name === "string" ? body.name : "";
    const message = typeof body.message === "string" ? body.message : "";
    const reason = [name, message].filter(Boolean).join(": ").slice(0, 300);
    return reason ? ` (${reason.replace(/[^\s@(),;:<>"']+@[^\s@(),;:<>"']+/g, maskEmail)})` : "";
  } catch {
    return "";
  }
}

/**
 * The buyer's copy of their ticket. Best-effort: a failed send never blocks
 * or reverses the purchase, since the ticket already lives in their own
 * account (this is a convenience copy, not the source of truth).
 */
export async function sendTicketEmail(opts: {
  to: string;
  locale: Locale;
  origin: string;
  eventName: string;
  eventDateTime: string;
  eventPlace: string;
  ticketCode: string;
  doorCode: string;
}): Promise<SendResult> {
  const t = dictFor(opts.locale);
  return send({
    to: opts.to,
    subject: t.email.subject(opts.eventName),
    html: ticketEmailHtml({
      locale: opts.locale,
      eventName: opts.eventName,
      eventDateTime: opts.eventDateTime,
      eventPlace: opts.eventPlace,
      doorCode: opts.doorCode,
      qrUrl: `${opts.origin}/api/tickets/${encodeURIComponent(opts.ticketCode)}/qr`,
    }),
    text: t.email.text(
      opts.eventName,
      formatEventDateTime(opts.eventDateTime, opts.locale),
      opts.eventPlace,
      opts.ticketCode,
      opts.doorCode
    ),
  });
}

/** "You're in" — sent when the door accepts the ticket. */
export async function sendCheckinEmail(opts: {
  to: string;
  locale: Locale;
  eventName: string;
  checkedInAt: string;
}): Promise<SendResult> {
  const t = dictFor(opts.locale);
  return send({
    to: opts.to,
    subject: t.email.checkinSubject(opts.eventName),
    html: checkinEmailHtml(opts),
    text: t.email.checkinText(opts.eventName, formatTimestamp(opts.checkedInAt, opts.locale)),
  });
}
