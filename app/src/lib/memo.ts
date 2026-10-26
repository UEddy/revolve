// The memo and the ZIP-321 payment link (API_CONTRACT.md, "Memo").
// Built on the device only: the server never sees the burner before it
// arrives inside the encrypted memo.

import { base58 } from "@scure/base";
import { b64url, utf8 } from "./bytes.ts";

const MEMO_MAX_BYTES = 512;
const BECH32_CHARS = "[02-9ac-hj-np-z]";
const UA = new RegExp(`^u1${BECH32_CHARS}{20,}$`);
const ORDER_ID = /^[A-Za-z0-9_]{8,64}$/;
const ZEC_AMOUNT = /^(0|[1-9]\d{0,7})(\.\d{1,8})?$/;

export function isSolanaPubkey(s: string): boolean {
  try {
    return base58.decode(s).length === 32;
  } catch {
    return false;
  }
}

/** `rv1|<order_id>|<burner_solana_pubkey>`. Throws on anything the worker would send to review. */
export function buildMemo(orderId: string, burnerPubkey: string): string {
  if (!ORDER_ID.test(orderId)) throw new Error("order id is not in the contract's format");
  if (!isSolanaPubkey(burnerPubkey)) throw new Error("burner key is not a valid address");
  const memo = `rv1|${orderId}|${burnerPubkey}`;
  if (utf8.encode(memo).length > MEMO_MAX_BYTES) throw new Error("memo over 512 bytes");
  return memo;
}

export function parseMemo(memo: string): { orderId: string; burner: string } | null {
  const parts = memo.split("|");
  if (parts.length !== 3 || parts[0] !== "rv1") return null;
  const [, orderId, burner] = parts as [string, string, string];
  return ORDER_ID.test(orderId) && isSolanaPubkey(burner) ? { orderId, burner } : null;
}

/** `zcash:<deposit_ua>?amount=<amount_zec>&memo=<base64url(memo)>` (ZIP-321, single payment). */
export function zip321(depositUa: string, amountZec: string, memo: string): string {
  if (!UA.test(depositUa)) throw new Error("deposit address is not a mainnet unified address");
  if (!ZEC_AMOUNT.test(amountZec)) throw new Error("amount is not a ZIP-321 decimal");
  const bytes = utf8.encode(memo);
  if (bytes.length > MEMO_MAX_BYTES) throw new Error("memo over 512 bytes");
  return `zcash:${depositUa}?amount=${amountZec}&memo=${b64url(bytes)}`;
}
