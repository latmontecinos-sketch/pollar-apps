import { NextResponse } from "next/server";
import { requireSignedAddress } from "@/lib/auth";
import { db, dbReady } from "@/lib/db";
import { salesClosed } from "@/lib/format";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/locales";
import { appOrigin, isDeliverableEmail, sendTicketEmail } from "@/lib/mail";
import { enforce } from "@/lib/rate-limit";
import { claimFreeTicket, generateReference } from "@/lib/sales";
import { maskEmail, shortAddressForLog } from "@/lib/security-log";
import { canView } from "@/lib/visibility";

const MAX_REFERENCE_ATTEMPTS = 5;

type Body = {
  eventId?: string;
  ticketTypeId?: string;
  idempotencyKey?: string;
  accessCode?: string;
  email?: string;
  locale?: string;
};

/**
 * A free tier's ticket, in one request: no sale to pay, no payment to
 * verify. The seat, the sale and the ticket are one transaction
 * (claimFreeTicket), limited to one per account per tier, and the answer is
 * the ticket itself — same shape as a confirmed paid sale.
 */
export async function POST(request: Request) {
  const auth = requireSignedAddress(request);
  if (!auth.ok) return auth.response;

  // Same quota as starting a paid checkout: it's the same act, minus the payment.
  const limited = await enforce("createSale", auth.address, { actor: shortAddressForLog(auth.address) });
  if (limited) return limited;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "JSON inválido", code: "invalid_json" }, { status: 400 });
  }
  const eventId = body.eventId?.trim() ?? "";
  const ticketTypeId = body.ticketTypeId?.trim() ?? "";
  const idempotencyKey = body.idempotencyKey?.trim() ?? "";
  if (!eventId) return NextResponse.json({ error: "Falta eventId", code: "missing_event_id" }, { status: 400 });
  if (!ticketTypeId) {
    return NextResponse.json({ error: "Falta el tipo de entrada", code: "ticket_type_not_found" }, { status: 400 });
  }
  if (!idempotencyKey) {
    return NextResponse.json({ error: "Falta idempotencyKey", code: "missing_idempotency_key" }, { status: 400 });
  }

  await dbReady();
  const found = await db.execute({
    sql: "SELECT name, datetime_utc, place, visibility, access_code FROM events WHERE id = ?",
    args: [eventId],
  });
  if (found.rows.length === 0) {
    return NextResponse.json({ error: "Evento no encontrado", code: "event_not_found" }, { status: 404 });
  }
  const event = found.rows[0] as unknown as {
    name: string;
    datetime_utc: string;
    place: string;
    visibility: string;
    access_code: string | null;
  };
  if (!canView(event, body.accessCode)) {
    return NextResponse.json(
      { error: "Evento privado: falta el código de acceso", code: "access_code_required" },
      { status: 403 }
    );
  }
  if (salesClosed(event.datetime_utc)) {
    return NextResponse.json({ error: "La venta de este evento ya cerró", code: "sale_closed" }, { status: 409 });
  }

  let result: Awaited<ReturnType<typeof claimFreeTicket>> | null = null;
  for (let attempt = 0; attempt < MAX_REFERENCE_ATTEMPTS; attempt++) {
    try {
      result = await claimFreeTicket({
        eventId,
        ticketTypeId,
        buyerPollarId: auth.address,
        reference: generateReference(),
        idempotencyKey,
      });
      break;
    } catch (err) {
      if (err instanceof Error && /UNIQUE/i.test(err.message) && /reference/i.test(err.message)) continue;
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
    const failures = {
      sold_out: { status: 409, error: "Evento agotado", code: "sold_out" },
      key_taken: { status: 409, error: "Esa reserva ya se usó", code: "key_taken" },
      not_free: { status: 409, error: "Esta entrada no es gratis", code: "not_free" },
    } as const;
    const failure = failures[result.reason];
    return NextResponse.json({ error: failure.error, code: failure.code }, { status: failure.status });
  }

  // Like a paid purchase: the copy by email, and the address kept for the
  // check-in notice. Only for a ticket issued now — asking again resends nothing.
  let emailed = false;
  const candidate = body.email?.trim() ?? "";
  if (!result.existing && isDeliverableEmail(candidate)) {
    const locale = isLocale(body.locale) ? body.locale : DEFAULT_LOCALE;
    await db.execute({
      sql: "UPDATE sales SET buyer_email = ?, buyer_locale = ? WHERE id = ?",
      args: [candidate, locale, result.saleId],
    });
    const mail = await sendTicketEmail({
      to: candidate,
      locale,
      origin: appOrigin(request),
      eventName: event.name,
      eventDateTime: event.datetime_utc,
      eventPlace: event.place,
      ticketCode: result.ticket.code,
      doorCode: result.ticket.doorCode,
    });
    emailed = mail.sent;
    if (!mail.sent) console.error(`[mail] ticket email to ${maskEmail(candidate)} failed: ${mail.error}`);
  }

  return NextResponse.json({
    status: "paid",
    ticket: { code: result.ticket.code, doorCode: result.ticket.doorCode },
    existing: result.existing,
    emailed,
  });
}
