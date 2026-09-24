import { randomBytes } from "node:crypto";
import type { Transaction } from "@libsql/client";
import { db, dbReady, withTransaction } from "./db.ts";
import { newId } from "./ids.ts";
import { issueTicket, type Ticket } from "./tickets.ts";

/**
 * Ceiling on one sweep, so a backlog can't turn a page view into a
 * transaction over thousands of rows. Whatever is left over gets picked up
 * by the next call, which happens constantly.
 */
const MAX_SWEEP_PER_CALL = 200;

/**
 * Goes in the Stellar payment memo (28-byte text memo limit), so it has to
 * be short — this is a correlation key, not a secret, so plain hex is fine.
 * `sales.reference` is UNIQUE; `reserveAndCreateSale` retries on collision.
 */
export function generateReference(): string {
  return `p${randomBytes(5).toString("hex")}`;
}

export type SaleStatus = "pending" | "paid" | "expired" | "unclaimed" | "refunded";

/**
 * Memo of the organizer's refund payment for an `unclaimed` sale. Distinct
 * from the sale's own memo, so a refund can never be mistaken for (or
 * replayed as) the purchase payment. 15 chars, well under the 28-byte limit.
 */
export function refundMemo(reference: string): string {
  return `dev-${reference}`;
}

/**
 * `unclaimed` -> `refunded`, once the refund payment is verified on Horizon.
 * Only from `unclaimed`: a paid ticket is never silently cancelled here.
 */
export async function markRefunded(
  saleId: string,
  refundTxHash: string
): Promise<{ refunded: boolean }> {
  await dbReady();
  const updated = await db.execute({
    sql: "UPDATE sales SET status = 'refunded', refund_tx_hash = ? WHERE id = ? AND status = 'unclaimed' RETURNING id",
    args: [refundTxHash, saleId],
  });
  return { refunded: updated.rows.length > 0 };
}

export type Sale = {
  id: string;
  eventId: string;
  ticketTypeId: string;
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
    ticketTypeId: String(row.ticket_type_id ?? ""),
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
  /** Which tier's seat this holds (General, VIP…). */
  ticketTypeId: string;
  buyerPollarId: string;
  reference: string;
  amountStroops: bigint;
  idempotencyKey: string;
  ttlMs: number;
};

export type ReserveResult =
  /** `reused`: the buyer's existing live reservation, not a newly held seat. */
  | { ok: true; sale: Sale; reused?: boolean }
  | { ok: false; reason: "sold_out" | "key_taken" };

/**
 * Reserves a seat and creates the sale as one DB transaction: if the INSERT
 * fails for any reason, the `reserved` increment rolls back with it — no
 * phantom seat. Idempotent: a resend of the same `idempotencyKey` returns
 * the existing sale instead of reserving a second seat.
 *
 * One live reservation per buyer per event: a buyer who already holds an
 * unexpired `pending` sale here gets that same sale back (with a fresh
 * window) instead of a second held seat. Without this, one logged-in
 * account could tap "comprar" over and over and hold every seat of an
 * event hostage for 15 minutes at a time without paying a cent.
 */
export async function reserveAndCreateSale(
  params: ReserveParams
): Promise<ReserveResult> {
  return withTransaction(async (tx: Transaction) => {
    // Scoped to the buyer on purpose: the key comes from the client, and
    // an unscoped lookup would hand whoever guessed (or collided with)
    // someone else's key that other person's sale — id, reference, amount.
    // The key is a UUID today, so this closes a door rather than a hole.
    const existing = await tx.execute({
      sql: "SELECT * FROM sales WHERE idempotency_key = ? AND buyer_pollar_id = ?",
      args: [params.idempotencyKey, params.buyerPollarId],
    });
    if (existing.rows.length > 0) {
      return { ok: true, sale: rowToSale(existing.rows[0]) };
    }

    // Same key, different buyer: the column is UNIQUE, so inserting would
    // blow up as a 500. Say what happened instead, without describing the
    // sale that owns the key.
    const taken = await tx.execute({
      sql: "SELECT 1 FROM sales WHERE idempotency_key = ?",
      args: [params.idempotencyKey],
    });
    if (taken.rows.length > 0) return { ok: false, reason: "key_taken" };

    const live = await tx.execute({
      sql: `SELECT * FROM sales
            WHERE event_id = ? AND ticket_type_id = ? AND buyer_pollar_id = ? AND status = 'pending'
              AND datetime(expires_at_utc) >= datetime('now')
            ORDER BY created_at DESC LIMIT 1`,
      args: [params.eventId, params.ticketTypeId, params.buyerPollarId],
    });
    if (live.rows.length > 0) {
      const renewed = await tx.execute({
        sql: "UPDATE sales SET expires_at_utc = ? WHERE id = ? RETURNING *",
        args: [
          new Date(Date.now() + params.ttlMs).toISOString(),
          String(live.rows[0].id),
        ],
      });
      return { ok: true, sale: rowToSale(renewed.rows[0]), reused: true };
    }

    // Atomic per tier: two people racing for the last VIP seat can't both win.
    const reserved = await tx.execute({
      sql: `UPDATE ticket_types SET reserved = reserved + 1
            WHERE id = ? AND event_id = ? AND reserved < capacity
            RETURNING reserved`,
      args: [params.ticketTypeId, params.eventId],
    });
    if (reserved.rows.length === 0) {
      return { ok: false, reason: "sold_out" };
    }

    const id = newId();
    const expiresAtUtc = new Date(Date.now() + params.ttlMs).toISOString();
    const inserted = await tx.execute({
      sql: `INSERT INTO sales
              (id, event_id, ticket_type_id, buyer_pollar_id, reference, amount_stroops,
               idempotency_key, status, expires_at_utc)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
            RETURNING *`,
      args: [
        id,
        params.eventId,
        params.ticketTypeId,
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
      sql: "UPDATE sales SET status = 'expired' WHERE id = ? AND status = 'pending' RETURNING ticket_type_id",
      args: [saleId],
    });
    if (updated.rows.length === 0) return { expired: false };

    await tx.execute({
      sql: "UPDATE ticket_types SET reserved = reserved - 1 WHERE id = ? AND reserved > 0",
      args: [String(updated.rows[0].ticket_type_id)],
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
 *
 * Reads that find nothing stale now write nothing at all: the common case on
 * a public page is one SELECT and no transaction. Forgetting old buyers'
 * emails used to ride along here on a one-in-a-hundred coin flip, which put
 * a full-table UPDATE on the critical path of an unlucky stranger's page
 * view; it lives on the organizer's own sweep route now.
 */
export async function sweepExpiredSales(
  scope: { eventId: string } | { organizerPollarId: string } | { buyerPollarId: string }
): Promise<number> {
  await dbReady();
  const [filter, value] =
    "eventId" in scope
      ? ["sales.event_id = ?", scope.eventId]
      : "buyerPollarId" in scope
        ? ["sales.buyer_pollar_id = ?", scope.buyerPollarId]
        : ["events.organizer_pollar_id = ?", scope.organizerPollarId];
  const stale = await db.execute({
    sql: `SELECT sales.id FROM sales JOIN events ON events.id = sales.event_id
          WHERE ${filter} AND sales.status = 'pending'
            AND datetime(sales.expires_at_utc) < datetime('now')
          LIMIT ${MAX_SWEEP_PER_CALL}`,
    args: [value],
  });
  if (stale.rows.length === 0) return 0;

  /**
   * One transaction for the whole batch, not one per sale.
   *
   * This used to call expireSale in a loop, and each of those opened its own
   * transaction: BEGIN, two UPDATEs, COMMIT, times the number of abandoned
   * checkouts — against a remote database, from inside the render of a page
   * that anyone with the link can open. A busy event turned every visit into
   * a burst of round trips.
   *
   * The transition is still the authority: only sales this UPDATE actually
   * moves out of 'pending' give their seat back, so a concurrent sweep
   * releasing the same seat can't decrement it twice.
   */
  const ids = stale.rows.map((row) => String(row.id));
  return withTransaction(async (tx: Transaction) => {
    const expired = await tx.execute({
      sql: `UPDATE sales SET status = 'expired'
            WHERE id IN (${ids.map(() => "?").join(", ")}) AND status = 'pending'
            RETURNING ticket_type_id`,
      args: ids,
    });
    if (expired.rows.length === 0) return 0;

    const freedPerTier = new Map<string, number>();
    for (const row of expired.rows) {
      const tier = String(row.ticket_type_id);
      freedPerTier.set(tier, (freedPerTier.get(tier) ?? 0) + 1);
    }
    for (const [tier, freed] of freedPerTier) {
      await tx.execute({
        sql: "UPDATE ticket_types SET reserved = max(0, reserved - ?) WHERE id = ?",
        args: [freed, tier],
      });
    }
    return expired.rows.length;
  });
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
