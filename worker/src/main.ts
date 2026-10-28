import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { startMint } from "./mint.ts";
import { OrderBook } from "./orders.ts";
import { BasePayer, runEvmPayouts } from "./evm.ts";
import { Payer, freeInventory, freeOnChain, runPayouts } from "./payout.ts";
import { Pricing } from "./pricing.ts";
import { createApi } from "./server.ts";
import { runWatcher } from "./watcher.ts";

const TICK_MS = 15_000;

// Exit cleanly so the watcher child is stopped with us.
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => process.exit(0));

const cfg = loadConfig();
const book = new OrderBook(openDb(cfg.dbPath));
const payer = new Payer(cfg.solanaRpcUrl, cfg.solanaKeypairPath);
const pricing = new Pricing({ ...cfg, weiPerZec: cfg.base.weiPerZec, gasAllowanceWei: cfg.base.gasAllowanceWei });
pricing.start();
const mint = await startMint(cfg.mintKeyPath, cfg.mintKeyId);
// Base is optional: without a usable EVM key the worker runs Solana only, as before.
let basePayer: BasePayer | null = null;
if (cfg.base.keyPath) {
  try {
    basePayer = new BasePayer(cfg.base.rpcUrl, cfg.base.keyPath);
    console.error(`base payouts from ${basePayer.address}`);
  } catch (e) {
    console.error(`!!! BASE UNAVAILABLE: ${(e as Error).message}`);
  }
}

let paying = false;
let payingBase = false;
async function tick() {
  book.expire();
  if (basePayer && !payingBase) {
    payingBase = true;
    void basePayer
      .refreshBalance()
      .then(() => runEvmPayouts(book, "base", basePayer, { reserve: cfg.base.reserveWei, dailyCap: cfg.base.dailyPayoutCapWei }))
      .catch((e: unknown) => console.error(`base payout tick failed: ${(e as Error).message}`))
      .finally(() => (payingBase = false));
  }
  if (paying) return;
  paying = true;
  try {
    await payer.refreshBalance();
    await runPayouts(book, payer, { reserve: cfg.solReserveLamports, dailyCap: cfg.dailyPayoutCapLamports });
  } catch (e) {
    console.error(`payout tick failed: ${(e as Error).message}`);
  } finally {
    paying = false;
  }
}

runWatcher(cfg.watcherBin, cfg.watcherEnvFile, (note) => {
  book.onNote(note);
  void tick();
});
setInterval(() => void tick(), TICK_MS);
void tick();

createApi({
  book,
  appOrigin: cfg.appOrigin,
  depositUa: cfg.depositUa,
  quoteTtlSecs: cfg.quoteTtlSecs,
  maxOpenOrders: cfg.maxOpenOrders,
  quote: (zat, chain) => (chain === "solana" ? pricing.payoutLamports(zat) : pricing.payoutWei(zat)),
  usdPerZec: () => pricing.indicativeUsdPerZec(),
  mint,
  chains: basePayer ? ["solana", "base"] : ["solana"],
  freeInventory: (chain) => {
    if (chain === "solana") {
      const balance = payer.cachedBalance();
      return balance === null ? null : freeInventory(balance, book, cfg);
    }
    const balance = basePayer?.cachedBalance() ?? null;
    if (balance === null) return null;
    const b = cfg.base;
    return freeOnChain(balance, book.committedLamports("base"), book.paidToday("base"), { reserve: b.reserveWei, cap: b.hotWalletCapWei, dailyCap: b.dailyPayoutCapWei });
  },
}).listen(cfg.port, "127.0.0.1", () => console.error(`order API on 127.0.0.1:${cfg.port}`));
