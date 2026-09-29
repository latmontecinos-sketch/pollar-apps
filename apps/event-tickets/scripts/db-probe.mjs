/**
 * Fase 0 — sonda de la capa de datos.
 *
 * Prueba, contra la MISMA base que se va a usar, los cinco primitivos sobre los
 * que se apoya todo el diseno: transaccion, rollback, UPDATE ... RETURNING,
 * restriccion UNIQUE y dos clientes concurrentes compitiendo por la misma fila.
 *
 * No modela eventos ni ventas: usa tablas `probe_*` desechables. Lo unico que
 * responde es si el motor se comporta como el diseno asume.
 *
 * Uso:
 *   node scripts/db-probe.mjs                      -> file:./probe.db (local)
 *   DATABASE_URL=libsql://... DATABASE_AUTH_TOKEN=... node scripts/db-probe.mjs
 *   node --env-file=.env scripts/db-probe.mjs
 */

import { createClient } from "@libsql/client";

const URL = process.env.DATABASE_URL ?? "file:./probe.db";
const AUTH_TOKEN = process.env.DATABASE_AUTH_TOKEN;
const REMOTE = !URL.startsWith("file:");

/** Cada cliente simula una invocacion serverless distinta. */
const newClient = () => createClient({ url: URL, authToken: AUTH_TOKEN });

let passed = 0;
let failed = 0;

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function setup(db) {
  await db.batch(
    [
      "DROP TABLE IF EXISTS probe_sales",
      "DROP TABLE IF EXISTS probe_events",
      `CREATE TABLE probe_events (
         id       TEXT PRIMARY KEY,
         capacity INTEGER NOT NULL,
         reserved INTEGER NOT NULL DEFAULT 0
       )`,
      `CREATE TABLE probe_sales (
         id        TEXT PRIMARY KEY,
         event_id  TEXT NOT NULL,
         reference TEXT NOT NULL UNIQUE,
         status    TEXT NOT NULL
       )`,
    ],
    "write",
  );
}

/** 1. Transaccion interactiva + COMMIT: lo escrito persiste. */
async function testCommit(db) {
  const tx = await db.transaction("write");
  await tx.execute({
    sql: "INSERT INTO probe_events (id, capacity, reserved) VALUES (?, ?, 0)",
    args: ["evt_commit", 5],
  });
  await tx.commit();

  const r = await db.execute({
    sql: "SELECT reserved FROM probe_events WHERE id = ?",
    args: ["evt_commit"],
  });
  check("transaccion + COMMIT persiste", r.rows.length === 1);
}

/** 2. ROLLBACK: nada de lo escrito dentro sobrevive. */
async function testRollback(db) {
  const tx = await db.transaction("write");
  await tx.execute({
    sql: "INSERT INTO probe_events (id, capacity, reserved) VALUES (?, ?, 0)",
    args: ["evt_rollback", 5],
  });
  const dentro = await tx.execute({
    sql: "SELECT id FROM probe_events WHERE id = ?",
    args: ["evt_rollback"],
  });
  await tx.rollback();

  const fuera = await db.execute({
    sql: "SELECT id FROM probe_events WHERE id = ?",
    args: ["evt_rollback"],
  });
  check(
    "ROLLBACK descarta la escritura",
    dentro.rows.length === 1 && fuera.rows.length === 0,
    `visible dentro de la tx: ${dentro.rows.length === 1}, visible despues: ${fuera.rows.length === 1}`,
  );
}

/**
 * 3. UPDATE ... RETURNING condicional.
 * La transicion es la autoridad: devuelve fila solo si gano la carrera.
 */
async function testReturning(db) {
  await db.execute({
    sql: "INSERT INTO probe_events (id, capacity, reserved) VALUES (?, 1, 0)",
    args: ["evt_ret"],
  });

  const primero = await db.execute({
    sql: "UPDATE probe_events SET reserved = reserved + 1 WHERE id = ? AND reserved < capacity RETURNING reserved",
    args: ["evt_ret"],
  });
  const segundo = await db.execute({
    sql: "UPDATE probe_events SET reserved = reserved + 1 WHERE id = ? AND reserved < capacity RETURNING reserved",
    args: ["evt_ret"],
  });

  check(
    "UPDATE ... RETURNING devuelve la fila cuando la condicion se cumple",
    primero.rows.length === 1 && Number(primero.rows[0].reserved) === 1,
    `reserved = ${primero.rows[0]?.reserved}`,
  );
  check(
    "UPDATE ... RETURNING devuelve vacio cuando no se cumple (agotado)",
    segundo.rows.length === 0,
  );
}

/** 4. UNIQUE: el duplicado tiene que fallar, y el fallo tiene que ser reconocible. */
async function testUnique(db) {
  await db.execute({
    sql: "INSERT INTO probe_sales (id, event_id, reference, status) VALUES (?, ?, ?, 'pending')",
    args: ["sale_1", "evt_ret", "ref_dup"],
  });

  let err = null;
  try {
    await db.execute({
      sql: "INSERT INTO probe_sales (id, event_id, reference, status) VALUES (?, ?, ?, 'pending')",
      args: ["sale_2", "evt_ret", "ref_dup"],
    });
  } catch (e) {
    err = e;
  }

  const mensaje = err ? `${err.code ?? ""} ${err.message ?? ""}`.trim() : "";
  check("UNIQUE rechaza el duplicado", err !== null, mensaje.slice(0, 120));
  check(
    "el error de UNIQUE es identificable en codigo",
    /UNIQUE|CONSTRAINT/i.test(mensaje),
    `code=${err?.code ?? "-"}`,
  );

  const filas = await db.execute("SELECT COUNT(*) AS n FROM probe_sales");
  check("quedo una sola fila", Number(filas.rows[0].n) === 1);
}

/**
 * 5. Concurrencia real: N clientes independientes compiten por el ultimo cupo.
 * Cada worker abre su propia transaccion, reserva y crea la venta: si el INSERT
 * falla, el rollback tiene que devolver el asiento (nada de asientos fantasma).
 */
async function testConcurrency(db, workers = 8) {
  await db.execute({
    sql: "INSERT INTO probe_events (id, capacity, reserved) VALUES (?, 1, 0)",
    args: ["evt_race"],
  });

  const intento = async (i) => {
    const client = newClient();
    try {
      const tx = await client.transaction("write");
      try {
        const cupo = await tx.execute({
          sql: "UPDATE probe_events SET reserved = reserved + 1 WHERE id = ? AND reserved < capacity RETURNING reserved",
          args: ["evt_race"],
        });
        if (cupo.rows.length === 0) {
          await tx.rollback();
          return { i, resultado: "agotado" };
        }
        await tx.execute({
          sql: "INSERT INTO probe_sales (id, event_id, reference, status) VALUES (?, ?, ?, 'pending')",
          args: [`race_${i}`, "evt_race", `ref_race_${i}`],
        });
        await tx.commit();
        return { i, resultado: "gano" };
      } catch (e) {
        await tx.rollback().catch(() => {});
        return { i, resultado: "error", error: `${e.code ?? ""} ${e.message ?? e}`.trim() };
      }
    } catch (e) {
      return { i, resultado: "error", error: `${e.code ?? ""} ${e.message ?? e}`.trim() };
    } finally {
      client.close();
    }
  };

  const res = await Promise.all(
    Array.from({ length: workers }, (_, i) => intento(i)),
  );

  const ganadores = res.filter((r) => r.resultado === "gano");
  const agotados = res.filter((r) => r.resultado === "agotado");
  const errores = res.filter((r) => r.resultado === "error");

  const evento = await db.execute({
    sql: "SELECT reserved FROM probe_events WHERE id = ?",
    args: ["evt_race"],
  });
  const ventas = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM probe_sales WHERE event_id = ?",
    args: ["evt_race"],
  });

  check(
    `${workers} clientes concurrentes, capacity=1: gana exactamente uno`,
    ganadores.length === 1,
    `ganaron ${ganadores.length}, agotado ${agotados.length}, error ${errores.length}`,
  );
  check("reserved quedo en 1", Number(evento.rows[0].reserved) === 1, `reserved = ${evento.rows[0].reserved}`);
  check("se creo una sola venta", Number(ventas.rows[0].n) === 1, `ventas = ${ventas.rows[0].n}`);

  if (errores.length > 0) {
    console.log(`  nota  ${errores.length} worker(s) fallaron por contencion del motor:`);
    for (const e of errores.slice(0, 3)) console.log(`        [${e.i}] ${e.error.slice(0, 140)}`);
    console.log("        (aceptable si reserved=1 y ventas=1: el reintento es responsabilidad de la capa de arriba)");
  }
}

/** 6. Asiento fantasma: si el INSERT falla, la reserva no puede quedar consumida. */
async function testNoPhantomSeat(db) {
  await db.execute({
    sql: "INSERT INTO probe_events (id, capacity, reserved) VALUES (?, 10, 0)",
    args: ["evt_phantom"],
  });
  await db.execute({
    sql: "INSERT INTO probe_sales (id, event_id, reference, status) VALUES (?, ?, ?, 'pending')",
    args: ["sale_phantom", "evt_phantom", "ref_phantom"],
  });

  const tx = await db.transaction("write");
  let fallo = false;
  try {
    await tx.execute({
      sql: "UPDATE probe_events SET reserved = reserved + 1 WHERE id = ? AND reserved < capacity RETURNING reserved",
      args: ["evt_phantom"],
    });
    // mismo `reference` -> viola UNIQUE -> la transaccion entera se cae
    await tx.execute({
      sql: "INSERT INTO probe_sales (id, event_id, reference, status) VALUES (?, ?, ?, 'pending')",
      args: ["sale_phantom_2", "evt_phantom", "ref_phantom"],
    });
    await tx.commit();
  } catch {
    fallo = true;
    await tx.rollback().catch(() => {});
  }

  const evento = await db.execute({
    sql: "SELECT reserved FROM probe_events WHERE id = ?",
    args: ["evt_phantom"],
  });
  check("el INSERT de la venta fallo como se esperaba", fallo);
  check(
    "sin asiento fantasma: reserved volvio a 0",
    Number(evento.rows[0].reserved) === 0,
    `reserved = ${evento.rows[0].reserved}`,
  );
}

async function main() {
  console.log(`\nSonda de datos — ${REMOTE ? "DB REMOTA" : "archivo local"}`);
  console.log(`URL: ${URL.replace(/\/\/.*@/, "//***@")}`);
  if (REMOTE && !AUTH_TOKEN) console.log("aviso: DATABASE_URL remota sin DATABASE_AUTH_TOKEN\n");
  console.log("");

  const db = newClient();
  try {
    await setup(db);
    await testCommit(db);
    await testRollback(db);
    await testReturning(db);
    await testUnique(db);
    await testConcurrency(db);
    await testNoPhantomSeat(db);
  } finally {
    db.close();
  }

  console.log(`\n${passed} pass, ${failed} fail\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\nla sonda se cayo:", e);
  process.exit(1);
});
