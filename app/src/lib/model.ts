// What the vault holds. Everything here stays on the device, encrypted at
// rest under a key only the passkey can produce.

import type { BurnerKey } from "./burner.ts";

export type OrderStatus = "awaiting_payment" | "seen" | "confirmed" | "paid_out" | "expired" | "needs_review";

export type TokenRef = {
  mint: string;
  symbol: string;
  name: string;
  icon?: string;
  decimals: number;
  isStock: boolean;
  verified: boolean;
  launchedAt?: string;
  holderCount?: number;
};

/** Where a position is in its life, as the app sees it (the order status is the server's view). */
export type Stage =
  | "awaiting_payment" // link built, waiting for the deposit
  | "settling" // deposit seen or confirmed, payout pending
  | "funded" // payout landed in the burner, swap not done yet
  | "swapping"
  | "swap_failed"
  | "held" // the asset is in the burner
  | "expired"
  | "needs_review"
  | "closed"; // emptied (sold or sent away)

export type Position = {
  id: string;
  createdAt: number;
  burner: BurnerKey;
  token: TokenRef;
  order: {
    id: string;
    bucketZec: string;
    amountZec: string;
    depositUa: string;
    payoutLamports: string;
    quoteExpiresAt: string;
    status: OrderStatus | "gone";
    confirmations: number;
    payoutSig?: string;
  };
  stage: Stage;
  swap?: { sig?: string; inLamports?: string; outAmount?: string; at?: number; error?: string; attempts: number };
  balance?: { lamports: string; tokenRaw: string; at: number };
  sends: { to: string; at: number; sig: string; what: "asset" | "cash" }[];
  keyRevealed?: boolean;
  /** Created against the mock order service: no money moved, balances are simulated. */
  demo?: boolean;
};

export type VaultData = {
  v: 1;
  createdAt: number;
  positions: Position[];
};

export function emptyVault(): VaultData {
  return { v: 1, createdAt: Date.now(), positions: [] };
}
