import { test } from "node:test";
import assert from "node:assert/strict";
import jsQR from "jsqr";
import { buildMemo, parseZip321, zip321 } from "./memo.ts";
import { buildFundMemo } from "./credits.ts";
import { newBurner } from "./burner.ts";
import { paymentQr, qrPath, qrPixels } from "./qr.ts";

// A mainnet-shaped unified address (bech32 characters, Orchard-only length or longer).
const UA = "u1" + "qpzry9x8gf2tvdw0s3jn54khce6mua7l".repeat(4);

/** Renders the QR exactly as the saved PNG is drawn, then reads it back with an independent decoder. */
function scan(uri: string): string {
  const { width, data } = qrPixels(paymentQr(uri), 4);
  const found = jsQR(data, width, width);
  assert.ok(found, "the QR decodes");
  return found.data;
}

test("the payment QR decodes back to the same address, amount and memo (order and funding)", () => {
  const orderMemo = buildMemo("rv_7f3k9q2m", newBurner().pub);
  for (const [amount, memo] of [["0.004", orderMemo], ["0.05", buildFundMemo("rf_ab12cd34ef")], ["0.002", orderMemo]] as const) {
    const uri = zip321(UA, amount, memo);
    const decoded = scan(uri);
    assert.equal(decoded, uri, "the QR carries the ZIP-321 URI byte for byte");
    assert.deepEqual(parseZip321(decoded), { address: UA, amount, memo });
  }
});

test("ZIP-321 form: amount as given, memo base64url with no padding, nothing else", () => {
  // Memo lengths that would need one and two padding characters in plain base64.
  for (const memo of ["rv1f|rf_ab12cd34ef", "rv1f|rf_ab12cd34e", "rv1f|rf_ab12cd34"]) {
    const uri = zip321(UA, "0.003", memo);
    const q = uri.slice(uri.indexOf("?") + 1);
    assert.match(q, /^amount=0\.003&memo=[A-Za-z0-9_-]+$/, uri);
    assert.ok(!q.includes("=", q.indexOf("memo=") + 5), "no padding");
    assert.ok(!/[+/]/.test(q), "url-safe alphabet");
    assert.equal(parseZip321(uri)!.memo, memo);
  }
});

test("the parser refuses anything that isn't a single, complete payment", () => {
  const memo = buildFundMemo("rf_ab12cd34ef");
  const good = zip321(UA, "0.01", memo);
  assert.ok(parseZip321(good));
  for (const bad of [
    good.replace("zcash:", "bitcoin:"),
    good.replace(/&memo=.*/, ""),
    good.replace("amount=0.01&", ""),
    good + "&label=x",
    good.replace("amount=0.01", "amount=0.01&amount=0.02"),
    good.replace(/memo=.*/, "memo=a+b/c="),
    `zcash:${UA}?amount=0.01&memo=__8`, // not UTF-8
  ]) {
    assert.equal(parseZip321(bad), null, bad);
  }
});

test("the QR keeps a 4-module quiet zone and draws only dark modules", () => {
  const qr = paymentQr(zip321(UA, "0.002", buildFundMemo("rf_ab12cd34ef")));
  for (let i = 0; i < 4; i++) {
    assert.ok(qr.dark[i]!.every((d) => !d), `top row ${i} is blank`);
    assert.ok(qr.dark.every((row) => !row[i]), `left column ${i} is blank`);
  }
  const darkCount = qr.dark.flat().filter(Boolean).length;
  assert.equal(qrPath(qr).match(/M/g)!.length, darkCount);
});
