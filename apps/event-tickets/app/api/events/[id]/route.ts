import { NextResponse } from "next/server";
import { requireAddress } from "@/lib/auth";
import { db, dbReady } from "@/lib/db";
import { stroopsToDecimal } from "@/lib/money";

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
  capacity_increases: number;
};

/** Events often add a second batch of tickets; twice is enough to stay honest about "cupo". */
const MAX_CAPACITY_INCREASES = 2;

async function loadEvent(id: string): Promise<EventRow | null> {
  const result = await db.execute({
    sql: "SELECT * FROM events WHERE id = ?",
    args: [id],
  });
  return result.rows.length > 0 ? (result.rows[0] as unknown as EventRow) : null;
}

/** Paid sales and door check-ins: `reserved` alone also counts unpaid, in-progress checkouts. */
async function loadCounts(id: string): Promise<{ paid: number; checkedIn: number }> {
  const result = await db.execute({
    sql: `SELECT
            (SELECT count(*) FROM sales WHERE event_id = ? AND status = 'paid') AS paid,
            (SELECT count(*) FROM tickets WHERE event_id = ? AND used_at IS NOT NULL) AS checked_in`,
    args: [id, id],
  });
  return { paid: Number(result.rows[0].paid), checkedIn: Number(result.rows[0].checked_in) };
}

function toJson(row: EventRow, counts: { paid: number; checkedIn: number }) {
  return {
    ...counts,
    id: row.id,
    organizerPollarId: row.organizer_pollar_id,
    name: row.name,
    description: row.description,
    datetimeUtc: row.datetime_utc,
    place: row.place,
    priceDecimal: stroopsToDecimal(BigInt(row.price_stroops)),
    capacity: row.capacity,
    reserved: row.reserved,
    createdAt: row.created_at,
    organizerName: row.organizer_name,
    organizerContact: row.organizer_contact,
    // Owner-only route, so the staff door secret is shown to its owner only.
    doorToken: row.door_token,
    capacityIncreasesLeft: Math.max(0, MAX_CAPACITY_INCREASES - Number(row.capacity_increases ?? 0)),
  };
}

/** Owner-only: the organizer panel. 404 before 403 — existence isn't secret, ownership is. */
export async function GET(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  await dbReady();
  const event = await loadEvent(id);
  if (!event) return NextResponse.json({ error: "No encontrado" }, { status: 404 });

  const auth = requireAddress(request, event.organizer_pollar_id);
  if (!auth.ok) return auth.response;

  return NextResponse.json(toJson(event, await loadCounts(id)));
}

type PatchBody = {
  organizerName?: string;
  organizerContact?: string;
  /** Only ever upwards, at most twice — see MAX_CAPACITY_INCREASES. */
  capacity?: number;
  name?: string;
  description?: string;
  place?: string;
  datetimeUtc?: string;
};

/** Owner-only edit. Price and capacity are immutable after creation — they're load-bearing for already-reserved seats. */
export async function PATCH(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  await dbReady();
  const event = await loadEvent(id);
  if (!event) return NextResponse.json({ error: "No encontrado" }, { status: 404 });

  const auth = requireAddress(request, event.organizer_pollar_id);
  if (!auth.ok) return auth.response;

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const name = body.name?.trim() || event.name;
  const description = body.description?.trim() ?? event.description;
  const place = body.place?.trim() || event.place;
  const organizerName = (body.organizerName?.trim() ?? event.organizer_name).slice(0, 80);
  const organizerContact = (body.organizerContact?.trim() ?? event.organizer_contact).slice(0, 120);
  let datetimeUtc = event.datetime_utc;
  if (body.datetimeUtc) {
    const parsed = new Date(body.datetimeUtc);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ error: "La fecha no es válida" }, { status: 400 });
    }
    datetimeUtc = parsed.toISOString();
  }

  // Capacity: never down (someone already holds those seats), never more
  // than twice — an event that keeps "adding tickets" isn't a capacity.
  if (body.capacity !== undefined) {
    const capacity = Number(body.capacity);
    if (!Number.isInteger(capacity) || capacity <= event.capacity) {
      return NextResponse.json(
        { error: "El cupo nuevo tiene que ser mayor al actual", code: "capacity_lower" },
        { status: 400 }
      );
    }
    if (Number(event.capacity_increases ?? 0) >= MAX_CAPACITY_INCREASES) {
      return NextResponse.json(
        { error: "Ya usaste las 2 ampliaciones de cupo de este evento", code: "capacity_limit" },
        { status: 409 }
      );
    }
    await db.execute({
      sql: "UPDATE events SET capacity = ?, capacity_increases = capacity_increases + 1 WHERE id = ?",
      args: [capacity, id],
    });
  }

  await db.execute({
    sql: `UPDATE events SET name = ?, description = ?, place = ?, datetime_utc = ?,
            organizer_name = ?, organizer_contact = ? WHERE id = ?`,
    args: [name, description, place, datetimeUtc, organizerName, organizerContact, id],
  });

  const updated = await loadEvent(id);
  return NextResponse.json(toJson(updated!, await loadCounts(id)));
}
