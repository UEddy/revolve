// Operator CLI for review items. Runs on the server shell only; there is no HTTP
// route for any of this.
//
//   node src/admin.ts list
//   node src/admin.ts pay-out <note_key> <burner> --order <order_id>
//   node src/admin.ts pay-out <note_key> <burner> --lamports <n>
//
// pay-out binds a review note to a burner, then pays it through the same claim,
// broadcast and reconcile path as the worker, so a crash never pays twice.

import { createInterface } from "node:readline/promises";
import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { OrderBook, REQUIRED_CONFS, isValidBurner, zatToZec } from "./orders.ts";
import { Payer, runPayouts } from "./payout.ts";

const cfg = loadConfig();
const book = new OrderBook(openDb(cfg.dbPath));
const [cmd, ...args] = process.argv.slice(2);

if (cmd === "list") list();
else if (cmd === "pay-out") await payOut(args);
else fail("usage: admin.ts list | pay-out <note_key> <burner> (--order <id> | --lamports <n>)");

function list() {
  const notes = book.reviewNotes();
  console.log(`review notes (${notes.length}):`);
  for (const n of notes) {
    console.log(`  ${n.note_key}  ${zatToZec(BigInt(n.value_zat))} ZEC  ${n.confirmations} confs  ${n.reason}`);
  }
  const orders = book.reviewOrders();
  console.log(`orders in needs_review (${orders.length}):`);
  for (const o of orders) {
    console.log(`  ${o.order_id}  ${zatToZec(BigInt(o.bucket_zat))} ZEC  ${o.chain}  ${o.review_reason}  note=${o.note_key}  burner=${o.burner}`);
  }
  // Fundings carry no burner: they are refunded offline, never minted from here.
  const funds = book.funds.reviewFunds();
  console.log(`fundings in needs_review (${funds.length}):`);
  for (const f of funds) {
    console.log(`  ${f.fund_id}  ${zatToZec(BigInt(f.amount_zat))} ZEC  ${f.review_reason}  note=${f.note_key}`);
  }
}

async function payOut(args: string[]) {
  const [noteKey, burner, flag, value] = args;
  if (!noteKey || !burner || !value || (flag !== "--order" && flag !== "--lamports")) {
    fail("usage: pay-out <note_key> <burner> (--order <id> | --lamports <n>)");
  }
  const note = book.reviewNotes().find((n) => n.note_key === noteKey);
  if (!note) fail(`no review note ${noteKey}`);
  if (!isValidBurner(burner)) fail("burner is not a valid on-curve Solana public key");
  if (note.confirmations < REQUIRED_CONFS) fail(`note has ${note.confirmations} confirmations, needs ${REQUIRED_CONFS}`);

  let lamports: bigint;
  let target: { orderId: string } | { lamports: bigint };
  if (flag === "--order") {
    const q = book.quoteOf(value);
    if (!q) fail(`no order ${value}`);
    if (q.noteKey !== null || (q.status !== "awaiting_payment" && q.status !== "expired")) {
      fail(`order ${value} is ${q.status}${q.noteKey ? " with a note" : ""}; it must be unpaid`);
    }
    // Pay-out here goes through the Solana hot wallet only; Base review items are refunded by hand.
    if (q.chain !== "solana") fail(`order ${value} pays out on ${q.chain}; pay-out handles Solana orders only`);
    if (q.bucketZat !== BigInt(note.value_zat)) {
      fail(`note is ${zatToZec(BigInt(note.value_zat))} ZEC but order ${value} quoted ${zatToZec(q.bucketZat)} ZEC`);
    }
    lamports = q.lamports;
    target = { orderId: value };
  } else {
    if (!/^\d+$/.test(value)) fail("--lamports must be a whole number");
    lamports = BigInt(value);
    target = { lamports };
  }

  console.log("About to pay from the hot wallet:");
  console.log(`  note      ${noteKey}`);
  console.log(`  value     ${zatToZec(BigInt(note.value_zat))} ZEC, ${note.confirmations} confirmations, ${note.reason}`);
  console.log(`  burner    ${burner}`);
  console.log(`  lamports  ${lamports} (${Number(lamports) / 1e9} SOL)${flag === "--order" ? `, quote of ${value}` : ""}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Type "pay" to send: ')).trim();
  rl.close();
  if (answer !== "pay") fail("not confirmed; nothing changed");

  const orderId = book.bindReviewNote(noteKey, burner, target);
  const payer = new Payer(cfg.solanaRpcUrl, cfg.solanaKeypairPath);
  await runPayouts(book, payer, { reserve: cfg.solReserveLamports, dailyCap: cfg.dailyPayoutCapLamports }, orderId);

  const status = book.get(orderId);
  if (status === null) {
    // The record is deleted on payout. The running worker can claim the order
    // before we do; its signature is then served by GET /orders/<id> for a while.
    console.log(`order ${orderId}: paid out by the running worker; signature via GET /orders/${orderId}`);
  } else if (status.status === "paid_out") {
    console.log(`order ${orderId}: paid out, signature ${status.payout_signature}`);
  } else {
    console.log(`order ${orderId}: ${status.status}; the worker will finish or reconcile the payout`);
  }
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}
