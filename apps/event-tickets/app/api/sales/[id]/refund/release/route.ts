import { NextResponse } from "next/server";
import { requireAddress } from "@/lib/auth";
import { enforce } from "@/lib/rate-limit";
import { loadRefundSale } from "@/lib/refund";
import { releaseRefundClaim } from "@/lib/sales";
import { shortAddressForLog } from "@/lib/security-log";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The organizer's tab won the refund claim and then the SDK refused before
 * sending anything (no wallet, a fee above the cap, the person cancelling in
 * their wallet): hand the claim back so the refund can be tried again.
 *
 * Needs the attempt's `startedAt` (compare-and-swap: a late "release" from an
 * old attempt can't undo a newer one) AND the `claimToken` that only the
 * winning `/refund/start` answer carried. A tab that lost the claim has
 * neither the token nor any reason to call this; the timestamp alone is not
 * identity, and another organizer session must not be able to reopen a refund
 * whose transfer is on its way. The winner's "it never left" is its own
 * classification (`classifySubmit`); that is acceptable because only the
 * winner holds the token, and the next claim still searches the chain.
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
  let claimToken = "";
  try {
    const body = (await request.json()) as { startedAt?: unknown; claimToken?: unknown };
    startedAt = typeof body.startedAt === "string" ? body.startedAt : "";
    claimToken = typeof body.claimToken === "string" ? body.claimToken : "";
  } catch {
    // No body: nothing to name, nothing to release.
  }
  if (!startedAt || !claimToken) {
    return NextResponse.json({ error: "JSON inválido", code: "invalid_json" }, { status: 400 });
  }
  return NextResponse.json({ released: await releaseRefundClaim(id, auth.address, startedAt, claimToken) });
}
