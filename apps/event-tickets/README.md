# Pollar Pass (`event-tickets`)

Ticket pre-sale and door check-in for small events in Bolivia (issue [#13](https://github.com/pollar-xyz/pollar-apps/issues/13)).

The organizer creates an event and gets a public link. A buyer opens that link, logs in with Pollar, and pays for a ticket in **USDC on Stellar testnet**, in-app — no external wallet, no QR to scan to buy. The ticket that comes back *is* a QR: the buyer shows it at the door, the organizer scans it (or types the short code by hand) to check them in, once, atomically.

## Run from a fresh clone

```bash
cd apps/event-tickets
cp .env.example .env
pnpm install
pnpm dev
```

Required in `.env`: `NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY` (dashboard.pollar.xyz → Build → API Keys → publishable). Everything else is optional:

- **Local dev**: no database setup needed — falls back to `file:./dev.db`.
- **Production**: `DATABASE_URL` + `DATABASE_AUTH_TOKEN` (libSQL/Turso) are required; the app refuses to start on the local file DB in production rather than silently losing writes on a serverless filesystem.
- **`RESEND_API_KEY`**: optional, best-effort email of the ticket after purchase (see below).

## Screens

| Path | Who | What |
|---|---|---|
| `/organizador/nuevo` | organizer | Create an event (name, place, date, price, capacity) |
| `/e/[id]` | anyone, no login | Public event page — buy a ticket |
| `/mis-pases` | buyer | Every ticket they've ever bought, with its QR |
| `/organizador/eventos/[id]` | owning organizer | Edit event, links to door mode and sales |
| `/organizador/eventos/[id]/puerta` | owning organizer | Door check-in: camera scan or typed short code |
| `/organizador/eventos/[id]/ventas` | owning organizer | Revenue, status counts, per-sale detail |

## How payment correlation works (no client webhooks)

There's no merchant "charge" API in Pollar — an in-app purchase is a user-to-user Stellar payment (`runTx('payment', …)`). Buying a ticket:

1. `POST /api/sales` reserves a seat (atomic `UPDATE ... WHERE reserved < capacity`) and creates a `pending` sale with a unique `reference`.
2. The buyer pays the organizer's address with that reference in the memo — `PayButton` doesn't expose a memo, so this calls `runTx('payment', …)` directly, the same SDK method `SendModal` uses.
3. `POST /api/sales/[id]/confirm` takes the resulting hash and verifies it against **Horizon** (destination, amount, asset, memo) before ever trusting it. Marking the sale `paid` and issuing the ticket happen in one DB transaction. A hash that doesn't match, or a Horizon outage, never gets treated as "payment failed" — the sale just stays `pending` and the buyer can retry.
4. A sale that expires before payment lands releases its seat (`sweep`, run opportunistically from the organizer panel). A payment that arrives *after* expiry moves the sale to `unclaimed` instead of overselling a seat that may have been resold.

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

## Known limitation

Door validation trusts the *organizer's own session* — there's no delegation to third-party door staff. For a small event this is usually one phone anyway; multi-staff delegation would need its own access model and is out of scope here.

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
- [ ] Deployed to Vercel
- [ ] Demo video with real Bolivian testers
