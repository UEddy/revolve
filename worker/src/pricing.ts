// ZEC -> SOL and ZEC -> ETH rates. The live price refreshes on its own timer, never in response
// to an order, so the price source learns nothing about when orders are made.

const PRICE_URL = "https://api.coingecko.com/api/v3/simple/price?ids=zcash,solana,ethereum&vs_currencies=usd";
const REFRESH_MS = 60_000;
const MAX_AGE_MS = 10 * 60_000;

export class Pricing {
  private readonly fixed: bigint | null;
  private readonly spreadBps: number;
  private readonly swapFeeLamports: bigint;
  private readonly fixedWei: bigint | null;
  private readonly gasAllowanceWei: bigint;
  private live: { lamportsPerZec: number; weiPerZec: number | null; usdPerZec: number; at: number } | null = null;

  constructor(opts: { lamportsPerZec: bigint | null; spreadBps: number; swapFeeLamports: bigint; weiPerZec?: bigint | null; gasAllowanceWei?: bigint }) {
    this.fixed = opts.lamportsPerZec;
    this.spreadBps = opts.spreadBps;
    this.swapFeeLamports = opts.swapFeeLamports;
    this.fixedWei = opts.weiPerZec ?? null;
    this.gasAllowanceWei = opts.gasAllowanceWei ?? 0n;
  }

  /** Runs with a fixed rate too: GET /limits still needs the indicative USD price. */
  start(): void {
    const tick = () => this.refresh().catch((e) => console.error(`price refresh failed: ${e.message}`));
    tick();
    setInterval(tick, REFRESH_MS).unref();
  }

  /** Payout for an order amount, after spread, plus the swap fee allowance. Null if no fresh price. */
  payoutLamports(amountZat: bigint): bigint | null {
    let perZec: bigint;
    if (this.fixed !== null) perZec = this.fixed;
    else if (this.fresh()) perZec = BigInt(Math.floor(this.live!.lamportsPerZec));
    else return null;
    const gross = (amountZat * perZec) / 100_000_000n;
    return (gross * BigInt(10_000 - this.spreadBps)) / 10_000n + this.swapFeeLamports;
  }

  /** Base payout in wei for an order amount, after spread, plus the gas allowance. Null if no fresh ETH price. */
  payoutWei(amountZat: bigint): bigint | null {
    let perZec: bigint;
    if (this.fixedWei !== null) perZec = this.fixedWei;
    else if (this.fresh() && this.live!.weiPerZec !== null) perZec = BigInt(Math.floor(this.live!.weiPerZec));
    else return null;
    const gross = (amountZat * perZec) / 100_000_000n;
    return (gross * BigInt(10_000 - this.spreadBps)) / 10_000n + this.gasAllowanceWei;
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
