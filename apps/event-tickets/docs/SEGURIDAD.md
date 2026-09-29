# Seguridad — Pollar Pass

Qué protege esta app, cómo, y qué decidimos **no** hacer. Escrito para que
el próximo cambio no reabra algo en silencio.

Revisión completa: 20 de septiembre de 2026, contra el
[OWASP Top 10:2025](https://owasp.org/Top10/2025/).

## Qué hay que proteger

Tres cosas, en orden:

1. **Las entradas.** El código QR *es* la entrada: quien lo tiene, entra.
   No hay nada más que verificar en la puerta.
2. **El dinero.** Los pagos van directo del comprador al organizador en la
   red Stellar. La app nunca custodia fondos, pero sí decide qué pago
   cuenta como pagado.
3. **Los datos del comprador.** Su dirección Stellar y —si la da— su
   dirección de correo.

## De quién

| Amenaza | Respuesta |
|---|---|
| Entrar con una captura del QR de otro | Cada entrada se marca usada en el mismo `UPDATE` que la valida (`lib/tickets.ts`) |
| Reusar una entrada de otro evento | `event_id` va en el mismo `UPDATE`: responde `UNKNOWN`, indistinguible de un código inexistente |
| Adivinar un código de entrada | 26 caracteres de un alfabeto de 31 = ~128 bits, CSPRNG con rejection sampling |
| Decir "soy el organizador" | La identidad sale de una firma SEP-53 verificada, nunca de un campo del body (`lib/auth.ts`) |
| Reusar una firma en otro endpoint | La firma incluye método y ruta; ventana de 2 minutos |
| Decir "ya pagué" sin pagar | Todo pago se verifica contra Horizon: destinatario, emisor de USDC, monto en stroops y memo |
| Cobrar dos veces el mismo pago | El memo es único por venta, y `sales.reference` es `UNIQUE` |
| Quedarse con todos los cupos sin pagar | Una reserva viva por comprador y por tipo, 10 minutos, y barrido automático |
| Vender más entradas que cupos | Reserva atómica por tipo: `UPDATE … WHERE reserved < capacity RETURNING` |
| Quemar nuestros recursos | Cuotas por cuenta y por IP (`lib/rate-limit.ts`) |
| Inyectar un script en la página | CSP con nonce y `strict-dynamic` (`proxy.ts`) |
| Poner la pantalla de puerta en un iframe | `frame-ancestors 'none'` + `X-Frame-Options: DENY` |
| Leer la base de datos a través de la app | Todo el SQL es parametrizado, sin excepción |

## De quién *no*

Decirlo importa tanto como lo anterior:

- **De alguien con acceso a la cuenta Pollar del comprador.** Si entran a
  su cuenta, son el comprador. La app no puede distinguirlos.
- **De un organizador deshonesto.** Puede no aparecer a su propio evento.
  El dinero va directo a él; la app nunca lo retiene, así que tampoco
  puede devolverlo por su cuenta (sí registra la devolución que él haga,
  verificada en la red).
- **De un ataque de volumen.** Las cuotas frenan un script, no una
  botnet. Eso es trabajo de la plataforma (Vercel).
- **De quien reenvía su propio QR.** Es su entrada; si la regala, la
  primera persona que llegue entra. Por eso vale una sola vez.

## Dónde vive cada control

| Control | Archivo |
|---|---|
| Identidad por firma SEP-53, atada a la ruta | `lib/auth.ts`, `lib/auth-message.ts`, `lib/auth-client.ts` |
| Link de puerta para el personal (caduca con el evento) | `lib/auth.ts` → `requireDoorAccess` |
| Cuotas de uso | `lib/rate-limit.ts` |
| Cabeceras planas (nosniff, frame, referrer, permissions) | `next.config.ts` |
| CSP con nonce por petición | `proxy.ts` |
| Verificación de pagos en la red | `lib/horizon.ts`, `lib/usdc.ts` |
| Montos en stroops, nunca en float | `lib/money.ts` |
| Estados de una venta y reserva atómica | `lib/sales.ts` |
| Validación en puerta (atómica, en dos pasos) | `lib/tickets.ts` |
| Retención del correo del comprador | `lib/retention.ts` |
| Registro de eventos de seguridad | `lib/security-log.ts` |

## Decisiones que parecen flojas y no lo son

**La firma vale 2 minutos y no es de un solo uso.** Atarla a un solo uso
obligaría a firmar en cada petición, y en una billetera externa
(Freighter, Albedo) cada firma es una ventana que el usuario tiene que
aprobar. Preferimos atarla al endpoint: una firma robada no sirve en otro
lado, que es el ataque real.

**La firma ata la *forma* de la ruta, no el id.** `POST
/api/sales/:id/confirm` cubre cualquier venta. Atar el id exacto
significaría una firma —y un popup— por venta.

**El endpoint del QR no pide login.** La URL contiene el código, y el
código es la entrada: quien tiene la URL ya podía entrar. Pedir login
rompería el correo, que es justo donde vive esa imagen.

**El límite de uso falla abierto.** Si la base de datos no responde, el
limitador es lo menos importante que se acaba de romper.

## Rutinas

```bash
pnpm audit    # dependencias con CVE conocido; falla con severidad alta o peor
pnpm test     # incluye tests/security.test.mts: 13 casos de abuso
```

`.npmrc` fija `minimum-release-age=1440`: nunca instalamos una versión
publicada hace menos de 24 horas. Una release comprometida suele
retirarse en horas; así no somos los primeros en ejecutarla.

Antes de cada deploy: `pnpm audit && pnpm test && pnpm build`.

## Checklist manual (contra producción)

Lo que no cubre un test automático, porque necesita un navegador real:

1. Las cabeceras están: `curl -sSI https://pollarpass.vercel.app/ | grep -i
   "content-security\|x-frame\|x-content\|referrer\|permissions"`.
2. Ninguna ruta `/api` responde 200 sin sesión.
3. Con dos cuentas: la cuenta B no ve la venta de A (`/api/sales/<id>` → 403).
4. El link de puerta no abre el panel del organizador ni la lista de ventas.
5. Revocar el link de puerta lo invalida de inmediato.
6. Un QR ya usado responde `USED` y no descuenta cupo otra vez.
7. Una compra rechazada libera el cupo (el evento no queda "agotado").
8. El correo de la entrada muestra el QR (no un cuadro roto).
9. Cambiar idioma y tema no expone datos de otra sesión.

## Reportar un problema

Todavía **no** publicamos `/.well-known/security.txt`: hace falta decidir
qué contacto exponer (un correo público se cosecha para siempre). La
plantilla está en `docs/security.txt.ejemplo`; para publicarla, completa
`Contact:` y muévela a `public/.well-known/security.txt`.

## Pendiente

- Rotar el token de Turso: estuvo en `.env`, que cargan todos los scripts.
- Marcar `DATABASE_URL`, `DATABASE_AUTH_TOKEN` y `RESEND_API_KEY` como
  *Sensitive* en Vercel; hoy son legibles desde el panel.
- Separar la base de datos de *preview* de la de producción: hoy un deploy
  de preview escribe en los datos reales.
- Dominio propio verificado en Resend (hoy `onboarding@resend.dev`, sin
  SPF/DKIM nuestro).
- `pnpm audit` en CI. No se agregó acá porque el workflow viviría en la
  raíz del monorepo, fuera del alcance de este app.
