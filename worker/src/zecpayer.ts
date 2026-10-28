import { execFile, spawnSync } from "node:child_process";
import type { ZecPayer } from "./withdrawals.ts";

// The ZEC hot wallet through the watcher binary's payer-* commands (solver/src/payer.rs),
// run with their own env file: their seed, birthday and data dir, never the deposit key.

/** Syncing from lightwalletd over Tor and proving can take a while. */
const SEND_TIMEOUT_MS = 15 * 60_000;

export class ProcessZecPayer implements ZecPayer {
  private readonly bin: string;
  private readonly envFile: string;
  private spendable: bigint | null = null;

  constructor(bin: string, envFile: string) {
    this.bin = bin;
    this.envFile = envFile;
  }

  private env() {
    return { ...process.env, REVOLVE_ENV_FILE: this.envFile, RUST_BACKTRACE: "0" };
  }

  private run(args: string[], timeout: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      execFile(this.bin, args, { env: this.env(), timeout, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`${args[0]} failed: ${String(stderr).trim().split("\n").at(-1) ?? err.message}`));
        try {
          resolve(JSON.parse(String(stdout).trim().split("\n").at(-1) ?? ""));
        } catch {
          reject(new Error(`${args[0]} printed no result`));
        }
      });
    });
  }

  checkAddress(ua: string): boolean {
    return spawnSync(this.bin, ["payer-check-address", ua], { env: this.env(), timeout: 10_000 }).status === 0;
  }

  cachedSpendable(): bigint | null {
    return this.spendable;
  }

  async refreshBalance(): Promise<bigint> {
    const r = await this.run(["payer-balance"], SEND_TIMEOUT_MS);
    if (typeof r.spendable_zat !== "number") throw new Error("payer-balance printed no balance");
    this.spendable = BigInt(r.spendable_zat);
    return this.spendable;
  }

  async send(id: string, ua: string, zat: bigint): Promise<{ txid: string; confirmations: number }> {
    const r = await this.run(["payer-send", id, ua, zat.toString()], SEND_TIMEOUT_MS);
    if (typeof r.txid !== "string" || !/^[0-9a-f]{64}$/.test(r.txid)) throw new Error("payer-send printed no txid");
    // A watcher binary older than this worker prints no count; it can't say when a withdrawal is mined.
    if (typeof r.confirmations !== "number") throw new Error("payer-send printed no confirmations: update the watcher binary (DEPLOY.md)");
    return { txid: r.txid, confirmations: r.confirmations };
  }
}
