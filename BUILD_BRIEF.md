# Revolve: build brief

Deadline: Oct 28, 2026, 23:59 UTC (Thursday 00:59 Lagos). Track: Cross-Chain.
Binding rules: all code written in the build window (libraries fine, existing products not), repo public by Oct 28, one submission, working demo URL + 2 minute video. Judging: privacy (any leak disqualifies), usefulness, execution (working beats ambitious), originality.

## Protocol note (verified Oct 26)

Ironwood (NU6.3, mainnet block 3,428,143, July 2026) replaced Orchard as Zcash's active shielded pool. Orchard is closed to new deposits; funds only leave it through the turnstile. Ironwood reuses the Orchard receiver in unified addresses, so wherever this brief says "Orchard address" or "Orchard note", read: a UA with the Orchard receiver only, whose payments now land in Ironwood. Pin librustzcash crate versions that sync the Ironwood tree (zcash-devtool main already does).

## The product in one line

Buy any token, stock or NFT with shielded ZEC, from one app, without ever seeing a chain, connecting a wallet, or being linkable to what you bought.

## User

A known CT trader whose wallets are tracked and copytraded. Today they burn fresh wallets but fund them from a KYC exchange or a known wallet, which re-links them.

## What the user experiences

1. Opens Revolve (installable PWA on their phone). Creates a passkey. No email, no password, no account.
2. Searches "BONK" or "TSLA". Taps Buy, picks an amount bucket.
3. Taps "Pay with Zodl". Zodl opens with amount and encrypted memo prefilled. One confirm.
4. Returns to Revolve. A few blocks later the asset is in their portfolio.
5. Portfolio shows everything as one wallet. Under the hood every position is a separate, unlinked burner whose key lives only in their passkey-locked vault on the phone.

No chain names, no gas, no seed phrase, no wallet connection.

## Why it is needed (proven on mainnet, Oct 26)

Every current route out of Zcash deshields at the deposit. Our test through Zodl CrossPay / NEAR Intents:
- Zcash tx 19d07f8f507039a1b922113c6cc28bfa8414478b198f96d30425d3541da6fe01, explorer type "Deshielding (Z-T)"
- 0 shielded outputs, 1 public output: 0.00251649 ZEC to single-use t1dCCf1RHzVnkB6KE8d1bzAQypGNktu8zwh, block 3531462, 16:33:38 UTC
MAYAChain also sends the value to a transparent vault. Revolve's deposit never leaves the shielded pool.
Demo centerpiece: that explorer page side by side with ours.

## Architecture

```
[Zodl] --shielded Orchard note, encrypted memo--> [Revolve solver Orchard address]
                                                        |
                                    watcher: viewing key only, no spend key on server
                                                        |
                              payout worker: SOL from capped inventory, after random 2-6 block delay
                                                        v
                         [fresh burner, key in passkey vault on the phone]
                                                        |
                              app signs Jupiter swap silently: token / xStock
```

### Components

1. **App** (PWA, static host, free tier). Visual design borrowed from NivPay (colors, type, layout) but every component rewritten fresh in this repo. Do NOT copy NivPay code (rule 02, and NivPay was entered elsewhere).
   - Passkey via WebAuthn; PRF extension derives the key that encrypts the burner vault in local storage. Nothing about the user ever reaches our server.
   - Search + Buy screens over Jupiter's API (tokens and xStocks). Chain names never shown.
   - Order: amount bucket, new burner pubkey, ZIP-321 `zcash:` link (solver UA, amount, memo = order id + burner pubkey + quote id, padded to fixed length).
   - Status by order id only.
   - On payout: decrypt burner key with passkey, sign Jupiter swap, done.
   - Portfolio: balances fetched per burner on staggered random timers, never in one batch, through a proxy, so the RPC cannot link burners by IP and timing.
   - Privacy coach: linkability meter per position, warnings at the moment of risk (sending to a known wallet, consolidating burners, buying within seconds of a launch, unique amounts).
2. **Watcher** (Rust, zcash_client_backend + zcash_client_sqlite, lightwalletd eu.zec.rocks:443). View-only account (incoming viewing key preferred, UFVK fallback). Emits txid, value, memo, confirmations.
3. **Payout worker + order API** (Node/TS, @solana/web3.js). `POST /orders`, `GET /orders/:id`. Validates memo against open order and value against quoted bucket, waits for confirmations plus random 2 to 6 block delay, pays SOL (enough for the swap plus fees) to the burner. Deletes the order to burner mapping after payout. No IP logging.
4. **Refunds**: manual, signed offline. Solver seed never on the server.

### Hosting
- Watcher + worker on the DigitalOcean droplet (Frankfurt, 512MB). Build Rust in WSL, copy the binary up. Never compile Rust on the droplet.
- App on a free static host.

## Scope tiers

- Tier 1 (must ship): the whole Solana catalog through one integration. Any SPL token Jupiter can route (all memecoins with liquidity, not a curated list) plus tokenized stocks on Solana. Search, trending and new launches pulled from Jupiter's token data. End to end on mainnet.
- Tier 2 (start only when Tier 1 works end to end, target Wed 06:00 UTC): Polymarket. Browsing every market is cheap (public market data API) and ships with Tier 1. Placing bets needs USDC on Polygon to an EVM burner, Polymarket's proxy wallet setup and signed CLOB orders: 8 to 10 hours, and region restrictions must be checked first.
- Gated stretch: in-app non-custodial shielded wallet (fund once, buy without Zodl confirms). Start ONLY when everything else is shipped (deployed, README, repo public-ready) and the Remotion video is the only task left. Before writing code, a 30 minute check: does an in-browser Zcash library (e.g. WebZjs) support Ironwood sends and proving on Android Chrome? If not, it stays on the roadmap.
- Tier 3 (roadmap slide): stocks on other chains (e.g. Robinhood Chain) and EVM NFTs, each needs a new payout chain plus its own DEX or marketplace integration; Solana NFTs; in-app shielded wallet; exit path back to shielded ZEC.

## Trust boundaries (README, stated upfront)

- Solver is custodial between deposit and payout (minutes) and knows order to burner until payout.
- Solana payout is public and comes from the solver wallet: it links a burner to "a Revolve user", not to a person.
- Behavioral fingerprints can still link burners; the coach warns but cannot prevent.
- Liquidity is our inventory; refunds are manual.

## Work split

- Account A: `solver/` (Rust watcher), then `worker/` (payout + order API).
- Account B: `app/` (PWA, passkey vault, search/buy, ZIP-321 link, status, Jupiter swap, portfolio, coach), then README + video script.
- Agree on the order API shape first.

## Order of work

1. Spike A (now, about 2 hours): solver wallet on mainnet, send ZEC with memo from Zodl, confirm value + memo are readable. Then confirm view-only import works. Stop and reassess if it fails.
2. Spike B (parallel): Zodl opens a `zcash:` link from a phone browser with amount and memo filled; WebAuthn PRF works on Eddy's Android Chrome.
3. Worker + order API.
4. App end to end on mainnet with real ZEC.
5. Jupiter buy from burner.
6. Portfolio + coach.
7. Deploy, README, demo video (NEAR deshield vs Revolve), secret scan over git history, make repo public, submit.

## Security rules

- No seeds, spending keys or Solana hot wallet keys in the repo, logs or chat. `.env` and key files in `.gitignore` from the first commit.
- Secret scan over full git history before going public.
- Server holds a viewing key and a capped hot wallet only.
- Commit early and often; rule 02 is judged by history.
