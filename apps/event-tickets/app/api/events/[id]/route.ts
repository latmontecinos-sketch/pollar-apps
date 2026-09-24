import { NextResponse } from "next/server";
import { requireAddress } from "@/lib/auth";
import { db, dbReady } from "@/lib/db";
import { stroopsToDecimal } from "@/lib/money";
import { enforce } from "@/lib/rate-limit";
import { shortAddressForLog } from "@/lib/security-log";
import {
  extendCapacity,
  listTicketTypes,
  MAX_DESCRIPTION_CHARS,
  MAX_NAME_CHARS,
  summarize,
  type TicketType,
} from "@/lib/ticket-types";

type Ctx = { params: Promise<{ id: string }> };

type EventRow = {
  id: string;
  organizer_pollar_id: string;
  name: string;
  description: string;
  datetime_utc: string;
  place: string;
  price_stroops: string;
  capacity: number;
  reserved: number;
  created_at: string;
  organizer_name: string;
  organizer_contact: string;
  door_token: string | null;
};

async function loadEvent(id: string): Promise<EventRow | null> {
  const result = await db.execute({
    sql: "SELECT * FROM events WHERE id = ?",
    args: [id],
  });
  return result.rows.length > 0 ? (result.rows[0] as unknown as EventRow) : null;
}

async function checkedInTotal(id: string): Promise<number> {
  const result = await db.execute({
    sql: "SELECT count(*) AS n FROM tickets WHERE event_id = ? AND used_at IS NOT NULL",
    args: [id],
  });
  return Number(result.rows[0].n);
}

function toJson(row: EventRow, types: TicketType[], checkedIn: number) {
  const totals = summarize(types);
  return {
    id: row.id,
    organizerPollarId: row.organizer_pollar_id,
    name: row.name,
    description: row.description,
    datetimeUtc: row.datetime_utc,
    place: row.place,
    /** Cheapest tier — "desde X USDC" in listings. */
    priceDecimal: stroopsToDecimal(totals.priceStroops),
    capacity: totals.capacity,
    reserved: totals.reserved,
    paid: totals.paid,
    checkedIn,
    createdAt: row.created_at,
    organizerName: row.organizer_name,
    organizerContact: row.organizer_contact,
    // Owner-only route, so the staff door secret is shown to its owner only.
    doorToken: row.door_token,
    ticketTypes: types,
  };
}

/** Owner-only: the organizer panel. 404 before 403 — existence isn't secret, ownership is. */
export async function GET(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  await dbReady();
  const event = await loadEvent(id);
  if (!event) {
    return NextResponse.json({ error: "No encontrado", code: "event_not_found" }, { status: 404 });
  }

  const auth = requireAddress(request, event.organizer_pollar_id);
  if (!auth.ok) return auth.response;

  return NextResponse.json(toJson(event, await listTicketTypes(id), await checkedInTotal(id)));
}

type PatchBody = {
  organizerName?: string;
  organizerContact?: string;
  /** Adds seats to one tier; only ever upwards, at most twice. */
  ticketTypeId?: string;
  capacity?: number;
  name?: string;
  description?: string;
  place?: string;
  datetimeUtc?: string;
};

/** Owner-only edit. Prices are immutable after creation; capacity can only grow. */
export async function PATCH(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  await dbReady();
  const event = await loadEvent(id);
  if (!event) {
    return NextResponse.json({ error: "No encontrado", code: "event_not_found" }, { status: 404 });
  }

  const auth = requireAddress(request, event.organizer_pollar_id);
  if (!auth.ok) return auth.response;

  const limited = await enforce("editEvent", auth.address, {
    actor: shortAddressForLog(auth.address),
  });
  if (limited) return limited;

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "JSON inválido", code: "invalid_json" }, { status: 400 });
  }

  if (body.capacity !== undefined && body.ticketTypeId) {
    const result = await extendCapacity(id, body.ticketTypeId, Number(body.capacity));
    if (!result.ok) {
      const status = result.code === "capacity_limit" ? 409 : 400;
      return NextResponse.json(
        {
          error:
            result.code === "capacity_limit"
              ? "Ya usaste las 2 ampliaciones de cupo de este tipo de entrada"
              : "El cupo nuevo tiene que ser mayor al actual",
          code: result.code,
        },
        { status }
      );
    }
  }

  // Capped like organizerName/organizerContact below. See MAX_NAME_CHARS:
  // the event name reaches a public, unauthenticated image renderer.
  const name = (body.name?.trim() || event.name).slice(0, MAX_NAME_CHARS);
  const description = (body.description?.trim() ?? event.description).slice(
    0,
    MAX_DESCRIPTION_CHARS
  );
  const place = (body.place?.trim() || event.place).slice(0, MAX_NAME_CHARS);
  const organizerName = (body.organizerName?.trim() ?? event.organizer_name).slice(0, 80);
  const organizerContact = (body.organizerContact?.trim() ?? event.organizer_contact).slice(0, 120);
  let datetimeUtc = event.datetime_utc;
  if (body.datetimeUtc) {
    const parsed = new Date(body.datetimeUtc);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ error: "La fecha no es válida", code: "invalid_date" }, { status: 400 });
    }
    datetimeUtc = parsed.toISOString();
  }

  const types = await listTicketTypes(id);
  const totals = summarize(types);
  await db.execute({
    sql: `UPDATE events SET name = ?, description = ?, place = ?, datetime_utc = ?,
            organizer_name = ?, organizer_contact = ?, capacity = ? WHERE id = ?`,
    args: [
      name,
      description,
      place,
      datetimeUtc,
      organizerName,
      organizerContact,
      totals.capacity,
      id,
    ],
  });

  const updated = await loadEvent(id);
  return NextResponse.json(toJson(updated!, types, await checkedInTotal(id)));
}
