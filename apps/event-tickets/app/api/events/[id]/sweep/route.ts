import { NextResponse } from "next/server";
import { requireAddress } from "@/lib/auth";
import { db, dbReady } from "@/lib/db";
import { sweepExpiredSales } from "@/lib/sales";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Idempotent sweep: resolves `pending` sales whose window expired (buyer
 * closed the tab, never paid). The same sweep also runs on its own from the
 * public page and before every new sale; this owner-only route just lets
 * the organizer panel force it before reading its numbers.
 */
export async function POST(request: Request, ctx: Ctx) {
  const { id: eventId } = await ctx.params;
  await dbReady();

  const eventRow = await db.execute({
    sql: "SELECT organizer_pollar_id FROM events WHERE id = ?",
    args: [eventId],
  });
  if (eventRow.rows.length === 0) {
    return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  }

  const auth = requireAddress(request, String(eventRow.rows[0].organizer_pollar_id));
  if (!auth.ok) return auth.response;

  const expired = await sweepExpiredSales({ eventId });
  return NextResponse.json({ expired });
}
