import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { secretPathProblem } from "../src/keypath.ts";
import { startMint } from "../src/mint.ts";

const keygen = resolve(import.meta.dirname, "../src/mint-keygen.ts");
const root = mkdtempSync(join(tmpdir(), "revolve-keypath-"));
after(() => rmSync(root, { recursive: true, force: true }));

// The droplet: /opt/revolve mirrors the repo layout but is not a git work tree.
const mirror = join(root, "opt", "revolve");
for (const d of ["worker/data", "relay", "app", "solver/data", "secrets"]) mkdirSync(join(mirror, d), { recursive: true });

// A real checkout.
const repo = join(root, "checkout");
mkdirSync(join(repo, "secrets"), { recursive: true });
execFileSync("git", ["init", "-q", repo]);

function runKeygen(out: string) {
  return spawnSync(process.execPath, [keygen, out], { encoding: "utf8" });
}

test("a deployed mirror without .git: secrets/ is fine, code folders are refused", () => {
  assert.equal(secretPathProblem(join(mirror, "secrets", "mint-key.pem")), null);
  assert.equal(secretPathProblem(join(mirror, "secrets", "new", "deeper.pem")), null);
  for (const d of ["worker", "worker/data", "relay", "app", "solver/data"]) {
    assert.match(secretPathProblem(join(mirror, d, "mint-key.pem")) ?? "", /keep keys outside worker\/, relay\/, app\/ and solver\//, d);
  }
});

test("anywhere inside a git work tree is refused, even outside the code folders", () => {
  assert.match(secretPathProblem(join(repo, "secrets", "mint-key.pem")) ?? "", /inside the git work tree/);
  assert.match(secretPathProblem(join(repo, "mint-key.pem")) ?? "", /inside the git work tree/);
  assert.match(secretPathProblem(join(repo, "not", "yet", "there.pem")) ?? "", /inside the git work tree/);
  // This worker's own checkout.
  assert.notEqual(secretPathProblem(resolve(import.meta.dirname, "../../mint-key.pem")), null);
});

test("mint-keygen writes into the mirror's secrets/ and refuses a work tree or a code folder", () => {
  const ok = join(mirror, "secrets", "mint-key.pem");
  const r = runKeygen(ok);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /wrote 2048-bit mint key/);
  assert.equal(statSync(ok).mode & 0o777, 0o600);
  assert.match(runKeygen(ok).stderr, /exists; refusing to overwrite/);

  const inRepo = runKeygen(join(repo, "secrets", "mint-key.pem"));
  assert.equal(inRepo.status, 1);
  assert.match(inRepo.stderr, /refusing: .*inside the git work tree/);

  const inWorker = runKeygen(join(mirror, "worker", "data", "mint-key.pem"));
  assert.equal(inWorker.status, 1);
  assert.match(inWorker.stderr, /refusing: .*keep keys outside/);
});

test("startMint: loads a good key, and never throws for a missing, misplaced or broken one", async () => {
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);

  const good = join(mirror, "secrets", "mint-key-2.pem");
  assert.equal(runKeygen(good).status, 0);
  const mint = await startMint(good, "k1", log);
  assert.equal(mint?.keyId, "k1");
  assert.match(lines.pop()!, /mint key k1 loaded \(2048 bits\)/);

  assert.equal(await startMint("", "k1", log), null);
  assert.match(lines.pop()!, /MINT_KEY_PATH not set/);

  const bad: [string, RegExp][] = [
    [join(mirror, "secrets", "missing.pem"), /ENOENT/],
    [join(repo, "secrets", "mint-key.pem"), /path refused: .*inside the git work tree/],
    [join(mirror, "worker", "data", "mint-key.pem"), /path refused: .*keep keys outside/],
  ];
  const garbage = join(mirror, "secrets", "garbage.pem");
  writeFileSync(garbage, "not a key");
  bad.push([garbage, /MINT_KEY_PATH=/]);
  for (const [path, why] of bad) {
    lines.length = 0;
    assert.equal(await startMint(path, "k1", log), null, path);
    assert.match(lines[0]!, /^!!! MINT UNAVAILABLE/);
    assert.match(lines[0]!, why);
    assert.match(lines[1]!, /503 mint_unavailable/);
  }
});
