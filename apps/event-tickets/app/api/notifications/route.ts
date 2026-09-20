import { NextResponse } from "next/server";
import { requireSignedAddress } from "@/lib/auth";
import { db, dbReady } from "@/lib/db";
import { sqlUtcToIso } from "@/lib/format";

type Row = { kind: string; event_name: string; at: string; id: string };

/**
 * The two things worth interrupting someone for, derived from the data we
 * already keep (no separate notifications table to drift out of sync):
 * a sale of one of your events, and your own ticket being accepted at a
 * door. "Read" state lives in the reader's browser — it's per-device and
 * not worth a round trip.
 */
export async function GET(request: Request) {
  const auth = requireSignedAddress(request);
  if (!auth.ok) return auth.response;

  await dbReady();
  const result = await db.execute({
    sql: `SELECT 'sold' AS kind, events.name AS event_name, sales.created_at AS at, sales.id AS id
          FROM sales JOIN events ON events.id = sales.event_id
          WHERE events.organizer_pollar_id = ? AND sales.status = 'paid'
          UNION ALL
          SELECT 'checked_in' AS kind, events.name AS event_name, tickets.used_at AS at, tickets.id AS id
          FROM tickets
          JOIN sales ON sales.id = tickets.sale_id
          JOIN events ON events.id = tickets.event_id
          WHERE sales.buyer_pollar_id = ? AND tickets.used_at IS NOT NULL
          ORDER BY at DESC
          LIMIT 30`,
    args: [auth.address, auth.address],
  });

  const items = (result.rows as unknown as Row[]).map((row) => ({
    id: `${row.kind}:${row.id}`,
    kind: row.kind,
    eventName: row.event_name,
    at: sqlUtcToIso(row.at),
  }));

  return NextResponse.json({ items });
}
