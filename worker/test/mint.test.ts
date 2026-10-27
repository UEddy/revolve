import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import { RSABSSA } from "@cloudflare/blindrsa-ts";
import { openDb } from "../src/db.ts";
import { Mint, b64 } from "../src/mint.ts";
import { OrderBook, type NoteLine } from "../src/orders.ts";
import { createApi } from "../src/server.ts";

// The client side (prepare, blind, finalize) is the library, as in the app.
const suite = RSABSSA.SHA384.PSS.Randomized();
const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }) as string;
const mint = await Mint.fromPem(pem, "k1");
const clientKey = await crypto.subtle.importKey(
  "spki",
  Buffer.from(mint.publicKeySpkiB64, "base64"),
  { name: "RSA-PSS", hash: "SHA-384" },
  true,
  ["verify"],
);
const burner = Keypair.generate().publicKey.toBase58();
const otherBurner = Keypair.generate().publicKey.toBase58();

type Token = { msg: string; sig: string };

/** Blinds `n` fresh token messages: what the app sends to /sign, and how to finish them. */
async function blindTokens(n: number) {
  const items: { msg: Uint8Array; blindedMsg: Uint8Array; inv: Uint8Array }[] = [];
  for (let i = 0; i < n; i++) {
    const msg = suite.prepare(crypto.getRandomValues(new Uint8Array(32)));
    const { blindedMsg, inv } = await suite.blind(clientKey, msg);
    items.push({ msg, blindedMsg, inv });
  }
  return {
    blinded: items.map((t) => Buffer.from(t.blindedMsg).toString("base64")),
    finish: async (signatures: string[]): Promise<Token[]> =>
      Promise.all(
        items.map(async (t, i) => ({
          msg: Buffer.from(t.msg).toString("base64"),
          sig: Buffer.from(await suite.finalize(clientKey, t.msg, Buffer.from(signatures[i], "base64"), t.inv)).toString(
            "base64",
          ),
        })),
      ),
  };
}

/** Tokens minted directly against the mint, for spend tests. */
async function tokens(n: number): Promise<Token[]> {
  const b = await blindTokens(n);
  return b.finish(b.blinded.map((x) => mint.blindSign(b64(x)!).toString("base64")));
}

function note(memo: string | null, value: number, confirmations: number, txid = "aa".repeat(32)): NoteLine {
  return { txid, pool: "ironwood", output_index: 0, value, memo, height: 3_600_000, confirmations };
}

async function withMintApi(
  fn: (ctx: {
    base: string;
    book: OrderBook;
    spent: () => number;
    state: { free: bigint | null; price: boolean };
    db: ReturnType<typeof openDb>;
  }) => Promise<void>,
  opts: { mint?: Mint | null } = {},
) {
  const db = openDb(":memory:");
  const book = new OrderBook(db);
  const state = { free: 1_000_000_000n as bigint | null, price: true };
  const server = createApi({
    book,
    appOrigin: "https://app.test",
    depositUa: "u1test",
    quoteTtlSecs: 900,
    maxOpenOrders: 20,
    quote: (zat) => (state.price ? zat * 100n : null),
    usdPerZec: () => "1224.50",
    freeInventory: () => state.free,
    mint: opts.mint === undefined ? mint : opts.mint,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const spent = () => (db.prepare("SELECT COUNT(*) AS n FROM spent_tokens").get() as { n: number }).n;
  try {
    await fn({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, book, spent, state, db });
  } finally {
    server.close();
  }
}

const json = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body) });

test("OpenSSL BlindSign matches the library's own BlindSign and finalizes to a valid signature", async () => {
  const { privateKey } = await suite.generateKey({ modulusLength: 2048, publicExponent: Uint8Array.from([1, 0, 1]) });
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", privateKey)).toString("base64");
  const m = await Mint.fromPem(`-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----\n`, "k1");
  const pub = await crypto.subtle.importKey("spki", Buffer.from(m.publicKeySpkiB64, "base64"), { name: "RSA-PSS", hash: "SHA-384" }, true, ["verify"]);

  const msg = suite.prepare(crypto.getRandomValues(new Uint8Array(32)));
  const { blindedMsg, inv } = await suite.blind(pub, msg);
  const ours = m.blindSign(blindedMsg);
  assert.deepEqual(new Uint8Array(ours), await suite.blindSign(privateKey, blindedMsg), "RSASP1 is deterministic");
  const sig = await suite.finalize(pub, msg, ours, inv);
  assert.ok(await suite.verify(pub, sig, msg));
  assert.ok(await m.verify(msg, sig));
});

test("mint rejects out-of-range blinded messages and bad tokens", async () => {
  assert.throws(() => mint.blindSign(new Uint8Array(mint.kLen - 1)), /out of range/);
  assert.throws(() => mint.blindSign(new Uint8Array(mint.kLen).fill(0xff)), /out of range/);

  const [t] = await tokens(1);
  const msg = b64(t.msg)!;
  const sig = b64(t.sig)!;
  assert.ok(await mint.verify(msg, sig));
  const tampered = Buffer.from(sig);
  tampered[10] ^= 1;
  assert.equal(await mint.verify(msg, tampered), false);
  assert.equal(await mint.verify(msg.subarray(32), sig), false, "the 32-byte inner message alone is not a token");

  const other = await Mint.fromPem(
    generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }) as string,
    "k2",
  );
  assert.equal(await other.verify(msg, sig), false, "signed by another key");
  await assert.rejects(
    Mint.fromPem(generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ format: "pem", type: "pkcs8" }) as string, "k"),
    /at least 2048/,
  );
});

test("strict base64", () => {
  assert.deepEqual(b64("AAEC"), Buffer.from([0, 1, 2]));
  for (const bad of ["", "AAE", "AA EC", "AAEC\n", "AA-_", "AAE=x", 5, null]) assert.equal(b64(bad), null, String(bad));
});

test("GET /mint/key, and 503 for every mint route without a key", async () => {
  await withMintApi(async ({ base }) => {
    const res = await fetch(`${base}/mint/key`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { key_id: "k1", public_key_spki_b64: mint.publicKeySpkiB64, denomination_zec: "0.001" });
  });
  await withMintApi(
    async ({ base }) => {
      assert.equal((await fetch(`${base}/mint/key`)).status, 503);
      assert.equal((await json(base, "/mint/orders", { amount_zec: "0.002" })).status, 503);
      assert.equal((await json(base, "/orders", { amount_zec: "0.002", tokens: [], burner })).status, 503);
    },
    { mint: null },
  );
});

test("fund, confirm, sign once: a second sign call is 409 and signatures finalize", () =>
  withMintApi(async ({ base, book }) => {
    for (const bad of ["0.051", "0.0015", "0.001", "abc", 0.003]) {
      const r = await json(base, "/mint/orders", { amount_zec: bad });
      assert.equal(r.status, 400, String(bad));
      assert.deepEqual(await r.json(), { error: "invalid_amount" });
    }
    const created = await json(base, "/mint/orders", { amount_zec: "0.003" });
    assert.equal(created.status, 201);
    const fund = (await created.json()) as Record<string, unknown>;
    assert.equal(fund.deposit_ua, "u1test");
    assert.equal(fund.amount_zec, "0.003");
    assert.equal(fund.credits, 3);
    assert.match(fund.fund_id as string, /^rf_[0-9a-z]{10}$/);
    assert.match(fund.expires_at as string, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    const id = fund.fund_id as string;
    const status = async () => ((await (await fetch(`${base}/mint/orders/${id}`)).json()) as { status: string }).status;

    const b = await blindTokens(3);
    const early = await json(base, `/mint/orders/${id}/sign`, { blinded: b.blinded });
    assert.equal(early.status, 409);
    assert.deepEqual(await early.json(), { error: "not_funded" });

    book.onNote(note(`rv1f|${id}`, 300_000, 1));
    assert.equal(await status(), "seen");
    book.onNote(note(`rv1f|${id}`, 300_000, 3));
    assert.equal(await status(), "funded");

    assert.equal((await json(base, `/mint/orders/${id}/sign`, { blinded: b.blinded.slice(0, 2) })).status, 400);
    assert.equal((await json(base, `/mint/orders/${id}/sign`, { blinded: [...b.blinded.slice(0, 2), "!!"] })).status, 400);
    const huge = Buffer.alloc(mint.kLen, 0xff).toString("base64");
    assert.equal((await json(base, `/mint/orders/${id}/sign`, { blinded: [...b.blinded.slice(0, 2), huge] })).status, 400);
    assert.equal(await status(), "funded", "bad sign requests leave it funded");

    const ok = await json(base, `/mint/orders/${id}/sign`, { blinded: b.blinded });
    assert.equal(ok.status, 200);
    const { signatures } = (await ok.json()) as { signatures: string[] };
    assert.equal(signatures.length, 3);
    for (const t of await b.finish(signatures)) assert.ok(await mint.verify(b64(t.msg)!, b64(t.sig)!));
    assert.equal(await status(), "minted");

    const again = await json(base, `/mint/orders/${id}/sign`, { blinded: b.blinded });
    assert.equal(again.status, 409);
    assert.deepEqual(await again.json(), { error: "already_minted" });

    assert.equal((await fetch(`${base}/mint/orders/rf_0000000000`)).status, 404);
    assert.equal((await json(base, "/mint/orders/rf_0000000000/sign", { blinded: [] })).status, 404);
  }));

test("concurrent sign calls: exactly one gets signatures", () =>
  withMintApi(async ({ base, book }) => {
    const id = ((await (await json(base, "/mint/orders", { amount_zec: "0.002" })).json()) as { fund_id: string }).fund_id;
    book.onNote(note(`rv1f|${id}`, 200_000, 3));
    const b = await blindTokens(2);
    const codes = (await Promise.all([1, 2, 3].map(() => json(base, `/mint/orders/${id}/sign`, { blinded: b.blinded })))).map(
      (r) => r.status,
    );
    assert.deepEqual(codes.sort(), [200, 409, 409]);
  }));

test("funding notes follow the order review rules", () => {
  let now = Date.parse("2026-10-27T10:00:00Z");
  const book = new OrderBook(openDb(":memory:"), () => now);
  const wrong = book.funds.create(300_000n, 900);
  book.onNote(note(`rv1f|${wrong.fund_id}`, 299_999, 5, "01".repeat(32)));
  assert.equal(book.funds.get(wrong.fund_id)!.status, "needs_review");

  const dup = book.funds.create(200_000n, 900);
  book.onNote(note(`rv1f|${dup.fund_id}`, 200_000, 5, "02".repeat(32)));
  book.onNote(note(`rv1f|${dup.fund_id}`, 200_000, 5, "03".repeat(32)));
  assert.equal(book.funds.get(dup.fund_id)!.status, "funded");

  book.onNote(note("rv1f|rf_0000000000", 200_000, 5, "04".repeat(32)));
  book.onNote(note("rv1f|nope", 200_000, 5, "05".repeat(32)));

  const late = book.funds.create(200_000n, 900);
  now += 901_000;
  book.expire();
  assert.equal(book.funds.get(late.fund_id)!.status, "expired");
  book.onNote(note(`rv1f|${late.fund_id}`, 200_000, 5, "06".repeat(32)));
  assert.equal(book.funds.get(late.fund_id)!.status, "needs_review");

  assert.deepEqual(
    book.reviewNotes().map((n) => n.reason),
    ["duplicate_payment", "unknown_fund", "malformed_memo"],
  );
  assert.deepEqual(
    book.funds.reviewFunds().map((f) => f.review_reason).sort(),
    ["paid_after_expiry", "wrong_amount"],
  );
});

test("spend: 201, exact retry returns the same order, any other reuse is a double spend", () =>
  withMintApi(async ({ base, spent }) => {
    const ts = await tokens(3);
    const ok = await json(base, "/orders", { amount_zec: "0.003", tokens: ts, burner });
    assert.equal(ok.status, 201);
    const order = (await ok.json()) as { order_id: string; payout_lamports: string };
    assert.deepEqual(Object.keys(order).sort(), ["order_id", "payout_lamports"]);
    assert.equal(order.payout_lamports, "30000000");
    assert.equal(spent(), 3);
    assert.deepEqual(await (await fetch(`${base}/orders/${order.order_id}`)).json(), {
      status: "confirmed",
      confirmations: 0,
      payout_signature: null,
    });

    const retry = await json(base, "/orders", { amount_zec: "0.003", tokens: [ts[2], ts[0], ts[1]], burner });
    assert.equal(retry.status, 201);
    assert.deepEqual(await retry.json(), order);
    assert.equal(spent(), 3);

    const otherPayee = await json(base, "/orders", { amount_zec: "0.003", tokens: ts, burner: otherBurner });
    assert.equal(otherPayee.status, 409);
    assert.deepEqual(await otherPayee.json(), { error: "token_spent" });

    const [fresh] = await tokens(1);
    const overlap = await json(base, "/orders", { amount_zec: "0.002", tokens: [ts[0], fresh], burner });
    assert.equal(overlap.status, 409);
    assert.deepEqual(await overlap.json(), { error: "token_spent" });
    assert.equal(spent(), 3, "the fresh token in the rejected spend stays unspent");
    const [fresh2] = await tokens(1);
    assert.equal((await json(base, "/orders", { amount_zec: "0.002", tokens: [fresh, fresh2], burner })).status, 201);
    assert.equal(spent(), 5);
  }));

test("partial failure leaves no tokens spent: one bad signature, or a failing order insert", () =>
  withMintApi(async ({ base, spent, db }) => {
    const ts = await tokens(3);
    const bad = { ...ts[2], sig: ts[1].sig };
    const r = await json(base, "/orders", { amount_zec: "0.003", tokens: [ts[0], ts[1], bad], burner });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: "invalid_tokens" });
    assert.equal(spent(), 0);

    // The spent rows are written before the order insert; make that insert fail.
    db.exec("CREATE TRIGGER fail_order BEFORE INSERT ON orders BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    const failed = await json(base, "/orders", { amount_zec: "0.003", tokens: ts, burner });
    assert.equal(failed.status, 500);
    assert.equal(spent(), 0, "rolled back with the order");
    db.exec("DROP TRIGGER fail_order");

    assert.equal((await json(base, "/orders", { amount_zec: "0.003", tokens: ts, burner })).status, 201);
    assert.equal(spent(), 3);
  }));

test("inventory 409 does not consume tokens; nor do busy or a missing price", () =>
  withMintApi(async ({ base, spent, state }) => {
    const ts = await tokens(4);
    state.free = 39_999_999n;
    const short = await json(base, "/orders", { amount_zec: "0.004", tokens: ts, burner });
    assert.equal(short.status, 409);
    assert.deepEqual(await short.json(), { error: "amount_unavailable" });
    assert.equal(spent(), 0);

    state.free = 40_000_000n;
    state.price = false;
    assert.equal((await json(base, "/orders", { amount_zec: "0.004", tokens: ts, burner })).status, 503);
    assert.equal(spent(), 0);

    state.price = true;
    assert.equal((await json(base, "/orders", { amount_zec: "0.004", tokens: ts, burner })).status, 201);
    assert.equal(spent(), 4);
  }));

test("spend validation: count, duplicates, burner, amount", () =>
  withMintApi(async ({ base, spent }) => {
    const ts = await tokens(2);
    const cases: [unknown, string][] = [
      [{ amount_zec: "0.003", tokens: ts, burner }, "invalid_tokens"],
      [{ amount_zec: "0.002", tokens: [ts[0], ts[0]], burner }, "invalid_tokens"],
      [{ amount_zec: "0.002", tokens: [ts[0], { msg: ts[1].msg }], burner }, "invalid_tokens"],
      [{ amount_zec: "0.002", tokens: [], burner }, "invalid_tokens"],
      [{ amount_zec: "0.002", tokens: "x", burner }, "invalid_tokens"],
      [{ amount_zec: "0.002", tokens: ts, burner: "notakey" }, "invalid_burner"],
      [{ amount_zec: "0.002", tokens: ts }, "invalid_burner"],
      [{ amount_zec: "0.0025", tokens: ts, burner }, "invalid_amount"],
    ];
    for (const [body, error] of cases) {
      const r = await json(base, "/orders", body);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
      assert.deepEqual(await r.json(), { error });
    }
    assert.equal(spent(), 0);
  }));

test("token orders pay after a random 60-300 s delay, without confirmations", () => {
  let now = Date.parse("2026-10-27T10:00:00Z");
  const book = new OrderBook(openDb(":memory:"), () => now);
  const delays = new Set<number>();
  for (let i = 0; i < 40; i++) {
    const r = book.spendTokens({
      tokenHashes: [`h${i}`],
      spendKey: `k${i}`,
      amountZat: 100_000n,
      burner,
      maxOpen: 1_000,
      quote: () => 7n,
      fits: () => true,
    });
    assert.equal(r.kind, "created");
  }
  const start = now;
  for (let s = 0; s <= 301; s++) {
    now = start + s * 1000;
    const n = book.due().length;
    if (s < 60) assert.equal(n, 0, `nothing due at ${s}s`);
    delays.add(n);
  }
  assert.equal(book.due().length, 40, "all due by 300 s");
  assert.ok(delays.size > 5, "delays are spread out");
});
