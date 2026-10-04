import { db, dbReady } from "./db.ts";
import { findVerifiedPaymentByMemo, searchSince } from "./horizon.ts";
import { stroopsToDecimal } from "./money.ts";
import { usdcAsset } from "./network.ts";
import { refundMemo } from "./sales.ts";

/**
 * What the three refund routes (plan, start, record) share: the sale with its
 * organizer, the search for a refund already on the chain, and the plan the
 * organizer's wallet is asked to send.
 */

export type RefundSaleRow = {
  id: string;
  buyer_pollar_id: string;
  reference: string;
  amount_stroops: string;
  status: string;
  created_at: string;
  refund_tx_hash: string | null;
  refund_started_at: string | null;
  organizer_pollar_id: string;
};

export async function loadRefundSale(id: string): Promise<RefundSaleRow | null> {
  await dbReady();
  const result = await db.execute({
    sql: `SELECT sales.id, sales.buyer_pollar_id, sales.reference, sales.amount_stroops,
                 sales.status, sales.created_at, sales.refund_tx_hash, sales.refund_started_at,
                 events.organizer_pollar_id
          FROM sales JOIN events ON events.id = sales.event_id
          WHERE sales.id = ?`,
    args: [id],
  });
  return result.rows.length > 0 ? (result.rows[0] as unknown as RefundSaleRow) : null;
}

/**
 * Looks for the organizer's refund of this sale on the chain, by its memo.
 * Both starting a refund (is there already one?) and recording it (which hash
 * is it?) need exactly this answer.
 */
export function findRefund(sale: RefundSaleRow) {
  return findVerifiedPaymentByMemo({
    account: sale.buyer_pollar_id,
    memo: refundMemo(sale.reference),
    destination: sale.buyer_pollar_id,
    source: sale.organizer_pollar_id,
    amountDecimal: stroopsToDecimal(BigInt(sale.amount_stroops)),
    since: searchSince(sale.created_at),
  });
}

/** What the organizer's wallet must send: the sale's own asset, never one it picks. */
export function refundPlan(sale: RefundSaleRow) {
  return {
    destination: sale.buyer_pollar_id,
    amountDecimal: stroopsToDecimal(BigInt(sale.amount_stroops)),
    memo: refundMemo(sale.reference),
    asset: usdcAsset(),
  };
}
