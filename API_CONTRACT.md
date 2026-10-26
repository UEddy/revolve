# Revolve order API contract (v1)

Both `worker/` (Account A) and `app/` (Account B) build against this. Change it only by editing this file in a commit both sessions pull.

## Privacy rule that shapes the API

The server never learns what the user buys. It only sells SOL for ZEC. Token choice and the Jupiter swap stay on the device. The server also never sees the burner address until it arrives inside the encrypted memo.

## Buckets

Fixed amounts only (blend in, no fingerprinting): `0.005`, `0.01`, `0.05` ZEC. Server may disable buckets larger than current inventory.

## POST /orders

Request:
```json
{ "bucket_zec": "0.01" }
```
Response 201:
```json
{
  "order_id": "rv_7f3k9q2m",
  "deposit_ua": "u1...",
  "amount_zec": "0.01",
  "payout_lamports": "123456789",
  "quote_expires_at": "2026-10-27T10:15:00Z"
}
```
- `order_id`: random, 8+ chars, base32, no sequence.
- `deposit_ua`: Orchard-receiver-only unified address (payments land in Ironwood).
- No IP, user agent or timestamps beyond expiry are stored.

## Memo (built by the app, never by the server)

UTF-8 text: `rv1|<order_id>|<burner_solana_pubkey>`
Zcash memos are always 512 bytes encrypted on chain, so no padding is needed.
The app builds the ZIP-321 link: `zcash:<deposit_ua>?amount=<amount_zec>&memo=<base64url(memo)>`

## GET /orders/:order_id

Response 200:
```json
{
  "status": "awaiting_payment",
  "confirmations": 0,
  "payout_signature": null
}
```
Statuses, in order:
- `awaiting_payment`: no matching note yet
- `seen`: note with this order_id detected, waiting for confirmations
- `confirmed`: enough confirmations, in the randomized 2 to 6 block payout delay
- `paid_out`: SOL sent; `payout_signature` set
- `expired`: quote expired before payment
- `needs_review`: wrong amount, malformed memo, or burner invalid. Manual refund, signed offline.

After `paid_out`, the server deletes order_id to burner mapping and keeps only aggregate counts. GET then returns `{ "status": "paid_out", "payout_signature": "..." }` from a short-lived cache, then 404.

## Rules for the worker

- Match on memo `order_id` AND exact `amount_zec`. Anything else goes to `needs_review`.
- 3 confirmations, then random 2 to 6 extra blocks, then pay.
- Payout = quoted lamports, which include enough SOL for the user's Jupiter swap fees.
- No request logging with IPs. CORS restricted to the app origin.
