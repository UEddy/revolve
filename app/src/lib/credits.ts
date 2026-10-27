// Credits (CREDITS_CONTRACT.md v1.3): blind-signed tokens, 1 credit =
// 0.001 ZEC. The blinding maths is RFC 9474 RSABSSA-SHA384-PSS-Randomized
// from @cloudflare/blindrsa-ts; nothing here re-implements it.
//
// A token's `msg` is the *prepared* message: the variant puts 32 random
// bytes in front of our 32 random bytes, and the signature covers all 64.
// The server verifies and hashes exactly those 64 bytes.

import { RSABSSA } from "@cloudflare/blindrsa-ts";
import { b64, fromB64, random } from "./bytes.ts";
import type { CreditToken, Credits, Funding } from "./model.ts";

export const CREDIT_ZATS = 100_000n; // 0.001 ZEC
export const FUND_MIN_ZATS = 200_000n; // 0.002 ZEC
export const FUND_MAX_ZATS = 5_000_000n; // 0.05 ZEC, the per-funding custody cap
const MSG_BYTES = 32;

const suite = () => RSABSSA.SHA384.PSS.Randomized();

/** The mint's public key from GET /mint/key. Extractable because the library reads its modulus; it is public anyway. */
export function importMintKey(spkiB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", fromB64(spkiB64) as Uint8Array<ArrayBuffer>, { name: "RSA-PSS", hash: "SHA-384" }, true, ["verify"]);
}

/** Short, human-checkable fingerprint of a key (SHA-256 of the SPKI). */
export async function keyFingerprint(spkiB64: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", fromB64(spkiB64) as Uint8Array<ArrayBuffer>));
  return Array.from(h.subarray(0, 8), (x) => x.toString(16).padStart(2, "0")).join(":");
}

/** Fresh messages for `count` credits, prepared and blinded. Everything returned must be sealed before `blinded` leaves the device. */
export async function blindFor(key: CryptoKey, count: number): Promise<{ prepared: string[]; inv: string[]; blinded: string[] }> {
  const s = suite();
  const out = { prepared: [] as string[], inv: [] as string[], blinded: [] as string[] };
  for (let i = 0; i < count; i++) {
    const prepared = s.prepare(random(MSG_BYTES));
    const { blindedMsg, inv } = await s.blind(key, prepared);
    out.prepared.push(b64(prepared));
    out.inv.push(b64(inv));
    out.blinded.push(b64(blindedMsg));
  }
  return out;
}

/** Unblinds the mint's answer and verifies every signature against the pinned key. Throws unless all of them check out. */
export async function unblindAll(
  key: CryptoKey,
  keyId: string,
  blind: { prepared: string[]; inv: string[] },
  signatures: string[],
): Promise<CreditToken[]> {
  if (signatures.length !== blind.prepared.length) throw new Error(`the mint returned ${signatures.length} signatures for ${blind.prepared.length} credits`);
  const s = suite();
  const tokens: CreditToken[] = [];
  for (let i = 0; i < signatures.length; i++) {
    const prepared = fromB64(blind.prepared[i]!);
    let sig: Uint8Array;
    try {
      sig = await s.finalize(key, prepared, fromB64(signatures[i]!), fromB64(blind.inv[i]!));
    } catch {
      throw new Error(`signature ${i + 1} from the mint does not verify`);
    }
    if (!(await s.verify(key, sig, prepared))) throw new Error(`signature ${i + 1} from the mint does not verify`);
    tokens.push({ msg: b64(prepared), sig: b64(sig), keyId });
  }
  return tokens;
}

export function verifyToken(key: CryptoKey, t: CreditToken): Promise<boolean> {
  return suite().verify(key, fromB64(t.sig), fromB64(t.msg)).catch(() => false);
}

/** Spendable balance in credits (tokens waiting on a spend's answer are not spendable). */
export function balanceCredits(c: Credits | undefined): number {
  return c?.tokens.length ?? 0;
}

export function creditsToZats(n: number): bigint {
  return BigInt(n) * CREDIT_ZATS;
}

/** How many credits an amount costs. The amount is already on the 0.001 grid. */
export function creditsFor(zats: bigint): number {
  if (zats % CREDIT_ZATS !== 0n) throw new Error("amount is not a whole number of credits");
  return Number(zats / CREDIT_ZATS);
}

/** `rv1f|<fund_id>`: no burner, no user data. */
export function buildFundMemo(fundId: string): string {
  if (!/^[A-Za-z0-9_]{8,64}$/.test(fundId)) throw new Error("fund id is not in the contract's format");
  return `rv1f|${fundId}`;
}

/** The newest funding that turned into credits, for the coach. */
export function lastMinted(c: Credits | undefined): Funding | undefined {
  return c?.fundings.filter((f) => f.mintedAt).sort((a, b) => b.mintedAt! - a.mintedAt!)[0];
}

/**
 * What a spend's answer means for its tokens (CREDITS_CONTRACT.md, App rules).
 * - created: the tokens are spent; the order exists.
 * - unavailable (409 amount_unavailable): nothing was consumed; tokens go back.
 * - spent (409 token_spent) or invalid (400 invalid_tokens): never reuse them.
 *   If an earlier try failed without an answer, that try probably went
 *   through: the payout can still arrive at the burner.
 * - network: keep them pending and retry with the very same tokens.
 */
export type SpendOutcome = "created" | "unavailable" | "spent" | "invalid" | "network" | "error";

export function tokensAfter(outcome: SpendOutcome): "spent" | "return" | "drop" | "keep_pending" {
  switch (outcome) {
    case "created":
      return "spent";
    case "unavailable":
      return "return";
    case "spent":
    case "invalid":
      return "drop";
    case "network":
    case "error":
      return "keep_pending";
  }
}
