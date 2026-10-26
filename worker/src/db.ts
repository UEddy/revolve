import { mkdirSync } from "node:fs";
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
  review_reason TEXT
);
-- Notes already turned into a payout, stored only as a hash so a re-emitted
-- watcher line is ignored without remembering which order it paid.
CREATE TABLE IF NOT EXISTS settled_notes (note_hash TEXT PRIMARY KEY);
-- Notes that match no open order. Kept for manual, offline-signed refunds.
CREATE TABLE IF NOT EXISTS review_notes (
  note_key TEXT PRIMARY KEY,
  value_zat INTEGER NOT NULL,
  reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stats (key TEXT PRIMARY KEY, n INTEGER NOT NULL);
`;

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}
