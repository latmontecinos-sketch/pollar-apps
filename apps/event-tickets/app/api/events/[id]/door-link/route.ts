import { NextResponse } from "next/server";
import { newDoorToken, requireAddress } from "@/lib/auth";
import { db, dbReady } from "@/lib/db";
import { enforce } from "@/lib/rate-limit";
import { shortAddressForLog } from "@/lib/security-log";

type Ctx = { params: Promise<{ id: string }> };

async function organizerOf(id: string): Promise<string | null> {
  await dbReady();
  const result = await db.execute({
    sql: "SELECT organizer_pollar_id FROM events WHERE id = ?",
    args: [id],
  });
  return result.rows.length > 0 ? String(result.rows[0].organizer_pollar_id) : null;
}

/** Owner-only: creates (or replaces, invalidating the old one) the staff door link's token. */
export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const organizer = await organizerOf(id);
  if (!organizer) return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  const auth = requireAddress(request, organizer);
  if (!auth.ok) return auth.response;

  const limited = await enforce("doorLink", auth.address, { actor: shortAddressForLog(auth.address) });
  if (limited) return limited;

  const token = newDoorToken();
  await db.execute({ sql: "UPDATE events SET door_token = ? WHERE id = ?", args: [token, id] });
  return NextResponse.json({ doorToken: token });
}

/** Owner-only: revokes the staff door link. */
export async function DELETE(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const organizer = await organizerOf(id);
  if (!organizer) return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  const auth = requireAddress(request, organizer);
  if (!auth.ok) return auth.response;

  // Same quota as issuing one: revoking is the other half of the same act,
  // and this was the only organizer write on the app with no ceiling at all.
  const limited = await enforce("doorLink", auth.address, {
    actor: shortAddressForLog(auth.address),
  });
  if (limited) return limited;

  await db.execute({ sql: "UPDATE events SET door_token = NULL WHERE id = ?", args: [id] });
  return NextResponse.json({ doorToken: null });
}
