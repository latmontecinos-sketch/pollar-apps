import { NextResponse } from "next/server";
import { requireSignedAddress } from "@/lib/auth";
import { db, dbReady } from "@/lib/db";
import { newId } from "@/lib/ids";
import { enforce } from "@/lib/rate-limit";
import { shortAddress } from "@/lib/security-log";
import {
  createTicketTypes,
  parseTicketTypes,
  TicketTypeError,
  type TicketTypeInput,
} from "@/lib/ticket-types";
import { decimalToStroops } from "@/lib/money";

type CreateEventBody = {
  organizerName?: string;
  organizerContact?: string;
  name: string;
  description?: string;
  datetimeUtc: string;
  place: string;
  /** One entry per tier (General, VIP…). */
  ticketTypes: TicketTypeInput[];
};

function badRequest(error: string, code?: string) {
  return NextResponse.json({ error, code }, { status: 400 });
}

/** Creates an event and its ticket tiers. Ownership is the verified signer — never a field from the body. */
export async function POST(request: Request) {
  const auth = requireSignedAddress(request);
  if (!auth.ok) return auth.response;

  const limited = await enforce("createEvent", auth.address, {
    actor: shortAddress(auth.address),
  });
  if (limited) return limited;

  let body: Partial<CreateEventBody>;
  try {
    body = (await request.json()) as Partial<CreateEventBody>;
  } catch {
    return badRequest("JSON inválido");
  }

  const name = body.name?.trim() ?? "";
  const place = body.place?.trim() ?? "";
  const description = body.description?.trim() ?? "";
  const organizerName = (body.organizerName?.trim() ?? "").slice(0, 80);
  const organizerContact = (body.organizerContact?.trim() ?? "").slice(0, 120);
  const datetimeUtc = body.datetimeUtc ?? "";

  if (!name) return badRequest("El nombre es obligatorio");
  if (!place) return badRequest("El lugar es obligatorio");
  if (!datetimeUtc || Number.isNaN(new Date(datetimeUtc).getTime())) {
    return badRequest("La fecha no es válida");
  }
  if (new Date(datetimeUtc).getTime() < Date.now()) {
    return badRequest("La fecha del evento ya pasó — elige una fecha futura");
  }

  let ticketTypes: TicketTypeInput[];
  try {
    ticketTypes = parseTicketTypes(body.ticketTypes);
  } catch (err) {
    if (err instanceof TicketTypeError) return badRequest(err.message, err.code);
    throw err;
  }

  await dbReady();
  const id = newId();
  // `price_stroops` / `capacity` on the event are a summary for listings;
  // the seats that get sold live on the tiers (lib/ticket-types.ts).
  const cheapest = ticketTypes
    .map((type) => decimalToStroops(type.priceDecimal))
    .reduce((a, b) => (a < b ? a : b));
  const totalCapacity = ticketTypes.reduce((sum, type) => sum + type.capacity, 0);

  await db.execute({
    sql: `INSERT INTO events (id, organizer_pollar_id, name, description, datetime_utc, place,
                              price_stroops, capacity, organizer_name, organizer_contact)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      auth.address,
      name,
      description,
      new Date(datetimeUtc).toISOString(),
      place,
      cheapest.toString(),
      totalCapacity,
      organizerName,
      organizerContact,
    ],
  });
  await createTicketTypes(id, ticketTypes);

  return NextResponse.json({ id }, { status: 201 });
}
