import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// Orders hold no IP, user agent or creation time; expiry is the only timestamp.
// A row (and with it the order -> burner link) is deleted once paid out.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  bucket_zat INTEGER NOT NULL,
  payout_lamports TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  burner TEXT,
  note_key TEXT UNIQUE,
  confirmations INTEGER NOT NULL DEFAULT 0,
  pay_at_confs INTEGER,
  payout_signature TEXT,
  payout_valid_until INTEGER,
  review_reason TEXT,
  pay_after INTEGER,
  spend_key TEXT
);
-- Notes already turned into a payout, stored only as a hash so a re-emitted
-- watcher line is ignored without remembering which order it paid.
CREATE TABLE IF NOT EXISTS settled_notes (note_hash TEXT PRIMARY KEY);
-- Notes that match no open order. Kept for manual, offline-signed refunds.
CREATE TABLE IF NOT EXISTS review_notes (
  note_key TEXT PRIMARY KEY,
  value_zat INTEGER NOT NULL,
  reason TEXT NOT NULL,
  confirmations INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS stats (key TEXT PRIMARY KEY, n INTEGER NOT NULL);
-- Credit fundings (CREDITS_CONTRACT.md). Never holds blinded messages, only the
-- SHA-256 of the signed set so an identical retry of /sign gets its signatures.
CREATE TABLE IF NOT EXISTS fund_orders (
  fund_id TEXT PRIMARY KEY,
  amount_zat INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  note_key TEXT UNIQUE,
  confirmations INTEGER NOT NULL DEFAULT 0,
  review_reason TEXT,
  blinded_hash TEXT
);
-- SHA-256 of every spent token message, kept forever against double spends.
CREATE TABLE IF NOT EXISTS spent_tokens (token_hash TEXT PRIMARY KEY);
-- SHA-256 of every transaction a cash-in was funded with, so none funds twice.
CREATE TABLE IF NOT EXISTS used_cashin_txs (tx_hash TEXT PRIMARY KEY);
-- Credit withdrawals to shielded ZEC (v1.5). The address goes with the row once mined.
CREATE TABLE IF NOT EXISTS withdrawals (
  withdrawal_id TEXT PRIMARY KEY,
  amount_zat INTEGER NOT NULL,
  address TEXT NOT NULL,
  pay_after INTEGER NOT NULL,
  status TEXT NOT NULL,
  spend_key TEXT UNIQUE NOT NULL
);
-- SHA-256 of cancelled order and funding ids, so a payment that still arrives
-- for one is held for review as paid_after_cancel. Nothing else is kept.
CREATE TABLE IF NOT EXISTS cancelled_ids (id_hash TEXT PRIMARY KEY);
-- Wallets Revolve paid out to (v1.5): a hash of chain and address, what Revolve
-- paid in and what came back as cash-ins, in lamports or wei. Both amounts are
-- public on chain already; no order, note or Zcash detail is kept with them.
CREATE TABLE IF NOT EXISTS funded_wallets (wallet_hash TEXT PRIMARY KEY, paid_in TEXT NOT NULL, returned TEXT NOT NULL DEFAULT '0');
`;

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  // Owner only, whatever the umask: the database and its WAL files hold note hashes and open orders.
  if (path !== ":memory:") for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
  // The worker and the admin CLI share this file; wait for each other's writes.
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  const reviewCols = db.prepare("PRAGMA table_info(review_notes)").all() as { name: string }[];
  if (!reviewCols.some((c) => c.name === "confirmations")) {
    db.exec("ALTER TABLE review_notes ADD COLUMN confirmations INTEGER NOT NULL DEFAULT 0");
  }
  // Token orders (v1.3): a payout time instead of confirmations, and the hash of
  // the spending request so an exact retry finds its order. Both go with the row.
  const orderCols = db.prepare("PRAGMA table_info(orders)").all() as { name: string }[];
  if (!orderCols.some((c) => c.name === "pay_after")) db.exec("ALTER TABLE orders ADD COLUMN pay_after INTEGER");
  if (!orderCols.some((c) => c.name === "spend_key")) db.exec("ALTER TABLE orders ADD COLUMN spend_key TEXT");
  // Payout chains (v1.4): NULL means Solana. On EVM chains payout_lamports holds
  // wei, and an in-flight payout keeps its signed raw transaction and nonce so an
  // unknown outcome is resolved by re-broadcasting that same transaction.
  if (!orderCols.some((c) => c.name === "chain")) db.exec("ALTER TABLE orders ADD COLUMN chain TEXT");
  if (!orderCols.some((c) => c.name === "payout_raw")) db.exec("ALTER TABLE orders ADD COLUMN payout_raw TEXT");
  if (!orderCols.some((c) => c.name === "payout_nonce")) db.exec("ALTER TABLE orders ADD COLUMN payout_nonce INTEGER");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS orders_spend_key ON orders (spend_key)");
  const fundCols = db.prepare("PRAGMA table_info(fund_orders)").all() as { name: string }[];
  if (!fundCols.some((c) => c.name === "blinded_hash")) db.exec("ALTER TABLE fund_orders ADD COLUMN blinded_hash TEXT");
  // Cash-ins (v1.5): a funding paid in SOL or ETH instead of a ZEC note. `source`
  // NULL means a ZEC funding; `pay_amount` is the quoted lamports or wei.
  if (!fundCols.some((c) => c.name === "source")) db.exec("ALTER TABLE fund_orders ADD COLUMN source TEXT");
  if (!fundCols.some((c) => c.name === "pay_amount")) db.exec("ALTER TABLE fund_orders ADD COLUMN pay_amount TEXT");
  // A withdrawal waits for its transaction to be mined before it is deleted; this is the one it waits on.
  const withdrawCols = db.prepare("PRAGMA table_info(withdrawals)").all() as { name: string }[];
  if (!withdrawCols.some((c) => c.name === "txid")) db.exec("ALTER TABLE withdrawals ADD COLUMN txid TEXT");
  // Fundings minted before minting forgot their note: forget it now, keeping only its hash.
  const minted = db.prepare("SELECT fund_id, note_key FROM fund_orders WHERE status = 'minted' AND note_key IS NOT NULL").all() as { fund_id: string; note_key: string }[];
  for (const m of minted) {
    db.prepare("INSERT OR IGNORE INTO settled_notes VALUES (?)").run(createHash("sha256").update(m.note_key).digest("hex"));
    db.prepare("UPDATE fund_orders SET note_key = NULL WHERE fund_id = ?").run(m.fund_id);
  }
  return db;
}
