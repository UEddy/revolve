import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { NoteLine } from "./orders.ts";

const RESTART_MS = 10_000;

/**
 * Runs the Rust watcher as a child process and hands each JSON line to `onNote`.
 * The child gets only what it needs: no Solana settings reach it.
 */
export function runWatcher(bin: string, envFile: string, onNote: (n: NoteLine) => void): void {
  const cwd = dirname(resolve(envFile));
  const child = spawn(resolve(bin), [], {
    cwd,
    stdio: ["ignore", "pipe", "inherit"],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      REVOLVE_ENV_FILE: resolve(envFile),
      // Wide enough that a worker restart still sees every note awaiting payout.
      REVOLVE_EMIT_UNTIL_CONFS: "100",
      RUST_LOG: "warn",
    },
  });

  const stop = () => child.kill("SIGTERM");
  process.once("exit", stop);

  createInterface({ input: child.stdout }).on("line", (line) => {
    let note: NoteLine;
    try {
      note = JSON.parse(line) as NoteLine;
    } catch {
      console.error("watcher: unparseable line");
      return;
    }
    try {
      onNote(note);
    } catch (e) {
      console.error(`note handling failed: ${(e as Error).message}`);
    }
  });

  child.on("exit", (code, signal) => {
    process.off("exit", stop);
    console.error(`watcher exited (${code ?? signal}); restarting in ${RESTART_MS / 1000}s`);
    setTimeout(() => runWatcher(bin, envFile, onNote), RESTART_MS).unref();
  });
}
