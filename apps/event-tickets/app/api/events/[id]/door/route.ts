import { NextResponse } from "next/server";
import { requireDoorAccess } from "@/lib/auth";
import { db, dbReady } from "@/lib/db";
import { sqlUtcToIso } from "@/lib/format";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/lib/i18n/locales";
import { sendCheckinEmail } from "@/lib/mail";
import { enforce } from "@/lib/rate-limit";
import { securityLog, shortAddressForLog } from "@/lib/security-log";
import { validateAtDoor } from "@/lib/tickets";

type Ctx = { params: Promise<{ id: string }> };

type EventRow = {
  organizer_pollar_id: string;
  door_token: string | null;
  name: string;
  datetime_utc: string;
  place: string;
};

async function loadEvent(id: string): Promise<EventRow | null> {
  await dbReady();
  const result = await db.execute({
    sql: "SELECT organizer_pollar_id, door_token, name, datetime_utc, place FROM events WHERE id = ?",
    args: [id],
  });
  return result.rows.length > 0 ? (result.rows[0] as unknown as EventRow) : null;
}

async function doorCounts(eventId: string): Promise<{ paid: number; checkedIn: number }> {
  const result = await db.execute({
    sql: `SELECT
            (SELECT count(*) FROM sales WHERE event_id = ? AND status = 'paid') AS paid,
            (SELECT count(*) FROM tickets WHERE event_id = ? AND used_at IS NOT NULL) AS checked_in`,
    args: [eventId, eventId],
  });
  return { paid: Number(result.rows[0].paid), checkedIn: Number(result.rows[0].checked_in) };
}

/**
 * "You're in" email, in the language the buyer bought in. Best-effort: the
 * person is already through the door, so a mail failure only gets logged.
 */
async function notifyBuyer(saleId: string, eventName: string): Promise<void> {
  const row = await db.execute({
    sql: "SELECT buyer_email, buyer_locale FROM sales WHERE id = ?",
    args: [saleId],
  });
  const email = row.rows[0]?.buyer_email;
  if (!email) return;
  const locale = row.rows[0]?.buyer_locale;
  const result = await sendCheckinEmail({
    to: String(email),
    locale: isLocale(locale as string) ? (locale as Locale) : DEFAULT_LOCALE,
    eventName,
    checkedInAt: new Date().toISOString(),
  });
  if (!result.sent) console.error(`[mail] check-in email failed: ${result.error}`);
}

/** What the door screen shows (organizer or staff link): which event, and the running counter. */
export async function GET(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const event = await loadEvent(id);
  if (!event) {
    return NextResponse.json({ error: "No encontrado", code: "event_not_found" }, { status: 404 });
  }

  const access = requireDoorAccess(request, event);
  if (!access.ok) return access.response;

  return NextResponse.json({
    name: event.name,
    datetimeUtc: event.datetime_utc,
    place: event.place,
    ...(await doorCounts(id)),
  });
}

/**
 * Door check-in, by the organizer or by staff holding the event's door
 * link. Response is only VALID/USED/UNKNOWN plus the minimum to render (and
 * the running check-in count) — never the sale/buyer object behind it.
 */
export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const event = await loadEvent(id);
  if (!event) {
    return NextResponse.json({ error: "No encontrado", code: "event_not_found" }, { status: 404 });
  }

  const access = requireDoorAccess(request, event);
  if (!access.ok) return access.response;

  // Per event, not per actor: the staff link is one shared credential, and
  // the limit is what a real door scans in an hour with room to spare.
  const limited = await enforce("door", id, { event: id });
  if (limited) return limited;

  let body: { code?: string };
  try {
    body = (await request.json()) as { code?: string };
  } catch {
    return NextResponse.json({ error: "JSON inválido", code: "invalid_json" }, { status: 400 });
  }
  const code = body.code?.trim() ?? "";
  if (!code) {
    return NextResponse.json({ error: "Falta el código", code: "missing_code" }, { status: 400 });
  }

  const result = await validateAtDoor(id, code, access.actor);
  switch (result.result) {
    case "VALID":
      // The one irreversible act at the door: a ticket just got spent.
      securityLog("checkin.accepted", {
        event: id,
        ticket: result.ticket.id,
        by: shortAddressForLog(access.actor),
      });
      await notifyBuyer(result.ticket.saleId, event.name);
      return NextResponse.json({ result: "VALID", checkedIn: (await doorCounts(id)).checkedIn });
    case "USED":
      return NextResponse.json({ result: "USED", usedAt: sqlUtcToIso(result.usedAt) });
    case "UNKNOWN":
      return NextResponse.json({ result: "UNKNOWN" });
  }
}
