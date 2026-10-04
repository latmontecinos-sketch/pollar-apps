import { NextResponse } from "next/server";
import { requireSignedAddress } from "@/lib/auth";
import { db, dbReady } from "@/lib/db";
import { enforce } from "@/lib/rate-limit";
import { shortAddressForLog } from "@/lib/security-log";
import { expireSale } from "@/lib/sales";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The buyer gives their held seat back: they cancelled the review step, or
 * the payment was rejected before reaching the network. Without this the
 * seat would sit "reserved" for the full window and the event could look
 * sold out while nobody actually bought — exactly what happens when a
 * wallet has no XLM for fees.
 *
 * Only ever `pending` -> `expired`, and only for the buyer's own sale: a
 * paid sale can't be released this way.
 *
 * The one caller after a payment attempt started is the tab that won the
 * claim (`/pay`) and then saw the SDK refuse before sending anything. A tab
 * that lost the claim never calls this. If a stale or wrong call ever did
 * release a sale whose payment then landed, the payment settles as
 * `unclaimed` and goes through the refund flow: money is not lost, it is
 * refunded.
 */
export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const auth = requireSignedAddress(request);
  if (!auth.ok) return auth.response;

  const limited = await enforce("releaseSale", auth.address, { actor: shortAddressForLog(auth.address) });
  if (limited) return limited;

  await dbReady();
  const result = await db.execute({
    sql: "SELECT buyer_pollar_id, status FROM sales WHERE id = ?",
    args: [id],
  });
  if (result.rows.length === 0) {
    return NextResponse.json({ error: "No encontrado", code: "sale_not_found" }, { status: 404 });
  }
  if (String(result.rows[0].buyer_pollar_id) !== auth.address) {
    return NextResponse.json(
      { error: "No tienes acceso a esta venta", code: "forbidden" },
      { status: 403 }
    );
  }

  const { expired } = await expireSale(id);
  return NextResponse.json({ released: expired });
}
