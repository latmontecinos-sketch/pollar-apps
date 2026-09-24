@AGENTS.md

# Pollar app

This codebase is ONE Pollar app, copied from the pollar-apps template into `apps/<slug>/`. The dev you're helping was assigned that slug and builds their app here, on top of an already-integrated Pollar SDK (payments for emerging markets: every end user has one account and one balance shared across all Pollar apps). Your job is the app, never the plumbing.

For anything SDK-related, the source of truth is https://docs.pollar.xyz/llms-full.txt and the installed types in `node_modules/@pollar/*`. Do not invent SDK methods.

## Architecture map

| Piece | Where | What it does |
|---|---|---|
| SDK init | `lib/pollar.tsx` | `PollarAppProvider`, mounted once in `app/layout.tsx`. Reads `NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY`. Keeps a single `PollarClient` on `globalThis`. The ONLY place Pollar is initialized. |
| Auth | `hooks/usePollarAuth.ts` | `{ user, isLoading, login, logout, verified }`. Sessions persist across reloads. `user.address` is the user's id across every Pollar app. |
| Balance | `hooks/useBalance.ts` | `{ balance, currency, asset, isLoading, error, refresh }` in the app's primary asset. Shared SDK state: one refresh updates every consumer. |
| Login UI | `components/LoginButton.tsx` | Logged out: login modal. Logged in: account button that opens `AccountModal` (email, wallet, log out). |
| Balance UI | `components/BalanceCard.tsx` | The wallet card; auto-refreshes after every payment (watches the SDK's global `tx` state). |
| Payments | `components/BuyButton.tsx` | The real checkout: reserve a seat, pay it with the sale's memo via `runTx('payment', …)`, then verify against Horizon with backoff. Remembers an in-flight purchase in `localStorage` so a reload only ever re-verifies, never re-pays. The template's `PayButton`/`SendModal` are gone — they could not carry a memo, which this flow needs. |
| Network & asset | `lib/network.ts` | The single source of truth for which Stellar network this is: issuer, Horizon URL, explorer links, and the `IS_MAINNET` gate for copy. Refuses to load if `HORIZON_URL` contradicts the publishable key. Nothing else may decide the network. |
| Receive | `components/ReceiveModal.tsx` | The receive view (address + QR), for a buyer topping up before a purchase. |
| UI kit | `components/ui/` | `Button`, `Card`, `Input`, `Modal`, `Spinner`, `EmptyState`, `PollarLogo`, `PollarBear`. Typed, token-styled. `Modal` is the single modal shell: bottom sheet on phones, centered on desktop. |
| Design tokens | `app/globals.css` | All colors as CSS variables (light by default, dark via `data-theme="dark"`), exposed as Tailwind utilities (`bg-primary`, `text-muted`, …). |
| Manifest | `pollar.manifest.json` | Identifies the app to the Pollar hub: name, slug, description, category, icon, deploy URL. Must be filled before the PR. |
| Demo | `app/page.tsx` | Working demo of all of the above. Replace it with the real app. |

## Hard rules

- **Never reinitialize the Pollar SDK.** No `new PollarClient(...)`, no second `<PollarProvider>`. Two live clients trip the server's refresh-token reuse detection and log the user out. Consume Pollar through `usePollarAuth()`, `useBalance()`, or `usePollar()` from `@pollar/react`; for advanced calls use `usePollar().getClient()`.
- **Never hardcode colors.** Every color comes from the tokens in `app/globals.css`, used via the UI kit or token utilities. New color, new token first.
- **Never commit `.env` or the API key.** The key lives only in `.env` (gitignored). `.env.example` carries placeholders, never real keys.
- **All user-facing payments go through `runTx('payment', …)`**, the way `components/BuyButton.tsx` does it. Don't reimplement payment logic, don't build custom signing or submission flows.
- **Working directory discipline.** Everything you build lives inside this app's folder. In the monorepo, never modify `template/`, other apps under `apps/`, or root files. The only exception is this app's own entry in the root `apps.json`. A PR touching anything else gets rejected.

## How to extend

- **Screens**: add routes under `app/` (this is Next.js 16 App Router; see the note at the top of this file).
- **Components**: add your own alongside the UI kit; compose the kit primitives.
- **Server logic**: Next.js route handlers (`app/api/*/route.ts`). The `POLLAR_SECRET_KEY` env var (backend-only) exists for privileged Pollar server calls if you need them.
- **Dependencies**: install freely inside this folder. The app has its own `package.json` and lockfile, no workspaces, no imports from other apps.
- **Smart contracts / external backends**: allowed, as long as payments still flow through Pollar.

## Rules this app learned the hard way

Each of these comes from a real defect found in an audit of this codebase,
not from a style guide. Breaking one has cost something here before.

1. **Money only through `lib/money.ts`.** No amount touches `Number()`,
   `parseFloat` or `toFixed` outside display formatting. Every amount that
   comes in needs a lower **and** an upper bound at the validation edge:
   stroops live in an INTEGER column and libSQL reads integers as JS
   numbers, so past 2^53 the read throws instead of rounding — and one
   poisoned row makes a whole event unreadable, with no way back from
   inside the app.

2. **A value read inside a long-lived callback** (a scanner, a
   `setInterval`, a subscription) **comes from a ref written on every
   render**, never from the closure. If a file already keeps an `xRef` for
   one captured value, every other captured value needs one too. When the
   guard has to hold within the same tick, write the ref synchronously —
   state is too late.

3. **Never SELECT-then-UPDATE a shared row.** The condition goes in the
   `WHERE`, inside `withTransaction`, and `RETURNING` is what tells you
   whether it applied. A check in JavaScript between two statements is not
   a check.

4. **Every endpoint that writes carries `enforce()`.** No exceptions
   without a comment saying why this one is different.

5. **Every user-facing string lives in `lib/i18n/`, error messages
   included.** The client prefers `t.xxx` over a string from the server;
   an API error in one language silently defeats three translated
   dictionaries.

6. **The network and the asset are decided in `lib/network.ts` and
   nowhere else.** No literal `"testnet"`, `"mainnet"`, issuer, Horizon or
   explorer URL anywhere else in the tree, and never derive the network in
   two places — they will disagree, and payments get verified against a
   chain they never happened on.

7. **Read paths don't write.** Sweeps, purges and migrations belong on a
   write path or a maintenance route, never in the render of a page a
   stranger can open.

8. **A new index is justified with `EXPLAIN QUERY PLAN`, before and
   after.** Any new column in a `WHERE` or `ORDER BY` over `sales`,
   `events` or `tickets` needs one, and you show the plan using it.

9. **Replacing a template file includes deleting it, in the same commit.**
   An orphaned template component keeps patterns the rest of the app has
   already abandoned, and someone will copy from it.

10. **A dependency pulled in for one function needs a written reason.**
    Check `node:` builtins first.

11. **A component only needed after an action is imported dynamically.**
    Nobody downloads the QR encoder while still deciding whether to buy.

12. **A function that answers "was this paid?" or "is this valid?" does
    not merge without a unit test** with its I/O mocked. A manual spike is
    not coverage.

13. **Types are checked with `pnpm typecheck`, never a bare `tsc`.** Page
    props use `PageProps`, which Next generates into `.next/types`; a bare
    `tsc` passes only on a machine that happens to have an old build, and
    fails on a fresh clone. The same goes for any check: "it passed" means
    it passed from a clean tree, the way CI runs it.

14. **A best-effort side effect never gets reported as done.** When a send,
    a notification or a sync may fail silently, the user hears about it
    only from the result of the attempt (like `emailed` from the confirm
    route), and the log keeps the provider's reason, not just a status.

## Definition of done (bounty)

1. App deployed (production URL live, e.g. Vercel).
2. `pollar.manifest.json` completely filled, including the deploy `url`.
3. Runs from a fresh clone with `pnpm install && pnpm dev` and ONLY the API key in `.env`.
4. Uses Pollar login and real payments (not mocked).
