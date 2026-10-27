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

Vercel: link the project from `app/` itself (build command `npm run build`, output `dist`), so the build guard below runs on every deploy. Never link or deploy `public/` or `dist/` directly. As a second guard, every build strips dotfiles and dot-directories from `dist/` (`build-dist.ts`; `.well-known` is kept), so tool metadata such as a `.vercel` link is never served.

Settings (`.env.example`):

| Variable | Where | What |
| --- | --- | --- |
| `VITE_ORDER_API` | build | Worker base URL (API_CONTRACT.md). Required, https. Under `npm run dev` it may be unset or `mock` for the demo order service. |
| `VITE_RELAY_URL` | build | Relay base URL. Required, https. |
| `SOLANA_RPC_URL`, `JUP_API_KEY`, `OPENSEA_API_KEY` | dev only | Upstreams for the relay inside the dev server. In production they are the relay's own settings. |

`npm run build` fails on a missing setting, plain http, or `mock`: demo mode can never ship (`build-env.ts`). Even if a bundle were built some other way, `src/lib/config.ts` refuses mock outside dev, and the mock code is stripped from production bundles. Both origins are added to the page's CSP (`connect-src`, and `img-src` for the relay's icons). For a local check against loopback http services, build with `--mode localtest`.

## Spike B

`/spike-b.html`: run on the phone. Checks passkey PRF (two evaluations must match, then an HKDF to AES-GCM round trip) and opens a `zcash:` ZIP-321 link with amount and base64url memo in three variants (no padding, padding, `?address=`). `?ua=u1...&amount=0.005` prefills. "Copy report" gives a JSON summary.

## How the pieces fit

- `src/lib/passkey.ts`, `vault.ts`: passkey creation with PRF, HKDF-SHA256 to a non-extractable AES-256-GCM key, sealed vault. The vault is written before any burner is shown, and locks 3 minutes after the app goes to the background.
- `src/lib/burner.ts`, `tx.ts`, `transfer.ts`: ed25519 burners, signing Jupiter's serialized transactions in our signer slot, and minimal SOL/SPL transfers (both token programs), without a Solana SDK.
- `src/lib/memo.ts`: `rv1|<order_id>|<burner>` and `zcash:<ua>?amount=<zec>&memo=<base64url>`.
- `src/lib/orders.ts`, `amount.ts`: contract client (`GET /limits`, `POST /orders` with `amount_zec`, `GET /orders/:id`) plus the demo mock. The buy sheet takes a free amount in USD or ZEC, converts with the indicative rate from `/limits`, rounds to the 0.001 ZEC step (integer zatoshi maths) and always shows the final ZEC amount before paying; min, max and "temporarily unavailable" (max below min) come from `/limits`. A 503 from `/limits` means the worker is still loading its price and balance: the sheet shows "Getting the latest rates", holds Continue and asks again every 3 to 5 seconds while open.
- `src/state/engine.tsx`: jittered order polling, the swap as soon as the payout is on chain (idempotent: it checks the burner's balance first and never buys twice), retries, and the balance scheduler.
- `src/lib/stagger.ts`: every burner on its own random timer, with a random minimum gap between any two checks, so no two burners are ever queried together.
- `src/components/DiscoverSection.tsx`, `src/lib/discover.ts`: the Discover tab's top section (the compass in the bottom bar), above search and the token lists; Portfolio has no carousel. Category chips (Trending memes, New, Stocks, Prediction markets, Popular collections) over one compact carousel, about a third of the screen high: three cards with the next one peeking, scroll-snap per card, page dots, arrow buttons on mouse devices, and a one-time swipe hint (skipped under reduced motion). Tokens and stocks come from Jupiter as before; prediction markets and NFT collections from the relay's read-only feeds (`../relay`: `/feeds/markets` from Polymarket; `/feeds/nfts` from Magic Eden for Solana, `/feeds/nfts/ethereum` and `/feeds/nfts/robinhood` from OpenSea). The NFT category interleaves the three chains, and each card carries a small chain label. Market and NFT cards open read-only views (`src/screens/Collectibles.tsx`) labelled "Buying coming soon", with no buy button. NFT floors are shown in USD (SOL and ETH via Jupiter's SOL and Wormhole ETH prices; stablecoin floors as is). "Popular collections" is a fixed list of 8 well-known collections per chain, not the whole market; a chain whose feed fails is left out.
- `src/components/InstallBanner.tsx`, `src/lib/install.ts`: "Install Revolve for one-tap access". On Chrome the `beforeinstallprompt` event is caught at startup (mini-infobar suppressed) and our Install button calls `prompt()`; it hides on `appinstalled`. On iOS, where there is no such event, the banner says to tap Share, then "Add to Home Screen". Never shown when running installed (`display-mode: standalone` or `navigator.standalone`). "Not now" hides it for 7 days (localStorage, wrapped; if storage fails it simply shows again next visit). On welcome and unlock it sits in the page flow, in the gap between the wordmark and the title, so it can never cover Create or Unlock; the first-run explainer (no account, shielded payment, fresh wallet per buy) lives in a "How it works" sheet under Restore, so first run keeps the unlock layout; on the tab screens it floats above the tab bar; it is never rendered on payment, funding or buy screens and is hidden while a sheet is open. Installability: the manifest has name, `id`, 192 and 512 icons (plus maskable), `start_url`, `display: standalone`, and `sw.js` has a fetch handler; there are no `screenshots` in the manifest, which Chrome only uses for the richer install dialog.
- `src/lib/coach.ts`: per-position linkability score with reasons, and warnings before risky moves (launch sniping, tiny holder counts, repeat buys, sending to another of your wallets or to an address another wallet already used, exporting a key).
- `../relay`: Solana RPC, Jupiter and token icons go through it so those providers see the relay's address, not the phone's. No logging, no client headers forwarded, allowlisted methods and paths, one JSON-RPC call per request.

## Credits (CREDITS_CONTRACT.md v1.3)

Fund once with shielded ZEC, then buy with a passkey tap. 1 credit = 0.001 ZEC.

- Blind signatures: RFC 9474 RSABSSA-SHA384-PSS-Randomized via `@cloudflare/blindrsa-ts` 0.4.6 (pinned; Cloudflare-maintained, npm provenance, Apache-2.0, one dependency `sjcl`). The app never does blinding maths itself (`src/lib/credits.ts`).
- Interop details for the mint (worker): a token's `msg` is the *prepared* message from `suite.prepare()`: a 32-byte random prefix plus the 32 random bytes generated on the device, 64 bytes in total. The signature verifies only over those 64 bytes, so the server verifies, and records SHA-256 of, exactly the `msg` it receives. The app imports the SPKI key as `RSA-PSS`/`SHA-384`, extractable (the library reads the modulus).
- Key pinning: the first `GET /mint/key` is pinned in the vault. A different `key_id` or key shows both fingerprints and needs an explicit "Trust the new key" before minting.
- Minting (`src/state/credits.tsx`): the prepared messages and blinding inverses are sealed in the vault before the blinded messages go to `/sign`; every returned signature is unblinded and verified against the pinned key; nothing is stored unless all of them verify. A lost answer or a hiccup (503 `mint_unavailable`, network, 5xx) is retried with the same sealed set, which the mint signs again with the same signatures. `409 already_minted` (a different set was signed: another copy of this vault) or `400 invalid_blinded` puts the funding in review; `409 not_funded` or 404 makes the app re-read the funding status and take the server's word.
- Spending: a fresh WebAuthn assertion with `userVerification: "required"` on the vault's own passkey (the app also checks the user-verified flag in `authenticatorData`) before any token leaves the vault. Tokens are marked pending in the same sealed write that creates the position and its burner. `409 amount_unavailable`, `503 busy`, `503 no_price`, `400 invalid_amount` and `400 invalid_burner` return them (the worker answers the first three only after finding none of the tokens spent, and the last two refuse the request itself, so even an earlier unanswered try with the same body consumed nothing); `token_spent`/`invalid_tokens` drops them for good; no answer, an unknown error or `503 mint_unavailable` means retry with the very same tokens, amount and burner, also after a reload: the mint answers an exact resend with the same order. That resend match lasts only until the order is paid out (the worker then forgets the order), so a `token_spent` after an unanswered try still keeps the position and lets the balance checks pick up the payout.
- Credits, pending spends and blinding state are part of the sealed vault, so they are in the encrypted backup.
- Coach: warns when a spend comes within an hour of a funding, and when it uses the whole balance (more strongly when that equals the funded amount).
- `src/screens/CashOut.tsx`, `src/lib/cashout.ts`: "Cash out to Zcash" on a holding (next to Sell) or a sold position. It sells to SOL in the position's wallet if needed, then hands off to Zodl's own Swap: the user opens Zodl, picks SOL on Solana as the source, and pastes Zodl's deposit address and exact amount here. The form prefills the whole balance minus the 0.000005 SOL network fee and is editable; it blocks non-Solana addresses, this wallet's own address, amounts under Zodl's ~0.017 SOL minimum, more than the balance allows, and amounts that would leave a non-zero balance below rent exemption (Solana rejects those). Then a summary (amount, destination, what stays in the wallet), a fresh verified passkey check, and a send from the position's wallet; the signature is shown. A half-filled form is kept in the vault when the app goes to the background, so switching to Zodl, or a lock meanwhile, loses nothing. A transfer that isn't confirmed in time is still recorded with its signature, so it can't be sent twice. Revolve makes no call to the swap provider (NEAR Intents behind Zodl): no API, no key, nothing through the relay.

## Privacy notes

- Fonts are bundled; the page loads nothing from third parties. Token icons come through the relay.
- The relay and the worker see the phone's IP. Neither logs it, and both sit behind a reverse proxy on our own droplet with access logs off. The static host (Vercel) only serves the app's files, so its logs show who opened the app, not what they did.
- Cash out: the swap provider behind Zodl publishes each swap on its own chain (the deposit from this wallet, the amount, the time); the ZEC lands shielded in the user's Zodl. The coach warns when cashing out within an hour of buying and when one cash-out moves a whole large position (over $250, or 2 SOL without a price), since timing and amount can pair the two ends, and on reusing an old deposit address or sending to another own wallet.
- Swaps use Jupiter Ultra (`/ultra/v1/order` then `/execute`); a fixed reserve of 0.0025 SOL stays in each burner for fees and a later sale.
