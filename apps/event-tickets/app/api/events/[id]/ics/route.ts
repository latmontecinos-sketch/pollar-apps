import { db, dbReady } from "@/lib/db";
import { loadEventIcs } from "@/lib/event-ics";
import { formatEventTime } from "@/lib/format";
import { getDict } from "@/lib/i18n/server";
import { clientIp, consume, isOverLimit, tooManyRequests } from "@/lib/rate-limit";
import { canView, normalizeAccessCode } from "@/lib/visibility";
import { publicOrigin } from "@/lib/app-origin";

type Ctx = { params: Promise<{ id: string }> };

/**
 * "Add to calendar": the event as an .ics file. Public like the page it
 * belongs to; a private event needs its code in `?c=`, the same as its photo
 * (app/api/events/[id]/image/route.ts), with the same quota on wrong codes.
 * Anything refused is a bare 404: it never says whether the event exists.
 */
export async function GET(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const params = new URL(request.url).searchParams;
  const offered = params.get("c");

  await dbReady();
  const gate = await db.execute({ sql: "SELECT visibility, access_code FROM events WHERE id = ?", args: [id] });
  if (gate.rows.length === 0) return new Response(null, { status: 404 });
  const event = gate.rows[0] as unknown as { visibility: string; access_code: string | null };

  // Only a wrong code counts; a right one never does (see the photo route).
  if (event.visibility === "private" && normalizeAccessCode(offered)) {
    const subject = `${clientIp(request)}:${id}`;
    const over = await isOverLimit("accessCode", subject);
    if (!over.ok) return tooManyRequests(over);
    if (!canView(event, offered)) {
      await consume("accessCode", subject);
      return new Response(null, { status: 404 });
    }
  }

  const { locale, t } = await getDict();
  const ics = await loadEventIcs(id, offered, {
    doorsLine: (doorsOpenUtc) => t.event.doorsOpen(formatEventTime(doorsOpenUtc, locale)),
    url: `${publicOrigin(request)}/e/${encodeURIComponent(id)}`,
  });
  if (!ics.ok) return new Response(null, { status: 404 });

  return new Response(ics.body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${ics.filename}"`,
      // Never a shared cache: the doors line is in the reader's language (cookie), which a shared
      // cache can't tell apart, and a private event's only key is the code in its URL.
      "Cache-Control": ics.isPrivate ? "private, no-store" : "private, max-age=300",
    },
  });
}
