import { NextResponse } from "next/server";
import { requireSignedAddress } from "@/lib/auth";
import { db, dbReady } from "@/lib/db";
import { salesClosed } from "@/lib/format";
import { decimalToStroops, stroopsToDecimal } from "@/lib/money";
import { usdcAsset } from "@/lib/network";
import { generateReference, reserveAndCreateSale, sweepExpiredSales } from "@/lib/sales";
import { listTicketTypes } from "@/lib/ticket-types";
import { enforce } from "@/lib/rate-limit";
import { shortAddressForLog } from "@/lib/security-log";
import { canView } from "@/lib/visibility";

/** How long a seat stays held while the buyer pays (mirrors `t.hold.minutes`). */
const SALE_TTL_MS = 10 * 60 * 1000;
const MAX_REFERENCE_ATTEMPTS = 5;

type CreateSaleBody = {
  eventId?: string;
  ticketTypeId?: string;
  idempotencyKey?: string;
  /** A private event's access code (lib/visibility.ts). */
  accessCode?: string;
};

type EventRow = {
  organizer_pollar_id: string;
  datetime_utc: string;
  visibility: string;
  access_code: string | null;
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

  const limited = await enforce("createSale", auth.address, {
    actor: shortAddressForLog(auth.address),
  });
  if (limited) return limited;

  let body: CreateSaleBody;
  try {
    body = (await request.json()) as CreateSaleBody;
  } catch {
    return NextResponse.json({ error: "JSON inválido", code: "invalid_json" }, { status: 400 });
  }

  const eventId = body.eventId?.trim() ?? "";
  const idempotencyKey = body.idempotencyKey?.trim() ?? "";
  if (!eventId) {
    return NextResponse.json({ error: "Falta eventId", code: "missing_event_id" }, { status: 400 });
  }
  if (!idempotencyKey) {
    return NextResponse.json(
      { error: "Falta idempotencyKey", code: "missing_idempotency_key" },
      { status: 400 }
    );
  }

  await dbReady();
  const eventResult = await db.execute({
    sql: "SELECT organizer_pollar_id, datetime_utc, visibility, access_code FROM events WHERE id = ?",
    args: [eventId],
  });
  if (eventResult.rows.length === 0) {
    return NextResponse.json({ error: "Evento no encontrado", code: "event_not_found" }, { status: 404 });
  }
  const event = eventResult.rows[0] as unknown as EventRow;
  // A private event sells only to whoever has its code, not to whoever has its id.
  if (!canView(event, body.accessCode)) {
    return NextResponse.json(
      { error: "Evento privado: falta el código de acceso", code: "access_code_required" },
      { status: 403 }
    );
  }
  if (salesClosed(event.datetime_utc)) {
    return NextResponse.json(
      { error: "La venta de este evento ya cerró", code: "sale_closed" },
      { status: 409 }
    );
  }

  // The tier decides the price — never a number the client sends.
  const types = await listTicketTypes(eventId);
  const ticketType = body.ticketTypeId
    ? types.find((type) => type.id === body.ticketTypeId)
    : types[0];
  if (!ticketType) {
    return NextResponse.json(
      { error: "Tipo de entrada no encontrado", code: "ticket_type_not_found" },
      { status: 404 }
    );
  }
  const amountStroops = decimalToStroops(ticketType.priceDecimal);
  // Nothing to pay means nothing to verify: free tiers go through /api/sales/free.
  if (amountStroops === 0n) {
    return NextResponse.json({ error: "Esta entrada es gratis", code: "free_tier" }, { status: 409 });
  }

  // Free up seats held by abandoned checkouts before deciding it's sold out.
  await sweepExpiredSales({ eventId });

  let result: Awaited<ReturnType<typeof reserveAndCreateSale>> | null = null;
  for (let attempt = 0; attempt < MAX_REFERENCE_ATTEMPTS; attempt++) {
    try {
      result = await reserveAndCreateSale({
        eventId,
        ticketTypeId: ticketType.id,
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
    return NextResponse.json(
      { error: "No se pudo generar una referencia única", code: "reference_generation_failed" },
      { status: 500 }
    );
  }
  if (!result.ok) {
    return result.reason === "key_taken"
      ? NextResponse.json(
          { error: "Esa reserva ya se usó. Recarga la página e intenta de nuevo.", code: "key_taken" },
          { status: 409 }
        )
      : NextResponse.json({ error: "Evento agotado", code: "sold_out" }, { status: 409 });
  }

  return NextResponse.json(
    {
      id: result.sale.id,
      reference: result.sale.reference,
      amountDecimal: stroopsToDecimal(result.sale.amountStroops),
      organizerAddress: event.organizer_pollar_id,
      // The sale names its own asset. Before this, the response said "pay
      // 10.00 to G…" and the client chose *what* to pay with from the first
      // non-native balance its wallet listed — so the one thing the server
      // verifies afterwards (that it was this USDC, from this issuer) was
      // the one thing the client was left to guess.
      asset: usdcAsset(),
      ticketTypeId: ticketType.id,
      ticketTypeName: ticketType.name,
      expiresAtUtc: result.sale.expiresAtUtc,
      status: result.sale.status,
    },
    { status: 201 }
  );
}
