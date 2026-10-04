import { NextResponse } from "next/server";
import { requireAddress } from "@/lib/auth";
import { db, dbReady } from "@/lib/db";
import { stroopsToDecimal } from "@/lib/money";
import { enforce } from "@/lib/rate-limit";
import { collectedForEvent } from "@/lib/revenue";
import { confirmCapacityCode } from "@/lib/capacity-code";
import { eventImageVersion } from "@/lib/event-image";
import { updateEventFields, type EventPatch } from "@/lib/event-update";
import { isVisibility } from "@/lib/visibility";
import { normalizeCity } from "@/lib/city";
import { checkDoorsOpen, DOORS_ERRORS } from "@/lib/doors-open";
import { securityLog, shortAddressForLog } from "@/lib/security-log";
import {
  listTicketTypes,
  MAX_DESCRIPTION_CHARS,
  MAX_NAME_CHARS,
  summarize,
  type TicketType,
} from "@/lib/ticket-types";

type Ctx = { params: Promise<{ id: string }> };

/** Spanish `error` for the logs; the UI shows `code`, translated (lib/i18n/errors.ts). */
const CAPACITY_ERRORS = {
  code_invalid: { status: 400, error: "El código no es correcto" },
  code_expired: { status: 400, error: "El código venció" },
  code_attempts: { status: 429, error: "Demasiados intentos con ese código" },
  capacity_lower: { status: 400, error: "El cupo nuevo tiene que ser mayor al actual" },
  capacity_limit: { status: 400, error: "El cupo no puede pasar de 100.000" },
  not_found: { status: 404, error: "Ese tipo de entrada no existe", code: "ticket_type_not_found" },
} as const;

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
  visibility: string;
  access_code: string | null;
  city: string | null;
  doors_open_utc: string | null;
  accent: string | null;
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

function toJson(
  row: EventRow,
  types: TicketType[],
  checkedIn: number,
  imageVersion: string | null,
  collected: bigint
) {
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
    /** What the paid sales brought in, summed across tiers (each has its own price). */
    collectedDecimal: stroopsToDecimal(collected),
    createdAt: row.created_at,
    organizerName: row.organizer_name,
    organizerContact: row.organizer_contact,
    // Owner-only route, so the staff door secret is shown to its owner only.
    doorToken: row.door_token,
    ticketTypes: types,
    visibility: row.visibility,
    // Owner-only, like the door token: the code that opens a private event.
    accessCode: row.access_code,
    /** Null when the event has no photo; else part of its URL (lib/event-image-path.ts). */
    imageVersion,
    city: row.city,
    /** When the doors open, ISO UTC, or null. */
    doorsOpenUtc: row.doors_open_utc,
    /** `#rrggbb` taken from the photo, or null (lib/accent.ts turns it into safe UI colours). */
    accent: row.accent,
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

  return NextResponse.json(
    toJson(
      event,
      await listTicketTypes(id),
      await checkedInTotal(id),
      await eventImageVersion(id),
      await collectedForEvent(id)
    )
  );
}

type PatchBody = {
  organizerName?: string;
  organizerContact?: string;
  /**
   * Adds seats to one tier; only ever upwards. Needs the code emailed by
   * POST /api/events/[id]/capacity-code for this exact change.
   */
  ticketTypeId?: string;
  capacity?: number;
  challengeId?: string;
  code?: string;
  name?: string;
  description?: string;
  place?: string;
  datetimeUtc?: string;
  /** Switches between listed and code-only; a private event gets its code on the way in. */
  visibility?: "public" | "private";
  /** Empty string or null clears it. */
  city?: string | null;
  /** ISO instant; empty string or null clears it. */
  doorsOpenUtc?: string | null;
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

  // Checked before anything is written (a capacity code, once confirmed, is spent).
  // The doors time is judged against the start this request leaves behind.
  let newStartIso: string | undefined;
  if (body.datetimeUtc) {
    const parsed = new Date(body.datetimeUtc);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ error: "La fecha no es válida", code: "invalid_date" }, { status: 400 });
    }
    newStartIso = parsed.toISOString();
  }
  let doorsPatch: string | null | undefined;
  if (body.doorsOpenUtc !== undefined) {
    const doors = checkDoorsOpen(body.doorsOpenUtc, newStartIso ?? event.datetime_utc);
    if (!doors.ok) {
      return NextResponse.json({ error: DOORS_ERRORS[doors.code], code: doors.code }, { status: 400 });
    }
    doorsPatch = doors.value;
  } else if (newStartIso && event.doors_open_utc) {
    // Moving the start without touching the doors time: it must still fit. (The UPDATE
    // checks it again against the row as it is then; this only gives the clear error.)
    const doors = checkDoorsOpen(event.doors_open_utc, newStartIso);
    if (!doors.ok) {
      return NextResponse.json({ error: DOORS_ERRORS[doors.code], code: doors.code }, { status: 400 });
    }
  }

  if (body.capacity !== undefined && body.ticketTypeId) {
    // No code, no seats: the email step is the whole point of the change.
    if (!body.challengeId || !body.code) {
      return NextResponse.json(
        { error: "Falta el código enviado por correo", code: "code_required" },
        { status: 428 }
      );
    }
    const result = await confirmCapacityCode({
      eventId: id,
      ticketTypeId: body.ticketTypeId,
      capacity: Number(body.capacity),
      organizer: auth.address,
      challengeId: String(body.challengeId),
      code: String(body.code),
    });
    if (!result.ok) {
      const failure = CAPACITY_ERRORS[result.code];
      securityLog("capacity.code_rejected", {
        reason: result.code,
        actor: shortAddressForLog(auth.address),
      });
      return NextResponse.json(
        { error: failure.error, code: "code" in failure ? failure.code : result.code },
        { status: failure.status }
      );
    }
  }

  // Only what the request carries is written (lib/event-update.ts), so an edit
  // that doesn't mention visibility can't undo one that does. Capped like the
  // organizer fields. See MAX_NAME_CHARS: the event name reaches a public,
  // unauthenticated image renderer.
  const patch: EventPatch = {};
  const name = body.name?.trim().slice(0, MAX_NAME_CHARS);
  if (name) patch.name = name;
  if (typeof body.description === "string") {
    patch.description = body.description.trim().slice(0, MAX_DESCRIPTION_CHARS);
  }
  const place = body.place?.trim().slice(0, MAX_NAME_CHARS);
  if (place) patch.place = place;
  if (typeof body.organizerName === "string") patch.organizerName = body.organizerName.trim().slice(0, 80);
  if (typeof body.organizerContact === "string") {
    patch.organizerContact = body.organizerContact.trim().slice(0, 120);
  }
  if (newStartIso) patch.datetimeUtc = newStartIso;
  if (doorsPatch !== undefined) patch.doorsOpenUtc = doorsPatch;
  if (typeof body.city === "string" || body.city === null) patch.city = normalizeCity(body.city);
  if (isVisibility(body.visibility)) patch.visibility = body.visibility;
  const applied = await updateEventFields(id, patch);
  if (!applied) {
    // The only condition in that UPDATE besides the id: a racing edit moved the start or the
    // doors time so that the two no longer fit.
    return NextResponse.json({ error: DOORS_ERRORS.doors_after_start, code: "doors_after_start" }, { status: 400 });
  }

  const updated = await loadEvent(id);
  return NextResponse.json(
    toJson(
      updated!,
      await listTicketTypes(id),
      await checkedInTotal(id),
      await eventImageVersion(id),
      await collectedForEvent(id)
    )
  );
}
