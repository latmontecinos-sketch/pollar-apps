import { NextResponse } from "next/server";
import { requireSignedAddress } from "@/lib/auth";
import { db, dbReady } from "@/lib/db";
import { stroopsToDecimal } from "@/lib/money";

type Ctx = { params: Promise<{ id: string }> };

type SaleRow = {
  id: string;
  event_id: string;
  buyer_pollar_id: string;
  reference: string;
  amount_stroops: string;
  status: string;
  tx_hash: string | null;
  expires_at_utc: string;
  organizer_pollar_id: string;
};

type TicketRow = { code: string; door_code: string; used_at: string | null };

async function loadSale(id: string): Promise<SaleRow | null> {
  const result = await db.execute({
    sql: `SELECT sales.*, events.organizer_pollar_id
          FROM sales JOIN events ON events.id = sales.event_id
          WHERE sales.id = ?`,
    args: [id],
  });
  return result.rows.length > 0 ? (result.rows[0] as unknown as SaleRow) : null;
}

/** The buyer polls this for status; the organizer can look up their own sales too. Never leaks sale data to anyone else. */
export async function GET(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const auth = requireSignedAddress(request);
  if (!auth.ok) return auth.response;

  await dbReady();
  const sale = await loadSale(id);
  if (!sale) return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  if (auth.address !== sale.buyer_pollar_id && auth.address !== sale.organizer_pollar_id) {
    return NextResponse.json({ error: "No tenés acceso a esta venta" }, { status: 403 });
  }

  let ticket: TicketRow | null = null;
  if (sale.status === "paid" && auth.address === sale.buyer_pollar_id) {
    const ticketResult = await db.execute({
      sql: "SELECT code, door_code, used_at FROM tickets WHERE sale_id = ?",
      args: [id],
    });
    ticket = ticketResult.rows.length > 0 ? (ticketResult.rows[0] as unknown as TicketRow) : null;
  }

  return NextResponse.json({
    id: sale.id,
    status: sale.status,
    reference: sale.reference,
    amountDecimal: stroopsToDecimal(BigInt(sale.amount_stroops)),
    expiresAtUtc: sale.expires_at_utc,
    ticket: ticket
      ? { code: ticket.code, doorCode: ticket.door_code, usedAt: ticket.used_at }
      : null,
  });
}
