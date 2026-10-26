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
  lamportsPerZec: bigint | null;
  spreadBps: number;
  swapFeeLamports: bigint;
  quoteTtlSecs: number;
  maxOpenOrders: number;
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
    lamportsPerZec: fixedRate === "" ? null : BigInt(fixedRate),
    spreadBps: Number(opt("SPREAD_BPS", "150")),
    swapFeeLamports: BigInt(opt("SWAP_FEE_LAMPORTS", "5000000")),
    quoteTtlSecs: Number(opt("QUOTE_TTL_SECS", "1800")),
    maxOpenOrders: Number(opt("MAX_OPEN_ORDERS", "200")),
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
