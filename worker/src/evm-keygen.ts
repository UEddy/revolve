// Generates the EVM hot wallet key (Base payouts) straight to a file outside any
// git work tree and outside worker/, relay/, app/ and solver/ (see keypath.ts),
// mode 600, never overwriting one. Prints only the wallet address, to fund.
//
//   node src/evm-keygen.ts <out.key>

import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { secretPathProblem } from "./keypath.ts";

const [out] = process.argv.slice(2);
if (!out) fail("usage: evm-keygen.ts <out.key>");

const path = resolve(out);
if (!existsSync(dirname(path))) fail(`directory ${dirname(path)} does not exist`);
const target = resolve(realpathSync(dirname(path)), path.slice(dirname(path).length + 1));
const problem = secretPathProblem(target);
if (problem) fail(`refusing: ${problem}`);
if (existsSync(target)) fail(`${target} exists; refusing to overwrite a hot wallet key`);

const key = generatePrivateKey();
writeFileSync(target, `${key}\n`, { mode: 0o600, flag: "wx" });
console.log(`wrote the EVM hot wallet key to ${target} (mode 600)`);
console.log(`address (fund it with ETH on Base): ${privateKeyToAccount(key).address}`);

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}
