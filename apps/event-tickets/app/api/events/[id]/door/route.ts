import { NextResponse } from "next/server";
import { requireAddress } from "@/lib/auth";
import { db, dbReady } from "@/lib/db";
import { validateAtDoor } from "@/lib/tickets";

type Ctx = { params: Promise<{ id: string }> };

type EventRow = { organizer_pollar_id: string };

/**
 * Owner-only door check-in. Response is only VALID/USED/UNKNOWN plus the
 * minimum to render — never the sale/buyer/event object behind it.
 */
export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;

  await dbReady();
  const eventResult = await db.execute({
    sql: "SELECT organizer_pollar_id FROM events WHERE id = ?",
    args: [id],
  });
  if (eventResult.rows.length === 0) {
    return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  }
  const event = eventResult.rows[0] as unknown as EventRow;

  const auth = requireAddress(request, event.organizer_pollar_id);
  if (!auth.ok) return auth.response;

  let body: { code?: string };
  try {
    body = (await request.json()) as { code?: string };
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }
  const code = body.code?.trim() ?? "";
  if (!code) return NextResponse.json({ error: "Falta el código" }, { status: 400 });

  const result = await validateAtDoor(id, code, auth.address);
  switch (result.result) {
    case "VALID":
      return NextResponse.json({ result: "VALID" });
    case "USED":
      return NextResponse.json({ result: "USED", usedAt: result.usedAt });
    case "UNKNOWN":
      return NextResponse.json({ result: "UNKNOWN" });
  }
}
