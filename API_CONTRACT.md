# Revolve order API contract (v1.2)

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
- Open orders still count against inventory, capped at 20 open orders; quotes last 15 minutes.

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

- 204, no body: cancelled. The record is deleted and the inventory it reserved is released; `GET` then answers 404. Only a hash of the order id is kept.
- 409 `{"error":"payment_seen"}`: a payment has already been seen (`seen`, `confirmed`, `needs_review`, `paid_out`, or a credit-token order). The order is kept and processed as usual.
- 404 `{"error":"not_found"}`: unknown, already cancelled, or paid out more than 15 minutes ago.

A payment that still arrives for a cancelled order is held for manual review (`paid_after_cancel`, like `paid_after_expiry`) and refunded by hand; it is never paid out automatically.

## Rules for the worker

- Match on memo `order_id` AND the order's exact `amount_zec`. Anything else goes to `needs_review`.
- 3 confirmations, then a random 2 to 6 extra blocks, then pay.
- Payout = quoted lamports, which include enough SOL for the user's Jupiter swap fees.
- No request logging with IPs. CORS restricted to the app origin.
