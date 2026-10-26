# Revolve app

The installable PWA: passkey-locked burner vault, search and buy over Jupiter's token data, ZIP-321 payment links for Zodl, order status, the swap from the burner after payout, a portfolio with staggered per-burner balance checks, and the privacy coach.

No accounts and no server-side user data. Everything about the user lives in one AES-GCM sealed blob in this browser's local storage, under a key derived from the passkey's WebAuthn PRF output.

## Run

```sh
npm ci
npm run dev        # http://localhost:5180, demo order service (no money moves), relay mounted at /api
npm test           # unit tests (memo, ZIP-321, vault crypto, tx signing, ATA, coach, stagger, build guard)
VITE_ORDER_API=https://api.example VITE_RELAY_URL=https://relay.example npm run build && npm run preview
```

The deploy is static files only (`dist/`, `vercel.json` sets the headers). The relay runs on the droplet (`../relay`).

Settings (`.env.example`):

| Variable | Where | What |
| --- | --- | --- |
| `VITE_ORDER_API` | build | Worker base URL (API_CONTRACT.md). Required, https. Under `npm run dev` it may be unset or `mock` for the demo order service. |
| `VITE_RELAY_URL` | build | Relay base URL. Required, https. |
| `SOLANA_RPC_URL`, `JUP_API_KEY` | dev only | Upstreams for the relay inside the dev server. In production they are the relay's own settings. |

`npm run build` fails on a missing setting, plain http, or `mock`: demo mode can never ship (`build-env.ts`). Even if a bundle were built some other way, `src/lib/config.ts` refuses mock outside dev, and the mock code is stripped from production bundles. Both origins are added to the page's CSP (`connect-src`, and `img-src` for the relay's icons). For a local check against loopback http services, build with `--mode localtest`.

## Spike B

`/spike-b.html`: run on the phone. Checks passkey PRF (two evaluations must match, then an HKDF to AES-GCM round trip) and opens a `zcash:` ZIP-321 link with amount and base64url memo in three variants (no padding, padding, `?address=`). `?ua=u1...&amount=0.005` prefills. "Copy report" gives a JSON summary.

## How the pieces fit

- `src/lib/passkey.ts`, `vault.ts`: passkey creation with PRF, HKDF-SHA256 to a non-extractable AES-256-GCM key, sealed vault. The vault is written before any burner is shown, and locks 3 minutes after the app goes to the background.
- `src/lib/burner.ts`, `tx.ts`, `transfer.ts`: ed25519 burners, signing Jupiter's serialized transactions in our signer slot, and minimal SOL/SPL transfers (both token programs), without a Solana SDK.
- `src/lib/memo.ts`: `rv1|<order_id>|<burner>` and `zcash:<ua>?amount=<zec>&memo=<base64url>`.
- `src/lib/orders.ts`: contract client (`GET /buckets`, `POST /orders`, `GET /orders/:id`) plus the demo mock.
- `src/state/engine.tsx`: jittered order polling, the swap as soon as the payout is on chain (idempotent: it checks the burner's balance first and never buys twice), retries, and the balance scheduler.
- `src/lib/stagger.ts`: every burner on its own random timer, with a random minimum gap between any two checks, so no two burners are ever queried together.
- `src/lib/coach.ts`: per-position linkability score with reasons, and warnings before risky moves (launch sniping, tiny holder counts, repeat buys, sending to another of your wallets or to an address another wallet already used, exporting a key).
- `../relay`: Solana RPC, Jupiter and token icons go through it so those providers see the relay's address, not the phone's. No logging, no client headers forwarded, allowlisted methods and paths, one JSON-RPC call per request.

## Privacy notes

- Fonts are bundled; the page loads nothing from third parties. Token icons come through the relay.
- The relay and the worker see the phone's IP. Neither logs it, and both sit behind a reverse proxy on our own droplet with access logs off. The static host (Vercel) only serves the app's files, so its logs show who opened the app, not what they did.
- Swaps use Jupiter Ultra (`/ultra/v1/order` then `/execute`); a fixed reserve of 0.0025 SOL stays in each burner for fees and a later sale.
