import { NextResponse } from "next/server";
import { requireAddress } from "@/lib/auth";
import { db, dbReady } from "@/lib/db";
import { purgeStaleBuyerEmails } from "@/lib/retention";
import { sweepExpiredSales } from "@/lib/sales";
import { enforce } from "@/lib/rate-limit";
import { shortAddressForLog } from "@/lib/security-log";

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

  const limited = await enforce("sweep", auth.address, { actor: shortAddressForLog(auth.address) });
  if (limited) return limited;

  const expired = await sweepExpiredSales({ eventId });

  // Retention rides here rather than inside the sweep helper, which also
  // runs while rendering the public event page: a stranger opening a shared
  // link should never be the one paying for a table-wide UPDATE. This route
  // is an organizer deliberately asking for housekeeping, and it is already
  // rate limited, so a low-odds pass is a good enough heartbeat for a
  // 30-day window without a cron to maintain.
  if (Math.floor(Math.random() * 20) === 0) {
    await purgeStaleBuyerEmails().catch(() => {});
  }

  return NextResponse.json({ expired });
}
