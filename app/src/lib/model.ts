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
  | "sending" // paid with credits: the spend is on its way to the server (retried with the same tokens)
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
    /** Fixed bucket of pre-v1.2 orders; amountZec is the order amount. */
    bucketZec?: string;
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
  /** "credits": paid from the credit balance (CREDITS_CONTRACT.md); otherwise a per-buy Zodl payment. */
  paidWith?: "credits";
};

// ---- credits (CREDITS_CONTRACT.md v1.3) ----

/** A spendable credit: the prepared message (32-byte random prefix + 32 random bytes) and its unblinded signature, base64. */
export type CreditToken = { msg: string; sig: string; keyId: string };

export type FundingStatus = "awaiting_payment" | "seen" | "funded" | "minted" | "expired" | "needs_review" | "gone";

export type Funding = {
  fundId: string;
  depositUa: string;
  amountZec: string;
  credits: number;
  expiresAt: string;
  createdAt: number;
  status: FundingStatus;
  keyId: string;
  /**
   * Blinding state, sealed before the blinded messages leave the device, so a
   * retry sends the very same messages and an answer can always be unblinded.
   * Dropped once the credits are stored.
   */
  blind?: { prepared: string[]; inv: string[]; blinded: string[] };
  mintedAt?: number;
  error?: string;
  demo?: boolean;
};

/** A spend in flight: its tokens are out of the balance until the server answers. */
export type PendingSpend = {
  id: string;
  positionId: string;
  amountZec: string;
  tokens: CreditToken[];
  createdAt: number;
  attempts: number;
  /** True once a send failed without an answer: the server may already have the order. */
  uncertain: boolean;
};

export type Credits = {
  /** The mint key this vault trusts (pinned on first use; a change needs the user's explicit OK). */
  key: { id: string; spki: string; pinnedAt: number } | null;
  tokens: CreditToken[];
  fundings: Funding[];
  pending: PendingSpend[];
};

export type VaultData = {
  v: 1;
  createdAt: number;
  positions: Position[];
  /** Absent in vaults made before credits existed; read through creditsOf(). */
  credits?: Credits;
};

export function emptyCredits(): Credits {
  return { key: null, tokens: [], fundings: [], pending: [] };
}

export function emptyVault(): VaultData {
  return { v: 1, createdAt: Date.now(), positions: [], credits: emptyCredits() };
}

/** The vault's credits, creating the section in older vaults (call inside an update). */
export function creditsOf(d: VaultData): Credits {
  d.credits ??= emptyCredits();
  return d.credits;
}
