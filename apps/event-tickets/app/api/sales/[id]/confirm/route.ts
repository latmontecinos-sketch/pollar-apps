import { NextResponse } from "next/server";
import { requireSignedAddress } from "@/lib/auth";
import { db, dbReady } from "@/lib/db";
import { stroopsToDecimal } from "@/lib/money";
import { verifyPaymentOnHorizon } from "@/lib/horizon";
import { settlePayment } from "@/lib/sales";

type Ctx = { params: Promise<{ id: string }> };

type SaleRow = {
  id: string;
  event_id: string;
  buyer_pollar_id: string;
  reference: string;
  amount_stroops: string;
  status: string;
  organizer_pollar_id: string;
};

/**
 * The buyer submits the hash of the payment they just sent. We verify it
 * against Horizon (real testnet chain state, not anything the client
 * asserts) before ever marking the sale paid or issuing a ticket. A Horizon
 * failure (network, not-yet-indexed) is a 503 the client should retry —
 * never a "payment rejected".
 */
export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const auth = requireSignedAddress(request);
  if (!auth.ok) return auth.response;

  await dbReady();
  const result = await db.execute({
    sql: `SELECT sales.*, events.organizer_pollar_id
          FROM sales JOIN events ON events.id = sales.event_id
          WHERE sales.id = ?`,
    args: [id],
  });
  if (result.rows.length === 0) {
    return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  }
  const sale = result.rows[0] as unknown as SaleRow;
  if (auth.address !== sale.buyer_pollar_id) {
    return NextResponse.json({ error: "No tenés acceso a esta venta" }, { status: 403 });
  }

  let body: { hash?: string };
  try {
    body = (await request.json()) as { hash?: string };
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }
  const hash = body.hash?.trim() ?? "";
  if (!hash) return NextResponse.json({ error: "Falta el hash de la transacción" }, { status: 400 });

  const check = await verifyPaymentOnHorizon({
    hash,
    organizerAddress: sale.organizer_pollar_id,
    amountDecimal: stroopsToDecimal(BigInt(sale.amount_stroops)),
    reference: sale.reference,
  });
  if (!check.ok) {
    const status = check.code === "mismatch" ? 400 : 503;
    return NextResponse.json({ error: check.error }, { status });
  }

  const settled = await settlePayment(sale.id, sale.event_id, hash);
  switch (settled.outcome) {
    case "paid":
    case "already_paid":
      return NextResponse.json({
        status: "paid",
        ticket: { code: settled.ticket.code, doorCode: settled.ticket.doorCode },
      });
    case "unclaimed":
      return NextResponse.json(
        {
          status: "unclaimed",
          error:
            "El pago llegó, pero la reserva ya había expirado. Contactá al organizador con el hash de la transacción.",
        },
        { status: 409 }
      );
    case "no_match":
      return NextResponse.json({ error: "La venta no está en un estado válido" }, { status: 409 });
  }
}
