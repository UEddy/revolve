// "Cash out to Zcash": the position's SOL goes to a deposit address that
// Zodl's own Swap shows (source: SOL on Solana), and Zodl delivers shielded
// ZEC to the user's wallet. Revolve never talks to the swap provider: the
// user copies the address and the exact amount from Zodl into this form.

import { isSolanaPubkey } from "./memo.ts";
import { FEE_LAMPORTS } from "./transfer.ts";

export const LAMPORTS_PER_SOL = 1_000_000_000n;
/** One signature, the cost of a plain transfer. */
export const NETWORK_FEE_LAMPORTS = FEE_LAMPORTS;
/** Below this, Zodl's swap provider refunds instead of swapping (about 0.017 SOL; it moves a little with prices). */
export const ZODL_MIN_LAMPORTS = 17_000_000n;
/**
 * Solana refuses to leave a system account with a balance above zero but
 * below rent exemption (0 bytes of data: 890,880 lamports), so a cash-out
 * either empties the wallet or leaves at least this much.
 */
export const RENT_EXEMPT_LAMPORTS = 890_880n;

/** "0.0251" or "0,0251" to lamports; null for anything else (more than 9 decimals, signs, exponents). */
export function parseSol(input: string): bigint | null {
  const s = input.trim().replace(",", ".");
  const m = /^(\d{0,10})(?:\.(\d{0,9}))?$/.exec(s);
  if (!m || (!m[1] && !m[2])) return null;
  return BigInt(m[1] || "0") * LAMPORTS_PER_SOL + BigInt((m[2] ?? "").padEnd(9, "0"));
}

/** Lamports as a plain SOL string with no trailing zeros, e.g. 25_100_000n -> "0.0251". */
export function formatSol(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_SOL;
  const frac = (lamports % LAMPORTS_PER_SOL).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** The most this wallet can send: everything but the network fee. */
export function maxSendable(balance: bigint): bigint {
  return balance > NETWORK_FEE_LAMPORTS ? balance - NETWORK_FEE_LAMPORTS : 0n;
}

export type CashOutCheck =
  | { ok: true; amount: bigint; leftover: bigint }
  | { ok: false; field: "to" | "amount"; error: string };

/** Everything that must hold before the summary screen. `self` is this position's own wallet. */
export function checkCashOut(to: string, amountText: string, balance: bigint, self: string): CashOutCheck {
  const dest = to.trim();
  if (!isSolanaPubkey(dest)) return { ok: false, field: "to", error: "That is not a Solana address. Copy the deposit address from Zodl's Swap screen." };
  if (dest === self) return { ok: false, field: "to", error: "That is this position's own wallet, not Zodl's deposit address." };
  const amount = parseSol(amountText);
  if (amount === null || amount === 0n) return { ok: false, field: "amount", error: "Enter the SOL amount exactly as Zodl shows it." };
  if (amount < ZODL_MIN_LAMPORTS) {
    return { ok: false, field: "amount", error: `Zodl's minimum is about ${formatSol(ZODL_MIN_LAMPORTS)} SOL. Below that the swap is refunded instead, minus fees.` };
  }
  const max = maxSendable(balance);
  if (amount > max) return { ok: false, field: "amount", error: `This wallet can send at most ${formatSol(max)} SOL after the network fee.` };
  const leftover = balance - amount - NETWORK_FEE_LAMPORTS;
  if (leftover > 0n && leftover < RENT_EXEMPT_LAMPORTS) {
    return {
      ok: false,
      field: "amount",
      error: `That would leave ${formatSol(leftover)} SOL, which Solana doesn't allow. Send ${formatSol(max)} SOL (everything), or leave at least ${formatSol(RENT_EXEMPT_LAMPORTS)}.`,
    };
  }
  return { ok: true, amount, leftover };
}
