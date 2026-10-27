import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
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
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS orders_spend_key ON orders (spend_key)");
  const fundCols = db.prepare("PRAGMA table_info(fund_orders)").all() as { name: string }[];
  if (!fundCols.some((c) => c.name === "blinded_hash")) db.exec("ALTER TABLE fund_orders ADD COLUMN blinded_hash TEXT");
  return db;
}
