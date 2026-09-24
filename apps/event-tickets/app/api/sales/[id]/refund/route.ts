import { NextResponse } from "next/server";
import { requireAddress } from "@/lib/auth";
import { db, dbReady } from "@/lib/db";
import { findPaymentHashByMemo, verifyPaymentOnHorizon } from "@/lib/horizon";
import { stroopsToDecimal } from "@/lib/money";
import { enforce } from "@/lib/rate-limit";
import { markRefunded, refundMemo } from "@/lib/sales";
import { securityLog, shortAddressForLog } from "@/lib/security-log";

type Ctx = { params: Promise<{ id: string }> };

type SaleRow = {
  id: string;
  buyer_pollar_id: string;
  reference: string;
  amount_stroops: string;
  status: string;
  refund_tx_hash: string | null;
  organizer_pollar_id: string;
};

async function loadSale(id: string): Promise<SaleRow | null> {
  await dbReady();
  const result = await db.execute({
    sql: `SELECT sales.id, sales.buyer_pollar_id, sales.reference, sales.amount_stroops,
                 sales.status, sales.refund_tx_hash, events.organizer_pollar_id
          FROM sales JOIN events ON events.id = sales.event_id
          WHERE sales.id = ?`,
    args: [id],
  });
  return result.rows.length > 0 ? (result.rows[0] as unknown as SaleRow) : null;
}

/** Owner-only: what the organizer's refund payment must look like (the client builds it with `runTx`). */
export async function GET(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const sale = await loadSale(id);
  if (!sale) return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  const auth = requireAddress(request, sale.organizer_pollar_id);
  if (!auth.ok) return auth.response;
  if (sale.status !== "unclaimed") {
    return NextResponse.json({ error: "Esta venta no tiene un pago para devolver" }, { status: 409 });
  }
  return NextResponse.json({
    destination: sale.buyer_pollar_id,
    amountDecimal: stroopsToDecimal(BigInt(sale.amount_stroops)),
    memo: refundMemo(sale.reference),
  });
}

/**
 * Owner-only: records the refund of a late (`unclaimed`) payment. The
 * organizer sends it from their own Pollar wallet; this only verifies it on
 * Horizon — organizer -> buyer, same USDC amount, the refund memo — before
 * moving the sale to `refunded`. With no hash, looks it up by memo on the
 * buyer's account (e.g. the organizer's tab closed after paying).
 */
export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const sale = await loadSale(id);
  if (!sale) return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  const auth = requireAddress(request, sale.organizer_pollar_id);
  if (!auth.ok) return auth.response;

  const limited = await enforce("refundSale", auth.address, {
    actor: shortAddressForLog(auth.address),
  });
  if (limited) return limited;

  if (sale.status === "refunded") {
    return NextResponse.json({ status: "refunded", refundTxHash: sale.refund_tx_hash });
  }
  if (sale.status !== "unclaimed") {
    return NextResponse.json({ error: "Esta venta no tiene un pago para devolver" }, { status: 409 });
  }

  let body: { hash?: string } = {};
  try {
    body = (await request.json()) as { hash?: string };
  } catch {
    // Empty body = "ya devolví, verificar" (look the refund up by memo).
  }
  const memo = refundMemo(sale.reference);
  let hash = body.hash?.trim() ?? "";
  if (!hash) {
    const found = await findPaymentHashByMemo({ account: sale.buyer_pollar_id, memo });
    if (found === undefined) {
      return NextResponse.json({ error: "No pudimos consultar la red de Stellar." }, { status: 503 });
    }
    if (found === null) {
      return NextResponse.json(
        { error: "Todavía no vemos la devolución en la red.", code: "no_payment" },
        { status: 404 }
      );
    }
    hash = found;
  }

  const check = await verifyPaymentOnHorizon({
    hash,
    destination: sale.buyer_pollar_id,
    source: sale.organizer_pollar_id,
    amountDecimal: stroopsToDecimal(BigInt(sale.amount_stroops)),
    reference: memo,
  });
  if (!check.ok) {
    const status = check.code === "mismatch" ? 400 : check.code === "failed" ? 422 : 503;
    return NextResponse.json({ error: check.error }, { status });
  }

  await markRefunded(sale.id, hash);
  // Money leaving the organizer's account is worth a line in the log.
  securityLog("refund.recorded", { sale: sale.id, organizer: shortAddressForLog(auth.address) });
  return NextResponse.json({ status: "refunded", refundTxHash: hash });
}
