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
| Reusar una firma en otra instalación (staging, otra red) | La firma incluye red y host; el servidor acepta una lista explícita de hosts (`APP_ORIGIN`, ver abajo) |
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

**Una reserva hecha con acceso a un evento lo conserva hasta el pago.**
`POST /api/sales/:id/pay` no vuelve a mirar la visibilidad del evento
(`canView`): el código de acceso de un evento privado se exige al *reservar*
(`POST /api/sales`). Si el organizador lo vuelve privado (o cambia el código)
después, quien ya tiene un cupo apartado puede pagarlo igual; no se le deja
una reserva que no puede usar. Una reserva nueva sí pide el código. Es una
excepción consciente a la regla "toda ruta de venta llama a `canView`", y
`confirm` y `release` nunca la aplican: reconcilian dinero que ya salió.

**Quién puede dar por muerto un intento de pago.** Las compras y las
devoluciones usan un derecho exclusivo de envío (`pay_started_at` /
`refund_started_at`). Una vez iniciado:

- Solo el ganador recibe `claimToken`; las respuestas de quien pierde no lo
  llevan ni llevan la hora de inicio. Devolver el derecho después de iniciado
  (`/release`, `/refund/release`) exige ese token **y** la hora del intento.
  Que el ganador clasifique su propio fallo como "nunca salió"
  (`classifySubmit`) es la única confianza que queda, y se acepta porque solo
  su pestaña tiene el token; si se equivoca, el pago aterriza como `unclaimed`
  y se devuelve (el dinero no se pierde). Sin intento iniciado, `/release`
  sigue sirviendo para un checkout abandonado. Aceptado por diseño: un
  comprador que envía y después suelta con su propio token solo deja
  varado **su** pago (`unclaimed`, que va al flujo de devolución); un
  organizador que hace lo mismo con una devolución solo puede devolver dos
  veces desde **su** billetera. Ningún tercero puede provocarlo ni
  aprovecharlo, y el cliente solo suelta tras un rechazo comprobado.
- La transacción se construye acotada a lo que queda del derecho: el servidor
  responde con `remainingSec` y el cliente pide `timeoutSec = remainingSec -
  tiempo que lleva con la respuesta - margen`; con menos de 30 s no envía y
  devuelve el derecho (`lib/pay-attempt.ts`, `sendWindowSec`). El
  `remainingSec` lo calcula el servidor al responder, a partir del
  `startedAt` del propio derecho, así que un derecho viejo nunca vuelve con
  una ventana grande; el cronómetro del cliente arranca *antes* de pedir el
  derecho (cuenta también la ida y vuelta y una pestaña congelada mientras la
  respuesta viaja) y la ventana se calcula justo antes de `runTx`, sin
  ningún `await` en medio. **Riesgo residual:** una pestaña que se congele
  entre ese cálculo y la llegada de la petición de construcción a Pollar solo
  queda cubierta por `SEND_MARGIN_SEC` (15 s) más `ATTEMPT_SLACK_MS` (2 min):
  el SDK solo acepta un `timeoutSec` relativo, no un vencimiento absoluto.
  Todo esto depende además de que el SDK/backend de Pollar respete
  `timeoutSec` como `maxTime` de la transacción: ver "Pendiente".
- Dar un intento por muerto y soltar su cupo (o reabrir una devolución) es un
  `UPDATE` que vuelve a comprobar, al escribir, que el intento sigue siendo el
  que se leyó y que ya venció (`releaseIfDead`, `reopenDeadRefund`, el barrido).
  Y un "no hay pago" de Horizon solo vale si su historial ingerido llegó más
  allá del vencimiento del intento (`history_latest_ledger_closed_at`,
  `historyReaches` en `lib/horizon.ts`); si Horizon va atrasado el resultado
  es "no concluyente" y el derecho se queda.
- Las ventas `pending` y las devoluciones `unclaimed` con NULL de antes del
  protocolo se marcan como si su intento hubiera empezado, una sola vez, en
  una migración versionada (`claim-fence-v1` en `schema_migrations`, `lib/db.ts`)
  que no depende de que las columnas se creen en ese arranque: sirve igual
  para una base que ya corrió una versión intermedia. NULL nunca quiere decir
  "nunca se envió" para una fila anterior; después de la migración, una venta
  nueva sí conserva su NULL.
- Un "no hay pago" solo puede terminar un checkout si la decisión se toma con
  el instante anterior a la búsqueda (`releaseGate`): un intento vivo al
  empezar la búsqueda no se libera porque venció mientras corría.

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

**`APP_ORIGIN` es una lista, y el primero manda en el correo.** Se lee en
`lib/app-origin.ts`: uno o varios orígenes separados por comas.

- *Definida*: solo esos hosts pueden ser el destinatario de una firma. El
  host de la petición **no** se agrega (antes sí, y eso dejaba abierta
  cualquier otra entrada a la misma instalación). Quien tenga un alias o un
  dominio propio tiene que listarlo, o no podrá iniciar sesión por ahí.
- *Sin definir* (desarrollo, o un deploy que nunca la usó): vale el host de
  la petición, para que nadie quede sin poder entrar. En un route handler
  eso es `x-forwarded-host` si hay proxy (Vercel lo pone y descarta el que
  mande el cliente; Next.js lee el host de la app en ese orden, ver
  `docs/01-app/03-api-reference/05-config/01-next-config-js/serverActions.md`),
  si no `Host`, si no el de `request.url`.
- El correo enlaza al **primer** origen de la lista, ya normalizado
  (`https://host`), nunca a la lista entera: un valor con comas dentro de la
  URL del QR la rompía. Sin la variable cae al origen de la petición, que
  controla quien llama: por eso en producción hay que definirla.
- Una entrada inválida se ignora; si no queda ninguna válida, se trata como
  sin definir y el log lo dice.

Límite que no se oculta: la audiencia frena que una firma cruce de una
instalación a otra *por accidente*. No es defensa contra una página de
phishing que pide firmar lo que quiera.

**La puerta tiene cuota por actor y por evento.** Cada paso (mirar el código,
aceptar la entrada) cuenta aparte, y cada uno tiene un presupuesto para el
organizador y otro para el personal que usa el link de puerta (7200 y 3600
por hora y actor), más un tope del evento que suma los de todos. Así un link
de personal que agota su presupuesto no deja al organizador sin puerta, y un
evento grande (más de 2000 personas por hora, varias puertas con un mismo
link) no se frena a sí mismo. El link de puerta es un solo secreto: el
personal cuenta como un único actor.

**La cuota de códigos privados no es atómica, y se acepta.** Se mira si el
contador está en el tope (`isOverLimit`) y, solo si el código era falso, se
cuenta (`consume`): son dos sentencias. Peticiones que llegan juntas pasan
todas la primera antes de que ninguna cuente, así que el exceso posible es
el nivel de concurrencia (un IP, un evento), no algo que un atacante pueda
seguir creciendo. No cambia que solo cuentan los fallos.

**La foto del evento se valida por estructura, no se decodifica.**
`lib/event-image.ts` recorre el JPEG entero pero no decodifica los datos
comprimidos: bytes estructuralmente limpios que no son una imagen pasan, y
la foto se vería rota para quien la abra. El daño lo recibe quien la subió;
no puede llevar script (se sirve `image/jpeg`, `inline`). Decodificar pide
una biblioteca (sharp, jpeg-js) que no justifica una sola función.

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
qué contacto exponer (un correo público se cosecha para siempre). Para
publicarlo, crea `public/.well-known/security.txt` con `Contact:` (un
correo o una URL) y `Expires:` (una fecha futura, máximo un año).

## Pendiente

- Comprobar en vivo, con una sesión Pollar iniciada, que el SDK/backend
  respeta `timeoutSec` de `runTx` como `maxTime` de la transacción (que una
  transacción pedida con 40 s caduca a los ~40 s). Toda la cota del intento
  (`sendWindowSec`) descansa en eso; ningún test automático lo puede probar.
- La raíz de la Horizon pública de testnet trae `history_latest_ledger_closed_at`
  (visto con un GET de lectura el 4 de octubre de 2026). Una Horizon que no lo
  traiga cae a la hora de cierre de su último ledger ingerido
  (`/ledgers?order=desc&limit=1`). Si fallan las dos, el "no hay pago" tras
  vencer un intento queda "no concluyente" (falla del lado seguro: el derecho
  nunca se libera solo, y el comprador sigue en "verificar" hasta que lo
  arregle quien opera la app).
- Rotar el token de Turso: estuvo en `.env`, que cargan todos los scripts.
- Marcar `DATABASE_URL`, `DATABASE_AUTH_TOKEN`, `SMTP_PASS` y `RESEND_API_KEY` como
  *Sensitive* en Vercel; hoy son legibles desde el panel.
- Separar la base de datos de *preview* de la de producción: hoy un deploy
  de preview escribe en los datos reales.
- Correo: `lib/mail.ts` envía por SMTP cuando están `SMTP_HOST`, `SMTP_USER` y
  `SMTP_PASS`, y usa Resend como respaldo si no. Resend con el remitente de
  pruebas (`onboarding@resend.dev`) solo entrega al dueño de la cuenta; para
  producción hace falta SMTP o un dominio propio verificado, con SPF/DKIM.
- `pnpm audit` en CI. No se agregó acá porque el workflow viviría en la
  raíz del monorepo, fuera del alcance de este app.
