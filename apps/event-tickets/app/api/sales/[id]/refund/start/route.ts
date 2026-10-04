import { NextResponse } from "next/server";
import { requireAddress } from "@/lib/auth";
import { attemptState } from "@/lib/pay-attempt";
import { enforce } from "@/lib/rate-limit";
import { findRefund, loadRefundSale, refundPlan } from "@/lib/refund";
import { claimRefund, reopenRefund, type RefundClaim } from "@/lib/sales";
import { shortAddressForLog } from "@/lib/security-log";

type Ctx = { params: Promise<{ id: string }> };

/**
 * "I am about to send this refund." Exactly one caller wins (`claimRefund`, one
 * conditional UPDATE), so a second tab or device, or a page that loaded its
 * plan minutes ago, can never send a second transfer: it loses, and goes to
 * reconcile with the chain.
 *
 * Order matters: the claim is taken first and the chain searched after, so no
 * one can start sending between the search and the claim. A refund already on
 * the chain answers `refund_already_sent` (the claim stays: recording it is
 * what finishes the job). An attempt whose transaction is dead and that left
 * nothing on the chain is taken over.
 */
export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const sale = await loadRefundSale(id);
  if (!sale) {
    return NextResponse.json({ error: "No encontrado", code: "sale_not_found" }, { status: 404 });
  }
  const auth = requireAddress(request, sale.organizer_pollar_id);
  if (!auth.ok) return auth.response;

  const limited = await enforce("refundStart", auth.address, { actor: shortAddressForLog(auth.address) });
  if (limited) return limited;

  const unreachable = NextResponse.json(
    { error: "No pudimos consultar la red de Stellar.", code: "horizon_unreachable" },
    { status: 503 }
  );

  let claim: RefundClaim = await claimRefund(id, auth.address);

  if (claim.outcome === "held" && attemptState(claim.startedAt, Date.now()) === "dead") {
    // Someone started it and its transaction can no longer land. Before
    // taking over, make sure it left nothing behind.
    const found = await findRefund(sale);
    if (found.status === "inconclusive") return unreachable;
    if (found.status === "found") {
      return NextResponse.json(
        { error: "Ya enviaste esta devolución.", code: "refund_already_sent", hash: found.hash },
        { status: 409 }
      );
    }
    if (await reopenRefund(id, auth.address, claim.startedAt)) {
      claim = await claimRefund(id, auth.address);
    }
  }

  switch (claim.outcome) {
    case "won": {
      const existing = await findRefund(sale);
      if (existing.status === "inconclusive") {
        // Nothing was sent: hand the claim back so a retry isn't locked out.
        await reopenRefund(id, auth.address, claim.startedAt);
        return unreachable;
      }
      if (existing.status === "found") {
        return NextResponse.json(
          { error: "Ya enviaste esta devolución.", code: "refund_already_sent", hash: existing.hash },
          { status: 409 }
        );
      }
      return NextResponse.json({ claimed: true, startedAt: claim.startedAt, ...refundPlan(sale) });
    }
    case "held":
      return NextResponse.json(
        {
          error: "Esta devolución ya se está enviando.",
          code: "refund_already_started",
          startedAt: claim.startedAt,
        },
        { status: 409 }
      );
    case "not_unclaimed":
      return NextResponse.json(
        { error: "Esta venta no tiene un pago para devolver", code: "sale_not_unclaimed" },
        { status: 409 }
      );
    case "forbidden":
      return NextResponse.json({ error: "No tienes acceso a esta venta", code: "forbidden" }, { status: 403 });
    case "not_found":
      return NextResponse.json({ error: "No encontrado", code: "sale_not_found" }, { status: 404 });
  }
}
