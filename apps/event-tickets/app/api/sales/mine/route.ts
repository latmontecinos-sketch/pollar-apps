import { NextResponse } from "next/server";
import { requireSignedAddress } from "@/lib/auth";
import { db, dbReady } from "@/lib/db";
import { stroopsToDecimal } from "@/lib/money";

type Row = {
  id: string;
  status: string;
  amount_stroops: string;
  created_at: string;
  event_id: string;
  event_name: string;
  datetime_utc: string;
  place: string;
  ticket_code: string | null;
  door_code: string | null;
  used_at: string | null;
};

/** "Mis pases": every sale the logged-in address has ever made, newest first. */
export async function GET(request: Request) {
  const auth = requireSignedAddress(request);
  if (!auth.ok) return auth.response;

  await dbReady();
  const result = await db.execute({
    sql: `SELECT sales.id, sales.status, sales.amount_stroops, sales.created_at,
                 events.id AS event_id, events.name AS event_name,
                 events.datetime_utc, events.place,
                 tickets.code AS ticket_code, tickets.door_code, tickets.used_at
          FROM sales
          JOIN events ON events.id = sales.event_id
          LEFT JOIN tickets ON tickets.sale_id = sales.id
          WHERE sales.buyer_pollar_id = ?
          ORDER BY sales.created_at DESC`,
    args: [auth.address],
  });

  const sales = (result.rows as unknown as Row[]).map((row) => ({
    id: row.id,
    status: row.status,
    amountDecimal: stroopsToDecimal(BigInt(row.amount_stroops)),
    createdAt: row.created_at,
    event: {
      id: row.event_id,
      name: row.event_name,
      datetimeUtc: row.datetime_utc,
      place: row.place,
    },
    ticket: row.ticket_code
      ? { code: row.ticket_code, doorCode: row.door_code, usedAt: row.used_at }
      : null,
  }));

  return NextResponse.json({ sales });
}
