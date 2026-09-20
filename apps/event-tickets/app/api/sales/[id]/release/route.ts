import { NextResponse } from "next/server";
import { requireSignedAddress } from "@/lib/auth";
import { db, dbReady } from "@/lib/db";
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
 */
export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const auth = requireSignedAddress(request);
  if (!auth.ok) return auth.response;

  await dbReady();
  const result = await db.execute({
    sql: "SELECT buyer_pollar_id, status FROM sales WHERE id = ?",
    args: [id],
  });
  if (result.rows.length === 0) {
    return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  }
  if (String(result.rows[0].buyer_pollar_id) !== auth.address) {
    return NextResponse.json({ error: "No tienes acceso a esta venta" }, { status: 403 });
  }

  const { expired } = await expireSale(id);
  return NextResponse.json({ released: expired });
}
