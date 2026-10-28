//! Revolve watcher: a view-only Zcash wallet that follows the solver's Orchard
//! receiver (payments land in Ironwood after NU6.3) and writes one JSON line to
//! stdout per received note. Logs go to stderr.
//!
//! Usage:
//!   revolve-watcher           sync forever, emitting notes
//!   revolve-watcher --once    one sync round, then exit
//!   revolve-watcher address   print the Orchard-only deposit UA
//!   revolve-watcher ufvk      print the Orchard-only UFVK, for the server's env file
//!   revolve-watcher payer-…   the withdrawal hot wallet (see payer.rs)

mod cache;
mod config;
mod notes;
mod payer;

use std::time::Duration;

use anyhow::{Context, anyhow};
use rand::{rand_core::UnwrapErr, rngs::SysRng};
use tonic::{
    Code,
    transport::{Channel, ClientTlsConfig},
};
use tracing::{info, warn};
use zcash_client_backend::{
    data_api::{
        AccountBirthday, AccountPurpose, TransactionDataRequest, TransactionStatus, WalletRead,
        WalletWrite, wallet::decrypt_and_store_transaction,
    },
    keys::{UnifiedAddressRequest, UnifiedFullViewingKey},
    proto::service::{BlockId, TxFilter, compact_tx_streamer_client::CompactTxStreamerClient},
    sync, tor,
    util::SystemClock,
};
use zcash_client_sqlite::{WalletDb, wallet::init::init_wallet_db};
use zcash_primitives::transaction::Transaction;
use zcash_protocol::consensus::{BlockHeight, BranchId, Network};

use crate::{cache::MemCache, config::Config, notes::Emitter};

type Db = WalletDb<rusqlite::Connection, Network, SystemClock, UnwrapErr<SysRng>>;
type Lwd = CompactTxStreamerClient<Channel>;

const ACCOUNT_NAME: &str = "revolve-solver";
const BATCH_SIZE: u32 = 1000;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(cmd) = args.first().filter(|c| c.starts_with("payer-")) {
        return payer::run(cmd, &args[1..]).await;
    }

    let cfg = Config::load()?;
    let arg = std::env::args().nth(1);
    let ufvk = orchard_only_ufvk(&cfg)?;

    if arg.as_deref() == Some("ufvk") {
        let encoded = ufvk
            .encode(&cfg.network)
            .map_err(|e| anyhow!("cannot encode UFVK: {e:?}"))?;
        println!("{encoded}");
        return Ok(());
    }
    if arg.as_deref() == Some("address") {
        let (ua, _) = ufvk
            .default_address(UnifiedAddressRequest::ORCHARD)
            .map_err(|e| anyhow!("address generation failed: {e:?}"))?;
        println!("{}", ua.encode(&cfg.network));
        return Ok(());
    }
    let once = match arg.as_deref() {
        None => false,
        Some("--once") => true,
        Some(other) => return Err(anyhow!("unknown argument {other:?}")),
    };

    std::fs::create_dir_all(&cfg.data_dir)?;
    let db_path = cfg.data_dir.join("wallet.sqlite");
    let mut db: Db = WalletDb::for_path(&db_path, cfg.network, SystemClock, UnwrapErr(SysRng))?;
    init_wallet_db(&mut db, None).map_err(|e| anyhow!("wallet db init failed: {e:?}"))?;

    let tor = if cfg.tor {
        let dir = cfg.data_dir.join("tor");
        std::fs::create_dir_all(&dir)?;
        info!("bootstrapping Tor");
        Some(tor::Client::create(&dir, |_| {}).await?)
    } else {
        None
    };

    let cache = MemCache::default();
    let mut emitter = Emitter::open(&db_path, cfg.emit_until_confs)?;
    let mut client: Option<Lwd> = None;

    loop {
        if client.is_none() {
            match connect(&cfg, tor.as_ref()).await {
                Ok(c) => client = Some(c),
                Err(e) => warn!("lightwalletd connect failed: {e:#}"),
            }
        }
        if let Some(c) = client.as_mut() {
            match round(c, &cfg, &ufvk, &cache, &mut db, &mut emitter).await {
                Ok(()) => {}
                Err(e) if is_broken_pipe(&e) => {
                    // Whoever reads our stdout is gone; there is no one to report to.
                    return Err(e);
                }
                Err(e) => {
                    warn!("sync round failed: {e:#}");
                    // Reconnect next round; a fresh Tor circuit is cheap.
                    client = None;
                }
            }
        }
        if once {
            return Ok(());
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(cfg.poll_secs)) => {}
            _ = tokio::signal::ctrl_c() => return Ok(()),
        }
    }
}

fn is_broken_pipe(e: &anyhow::Error) -> bool {
    use std::io::ErrorKind::BrokenPipe;
    e.chain().any(|c| {
        c.downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == BrokenPipe)
            || c.downcast_ref::<serde_json::Error>()
                .is_some_and(|j| j.io_error_kind() == Some(BrokenPipe))
    })
}

/// Decodes the configured UFVK and drops every component except Orchard, so the
/// wallet never tracks transparent or Sapling receivers.
fn orchard_only_ufvk(cfg: &Config) -> anyhow::Result<UnifiedFullViewingKey> {
    let full = UnifiedFullViewingKey::decode(&cfg.network, &cfg.ufvk)
        .map_err(|e| anyhow!("REVOLVE_UFVK is not a valid UFVK: {e}"))?;
    let orchard = full
        .orchard()
        .cloned()
        .context("REVOLVE_UFVK has no Orchard component")?;
    UnifiedFullViewingKey::from_orchard_fvk(orchard)
        .map_err(|e| anyhow!("cannot build Orchard-only UFVK: {e:?}"))
}

async fn connect(cfg: &Config, tor: Option<&tor::Client>) -> anyhow::Result<Lwd> {
    connect_lwd(&cfg.lightwalletd, tor).await
}

async fn connect_lwd(lightwalletd: &str, tor: Option<&tor::Client>) -> anyhow::Result<Lwd> {
    let uri = lightwalletd.parse()?;
    Ok(match tor {
        Some(tor) => tor.connect_to_lightwalletd(uri, false).await?,
        None => {
            let channel = Channel::builder(uri)
                .tls_config(ClientTlsConfig::new().with_webpki_roots())?
                .connect()
                .await?;
            CompactTxStreamerClient::new(channel)
        }
    })
}

async fn round(
    client: &mut Lwd,
    cfg: &Config,
    ufvk: &UnifiedFullViewingKey,
    cache: &MemCache,
    db: &mut Db,
    emitter: &mut Emitter,
) -> anyhow::Result<()> {
    ensure_account(client, cfg, ufvk, db).await?;
    sync::run(client, &cfg.network, cache, db, BATCH_SIZE)
        .await
        .map_err(|e| anyhow!("sync: {e}"))?;
    enhance(client, &cfg.network, db).await?;
    let tip = db
        .chain_height()?
        .context("wallet has no chain tip after sync")?;
    emitter.emit(tip)
}

/// Imports the Orchard-only UFVK as a view-only account on first run, and refuses
/// to run against a database that was created for a different key.
async fn ensure_account(
    client: &mut Lwd,
    cfg: &Config,
    ufvk: &UnifiedFullViewingKey,
    db: &mut Db,
) -> anyhow::Result<()> {
    let existing = db.get_unified_full_viewing_keys()?;
    if !existing.is_empty() {
        let want = ufvk.encode(&cfg.network);
        if existing.values().any(|k| k.encode(&cfg.network) != want) {
            return Err(anyhow!(
                "wallet db holds a different viewing key; use a new REVOLVE_DATA_DIR"
            ));
        }
        return Ok(());
    }

    let treestate = client
        .get_tree_state(BlockId {
            height: u64::from(cfg.birthday - 1),
            hash: vec![],
        })
        .await?
        .into_inner();
    let birthday = AccountBirthday::from_treestate(treestate, None)
        .map_err(|e| anyhow!("bad treestate for birthday: {e:?}"))?;
    db.import_account_ufvk(
        ACCOUNT_NAME,
        ufvk,
        &birthday,
        AccountPurpose::ViewOnly,
        None,
    )?;
    info!(
        "imported view-only Orchard account, birthday {}",
        cfg.birthday
    );
    Ok(())
}

/// Compact blocks carry no memos. Fetch the full transaction for every note the
/// scanner found, and refresh the status of transactions the wallet asks about.
async fn enhance(client: &mut Lwd, params: &Network, db: &mut Db) -> anyhow::Result<()> {
    for req in db.transaction_data_requests()? {
        let (txid, store) = match req {
            TransactionDataRequest::Enhancement(txid) => (txid, true),
            TransactionDataRequest::GetStatus(txid) => (txid, false),
            #[allow(unreachable_patterns)]
            _ => continue,
        };

        let raw = match client
            .get_transaction(TxFilter {
                block: None,
                index: 0,
                hash: txid.as_ref().to_vec(),
            })
            .await
        {
            Ok(r) => r.into_inner(),
            Err(s) if s.code() == Code::NotFound => {
                db.set_transaction_status(txid, TransactionStatus::TxidNotRecognized)?;
                continue;
            }
            Err(s) => return Err(s.into()),
        };

        // lightwalletd: 0 = mempool, u64::MAX = not in the main chain.
        let mined = match raw.height {
            0 | u64::MAX => None,
            h => Some(BlockHeight::from_u32(u32::try_from(h)?)),
        };

        if store {
            let branch_height = match mined {
                Some(h) => h,
                None => db
                    .chain_height()?
                    .map_or(BlockHeight::from_u32(0), |h| h + 1),
            };
            let tx = Transaction::read(&raw.data[..], BranchId::for_height(params, branch_height))
                .with_context(|| format!("parse tx {txid}"))?;
            decrypt_and_store_transaction(params, db, &tx, mined)?;
        } else {
            let status = mined.map_or(TransactionStatus::NotInMainChain, TransactionStatus::Mined);
            db.set_transaction_status(txid, status)?;
        }
        tracing::debug!("fetched full transaction {txid}");
    }
    Ok(())
}
