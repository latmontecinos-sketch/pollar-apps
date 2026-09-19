import { NextResponse } from "next/server";
import { requireSignedAddress } from "@/lib/auth";
import { db, dbReady } from "@/lib/db";
import { stroopsToDecimal } from "@/lib/money";
import { sweepExpiredSales } from "@/lib/sales";

type Row = {
  id: string;
  name: string;
  datetime_utc: string;
  place: string;
  price_stroops: string;
  capacity: number;
  reserved: number;
  paid: number;
};

/**
 * "Mis eventos": every event the logged-in address organizes, newest first.
 * `reserved` counts seats held by unpaid checkouts too, so `paid` is the
 * number to show as "vendidas".
 */
export async function GET(request: Request) {
  const auth = requireSignedAddress(request);
  if (!auth.ok) return auth.response;

  await dbReady();
  await sweepExpiredSales({ organizerPollarId: auth.address });
  const result = await db.execute({
    sql: `SELECT events.id, events.name, events.datetime_utc, events.place,
                 events.price_stroops, events.capacity, events.reserved,
                 (SELECT count(*) FROM sales
                  WHERE sales.event_id = events.id AND sales.status = 'paid') AS paid
          FROM events
          WHERE organizer_pollar_id = ?
          ORDER BY created_at DESC`,
    args: [auth.address],
  });

  const events = (result.rows as unknown as Row[]).map((row) => ({
    id: row.id,
    name: row.name,
    datetimeUtc: row.datetime_utc,
    place: row.place,
    priceDecimal: stroopsToDecimal(BigInt(row.price_stroops)),
    capacity: row.capacity,
    reserved: row.reserved,
    paid: Number(row.paid),
  }));

  return NextResponse.json({ events });
}
