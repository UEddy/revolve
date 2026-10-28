// ZEC -> SOL and ZEC -> ETH rates. The live price refreshes on its own timer, never in response
// to an order, so the price source learns nothing about when orders are made.

const PRICE_URL = "https://api.coingecko.com/api/v3/simple/price?ids=zcash,solana,ethereum&vs_currencies=usd";
const REFRESH_MS = 60_000;
const MAX_AGE_MS = 10 * 60_000;

// A payout is the order's value at the market rate less the spread, nothing
// added: the fresh wallet's own gas comes out of it (the app keeps a little back
// for its swap and a later sale), so no order costs Revolve more than it earns.

export class Pricing {
  private readonly fixed: bigint | null;
  readonly spreadBps: number;
  private readonly fixedWei: bigint | null;
  private live: { lamportsPerZec: number; weiPerZec: number | null; usdPerZec: number; at: number } | null = null;

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

  /** Payout for an order amount, after the spread. Null if no fresh price. */
  payoutLamports(amountZat: bigint): bigint | null {
    let perZec: bigint;
    if (this.fixed !== null) perZec = this.fixed;
    else if (this.fresh()) perZec = BigInt(Math.floor(this.live!.lamportsPerZec));
    else return null;
    const gross = (amountZat * perZec) / 100_000_000n;
    return (gross * BigInt(10_000 - this.spreadBps)) / 10_000n;
  }

  /** Base payout in wei for an order amount, after the spread. Null if no fresh ETH price. */
  payoutWei(amountZat: bigint): bigint | null {
    let perZec: bigint;
    if (this.fixedWei !== null) perZec = this.fixedWei;
    else if (this.fresh() && this.live!.weiPerZec !== null) perZec = BigInt(Math.floor(this.live!.weiPerZec));
    else return null;
    const gross = (amountZat * perZec) / 100_000_000n;
    return (gross * BigInt(10_000 - this.spreadBps)) / 10_000n;
  }

  /**
   * What one credit (0.001 ZEC) costs on a cash-in, in lamports or wei: the
   * spread works the other way from a payout, so Revolve never pays out more
   * than it takes in. Null without a fresh price.
   */
  cashinPerCredit(chain: "solana" | "base", creditZat: bigint): bigint | null {
    let perZec: bigint;
    if (chain === "solana") {
      if (this.fixed !== null) perZec = this.fixed;
      else if (this.fresh()) perZec = BigInt(Math.floor(this.live!.lamportsPerZec));
      else return null;
    } else {
      if (this.fixedWei !== null) perZec = this.fixedWei;
      else if (this.fresh() && this.live!.weiPerZec !== null) perZec = BigInt(Math.floor(this.live!.weiPerZec));
      else return null;
    }
    const num = creditZat * perZec * BigInt(10_000 + this.spreadBps);
    const den = 100_000_000n * 10_000n;
    return (num + den - 1n) / den;
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
    this.live = { lamportsPerZec: (zec / sol) * 1e9, weiPerZec: eth ? (zec / eth) * 1e18 : null, usdPerZec: zec, at: Date.now() };
  }
}
