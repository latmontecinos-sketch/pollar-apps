import { NextResponse } from "next/server";
import { requireAddress } from "@/lib/auth";
import { verifyPaymentOnHorizon } from "@/lib/horizon";
import { stroopsToDecimal } from "@/lib/money";
import { attemptState } from "@/lib/pay-attempt";
import { enforce } from "@/lib/rate-limit";
import { findRefund, loadRefundSale, refundPlan } from "@/lib/refund";
import { markRefunded, refundMemo, reopenRefund } from "@/lib/sales";
import { securityLog, shortAddressForLog } from "@/lib/security-log";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Owner-only: what the organizer's refund payment would look like, for the
 * confirmation screen. It decides nothing and sends nothing: the right to send
 * is taken by `POST …/refund/start`, which is also where the chain is searched
 * for a refund already on its way. So this is a plain read, with no Horizon
 * call, and it carries no quota of its own (the rule that every writing
 * endpoint enforces one is about writes; browsing a plan writes nothing).
 *
 * `started` tells the screen that someone already took the refund: it goes to
 * reconcile with the chain instead of offering to send.
 */
export async function GET(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const sale = await loadRefundSale(id);
  if (!sale) {
    return NextResponse.json({ error: "No encontrado", code: "sale_not_found" }, { status: 404 });
  }
  const auth = requireAddress(request, sale.organizer_pollar_id);
  if (!auth.ok) return auth.response;
  if (sale.status !== "unclaimed") {
    return NextResponse.json(
      { error: "Esta venta no tiene un pago para devolver", code: "sale_not_unclaimed" },
      { status: 409 }
    );
  }
  return NextResponse.json({ ...refundPlan(sale), started: sale.refund_started_at !== null });
}

/**
 * Owner-only: records the refund of a late (`unclaimed`) payment. The
 * organizer sends it from their own Pollar wallet; this only verifies it on
 * Horizon — organizer -> buyer, same USDC amount, the refund memo — before
 * moving the sale to `refunded`. With no hash, looks it up by memo on the
 * buyer's account (e.g. the organizer's tab closed after paying).
 *
 * When nothing is on the chain it also says whether the refund may be tried
 * again (`retryable`): never nobody-sent from a clock in the browser, but the
 * server's own reading of the attempt (lib/pay-attempt.ts), and it takes over
 * a dead attempt in the same breath.
 *
 * Its quota (`refundRecord`) is its own and generous: by the time this is
 * called money may already have left, and plan browsing or an earlier retry
 * must not be what stops it being recorded.
 */
export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const sale = await loadRefundSale(id);
  if (!sale) {
    return NextResponse.json({ error: "No encontrado", code: "sale_not_found" }, { status: 404 });
  }
  const auth = requireAddress(request, sale.organizer_pollar_id);
  if (!auth.ok) return auth.response;

  const limited = await enforce("refundRecord", auth.address, {
    actor: shortAddressForLog(auth.address),
  });
  if (limited) return limited;

  if (sale.status === "refunded") {
    return NextResponse.json({ status: "refunded", refundTxHash: sale.refund_tx_hash });
  }
  if (sale.status !== "unclaimed") {
    return NextResponse.json(
      { error: "Esta venta no tiene un pago para devolver", code: "sale_not_unclaimed" },
      { status: 409 }
    );
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
    const found = await findRefund(sale);
    if (found.status === "inconclusive") {
      return NextResponse.json(
        { error: "No pudimos consultar la red de Stellar.", code: "horizon_unreachable" },
        { status: 503 }
      );
    }
    if (found.status === "none") {
      // Not on the chain. If the attempt that started it is dead (its
      // transaction can no longer be accepted), hand it back so the refund can
      // be started again; if it is still alive, it may yet land.
      const state = attemptState(sale.refund_started_at, Date.now());
      let retryable = state === "none";
      if (state === "dead" && sale.refund_started_at !== null) {
        retryable = await reopenRefund(sale.id, auth.address, sale.refund_started_at);
      }
      return NextResponse.json(
        { error: "Todavía no vemos la devolución en la red.", code: "no_payment", retryable },
        { status: 404 }
      );
    }
    hash = found.hash;
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
    const code =
      check.code === "mismatch" ? "payment_mismatch" : check.code === "failed" ? "tx_failed" : "horizon_unreachable";
    return NextResponse.json({ error: check.error, code }, { status });
  }

  await markRefunded(sale.id, hash);
  // Money leaving the organizer's account is worth a line in the log.
  securityLog("refund.recorded", { sale: sale.id, organizer: shortAddressForLog(auth.address) });
  return NextResponse.json({ status: "refunded", refundTxHash: hash });
}
