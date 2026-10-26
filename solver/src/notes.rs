//! Reads received shielded notes from the wallet's public views and prints one JSON
//! line per note to stdout. A note is printed when first seen with its memo, and
//! again whenever its confirmation count changes, until it reaches the cap. The
//! worker treats lines as idempotent updates keyed by (txid, pool, output_index).

use std::{collections::HashMap, io::Write, path::Path};

use anyhow::Context;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use zcash_protocol::{
    TxId,
    consensus::BlockHeight,
    memo::{Memo, MemoBytes},
};

// Pool codes used by zcash_client_sqlite's v_received_outputs view.
const POOL_ORCHARD: i64 = 3;
const POOL_IRONWOOD: i64 = 4;

#[derive(Serialize)]
struct NoteLine {
    txid: String,
    pool: &'static str,
    output_index: u32,
    /// Zatoshis.
    value: u64,
    memo: Option<String>,
    height: u32,
    confirmations: u32,
}

pub struct Emitter {
    conn: Connection,
    emit_until_confs: u32,
    last: HashMap<(TxId, i64, u32), u32>,
}

impl Emitter {
    pub fn open(db_path: &Path, emit_until_confs: u32) -> anyhow::Result<Self> {
        let conn = Connection::open_with_flags(
            db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        Ok(Self {
            conn,
            emit_until_confs,
            last: HashMap::new(),
        })
    }

    pub fn emit(&mut self, tip: BlockHeight) -> anyhow::Result<()> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT t.txid, r.pool, r.output_index, r.value, r.memo, t.mined_height
             FROM v_received_outputs r
             JOIN transactions t ON t.id_tx = r.transaction_id
             WHERE r.pool IN (?1, ?2)
               AND r.is_change = 0
               AND t.mined_height IS NOT NULL
               AND r.memo IS NOT NULL
             ORDER BY t.mined_height, r.output_index",
        )?;
        let rows = stmt.query_map([POOL_ORCHARD, POOL_IRONWOOD], |row| {
            Ok((
                row.get::<_, Vec<u8>>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, u32>(2)?,
                row.get::<_, u64>(3)?,
                row.get::<_, Vec<u8>>(4)?,
                row.get::<_, u32>(5)?,
            ))
        })?;

        let stdout = std::io::stdout();
        let mut out = stdout.lock();
        for row in rows {
            let (txid, pool, output_index, value, memo, height) = row?;
            let txid = TxId::from_bytes(txid.try_into().ok().context("txid is not 32 bytes")?);
            let confirmations = (u32::from(tip) + 1).saturating_sub(height);

            let key = (txid, pool, output_index);
            if self.last.get(&key) == Some(&confirmations) {
                continue;
            }
            if confirmations > self.emit_until_confs && self.last.contains_key(&key) {
                continue;
            }
            self.last.insert(key, confirmations);
            if confirmations > self.emit_until_confs {
                // Already settled before this process started; nothing to report.
                continue;
            }

            let line = NoteLine {
                txid: txid.to_string(),
                pool: if pool == POOL_IRONWOOD {
                    "ironwood"
                } else {
                    "orchard"
                },
                output_index,
                value,
                memo: memo_text(&memo),
                height,
                confirmations,
            };
            serde_json::to_writer(&mut out, &line)?;
            out.write_all(b"\n")?;
        }
        out.flush()?;
        Ok(())
    }
}

/// Text memos come back as their UTF-8 content; empty or non-text memos as null.
fn memo_text(bytes: &[u8]) -> Option<String> {
    let memo = MemoBytes::from_bytes(bytes).ok()?;
    match Memo::try_from(memo).ok()? {
        Memo::Text(t) => Some(String::from(t)),
        _ => None,
    }
}
