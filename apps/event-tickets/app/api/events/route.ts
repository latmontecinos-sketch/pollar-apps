import { NextResponse } from "next/server";
import { requireSignedAddress } from "@/lib/auth";
import { db, dbReady } from "@/lib/db";
import { decimalToStroops } from "@/lib/money";
import { newId } from "@/lib/ids";

type CreateEventBody = {
  name: string;
  description?: string;
  datetimeUtc: string;
  place: string;
  priceDecimal: string;
  capacity: number;
};

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

/** Creates an event. Ownership is the verified signer — never a field from the body. */
export async function POST(request: Request) {
  const auth = requireSignedAddress(request);
  if (!auth.ok) return auth.response;

  let body: Partial<CreateEventBody>;
  try {
    body = (await request.json()) as Partial<CreateEventBody>;
  } catch {
    return badRequest("JSON inválido");
  }

  const name = body.name?.trim() ?? "";
  const place = body.place?.trim() ?? "";
  const description = body.description?.trim() ?? "";
  const datetimeUtc = body.datetimeUtc ?? "";
  const capacity = Number(body.capacity);

  if (!name) return badRequest("El nombre es obligatorio");
  if (!place) return badRequest("El lugar es obligatorio");
  if (!datetimeUtc || Number.isNaN(new Date(datetimeUtc).getTime())) {
    return badRequest("La fecha no es válida");
  }
  if (new Date(datetimeUtc).getTime() < Date.now()) {
    return badRequest("La fecha del evento ya pasó — elige una fecha futura");
  }
  if (!Number.isInteger(capacity) || capacity < 1) {
    return badRequest("El cupo debe ser un entero mayor a 0");
  }

  let priceStroops: bigint;
  try {
    priceStroops = decimalToStroops(body.priceDecimal ?? "");
  } catch {
    return badRequest("El precio no es válido");
  }
  if (priceStroops <= 0n) return badRequest("El precio debe ser mayor a 0");

  await dbReady();
  const id = newId();
  await db.execute({
    sql: `INSERT INTO events (id, organizer_pollar_id, name, description, datetime_utc, place, price_stroops, capacity)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      auth.address,
      name,
      description,
      new Date(datetimeUtc).toISOString(),
      place,
      priceStroops.toString(),
      capacity,
    ],
  });

  return NextResponse.json({ id }, { status: 201 });
}
