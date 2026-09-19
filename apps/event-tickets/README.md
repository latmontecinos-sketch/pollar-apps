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
| `/` | anyone | Logged out: what Pollar Pass is + how buying works. Logged in: balance, "get test USDC", and the three main actions |
| `/como-funciona` | anyone, no login | In-app guide: buyer steps, organizer steps, FAQ (test USDC faucet, "I paid but got no ticket", refunds, privacy). Deep-linkable (`#usdc`, `#organizador`…) and reachable from the **Ayuda** button in every header |
| `/organizador/nuevo` | organizer | Create an event (name, place, date in Bolivia time, price, capacity) |
| `/e/[id]` | anyone, no login | Public event page — buy a ticket. Link previews (WhatsApp etc.) show the event's name, date and price |
| `/mis-pases` | buyer | "Mis entradas": every ticket with its QR; unconfirmed purchases get **"Ya pagué, verificar"** |
| `/mis-eventos` | organizer | Every event they organize, with sold count, linking to its panel |
| `/organizador/eventos/[id]` | owning organizer | Share the link (copy / WhatsApp / QR for posters), sold vs. in-progress vs. checked-in, edit event |
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

## Identity, without a Bearer token

Pollar sessions are DPoP-bound — the signing key lives in the browser and never reaches this server, so a forwarded access token proves nothing here. Every write route instead requires a short-lived **SEP-53** signature of the live Pollar session (`x-pollar-proof`), verified purely cryptographically (`@stellar/stellar-base`, no call back to Pollar) — the same pattern already merged in `vendor-pay-link`. Ownership checks (editing an event, door mode, the sales view) return a real 403 for a different address.

## Money and codes

- Amounts are integer **stroops** end to end (`lib/money.ts`), never floats.
- A ticket's QR `code` is CSPRNG, ~128.8 bits of entropy (rejection-sampled against its alphabet so there's no modulo bias), never derived from the sale, timestamp, or buyer. Its `door_code` is a short, hand-typeable fallback. Either one checks in through the same atomic `UPDATE ... WHERE (code = ? OR door_code = ?) AND event_id = ? AND used_at IS NULL` — a valid ticket scanned at the wrong event's door reads as unknown without being consumed.

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
