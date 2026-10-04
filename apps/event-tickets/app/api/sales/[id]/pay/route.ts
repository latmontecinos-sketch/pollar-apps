import { NextResponse } from "next/server";
import { requireSignedAddress } from "@/lib/auth";
import { enforce } from "@/lib/rate-limit";
import { txSecondsLeft } from "@/lib/pay-attempt";
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
 * a rejection the winner proves (`/release`, which needs the claim token only
 * this answer carries) or the attempt's transaction dying (lib/pay-attempt.ts).
 *
 * The winning answer carries `remainingSec`, the transaction lifetime left on
 * THIS server's clock: the winner bounds the transaction it builds to it
 * (`sendWindowSec`), so a tab that sat on this answer for minutes cannot build
 * a transaction that outlives the attempt's deadline. A losing answer says
 * nothing but that someone started: no timestamp, no token.
 *
 * Deliberately no `canView` here: a reservation made with access to a private
 * (or since-privatised) event keeps it through to payment. The access code is
 * checked when the seat is reserved (POST /api/sales), and revoking it after
 * that does not strand a buyer who already holds a seat. See docs/SEGURIDAD.md.
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
      return NextResponse.json({
        claimed: true,
        startedAt: claim.startedAt,
        claimToken: claim.claimToken,
        remainingSec: txSecondsLeft(Date.parse(claim.startedAt), Date.now()),
      });
    case "held":
      return NextResponse.json(
        { error: "Ya hay un pago en curso para esta reserva.", code: "pay_already_started" },
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
