import { test } from "node:test";
import assert from "node:assert/strict";
import { RSABSSA } from "@cloudflare/blindrsa-ts";
import { b64, fromB64 } from "./bytes.ts";
import { blindFor, buildFundMemo, creditsFor, importMintKey, keyFingerprint, tokensAfter, unblindAll, verifyToken } from "./credits.ts";
import { assertionFlags } from "./passkey.ts";
import { creditWarnings } from "./coach.ts";
import { emptyCredits, type Credits } from "./model.ts";
import { parseZec } from "./amount.ts";

async function mint() {
  const suite = RSABSSA.SHA384.PSS.Randomized();
  const kp = await suite.generateKey({ publicExponent: Uint8Array.from([1, 0, 1]), modulusLength: 2048 });
  const spki = b64(new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey)));
  const sign = (blinded: string[]) => Promise.all(blinded.map(async (m) => b64(await suite.blindSign(kp.privateKey, fromB64(m)))));
  return { spki, sign };
}

test("blind, sign, unblind: every credit verifies against the pinned key", async () => {
  const m = await mint();
  const key = await importMintKey(m.spki);
  const blind = await blindFor(key, 3);
  assert.equal(blind.blinded.length, 3);
  assert.equal(new Set(blind.prepared).size, 3);
  for (const p of blind.prepared) assert.equal(fromB64(p).length, 64); // 32-byte randomizer + 32 random bytes
  const tokens = await unblindAll(key, "k1", blind, await m.sign(blind.blinded));
  assert.equal(tokens.length, 3);
  for (const t of tokens) {
    assert.equal(t.keyId, "k1");
    assert.equal(await verifyToken(key, t), true);
  }
  // The same tokens fail against any other key.
  const other = await importMintKey((await mint()).spki);
  assert.equal(await verifyToken(other, tokens[0]!), false);
});

test("a bad or missing signature means no credits are stored", async () => {
  const m = await mint();
  const key = await importMintKey(m.spki);
  const blind = await blindFor(key, 2);
  const sigs = await m.sign(blind.blinded);
  const tampered = fromB64(sigs[1]!);
  tampered[10]! ^= 0xff;
  await assert.rejects(unblindAll(key, "k1", blind, [sigs[0]!, b64(tampered)]), /signature 2 .* does not verify/);
  await assert.rejects(unblindAll(key, "k1", blind, [sigs[0]!]), /1 signatures for 2 credits/);
  // Signed by a different mint.
  const wrong = await (await mint()).sign(blind.blinded).catch(() => null);
  if (wrong) await assert.rejects(unblindAll(key, "k1", blind, wrong));
});

test("key fingerprints are stable and differ between keys", async () => {
  const a = await mint();
  const b = await mint();
  assert.equal(await keyFingerprint(a.spki), await keyFingerprint(a.spki));
  assert.notEqual(await keyFingerprint(a.spki), await keyFingerprint(b.spki));
  assert.match(await keyFingerprint(a.spki), /^([0-9a-f]{2}:){7}[0-9a-f]{2}$/);
});

test("spend answers decide what happens to the tokens (contract App rules)", () => {
  assert.equal(tokensAfter("created"), "spent");
  assert.equal(tokensAfter("unavailable"), "return");
  assert.equal(tokensAfter("spent"), "drop");
  assert.equal(tokensAfter("invalid"), "drop");
  assert.equal(tokensAfter("network"), "keep_pending");
  assert.equal(tokensAfter("error"), "keep_pending");
});

test("fund memo and credit arithmetic", () => {
  assert.equal(buildFundMemo("rf_abcd1234"), "rv1f|rf_abcd1234");
  assert.throws(() => buildFundMemo("rf|x"));
  assert.equal(creditsFor(parseZec("0.004")!), 4);
  assert.equal(creditsFor(parseZec("0.05")!), 50);
  assert.throws(() => creditsFor(parseZec("0.0045")!));
});

test("user-verified flag is read from authenticatorData", () => {
  const data = new Uint8Array(37);
  data[32] = 0x05; // UP + UV
  assert.deepEqual(assertionFlags(data), { up: true, uv: true });
  data[32] = 0x01; // presence only
  assert.deepEqual(assertionFlags(data), { up: true, uv: false });
  assert.throws(() => assertionFlags(new Uint8Array(10)));
});

test("coach: spending soon after funding, or the whole balance", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  const c: Credits = emptyCredits();
  c.tokens = Array.from({ length: 20 }, () => ({ msg: "", sig: "", keyId: "k1" }));
  c.fundings = [{ fundId: "rf_aaaaaaaa", depositUa: "u1", amountZec: "0.02", credits: 20, expiresAt: "", createdAt: now - 3_600_000, status: "minted", keyId: "k1", mintedAt: now - 5 * 60_000 }];
  const w = creditWarnings(20, c, now);
  assert.deepEqual(w.map((x) => x.title), ["You added funds 5 minutes ago", "This uses your whole balance"]);
  assert.match(w[1]!.body, /exactly the amount you added/);
  // Part of the balance, long after funding: nothing to say.
  c.fundings[0]!.mintedAt = now - 3 * 3_600_000;
  assert.deepEqual(creditWarnings(4, c, now), []);
});
