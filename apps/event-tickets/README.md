# Pollar Pass (`event-tickets`)

Ticket pre-sale and door check-in for small events in Bolivia (issue [#13](https://github.com/pollar-xyz/pollar-apps/issues/13)).

The organizer creates an event and gets a public link. A buyer opens that link, logs in with Pollar, and pays for a ticket in **USDC on Stellar testnet**, in-app — no external wallet, no QR to scan to buy. The ticket that comes back *is* a QR: the buyer shows it at the door, the organizer scans it (or types the short code by hand) to check them in, once, atomically.

📊 **[Documentación visual](docs/ARQUITECTURA.md)** — arquitectura, flujo de compra, check-in en la puerta y capturas reales, con [tablero editable en Figma](https://www.figma.com/board/OwFBSZmDTqxdJ1jHZfe4Km).

## Run from a fresh clone

```bash
cd apps/event-tickets
cp .env.example .env
pnpm install
pnpm dev
```

Required in `.env`: `NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY` (dashboard.pollar.xyz → Build → API Keys → publishable). Everything else is optional:

- **Local dev**: no database setup needed — falls back to `file:./dev.db`. If your `.env` also holds the production `DATABASE_URL` (e.g. copied from Vercel), add a `.env.development.local` with `DATABASE_URL=file:./dev.db` so `pnpm dev` never writes test data into production.
- **Production**: `DATABASE_URL` + `DATABASE_AUTH_TOKEN` (libSQL/Turso) are required; the app refuses to start on the local file DB in production rather than silently losing writes on a serverless filesystem.
- **`RESEND_API_KEY`**: optional, best-effort email of the ticket after purchase (see below).

Deploying to a new domain (Vercel or otherwise) also needs that domain added on the Pollar side, or every login fails with "Could not load sign-in options": dashboard.pollar.xyz → your app → Build → Domains → add the deploy URL (e.g. `https://your-app.vercel.app`) to both **Allowed origins** and **Allowed redirect URIs** (the latter is only checked for OAuth logins like Google — email/wallet login only needs the former). `localhost:3000` for local dev is separate and unaffected.

## Screens

| Path | Who | What |
|---|---|---|
| `/` | anyone | Product page: what Pollar Pass is, who it is for, how it works, with "Abrir la app" as the single action |
| `/app` | anyone | The app itself: balance, "get test USDC", scan an event, and the three main actions |
| `/como-funciona` | anyone, no login | In-app guide: buyer steps, organizer steps, FAQ (test USDC faucet, "I paid but got no ticket", refunds, privacy). Deep-linkable (`#usdc`, `#organizador`…) and reachable from the **Ayuda** button in every header |
| `/escanear` | anyone | Scan an event's QR (poster, invitation) to open its page |
| `/organizador/nuevo` | organizer | Create an event and its ticket tiers (General, VIP…), with a preview of the public page before publishing |
| `/e/[id]` | anyone, no login | Public event page — one row per ticket tier with its own price and remaining seats. Link previews (WhatsApp etc.) show the event's name, date and cheapest price |
| `/mis-pases` | buyer | "Mis entradas": every ticket with its QR; unconfirmed purchases get **"Ya pagué, verificar"** |
| `/mis-eventos` | organizer | Every event they organize, with sold count, linking to its panel |
| `/organizador/eventos/[id]` | owning organizer | Share the link (copy / WhatsApp / QR for posters), sold vs. in-progress vs. checked-in, edit event, extend capacity (twice at most), staff door link |
| `/organizador/eventos/[id]/puerta` | owning organizer | Door check-in: camera scan or typed short code, big green/red result that clears itself, live check-in counter |
| `/puerta/[id]` | door staff, no login | The same check-in screen, opened from the staff link the organizer shares (`#t=<token>`) |
| `/organizador/eventos/[id]/ventas` | owning organizer | Revenue, per-sale detail with Stellar receipt, who already got in |

## How payment correlation works (no client webhooks)

There's no merchant "charge" API in Pollar — an in-app purchase is a user-to-user Stellar payment (`runTx('payment', …)`). Buying a ticket:

1. `POST /api/sales` reserves a seat (atomic `UPDATE ... WHERE reserved < capacity`) and creates a `pending` sale with a unique `reference`.
2. The buyer pays the organizer's address with that reference in the memo — `PayButton` doesn't expose a memo, so this calls `runTx('payment', …)` directly, the same SDK method `SendModal` uses.
3. `POST /api/sales/[id]/confirm` takes the resulting hash and verifies it against **Horizon** (destination, amount, asset, memo) before ever trusting it. Marking the sale `paid` and issuing the ticket happen in one DB transaction. A hash that doesn't match, or a Horizon outage, never gets treated as "payment failed" — the sale just stays `pending` and the buyer can retry.
4. A sale that expires before payment lands releases its seat (`sweepExpiredSales`, run on the public page, before every new sale and in the organizer views — so an abandoned checkout can't make an event look sold out). A payment that arrives *after* expiry moves the sale to `unclaimed` instead of overselling a seat that may have been resold.

**Never charging twice.** Once a sale exists the buyer's browser remembers it, and once a payment may have been sent the only action offered is *verify* — never *buy* again. Confirmation retries with backoff (Horizon can lag a few seconds behind a fresh payment), resumes after a reload, and `confirm` also works **without a hash**: the server finds the payment on Horizon by the sale's unique memo. That's what "Mis entradas → Ya pagué, verificar" uses when the tab was closed mid-payment.

## Languages and theme

Spanish, English and French, plus light / dark / system. Both live in cookies read on the **server** (`lib/i18n/server.ts`), so the first paint is already in the right language and theme — no flash, and shared links preview correctly for whoever opens them. A visitor with no cookie gets their `Accept-Language`. `lib/i18n/es.ts` is the source dictionary; `en.ts` and `fr.ts` are typed against it, so a missing key fails the build instead of rendering blank. Amounts and dates follow the reader's language (`2,50` vs `2.50`) while event times stay in `America/La_Paz` — the event happens in Bolivia whoever is reading.

## Ticket tiers

An event's seats live on `ticket_types` (`lib/ticket-types.ts`), not on the event: each tier has its own name, price, capacity and **its own atomic reservation**, so General selling out never closes VIP, and two people racing for the last VIP seat still can't both win. The event row keeps the cheapest price and the total capacity as a summary for listings. Capacity is extended per tier and only upwards, twice at most. Events created before tiers existed get a single "General" tier carrying their original price and capacity, backfilled idempotently on boot.

## Holding a seat, and giving it back

A checkout holds its seat for **10 minutes**, shown to the buyer as a live countdown. The hold ends early when the buyer cancels or the payment is rejected before reaching the network (`POST /api/sales/[id]/release`) — without that, a wallet with no XLM for fees could leave an event looking sold out with nothing sold. A page whose remaining seats are only *held* says so instead of "agotado", since those come back in minutes.

## Check-in is two taps, not one

Scanning only **reads** the ticket (`POST /api/events/[id]/door/check`); the ticket is spent only when the person on the door confirms (`POST …/door`). A QR read from a pocket, or a scan of the wrong person's phone, costs nothing. On confirmation the buyer gets a "you're in" email in the language they bought in, and both parties see it under the bell in the header (`GET /api/notifications`: your event sold a ticket, your ticket was accepted).

## Identity, without a Bearer token

Pollar sessions are DPoP-bound — the signing key lives in the browser and never reaches this server, so a forwarded access token proves nothing here. Every write route instead requires a short-lived **SEP-53** signature of the live Pollar session (`x-pollar-proof`), verified purely cryptographically (`@stellar/stellar-base`, no call back to Pollar) — the same pattern already merged in `vendor-pay-link`. Ownership checks (editing an event, door mode, the sales view) return a real 403 for a different address.

## Security

A full review against the [OWASP Top 10:2025](https://owasp.org/Top10/2025/) lives in [docs/SEGURIDAD.md](docs/SEGURIDAD.md) — what's defended, what deliberately isn't, and where each control lives. The short version:

- **The signature is bound to the endpoint.** `x-pollar-proof` signs `POST /api/sales/:id/confirm`, not just "I am this address", and lasts 2 minutes. A proof captured from a harmless read can't be replayed against the route that rotates the staff door link.
- **Nothing the client says about money is trusted.** Price comes from the tier, the payment is verified on Horizon (destination, USDC issuer, amount in stroops, memo), and the memo is unique per sale so a payment can't be counted twice.
- **The browser runs only our scripts.** Nonce-based CSP with `strict-dynamic`, plus `frame-ancestors 'none'` — the door's "Aceptar ingreso" button is one invisible iframe away from being clicked by someone else's page.
- **Every route that costs us something has a ceiling** (`lib/rate-limit.ts`), sized to be invisible to a real user.
- **The buyer's email deletes itself** 30 days after the event, because by then it has done its only two jobs.

## Money and codes

- Amounts are integer **stroops** end to end (`lib/money.ts`), never floats.
- A ticket's QR `code` is CSPRNG, ~128.8 bits of entropy (rejection-sampled against its alphabet so there's no modulo bias), never derived from the sale, timestamp, or buyer. Its `door_code` is a short, hand-typeable fallback. Either one checks in through the same atomic `UPDATE ... WHERE (code = ? OR door_code = ?) AND event_id = ? AND used_at IS NULL` — a valid ticket scanned at the wrong event's door reads as unknown without being consumed.

## Testing and QA

Automated where it's cheap, by hand where it isn't. The spikes below run against the real remote database and real testnet; the manual pass is the one to repeat before a demo.

**Manual pass (two accounts, two phones — the same setup as the demo video):**

| # | Scenario | Expected |
|---|---|---|
| 1 | Brand-new account, no USDC, opens an event | "Te faltan USDC" with the faucet link, no dead button |
| 2 | Brand-new account whose wallet isn't on-chain yet | "Tu cuenta todavía no está activa" + link to the fees question; see the XLM note below |
| 3 | Buy 0.01 USDC, confirm | Ticket QR in seconds, email arrives with the QR **rendered** (not a broken image) |
| 4 | Buy, then cancel the payment / reject it in the wallet | Seat released immediately; the event doesn't read "agotado" |
| 5 | Start a checkout, don't pay | Countdown runs to 0, sale goes `expired`, seat back on sale |
| 6 | Close the tab mid-payment, reopen "Mis entradas" | "Ya pagué, verificar" finds the payment on Stellar and issues the ticket — never a second charge |
| 7 | Scan the ticket at the door | Review step first; the ticket is spent only after "Aceptar ingreso" |
| 8 | Scan the same ticket again | Red "Ya fue usada", with the time it came in |
| 9 | Scan a ticket from another event | "No válida", and the ticket stays unused for its own event |
| 10 | Staff door link on a second phone | Checks in, sees no sales and no account |
| 11 | Revoke the staff link, scan again | "Este link de puerta ya no es válido" |
| 12 | Switch language and theme | Whole app (including emails and link previews) follows; no flash on reload |

**Network fees (XLM), the one thing a tester hits first:** payments are USDC, but Stellar charges a fraction of a cent in **XLM** per transaction, paid by the buyer's own account. A brand-new Pollar wallet can be created in deferred funding mode, with no XLM yet — the app detects that (`wallet.existsOnStellar === false`) and says so instead of failing with a network error. For testing, `friendbot.stellar.org` funds an address on testnet for free. Sponsoring those fees from the app would need Pollar's own sponsorship path, not something this app can decide on its own.

## Tests

```bash
pnpm test     # node --test, no extra dependency
pnpm audit    # dependencies with a known CVE; fails on high or worse
```

Covers what has actually broken here: stroops arithmetic (never floats), the SQLite-timestamp and timezone bugs, tier validation and capacity limits, the sale state machine (holds, expiry, late payments, refunds, one live reservation per buyer), and that all three dictionaries define the same keys with their interpolations intact.

`tests/security.test.mts` covers the abuse cases instead: a proof replayed on a different endpoint or a different method, an expired one, one claiming a week of life, one forging someone else's address, a staff token used on the wrong event or after it ended, and a quota that lets the honest case through and stops the loop. They run the real modules directly — `lib/auth.ts` returns plain `Response`s precisely so no framework has to be booted around them.

`.npmrc` sets `minimum-release-age=1440`: never install a version published less than 24 hours ago. A compromised release is usually yanked within hours, so our installs are never the ones that run it.

## Reproducible spikes

Each runs against the real remote database / real testnet, not stubs:

```bash
pnpm db:probe          # transactions, rollback, RETURNING, UNIQUE, concurrency — 12/12
pnpm spike:capacity    # atomic seat reservation under concurrency — 12/12
pnpm spike:door        # atomic door check-in, both code kinds — 8/8
pnpm spike:horizon-verify  # payment verification against a real existing tx — 5/5
```

## Door staff, without sharing an account

The organizer can hand the entrance to someone else: the panel mints a 144-bit token (`POST /api/events/[id]/door-link`) and hands out `/puerta/[id]#t=<token>`. The token travels in the URL **fragment**, so it never reaches server logs or a `Referer`; it unlocks check-in for that one event and nothing else (no panel, no sales, no edits), and the organizer can replace or revoke it at any time. Server-side it's a constant-time comparison against the event's stored token.

## Refunding a late payment

A payment that lands after its reservation expired becomes `unclaimed`: no ticket, and the organizer is holding money that isn't theirs. From **Ventas** they send it back from their own Pollar wallet with the sale's refund memo; `POST /api/sales/[id]/refund` verifies that payment on Horizon (organizer → buyer, same amount, that memo) before moving the sale to `refunded`, and — like the purchase — it can be recovered by memo if the hash is lost, never paid twice.

## Known limitation

There's no automatic refund of a *paid* ticket (a cancelled event, a buyer who can't come): the organizer has to return it by hand. Only the late-payment case above is wired into the app.

## Stack

- Next.js 16 App Router, React 19, TypeScript 5, Tailwind 4 (template)
- `@pollar/core@0.11.2`, `@pollar/react@0.11.2`
- `@libsql/client` (Turso) for events/sales/tickets
- `@stellar/stellar-base` to verify SEP-53 session proofs server-side
- `qr-scanner` for camera check-in, `qrcode` to render the buyer's ticket QR
- Pollar auth, balance, session, payments: **not reimplemented**

## Acceptance (issue #13)

- [x] Organizer creates an event and shares a public link
- [x] Buyer logs in with Pollar and pays for a ticket in USDC on testnet, in-app
- [x] Payment is verified against Horizon before a ticket is ever issued
- [x] Ticket renders as a real scannable QR, plus a typed fallback code
- [x] Door check-in is atomic: a ticket can't be used twice, even under concurrent scans
- [x] Organizer sees their sales (revenue, status, per-sale detail)
- [x] Runs from a fresh clone with `pnpm install && pnpm dev` plus only the Pollar API key in `.env`
- [x] Deployed to Vercel — https://pollarpass.vercel.app
- [ ] Demo video with real Bolivian testers — shooting script ready in [docs/GUION-DEMO.md](docs/GUION-DEMO.md)
