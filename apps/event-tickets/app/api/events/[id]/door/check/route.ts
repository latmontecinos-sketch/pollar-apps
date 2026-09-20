import { NextResponse } from "next/server";
import { requireDoorAccess } from "@/lib/auth";
import { db, dbReady } from "@/lib/db";
import { sqlUtcToIso } from "@/lib/format";
import { enforce } from "@/lib/rate-limit";
import { peekAtDoor } from "@/lib/tickets";

type Ctx = { params: Promise<{ id: string }> };

type EventRow = { organizer_pollar_id: string; door_token: string | null };

/**
 * Step 1 of check-in: says what a scanned code is **without spending it**,
 * so whoever is on the door sees the result and decides. Step 2 (`POST
 * ../door`) is what actually marks the ticket used.
 */
export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;

  await dbReady();
  const eventResult = await db.execute({
    sql: "SELECT organizer_pollar_id, door_token FROM events WHERE id = ?",
    args: [id],
  });
  if (eventResult.rows.length === 0) {
    return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  }

  const access = requireDoorAccess(request, eventResult.rows[0] as unknown as EventRow);
  if (!access.ok) return access.response;

  // Shares the door budget with the check-in itself: peeking is free to
  // repeat by design, which is exactly what makes it worth guessing codes on.
  const limited = await enforce("door", id, { event: id });
  if (limited) return limited;

  let body: { code?: string };
  try {
    body = (await request.json()) as { code?: string };
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }
  const code = body.code?.trim() ?? "";
  if (!code) return NextResponse.json({ error: "Falta el código" }, { status: 400 });

  const result = await peekAtDoor(id, code);
  switch (result.result) {
    case "VALID":
      // The door needs something human to confirm against, never the QR payload.
      return NextResponse.json({ result: "VALID", doorCode: result.ticket.doorCode });
    case "USED":
      return NextResponse.json({ result: "USED", usedAt: sqlUtcToIso(result.usedAt) });
    case "UNKNOWN":
      return NextResponse.json({ result: "UNKNOWN" });
  }
}
