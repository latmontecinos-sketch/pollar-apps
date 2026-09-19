import { NextResponse } from "next/server";
import { requireAddress } from "@/lib/auth";
import { db, dbReady } from "@/lib/db";
import { sqlUtcToIso } from "@/lib/format";
import { stroopsToDecimal } from "@/lib/money";
import { sweepExpiredSales } from "@/lib/sales";

type Ctx = { params: Promise<{ id: string }> };

type EventRow = { organizer_pollar_id: string };

type SaleRow = {
  id: string;
  buyer_pollar_id: string;
  status: string;
  amount_stroops: string;
  tx_hash: string | null;
  created_at: string;
  used_at: string | null;
};

/** Owner-only: every sale ever made for this event, newest first, with whether its ticket already got in. */
export async function GET(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;

  await dbReady();
  const eventResult = await db.execute({
    sql: "SELECT organizer_pollar_id FROM events WHERE id = ?",
    args: [id],
  });
  if (eventResult.rows.length === 0) {
    return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  }
  const event = eventResult.rows[0] as unknown as EventRow;

  const auth = requireAddress(request, event.organizer_pollar_id);
  if (!auth.ok) return auth.response;

  await sweepExpiredSales({ eventId: id });

  const result = await db.execute({
    sql: `SELECT sales.id, sales.buyer_pollar_id, sales.status, sales.amount_stroops,
                 sales.tx_hash, sales.created_at, tickets.used_at
          FROM sales LEFT JOIN tickets ON tickets.sale_id = sales.id
          WHERE sales.event_id = ? ORDER BY sales.created_at DESC`,
    args: [id],
  });

  const rows = result.rows as unknown as SaleRow[];
  const sales = rows.map((row) => ({
    id: row.id,
    buyerPollarId: row.buyer_pollar_id,
    status: row.status,
    amountDecimal: stroopsToDecimal(BigInt(row.amount_stroops)),
    txHash: row.tx_hash,
    createdAt: sqlUtcToIso(row.created_at),
    usedAt: sqlUtcToIso(row.used_at),
  }));

  const paidTotal = rows
    .filter((row) => row.status === "paid")
    .reduce((sum, row) => sum + BigInt(row.amount_stroops), 0n);

  return NextResponse.json({
    sales,
    paidTotalDecimal: stroopsToDecimal(paidTotal),
    checkedIn: rows.filter((row) => row.used_at !== null).length,
  });
}
