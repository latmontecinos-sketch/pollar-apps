# SDK-NOTES — Fase 1

Fuentes usadas: `template/` (copiado a este app), `node_modules/@pollar/{core,react}/dist/index.d.ts`
(tipos reales del SDK 0.11.2, generados desde el OpenAPI del backend de Pollar),
`https://docs.pollar.xyz/llms-full.txt`, el dashboard (`dashboard.pollar.xyz`), y el código de
**dos apps ya mergeadas de este mismo monorepo** (`apps/vendor-pay-link`, `apps/qr-menu-orders`) —
la evidencia más fuerte posible porque son PRs aceptados que ya resolvieron estos mismos problemas.

Cada respuesta está marcada **[verificado]** (visto directamente en código/tipos/docs, con cita) o
**[supuesto pendiente]** (no confirmado, a probar empíricamente en fases siguientes).

---

## 1. ¿Se puede adjuntar una referencia/memo al pago, y se recupera del historial?

**[verificado]** Sí, pero con un matiz importante.

- `POST /tx/build` acepta `options.memo: { type: "text", value: string }` — visto en los tipos
  generados (`@pollar/core/dist/index.d.ts:1362-1367` y `:2056-2061`). `runTx('payment', params, { memo: {...} })`
  es la vía real y tipada.
- **El historial propio del SDK (`getTxHistory` / `useBalance`'s hermano `txHistory`) NO expone el
  memo de forma fiable.** Su respuesta (`index.d.ts:2447-2468`) trae `summary: string` (texto suelto
  tipo "Sent 10.00 USDC") y un `details: {[key: string]: unknown}` sin tipar — nada de un campo `memo`
  garantizado. `apps/vendor-pay-link/lib/parse-history.ts` lo confirma explícitamente en su comentario:
  *"Amount matching is the fallback when memo is absent from the history API"*.
- **La vía que sí funciona, ya probada en producción:** `apps/vendor-pay-link/lib/horizon.ts`
  (`verifyPaymentOnHorizon`) recupera el memo consultando **Horizon testnet directamente** por hash
  de transacción (`GET /transactions/{hash}` → `tx.memo` + `tx.memo_type === "text"`), no vía el SDK.

**Conclusión para Fase 2:** Plan A (referencia en memo) es viable, pero la verificación pasa por
Horizon con el hash reportado por el cliente — es decir, en la práctica es un híbrido A+C, no A puro.
Exactamente el patrón que ya usa `vendor-pay-link` en un PR mergeado.

## 2. ¿Puede el servidor leer el historial del organizador, o solo el cliente con su sesión?

**[verificado]** Solo el cliente, con su propia sesión. `getTxHistory` es un endpoint autenticado
(401 documentado en `index.d.ts:2491-2505`) y las sesiones de Pollar son **DPoP-bound**: la clave que
firma cada request vive en el dispositivo del usuario (ver §8). El servidor no tiene forma de
"tomar prestada" esa sesión ni de llamar `tx/history` en nombre del usuario.

**Lo que el servidor sí puede hacer:** leer **Horizon testnet directamente** (`horizon-testnet.stellar.org`,
público, sin auth) para la cuenta que nos interesa (la del organizador/evento), dado un hash de
transacción. Es exactamente lo que hace `vendor-pay-link/lib/horizon.ts`. El modelo de resolución
server-side del diseño (§4) **se sostiene**, pero apoyado en Horizon, no en el SDK de Pollar.

## 3. ¿Qué claves existen, cuál necesita el servidor, cómo encaja con el arranque del bounty?

**[verificado]** Dos tipos de clave a nivel de app (creadas en el dashboard, Build → API Keys),
más un tercer tipo a nivel de cuenta que no es lo que el `.env.example` pide:

| Clave | Prefijo | Dónde vive | Para qué |
|---|---|---|---|
| Publishable | `pub_testnet_…` | Frontend (`NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY`) | Inicializa el SDK en el browser. Segura de exponer. |
| Secret | `sec_testnet_…` | Backend (`POLLAR_SECRET_KEY`), solo en API routes | Llamadas privilegiadas: `POST /v1/wallets/activate` (modo Deferred), y análogas. **Nunca** desde el cliente. |
| Personal Access Token (`pat_…`) | — | Cuenta del dashboard, no de la app | Automatización sobre el dashboard mismo (gestión de apps vía MCP/API), **no** es ni publishable ni secret. No corresponde a ningún campo del `.env.example`. |

Confirmado creando la app "Pase"/Pollar Pass en el dashboard: sección "API Keys" separa
Publishable/Secret con exactamente esos prefijos (`pub_testnet_c646…`, `sec_testnet_cab8…`).

**Cómo encaja con el arranque ("solo la API key" en local):** la Secret key **no es necesaria para
el arranque local básico** — el `.env.example` la marca opcional ("Only needed for privileged server
calls"). Nuestro diseño la necesita igual, porque la emisión de tickets corre en un route handler
server-side; pero el arranque en frío sigue funcionando con solo la publishable, y el README debe dejar
claro que la Secret solo hace falta si se prueban los endpoints de puerta/verificación localmente
contra Pollar (no para simplemente ver la UI).

## 4. ¿Cómo se prefijan destinatario e importe? ¿Editable por el usuario?

**[verificado]** `components/PayButton.tsx` (nuestra copia del template, línea 42-64): `amount` y
`recipient` son props de string fijadas por la app — el componente solo los muestra y pide confirmar,
nunca renderiza un input editable para ellos. El monto **no es editable por el usuario** en este flujo.
(El componente separado `SendModal` sí es un "enviar dinero" genérico con monto editable — pero ese no
es el que usaríamos para una compra con precio fijo.)

Esto valida que un Plan B (monto único `price + salt`) sería técnicamente viable si hiciera falta —
pero dado que el memo (§1) sí funciona, no debería hacer falta.

**Limitación real encontrada:** `PayButton` no expone una prop `memo`/`options`. Para adjuntar memo
vamos a necesitar un componente propio (permitido por CLAUDE.md, "add your own alongside the UI kit")
que llame `usePollar().runTx('payment', params, { memo: {...} })` directamente, replicando la lógica
interna de `PayButton` pero con memo. Confirmar en Fase 2.

## 5. ¿Con qué precisión decimal maneja los importes de USDC?

**[verificado]** 7 decimales, como toda la red Stellar (1 stroop = 1e-7). `SendPaymentParams.amount`
es un string decimal (`index.d.ts:8495-8496`, comentario: *"Decimal string, e.g. '1.5'"*).
`apps/vendor-pay-link/lib/horizon.ts:normalizeAmount` usa `Number(value).toFixed(7)` para comparar
montos contra Horizon — confirma que 7 es la precisión de trabajo real, coherente con nuestro diseño
en stroops enteros (§3 del brief).

## 6. ¿Qué identificador estable tenemos para buyer/organizer_pollar_id?

**[verificado]** La dirección Stellar (`G…`), `user.address` en `usePollarAuth()`
(`hooks/usePollarAuth.ts:8-9`, comentario: *"the user's stable id across every Pollar app"*).
Confirmado también en la UI del propio SDK: el modal "Receive money" dice textualmente *"Same account,
same balance, in every Pollar app"*. Es la misma cuenta Stellar en cualquier app construida sobre
Pollar — coincide con `buyer_pollar_id`/`organizer_pollar_id` del esquema.

## 7. ¿Qué devuelve el flujo de envío al completarse? ¿Cuándo se considera confirmado?

**[verificado]** `SubmitOutcome` (`index.d.ts:8520-8536`) es una unión de tres estados:

```ts
{ status: 'success', hash: string, buildData?: ... }
{ status: 'pending',  hash: string, buildData?: ... }
{ status: 'error',    hash?: string, details?, resultCode?, code?, message? }
```

`status: 'success'` trae hash y, por cómo Stellar/Horizon confirman síncronamente al enviar, implica
que la transacción ya está en el ledger. `status: 'pending'` también trae hash pero sin confirmación
aún (rutas async, p. ej. fee-bump patrocinado). **Para la correlación del pago, el `tx_hash` es utilizable
en ambos casos** — la verificación real de "está de verdad en el ledger" la hacemos nosotros consultando
Horizon (§1/§2), no confiando ciegamente en el string `status` del SDK. Esto es justo la distinción que
pide la pregunta: "el usuario apretó pagar" (processing) ≠ "la red la aceptó" (`success`/`pending` con
hash) ≠ "confirmada en Horizon" (lo que nosotros verificamos aparte).

## 8. ¿Cómo se verifica server-side la identidad de la sesión Pollar en una API route de Next?

**[verificado — el hallazgo más importante de esta fase.]** **No se puede** con un `Authorization: Bearer`
convencional. Las sesiones de Pollar están atadas a DPoP (prueba de posesión de clave, firmada en el
dispositivo del usuario) — la clave que firma nunca sale del browser, así que reenviar un token al
propio backend no prueba nada ahí. Esto está confirmado tanto en los tipos internos del cliente
(`PollarClient._buildProofForRequest`, `_dpopNonce`, comentarios sobre "DPoP proof", `index.d.ts:8927-8935`)
como, de forma explícita y en producción, en el comentario de `apps/vendor-pay-link/lib/require-session.ts:16-19`:

> *"Pollar access tokens are DPoP-bound, so a Bearer token + POLLAR_SECRET_KEY cannot prove the caller
> on our server. The live Pollar session signs a short-lived SEP-53 message instead."*

**El patrón que sí funciona (copiado de esa app, ya mergeada):**

1. Cliente: `client.stellar.sep53.signMessage(mensaje)` firma un mensaje corto y con expiración
   (`apps/vendor-pay-link/lib/pollar-fetch.ts`). El mensaje es algo como `auth:{address}:{exp}`.
2. Cliente adjunta `{address, exp, signature}` como header propio en el `fetch` a nuestra propia API.
3. Servidor: reconstruye el mismo mensaje, verifica la firma con `@stellar/stellar-base`
   (`Keypair.fromPublicKey(address).verify(digest, sig)`) — **sin llamar a Pollar para nada**, es
   verificación criptográfica pura (`apps/vendor-pay-link/lib/sep53.ts`). TTL corto (ellos usan 10 min
   máx.) evita replay.

Esto es exactamente lo que necesita el diseño de autorización del brief (§4): la identidad nunca sale
de algo que el cliente "dice" (un `pollar_id` en el body), sino de una firma verificable
criptográficamente contra la clave pública (que ES la dirección Stellar = el `pollar_id`).

**Alternativa descartada:** `apps/qr-menu-orders/lib/admin-auth.ts` resuelve el mismo problema de otra
forma — emite su **propia** cookie/token opaco, desacoplado de la identidad Pollar ("whoever holds this
cookie owns this restaurant"). Funciona para su caso, pero no sirve para el nuestro: nuestro modelo de
autorización (§4 del brief) necesita atar cada acción a un `pollar_id` real —Mis Pases, panel del
organizador— no a la posesión de una cookie de este navegador. Vamos con el patrón SEP-53 de
`vendor-pay-link`.

---

## Hallazgo colateral: `/charges` no es un atajo utilizable

El OpenAPI interno del SDK expone `/charges` y `/charges/{id}` ("Pollar Pay point-of-sale charge",
`index.d.ts:1038-1077,6355-6469`) con estados `pending/completed/overpaid/underpaid/expired/refunded` —
muy parecido a lo que estamos construyendo nosotros mismos. Pero es un producto POS separado
("reserves a pool wallet... for one of the application branches"), **`PollarClient` no expone ningún
método para invocarlo**, no tiene body de creación documentado, y depende de un concepto de "branches"
que nuestra app no tiene. Descartado como atajo — seguimos con el diseño propio del brief.

---

## Modelo de autorización — cerrado

Con las respuestas de arriba, el modelo de autorización de organizador/comprador/puerta del brief (§4)
**se sostiene tal cual está escrito**, implementado así:

- Toda ruta que necesite saber "quién sos" exige el header de prueba SEP-53 (patrón de
  `vendor-pay-link/lib/require-session.ts`, adaptado con nuestro propio nombre de header/mensaje).
- El servidor nunca confía en un `pollar_id`/dirección enviada en el body — solo en la dirección que
  salió de verificar la firma.
- Ownership (organizador dueño del evento, comprador dueño de la venta) se resuelve comparando esa
  dirección verificada contra `events.organizer_pollar_id` / `sales.buyer_pollar_id` en la DB, nunca
  al revés.
- La emisión de tickets y la validación en puerta corren en route handlers propios; la Secret key
  (`POLLAR_SECRET_KEY`) solo entra en juego si necesitamos alguna llamada privilegiada a Pollar
  (no la necesitamos para nada del flujo central de tickets — activación Deferred no aplica a nuestro
  caso, usamos modo Immediate).

Nada de esto bloquea el diseño. Pasamos a Fase 2 (SPIKE A) con evidencia, no con supuestos.
