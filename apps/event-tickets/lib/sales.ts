import { randomBytes } from "node:crypto";
import type { Transaction } from "@libsql/client";
import { db, dbReady, withTransaction } from "./db.ts";
import { newId } from "./ids.ts";
import { issueTicket, type Ticket } from "./tickets.ts";

/**
 * Goes in the Stellar payment memo (28-byte text memo limit), so it has to
 * be short — this is a correlation key, not a secret, so plain hex is fine.
 * `sales.reference` is UNIQUE; `reserveAndCreateSale` retries on collision.
 */
export function generateReference(): string {
  return `p${randomBytes(5).toString("hex")}`;
}

export type SaleStatus = "pending" | "paid" | "expired" | "unclaimed";

export type Sale = {
  id: string;
  eventId: string;
  buyerPollarId: string;
  reference: string;
  amountStroops: bigint;
  idempotencyKey: string;
  status: SaleStatus;
  txHash: string | null;
  expiresAtUtc: string;
  createdAt: string;
};

function rowToSale(row: Record<string, unknown>): Sale {
  return {
    id: String(row.id),
    eventId: String(row.event_id),
    buyerPollarId: String(row.buyer_pollar_id),
    reference: String(row.reference),
    amountStroops: BigInt(String(row.amount_stroops)),
    idempotencyKey: String(row.idempotency_key),
    status: String(row.status) as SaleStatus,
    txHash: row.tx_hash == null ? null : String(row.tx_hash),
    expiresAtUtc: String(row.expires_at_utc),
    createdAt: String(row.created_at),
  };
}

export type ReserveParams = {
  eventId: string;
  buyerPollarId: string;
  reference: string;
  amountStroops: bigint;
  idempotencyKey: string;
  ttlMs: number;
};

export type ReserveResult =
  | { ok: true; sale: Sale }
  | { ok: false; reason: "sold_out" };

/**
 * Reserves a seat and creates the sale as one DB transaction: if the INSERT
 * fails for any reason, the `reserved` increment rolls back with it — no
 * phantom seat. Idempotent: a resend of the same `idempotencyKey` returns
 * the existing sale instead of reserving a second seat.
 */
export async function reserveAndCreateSale(
  params: ReserveParams
): Promise<ReserveResult> {
  return withTransaction(async (tx: Transaction) => {
    const existing = await tx.execute({
      sql: "SELECT * FROM sales WHERE idempotency_key = ?",
      args: [params.idempotencyKey],
    });
    if (existing.rows.length > 0) {
      return { ok: true, sale: rowToSale(existing.rows[0]) };
    }

    const reserved = await tx.execute({
      sql: "UPDATE events SET reserved = reserved + 1 WHERE id = ? AND reserved < capacity RETURNING reserved",
      args: [params.eventId],
    });
    if (reserved.rows.length === 0) {
      return { ok: false, reason: "sold_out" };
    }

    const id = newId();
    const expiresAtUtc = new Date(Date.now() + params.ttlMs).toISOString();
    const inserted = await tx.execute({
      sql: `INSERT INTO sales
              (id, event_id, buyer_pollar_id, reference, amount_stroops, idempotency_key, status, expires_at_utc)
            VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
            RETURNING *`,
      args: [
        id,
        params.eventId,
        params.buyerPollarId,
        params.reference,
        params.amountStroops.toString(),
        params.idempotencyKey,
        expiresAtUtc,
      ],
    });
    return { ok: true, sale: rowToSale(inserted.rows[0]) };
  });
}

/**
 * `pending` -> `expired`. The transition is the authority: only a genuine
 * pending->expired UPDATE releases the seat, so calling this twice on the
 * same sale decrements `reserved` exactly once.
 */
export async function expireSale(saleId: string): Promise<{ expired: boolean }> {
  return withTransaction(async (tx: Transaction) => {
    const updated = await tx.execute({
      sql: "UPDATE sales SET status = 'expired' WHERE id = ? AND status = 'pending' RETURNING event_id",
      args: [saleId],
    });
    if (updated.rows.length === 0) return { expired: false };

    await tx.execute({
      sql: "UPDATE events SET reserved = reserved - 1 WHERE id = ?",
      args: [String(updated.rows[0].event_id)],
    });
    return { expired: true };
  });
}

/**
 * Expires every `pending` sale whose payment window closed, releasing its
 * seat. Idempotent and cheap, so it runs wherever seat counts are read or
 * spent (public page, new sale, organizer views) instead of only when the
 * organizer happens to open their panel — otherwise an abandoned checkout
 * could keep an event looking sold out indefinitely.
 *
 * `expires_at_utc` is an ISO string ("…T…Z") while `datetime('now')` is
 * "YYYY-MM-DD HH:MM:SS": compared as raw text, 'T' > ' ' means a sale never
 * reads as expired until the UTC date rolls over. `datetime()` normalizes
 * both sides first.
 */
export async function sweepExpiredSales(
  scope: { eventId: string } | { organizerPollarId: string }
): Promise<number> {
  await dbReady();
  const stale =
    "eventId" in scope
      ? await db.execute({
          sql: `SELECT id FROM sales
                WHERE event_id = ? AND status = 'pending'
                  AND datetime(expires_at_utc) < datetime('now')`,
          args: [scope.eventId],
        })
      : await db.execute({
          sql: `SELECT sales.id FROM sales JOIN events ON events.id = sales.event_id
                WHERE events.organizer_pollar_id = ? AND sales.status = 'pending'
                  AND datetime(sales.expires_at_utc) < datetime('now')`,
          args: [scope.organizerPollarId],
        });

  let expired = 0;
  for (const row of stale.rows) {
    if ((await expireSale(String(row.id))).expired) expired++;
  }
  return expired;
}

/**
 * `pending` -> `paid`. If this loses the race to a concurrent `expireSale`
 * (WHERE status = 'pending' matches nothing because it already flipped to
 * 'expired'), the caller applies the late-payment rule instead of retrying
 * blindly — see the design's PENDING/EXPIRED/UNCLAIMED state chart.
 */
export async function markPaid(
  saleId: string,
  txHash: string
): Promise<{ paid: boolean }> {
  return withTransaction(async (tx: Transaction) => {
    const updated = await tx.execute({
      sql: "UPDATE sales SET status = 'paid', tx_hash = ? WHERE id = ? AND status = 'pending' RETURNING id",
      args: [txHash, saleId],
    });
    return { paid: updated.rows.length > 0 };
  });
}

export type SettleResult =
  | { outcome: "paid"; ticket: Ticket }
  | { outcome: "already_paid"; ticket: Ticket }
  | { outcome: "unclaimed" }
  | { outcome: "no_match" };

/**
 * Verified payment meets the sale record. `pending` -> `paid` and ticket
 * issuance happen in the same transaction (design: never a `paid` sale
 * without a ticket). If the sale already flipped to `expired` before this
 * payment landed (lost the race with `expireSale`), the seat is already
 * released — possibly resold — so this does NOT issue a ticket; it moves
 * the sale to `unclaimed` for manual handling instead of overselling.
 * Replays of an already-`paid` sale are idempotent (same ticket back).
 */
export async function settlePayment(
  saleId: string,
  eventId: string,
  txHash: string
): Promise<SettleResult> {
  return withTransaction(async (tx: Transaction) => {
    const paid = await tx.execute({
      sql: "UPDATE sales SET status = 'paid', tx_hash = ? WHERE id = ? AND status = 'pending' RETURNING id",
      args: [txHash, saleId],
    });
    if (paid.rows.length > 0) {
      const ticket = await issueTicket(saleId, eventId, tx);
      return { outcome: "paid", ticket };
    }

    const current = await tx.execute({
      sql: "SELECT status FROM sales WHERE id = ?",
      args: [saleId],
    });
    const status = current.rows[0]?.status;
    if (status === "paid") {
      const ticket = await issueTicket(saleId, eventId, tx);
      return { outcome: "already_paid", ticket };
    }
    if (status === "expired") {
      await tx.execute({
        sql: "UPDATE sales SET status = 'unclaimed', tx_hash = ? WHERE id = ? AND status = 'expired'",
        args: [txHash, saleId],
      });
      return { outcome: "unclaimed" };
    }
    return { outcome: "no_match" };
  });
}
