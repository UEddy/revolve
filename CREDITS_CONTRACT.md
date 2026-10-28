# Revolve contract v1.3 addendum: shielded credits (fund once, buy with a passkey tap)

Adds to v1.2. Everything in v1.2 stays (per-buy Pay with Zodl remains as the fallback path).

## Idea

Users fund Revolve once with shielded ZEC and receive blind-signed credit tokens (Chaumian e-cash, RFC 9474 blind RSA). Each buy spends tokens after a passkey prompt. The server cannot link spent tokens to the deposit that minted them, or buys to each other.

## Denomination and keys

- One denomination: 1 credit = 0.001 ZEC.
- Scheme: RFC 9474 RSABSSA-SHA384-PSS-Randomized, 2048-bit key minimum. Use a maintained implementation of RFC 9474 on both sides (e.g. @cloudflare/blindrsa-ts). Verify the package and its maintenance before adding it; never hand-roll the blinding math.
- The mint private key lives only on the droplet (`/opt/revolve/secrets/mint-key.pem`, 600, owned by revolve), never in the repo, generated on the server or on Eddy's PC.
- A token message starts as 32 random bytes generated on the device. The Randomized variant signs the *prepared* message, `prepare(msg)` = 32-byte random prefix || those 32 bytes, so the token message everywhere on the wire (`tokens[].msg`, and what is blinded) is that 64-byte prepared message. The spent hash is SHA-256 of those 64 bytes. Base64 is standard and padded.

## GET /mint/key

Response 200: `{ "key_id": "k1", "public_key_spki_b64": "...", "denomination_zec": "0.001" }`
Every `/mint/*` route and the spend form of POST /orders answer 503 `mint_unavailable` while the server has no mint key.
The app pins `key_id` and refuses to mint against an unknown or changed key without showing a warning.

## POST /mint/orders  (fund)

Request: `{ "amount_zec": "0.02" }` on the 0.001 grid, min 0.002, max 0.05 per funding (custody cap).
Response 201: `{ "fund_id": "rf_...", "deposit_ua": "u1...", "amount_zec": "0.02", "credits": 20, "expires_at": "..." }`
- Errors: 400 `invalid_amount` (not a decimal string, off the grid, below 0.002 or above 0.05), 503 `busy` (too many open fundings).
- A funding expires after 15 minutes, like an order quote.
Memo built by the app: `rv1f|<fund_id>` (no burner, no user data).
The watcher/worker match on fund_id AND exact amount, same review rules as orders.

## GET /mint/orders/:fund_id

Response 200: `{ "status": "funded", "confirmations": 3 }`. 404 `not_found` for an unknown fund_id.
Statuses: `awaiting_payment`, `seen`, `funded` (3 confirmations), `minted`, `expired`, `needs_review`.

## DELETE /mint/orders/:fund_id

Cancels a funding nobody has paid yet, with the same rules as `DELETE /orders/:order_id`: allowed only while no payment note has been seen (`awaiting_payment`, or `expired` without a payment).

- 204, no body: cancelled; the record is deleted and `GET` then answers 404.
- 409 `payment_seen`: a payment has been seen (`seen`, `funded`, `minted`, `needs_review`). The funding is kept.
- 404 `not_found`: unknown or already cancelled.

A payment that still arrives for a cancelled funding goes to manual review (`paid_after_cancel`) and is never minted automatically.

## POST /mint/orders/:fund_id/sign

Only when status is `funded`. Request: `{ "blinded": ["b64", ...] }` with exactly `credits` entries.
Response 200: `{ "signatures": ["b64", ...] }`, in request order. The funding moves to `minted` atomically.
- Retry: a later call with exactly the same blinded set (in any order) gets 200 with the same signatures, so a lost response is recovered by resending the same blinded messages. The app keeps its blinding state until it has the signatures. Any other set gets 409 `already_minted`.
- Errors: 400 `invalid_blinded` (wrong count, not base64, or out of range for the key; the funding stays `funded`), 409 `not_funded` (not yet `funded`, or expired / needs_review), 409 `already_minted`, 404 `not_found`.
- The server stores no blinded message, only "minted" and the SHA-256 of the sorted blinded set (for the retry check). The server sees the blinded messages while signing anyway; blinding keeps them unlinkable to the finished tokens.

## POST /orders  (spend, new form)

Request:
```json
{ "amount_zec": "0.004", "tokens": [{ "msg": "b64", "sig": "b64" }], "burner": "<solana pubkey>" }
```
- `tokens.length * 0.001` must equal `amount_zec`.
- Server verifies every signature, then in ONE database transaction checks none is already spent, records SHA-256 of each `msg` as spent, and creates the order. Any failure: nothing is marked spent.
- Errors: 400 `invalid_tokens`, 409 `token_spent`, 409 `amount_unavailable` (inventory short; tokens NOT consumed).
- Further errors, none of which consume tokens: 400 `invalid_amount` (amount not on the grid), 400 `invalid_burner` (missing or not an on-curve Solana key), 503 `busy` (open-order cap), 503 `no_price`.
- Retry: resending exactly the same tokens, amount and burner returns 201 with the same order_id and payout_lamports. Any other reuse of a spent token is 409 `token_spent`.
- Response 201: `{ "order_id": "rv_...", "payout_lamports": "..." }`, then status via GET /orders/:id as today.
- Payout after a random 60 to 300 second delay (breaks request-to-payout timing). No Zcash confirmations needed: credits are already backed.
- Spent-token hashes are kept forever (double-spend protection). No IP, user agent or timing stored.

## Privacy and trust (README)

- Unlinkable: blind signatures mean the server cannot tell which deposit minted a token, nor link two buys by their tokens.
- Still linkable by behaviour: minting 0.02 and spending 0.02 seconds later links them by timing and amount. The coach warns when a spend follows a funding closely or uses the whole balance at once.
- Custodial: Revolve holds funded balances until spent. Capped at 0.05 ZEC per funding.
- Mint key compromise lets an attacker forge credits and drain the hot wallet; the capped hot wallet bounds the loss.
- Lost device without a vault backup loses the credits.

## App rules

- Credits (unspent token msg + sig) live only in the passkey vault, encrypted, included in the existing vault backup.
- Every spend requires a fresh WebAuthn assertion with userVerification "required" before tokens leave the vault.
- Mark tokens "pending" before sending; on 409 amount_unavailable return them to unspent; on network failure retry the same tokens (idempotent: same msgs). Never reuse a token after token_spent.
- Show balance in credits as ZEC and USD. Keep "Pay with Zodl" as a secondary option on the buy sheet.
