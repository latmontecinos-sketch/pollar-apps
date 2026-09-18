import { NextResponse } from "next/server";
import { requireSignedAddress } from "@/lib/auth";
import { db, dbReady } from "@/lib/db";
import { stroopsToDecimal } from "@/lib/money";

type Row = {
  id: string;
  name: string;
  datetime_utc: string;
  place: string;
  price_stroops: string;
  capacity: number;
  reserved: number;
};

/** "Mis eventos": every event the logged-in address organizes, newest first. */
export async function GET(request: Request) {
  const auth = requireSignedAddress(request);
  if (!auth.ok) return auth.response;

  await dbReady();
  const result = await db.execute({
    sql: `SELECT id, name, datetime_utc, place, price_stroops, capacity, reserved
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
  }));

  return NextResponse.json({ events });
}
