import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { isEvmAddress } from "../src/chains.ts";
import { openDb } from "../src/db.ts";
import { runEvmPayouts, type EvmChain } from "../src/evm.ts";
import { OrderBook, type NoteLine } from "../src/orders.ts";
import { Bucket, createApi } from "../src/server.ts";

// A fixed, well-known test key (never funded): its checksummed address is the recipient.
const recipient = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d").address;
const solanaBurner = "11111111111111111111111111111111";

function note(memo: string, value: number, confirmations: number, txid = "aa".repeat(32)): NoteLine {
  return { txid, pool: "ironwood", output_index: 0, value, memo, height: 3_600_000, confirmations };
}

test("EVM recipients: exact EIP-55 form only, never the zero address", () => {
  assert.ok(isEvmAddress(recipient));
  assert.ok(isEvmAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"));
  assert.ok(!isEvmAddress(recipient.toLowerCase()), "all lowercase");
  assert.ok(!isEvmAddress("0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913"), "one letter's case wrong");
  assert.ok(!isEvmAddress("0x0000000000000000000000000000000000000000"));
  assert.ok(!isEvmAddress(solanaBurner));
});

async function withBaseApi(fn: (ctx: { base: string; book: OrderBook }) => Promise<void>, opts: { chains?: ("solana" | "base")[] } = {}) {
  const book = new OrderBook(openDb(":memory:"));
  const server = createApi({
    book,
    appOrigin: "https://app.test",
    depositUa: "u1test",
    quoteTtlSecs: 900,
    maxOpenOrders: 20,
    // 1 zat -> 100 lamports on Solana, 1e10 wei on Base (0.005 ZEC -> 0.005 ETH).
    quote: (zat, chain) => (chain === "solana" ? zat * 100n : zat * 10_000_000_000n),
    usdPerZec: () => "1224.50",
    freeInventory: (chain) => (chain === "solana" ? 1_000_000_000n : 4_500_000_000_000_000n - book.committedLamports("base")),
    chains: opts.chains ?? ["solana", "base"],
    mint: null,
    limits: { write: new Bucket(1e9, 1e9), read: new Bucket(1e9, 1e9) },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, book });
  } finally {
    server.close();
  }
}

const post = (base: string, body: unknown) => fetch(`${base}/orders`, { method: "POST", body: JSON.stringify(body) });

test("Base orders: per-chain limits, payout_wei, chain on the order, its own inventory", () =>
  withBaseApi(async ({ base, book }) => {
    const limits = (await (await fetch(`${base}/limits`)).json()) as { max_zec: string; chains: Record<string, { max_zec: string }> };
    assert.equal(limits.max_zec, "0.1", "top level is still Solana: 1 SOL at 100 lamports per zat");
    assert.equal(limits.chains.base!.max_zec, "0.004", "Base max from Base inventory: 0.0045 ETH");

    const r = await post(base, { amount_zec: "0.003", chain: "base" });
    assert.equal(r.status, 201);
    const o = (await r.json()) as Record<string, string>;
    assert.equal(o.chain, "base");
    assert.equal(o.payout_wei, "3000000000000000");
    assert.equal(o.payout_lamports, undefined);
    assert.deepEqual(await (await fetch(`${base}/orders/${o.order_id}`)).json(), {
      status: "awaiting_payment",
      confirmations: 0,
      payout_signature: null,
      chain: "base",
    });
    assert.equal(book.committedLamports("base"), 3_000_000_000_000_000n);
    assert.equal(book.committedLamports("solana"), 0n, "Solana inventory untouched");
    assert.equal((await post(base, { amount_zec: "0.002", chain: "base" })).status, 409, "only 0.0015 ETH left on Base");
    assert.equal((await post(base, { amount_zec: "0.002" })).status, 201, "Solana still open");

    const bad = await post(base, { amount_zec: "0.003", chain: "tron" });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: "invalid_chain" });
  }));

test("Base is chain_unavailable without a hot wallet, and missing from /limits", () =>
  withBaseApi(
    async ({ base }) => {
      const limits = (await (await fetch(`${base}/limits`)).json()) as { chains: Record<string, unknown> };
      assert.deepEqual(Object.keys(limits.chains), ["solana"]);
      const r = await post(base, { amount_zec: "0.003", chain: "base" });
      assert.equal(r.status, 503);
      assert.deepEqual(await r.json(), { error: "chain_unavailable" });
    },
    { chains: ["solana"] },
  ));

test("Base memos: the 4-field memo pays on Base; a Solana memo or a bad address goes to review", () => {
  const book = new OrderBook(openDb(":memory:"));
  const ok = book.create(300_000n, 3_000_000_000_000_000n, 900, "base");
  book.onNote(note(`rv1|${ok.order_id}|base|${recipient}`, 300_000, 20, "01".repeat(32)));
  assert.deepEqual(book.due("base"), [{ orderId: ok.order_id, burner: recipient, lamports: 3_000_000_000_000_000n }]);
  assert.deepEqual(book.due("solana"), []);

  const solMemo = book.create(300_000n, 1n, 900, "base");
  book.onNote(note(`rv1|${solMemo.order_id}|${solanaBurner}`, 300_000, 5, "02".repeat(32)));
  const lower = book.create(300_000n, 1n, 900, "base");
  book.onNote(note(`rv1|${lower.order_id}|base|${recipient.toLowerCase()}`, 300_000, 5, "03".repeat(32)));
  const onSolana = book.create(300_000n, 1n, 900);
  book.onNote(note(`rv1|${onSolana.order_id}|base|${recipient}`, 300_000, 5, "04".repeat(32)));
  const unknownChain = book.create(300_000n, 1n, 900, "base");
  book.onNote(note(`rv1|${unknownChain.order_id}|tron|${recipient}`, 300_000, 5, "05".repeat(32)));

  const reasons = Object.fromEntries(book.reviewOrders().map((o) => [o.order_id, o.review_reason]));
  assert.deepEqual(reasons, {
    [solMemo.order_id]: "wrong_chain",
    [lower.order_id]: "invalid_burner",
    [onSolana.order_id]: "wrong_chain",
    [unknownChain.order_id]: "wrong_chain",
  });
});

// ---- the payout loop against a simulated chain ----

type Sent = { to: string; wei: bigint; nonce: number };

class FakeBase implements EvmChain {
  readonly address = "0x00000000000000000000000000000000000000Aa";
  balance = 10n ** 18n;
  nonce = 0; // next mined nonce
  signed = 0;
  broadcasts: string[] = [];
  /** hash -> transaction; mined ones have a status. */
  txs = new Map<string, Sent & { status?: "success" | "reverted" }>();
  /** raw -> hash: re-signing the same transfer gives a new hash, as with fresh fees on a real chain. */
  hashOf = new Map<string, string>();
  failBroadcast = false;
  /** When false, broadcasts land in the mempool and stay pending. */
  autoMine = true;
  cachedBalance() {
    return this.balance;
  }
  async refreshBalance() {
    return this.balance;
  }
  async minedNonce() {
    return this.nonce;
  }
  async signTransfer(to: string, wei: bigint, nonce: number) {
    this.signed++;
    const raw = `0x${Buffer.from(JSON.stringify({ to, wei: String(wei), nonce })).toString("hex")}` as `0x${string}`;
    const hash = `0x${String(this.signed).padStart(64, "0")}` as `0x${string}`;
    this.txs.set(hash, { to, wei, nonce });
    const tagged = `${raw}${this.signed.toString(16).padStart(4, "0")}` as `0x${string}`;
    this.hashOf.set(tagged, hash);
    return { raw: tagged, hash, maxGasCost: 21_000n * 1_000_000n };
  }
  async broadcast(raw: `0x${string}`) {
    this.broadcasts.push(raw);
    if (this.failBroadcast) throw new Error("connection reset");
    if (this.autoMine) this.mine(raw);
  }
  /** Mines exactly the transaction these bytes encode, if its nonce is the next one. */
  mine(raw: string, status: "success" | "reverted" = "success") {
    const t = this.txs.get(this.hashOf.get(raw) ?? "");
    if (!t || t.status || t.nonce !== this.nonce) return;
    t.status = status;
    this.nonce++;
    if (status === "success") this.balance -= t.wei;
  }
  async receipt(hash: `0x${string}`) {
    return this.txs.get(hash)?.status ?? null;
  }
}

function dueBaseOrder(book: OrderBook, wei: bigint, txid: string) {
  const o = book.create(300_000n, wei, 900, "base");
  book.onNote(note(`rv1|${o.order_id}|base|${recipient}`, 300_000, 20, txid));
  return o.order_id;
}

const limits = { reserve: 0n, dailyCap: 10n ** 18n, receiptWaitMs: 0 };

test("Base payout: signed, stored before broadcast, paid, then served as a hash with its chain", async () => {
  const book = new OrderBook(openDb(":memory:"));
  const chain = new FakeBase();
  const id = dueBaseOrder(book, 3_000_000_000_000_001n, "01".repeat(32));
  await runEvmPayouts(book, "base", chain, limits);
  assert.equal(chain.signed, 1);
  const got = book.get(id) as { status: string; payout_signature: string; chain: string };
  assert.equal(got.status, "paid_out");
  assert.equal(got.chain, "base");
  assert.match(got.payout_signature, /^0x[0-9a-f]{64}$/);
  assert.equal(book.paidToday("base"), 3_000_001_000_000_000n, "kept in gwei, rounded up");
  assert.equal(book.paidToday("solana"), 0n);
});

test("Base payout, unknown outcome: the same signed transaction is re-broadcast, never a second one", async () => {
  const book = new OrderBook(openDb(":memory:"));
  const chain = new FakeBase();
  const id = dueBaseOrder(book, 1_000n, "01".repeat(32));
  chain.failBroadcast = true;
  await runEvmPayouts(book, "base", chain, limits);
  assert.equal(book.get(id)!.status, "confirmed", "paying is reported as confirmed");
  assert.equal(book.inFlightEvm("base").length, 1);

  chain.failBroadcast = false;
  chain.autoMine = false;
  await runEvmPayouts(book, "base", chain, limits);
  assert.equal(chain.signed, 1, "no new transaction signed");
  assert.equal(chain.broadcasts.length, 2);
  assert.equal(chain.broadcasts[1], chain.broadcasts[0], "the identical raw transaction");

  chain.mine(chain.broadcasts[1]!);
  await runEvmPayouts(book, "base", chain, limits);
  assert.equal(book.get(id)!.status, "paid_out");
  assert.equal(chain.signed, 1);
});

test("Base payouts: one in flight at a time", async () => {
  const book = new OrderBook(openDb(":memory:"));
  const chain = new FakeBase();
  chain.autoMine = false;
  const a = dueBaseOrder(book, 1_000n, "01".repeat(32));
  const b = dueBaseOrder(book, 2_000n, "02".repeat(32));
  await runEvmPayouts(book, "base", chain, limits);
  await runEvmPayouts(book, "base", chain, limits);
  assert.equal(chain.signed, 1, "the second waits for the first");
  chain.mine(chain.broadcasts[0]!);
  chain.autoMine = true;
  await runEvmPayouts(book, "base", chain, limits);
  assert.equal(book.get(a)!.status, "paid_out");
  assert.equal(book.get(b)!.status, "paid_out");
  assert.deepEqual([...chain.txs.values()].map((t) => t.nonce), [0, 1]);
});

test("Base payout: reverted means nothing moved, so it pays again with the next nonce", async () => {
  const book = new OrderBook(openDb(":memory:"));
  const chain = new FakeBase();
  chain.autoMine = false;
  const id = dueBaseOrder(book, 1_000n, "01".repeat(32));
  await runEvmPayouts(book, "base", chain, limits);
  chain.mine(chain.broadcasts[0]!, "reverted");
  chain.autoMine = true;
  await runEvmPayouts(book, "base", chain, limits);
  assert.equal(book.get(id)!.status, "paid_out");
  assert.deepEqual([...chain.txs.values()].map((t) => [t.nonce, t.status]), [[0, "reverted"], [1, "success"]]);
});

test("Base payout: a different transaction at its nonce sends the order to review, never pays again", async () => {
  const book = new OrderBook(openDb(":memory:"));
  const chain = new FakeBase();
  chain.autoMine = false;
  const id = dueBaseOrder(book, 1_000n, "01".repeat(32));
  await runEvmPayouts(book, "base", chain, limits);
  chain.nonce = 1; // someone else used nonce 0
  chain.autoMine = true;
  await runEvmPayouts(book, "base", chain, limits);
  assert.equal(book.get(id)!.status, "needs_review");
  assert.equal(book.reviewOrders()[0]!.review_reason, "nonce_reused");
  assert.equal(chain.signed, 1);
});

test("Base payout waits for the daily cap and for balance plus gas plus reserve", async () => {
  const book = new OrderBook(openDb(":memory:"));
  const chain = new FakeBase();
  const id = dueBaseOrder(book, 5_000n, "01".repeat(32));
  await runEvmPayouts(book, "base", chain, { ...limits, dailyCap: 4_999n });
  assert.equal(book.get(id)!.status, "confirmed");
  chain.balance = 5_000n + 21_000n * 1_000_000n; // one short of payout + gas + reserve 1
  await runEvmPayouts(book, "base", chain, { ...limits, reserve: 1n });
  assert.equal(book.get(id)!.status, "confirmed");
  assert.equal(book.inFlightEvm("base").length, 0, "nothing claimed while waiting");
  await runEvmPayouts(book, "base", chain, limits);
  assert.equal(book.get(id)!.status, "paid_out");
});
