import { NextResponse } from "next/server";
import { requireSignedAddress } from "@/lib/auth";
import { enforce } from "@/lib/rate-limit";
import { claimPayment } from "@/lib/sales";
import { shortAddressForLog } from "@/lib/security-log";

type Ctx = { params: Promise<{ id: string }> };

/**
 * "I am about to pay this reservation." Exactly one caller wins, however many
 * tabs, devices or taps ask: the answer is one conditional UPDATE
 * (`claimPayment`), not anything the browser decided. Only the winner sends
 * the payment; everyone else gets `pay_already_started` and goes to look for
 * the winner's payment by memo, never to pay.
 *
 * The claim is never handed back by the clock. It frees the seat only through
 * a rejection the winner proves (`/release`) or the attempt's transaction
 * dying (lib/pay-attempt.ts).
 */
export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const auth = requireSignedAddress(request);
  if (!auth.ok) return auth.response;

  const limited = await enforce("payStart", auth.address, { actor: shortAddressForLog(auth.address) });
  if (limited) return limited;

  const claim = await claimPayment(id, auth.address);
  switch (claim.outcome) {
    case "won":
      return NextResponse.json({ claimed: true, startedAt: claim.startedAt });
    case "held":
      return NextResponse.json(
        {
          error: "Ya hay un pago en curso para esta reserva.",
          code: "pay_already_started",
          startedAt: claim.startedAt,
        },
        { status: 409 }
      );
    case "not_pending":
    case "expired":
      return NextResponse.json(
        {
          error: "Esa reserva ya no está activa. Recarga la página e intenta de nuevo.",
          code: "sale_not_pending",
          // A `paid` or `unclaimed` sale has a payment behind it: the caller verifies it instead of retrying.
          saleStatus: claim.outcome === "not_pending" ? claim.status : "expired",
        },
        { status: 409 }
      );
    case "forbidden":
      return NextResponse.json({ error: "No tienes acceso a esta venta", code: "forbidden" }, { status: 403 });
    case "not_found":
      return NextResponse.json({ error: "No encontrado", code: "sale_not_found" }, { status: 404 });
  }
}
