import { NextResponse } from "next/server";
import { requireSignedAddress } from "@/lib/auth";
import { db, dbReady } from "@/lib/db";
import { stroopsToDecimal } from "@/lib/money";
import { findPaymentHashByMemo, verifyPaymentOnHorizon } from "@/lib/horizon";
import { settlePayment } from "@/lib/sales";
import { sendTicketEmail } from "@/lib/mail";

type Ctx = { params: Promise<{ id: string }> };

type SaleRow = {
  id: string;
  event_id: string;
  buyer_pollar_id: string;
  reference: string;
  amount_stroops: string;
  status: string;
  organizer_pollar_id: string;
  event_name: string;
  event_datetime_utc: string;
  event_place: string;
};

/**
 * The buyer submits the hash of the payment they just sent — or no hash at
 * all ("Ya pagué, verificar"), in which case we look the payment up on
 * Horizon by this sale's unique memo. Either way it's verified against
 * Horizon (real testnet chain state, not anything the client asserts)
 * before ever marking the sale paid or issuing a ticket. A Horizon failure
 * (network, not-yet-indexed) is a 503 the client should retry — never a
 * "payment rejected".
 */
export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const auth = requireSignedAddress(request);
  if (!auth.ok) return auth.response;

  await dbReady();
  const result = await db.execute({
    sql: `SELECT sales.*, events.organizer_pollar_id, events.name AS event_name,
                 events.datetime_utc AS event_datetime_utc, events.place AS event_place
          FROM sales JOIN events ON events.id = sales.event_id
          WHERE sales.id = ?`,
    args: [id],
  });
  if (result.rows.length === 0) {
    return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  }
  const sale = result.rows[0] as unknown as SaleRow;
  if (auth.address !== sale.buyer_pollar_id) {
    return NextResponse.json({ error: "No tienes acceso a esta venta" }, { status: 403 });
  }

  let body: { hash?: string; email?: string };
  try {
    body = (await request.json()) as { hash?: string; email?: string };
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }
  const email = body.email?.trim() ?? "";
  let hash = body.hash?.trim() ?? "";

  if (!hash) {
    const found = await findPaymentHashByMemo({
      account: sale.organizer_pollar_id,
      memo: sale.reference,
    });
    if (found === undefined) {
      return NextResponse.json(
        { error: "No pudimos consultar la red de Stellar. Intenta de nuevo en un momento." },
        { status: 503 }
      );
    }
    if (found === null) {
      return NextResponse.json(
        { error: "Todavía no vemos ningún pago para esta reserva.", code: "no_payment" },
        { status: 404 }
      );
    }
    hash = found;
  }

  const check = await verifyPaymentOnHorizon({
    hash,
    destination: sale.organizer_pollar_id,
    amountDecimal: stroopsToDecimal(BigInt(sale.amount_stroops)),
    reference: sale.reference,
  });
  if (!check.ok) {
    if (check.code === "failed") {
      // A failed Stellar tx applies no operations: the buyer wasn't charged.
      return NextResponse.json(
        {
          error: "La red de Stellar rechazó la transacción, así que no se te cobró. Puedes intentar de nuevo.",
          code: "tx_failed",
        },
        { status: 422 }
      );
    }
    const status = check.code === "mismatch" ? 400 : 503;
    return NextResponse.json({ error: check.error }, { status });
  }

  const settled = await settlePayment(sale.id, sale.event_id, hash);
  switch (settled.outcome) {
    case "paid":
    case "already_paid": {
      // Only on the first settlement: a replay (retry, "verificar" again)
      // must not send the buyer a second copy of the same ticket.
      if (email && settled.outcome === "paid") {
        // Best-effort: the ticket already lives in the buyer's own account
        // either way, so a failed send doesn't get retried or block anything.
        const mailResult = await sendTicketEmail({
          to: email,
          eventName: sale.event_name,
          eventDateTime: sale.event_datetime_utc,
          eventPlace: sale.event_place,
          ticketCode: settled.ticket.code,
          doorCode: settled.ticket.doorCode,
        });
        if (!mailResult.sent) {
          console.error(`[mail] ticket email to ${email} failed: ${mailResult.error}`);
        }
      }
      return NextResponse.json({
        status: "paid",
        ticket: { code: settled.ticket.code, doorCode: settled.ticket.doorCode },
      });
    }
    case "unclaimed":
      return NextResponse.json(
        {
          status: "unclaimed",
          error:
            "El pago llegó, pero la reserva ya había expirado. Contacta al organizador con el comprobante de la transacción.",
        },
        { status: 409 }
      );
    case "no_match":
      return NextResponse.json({ error: "La venta no está en un estado válido" }, { status: 409 });
  }
}
