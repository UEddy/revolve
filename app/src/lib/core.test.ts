import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { buildMemo, parseMemo, zip321 } from "./memo.ts";
import { newBurner, pubkeyBytes, signWith } from "./burner.ts";
import { compactU16, parseTx, readCompactU16, signTx } from "./tx.ts";
import { deriveVaultKey, seal, unseal, WrongPasskey } from "./vault.ts";
import { fromB64url, random } from "./bytes.ts";
import { emptyVault } from "./model.ts";

const UA = "u1" + "qpzry9x8gf2tvdw0s3jn54khce6mua7l".repeat(4);

test("memo follows the contract and round-trips", () => {
  const b = newBurner();
  const memo = buildMemo("rv_7f3k9q2m", b.pub);
  assert.equal(memo, `rv1|rv_7f3k9q2m|${b.pub}`);
  assert.deepEqual(parseMemo(memo), { orderId: "rv_7f3k9q2m", burner: b.pub });
  assert.throws(() => buildMemo("rv|bad|id", b.pub));
  assert.throws(() => buildMemo("rv_7f3k9q2m", "not-a-key"));
});

test("zip321 link carries amount and base64url memo without padding", () => {
  const b = newBurner();
  const memo = buildMemo("rv_7f3k9q2m", b.pub);
  const link = zip321(UA, "0.01", memo);
  const m = /^zcash:(u1[a-z0-9]+)\?amount=0\.01&memo=([A-Za-z0-9_-]+)$/.exec(link);
  assert.ok(m, link);
  assert.equal(m[1], UA);
  assert.equal(new TextDecoder().decode(fromB64url(m[2]!)), memo);
  assert.throws(() => zip321("t1abc", "0.01", memo));
  assert.throws(() => zip321(UA, "1e-3", memo));
  assert.throws(() => zip321(UA, "0.000000001", memo));
});

test("compact-u16 round-trips", () => {
  for (const n of [0, 1, 127, 128, 255, 16383, 16384, 65535]) {
    const enc = compactU16(n);
    assert.deepEqual(readCompactU16(enc, 0), [n, enc.length]);
  }
});

function fakeTx(signers: Uint8Array[], v0: boolean): Uint8Array {
  const program = random(32);
  const msg = [
    ...(v0 ? [0x80] : []),
    signers.length, 0, 1,
    ...compactU16(signers.length + 1),
    ...signers.flatMap((s) => [...s]),
    ...program,
    ...random(32), // blockhash
    0, // no instructions
    ...(v0 ? [0] : []), // no lookup tables
  ];
  return Uint8Array.from([...compactU16(signers.length), ...new Uint8Array(64 * signers.length), ...msg]);
}

for (const v0 of [false, true]) {
  test(`signTx writes a valid signature into our slot (${v0 ? "v0" : "legacy"})`, () => {
    const other = random(32);
    const b = newBurner();
    const tx = fakeTx([other, pubkeyBytes(b.pub)], v0);
    const signed = signTx(tx, pubkeyBytes(b.pub), (m) => signWith(b, m));
    const p = parseTx(signed);
    const sig = signed.subarray(p.signaturesOffset + 64, p.signaturesOffset + 128);
    assert.ok(ed25519.verify(sig, p.message, pubkeyBytes(b.pub)));
    assert.deepEqual(signed.subarray(p.signaturesOffset, p.signaturesOffset + 64), new Uint8Array(64));
    assert.throws(() => signTx(tx, random(32), (m) => signWith(b, m)), /not a signer/);
  });
}

test("burner seed is checked against its address before signing", () => {
  const a = newBurner();
  const b = newBurner();
  assert.equal(base58.decode(a.pub).length, 32);
  assert.throws(() => signWith({ pub: a.pub, seed: b.seed }, new Uint8Array([1])), /does not match/);
});

test("vault seals and unseals; another PRF output cannot open it", async () => {
  const key = await deriveVaultKey(random(32));
  const data = emptyVault();
  data.positions.push({ id: "p1" } as never);
  const sealed = await seal(key, "cred", data);
  assert.deepEqual(await unseal(key, sealed), data);
  const wrong = await deriveVaultKey(random(32));
  await assert.rejects(unseal(wrong, sealed), WrongPasskey);
  await assert.rejects(unseal(key, { ...sealed, credId: "other" }), WrongPasskey);
  const again = await seal(key, "cred", data);
  assert.notEqual(again.iv, sealed.iv);
});
