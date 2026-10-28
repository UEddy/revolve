import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import { RSABSSA } from "@cloudflare/blindrsa-ts";
import { openDb } from "../src/db.ts";
import { Mint, b64 } from "../src/mint.ts";
import { OrderBook, type NoteLine } from "../src/orders.ts";
import { Bucket, createApi, type ServerDeps } from "../src/server.ts";
import type { CashinRail, Verdict } from "../src/cashin.ts";
import { WITHDRAW_CONFS, WithdrawBook, runWithdrawals, type ZecPayer } from "../src/withdrawals.ts";

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
  opts: { mint?: Mint | null; chains?: ("solana" | "base")[]; cashin?: ServerDeps["cashin"]; withdraw?: (db: ReturnType<typeof openDb>) => ServerDeps["withdraw"] } = {},
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
    chains: opts.chains,
    cashin: opts.cashin,
    withdraw: opts.withdraw?.(db),
    // Rate limits have their own test (hardening.test.ts); these tests make bursts of calls.
    limits: { write: new Bucket(1e9, 1e9), read: new Bucket(1e9, 1e9) },
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

test("fund, confirm, sign once: signatures finalize; a different second set is 409", () =>
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

    const other = await blindTokens(3);
    const again = await json(base, `/mint/orders/${id}/sign`, { blinded: other.blinded });
    assert.equal(again.status, 409);
    assert.deepEqual(await again.json(), { error: "already_minted" });

    assert.equal((await fetch(`${base}/mint/orders/rf_0000000000`)).status, 404);
    assert.equal((await json(base, "/mint/orders/rf_0000000000/sign", { blinded: [] })).status, 404);
  }));

test("sign retry with the identical blinded set returns the same signatures; any other set is 409", () =>
  withMintApi(async ({ base, book, db }) => {
    const id = ((await (await json(base, "/mint/orders", { amount_zec: "0.003" })).json()) as { fund_id: string }).fund_id;
    book.onNote(note(`rv1f|${id}`, 300_000, 3));
    const b = await blindTokens(3);
    const sign = async (blinded: unknown) => {
      const r = await json(base, `/mint/orders/${id}/sign`, { blinded });
      return { status: r.status, body: (await r.json()) as { signatures?: string[]; error?: string } };
    };

    const first = await sign(b.blinded);
    assert.equal(first.status, 200);
    const sigs = first.body.signatures!;

    assert.deepEqual(await sign(b.blinded), first, "identical retry");
    const reordered = await sign([b.blinded[2], b.blinded[0], b.blinded[1]]);
    assert.equal(reordered.status, 200);
    assert.deepEqual(reordered.body.signatures, [sigs[2], sigs[0], sigs[1]], "same set in another order, signatures follow it");
    for (const t of await b.finish(sigs)) assert.ok(await mint.verify(b64(t.msg)!, b64(t.sig)!));

    const other = await blindTokens(1);
    for (const set of [
      [b.blinded[0], b.blinded[1], other.blinded[0]],
      b.blinded.slice(0, 2),
      [...b.blinded, other.blinded[0]],
      [b.blinded[0], b.blinded[0], b.blinded[1]],
      [b.blinded[0], b.blinded[1], "!!"],
      "x",
    ]) {
      assert.deepEqual(await sign(set), { status: 409, body: { error: "already_minted" } }, JSON.stringify(set).slice(0, 60));
    }

    // Only the hash of the set is kept, never the blinded messages.
    const row = db.prepare("SELECT * FROM fund_orders WHERE fund_id = ?").get(id) as Record<string, unknown>;
    assert.equal(row.status, "minted");
    assert.match(row.blinded_hash as string, /^[0-9a-f]{64}$/);
    const stored = JSON.stringify(db.prepare("SELECT * FROM fund_orders").all());
    for (const x of b.blinded) assert.ok(!stored.includes(x) && !stored.includes(b64(x)!.toString("hex")));
  }));

test("concurrent sign calls: identical sets all get the signatures, different sets only one", () =>
  withMintApi(async ({ base, book }) => {
    const fund = async () => {
      const id = ((await (await json(base, "/mint/orders", { amount_zec: "0.002" })).json()) as { fund_id: string }).fund_id;
      book.onNote(note(`rv1f|${id}`, 200_000, 3, Buffer.from(id.padEnd(32, "x")).toString("hex")));
      return id;
    };
    const same = await fund();
    const b = await blindTokens(2);
    const res = await Promise.all([1, 2, 3].map(() => json(base, `/mint/orders/${same}/sign`, { blinded: b.blinded })));
    assert.deepEqual(res.map((r) => r.status), [200, 200, 200]);
    const bodies = await Promise.all(res.map((r) => r.json()));
    assert.deepEqual(bodies[1], bodies[0]);
    assert.deepEqual(bodies[2], bodies[0]);

    const diff = await fund();
    const sets = await Promise.all([1, 2, 3].map(() => blindTokens(2)));
    const codes = (await Promise.all(sets.map((s) => json(base, `/mint/orders/${diff}/sign`, { blinded: s.blinded })))).map(
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
    assert.deepEqual(Object.keys(order).sort(), ["chain", "order_id", "payout_lamports"]);
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

test("DELETE /mint/orders/:id cancels an unpaid funding; 409 once a payment is seen; a late payment goes to review", () =>
  withMintApi(async ({ base, book }) => {
    const create = async () => ((await (await json(base, "/mint/orders", { amount_zec: "0.003" })).json()) as { fund_id: string }).fund_id;
    const del = (id: string) => fetch(`${base}/mint/orders/${id}`, { method: "DELETE" });

    const id = await create();
    assert.equal(book.funds.openCount(), 1);
    assert.equal((await del(id)).status, 204);
    assert.equal(book.funds.openCount(), 0, "no longer counts toward the open cap");
    assert.equal((await fetch(`${base}/mint/orders/${id}`)).status, 404, "record deleted");
    assert.equal((await del(id)).status, 404);
    assert.equal((await del("rf_0000000000")).status, 404);

    book.onNote(note(`rv1f|${id}`, 300_000, 5, "0a".repeat(32)));
    assert.deepEqual(book.reviewNotes().map((n) => n.reason), ["paid_after_cancel"]);

    const seen = await create();
    book.onNote(note(`rv1f|${seen}`, 300_000, 0, "0b".repeat(32)));
    const r = await del(seen);
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { error: "payment_seen" });
    book.onNote(note(`rv1f|${seen}`, 300_000, 3, "0b".repeat(32)));
    assert.equal(book.funds.get(seen)!.status, "funded");
    assert.equal((await del(seen)).status, 409, "funded is past cancelling too");
  }));

test("spend on Base: payout_wei to a checksummed address; bad chain, bad address or no Base wallet spend nothing", async () => {
  const evm = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  await withMintApi(
    async ({ base, spent }) => {
      const ts = await tokens(2);
      for (const [body, code] of [
        [{ chain: "tron", burner: evm }, "invalid_chain"],
        [{ chain: "base", burner }, "invalid_burner"],
        [{ chain: "base", burner: evm.toLowerCase() }, "invalid_burner"],
      ] as const) {
        const r = await json(base, "/orders", { amount_zec: "0.002", tokens: ts, ...body });
        assert.equal(r.status, 400);
        assert.deepEqual(await r.json(), { error: code });
      }
      assert.equal(spent(), 0);
      const ok = await json(base, "/orders", { amount_zec: "0.002", tokens: ts, burner: evm, chain: "base" });
      assert.equal(ok.status, 201);
      const order = (await ok.json()) as Record<string, string>;
      assert.deepEqual(Object.keys(order).sort(), ["chain", "order_id", "payout_wei"]);
      assert.equal(order.chain, "base");
      assert.equal(spent(), 2);
      const retry = await json(base, "/orders", { amount_zec: "0.002", tokens: ts, burner: evm, chain: "base" });
      assert.deepEqual(await retry.json(), order, "an exact retry finds the same order");
    },
    { chains: ["solana", "base"] },
  );
  await withMintApi(async ({ base, spent }) => {
    const r = await json(base, "/orders", { amount_zec: "0.002", tokens: await tokens(2), burner: evm, chain: "base" });
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: "chain_unavailable" });
    assert.equal(spent(), 0);
  });
});

// ---- v1.5: cash out to credits, withdraw to shielded ZEC ----

const HOT = Keypair.generate().publicKey.toBase58();

/** A cash-in rail whose chain is a table of transaction ids and verdicts; it records what it was asked. */
function fakeRail(verdicts: Record<string, Verdict>) {
  const asked: { tx: string; min: bigint; notBefore: number; notAfter: number; fundId: string }[] = [];
  const rail: CashinRail = {
    payTo: HOT,
    perCredit: () => 88_000n,
    normalizeTx: (tx) => (/^[a-z0-9]+$/.test(tx) ? tx : null),
    verify: async (tx, min, notBefore, notAfter, fundId) => {
      asked.push({ tx, min, notBefore, notAfter, fundId });
      return verdicts[tx] ?? "pending";
    },
  };
  return { rail, asked };
}

test("cash-in: quote, a transfer checked on chain, then credits signed like any funding; a transaction funds once", async () => {
  const { rail, asked } = fakeRail({ goodtx: "ok", badtx: "bad", othertx: "ok" });
  await withMintApi(
    async ({ base, book }) => {
      const limits = (await (await fetch(`${base}/limits`)).json()) as { cashin: Record<string, { per_credit: string }> };
      assert.deepEqual(limits.cashin, { solana: { per_credit: "88000" } });

      for (const [body, code] of [
        [{ chain: "solana", credits: 0 }, "invalid_amount"],
        [{ chain: "solana", credits: 51 }, "invalid_amount"],
        [{ chain: "solana", credits: 1.5 }, "invalid_amount"],
        [{ chain: "tron", credits: 3 }, "invalid_chain"],
      ] as const) {
        const r = await json(base, "/cashins", body);
        assert.equal(r.status, 400);
        assert.deepEqual(await r.json(), { error: code });
      }
      const noBase = await json(base, "/cashins", { chain: "base", credits: 3 });
      assert.equal(noBase.status, 503);
      assert.deepEqual(await noBase.json(), { error: "cashin_unavailable" });

      const q = (await (await json(base, "/cashins", { chain: "solana", credits: 3 })).json()) as Record<string, string | number>;
      assert.equal(q.pay_to, HOT);
      assert.equal(q.pay_lamports, "264000");
      assert.equal(q.credits, 3);
      const id = q.fund_id as string;
      const status = async () => ((await (await fetch(`${base}/mint/orders/${id}`)).json()) as { status: string }).status;
      assert.equal(await status(), "awaiting_payment");

      const sent = (tx: string, fund = id) => json(base, `/cashins/${fund}/sent`, { tx });
      assert.equal((await sent("NOT-A-TX")).status, 400);
      const pending = await sent("unseen");
      assert.equal(pending.status, 202);
      assert.deepEqual(await pending.json(), { status: "pending" });
      const bad = await sent("badtx");
      assert.equal(bad.status, 400);
      assert.deepEqual(await bad.json(), { error: "bad_tx" });
      assert.equal(await status(), "awaiting_payment", "nothing minted on a bad or unseen transfer");

      const ok = await sent("goodtx");
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { status: "funded" });
      const expires = Date.parse(q.expires_at as string) / 1000;
      assert.deepEqual(asked.at(-1), { tx: "goodtx", min: 264_000n, notBefore: expires - 900 - 60, notAfter: expires + 600, fundId: id });
      assert.deepEqual(await (await sent("goodtx")).json(), { status: "funded" }, "a repeated report finds it funded");

      const b = await blindTokens(3);
      const signed = await json(base, `/mint/orders/${id}/sign`, { blinded: b.blinded });
      assert.equal(signed.status, 200);
      assert.equal(await status(), "minted");

      const q2 = (await (await json(base, "/cashins", { chain: "solana", credits: 2 })).json()) as { fund_id: string };
      const reused = await sent("goodtx", q2.fund_id);
      assert.equal(reused.status, 409);
      assert.deepEqual(await reused.json(), { error: "tx_used" });
      assert.equal((await sent("othertx", q2.fund_id)).status, 200);

      // A cash-in is never paid with ZEC: such a note goes to review.
      const q3 = (await (await json(base, "/cashins", { chain: "solana", credits: 2 })).json()) as { fund_id: string };
      book.onNote(note(`rv1f|${q3.fund_id}`, 200_000, 5, "0c".repeat(32)));
      assert.deepEqual(book.reviewNotes().map((n) => n.reason), ["wrong_rail"]);
      assert.equal(await status.call(null), "minted");
    },
    { cashin: { solana: rail } },
  );
});

const UA = "u1" + "q".repeat(120);

function fakePayer(spendable: bigint) {
  const sends: { id: string; ua: string; zat: bigint }[] = [];
  let fail = 0;
  let answer = { txid: "ab".repeat(32), confirmations: WITHDRAW_CONFS };
  const payer: ZecPayer & { sends: typeof sends; failNext: (n: number) => void; answer: (txid: string, confirmations: number) => void } = {
    sends,
    failNext: (n) => void (fail = n),
    answer: (txid, confirmations) => void (answer = { txid, confirmations }),
    checkAddress: (ua) => ua === UA,
    cachedSpendable: () => spendable,
    refreshBalance: async () => spendable,
    send: async (id, ua, zat) => {
      sends.push({ id, ua, zat });
      if (fail > 0) {
        fail--;
        throw new Error("lightwalletd unreachable");
      }
      return answer;
    },
  };
  return payer;
}

test("withdrawals: credits spent and queued in one step, exact retry finds it, nothing spent on any refusal", async () => {
  const payer = fakePayer(500_000n);
  await withMintApi(
    async ({ base, spent }) => {
      const ts = await tokens(3);
      const bad = await json(base, "/withdrawals", { tokens: ts, address: "t1dCCf1RHzVnkB6KE8d1bzAQypGNktu8zwh" });
      assert.equal(bad.status, 400);
      assert.deepEqual(await bad.json(), { error: "invalid_address" });
      assert.equal(spent(), 0);

      const ok = await json(base, "/withdrawals", { tokens: ts, address: UA });
      assert.equal(ok.status, 201);
      const w = (await ok.json()) as { withdrawal_id: string; amount_zec: string; status: string };
      assert.match(w.withdrawal_id, /^rw_[0-9a-z]{10}$/);
      assert.deepEqual([w.amount_zec, w.status], ["0.003", "queued"]);
      assert.equal(spent(), 3);
      assert.deepEqual(await (await json(base, "/withdrawals", { tokens: [ts[2], ts[0], ts[1]], address: UA })).json(), w);
      assert.equal(spent(), 3);
      assert.deepEqual(await (await fetch(`${base}/withdrawals/${w.withdrawal_id}`)).json(), { status: "queued" });

      const reuse = await json(base, "/orders", { amount_zec: "0.003", tokens: ts, burner });
      assert.deepEqual(await reuse.json(), { error: "token_spent" }, "withdrawn credits can't be spent again");

      // 0.5 ZEC hot wallet: 0.003 queued, 0.0005 kept for fees, so 0.5 more doesn't fit.
      const big = await json(base, "/withdrawals", { tokens: await tokens(50), address: UA });
      assert.equal(big.status, 503);
      assert.deepEqual(await big.json(), { error: "withdraw_unavailable" });
      assert.equal(spent(), 3);
    },
    { withdraw: (db) => ({ book: new WithdrawBook(db), payer }) },
  );
  await withMintApi(async ({ base }) => {
    const r = await json(base, "/withdrawals", { tokens: await tokens(1), address: UA });
    assert.equal(r.status, 503, "no hot wallet configured");
  });
});

test("withdrawals pay after their random delay, one at a time, forget the address, and retry a failed send with the same id", async () => {
  let now = Date.parse("2026-10-28T10:00:00Z");
  const db = openDb(":memory:");
  const book = new WithdrawBook(db, () => now);
  const payer = fakePayer(10n ** 9n);
  const mk = (key: string, zat: bigint) => book.create({ tokenHashes: [key], spendKey: key, amountZat: zat, address: UA, fits: () => true });
  const a = mk("a", 300_000n);
  const b = mk("b", 200_000n);
  assert.ok(a.kind === "created" && b.kind === "created");

  now += 19 * 60_000;
  await runWithdrawals(book, payer, 10n ** 9n);
  assert.equal(payer.sends.length, 0, "nothing before the 20 minute minimum");

  now += 102 * 60_000;
  payer.failNext(1);
  await runWithdrawals(book, payer, 10n ** 9n);
  assert.equal(payer.sends.length, 1);
  const first = payer.sends[0]!.id;
  assert.equal(book.get(first)!.status, "sending");
  await runWithdrawals(book, payer, 10n ** 9n);
  assert.equal(payer.sends.length, 1, "a failed send waits before retrying");

  now += 5 * 60_000;
  await runWithdrawals(book, payer, 10n ** 9n);
  assert.equal(payer.sends[1]!.id, first, "retried with the same id: the payer re-broadcasts, never pays twice");
  assert.deepEqual(book.get(first), { status: "sent", txid: "ab".repeat(32) });

  await runWithdrawals(book, payer, 10n ** 9n);
  assert.equal(payer.sends.length, 3);
  const left = (db.prepare("SELECT COUNT(*) AS n FROM withdrawals").get() as { n: number }).n;
  assert.equal(left, 0, "no address kept after sending");
  assert.equal(book.withdrawnToday(), 500_000n);

  const c = mk("c", 400_000n);
  assert.ok(c.kind === "created");
  now += 121 * 60_000;
  await runWithdrawals(book, payer, 800_000n);
  assert.equal(payer.sends.length, 3, "waits for the daily cap");
});

test("a withdrawal accepted but not yet mined stays sending, address kept, until its confirmations; others wait behind it", async () => {
  let now = Date.parse("2026-10-28T10:00:00Z");
  const db = openDb(":memory:");
  const book = new WithdrawBook(db, () => now);
  const payer = fakePayer(10n ** 9n);
  const mk = (key: string, zat: bigint) => book.create({ tokenHashes: [key], spendKey: key, amountZat: zat, address: UA, fits: () => true });
  const row = (id: string) => db.prepare("SELECT status, address, txid FROM withdrawals WHERE withdrawal_id = ?").get(id) as { status: string; address: string; txid: string | null } | undefined;
  const a = mk("a", 400_000n);
  assert.ok(a.kind === "created");

  now += 121 * 60_000;
  payer.answer("cd".repeat(32), 0);
  await runWithdrawals(book, payer, 400_000n);
  assert.equal(payer.sends.length, 1);
  assert.deepEqual(book.get(a.id), { status: "sending" }, "accepted is not sent");
  assert.deepEqual({ ...row(a.id) }, { status: "sending", address: UA, txid: "cd".repeat(32) }, "kept, address and all, so it can be re-sent");
  assert.equal(book.withdrawnToday(), 0n);

  const b = mk("b", 100_000n);
  assert.ok(b.kind === "created");
  now += 121 * 60_000;
  // Already paid out once: a lower cap doesn't stop it being followed to its confirmations.
  await runWithdrawals(book, payer, 0n);
  assert.deepEqual(payer.sends.map((x) => x.id), [a.id, a.id], "the unconfirmed one is looked at again; the next waits behind it");

  await runWithdrawals(book, payer, 10n ** 9n);
  assert.equal(payer.sends.length, 2, "not looked at again before its check time");
  now += 91_000;
  // It expired unmined and the payer replaced it: the new transaction is the one followed.
  payer.answer("ef".repeat(32), 0);
  await runWithdrawals(book, payer, 10n ** 9n);
  assert.equal(row(a.id)!.txid, "ef".repeat(32));

  now += 91_000;
  payer.answer("ef".repeat(32), WITHDRAW_CONFS);
  await runWithdrawals(book, payer, 10n ** 9n);
  assert.deepEqual(book.get(a.id), { status: "sent", txid: "ef".repeat(32) });
  assert.equal(row(a.id), undefined, "the address goes once mined");
  assert.equal(book.withdrawnToday(), 400_000n);

  await runWithdrawals(book, payer, 10n ** 9n);
  assert.equal(payer.sends.at(-1)!.id, b.id, "then the next one pays");
});

test("once minted, a funding forgets which Zcash note paid it; a re-emitted line for that note changes nothing", () =>
  withMintApi(async ({ base, book, db }) => {
    const id = ((await (await json(base, "/mint/orders", { amount_zec: "0.002" })).json()) as { fund_id: string }).fund_id;
    const line = note(`rv1f|${id}`, 200_000, 3, "0d".repeat(32));
    book.onNote(line);
    const b = await blindTokens(2);
    assert.equal((await json(base, `/mint/orders/${id}/sign`, { blinded: b.blinded })).status, 200);
    const row = db.prepare("SELECT note_key, status FROM fund_orders WHERE fund_id = ?").get(id) as { note_key: string | null; status: string };
    assert.deepEqual({ ...row }, { note_key: null, status: "minted" });
    assert.equal(JSON.stringify(db.prepare("SELECT * FROM fund_orders").all()).includes("0d0d0d"), false, "no trace of the txid in fundings");
    book.onNote({ ...line, confirmations: 9 });
    assert.deepEqual(book.reviewNotes(), [], "not mistaken for a second payment");
  }));

test("fundings minted before that rule are scrubbed when the database opens", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const dir = mkdtempSync(join(tmpdir(), "rv-db-"));
  try {
    const path = join(dir, "w.sqlite");
    const a = openDb(path);
    a.prepare("INSERT INTO fund_orders (fund_id, amount_zat, expires_at, status, note_key) VALUES ('rf_old0000000', 200000, 0, 'minted', 'tx:orchard:0')").run();
    a.close();
    const b = openDb(path);
    assert.equal((b.prepare("SELECT note_key FROM fund_orders").get() as { note_key: string | null }).note_key, null);
    assert.ok(b.prepare("SELECT 1 FROM settled_notes WHERE note_hash = ?").get(createHash("sha256").update("tx:orchard:0").digest("hex")));
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
