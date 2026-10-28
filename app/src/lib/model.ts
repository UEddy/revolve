// What the vault holds. Everything here stays on the device, encrypted at
// rest under a key only the passkey can produce.

import type { BurnerKey } from "./burner.ts";

/** Where a position's wallet lives (API_CONTRACT.md v1.4). Absent on a Position means Solana. */
export type Chain = "solana" | "base";

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
  /** "base": an EVM wallet on Base, whose amounts below are in wei and whose token `mint` is a contract address. */
  chain?: "base";
  burner: BurnerKey;
  token: TokenRef;
  order: {
    id: string;
    /** Fixed bucket of pre-v1.2 orders; amountZec is the order amount. */
    bucketZec?: string;
    amountZec: string;
    depositUa: string;
    /** Lamports, or wei on Base. */
    payoutLamports: string;
    quoteExpiresAt: string;
    status: OrderStatus | "gone";
    confirmations: number;
    payoutSig?: string;
    /** When the app first saw the payout (for the history view). */
    paidAt?: number;
  };
  stage: Stage;
  swap?: { sig?: string; inLamports?: string; outAmount?: string; at?: number; error?: string; attempts: number };
  /** The sale back to SOL or ETH in this wallet. */
  sale?: { sig: string; at: number };
  /** `lamports` is wei on Base. */
  balance?: { lamports: string; tokenRaw: string; at: number };
  /**
   * `cashout`: SOL sent to a deposit address from Zodl's Swap, to come back as shielded ZEC.
   * `cashin`: sent to Revolve's hot wallet for blind-signed credits (v1.5).
   */
  sends: { to: string; at: number; sig: string; what: "asset" | "cash"; cashout?: true; cashin?: true }[];
  keyRevealed?: boolean;
  /** A half-filled "Cash out to Zcash" form, kept in the vault so switching to Zodl (and a lock meanwhile) loses nothing. */
  cashoutDraft?: { to: string; amount: string };
  /** Created against the mock order service: no money moved, balances are simulated. */
  demo?: boolean;
  /** "credits": paid from the credit balance (CREDITS_CONTRACT.md); otherwise a per-buy Zodl payment. */
  paidWith?: "credits";
  /**
   * Cash out to credits (CREDITS_CONTRACT.md v1.5): the wallet's SOL or ETH goes
   * back to Revolve for blind-signed credits, in one or more parts. Each part
   * becomes a cash-in funding (`fundId`) when its time comes.
   */
  cashoutPlan?: { mode: "now" | "gradual"; createdAt: number; parts: { credits: number; at: number; fundId?: string; skipped?: true }[] };
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
  /** v1.5 cash-in: paid by a transfer from a position's wallet on this chain instead of a ZEC note. */
  cashin?: {
    chain: Chain;
    positionId: string;
    payTo: string;
    /** Lamports or wei, as quoted. */
    payAmount: string;
    /** Set before the transfer is signed: if a reload finds it without `tx`, the transfer is never sent again. */
    sendStarted?: true;
    tx?: string;
  };
};

/** A withdrawal of credits to shielded ZEC (v1.5). Its tokens stay here until the server has answered. */
export type Withdrawal = {
  key: string;
  id?: string;
  amountZec: string;
  address: string;
  createdAt: number;
  status: "sending" | "queued" | "sent" | "failed";
  tokens?: CreditToken[];
  /** True once a send failed without an answer: the server may already have it. */
  uncertain?: boolean;
  txid?: string;
  error?: string;
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
  /** Absent in vaults made before withdrawals existed. */
  withdrawals?: Withdrawal[];
};

export type VaultData = {
  v: 1;
  createdAt: number;
  positions: Position[];
  /** Absent in vaults made before credits existed; read through creditsOf(). */
  credits?: Credits;
  /** History cleared up to here (ms); older entries without a hash aren't shown again. */
  historyClearedAt?: number;
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
