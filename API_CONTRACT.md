# Revolve order API contract (v1.4)

v1.4 adds payout chains (see the last section). Everything above it is v1.2 and still holds for Solana; a request or memo without a chain means Solana.

Both `worker/` (Account A) and `app/` (Account B) build against this. Change it only by editing this file in a commit both sessions pull.

## Privacy rule that shapes the API

The server never learns what the user buys. It only sells SOL for ZEC. Token choice and the Jupiter swap stay on the device. The server never sees the burner address until it arrives inside the encrypted memo.

## Amounts (changed in v1.2)

Free amounts on a coarse grid replace fixed buckets.
- `step_zec` is `0.001`. Every order amount is a whole multiple of it.
- `min_zec` is `0.002`.
- `max_zec` is whatever the hot wallet can cover right now (after reserve and fee buffer), rounded down to the step.
- Zcash deposit amounts are shielded, so the grid exists only to keep Solana payouts from carrying hyper-precise, fingerprintable amounts.

## GET /limits (new in v1.2)

Response 200:
```json
{
  "min_zec": "0.002",
  "max_zec": "0.007",
  "step_zec": "0.001",
  "indicative_usd_per_zec": "1224.50"
}
```
- `max_zec` below `min_zec` means no orders can be placed right now; the app shows "temporarily unavailable".
- `indicative_usd_per_zec` is for display only (USD input and labels). It comes from the same 60 second price timer the worker already runs. Payouts are always computed from the quote in POST /orders, never from this field.
- `spread_bps` (added later in v1.5) is the spread taken from every payout, in basis points (150 = 1.5%), so the app's "you get" estimate matches the quote. Estimates only; an app talking to a worker without it assumes 150.
- Response 503 `{"error":"not_ready"}` until price and balance are loaded. The app treats it as loading and retries every 3 to 5 seconds.

## GET /buckets (deprecated)

Kept unchanged during the transition so the currently deployed app keeps working. Remove it in a later commit, after the v1.2 app is deployed.

## POST /orders

Request (v1.2):
```json
{ "amount_zec": "0.004" }
```
The legacy form `{ "bucket_zec": "0.005" }` is still accepted during the transition and treated as `amount_zec`.

Validation:
- Not a decimal string, not on the 0.001 grid, below `min_zec`: 400 `{"error":"invalid_amount"}`.
- Above the current `max_zec`: 409 `{"error":"amount_unavailable"}`.

Response 201:
```json
{
  "order_id": "rv_7f3k9q2m",
  "deposit_ua": "u1...",
  "amount_zec": "0.004",
  "payout_lamports": "52345678",
  "quote_expires_at": "2026-10-27T10:15:00Z"
}
```
- `order_id`: random, base32, no sequence.
- `deposit_ua`: Orchard-receiver-only unified address (payments land in Ironwood).
- No IP, user agent or timestamps beyond expiry are stored.
- Only paid orders count against inventory: a quote reserves nothing until its payment is seen, so unpaid quotes can't lock up the hot wallet. Paid orders waiting to settle are capped at 20 (`MAX_OPEN_ORDERS`); unpaid quotes don't count. Quotes last 10 minutes.
- Before a payout, the worker checks the quote against the price then. If the market moved against Revolve by more than 3% (`MAX_PRICE_MOVE_BPS`), the payout is re-priced at that rate, spread included; a move in the user's favour keeps the quote. Without a fresh price, the payout waits.

## Memo (built by the app, never by the server)

UTF-8 text: `rv1|<order_id>|<burner_solana_pubkey>`
Zcash memos are always 512 bytes encrypted on chain, so no padding is needed.
ZIP-321 link: `zcash:<deposit_ua>?amount=<amount_zec>&memo=<base64url(memo)>`

## GET /orders/:order_id

Response 200:
```json
{ "status": "awaiting_payment", "confirmations": 0, "payout_signature": null }
```
Statuses, in order:
- `awaiting_payment`, `seen`, `confirmed`, `paid_out` (with `payout_signature`), `expired`, `needs_review`.

After `paid_out`, the server deletes the order to burner mapping and keeps only aggregate counts. GET returns the paid status from a short-lived cache for 15 minutes, then 404.

## DELETE /orders/:order_id

Cancels an order nobody has paid yet. Allowed only while no payment note has been seen for it: status `awaiting_payment` (or `expired` without a payment).

- 204, no body: cancelled. The record is deleted (an unpaid quote holds no inventory); `GET` then answers 404. Only a hash of the order id is kept.
- 409 `{"error":"payment_seen"}`: a payment has already been seen (`seen`, `confirmed`, `needs_review`, `paid_out`, or a credit-token order). The order is kept and processed as usual.
- 404 `{"error":"not_found"}`: unknown, already cancelled, or paid out more than 15 minutes ago.

A payment that still arrives for a cancelled order is held for manual review (`paid_after_cancel`, like `paid_after_expiry`) and refunded by hand; it is never paid out automatically.

## Rules for the worker

- Match on memo `order_id` AND the order's exact `amount_zec`. Anything else goes to `needs_review`.
- 3 confirmations, then a random 2 to 6 extra blocks, then pay.
- Payout = quoted lamports: the amount's value at the market rate, less the spread. Nothing is added for gas; the app keeps a little of the payout in the fresh wallet for its swap and a later sale.
- No request logging with IPs. CORS restricted to the app origin.

## v1.4: payout chains (Solana, Base)

Backward compatible: every v1.2 request, response field and memo keeps its meaning, and "no chain" always means `solana`. Robinhood Chain is planned as a third chain with the same rules; it is not offered yet.

### Chains

| `chain` | Payout | Recipient format | Payout field |
|---|---|---|---|
| `solana` (default) | SOL, in lamports | base58 Solana public key, on curve | `payout_lamports` |
| `base` | ETH on Base (chain id 8453), in wei | EIP-55 checksummed `0x` address | `payout_wei` |

An EVM recipient must be exactly its EIP-55 checksummed form: all-lowercase or wrongly mixed case is `invalid_burner`. The zero address is refused.

### GET /limits

The v1.2 top-level fields stay and describe Solana. A new `chains` object holds one entry per chain the worker can pay out on right now:
```json
{
  "min_zec": "0.002", "max_zec": "0.005", "step_zec": "0.001", "indicative_usd_per_zec": "1224.50",
  "chains": {
    "solana": { "min_zec": "0.002", "max_zec": "0.005", "step_zec": "0.001" },
    "base":   { "min_zec": "0.002", "max_zec": "0.004", "step_zec": "0.001" }
  }
}
```
- A chain missing from `chains` is not offered (no hot wallet configured, or its price or balance isn't loaded yet). The app shows it as unavailable.
- Each chain's `max_zec` comes from that chain's own inventory: separate hot wallets, reserves and caps.

### POST /orders and the credits spend

Both take an optional `"chain"`:
```json
{ "amount_zec": "0.004", "chain": "base" }
{ "amount_zec": "0.004", "tokens": [...], "burner": "0xAbC...", "chain": "base" }
```
Response 201 echoes `chain` and carries `payout_lamports` (Solana) or `payout_wei` (Base), as a decimal string.

New errors, none of which consume credit tokens:
- 400 `invalid_chain`: not one of the chains above.
- 400 `invalid_burner`: the recipient isn't valid for that chain (see the format rules).
- 503 `chain_unavailable`: that chain isn't offered right now.

### Memo (v1.4)

`rv1|<order_id>|<chain>|<recipient>`, for example `rv1|rv_7f3k9q2m0a|base|0xAbC…`.
- The v1.2 three-field memo `rv1|<order_id>|<burner>` stays valid and means `solana`.
- The memo's chain must equal the order's chain, and the recipient must be valid for it. Anything else goes to `needs_review` (`wrong_chain`, `invalid_burner`), like any other mismatch.
- Credit fundings keep `rv1f|<fund_id>`: credits aren't tied to a chain, only spends are.

### GET /orders/:order_id

Adds `chain`. For Base, `payout_signature` holds the transaction hash (`0x` + 64 hex).

### Rules for the worker (v1.4)

- One EVM hot-wallet key, stored outside the repo under the same rules as the mint key (`keypath.ts`). Base has its own balance, inventory, reserve, hot-wallet cap and daily payout cap. Its RPC URL comes from env.
- Base payout = native ETH for the quoted buy, less the spread, nothing added: the app keeps a little of it in the fresh wallet for its own swap gas (and a later sale). Plain transfer, EIP-1559, 21,000 gas.
- Crash-safe and never paying twice, like Solana:
  - At most one Base payout is in flight. The worker signs the transfer with the next nonce and stores the signed raw transaction, its hash and its nonce, conditionally (only if the order is still `confirmed`), before broadcasting.
  - On an unknown outcome it re-broadcasts that same signed transaction, which can't pay twice because the nonce can only be used once. It then looks up the receipt.
  - Status 1 means paid. Status 0 means nothing moved, so the order can be retried with a new nonce. A different transaction mined at that nonce sends the order to review (`nonce_reused`).
- The order row is deleted after payout as before; only the payout hash is served from the short-lived cache.
