import { NextResponse } from "next/server";
import { requireDoorAccess } from "@/lib/auth";
import { db, dbReady } from "@/lib/db";
import { sqlUtcToIso } from "@/lib/format";
import { notifyCheckin } from "@/lib/checkin-notify";
import { enforceDoor } from "@/lib/rate-limit";
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

  // One budget per actor (the organizer, or the staff link) plus the event's
  // own: a staff link that spends its budget never locks the organizer out.
  const limited = await enforceDoor("checkin", id, access.actor);
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
      const notified = await notifyCheckin(result.ticket.saleId, event.name);
      // The counter is a nicety too: if reading it fails the ticket is still spent.
      const checkedIn = await doorCounts(id).then(
        (counts) => counts.checkedIn,
        () => undefined
      );
      return NextResponse.json({ result: "VALID", checkedIn, notified });
    case "USED":
      return NextResponse.json({ result: "USED", usedAt: sqlUtcToIso(result.usedAt) });
    case "UNKNOWN":
      return NextResponse.json({ result: "UNKNOWN" });
  }
}
