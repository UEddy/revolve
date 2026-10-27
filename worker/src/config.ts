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
  swapFeeLamports: bigint;
  quoteTtlSecs: number;
  maxOpenOrders: number;
  /** PKCS#8 PEM of the credits mint key, outside any work tree and code folder (keypath.ts); empty or unloadable disables /mint. */
  mintKeyPath: string;
  mintKeyId: string;
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
    swapFeeLamports: BigInt(opt("SWAP_FEE_LAMPORTS", "5000000")),
    quoteTtlSecs: Number(opt("QUOTE_TTL_SECS", "900")),
    maxOpenOrders: Number(opt("MAX_OPEN_ORDERS", "20")),
    mintKeyPath: opt("MINT_KEY_PATH", ""),
    mintKeyId: opt("MINT_KEY_ID", "k1"),
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
