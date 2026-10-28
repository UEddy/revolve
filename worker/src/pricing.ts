import type { Chain } from "./chains.ts";
import type { DuePayout, OrderBook } from "./orders.ts";

// ZEC -> SOL and ZEC -> ETH rates. The live price refreshes on its own timer, never in response
// to an order, so the price source learns nothing about when orders are made.

const PRICE_URL = "https://api.coingecko.com/api/v3/simple/price?ids=zcash,solana,ethereum&vs_currencies=usd";
const REFRESH_MS = 60_000;
const MAX_AGE_MS = 10 * 60_000;

// A payout is the order's value at the market rate less the spread, nothing
// added: the fresh wallet's own gas comes out of it (the app keeps a little back
// for its swap and a later sale), so no order costs Revolve more than it earns.

/** How far the market may move against Revolve between a quote and its settlement before the quote stops binding (3%). */
export const MAX_PRICE_MOVE_BPS = 300;
/** Rates are kept this long, to price a cash-in at the moment its transfer landed. */
const HISTORY_MS = 3 * 3600_000;

/** True when `a` is more than `bps` basis points above `b`. */
export function exceedsBy(a: bigint, b: bigint, bps: number): boolean {
  return a * 10_000n > b * BigInt(10_000 + bps);
}

/**
 * What to pay now for a quoted payout: the quote, unless the market has since
 * moved against Revolve by more than `bps`; then the payout is re-priced at the
 * current rate (spread included), so a stale quote can't be picked off. A move
 * in the user's favour keeps the quote. Null without a fresh price: it waits.
 */
export function guardPayout(quoted: bigint, current: bigint | null, bps: number): bigint | null {
  if (current === null) return null;
  return exceedsBy(quoted, current, bps) ? current : quoted;
}

/**
 * A due payout checked against the price now (guardPayout): re-priced in the
 * book if the market moved against Revolve by more than `maxMoveBps`, null
 * (wait) without a fresh price. Shared by the Solana and EVM payout loops.
 */
export function repriced(
  book: Pick<OrderBook, "reprice">,
  chain: Chain,
  due: DuePayout,
  limits: { quote?: (amountZat: bigint) => bigint | null; maxMoveBps?: number },
): DuePayout | null {
  if (!limits.quote) return due;
  const pay = guardPayout(due.lamports, limits.quote(due.amountZat), limits.maxMoveBps ?? MAX_PRICE_MOVE_BPS);
  if (pay === null) {
    console.error(`${chain} payout waiting: no fresh price to check it against`);
    return null;
  }
  if (pay === due.lamports) return due;
  book.reprice(due.orderId, pay);
  console.error(`${chain} payout re-priced: the market moved against its quote by more than the allowed move`);
  return { ...due, lamports: pay };
}

type Rates = { lamportsPerZec: number; weiPerZec: number | null; usdPerZec: number; at: number };

export class Pricing {
  private readonly fixed: bigint | null;
  readonly spreadBps: number;
  private readonly fixedWei: bigint | null;
  private live: Rates | null = null;
  private readonly history: Rates[] = [];

  constructor(opts: { lamportsPerZec: bigint | null; spreadBps: number; weiPerZec?: bigint | null }) {
    this.fixed = opts.lamportsPerZec;
    this.spreadBps = opts.spreadBps;
    this.fixedWei = opts.weiPerZec ?? null;
  }

  /** Runs with a fixed rate too: GET /limits still needs the indicative USD price. */
  start(): void {
    const tick = () => this.refresh().catch((e) => console.error(`price refresh failed: ${e.message}`));
    tick();
    setInterval(tick, REFRESH_MS).unref();
  }

  /** Takes a fresh set of rates (from the refresh timer, or a test) and keeps a few hours of them. */
  record(r: Omit<Rates, "at">, at: number = Date.now()): void {
    this.live = { ...r, at };
    this.history.push(this.live);
    while (this.history.length > 0 && this.history[0]!.at < at - HISTORY_MS) this.history.shift();
  }

  /** Units of the chain's coin per ZEC from a set of rates (a fixed rate wins). */
  private perZec(chain: "solana" | "base", r: Rates | null): bigint | null {
    if (chain === "solana") {
      if (this.fixed !== null) return this.fixed;
      return r ? BigInt(Math.floor(r.lamportsPerZec)) : null;
    }
    if (this.fixedWei !== null) return this.fixedWei;
    return r && r.weiPerZec !== null ? BigInt(Math.floor(r.weiPerZec)) : null;
  }

  private current(): Rates | null {
    return this.fresh() ? this.live : null;
  }

  private payout(chain: "solana" | "base", amountZat: bigint): bigint | null {
    const perZec = this.perZec(chain, this.current());
    if (perZec === null) return null;
    const gross = (amountZat * perZec) / 100_000_000n;
    return (gross * BigInt(10_000 - this.spreadBps)) / 10_000n;
  }

  /** Payout for an order amount, after the spread. Null if no fresh price. */
  payoutLamports(amountZat: bigint): bigint | null {
    return this.payout("solana", amountZat);
  }

  /** Base payout in wei for an order amount, after the spread. Null if no fresh ETH price. */
  payoutWei(amountZat: bigint): bigint | null {
    return this.payout("base", amountZat);
  }

  private creditCost(perZec: bigint, creditZat: bigint): bigint {
    const num = creditZat * perZec * BigInt(10_000 + this.spreadBps);
    const den = 100_000_000n * 10_000n;
    return (num + den - 1n) / den;
  }

  /**
   * What one credit (0.001 ZEC) costs on a cash-in, in lamports or wei: the
   * spread works the other way from a payout, so Revolve never pays out more
   * than it takes in. Null without a fresh price.
   */
  cashinPerCredit(chain: "solana" | "base", creditZat: bigint): bigint | null {
    const perZec = this.perZec(chain, this.current());
    return perZec === null ? null : this.creditCost(perZec, creditZat);
  }

  /**
   * What a credit cost at `atSecs` (a transfer's block time), from the rates
   * seen then. Null when none fresh enough were seen (e.g. the worker restarted since).
   */
  cashinPerCreditAt(chain: "solana" | "base", creditZat: bigint, atSecs: number): bigint | null {
    const at = atSecs * 1000;
    let r: Rates | null = null;
    for (const h of this.history) {
      if (h.at > at) break;
      r = h;
    }
    const perZec = this.perZec(chain, r && at - r.at <= MAX_AGE_MS ? r : null);
    return perZec === null ? null : this.creditCost(perZec, creditZat);
  }

  /** USD per ZEC for display only, e.g. "1224.50". Null if no fresh price. Never used for payouts. */
  indicativeUsdPerZec(): string | null {
    return this.fresh() ? this.live!.usdPerZec.toFixed(2) : null;
  }

  private fresh(): boolean {
    return this.live !== null && Date.now() - this.live.at < MAX_AGE_MS;
  }

  private async refresh(): Promise<void> {
    const res = await fetch(PRICE_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { zcash?: { usd?: number }; solana?: { usd?: number }; ethereum?: { usd?: number } };
    const zec = body.zcash?.usd;
    const sol = body.solana?.usd;
    const eth = body.ethereum?.usd;
    if (!zec || !sol) throw new Error("missing price");
    // A missing ETH price only pauses Base; Solana carries on.
    this.record({ lamportsPerZec: (zec / sol) * 1e9, weiPerZec: eth ? (zec / eth) * 1e18 : null, usdPerZec: zec });
  }
}
