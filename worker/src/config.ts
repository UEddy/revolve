import { existsSync } from "node:fs";

export interface Config {
  port: number;
  appOrigin: string;
  depositUa: string;
  dbPath: string;
  watcherBin: string;
  watcherEnvFile: string;
  solanaRpcUrl: string;
  solanaKeypairPath: string;
  solReserveLamports: bigint;
  /** The most of the hot wallet's balance ever offered as inventory, however much it holds. */
  hotWalletCapLamports: bigint;
  /** The most paid out per UTC day, in flight included: bounds the loss from a forged order or a stolen mint key. */
  dailyPayoutCapLamports: bigint;
  lamportsPerZec: bigint | null;
  spreadBps: number;
  quoteTtlSecs: number;
  maxOpenOrders: number;
  /** How far the market may move against Revolve between a quote and its payout or cash-in before the quote stops binding. */
  maxPriceMoveBps: number;
  /** PKCS#8 PEM of the credits mint key, outside any work tree and code folder (keypath.ts); empty or unloadable disables /mint. */
  mintKeyPath: string;
  mintKeyId: string;
  /** The ZEC withdrawal hot wallet's env file for the payer-* commands (v1.5); empty leaves withdrawals off. */
  zecPayerEnvFile: string;
  /** The most withdrawn per UTC day, in zatoshis: bounds the loss from a forged or stolen credit. */
  withdrawDailyCapZat: bigint;
  /** Base payouts (API_CONTRACT.md v1.4). An empty EVM_KEY_PATH leaves Base off: /limits doesn't offer it. */
  base: {
    rpcUrl: string;
    /** Hex private key file of the EVM hot wallet, outside any work tree and code folder (keypath.ts). */
    keyPath: string;
    reserveWei: bigint;
    hotWalletCapWei: bigint;
    dailyPayoutCapWei: bigint;
    /** Added to every Base payout: the fresh wallet's gas for its buy and a later sale. */
    weiPerZec: bigint | null;
  };
}

export function loadConfig(): Config {
  const envFile = process.env.WORKER_ENV_FILE ?? ".env";
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const fixedRate = opt("LAMPORTS_PER_ZEC", "");
  return {
    port: Number(opt("PORT", "8787")),
    appOrigin: req("APP_ORIGIN"),
    depositUa: req("DEPOSIT_UA"),
    dbPath: opt("DB_PATH", "./data/worker.sqlite"),
    watcherBin: opt("WATCHER_BIN", "../solver/target/release/revolve-watcher"),
    watcherEnvFile: opt("WATCHER_ENV_FILE", "../solver/.env"),
    solanaRpcUrl: opt("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com"),
    solanaKeypairPath: req("SOLANA_KEYPAIR_PATH"),
    solReserveLamports: BigInt(opt("SOL_RESERVE_LAMPORTS", "10000000")),
    hotWalletCapLamports: BigInt(opt("HOT_WALLET_CAP_LAMPORTS", "1000000000")),
    dailyPayoutCapLamports: BigInt(opt("DAILY_PAYOUT_CAP_LAMPORTS", "1000000000")),
    lamportsPerZec: fixedRate === "" ? null : BigInt(fixedRate),
    spreadBps: Number(opt("SPREAD_BPS", "150")),
    quoteTtlSecs: Number(opt("QUOTE_TTL_SECS", "600")),
    maxPriceMoveBps: Number(opt("MAX_PRICE_MOVE_BPS", "300")),
    maxOpenOrders: Number(opt("MAX_OPEN_ORDERS", "20")),
    mintKeyPath: opt("MINT_KEY_PATH", ""),
    mintKeyId: opt("MINT_KEY_ID", "k1"),
    zecPayerEnvFile: opt("ZEC_PAYER_ENV_FILE", ""),
    withdrawDailyCapZat: BigInt(opt("WITHDRAW_DAILY_CAP_ZAT", "50000000")),
    base: {
      rpcUrl: opt("BASE_RPC_URL", "https://mainnet.base.org"),
      keyPath: opt("EVM_KEY_PATH", ""),
      reserveWei: BigInt(opt("BASE_RESERVE_WEI", "200000000000000")),
      hotWalletCapWei: BigInt(opt("BASE_HOT_WALLET_CAP_WEI", "100000000000000000")),
      dailyPayoutCapWei: BigInt(opt("BASE_DAILY_PAYOUT_CAP_WEI", "100000000000000000")),
      weiPerZec: opt("WEI_PER_ZEC", "") === "" ? null : BigInt(opt("WEI_PER_ZEC", "")),
    },
  };
}

function req(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set`);
  return v;
}

function opt(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}
