/**
 * Fase 4 — SPIKE C: puerta atómica.
 * Las 4 pruebas de la fase, contra el esquema real y la DB configurada
 * en el entorno.
 *
 * Uso: node --env-file=.env scripts/spike-door.mts
 */
import { randomUUID } from "node:crypto";
import { db, dbReady } from "../lib/db.ts";
import { issueTicket, validateAtDoor } from "../lib/tickets.ts";

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

async function createPaidSaleWithTicket(eventId: string): Promise<{
  saleId: string;
  code: string;
  doorCode: string;
}> {
  const saleId = randomUUID();
  await db.execute({
    sql: `INSERT INTO sales
            (id, event_id, buyer_pollar_id, reference, amount_stroops, idempotency_key, status, expires_at_utc)
          VALUES (?, ?, 'GBUYER_DOOR', ?, 10000000, ?, 'paid', datetime('now', '+1 hour'))`,
    args: [saleId, eventId, `ref_door_${randomUUID()}`, `idem_door_${randomUUID()}`],
  });
  const ticket = await issueTicket(saleId, eventId);
  return { saleId, code: ticket.code, doorCode: ticket.doorCode };
}

async function createEvent(): Promise<string> {
  const id = randomUUID();
  await db.execute({
    sql: `INSERT INTO events (id, organizer_pollar_id, name, datetime_utc, place, price_stroops, capacity)
          VALUES (?, 'GORGANIZER000000000000000000000000000000000000000000000', 'Spike door event', datetime('now'), 'Test', 10000000, 100)`,
    args: [id],
  });
  return id;
}

/** 1. Primer escaneo acepta y marca usado; segundo rechaza. */
async function testFirstAcceptsSecondRejects(): Promise<void> {
  const eventId = await createEvent();
  const { code } = await createPaidSaleWithTicket(eventId);

  const first = await validateAtDoor(eventId, code, "GORGANIZER_DOOR");
  check("primer escaneo: VALID", first.result === "VALID", `result=${first.result}`);

  const second = await validateAtDoor(eventId, code, "GORGANIZER_DOOR");
  check("segundo escaneo del mismo código: USED", second.result === "USED", `result=${second.result}`);
}

/** 2. Dos escaneos simultáneos del mismo código: gana uno. */
async function testConcurrentSameCode(): Promise<void> {
  const eventId = await createEvent();
  const { code } = await createPaidSaleWithTicket(eventId);

  const [a, b] = await Promise.all([
    validateAtDoor(eventId, code, "SCANNER_A"),
    validateAtDoor(eventId, code, "SCANNER_B"),
  ]);

  const results = [a.result, b.result].sort();
  check(
    "exactamente un VALID y un USED entre los dos escaneos simultáneos",
    results[0] === "USED" && results[1] === "VALID",
    `[${a.result}, ${b.result}]`
  );
}

/** 3. Ticket de otro evento: UNKNOWN, sin consumir. */
async function testWrongEventIsUnknown(): Promise<void> {
  const eventA = await createEvent();
  const eventB = await createEvent();
  const { code } = await createPaidSaleWithTicket(eventA);

  const wrongEventScan = await validateAtDoor(eventB, code, "GORGANIZER_B");
  check(
    "ticket válido de evento A escaneado en evento B: UNKNOWN",
    wrongEventScan.result === "UNKNOWN",
    `result=${wrongEventScan.result}`
  );

  // Confirm it was NOT consumed: it must still validate fine on its real event.
  const rightEventScan = await validateAtDoor(eventA, code, "GORGANIZER_A");
  check(
    "el mismo ticket sigue sin consumir: VALID en su evento real",
    rightEventScan.result === "VALID",
    `result=${rightEventScan.result}`
  );
}

/** 4b. El door_code corto (tipeado a mano) valida el mismo ticket que el code largo. */
async function testDoorCodeAlsoValidates(): Promise<void> {
  const eventId = await createEvent();
  const { doorCode } = await createPaidSaleWithTicket(eventId);

  const scan = await validateAtDoor(eventId, doorCode, "GORGANIZER_DOOR");
  check("door_code corto: VALID", scan.result === "VALID", `result=${scan.result}`);

  const second = await validateAtDoor(eventId, doorCode, "GORGANIZER_DOOR");
  check("mismo door_code de nuevo: USED", second.result === "USED", `result=${second.result}`);
}

/** 4c. Un código que directamente no existe también da UNKNOWN. */
async function testNonexistentCodeIsUnknown(): Promise<void> {
  const eventId = await createEvent();
  const result = await validateAtDoor(eventId, "DOESNOTEXIST00000000000000", "GORGANIZER_DOOR");
  check("código inexistente: UNKNOWN", result.result === "UNKNOWN", `result=${result.result}`);
}

async function main() {
  await dbReady();
  console.log("\nFase 4 — SPIKE C: puerta atómica\n");
  await testFirstAcceptsSecondRejects();
  await testConcurrentSameCode();
  await testWrongEventIsUnknown();
  await testDoorCodeAlsoValidates();
  await testNonexistentCodeIsUnknown();
  console.log(`\n${passed} pass, ${failed} fail\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\nel spike se cayó:", e);
  process.exit(1);
});
