import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { startMint } from "./mint.ts";
import { OrderBook } from "./orders.ts";
import { Payer, freeInventory, runPayouts } from "./payout.ts";
import { Pricing } from "./pricing.ts";
import { createApi } from "./server.ts";
import { runWatcher } from "./watcher.ts";

const TICK_MS = 15_000;

// Exit cleanly so the watcher child is stopped with us.
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => process.exit(0));

const cfg = loadConfig();
const book = new OrderBook(openDb(cfg.dbPath));
const payer = new Payer(cfg.solanaRpcUrl, cfg.solanaKeypairPath);
const pricing = new Pricing(cfg);
pricing.start();
const mint = await startMint(cfg.mintKeyPath, cfg.mintKeyId);

let paying = false;
async function tick() {
  book.expire();
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
  quote: (zat) => pricing.payoutLamports(zat),
  usdPerZec: () => pricing.indicativeUsdPerZec(),
  mint,
  freeInventory: () => {
    const balance = payer.cachedBalance();
    return balance === null ? null : freeInventory(balance, book, cfg);
  },
}).listen(cfg.port, "127.0.0.1", () => console.error(`order API on 127.0.0.1:${cfg.port}`));
