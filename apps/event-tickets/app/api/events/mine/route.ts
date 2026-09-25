import { NextResponse } from "next/server";
import { requireSignedAddress } from "@/lib/auth";
import { db, dbReady } from "@/lib/db";
import { stroopsToDecimal } from "@/lib/money";
import { PRICE_RANGE_COLUMNS } from "@/lib/public-events";
import { sweepExpiredSales } from "@/lib/sales";

/**
 * "Mis eventos" and the organizer home: every event the logged-in address
 * organizes, newest first.
 *
 * Price, capacity and seats come from the tiers, never from the event row's
 * summary columns: those are written once at creation, so they miss a
 * capacity increase and only ever knew the cheapest tier (a mixed event read
 * "0,00 USDC c/u"). `reserved` counts seats held by unpaid checkouts too, so
 * `paid` is the number to show as "vendidas"; `collectedDecimal` is what
 * those paid sales brought in.
 */
export async function GET(request: Request) {
  const auth = requireSignedAddress(request);
  if (!auth.ok) return auth.response;

  await dbReady();
  await sweepExpiredSales({ organizerPollarId: auth.address });
  const result = await db.execute({
    sql: `SELECT e.id, e.name, e.datetime_utc, e.place, e.visibility,
                 ${PRICE_RANGE_COLUMNS},
                 (SELECT COALESCE(SUM(t.capacity), 0) FROM ticket_types t WHERE t.event_id = e.id) AS capacity,
                 (SELECT COALESCE(SUM(t.reserved), 0) FROM ticket_types t WHERE t.event_id = e.id) AS reserved,
                 (SELECT count(*) FROM sales s WHERE s.event_id = e.id AND s.status = 'paid') AS paid,
                 (SELECT COALESCE(SUM(s.amount_stroops), 0) FROM sales s
                  WHERE s.event_id = e.id AND s.status = 'paid') AS collected
          FROM events e
          WHERE e.organizer_pollar_id = ?
          ORDER BY e.created_at DESC`,
    args: [auth.address],
  });

  const events = result.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    datetimeUtc: String(row.datetime_utc),
    place: String(row.place),
    visibility: String(row.visibility),
    minPriceDecimal: stroopsToDecimal(BigInt((row.min_price as number | null) ?? 0)),
    maxPriceDecimal: stroopsToDecimal(BigInt((row.max_price as number | null) ?? 0)),
    capacity: Number(row.capacity),
    reserved: Number(row.reserved),
    paid: Number(row.paid),
    collectedDecimal: stroopsToDecimal(BigInt(row.collected as number)),
  }));

  return NextResponse.json({ events });
}
