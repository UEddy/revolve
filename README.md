# Revolve

**Buy anything across crypto with shielded ZEC, from one phone app, without leaving a trail back to your Zcash.**

Live app: **https://revolveapp-phi.vercel.app** (order API: `https://revolveapp.duckdns.org`)

> **Trying it live: amounts are small on purpose.** The hot wallets are funded for testing, so a buy is 0.002 to about **0.005 ZEC** (in steps of 0.001) and a withdrawal is a few credits at most. The app always shows the current limits, and so does [`/limits`](https://revolveapp.duckdns.org/limits). Anything Revolve can't cover is refused before you pay, or before any credit is spent.

You pay from your shielded Zcash wallet (Zodl), and the asset lands in a brand-new wallet on the destination chain that holds that one position and nothing else. There are no accounts, no wallet connection, no gas to manage and no seed phrase: a passkey on your phone opens an encrypted vault that holds every position's key. Nothing on the Zcash side becomes public, and nothing on the destination side points back to you or to your other positions.

**Contents:** [The problem](#the-problem-proven-on-mainnet) · [What Revolve does](#what-revolve-does) · [How it works](#how-it-works) · [Why it does not leak](#why-it-does-not-leak) · [Trust boundaries](#trust-boundaries) · [Abuse protections](#abuse-protections) · [Proven on mainnet](#proven-on-mainnet) · [vs. NEAR Intents](#how-revolve-differs-from-near-intents) · [Business model](#business-model-and-unit-economics) · [Architecture](#architecture-and-repo-map) · [Run it yourself](#run-it-yourself) · [Roadmap](#roadmap) · [Path to trustless](#path-to-trustless) · [FAQ](#faq)

## The problem, proven on mainnet

The common swap routes out of Zcash today deshield. To check, I swapped ZEC through NEAR Intents from Zodl. The resulting Zcash transaction is labelled **"Deshielding (Z-T)"** by the explorer: it has no transparent inputs and one public transparent output of **0.00251649 ZEC** to `t1dCCf1RHzVnkB6KE8d1bzAQypGNktu8zwh`.

- Tx [`19d07f8f507039a1b922113c6cc28bfa8414478b198f96d30425d3541da6fe01`](https://mainnet.zcashexplorer.app/transactions/19d07f8f507039a1b922113c6cc28bfa8414478b198f96d30425d3541da6fe01), block 3,531,462

The amount and the time are now public on Zcash, and they can be matched to the swap on the other side. MAYAChain is no different on the value side: ZEC is paid into its vault's transparent inbound address (newer flows carry only the memo in a shielded note; see the [SwapKit Zcash guide](https://docs.swapkit.dev/spotlights/chain-specific-guides/zcash-shielded-and-unified-addresses)).

## What Revolve does

From one app on your phone you can:

- **Buy any Solana token or tokenized stock with liquidity** (via Jupiter), paid in shielded ZEC. Live.
- **Browse tokens on Base**: a hand-checked list, or any token by its contract address, with KyberSwap prices. Read only for now: buying is built end to end (ETH payout to a fresh Base wallet, the phone signs a KyberSwap buy) but switched off until its hot wallet is funded and tested.
- **Browse** prediction markets (Polymarket) and NFT collections on Solana, Ethereum and Robinhood Chain. Live, read only: these cards say "Buying coming soon".
- **Sell** a position to SOL (or ETH on Base) inside its own wallet, **send** it out, or **cash out privately**: the coin goes back to Revolve for blind-signed credits, at once or in random parts over hours, and you **withdraw** credits to your shielded Zcash address whenever you like. On Solana, Zodl's built-in Swap stays as a faster second route, less private: its swap provider sees both ends. Cashing out to credits and withdrawing them to shielded ZEC have both run on mainnet (see below).

No bridge UI, no chain selection, no wallet connection, no gas to buy separately: a little of each payout stays in its wallet for gas, and the app signs everything on the device.

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

1. **Cash in.** The position's SOL (or ETH on Base) goes back to Revolve's hot wallet, the same one every user's payouts come from. Only wallets Revolve paid into can do this (see [Abuse protections](#abuse-protections)). The transfer names its cash-in (a memo on Solana, input data on Base), so nobody else can claim it. The app reports it; the worker looks it up on chain itself (it succeeded, names this cash-in, paid at least the quoted amount, inside the quote's window, never used before) and only then signs credits for it, blind, exactly as for a ZEC funding.
2. **Gradually, if you choose.** The cash-out is split into 3 to 6 parts of random sizes, sent at random times over 2 to 8 hours, so neither the amounts nor the times line up with the sale, or with each other.
3. **Withdraw.** Later, you spend credits to a shielded address (a unified address with an Orchard receiver; transparent addresses are refused). The worker pays after a random 20 to 120 minutes, one withdrawal at a time, from a separate ZEC hot wallet, and deletes the address once the payment is mined.

Why this design, and not the alternatives:

- **No swap provider sees you.** Through a cross-chain swap (Zodl's Swap uses one), the provider must learn both ends: which fresh wallet paid, and which Zcash address to pay. That single record links a position to your Zcash wallet. Here no third party is involved at all.
- **Revolve can't link them either.** Credits are blind-signed (RFC 9474): the server signs tokens it never sees, so when they come back in a withdrawal it can't tell which cash-in, funding or position they came from. Without that, Revolve would simply be the swap provider, holding the same record.
- **Amounts and timing are broken up.** The transfer back to Revolve is public on its chain, so the gradual mode, the random delay before every withdrawal, the 0.001 ZEC grid and the coach's warnings (withdrawing right after a cash-in, or exactly the same amount) are what keep it from being paired with the withdrawal.
- **Fully shielded at the end.** Withdrawals only ever pay an Orchard receiver. I showed on mainnet that the common swap route out of ZEC deshields (see above); how a provider pays back into ZEC is up to the provider, so the exit doesn't depend on one.
- **Credits are fungible.** Cashed-out credits can also buy the next position directly, without touching Zcash or any chain in between.

Why there is a ZEC hot wallet on the server, and why that's acceptable:

- **A spending key is unavoidable.** Paying someone shielded ZEC needs a spending key; a view-only key can't. So withdrawals need one.
- **It's a separate wallet, not the deposit address.** Its own seed, generated on the server, holding only what an operator moves into it. The deposit address's spending key stays off the server, so deposits in flight are never at risk from it.
- **The loss is bounded.** A daily withdrawal cap (`WITHDRAW_DAILY_CAP_ZAT`) and its small balance limit what a leaked seed or a forged credit could take.
- **A leaked seed doesn't reveal who was paid.** Withdrawals are built with no outgoing viewing key (`OvkPolicy::Discard`), so even the hot wallet's own keys can't list past recipients, and the server deletes each address once paid.
- **It can't pay twice.** Each withdrawal's signed transaction is stored under its id before broadcast; a retry re-broadcasts the same bytes, whose notes can only be spent once.
- **Accepted isn't paid.** A withdrawal stays open until its transaction has 3 confirmations, re-broadcast meanwhile. If one ever expires unmined, it is replaced only once it is well past its expiry height, when the old one can no longer be mined.

## Why it does not leak

- **Nothing public on Zcash.** Fully shielded payment to an Orchard-only address: no public amount, no public sender, encrypted memo.
- **One deposit address for everyone.** There are no accounts, so there are no per-user addresses: every payment, a funding or a single buy, goes to the same shielded deposit address. It is matched by its exact amount and its memo, which names that one funding or order by a random id made for it (`rv1f|rf_…` for a funding), never a person. On chain the address, amount and memo are all hidden, so separate addresses would hide nothing more; and to Revolve, an address per user would tag every funding with the same person, the very link the blind credits exist to break.
- **The server can't move deposits.** It holds only a view-only key for the deposit address; that spending key is not on the server. Withdrawals come from a separate, capped hot wallet (see above).
- **Exits leave no trail.** Cashing out to blind-signed credits and withdrawing later means no swap provider ever links a position to your Zcash address, and Revolve can't either.
- **The server isn't told what you buy.** An order carries an amount and a fresh wallet, never a token; the buy happens on the phone.
- **A fresh wallet per position.** Every buy lands in its own new wallet, funded by the shared payout wallet like every other Revolve user's. Its key is 32 bytes drawn at random on the phone (`crypto.getRandomValues`), never derived from the passkey, a seed or another position, so two phones, or two positions on one phone, can't end up with the same wallet (the odds are about 1 in 2^256).
- **Keys sealed by your passkey.** The passkey doesn't make the wallets, it locks them: the vault is AES-256-GCM encrypted with a key derived (HKDF-SHA256) from the passkey's WebAuthn PRF output. That output comes from a secret each passkey creates for itself when it is made, so every passkey opens only its own vault, even though the PRF input is the same public constant for everyone. No password, no seed phrase, no copy on any server.
- **No accounts, no IP logs.** Orders hold no IP or user agent; the only time kept is when the quote expires. The relay and worker don't log requests, and the reverse proxy has access logs off.
- **Mappings deleted after payout.** Once an order is paid, its row is deleted; only a hash of the note remains, so a re-emitted note isn't paid twice, and a hash of the wallet paid with the amount, which is public on chain anyway, for the cash-in rule. Nothing links that wallet back to the note or the order.
- **Staggered balance checks.** The phone checks one wallet at a time, with gaps between them, so the RPC never sees all your wallets at once.
- **A 0.001 ZEC grid.** Amounts are multiples of 0.001 ZEC, so there are many identical payments to hide among.
- **A privacy coach.** Each position shows a linkability score with its reasons, and risky moves get a warning first: launch sniping, tiny holder counts, repeat buys, sending to another of your wallets or to a reused address, spending credits right after funding, cashing out right after buying or all at once.

**Leaks I found and closed while building:**

- **Transparent-address polling.** A full viewing key makes a light wallet ask the lightwalletd server about transparent addresses, which reveals them. The watcher strips the key down to Orchard only, so it never tracks transparent or Sapling receivers.
- **Request logs at the relay.** The relay started as serverless functions next to the app on Vercel, where the host's request logs would see client IPs. It now runs on my own server with logging off.
- **Demo mode in production.** A production build fails if it points at the demo order service or at plain http, and the demo code is stripped from production bundles.

## Trust boundaries

Stated plainly, so nobody has to dig for them:

- **Custodial between deposit and payout.** From the moment your ZEC arrives until the SOL is paid out, Revolve holds the value. [Path to trustless](#path-to-trustless) is how that goes away.
- **Credits are custodial until spent or withdrawn.** That's capped at 0.05 ZEC per funding or cash-in part. Losing your phone without a vault backup loses them.
- **Withdrawals come from a hot wallet.** A ZEC spending key for that one wallet is on the server; its balance and a daily cap bound the loss. If it runs low, a new withdrawal is refused before anything is spent (your credits stay yours) until it's topped up.
- **Cash-in transfers are public.** Anyone can see a fresh wallet pay Revolve's hot wallet. What they can't see is where the credits went; timing and amounts are the remaining fingerprint, which is what the gradual mode and the coach are for.
- **Gradual parts need the app.** A planned part goes out when Revolve is open on your phone at or after its time; the phone holds the keys, so nothing can send for it in the background.
- **Payouts are public on the destination chain.** Anyone can see the hot wallet pay a fresh wallet and that wallet buy a token. What they can't see is who paid for it.
- **Privacy grows with the crowd.** Blind credits, the shared hot wallets and the 0.001 ZEC grid hide you among everyone else doing the same thing. While only a handful of people use Revolve, there is little to hide among: amounts and timing narrow it down to you, for Revolve itself above all.
- **IPs are the operator's to forget.** The order API and the relay both see your IP and log nothing; the relay also sees, in transit, which token a fresh wallet swaps into. You trust that I run them as published. Blind signatures keep the database from linking a funding, a buy and a cash-out; they can't stop an operator who chose to log IPs from noticing the same phone made all three. For the strongest separation, use a VPN or a different network for different steps.
- **Behaviour can still link you.** Timing and amounts are fingerprints: a buy seconds after a funding, the same unusual amount twice, cashing out a whole position right after buying. The coach warns; it can't prevent.
- **The mint key is a hot key.** If it leaked, an attacker could forge credits and claim payouts or withdrawals. The loss is bounded by what sits in the capped hot wallets and their daily caps.
- **Refunds are manual.** A payment that doesn't match an open order exactly is held for review and refunded by hand: a wrong amount, a malformed or unknown memo, a payment after the quote expired, or a second payment to the same order. So is a cash-in held under the abuse protections (a stale quote, or a wallet Revolve didn't pay).

## Abuse protections

How Revolve keeps people from gaming it, and what is still open:

- **Stale quotes can't be picked off.** Quotes last 10 minutes. Before paying out, the worker checks the quote against the price at that moment. If the market moved against Revolve by more than 3% (`MAX_PRICE_MOVE_BPS`), the payout is re-priced at the current rate; a move in your favour keeps the quote. Without a fresh price, payouts wait. A cash-in is priced as of the moment its transfer landed, from the rates the worker saw then; past a 3% move it is held for review and refunded by hand.
- **Quotes can't lock up the hot wallet.** A quote reserves nothing until its payment is seen, and unpaid quotes don't count toward the cap of 20 open orders, so spamming quotes blocks nobody. Expired unpaid quotes are deleted after a day. The trade-off: if several people pay at once for more than the hot wallet holds, a payout waits until it's topped up.
- **Hot wallets are bounded.** Small balances, a cap on each wallet and daily payout caps (Solana, Base, withdrawals). The deposit address's spending key isn't on the server, and withdrawals go one at a time after a random 20 to 120 minutes.
- **Nothing pays twice.** Spent credits are remembered by hash forever, every payout is stored before it is broadcast and settled by looking it up, and a cash-in transaction can fund only once.
- **A clone can't open your vault.** Passkeys only work on the real site, and the app runs only its own code and talks only to the servers it lists.
- **Revolve only takes back coins it handed out.** A cash-in must come from a wallet Revolve paid into, and a wallet can send back at most twice what Revolve paid it (`CASHIN_MAX_MULTIPLE`), which leaves room for real trading gains. Anything else is held for review and refunded to the wallet it came from. So outside money, stolen funds for example, can't be turned into credits and withdrawn as private ZEC. Revolve keeps a hash of each payout's wallet with the amounts paid in and sent back, which are public on chain anyway; no order or Zcash detail goes with them.
- **Rate limits** on the order API and the relay, which forwards allowlisted calls only.

Still open:

- Within that 2× allowance, gains can't be told apart from money moved in through a rigged trade: someone could launder up to what they first bought through Revolve, with real shielded ZEC. The caps (0.05 ZEC per part, the daily withdrawal cap) bound it.
- The rate limits are global, by design: Revolve keeps no per-user state, so a flood of requests slows everyone down rather than one client.
- The code and hosting accounts (GitHub, Vercel, DigitalOcean) are only as safe as their logins: two-factor authentication on all of them is part of running Revolve.

## Proven on mainnet

### A single buy, paid straight from Zodl

| Step | Transaction |
|---|---|
| Shielded deposit: 0.005 ZEC to the Orchard-only address, landed in Ironwood, block 3,531,565 | [`bef498e89249127a1fb93457305b3b447bb11e831f340fda42ff25c6da1d63fd`](https://mainnet.zcashexplorer.app/transactions/bef498e89249127a1fb93457305b3b447bb11e831f340fda42ff25c6da1d63fd) |
| Payout: 0.065380967 SOL from the hot wallet to a fresh wallet (test payouts then added 0.005 SOL for gas on top; payouts no longer add anything) | [`4uTmgrG2…QtTGd8m2`](https://solscan.io/tx/4uTmgrG2wcg66VkmFFfEzk8nD8KazRaiGQ2maQFwSLVbb1WMaSRg7JUCXfzdGBakZijhsEqxiZDesZx6QtTGd8m2) |
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
| Withdraw: 4 credits (0.004 ZEC) to a shielded Zodl address, paid after a random delay from the separate withdrawal hot wallet, Orchard only, with no outgoing viewing key (Revolve covered the 0.0001 ZEC network fee then; it now comes out of the amount) | [`baed025d…c90c9057`](https://mainnet.zcashexplorer.app/transactions/baed025d924dd1bf40eeb817a03e4ebe32da3c9fe295f7f689aeb632c90c9057) |

Only the phone holds that fresh wallet's key, and these four are everything it did on Solana: funded by the shared payout wallet, a buy, a sale, and a transfer back to that same shared wallet. Nothing in it points to the Zcash fundings, to Zodl, or to any other position.

The withdrawal spends only Orchard notes and pays only an Orchard receiver, so nothing about it is public on Zcash either: not the amount, not the address. The credits it spent were blind-signed, so Revolve itself can't tell from the tokens whether they came from the fundings or from the cash-out, and the address was deleted from the server once it was paid.

## How Revolve differs from NEAR Intents

[NEAR Intents](https://docs.near-intents.org) swaps ZEC into another chain's asset through a network of solvers, and the result goes to an address you supply. As shown above, the ZEC leaves Zcash through a deshielding transaction: the amount and time become public and can be matched to the swap on the other side. Revolve keeps the payment fully shielded, to an Orchard-only address with an encrypted memo, so nothing about it is public on Zcash. It is also a consumer app rather than a swap route: you pick the token or stock itself, and it arrives in a fresh wallet that holds that one position and is unlinked to your others. And with credits, even the order server can't link your buys to your deposit or to each other.

## Business model and unit economics

Revolve earns the way an exchange desk does: a spread on the conversions it performs. No accounts, no ads, no data: it keeps too little about its users to sell anything else, which is the point. **No flow costs Revolve more than it earns**: network fees are paid by whoever's transaction it is, as in any wallet, and Revolve keeps the spread.

### How it earns

| Where | What Revolve keeps |
|---|---|
| Every buy, paid from Zodl or with credits | **1.5%**: the payout is 98.5% of the ZEC's value in SOL or ETH, at a market price refreshed every minute (`SPREAD_BPS=150`). Nothing is added on top |
| Every cash-out to credits | **1.5%** the other way: one credit costs 101.5% of 0.001 ZEC's value in SOL or ETH |
| Funding credits | Nothing: at par, 1 credit = 0.001 ZEC |
| Withdrawing credits | Nothing: at par, less the 0.0001 ZEC network fee, which comes out of the amount (1 credit withdraws 0.0009 ZEC) |

A full round trip (ZEC to a token and back to shielded ZEC) costs the user about 3% plus network fees. The spread also absorbs the price moving while a quote is open (10 minutes); past a 3% move against Revolve, the payout is re-priced at the current rate (see [Abuse protections](#abuse-protections)).

### One buy, end to end (Solana)

What Revolve pays per buy:

- **The payout transaction: 0.000005 SOL.**
- **Rebalancing: about 0.5% of the order (my estimate, not measured).** Buys leave ZEC at the deposit address and take SOL out of the hot wallet; cash-outs run the other way (SOL in, ZEC out), so only the net imbalance has to be swapped back.

What the user pays, out of their own payout: the app keeps 0.0025 SOL of it in the fresh wallet for the swap, the token account's rent (0.00204 SOL) and a later sale. It is theirs and stays in their wallet. On the smallest buy that's about a tenth of the payout held back, so bigger buys are better value; the minimum stays at 0.002 ZEC so Revolve can be tried with very little. The Zcash fee on their payment is paid by their own wallet.

Per buy worth V in SOL, Revolve's contribution is **1.5% of V − 0.5% of V − 0.000005 SOL, about 1% at any size**. At about 12.3 SOL per ZEC (the rate at Revolve's first mainnet payout):

| Buy | Worth | Spread earned | Rebalancing (est.) | Contribution |
|---|---|---|---|---|
| 0.002 ZEC (the minimum) | 0.025 SOL | 0.00037 SOL | 0.00012 SOL | +0.00024 SOL (+1%) |
| 0.005 ZEC (today's largest) | 0.061 SOL | 0.00092 SOL | 0.00031 SOL | +0.00061 SOL (+1%) |
| 0.02 ZEC | 0.25 SOL | 0.0037 SOL | 0.0012 SOL | +0.0025 SOL (+1%) |
| 0.05 ZEC (the cap per funding) | 0.61 SOL | 0.0092 SOL | 0.0031 SOL | +0.0061 SOL (+1%) |

Base works the same way: the payout is the order's value less the spread, and the app keeps 0.00002 ETH of it for the wallet's gas.

### Cash-outs and withdrawals

- **A cash-out to credits earns 1.5%** of the SOL or ETH sent back, and costs Revolve nothing: the user's wallet pays the transfer.
- **A withdrawal costs Revolve nothing**: the 0.0001 ZEC network fee (ZIP-317: 0.00005 ZEC per action, at least two; what Revolve's first mainnet withdrawal paid) comes out of the amount. Only a withdrawal that needs more than two actions costs a little more, and Revolve covers the difference.

### Fixed costs

Today: one small DigitalOcean droplet (1 vCPU, 512 MB, about $4 a month) runs the watcher, the worker, the relay and Caddy. The app is on Vercel's free tier and DNS on DuckDNS. Solana and Base RPC, prices (CoinGecko) and lightwalletd (zec.rocks, over Tor) are free public endpoints. At about 1% per buy, roughly $400 of buys a month covers that. At scale, the costs that grow are paid RPC endpoints, a larger server, a security audit, and someone on call for review items and hot wallet top-ups.

### Growing it

Revenue scales with volume, and volume is capped on purpose for now: the largest buy (about 0.005 ZEC today) is set by how much SOL the payout hot wallet holds, and payouts are capped at 1 SOL a day by default (`DAILY_PAYOUT_CAP_LAMPORTS`). These are safety limits, raised as volume and trust grow.

More ways to earn, not built yet:

- **A swap platform fee.** The buy itself runs on the phone through Jupiter (Solana) and KyberSwap (Base), and both let an integrator take a small fee on the swaps it routes. This links nothing new on chain: every fresh wallet is already funded by the same public hot wallet.
- **The same spread on new products.** Prediction markets, NFTs, perps, staking and lending (see the roadmap) all pay in through the same shielded deposit.
- **Private checkout for other apps.** Wallets and apps could use Revolve's order API to let their users pay from shielded ZEC for anything, for a share of the spread.

### What Revolve won't charge for

- **Privacy features stay free.** Gradual cash-out, random delays and the coach protect everyone only if everyone uses them: a paid privacy tier would shrink the crowd and mark the people who paid for it.
- **One price for everyone.** No accounts means no subscriptions or loyalty tiers, and per-user pricing would itself be a fingerprint.
- **No data to sell, no lending.** Revolve doesn't keep the data, and it won't lend out the ZEC behind credits: balances are custodial, and they must be there to withdraw.

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

Revolve's core stays the same for everything below: you pay in shielded ZEC, every position lives in its own fresh wallet, and the server never holds your positions' keys or learns who holds them.

- **Prediction markets and NFTs.** Buying across chains; browsing is already built (read only) for Polymarket and for Solana, Ethereum and Robinhood Chain collections.
- **Perpetuals and derivatives.** Open a leveraged position from shielded ZEC, each margin account in its own fresh wallet, so your trading history can't be stitched together or copytraded.
- **Staking and restaking.** Earn yield on SOL, ETH and liquid staking tokens without the stake being traceable back to your Zcash holdings.
- **Lending and borrowing.** Supply assets or borrow against them from a fresh wallet, with collateral that can't be linked to your other positions.
- **Native apps for iOS and Android.** The same app and passkey vault on the App Store and Google Play, as signed releases.
- **More chains as payout routes.** Base is built (above); Robinhood Chain is next on the same rules (API_CONTRACT.md v1.4), each a new route behind the same deposit, not a new user flow.
- **An in-app shielded wallet.** Fund and cash out without leaving the app, once a browser Zcash library supports Ironwood (none does yet; I checked). Trustless exits need it too.
- **Trustless swaps,** so Revolve never holds your money at any point: see [Path to trustless](#path-to-trustless) below.

Long-lived positions like staking, lending and perps are easier to watch over time than one-off buys, so the privacy coach will extend to them: warnings on reusing a wallet across positions, topping up from a known wallet, or closing everything at once.

### Path to trustless

Today Revolve is custodial at three points (see [Trust boundaries](#trust-boundaries)): it holds your ZEC between deposit and payout, it holds the ZEC behind credits until they're spent or withdrawn, and its hot wallets pay out. You trust Revolve not to keep the money and not to get hacked. The plan is to replace that trust with **atomic swaps**: the ZEC and the coin on the other chain change hands together or not at all, so neither Revolve nor anyone else can keep both.

**Why Zcash needs a special approach.** Atomic swaps on Bitcoin lock coins with a script: "pay whoever reveals this secret, or refund after this time". Zcash's shielded pool has no scripts and no time locks, and moving through Zcash's transparent pool to get them would deshield the payment, which is exactly the leak Revolve exists to avoid. Monero has the same limit, and Monero–Bitcoin swaps solved it in a way that maps directly onto Revolve:

- **The Zcash side is just a key, split in two.** The phone and a solver (Revolve, or anyone running one) each create half of a fresh shielded spending key. Together the halves make a one-off shielded address that only someone holding *both* halves can spend from.
- **All the rules live on the other chain.** A small escrow program on Solana (a contract on Base) holds the conditions and the deadlines.
- **A proof ties the two together.** Each side proves that its half is the same secret number as a key the other chain can check (a cross-curve discrete-log equality proof, the technique Monero–Bitcoin swaps use). Revealing a half on Solana therefore hands over the matching half of the Zcash key.

**A trustless buy, step by step:**

1. **Quote and set-up.** The phone and the solver exchange their key halves' public parts and the proofs. The phone works out the one-off shielded address.
2. **The solver locks the SOL first.** It goes into the escrow, earmarked for your fresh wallet, with a little SOL sent straight to that wallet so it can pay for its own claim.
3. **You pay from Zodl.** A normal shielded payment to the one-off address: no memo, no changes to Zodl, nothing public on Zcash.
4. **The solver releases.** It can see the payment (both halves can view the address), waits for confirmations, and signs a release for your fresh wallet.
5. **You claim the SOL.** Claiming publishes your half of the key on Solana; the solver now holds both halves and sweeps the ZEC. The buy then runs on the phone exactly as it does today.

If anything goes wrong, nobody can take both sides:

| What goes wrong | What happens |
|---|---|
| You never pay | After a deadline the solver takes its SOL back. It loses only time |
| The solver never releases | The solver can only get its SOL back by refunding, and refunding reveals *its* half of the key, so you sweep your ZEC back |
| The solver never refunds either | After a second, later deadline, you take the SOL anyway |

**A trustless exit** is the same swap in reverse: your fresh wallet locks its SOL in the escrow, the solver pays ZEC to a one-off shielded address you share with it, you release, the solver claims the SOL and reveals its half, and your phone sweeps the ZEC to your Zodl address whenever it likes. Your Zcash address is never given to anyone, not even the solver: the same protection blind credits give today, without anyone holding your money.

**What it replaces in today's design:**

| Part | Today | Trustless |
|---|---|---|
| Deposit | One shared shielded address, matched by memo | A one-off shielded address per swap, no memo |
| Worker | Custodian: payouts from hot wallets, the credits mint, the withdrawal queue | A solver: quotes, locks coins in escrow, releases, sweeps ZEC. Credits stay only as an opt-in, clearly custodial fast lane |
| Hot wallets | Pay out and hold your value in between | Hold the solver's own float only; your money is never in them |
| New: escrow programs | None | On Solana and Base, audited and made immutable (an upgrade key would bring the trust back) |
| Rust watcher | View-only deposit watcher, withdrawal payer | Split-key tooling, sweeps, the proofs |
| App | Vault, fresh wallets, credits | Adds the swap client (key half, proofs, watching the escrow, claiming) and a small shielded wallet for exits and refunds |
| Who can be a solver | Revolve only | Anyone; the app takes the best quote |

**What stays, honestly:** the solver still sees the amount, the timing, the fresh wallet and your IP, as Revolve does today; it just can't keep your money or follow your ZEC after the swap. Your phone has to be online during the swap window. And "fund once, then buy with a tap" is custodial by nature, so it would remain an opt-in.

**What's built today, and what's planned:**

- **Built, and reused as is:** the fresh wallet per position, the passkey vault, on-device buys and sells, the Zcash tooling (librustzcash, synced to the Ironwood pool), crash-safe payouts that never pay twice, and Solana and Base on the same rules. The swap itself is **not built yet**.
- **Planned, in this order:**
  1. **Trust-minimised first:** split the hot-wallet keys across independent people (FROST threshold signing, which already supports Zcash's shielded keys), publish a proof of reserves for credits, and ship reproducible app builds pinned by hash.
  2. **Trustless buys:** the escrow programs, the split-key spends and the cross-curve proof, with an audit before any real money. Buys come first because Zodl does the paying, so the phone only needs to work out the address and claim.
  3. **Trustless exits:** they need a shielded Zcash wallet inside the app, so they wait for a browser library that supports Ironwood (none does yet).

This is careful cryptography that has to be right before it holds anyone's money, so it ships after the hackathon, with an audit, not before.

## FAQ

**Why not just use Zodl's built-in Swap or NEAR Intents?**
They deshield: the ZEC leaves through a public transparent output whose amount and time can be matched to the swap on the other chain ([proven above](#the-problem-proven-on-mainnet)), and the swap provider sees both ends. Revolve pays and withdraws fully shielded, and no third party learns both ends.

**Is Revolve custodial?**
Yes, at three points: between your deposit and the payout, for credits until they're spent or withdrawn, and in its hot wallets. Each is capped and stated in [Trust boundaries](#trust-boundaries); [Path to trustless](#path-to-trustless) is how it goes away.

**What do blind-signed credits buy you?**
The server signs credit tokens without ever seeing them (RFC 9474), so when they come back, for a buy or a withdrawal, Revolve can't tell which funding or cash-out they came from. Without them, Revolve would hold the record linking your deposits, your positions and your exits.

**Why one deposit address for everyone, not one per user?**
On Zcash the address, amount and memo are all hidden anyway, so separate addresses would hide nothing more on chain; and to Revolve, an address per user would tie every funding to the same person. Payments are matched by a random id in the encrypted memo, never by who you are.

**How do you stop amount and timing on Solana from matching the shielded side?**
There's nothing public on the Zcash side to match against: both the payment in and the withdrawal out are fully shielded. On Solana, amounts sit on a 0.001 ZEC grid, payouts wait 3 confirmations plus a random 2 to 6 blocks (or a random 60 to 300 seconds with credits), gradual cash-outs go in 3 to 6 random parts over 2 to 8 hours, withdrawals wait a random 20 to 120 minutes, and the coach warns before moves that would line up. See [Cashing out without a trail](#cashing-out-without-a-trail).

**What can Revolve itself see?**
IP addresses (never logged), public payouts and cash-in transfers, and withdrawal amounts and times. It can't link a spent or withdrawn credit to the funding or cash-out that minted it. While few people use Revolve, timing and amounts still narrow things down, as [Trust boundaries](#trust-boundaries) states.

**Can bad actors use it to launder money?**
Not with outside money: Revolve only takes coins back from wallets it paid into, up to twice what it paid them, so stolen funds can't be turned into credits and private ZEC. Everything is capped per payment and per day. The remaining edge case is stated in [Abuse protections](#abuse-protections).

**What if the server is hacked?**
The deposit address's spending key isn't on it, so deposits are safe. The hot wallets are on it, but each holds little, has a daily cap, and withdrawals wait 20 to 120 minutes. A stolen mint key could forge credits, bounded by those same wallets and caps.

**What if I lose my phone?**
Settings → "Save encrypted backup" gives you a file that is useless without your passkey. On a new phone, "Restore from backup" with the same passkey (synced by Google Password Manager or iCloud Keychain) brings back the wallets and credits it was saved with, so save a fresh one after new buys. Without a backup, they're gone: nothing is ever stored on a server.

**Why a web app (PWA) first?**
It was the fastest way to reach both platforms at once: passkeys with the WebAuthn PRF extension work in Chrome on Android and Safari on iPhone, so the vault needs no account, seed phrase or install. Native apps for the App Store and Google Play are planned, on the same vault design. They also ease the web app's main trade-off, trusting the code the server serves on each visit, since store releases are signed, versioned builds; until then, reproducible, hash-pinned web builds address it ([Path to trustless](#path-to-trustless)).

**Why Solana first?**
Jupiter routes almost any token and tokenized stocks, fees are a fraction of a cent, and swaps land in seconds. Base is built on the same rules and browse-only until its hot wallet is funded and tested.

**What's Ironwood?**
The shielded pool NU6.3 activated on mainnet (block 3,428,143). Revolve's addresses carry only an Orchard receiver, so payments to them land in Ironwood, and the watcher and the withdrawal wallet sync the Ironwood tree.

**How does it make money?**
A 1.5% spread on buys and on cash-outs to credits; network fees are paid by whoever's transaction it is. See [Business model and unit economics](#business-model-and-unit-economics).

**What would you do next?**
Trust-minimised custody first (keys split across independent people, proof of reserves, pinned builds), then trustless swaps with an audit, then routing the app over Tor or Oblivious HTTP, native apps for both app stores, and the products in the [Roadmap](#roadmap).

---

Built for **ZECATHON 2026**, Cross-Chain track. All code was written during the hackathon.
