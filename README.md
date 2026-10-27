# Revolve

**Buy anything across crypto with shielded ZEC, from one phone app, without leaving a trail back to your Zcash.**

Live app: **https://revolveapp-phi.vercel.app** (order API: `https://revolveapp.duckdns.org`)

You pay from your shielded Zcash wallet (Zodl), and the asset lands in a brand-new wallet on the destination chain that holds that one position and nothing else. There are no accounts, no wallet connection, no gas to manage and no seed phrase: a passkey on your phone opens an encrypted vault that holds every position's key. Nothing on the Zcash side becomes public, and nothing on the destination side points back to you or to your other positions.

## The problem, proven on mainnet

Every route out of Zcash today deshields. To check, we swapped ZEC through NEAR Intents from Zodl. The resulting Zcash transaction is labelled **"Deshielding (Z-T)"** by the explorer: it has no transparent inputs and one public transparent output of **0.00251649 ZEC** to `t1dCCf1RHzVnkB6KE8d1bzAQypGNktu8zwh`.

- Tx [`19d07f8f507039a1b922113c6cc28bfa8414478b198f96d30425d3541da6fe01`](https://mainnet.zcashexplorer.app/transactions/19d07f8f507039a1b922113c6cc28bfa8414478b198f96d30425d3541da6fe01), block 3,531,462

The amount and the time are now public on Zcash, and they can be matched to the swap on the other side. MAYAChain is no different on the value side: ZEC is paid into its vault's transparent inbound address (newer flows carry only the memo in a shielded note; see the [SwapKit Zcash guide](https://docs.swapkit.dev/spotlights/chain-specific-guides/zcash-shielded-and-unified-addresses)).

## What Revolve does

From one app on your phone you can:

- **Buy any Solana token or tokenized stock with liquidity** (via Jupiter), paid in shielded ZEC. Live.
- **Browse** prediction markets (Polymarket) and NFT collections on Solana, Ethereum and Robinhood Chain. Live, read only: these cards say "Buying coming soon".
- **Sell** a position to SOL inside its own wallet, **send** it out, or **cash out to Zcash** by handing the SOL to Zodl's built-in Swap (deployed; its first mainnet run is still to come).

No bridge UI, no chain selection, no wallet connection, no gas: each position's wallet gets a small SOL reserve with the payout, and the app signs everything on the device.

## How it works

```
 Zodl (your shielded ZEC)
   │  shielded payment to an Orchard-only unified address,
   │  encrypted memo: rv1|<order id>|<fresh wallet>
   ▼
 Zcash ──────────────► watcher (view-only key, lightwalletd over Tor)
                          │ one line per received note
                          ▼
                       worker (order API)
                          │ 3 confirmations + random 2-6 blocks,
                          │ then SOL from a capped hot wallet
                          ▼
 Solana: fresh wallet for this one position ◄── your phone buys the token
                                                (Jupiter, via the no-log relay)
```

1. **Deposit.** The app creates a fresh Solana wallet on the phone, asks the order API for a quote, and opens Zodl with a payment request. The payment goes to an **Orchard-only unified address**; since NU6.3, notes to it land in the **Ironwood** pool. The **memo is encrypted** on chain: it carries the order id and the fresh wallet's public key, nothing about you.
2. **Watch.** The watcher (`solver/`) is a view-only wallet: it holds only the Orchard part of the viewing key, never a spending key, and syncs over **Tor**.
3. **Pay out.** After 3 confirmations plus a **random 2 to 6 block delay**, the worker pays SOL to the fresh wallet. Then it deletes the order row, and with it the order-to-wallet link.
4. **Buy on the device.** The phone swaps the SOL for the token you chose, signing with that wallet's key, which never leaves the phone's vault.

### Credits: fund once, then buy with a passkey tap

Instead of one Zodl payment per buy, you can fund Revolve once (0.002 to 0.05 ZEC, memo `rv1f|<funding id>`, no wallet in it) and receive **blind-signed credit tokens** (Chaumian e-cash, **RFC 9474** RSABSSA-SHA384-PSS-Randomized, 1 credit = 0.001 ZEC). The phone blinds random token messages, the server signs them blind, and the phone unblinds and keeps them in its vault. A buy then spends tokens after a **fresh passkey check** (user verification required), and pays out after a random 60 to 300 second delay. Because of the blinding, the server cannot tell which deposit minted a spent token, and buys can't be linked to each other by their tokens. The server keeps only hashes of spent tokens, to stop double spends.

## Why it does not leak

- **Nothing public on Zcash.** Fully shielded payment to an Orchard-only address: no public amount, no public sender, encrypted memo.
- **The server can't move your ZEC.** It holds only a view-only key for the deposit address. The ZEC spending key is not on the server.
- **The server isn't told what you buy.** An order carries an amount and a fresh wallet, never a token; the buy happens on the phone.
- **A fresh wallet per position.** Every buy lands in its own new wallet, funded by the shared payout wallet like every other Revolve user's.
- **Keys sealed by your passkey.** The vault is AES-GCM encrypted with a key derived from the passkey (WebAuthn PRF). No password, no seed phrase, no copy on any server.
- **No accounts, no IP logs.** Orders hold no IP, user agent or creation time. The relay and worker don't log requests, and the reverse proxy has access logs off.
- **Mappings deleted after payout.** Once an order is paid, its row is deleted; only a hash of the note remains, so a re-emitted note isn't paid twice.
- **Staggered balance checks.** The phone checks one wallet at a time, with gaps between them, so the RPC never sees all your wallets at once.
- **A 0.001 ZEC grid.** Amounts are multiples of 0.001 ZEC, so there are many identical payments to hide among.
- **A privacy coach.** Each position shows a linkability score with its reasons, and risky moves get a warning first: launch sniping, tiny holder counts, repeat buys, sending to another of your wallets or to a reused address, spending credits right after funding, cashing out right after buying or all at once.

**Leaks we found and closed while building:**

- **Transparent-address polling.** A full viewing key makes a light wallet ask the lightwalletd server about transparent addresses, which reveals them. The watcher strips the key down to Orchard only, so it never tracks transparent or Sapling receivers.
- **Request logs at the relay.** The relay started as serverless functions next to the app on Vercel, where the host's request logs would see client IPs. It now runs on our own server with logging off.
- **Demo mode in production.** A production build fails if it points at the demo order service or at plain http, and the demo code is stripped from production bundles.

## Trust boundaries

Stated plainly, so nobody has to dig for them:

- **Custodial between deposit and payout.** From the moment your ZEC arrives until the SOL is paid out, Revolve holds the value.
- **Credits are custodial until spent.** That's capped at 0.05 ZEC per funding. Losing your phone without a vault backup loses them.
- **Payouts are public on the destination chain.** Anyone can see the hot wallet pay a fresh wallet and that wallet buy a token. What they can't see is who paid for it.
- **The relay sees IPs and logs nothing.** It also sees, in transit, which token a fresh wallet swaps into. The order API sees IPs too, and logs nothing. You trust that we run them as published.
- **Behaviour can still link you.** Timing and amounts are fingerprints: a buy seconds after a funding, the same unusual amount twice, cashing out a whole position right after buying. The coach warns; it can't prevent.
- **The mint key is a hot key.** If it leaked, an attacker could forge credits and claim payouts. The loss is bounded by what sits in the capped hot wallet.
- **Refunds are manual.** A payment that doesn't match an open order exactly is held for review and refunded by hand: a wrong amount, a malformed or unknown memo, a payment after the quote expired, or a second payment to the same order.

## Proven on mainnet

| Step | Transaction |
|---|---|
| Shielded deposit: 0.005 ZEC to the Orchard-only address, landed in Ironwood, block 3,531,565 | [`bef498e89249127a1fb93457305b3b447bb11e831f340fda42ff25c6da1d63fd`](https://mainnet.zcashexplorer.app/transactions/bef498e89249127a1fb93457305b3b447bb11e831f340fda42ff25c6da1d63fd) |
| Payout: 0.065380967 SOL from the hot wallet to a fresh wallet | [`4uTmgrG2…QtTGd8m2`](https://solscan.io/tx/4uTmgrG2wcg66VkmFFfEzk8nD8KazRaiGQ2maQFwSLVbb1WMaSRg7JUCXfzdGBakZijhsEqxiZDesZx6QtTGd8m2) |
| Buy on the device: that wallet bought 330,983 BONK, 4 minutes later | [`KPoQSXNf…Rq3pPe`](https://solscan.io/tx/KPoQSXNf4NFaJL6tbYUCsjx9pxCbU5bBq8YTRt9SuCEZtQhKBGCEwxBJEDH35vSWZamMp9VgwDGTdnHUwRq3pPe) |
| Wrong-memo payment: 0.0005 ZEC with a malformed memo, held for review, not paid out | [`b3bf882c70d4d2f67f8e4e5554e5056aaad9eba9c3c3944befbf0d53a575c2e3`](https://mainnet.zcashexplorer.app/transactions/b3bf882c70d4d2f67f8e4e5554e5056aaad9eba9c3c3944befbf0d53a575c2e3) |
| **TODO (Eddy): credits run, fund → mint → spend → payout** | **TODO: txids and signatures** |

Both Zcash transactions show as fully shielded on the explorer (Orchard actions, no transparent inputs or outputs). The worker's database holds no record of the paid order any more, only a hash of the deposit note, which matches this deposit.

## How Revolve differs from bridges like ZCross

Bridges such as [ZCross](https://github.com/Blackwrld04/ZCross) route a swap of shielded ZEC through NEAR solvers into another chain's asset. Revolve is a consumer app: you pick the token or stock itself, and it arrives in a wallet of its own. Every position gets its own fresh, unlinked wallet. And with credits, even the order server can't link your buys to your deposit or to each other.

## Architecture and repo map

| Folder | What it is |
|---|---|
| [`solver/`](solver/src/main.rs) | Rust watcher: a view-only Orchard/Ironwood wallet over lightwalletd and Tor (librustzcash). It prints one JSON line per received note, and the `address` and `ufvk` commands print the Orchard-only deposit address and viewing key. |
| [`worker/`](worker/deploy/DEPLOY.md) | Node order API and payout worker: quotes, memo matching, review queue, delayed SOL payouts from the capped hot wallet, the credits mint. It starts the watcher as a child process. Admin tool: `worker/src/admin.ts`. |
| [`relay/`](relay/README.md) | No-log privacy relay: Solana RPC, Jupiter, token icons and the read-only Discover feeds (Polymarket, Magic Eden, OpenSea), with no client headers forwarded and allowlisted calls only. |
| [`app/`](app/README.md) | The phone app (PWA): passkey vault, buying, credits, the privacy coach, sell, send and cash out. |

Contracts between the parts: [`API_CONTRACT.md`](API_CONTRACT.md) (order API) and [`CREDITS_CONTRACT.md`](CREDITS_CONTRACT.md) (credits and mint).

## Run it yourself

- Server side (watcher, worker, relay on one droplet, step by step): [`worker/deploy/DEPLOY.md`](worker/deploy/DEPLOY.md)
- The app (dev server with a demo order service, tests, build settings): [`app/README.md`](app/README.md)

## Roadmap

Revolve’s core stays the same for everything below: you pay in shielded ZEC, every position lives in its own fresh wallet, and our server never holds a spending key or learns what you hold.

- Buying prediction markets and NFTs across chains. Browsing is already built (read only) for Polymarket and for Solana, Ethereum and Robinhood Chain collections.
- Perpetuals and derivatives. Open a leveraged position from shielded ZEC, each margin account in its own fresh wallet, so your trading history can’t be stitched together or copytraded.
- Staking and restaking. Earn yield on SOL, ETH and liquid staking tokens without the stake being traceable back to your Zcash holdings.
- Lending and borrowing. Supply assets or borrow against them from a fresh wallet, with collateral that can’t be linked to your other positions.
- More chains as payout routes. EVM chains first, each a new route behind the same deposit, not a new user flow.
- Fully non-custodial in-app wallet, once a browser Zcash library supports Ironwood (none does yet; we checked).

Long-lived positions like staking, lending and perps are easier to watch over time than one-off buys, so the privacy coach will extend to them: warnings on reusing a wallet across positions, topping up from a known wallet, or closing everything at once.

---

Built for **ZECATHON 2026**, Cross-Chain track. All code was written during the hackathon (first commit 2026-10-26).
