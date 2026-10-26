// ZEC -> SOL rate. The live price refreshes on its own timer, never in response
// to an order, so the price source learns nothing about when orders are made.

const PRICE_URL = "https://api.coingecko.com/api/v3/simple/price?ids=zcash,solana&vs_currencies=usd";
const REFRESH_MS = 60_000;
const MAX_AGE_MS = 10 * 60_000;

export class Pricing {
  private readonly fixed: bigint | null;
  private readonly spreadBps: number;
  private readonly swapFeeLamports: bigint;
  private live: { lamportsPerZec: number; at: number } | null = null;

  constructor(opts: { lamportsPerZec: bigint | null; spreadBps: number; swapFeeLamports: bigint }) {
    this.fixed = opts.lamportsPerZec;
    this.spreadBps = opts.spreadBps;
    this.swapFeeLamports = opts.swapFeeLamports;
  }

  start(): void {
    if (this.fixed !== null) return;
    const tick = () => this.refresh().catch((e) => console.error(`price refresh failed: ${e.message}`));
    tick();
    setInterval(tick, REFRESH_MS).unref();
  }

  /** Payout for a bucket, after spread, plus the swap fee allowance. Null if no fresh price. */
  payoutLamports(bucketZat: bigint): bigint | null {
    let perZec: bigint;
    if (this.fixed !== null) perZec = this.fixed;
    else if (this.live && Date.now() - this.live.at < MAX_AGE_MS) perZec = BigInt(Math.floor(this.live.lamportsPerZec));
    else return null;
    const gross = (bucketZat * perZec) / 100_000_000n;
    return (gross * BigInt(10_000 - this.spreadBps)) / 10_000n + this.swapFeeLamports;
  }

  private async refresh(): Promise<void> {
    const res = await fetch(PRICE_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { zcash?: { usd?: number }; solana?: { usd?: number } };
    const zec = body.zcash?.usd;
    const sol = body.solana?.usd;
    if (!zec || !sol) throw new Error("missing price");
    this.live = { lamportsPerZec: (zec / sol) * 1e9, at: Date.now() };
  }
}
