import { NextResponse } from "next/server";
import { requireSignedAddress } from "@/lib/auth";
import { db, dbReady } from "@/lib/db";
import { stroopsToDecimal } from "@/lib/money";
import { findPaymentHashByMemo, verifyPaymentOnHorizon } from "@/lib/horizon";
import { settlePayment } from "@/lib/sales";
import { appOrigin, isDeliverableEmail, sendTicketEmail } from "@/lib/mail";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/locales";
import { enforce } from "@/lib/rate-limit";
import { maskEmail, securityLog, shortAddressForLog } from "@/lib/security-log";

type Ctx = { params: Promise<{ id: string }> };

type SaleRow = {
  id: string;
  event_id: string;
  buyer_pollar_id: string;
  reference: string;
  amount_stroops: string;
  status: string;
  organizer_pollar_id: string;
  event_name: string;
  event_datetime_utc: string;
  event_place: string;
};

/**
 * The buyer submits the hash of the payment they just sent — or no hash at
 * all ("Ya pagué, verificar"), in which case we look the payment up on
 * Horizon by this sale's unique memo. Either way it's verified against
 * Horizon (real testnet chain state, not anything the client asserts)
 * before ever marking the sale paid or issuing a ticket. A Horizon failure
 * (network, not-yet-indexed) is a 503 the client should retry — never a
 * "payment rejected".
 */
export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const auth = requireSignedAddress(request);
  if (!auth.ok) return auth.response;

  // Every confirm can fan out up to three requests to Horizon, so a loop
  // from one account would get us throttled and break everyone's checkout.
  const limited = await enforce("confirmSale", auth.address, {
    actor: shortAddressForLog(auth.address),
  });
  if (limited) return limited;

  await dbReady();
  const result = await db.execute({
    sql: `SELECT sales.*, events.organizer_pollar_id, events.name AS event_name,
                 events.datetime_utc AS event_datetime_utc, events.place AS event_place
          FROM sales JOIN events ON events.id = sales.event_id
          WHERE sales.id = ?`,
    args: [id],
  });
  if (result.rows.length === 0) {
    return NextResponse.json({ error: "No encontrado", code: "sale_not_found" }, { status: 404 });
  }
  const sale = result.rows[0] as unknown as SaleRow;
  if (auth.address !== sale.buyer_pollar_id) {
    return NextResponse.json(
      { error: "No tienes acceso a esta venta", code: "forbidden" },
      { status: 403 }
    );
  }

  let body: { hash?: string; email?: string; locale?: string };
  try {
    body = (await request.json()) as { hash?: string; email?: string; locale?: string };
  } catch {
    return NextResponse.json({ error: "JSON inválido", code: "invalid_json" }, { status: 400 });
  }
  // An unvalidated address goes straight into our Resend "to" and into the
  // database forever; anything that isn't a mailbox is simply dropped, and
  // the purchase carries on (the ticket lives in the buyer's account).
  const candidate = body.email?.trim() ?? "";
  const email = isDeliverableEmail(candidate) ? candidate : "";
  const locale = isLocale(body.locale) ? body.locale : DEFAULT_LOCALE;
  let hash = body.hash?.trim() ?? "";

  if (!hash) {
    // The buyer's account, not the organizer's: the payment shows up on both
    // (Horizon lists an account's payments in either direction), but the
    // organizer's is the one that fills up — and the lookup only reads one
    // page. A popular organizer, or anyone spraying 1-stroop payments at the
    // address we publish to every buyer, would push the real payment out of
    // that page and break this recovery path. The destination and amount are
    // re-checked by verifyPaymentOnHorizon either way, so searching the
    // quieter account costs nothing.
    const found = await findPaymentHashByMemo({
      account: sale.buyer_pollar_id,
      memo: sale.reference,
    });
    if (found === undefined) {
      return NextResponse.json(
        {
          error: "No pudimos consultar la red de Stellar. Intenta de nuevo en un momento.",
          code: "horizon_unreachable",
        },
        { status: 503 }
      );
    }
    if (found === null) {
      return NextResponse.json(
        { error: "Todavía no vemos ningún pago para esta reserva.", code: "no_payment" },
        { status: 404 }
      );
    }
    hash = found;
  }

  const check = await verifyPaymentOnHorizon({
    hash,
    destination: sale.organizer_pollar_id,
    amountDecimal: stroopsToDecimal(BigInt(sale.amount_stroops)),
    reference: sale.reference,
  });
  if (!check.ok) {
    if (check.code === "failed") {
      // A failed Stellar tx applies no operations: the buyer wasn't charged.
      return NextResponse.json(
        {
          error: "La red de Stellar rechazó la transacción, así que no se te cobró. Puedes intentar de nuevo.",
          code: "tx_failed",
        },
        { status: 422 }
      );
    }
    if (check.code === "mismatch") {
      // A real transaction that doesn't match this sale: either a mistake
      // worth helping with, or someone trying to pass off a payment.
      securityLog("payment.mismatch", {
        sale: sale.id,
        actor: shortAddressForLog(auth.address),
        hash: hash.slice(0, 12),
      });
    }
    const status = check.code === "mismatch" ? 400 : 503;
    const code = check.code === "mismatch" ? "payment_mismatch" : "horizon_unreachable";
    return NextResponse.json({ error: check.error, code }, { status });
  }

  // The payment is verified on-chain by this point: the money is gone and
  // this record is the only thing standing between the buyer and their
  // ticket. If the database refuses (write contention, a blip reaching
  // Turso), an uncaught throw became a raw 500, which the client reads as
  // "unverified" — and the sale could later expire with no trace that it was
  // ever paid, which is also the one state the refund flow can't reach. A
  // 503 says "ask me again", which is exactly right: settlePayment is
  // idempotent, so retrying costs nothing and the retry is already built
  // into BuyButton.
  let settled: Awaited<ReturnType<typeof settlePayment>>;
  try {
    settled = await settlePayment(sale.id, sale.event_id, hash);
  } catch (err) {
    console.error(
      `[sales] settlePayment failed for ${sale.id} with a verified payment (${hash.slice(0, 12)}): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return NextResponse.json(
      {
        error:
          "Tu pago está confirmado en la red, pero no pudimos registrarlo en este momento. Volvé a intentar en unos segundos: no se te va a cobrar de nuevo.",
        code: "settle_retry",
      },
      { status: 503 }
    );
  }

  switch (settled.outcome) {
    case "paid":
    case "already_paid": {
      // Only on the first settlement: a replay (retry, "verificar" again)
      // must not send the buyer a second copy of the same ticket.
      // `emailed` is what the buyer is told, so it's only true for a send
      // that went out on this request. A replay says nothing either way.
      let emailed = false;
      if (email && settled.outcome === "paid") {
        // Kept so we can tell this buyer (in their language) when their
        // ticket is accepted at the door. Never shown to the organizer.
        await db.execute({
          sql: "UPDATE sales SET buyer_email = ?, buyer_locale = ? WHERE id = ?",
          args: [email, locale, sale.id],
        });
        // Best-effort: the ticket already lives in the buyer's own account
        // either way, so a failed send doesn't get retried or block anything.
        const mailResult = await sendTicketEmail({
          to: email,
          locale,
          origin: appOrigin(request),
          eventName: sale.event_name,
          eventDateTime: sale.event_datetime_utc,
          eventPlace: sale.event_place,
          ticketCode: settled.ticket.code,
          doorCode: settled.ticket.doorCode,
        });
        emailed = mailResult.sent;
        if (!mailResult.sent) {
          // Masked: which provider bounced is useful, who bought is not.
          console.error(`[mail] ticket email to ${maskEmail(email)} failed: ${mailResult.error}`);
        }
      }
      return NextResponse.json({
        status: "paid",
        ticket: { code: settled.ticket.code, doorCode: settled.ticket.doorCode },
        emailed,
      });
    }
    case "unclaimed":
      return NextResponse.json(
        {
          status: "unclaimed",
          error:
            "El pago llegó, pero la reserva ya había expirado. Contacta al organizador con el comprobante de la transacción.",
          code: "sale_unclaimed",
        },
        { status: 409 }
      );
    case "no_match":
      return NextResponse.json(
        { error: "La venta no está en un estado válido", code: "sale_invalid_state" },
        { status: 409 }
      );
  }
}
