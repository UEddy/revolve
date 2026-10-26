# Revolve app

The installable PWA: passkey-locked burner vault, search and buy over Jupiter's token data, ZIP-321 payment links for Zodl, order status, the swap from the burner after payout, a portfolio with staggered per-burner balance checks, and the privacy coach.

No accounts and no server-side user data. Everything about the user lives in one AES-GCM sealed blob in this browser's local storage, under a key derived from the passkey's WebAuthn PRF output.

## Run

```sh
npm ci
npm run dev        # http://localhost:5180, demo order service (no money moves)
npm test           # unit tests (memo, ZIP-321, vault crypto, tx signing, ATA, coach, stagger, relay)
VITE_ORDER_API=https://worker.example npm run build && npm run preview   # production build under the real CSP
```

Settings (`.env.example`):

| Variable | Where | What |
| --- | --- | --- |
| `VITE_ORDER_API` | build | Worker base URL (API_CONTRACT.md), or `mock`. Unset in a production build means "not configured". Its origin is added to the CSP's `connect-src`. |
| `SOLANA_RPC_URL` | relay | Upstream RPC. Defaults to the public mainnet endpoint. |
| `JUP_API_KEY` | relay | Optional. Uses `api.jup.ag` with the key, else the rate-limited `lite-api.jup.ag`. |

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
- `api/`: the relay (Vercel functions; the same code runs in `vite` and `vite preview`). Solana RPC, Jupiter and token icons go through it so those providers see the relay's address, not the phone's. No logging, no client headers forwarded, allowlisted methods and paths, one JSON-RPC call per request.

## Privacy notes

- Fonts are bundled; the page loads nothing from third parties. Token icons come through the relay.
- The relay and the worker see the phone's IP. Neither logs it, but the hosting platform's own request logs are outside the app's control; that is a trust boundary for the README.
- Swaps use Jupiter Ultra (`/ultra/v1/order` then `/execute`); a fixed reserve of 0.0025 SOL stays in each burner for fees and a later sale.
