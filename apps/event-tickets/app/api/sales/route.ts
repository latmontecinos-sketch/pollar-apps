import { NextResponse } from "next/server";
import { requireSignedAddress } from "@/lib/auth";
import { db, dbReady } from "@/lib/db";
import { stroopsToDecimal } from "@/lib/money";
import { generateReference, reserveAndCreateSale } from "@/lib/sales";

const SALE_TTL_MS = 15 * 60 * 1000;
const MAX_REFERENCE_ATTEMPTS = 5;

type CreateSaleBody = { eventId?: string; idempotencyKey?: string };

type EventRow = {
  organizer_pollar_id: string;
  price_stroops: string;
};

/**
 * Creates a pending sale for the logged-in buyer and hands back everything
 * the client needs to pay: the exact amount, the organizer's address (the
 * payment destination) and the `reference` that must go in the memo — the
 * correlation key `confirm` will look for on Horizon.
 */
export async function POST(request: Request) {
  const auth = requireSignedAddress(request);
  if (!auth.ok) return auth.response;

  let body: CreateSaleBody;
  try {
    body = (await request.json()) as CreateSaleBody;
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const eventId = body.eventId?.trim() ?? "";
  const idempotencyKey = body.idempotencyKey?.trim() ?? "";
  if (!eventId) return NextResponse.json({ error: "Falta eventId" }, { status: 400 });
  if (!idempotencyKey) {
    return NextResponse.json({ error: "Falta idempotencyKey" }, { status: 400 });
  }

  await dbReady();
  const eventResult = await db.execute({
    sql: "SELECT organizer_pollar_id, price_stroops FROM events WHERE id = ?",
    args: [eventId],
  });
  if (eventResult.rows.length === 0) {
    return NextResponse.json({ error: "Evento no encontrado" }, { status: 404 });
  }
  const event = eventResult.rows[0] as unknown as EventRow;
  const amountStroops = BigInt(event.price_stroops);

  let result: Awaited<ReturnType<typeof reserveAndCreateSale>> | null = null;
  for (let attempt = 0; attempt < MAX_REFERENCE_ATTEMPTS; attempt++) {
    try {
      result = await reserveAndCreateSale({
        eventId,
        buyerPollarId: auth.address,
        reference: generateReference(),
        amountStroops,
        idempotencyKey,
        ttlMs: SALE_TTL_MS,
      });
      break;
    } catch (err) {
      // `reference` UNIQUE collision (astronomically unlikely at 40 bits): retry with a new one.
      if (err instanceof Error && /UNIQUE/i.test(err.message) && /reference/i.test(err.message)) {
        continue;
      }
      throw err;
    }
  }
  if (!result) {
    return NextResponse.json({ error: "No se pudo generar una referencia única" }, { status: 500 });
  }
  if (!result.ok) {
    return NextResponse.json({ error: "Evento agotado" }, { status: 409 });
  }

  return NextResponse.json(
    {
      id: result.sale.id,
      reference: result.sale.reference,
      amountDecimal: stroopsToDecimal(result.sale.amountStroops),
      organizerAddress: event.organizer_pollar_id,
      expiresAtUtc: result.sale.expiresAtUtc,
      status: result.sale.status,
    },
    { status: 201 }
  );
}
