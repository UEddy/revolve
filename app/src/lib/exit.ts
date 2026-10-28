// Cashing out without a trail (CREDITS_CONTRACT.md v1.5): a position's coin goes
// back to Revolve for blind-signed credits, now or in random parts over hours,
// and credits are withdrawn to a shielded address later. This file is the pure
// part: how many credits a wallet can buy, and how a cash-out is split in time.

import { RENT_EXEMPT_LAMPORTS } from "./cashout.ts";
import { FEE_LAMPORTS } from "./transfer.ts";
import type { Chain } from "./model.ts";

/** Most credits one cash-in can carry (the per-funding custody cap, 0.05 ZEC). */
export const MAX_PART_CREDITS = 50;

/**
 * What stays in the wallet so every part can still be sent: each transfer's fee,
 * and on Solana the rent minimum (a wallet can't be left with less, only empty,
 * and quoted amounts never empty it exactly). On Base, gas per transfer.
 */
export function keepFor(chain: Chain, parts: number, evmTransferFee = 0n): bigint {
  return chain === "base" ? evmTransferFee * 2n * BigInt(parts) : RENT_EXEMPT_LAMPORTS + FEE_LAMPORTS * BigInt(parts) + 10_000n;
}

/** Whole credits the wallet's coin buys at `perCredit`, after `keep`. */
export function creditsAffordable(balance: bigint, perCredit: bigint, keep: bigint): number {
  if (perCredit <= 0n || balance <= keep) return 0;
  return Number((balance - keep) / perCredit);
}

/**
 * Splits `credits` into parts. "now": as few parts as the cap allows, all due
 * immediately. "gradual": 3 to 6 parts of random sizes (none above the cap),
 * the first 15 to 45 minutes out, the rest spread at random over 2 to 8 hours,
 * so neither the amounts nor the times line up with the sale or each other.
 */
export function planParts(credits: number, mode: "now" | "gradual", now: number, rand: () => number = Math.random): { credits: number; at: number }[] {
  if (credits <= 0) return [];
  const minParts = Math.ceil(credits / MAX_PART_CREDITS);
  if (mode === "now") {
    return Array.from({ length: minParts }, (_, i) => ({ credits: Math.min(MAX_PART_CREDITS, credits - i * MAX_PART_CREDITS), at: now }));
  }
  const want = 3 + Math.floor(rand() * 4);
  const n = Math.min(credits, Math.max(minParts, want));
  // Random cut points, then even out anything over the cap.
  const sizes = Array.from({ length: n }, () => 1);
  for (let left = credits - n; left > 0; left--) sizes[Math.floor(rand() * n)]! += 1;
  for (let i = 0; i < n; i++) {
    while (sizes[i]! > MAX_PART_CREDITS) {
      const j = sizes.findIndex((s) => s < MAX_PART_CREDITS);
      sizes[i]! -= 1;
      sizes[j]! += 1;
    }
  }
  const MIN = 60_000;
  const first = now + (15 + rand() * 30) * MIN;
  const span = (120 + rand() * 360) * MIN;
  const times = [first, ...Array.from({ length: n - 1 }, () => first + rand() * span)].sort((a, b) => a - b);
  return sizes.map((c, i) => ({ credits: c, at: Math.round(times[i]!) }));
}
