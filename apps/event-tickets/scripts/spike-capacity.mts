/**
 * Fase 3 — SPIKE B: cupo atómico.
 * Las 4 pruebas de la fase, contra el esquema real (events/sales) y la DB
 * configurada en el entorno (Turso remota si DATABASE_URL está seteada).
 *
 * Uso: node --env-file=.env scripts/spike-capacity.mts
 */
import { randomUUID } from "node:crypto";
import { db, dbReady } from "../lib/db.ts";
import { reserveAndCreateSale, expireSale, markPaid } from "../lib/sales.ts";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function createEvent(capacity: number): Promise<string> {
  const id = randomUUID();
  await db.execute({
    sql: `INSERT INTO events (id, organizer_pollar_id, name, datetime_utc, place, price_stroops, capacity)
          VALUES (?, 'GORGANIZER000000000000000000000000000000000000000000000', 'Spike event', datetime('now'), 'Test', 10000000, ?)`,
    args: [id, capacity],
  });
  return id;
}

async function eventReserved(eventId: string): Promise<number> {
  const r = await db.execute({
    sql: "SELECT reserved FROM events WHERE id = ?",
    args: [eventId],
  });
  return Number(r.rows[0].reserved);
}

/** 1. capacity=1, dos reservas en paralelo: gana una sola. */
async function testConcurrentCapacityOne(): Promise<void> {
  const eventId = await createEvent(1);

  const attempt = (i: number) =>
    reserveAndCreateSale({
      eventId,
      buyerPollarId: `GBUYER${i}`,
      reference: `ref_cap1_${i}_${randomUUID()}`,
      amountStroops: 10_000_000n,
      idempotencyKey: `idem_cap1_${i}_${randomUUID()}`,
      ttlMs: 15 * 60 * 1000,
    });

  const results = await Promise.all([attempt(0), attempt(1)]);
  const wins = results.filter((r) => r.ok);
  const soldOut = results.filter((r) => !r.ok);

  check(
    "capacity=1, 2 reservas en paralelo: gana exactamente una",
    wins.length === 1 && soldOut.length === 1,
    `ganaron ${wins.length}, sold_out ${soldOut.length}`
  );

  const reserved = await eventReserved(eventId);
  check("reserved quedó en 1", reserved === 1, `reserved = ${reserved}`);
}

/** 2. Reserva + creación de venta en una transacción: si el INSERT falla, no queda asiento fantasma. */
async function testNoPhantomSeat(): Promise<void> {
  const eventId = await createEvent(5);
  const dupRef = `ref_dup_${randomUUID()}`;

  // Primera venta ocupa esa `reference`.
  const first = await reserveAndCreateSale({
    eventId,
    buyerPollarId: "GBUYER_A",
    reference: dupRef,
    amountStroops: 10_000_000n,
    idempotencyKey: `idem_a_${randomUUID()}`,
    ttlMs: 15 * 60 * 1000,
  });
  check("primera venta (setup) se creó", first.ok);

  const before = await eventReserved(eventId);

  // Segunda venta con la MISMA reference (UNIQUE) pero idempotencyKey distinta:
  // el INSERT tiene que fallar por la constraint de `reference`, y el reserved
  // de arriba (ya incrementado dentro de la misma transacción) debe revertir.
  let threw = false;
  try {
    await reserveAndCreateSale({
      eventId,
      buyerPollarId: "GBUYER_B",
      reference: dupRef,
      amountStroops: 10_000_000n,
      idempotencyKey: `idem_b_${randomUUID()}`,
      ttlMs: 15 * 60 * 1000,
    });
  } catch {
    threw = true;
  }
  check("el INSERT con reference duplicada falló como se esperaba", threw);

  const after = await eventReserved(eventId);
  check(
    "sin asiento fantasma: reserved no cambió tras el INSERT fallido",
    after === before,
    `antes=${before}, despues=${after}`
  );
}

/** 3. Expirar la misma venta dos veces: reserved baja una sola vez. */
async function testDoubleExpire(): Promise<void> {
  const eventId = await createEvent(5);
  const created = await reserveAndCreateSale({
    eventId,
    buyerPollarId: "GBUYER_C",
    reference: `ref_exp_${randomUUID()}`,
    amountStroops: 10_000_000n,
    idempotencyKey: `idem_c_${randomUUID()}`,
    ttlMs: 15 * 60 * 1000,
  });
  if (!created.ok) throw new Error("setup failed");
  const saleId = created.sale.id;

  const before = await eventReserved(eventId);
  const first = await expireSale(saleId);
  const afterFirst = await eventReserved(eventId);
  const second = await expireSale(saleId);
  const afterSecond = await eventReserved(eventId);

  check("primera expiración transiciona (expired: true)", first.expired === true);
  check(
    "reserved bajó en 1 tras la primera expiración",
    afterFirst === before - 1,
    `antes=${before}, despues=${afterFirst}`
  );
  check("segunda expiración es no-op (expired: false)", second.expired === false);
  check(
    "reserved NO volvió a bajar en la segunda expiración",
    afterSecond === afterFirst,
    `afterFirst=${afterFirst}, afterSecond=${afterSecond}`
  );
}

/** 4. Pago y expiración compitiendo sobre la misma venta: gana uno, el otro no corrompe el cupo. */
async function testPayVsExpireRace(): Promise<void> {
  const eventId = await createEvent(5);
  const created = await reserveAndCreateSale({
    eventId,
    buyerPollarId: "GBUYER_D",
    reference: `ref_race_${randomUUID()}`,
    amountStroops: 10_000_000n,
    idempotencyKey: `idem_d_${randomUUID()}`,
    ttlMs: 15 * 60 * 1000,
  });
  if (!created.ok) throw new Error("setup failed");
  const saleId = created.sale.id;
  const reservedBefore = await eventReserved(eventId);

  const [payResult, expireResult] = await Promise.all([
    markPaid(saleId, `hash_${randomUUID()}`),
    expireSale(saleId),
  ]);

  const exactlyOneWon = payResult.paid !== expireResult.expired;
  check(
    "exactamente una de las dos transiciones ganó",
    exactlyOneWon,
    `paid=${payResult.paid}, expired=${expireResult.expired}`
  );

  const statusRow = await db.execute({
    sql: "SELECT status FROM sales WHERE id = ?",
    args: [saleId],
  });
  const status = String(statusRow.rows[0].status);
  check(
    "el status final es 'paid' o 'expired', nunca ambos ni ninguno",
    status === "paid" || status === "expired",
    `status = ${status}`
  );

  const reservedAfter = await eventReserved(eventId);
  const expectedReserved = status === "expired" ? reservedBefore - 1 : reservedBefore;
  check(
    "reserved coincide con el resultado ganador (paid no libera cupo, expired sí)",
    reservedAfter === expectedReserved,
    `status=${status}, antes=${reservedBefore}, despues=${reservedAfter}`
  );
}

/** 5. Un mismo comprador no puede acaparar cupos: repetir "comprar" reusa su reserva viva. */
async function testOneLiveReservationPerBuyer(): Promise<void> {
  const eventId = await createEvent(5);
  const buyer = `GBUYER_HOARDER_${randomUUID()}`;

  const attempt = () =>
    reserveAndCreateSale({
      eventId,
      buyerPollarId: buyer,
      reference: `ref_hoard_${randomUUID()}`,
      amountStroops: 10_000_000n,
      idempotencyKey: `idem_hoard_${randomUUID()}`,
      ttlMs: 15 * 60 * 1000,
    });

  const first = await attempt();
  const repeats = [await attempt(), await attempt(), await attempt()];
  const reserved = await eventReserved(eventId);

  check(
    "5 intentos del mismo comprador ocupan un solo cupo",
    reserved === 1,
    `reserved = ${reserved}`
  );
  check(
    "los intentos repetidos devuelven la misma venta",
    first.ok && repeats.every((r) => r.ok && r.sale.id === first.sale.id)
  );
  check(
    "la reserva reusada renueva su ventana de pago",
    first.ok &&
      repeats[2].ok &&
      new Date(repeats[2].sale.expiresAtUtc) >= new Date(first.sale.expiresAtUtc)
  );

  // Otro comprador sí toma un cupo distinto.
  const other = await reserveAndCreateSale({
    eventId,
    buyerPollarId: `GBUYER_OTHER_${randomUUID()}`,
    reference: `ref_other_${randomUUID()}`,
    amountStroops: 10_000_000n,
    idempotencyKey: `idem_other_${randomUUID()}`,
    ttlMs: 15 * 60 * 1000,
  });
  const reservedAfter = await eventReserved(eventId);
  check(
    "otro comprador sí ocupa su propio cupo",
    other.ok && reservedAfter === 2,
    `reserved = ${reservedAfter}`
  );

  // Tras expirar la suya, el mismo comprador puede volver a reservar.
  if (first.ok) await expireSale(first.sale.id);
  const afterExpiry = await attempt();
  check(
    "tras expirar, el mismo comprador puede reservar de nuevo",
    afterExpiry.ok && first.ok && afterExpiry.sale.id !== first.sale.id
  );
}

async function main() {
  await dbReady();
  console.log("\nFase 3 — SPIKE B: cupo atómico\n");
  await testConcurrentCapacityOne();
  await testNoPhantomSeat();
  await testDoubleExpire();
  await testPayVsExpireRace();
  await testOneLiveReservationPerBuyer();
  console.log(`\n${passed} pass, ${failed} fail\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\nel spike se cayó:", e);
  process.exit(1);
});
