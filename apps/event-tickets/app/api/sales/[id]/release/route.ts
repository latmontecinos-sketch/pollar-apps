import { NextResponse } from "next/server";
import { requireSignedAddress } from "@/lib/auth";
import { enforce } from "@/lib/rate-limit";
import { shortAddressForLog } from "@/lib/security-log";
import { releaseSale } from "@/lib/sales";

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
 * Two shapes, decided by the UPDATE itself (`releaseSale`):
 *  - No body, for a checkout nobody started paying (cancelled review, an
 *    asset the SDK couldn't build): releases only while no attempt started.
 *  - `{ startedAt, claimToken }`, for the tab that won `/pay` and then saw the
 *    SDK refuse before sending anything. The token is in no response but the
 *    winner's, so a losing tab, a second device or a replayed timestamp
 *    cannot free a seat whose transaction may still land. That the winner's
 *    "it never left" is its own classification (`classifySubmit`) is the one
 *    trust left, and it is acceptable because only the winner holds the token;
 *    if it is ever wrong, the payment settles as `unclaimed` and is refunded.
 */
export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const auth = requireSignedAddress(request);
  if (!auth.ok) return auth.response;

  const limited = await enforce("releaseSale", auth.address, { actor: shortAddressForLog(auth.address) });
  if (limited) return limited;

  let proof: { startedAt: string; claimToken: string } | undefined;
  try {
    const body = (await request.json()) as { startedAt?: unknown; claimToken?: unknown };
    if (typeof body.startedAt === "string" && typeof body.claimToken === "string" && body.claimToken !== "") {
      proof = { startedAt: body.startedAt, claimToken: body.claimToken };
    }
  } catch {
    // No body: the abandoned-checkout shape, which only works before an attempt started.
  }

  const result = await releaseSale(id, auth.address, proof);
  switch (result.outcome) {
    case "released":
      return NextResponse.json({ released: true });
    case "kept":
      return NextResponse.json({ released: false });
    case "forbidden":
      return NextResponse.json({ error: "No tienes acceso a esta venta", code: "forbidden" }, { status: 403 });
    case "not_found":
      return NextResponse.json({ error: "No encontrado", code: "sale_not_found" }, { status: 404 });
  }
}
