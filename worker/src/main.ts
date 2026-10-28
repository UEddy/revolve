import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { startMint } from "./mint.ts";
import { OrderBook } from "./orders.ts";
import { BasePayer, runEvmPayouts } from "./evm.ts";
import { Payer, freeInventory, freeOnChain, runPayouts } from "./payout.ts";
import { Pricing } from "./pricing.ts";
import { createApi } from "./server.ts";
import { readFileSync } from "node:fs";
import { solanaRail } from "./cashin.ts";
import { secretPathProblem } from "./keypath.ts";
import { CREDIT_ZAT } from "./mint.ts";
import { WithdrawBook, runWithdrawals } from "./withdrawals.ts";
import { ProcessZecPayer } from "./zecpayer.ts";
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

// Withdrawals (v1.5) are optional too: without a ZEC hot wallet they answer 503.
let zecPayer: ProcessZecPayer | null = null;
if (cfg.zecPayerEnvFile) {
  try {
    const seedPath = /^REVOLVE_PAYER_SEED_PATH=(.*)$/m.exec(readFileSync(cfg.zecPayerEnvFile, "utf8"))?.[1]?.trim();
    if (!seedPath) throw new Error(`${cfg.zecPayerEnvFile} sets no REVOLVE_PAYER_SEED_PATH`);
    const problem = secretPathProblem(seedPath);
    if (problem) throw new Error(`refusing the withdrawal hot wallet seed: ${problem}`);
    zecPayer = new ProcessZecPayer(cfg.watcherBin, cfg.zecPayerEnvFile);
  } catch (e) {
    console.error(`!!! WITHDRAWALS UNAVAILABLE: ${(e as Error).message}`);
  }
}
const withdrawals = new WithdrawBook(book.db);
const BALANCE_EVERY_MS = 5 * 60_000;
let zecBalanceAt = 0;
let payingZec = false;

let paying = false;
let payingBase = false;
async function tick() {
  book.expire();
  if (zecPayer && !payingZec) {
    payingZec = true;
    const zp = zecPayer;
    const refresh = Date.now() - zecBalanceAt > BALANCE_EVERY_MS ? zp.refreshBalance().then(() => void (zecBalanceAt = Date.now())) : Promise.resolve();
    void refresh
      .then(() => runWithdrawals(withdrawals, zp, cfg.withdrawDailyCapZat))
      .catch((e: unknown) => console.error(`withdrawal tick failed: ${(e as Error).message}`))
      .finally(() => (payingZec = false));
  }
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
  cashin: {
    solana: solanaRail(payer.conn, payer.address, () => pricing.cashinPerCredit("solana", CREDIT_ZAT)),
    ...(basePayer ? { base: basePayer.cashinRail(() => pricing.cashinPerCredit("base", CREDIT_ZAT)) } : {}),
  },
  withdraw: zecPayer ? { book: withdrawals, payer: zecPayer } : undefined,
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
