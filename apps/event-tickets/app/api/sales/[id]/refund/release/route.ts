import { NextResponse } from "next/server";
import { requireAddress } from "@/lib/auth";
import { enforce } from "@/lib/rate-limit";
import { loadRefundSale } from "@/lib/refund";
import { reopenRefund } from "@/lib/sales";
import { shortAddressForLog } from "@/lib/security-log";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The organizer's tab won the refund claim and then the SDK refused before
 * sending anything (no wallet, a fee above the cap, the person cancelling in
 * their wallet): hand the claim back so the refund can be tried again.
 *
 * Compare-and-swap on the attempt the caller names (`startedAt`, the value the
 * claim returned): a late "release" from an old attempt can't undo a newer
 * one. A tab that lost the claim never calls this.
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

  let startedAt = "";
  try {
    const body = (await request.json()) as { startedAt?: unknown };
    startedAt = typeof body.startedAt === "string" ? body.startedAt : "";
  } catch {
    // No body: nothing to name, nothing to release.
  }
  if (!startedAt) {
    return NextResponse.json({ error: "JSON inválido", code: "invalid_json" }, { status: 400 });
  }
  return NextResponse.json({ released: await reopenRefund(id, auth.address, startedAt) });
}
