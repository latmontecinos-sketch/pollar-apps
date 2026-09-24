import { NextResponse } from "next/server";
import { requireAddress } from "@/lib/auth";
import { discardCapacityCode, requestCapacityCode } from "@/lib/capacity-code";
import { db, dbReady } from "@/lib/db";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/locales";
import { isDeliverableEmail, sendCapacityCodeEmail } from "@/lib/mail";
import { enforce } from "@/lib/rate-limit";
import { maskEmail, shortAddressForLog } from "@/lib/security-log";

type Ctx = { params: Promise<{ id: string }> };

type Body = { ticketTypeId?: string; capacity?: number; email?: string; locale?: string };

const ERRORS = {
  capacity_lower: { status: 400, error: "El cupo nuevo tiene que ser mayor al actual" },
  capacity_limit: { status: 400, error: "El cupo no puede pasar de 100.000" },
  not_found: { status: 404, error: "Ese tipo de entrada no existe", code: "ticket_type_not_found" },
  email_required: { status: 400, error: "Falta un correo para mandar el código" },
} as const;

/**
 * Owner-only, step one of a capacity increase: emails a six-digit code bound
 * to this exact change. Step two is PATCH /api/events/[id] with the code.
 * The answer names where the code went only masked (`l…@gmail.com`).
 */
export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  await dbReady();
  const found = await db.execute({
    sql: "SELECT organizer_pollar_id, name FROM events WHERE id = ?",
    args: [id],
  });
  if (found.rows.length === 0) {
    return NextResponse.json({ error: "No encontrado", code: "event_not_found" }, { status: 404 });
  }
  const auth = requireAddress(request, String(found.rows[0].organizer_pollar_id));
  if (!auth.ok) return auth.response;

  // Each request sends an email and opens a fresh set of guesses: both are
  // what a ceiling is for.
  const limited = await enforce("capacityCode", auth.address, { actor: shortAddressForLog(auth.address) });
  if (limited) return limited;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "JSON inválido", code: "invalid_json" }, { status: 400 });
  }
  if (!body.ticketTypeId) {
    return NextResponse.json(
      { error: "Falta el tipo de entrada", code: "ticket_type_not_found" },
      { status: 400 }
    );
  }
  const offered = body.email?.trim().toLowerCase() ?? "";

  const issued = await requestCapacityCode({
    eventId: id,
    ticketTypeId: body.ticketTypeId,
    capacity: Number(body.capacity),
    organizer: auth.address,
    offeredEmail: offered && isDeliverableEmail(offered) ? offered : null,
  });
  if (!issued.ok) {
    const failure = ERRORS[issued.code];
    return NextResponse.json(
      { error: failure.error, code: "code" in failure ? failure.code : issued.code },
      { status: failure.status }
    );
  }

  const sent = await sendCapacityCodeEmail({
    to: issued.email,
    locale: isLocale(body.locale) ? body.locale : DEFAULT_LOCALE,
    eventName: String(found.rows[0].name),
    tierName: issued.tierName,
    capacity: Number(body.capacity),
    code: issued.code,
  });
  if (!sent.sent) {
    // A code nobody received shouldn't sit there with guesses left on it.
    await discardCapacityCode(issued.challengeId);
    console.error(`[mail] capacity code to ${maskEmail(issued.email)} failed: ${sent.error}`);
    return NextResponse.json(
      { error: "No pudimos enviar el código por correo", code: "email_failed" },
      { status: 502 }
    );
  }

  return NextResponse.json({ challengeId: issued.challengeId, sentTo: maskEmail(issued.email) });
}
