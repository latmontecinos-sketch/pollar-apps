import { NextResponse } from "next/server";
import { requireAddress } from "@/lib/auth";
import { db, dbReady } from "@/lib/db";
import { stroopsToDecimal } from "@/lib/money";

type Ctx = { params: Promise<{ id: string }> };

type EventRow = { organizer_pollar_id: string };

type SaleRow = {
  id: string;
  buyer_pollar_id: string;
  status: string;
  amount_stroops: string;
  tx_hash: string | null;
  created_at: string;
};

/** Owner-only: every sale ever made for this event, newest first. */
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

  const result = await db.execute({
    sql: `SELECT id, buyer_pollar_id, status, amount_stroops, tx_hash, created_at
          FROM sales WHERE event_id = ? ORDER BY created_at DESC`,
    args: [id],
  });

  const sales = (result.rows as unknown as SaleRow[]).map((row) => ({
    id: row.id,
    buyerPollarId: row.buyer_pollar_id,
    status: row.status,
    amountDecimal: stroopsToDecimal(BigInt(row.amount_stroops)),
    txHash: row.tx_hash,
    createdAt: row.created_at,
  }));

  const paidTotal = (result.rows as unknown as SaleRow[])
    .filter((row) => row.status === "paid")
    .reduce((sum, row) => sum + BigInt(row.amount_stroops), 0n);

  return NextResponse.json({ sales, paidTotalDecimal: stroopsToDecimal(paidTotal) });
}
