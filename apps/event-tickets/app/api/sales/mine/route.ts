import { NextResponse } from "next/server";
import { requireSignedAddress } from "@/lib/auth";
import { db, dbReady } from "@/lib/db";
import { stroopsToDecimal } from "@/lib/money";
import { sqlUtcToIso } from "@/lib/format";
import { sweepExpiredSales } from "@/lib/sales";

type Row = {
  id: string;
  status: string;
  amount_stroops: string;
  created_at: string;
  expires_at_utc: string;
  tx_hash: string | null;
  refund_tx_hash: string | null;
  event_id: string;
  event_name: string;
  datetime_utc: string;
  place: string;
  ticket_type_name: string | null;
  ticket_code: string | null;
  door_code: string | null;
  used_at: string | null;
};

/**
 * "Mis pases": the logged-in address's most recent purchases, newest first.
 *
 * Bounded, and backed by an index on (buyer_pollar_id, created_at) — it used
 * to return a buyer's entire history and sort it in a temp B-tree, growing
 * with every purchase they ever made for a screen that shows a short list.
 */
export async function GET(request: Request) {
  const auth = requireSignedAddress(request);
  if (!auth.ok) return auth.response;

  await dbReady();
  await sweepExpiredSales({ buyerPollarId: auth.address });
  const result = await db.execute({
    sql: `SELECT sales.id, sales.status, sales.amount_stroops, sales.created_at, sales.expires_at_utc,
                 sales.tx_hash, sales.refund_tx_hash,
                 events.id AS event_id, events.name AS event_name,
                 events.datetime_utc, events.place, ticket_types.name AS ticket_type_name,
                 tickets.code AS ticket_code, tickets.door_code, tickets.used_at
          FROM sales
          JOIN events ON events.id = sales.event_id
          LEFT JOIN ticket_types ON ticket_types.id = sales.ticket_type_id
          LEFT JOIN tickets ON tickets.sale_id = sales.id
          WHERE sales.buyer_pollar_id = ?
          ORDER BY sales.created_at DESC
          LIMIT 100`,
    args: [auth.address],
  });

  const sales = (result.rows as unknown as Row[]).map((row) => ({
    id: row.id,
    status: row.status,
    amountDecimal: stroopsToDecimal(BigInt(row.amount_stroops)),
    createdAt: sqlUtcToIso(row.created_at),
    expiresAtUtc: row.expires_at_utc,
    txHash: row.tx_hash,
    refundTxHash: row.refund_tx_hash,
    event: {
      id: row.event_id,
      name: row.event_name,
      datetimeUtc: row.datetime_utc,
      place: row.place,
    },
    ticketTypeName: row.ticket_type_name,
    ticket: row.ticket_code
      ? { code: row.ticket_code, doorCode: row.door_code, usedAt: sqlUtcToIso(row.used_at) }
      : null,
  }));

  return NextResponse.json({ sales });
}
