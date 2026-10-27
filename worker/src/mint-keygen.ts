// Generates the credits mint key (RSA, PKCS#8 PEM) straight to a file outside any
// git work tree and outside worker/, relay/, app/ and solver/ (see keypath.ts),
// mode 600, never overwriting one. Prints only the public key's fingerprint.
//
//   node src/mint-keygen.ts <out.pem> [--bits 2048]

import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { secretPathProblem } from "./keypath.ts";

const [out, flag, value] = process.argv.slice(2);
if (!out || (flag !== undefined && flag !== "--bits")) fail("usage: mint-keygen.ts <out.pem> [--bits 2048]");
const bits = flag ? Number(value) : 2048;
if (!Number.isInteger(bits) || bits < 2048 || bits % 1024 !== 0) fail("--bits must be 2048, 3072, 4096, ...");

const path = resolve(out);
if (!existsSync(dirname(path))) fail(`directory ${dirname(path)} does not exist`);
const target = resolve(realpathSync(dirname(path)), path.slice(dirname(path).length + 1));
const problem = secretPathProblem(target);
if (problem) fail(`refusing: ${problem}`);
if (existsSync(target)) fail(`${target} exists; refusing to overwrite a mint key`);

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: bits, publicExponent: 65537 });
const pem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
writeFileSync(target, pem, { mode: 0o600, flag: "wx" });

const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
console.log(`wrote ${bits}-bit mint key to ${target} (mode 600)`);
console.log(`public key spki sha256: ${createHash("sha256").update(spki).digest("hex")}`);

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}
