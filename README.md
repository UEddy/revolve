# Revolve

**Buy anything across crypto with shielded ZEC, from one phone app, without leaving a trail back to your Zcash.**

Live app: **https://revolveapp-phi.vercel.app** (order API: `https://revolveapp.duckdns.org`)

> **Trying it live: buys are small on purpose.** The largest buy is limited by how much SOL the payout hot wallet holds, after what open orders have already reserved. Right now that allows about **0.005 ZEC per buy** (the minimum is 0.002 ZEC, in steps of 0.001). The app's amount screen always shows the current maximum, and so does [`/limits`](https://revolveapp.duckdns.org/limits) (`max_zec`). Larger amounts are refused before you pay, never after.
>
> **Withdrawals are small on purpose too.** Credits are withdrawn to shielded ZEC from a separate withdrawal hot wallet that holds only a little ZEC, and 0.0005 ZEC of it is always kept back for network fees. So a withdrawal is capped by what that wallet holds at the time: a few credits at most while it's being tested, and it is topped up by hand. A withdrawal it can't cover is refused before anything is spent, and the credits stay in your balance; try a smaller amount.

You pay from your shielded Zcash wallet (Zodl), and the asset lands in a brand-new wallet on the destination chain that holds that one position and nothing else. There are no accounts, no wallet connection, no gas to manage and no seed phrase: a passkey on your phone opens an encrypted vault that holds every position's key. Nothing on the Zcash side becomes public, and nothing on the destination side points back to you or to your other positions.

## The problem, proven on mainnet

Every route out of Zcash today deshields. To check, we swapped ZEC through NEAR Intents from Zodl. The resulting Zcash transaction is labelled **"Deshielding (Z-T)"** by the explorer: it has no transparent inputs and one public transparent output of **0.00251649 ZEC** to `t1dCCf1RHzVnkB6KE8d1bzAQypGNktu8zwh`.

- Tx [`19d07f8f507039a1b922113c6cc28bfa8414478b198f96d30425d3541da6fe01`](https://mainnet.zcashexplorer.app/transactions/19d07f8f507039a1b922113c6cc28bfa8414478b198f96d30425d3541da6fe01), block 3,531,462

The amount and the time are now public on Zcash, and they can be matched to the swap on the other side. MAYAChain is no different on the value side: ZEC is paid into its vault's transparent inbound address (newer flows carry only the memo in a shielded note; see the [SwapKit Zcash guide](https://docs.swapkit.dev/spotlights/chain-specific-guides/zcash-shielded-and-unified-addresses)).

## What Revolve does

From one app on your phone you can:

- **Buy any Solana token or tokenized stock with liquidity** (via Jupiter), paid in shielded ZEC. Live.
- **Browse tokens on Base**: a hand-checked list, or any token by its contract address, with KyberSwap prices. Read only for now: buying is built end to end (ETH payout to a fresh Base wallet, the phone signs a KyberSwap buy) but switched off until its hot wallet is funded and tested.
- **Browse** prediction markets (Polymarket) and NFT collections on Solana, Ethereum and Robinhood Chain. Live, read only: these cards say "Buying coming soon".
- **Sell** a position to SOL (or ETH on Base) inside its own wallet, **send** it out, or **cash out privately**: the coin goes back to Revolve for blind-signed credits, at once or in random parts over hours, and you **withdraw** credits to your shielded Zcash address whenever you like. On Solana, Zodl's built-in Swap stays as a faster second route. Cashing out to credits and withdrawing them to shielded ZEC have both run on mainnet (see below).

No bridge UI, no chain selection, no wallet connection, no gas: each position's wallet gets a small SOL reserve with the payout, and the app signs everything on the device.

## How it works

```
 Zodl (your shielded ZEC)
   │  shielded payment to an Orchard-only unified address,
   │  encrypted memo: rv1|<order id>|<fresh wallet>   (Base: rv1|<order id>|base|<0x wallet>)
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

### Cashing out without a trail

Getting back to shielded ZEC is where privacy usually breaks, so the default exit avoids both trails a swap leaves:

1. **Cash in.** The position's SOL (or ETH on Base) goes back to Revolve's hot wallet, the same one every user's payouts come from. The transfer names its cash-in (a memo on Solana, input data on Base), so nobody else can claim it. The app reports it; the worker looks it up on chain itself (it succeeded, names this cash-in, paid at least the quoted amount, inside the quote's window, never used before) and only then signs credits for it, blind, exactly as for a ZEC funding.
2. **Gradually, if you choose.** The cash-out is split into 3 to 6 parts of random sizes, sent at random times over 2 to 8 hours, so neither the amounts nor the times line up with the sale, or with each other.
3. **Withdraw.** Later, you spend credits to a shielded address (a unified address with an Orchard receiver; transparent addresses are refused). The worker pays after a random 20 to 120 minutes, one withdrawal at a time, from a separate ZEC hot wallet, and then deletes the address.

Why this design, and not the alternatives:

- **No swap provider sees you.** Through a cross-chain swap (Zodl's Swap uses one), the provider must learn both ends: which fresh wallet paid, and which Zcash address to pay. That single record links a position to your Zcash wallet. Here no third party is involved at all.
- **Revolve can't link them either.** Credits are blind-signed (RFC 9474): the server signs tokens it never sees, so when they come back in a withdrawal it can't tell which cash-in, funding or position they came from. Without that, Revolve would simply be the swap provider, holding the same record.
- **Amounts and timing are broken up.** The transfer back to Revolve is public on its chain, so the gradual mode, the random delay before every withdrawal, the 0.001 ZEC grid and the coach's warnings (withdrawing right after a cash-in, or exactly the same amount) are what keep it from being paired with the withdrawal.
- **Fully shielded at the end.** Withdrawals only ever pay an Orchard receiver. We showed on mainnet that the common swap route out of ZEC deshields (see above); how a provider pays back into ZEC is up to the provider, so the exit doesn't depend on one.
- **Credits are fungible.** Cashed-out credits can also buy the next position directly, without touching Zcash or any chain in between.

Why a ZEC hot wallet is on the server now, and why it's acceptable:

- Paying someone shielded ZEC needs a spending key; a view-only key can't. So withdrawals need one.
- **It's a separate wallet, not the deposit address.** Its own seed, generated on the server, holding only what an operator moves into it. The deposit address's spending key stays off the server, as before, so deposits in flight are never at risk from it.
- **The loss is bounded.** A daily withdrawal cap (`WITHDRAW_DAILY_CAP_ZAT`) and its small balance limit what a leaked seed or a forged credit could take.
- **A leaked seed doesn't reveal who was paid.** Withdrawals are built with no outgoing viewing key (`OvkPolicy::Discard`), so even the hot wallet's own keys can't list past recipients, and the server deletes each address once paid.
- **It can't pay twice.** Each withdrawal's signed transaction is stored under its id before broadcast; a retry re-broadcasts the same bytes, whose notes can only be spent once.

## Why it does not leak

- **Nothing public on Zcash.** Fully shielded payment to an Orchard-only address: no public amount, no public sender, encrypted memo.
- **One deposit address for everyone.** There are no accounts, so there are no per-user addresses: every payment, a funding or a single buy, goes to the same shielded deposit address. It is matched by its exact amount and its memo, which names that one funding or order by a random id made for it (`rv1f|rf_…` for a funding), never a person. On chain the address, amount and memo are all hidden, so separate addresses would hide nothing more; and to Revolve, an address per user would tag every funding with the same person, the very link the blind credits exist to break.
- **The server can't move deposits.** It holds only a view-only key for the deposit address; that spending key is not on the server. Withdrawals come from a separate, capped hot wallet (see above).
- **Exits leave no trail.** Cashing out to blind-signed credits and withdrawing later means no swap provider ever links a position to your Zcash address, and Revolve can't either.
- **The server isn't told what you buy.** An order carries an amount and a fresh wallet, never a token; the buy happens on the phone.
- **A fresh wallet per position.** Every buy lands in its own new wallet, funded by the shared payout wallet like every other Revolve user's. Its key is 32 bytes drawn at random on the phone (`crypto.getRandomValues`), never derived from the passkey, a seed or another position, so two phones, or two positions on one phone, can't end up with the same wallet (the odds are about 1 in 2^256).
- **Keys sealed by your passkey.** The passkey doesn't make the wallets, it locks them: the vault is AES-256-GCM encrypted with a key derived (HKDF-SHA256) from the passkey's WebAuthn PRF output. That output comes from a secret each passkey creates for itself when it is made, so every passkey opens only its own vault, even though the PRF input is the same public constant for everyone. No password, no seed phrase, no copy on any server.
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
- **Credits are custodial until spent or withdrawn.** That's capped at 0.05 ZEC per funding or cash-in part. Losing your phone without a vault backup loses them.
- **Withdrawals come from a hot wallet.** A ZEC spending key for that one wallet is on the server; its balance and a daily cap bound the loss. If it runs low, withdrawals wait (your credits stay yours) until it's topped up.
- **Cash-in transfers are public.** Anyone can see a fresh wallet pay Revolve's hot wallet. What they can't see is where the credits went; timing and amounts are the remaining fingerprint, which is what the gradual mode and the coach are for.
- **Gradual parts need the app.** A planned part goes out when Revolve is open on your phone at or after its time; the phone holds the keys, so nothing can send for it in the background.
- **Payouts are public on the destination chain.** Anyone can see the hot wallet pay a fresh wallet and that wallet buy a token. What they can't see is who paid for it.
- **The relay sees IPs and logs nothing.** It also sees, in transit, which token a fresh wallet swaps into. The order API sees IPs too, and logs nothing. You trust that we run them as published.
- **Privacy grows with the crowd.** Blind credits, the shared hot wallets and the 0.001 ZEC grid hide you among everyone else doing the same thing. While only a handful of people use Revolve, there is little to hide among: amounts and timing narrow it down to you, for Revolve itself above all.
- **IPs are the operator's to forget.** The order API and the relay both see your IP and log nothing. Blind signatures keep the database from linking a funding, a buy and a cash-out; they can't stop an operator who chose to log IPs from noticing the same phone made all three. For the strongest separation, use a VPN or a different network for different steps.
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


The deposit and the wrong-memo payment both show as fully shielded on the explorer (Orchard actions, no transparent inputs or outputs). The worker's database holds no record of the paid order any more, only a hash of the deposit note, which matches this deposit.

### A full credits run: fund, mint, spend, buy, sell, cash out, withdraw

| Step | Transaction |
|---|---|
| Fund, twice: 0.002 and 0.003 ZEC, shielded from Zodl to the deposit address (memo `rv1f\|<funding id>`, no wallet in it) | [`750e6fa3…84ad13`](https://mainnet.zcashexplorer.app/transactions/750e6fa32c4ccfd91e3cd396d3d5de8d3f2d3924921ed57a806c8b5ffe84ad13), [`5634fd6f…fead002`](https://mainnet.zcashexplorer.app/transactions/5634fd6f5469f8d0ae3ccf89dd1b10d77c3e4dafbc5607bbf2fc89527fead002) |
| Mint: 5 credits, blind-signed (RFC 9474) | Off-chain by design: the server signed tokens it never saw, so no transaction exists |
| Spend: 2 credits on a PUMP buy, after a fresh passkey check | Off-chain: the server checked the tokens and recorded only their hashes |
| Payout: SOL from the shared hot wallet to a fresh wallet | [`59oZ5SHp…jtMV2LAm`](https://solscan.io/tx/59oZ5SHpXzMyPnu7B7KSeYaJCh3B5dQHiVtgubU2zJ5ndCUYEPAzdqdcPJxsDeTVKmjhRkepsJ78DUjvjtMV2LAm) |
| Buy on the device: that wallet bought PUMP | [`vXmK1Bry…vwTGikZZ`](https://solscan.io/tx/vXmK1Bry1zUPqEdSXftbd35HdmjcD5mWHkAgq8ojk2nqyeTfQt3NYv3xHPZzM4iXEM7adH5bVsRxxEhvwTGikZZ) |
| Sell in the same wallet: PUMP back to SOL, nothing sent anywhere else | [`4i1Jyd4V…dak1bfhu`](https://solscan.io/tx/4i1Jyd4VtJrKRLydcnJj1gp9NZ9K9WVX5Fvk8JokqD28ynd9zcZrcTvG46HKi1728k4mKJPUnsEye3wzdak1bfhu) |
| Cash out to credits: the SOL back to the shared hot wallet, the transfer naming its cash-in in a memo; credits blind-signed for it | [`2XRcrWG9…PDoL7fNA`](https://solscan.io/tx/2XRcrWG9RFCmh2PePjv5eqBvcQkG2HkGvCsf9kAPHBp9UVJRwJrMtJTbk4uFRPcm16jKkHTWAM47zM8fPDoL7fNA) |
| Withdraw: 4 credits (0.004 ZEC) to a shielded Zodl address, paid after a random delay from the separate withdrawal hot wallet, Orchard only, with no outgoing viewing key | [`baed025d…c90c9057`](https://mainnet.zcashexplorer.app/transactions/baed025d924dd1bf40eeb817a03e4ebe32da3c9fe295f7f689aeb632c90c9057) |

Only the phone holds that fresh wallet's key, and these four are everything it did on Solana: funded by the shared payout wallet, a buy, a sale, and a transfer back to that same shared wallet. Nothing in it points to the Zcash fundings, to Zodl, or to any other position.

The withdrawal spends only Orchard notes and pays only an Orchard receiver, so nothing about it is public on Zcash either: not the amount, not the address. The credits it spent were blind-signed, so Revolve itself can't tell from the tokens whether they came from the fundings or from the cash-out, and the address was deleted from the server once it was paid.

## How Revolve differs from NEAR Intents

[NEAR Intents](https://docs.near-intents.org) swaps ZEC into another chain's asset through a network of solvers, and the result goes to an address you supply. As shown above, the ZEC leaves Zcash through a deshielding transaction: the amount and time become public and can be matched to the swap on the other side. Revolve keeps the payment fully shielded, to an Orchard-only address with an encrypted memo, so nothing about it is public on Zcash. It is also a consumer app rather than a swap route: you pick the token or stock itself, and it arrives in a fresh wallet that holds that one position and is unlinked to your others. And with credits, even the order server can't link your buys to your deposit or to each other.

## Architecture and repo map

| Folder | What it is |
|---|---|
| [`solver/`](solver/src/main.rs) | Rust watcher: a view-only Orchard/Ironwood wallet over lightwalletd and Tor (librustzcash). It prints one JSON line per received note, and the `address` and `ufvk` commands print the Orchard-only deposit address and viewing key. Its `payer-*` commands ([`payer.rs`](solver/src/payer.rs)) run the separate withdrawal hot wallet. |
| [`worker/`](worker/deploy/DEPLOY.md) | Node order API and payout worker: quotes, memo matching, review queue, delayed SOL payouts from the capped hot wallet (and ETH payouts on Base from a separate one), the credits mint, cash-ins checked on chain, and delayed withdrawals to shielded ZEC. It starts the watcher as a child process. Admin tool: `worker/src/admin.ts`. |
| [`relay/`](relay/README.md) | No-log privacy relay: Solana and Base RPC, Jupiter, KyberSwap, token icons and the read-only Discover feeds (Polymarket, Magic Eden, OpenSea), with no client headers forwarded and allowlisted calls only. |
| [`app/`](app/README.md) | The phone app (PWA): passkey vault, buying, credits, the privacy coach, sell, send and cash out. |

Contracts between the parts: [`API_CONTRACT.md`](API_CONTRACT.md) (order API) and [`CREDITS_CONTRACT.md`](CREDITS_CONTRACT.md) (credits and mint).

## Run it yourself

- Server side (watcher, worker, relay on one droplet, step by step): [`worker/deploy/DEPLOY.md`](worker/deploy/DEPLOY.md)
- The app (dev server with a demo order service, tests, build settings): [`app/README.md`](app/README.md)

## Roadmap

Revolve’s core stays the same for everything below: you pay in shielded ZEC, every position lives in its own fresh wallet, and our server never holds your positions’ keys or learns who holds them.

- Buying prediction markets and NFTs across chains. Browsing is already built (read only) for Polymarket and for Solana, Ethereum and Robinhood Chain collections.
- Perpetuals and derivatives. Open a leveraged position from shielded ZEC, each margin account in its own fresh wallet, so your trading history can’t be stitched together or copytraded.
- Staking and restaking. Earn yield on SOL, ETH and liquid staking tokens without the stake being traceable back to your Zcash holdings.
- Lending and borrowing. Supply assets or borrow against them from a fresh wallet, with collateral that can’t be linked to your other positions.
- More chains as payout routes. Base is built (above); Robinhood Chain is next on the same rules (API_CONTRACT.md v1.4), each a new route behind the same deposit, not a new user flow.
- Fully non-custodial in-app wallet, once a browser Zcash library supports Ironwood (none does yet; we checked).

Long-lived positions like staking, lending and perps are easier to watch over time than one-off buys, so the privacy coach will extend to them: warnings on reusing a wallet across positions, topping up from a known wallet, or closing everything at once.

---

Built for **ZECATHON 2026**, Cross-Chain track. All code was written during the hackathon.
