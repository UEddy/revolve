//! The withdrawal hot wallet (CREDITS_CONTRACT.md v1.5). A spending wallet with
//! its own seed, separate from the deposit address (whose spending key never
//! reaches the server), holding only what an operator moves into it.
//!
//!   revolve-watcher payer-keygen <seed file>       new random seed, mode 600, never overwritten
//!   revolve-watcher payer-address                  its Orchard-only address, to fund it
//!   revolve-watcher payer-balance                  sync, then {"spendable_zat":..,"total_zat":..}
//!   revolve-watcher payer-send <id> <ua> <zat>     sync, pay, then {"txid":".."}
//!   revolve-watcher payer-check-address <ua>       exit 0 if it is a valid withdrawal address (no network)
//!
//! `payer-send` is idempotent per withdrawal id: the signed transaction is stored
//! under the id before it is broadcast, and a retry re-broadcasts those same bytes,
//! which can never pay twice (the notes it spends can only be spent once).

use std::{env, io::Write, os::unix::fs::OpenOptionsExt, path::PathBuf};

use anyhow::{Context, anyhow, bail};
use rand::{
    rand_core::{TryRng, UnwrapErr},
    rngs::SysRng,
};
use secrecy::SecretVec;
use tracing::info;
use zcash_client_backend::{
    data_api::{
        AccountBirthday, WalletRead, WalletWrite,
        wallet::{
            ConfirmationsPolicy, SpendingKeys, create_proposed_transactions,
            propose_standard_transfer_to_address,
        },
    },
    fees::StandardFeeRule,
    keys::{UnifiedAddressRequest, UnifiedSpendingKey},
    proto::service::{BlockId, RawTransaction},
    sync,
    util::SystemClock,
    wallet::OvkPolicy,
};
use zcash_client_sqlite::{WalletDb, wallet::init::init_wallet_db};
use zcash_keys::address::{Address, UnifiedAddress};
use zcash_proofs::prover::LocalTxProver;
use zcash_protocol::{ShieldedPool, consensus::Network, value::Zatoshis};

use crate::{Db, Lwd, cache::MemCache, connect_lwd, enhance};

const ACCOUNT_NAME: &str = "revolve-payer";
const BATCH_SIZE: u32 = 1000;

struct PayerConfig {
    seed_path: PathBuf,
    birthday: u32,
    network: Network,
    lightwalletd: String,
    tor: bool,
    data_dir: PathBuf,
}

impl PayerConfig {
    fn load() -> anyhow::Result<Self> {
        let env_file = env::var("REVOLVE_ENV_FILE").unwrap_or_else(|_| ".env".into());
        let _ = dotenvy::from_path(&env_file);
        let var = |k: &str, d: &str| env::var(k).unwrap_or_else(|_| d.into());
        Ok(Self {
            seed_path: env::var("REVOLVE_PAYER_SEED_PATH").context("REVOLVE_PAYER_SEED_PATH is not set")?.into(),
            birthday: env::var("REVOLVE_PAYER_BIRTHDAY")
                .context("REVOLVE_PAYER_BIRTHDAY is not set")?
                .parse()
                .context("REVOLVE_PAYER_BIRTHDAY must be a block height")?,
            network: match var("REVOLVE_NETWORK", "main").as_str() {
                "main" => Network::MainNetwork,
                "test" => Network::TestNetwork,
                other => bail!("REVOLVE_NETWORK must be main or test, got {other}"),
            },
            lightwalletd: var("REVOLVE_LIGHTWALLETD", "https://eu.zec.rocks:443"),
            tor: var("REVOLVE_TOR", "1") == "1",
            data_dir: var("REVOLVE_PAYER_DATA_DIR", "./payer-data").into(),
        })
    }

    fn seed(&self) -> anyhow::Result<SecretVec<u8>> {
        let text = std::fs::read_to_string(&self.seed_path).with_context(|| format!("read {}", self.seed_path.display()))?;
        let bytes = hex::decode(text.trim()).context("seed file must hold hex")?;
        if bytes.len() != 32 {
            bail!("seed must be 32 bytes");
        }
        Ok(SecretVec::new(bytes))
    }

    fn usk(&self) -> anyhow::Result<UnifiedSpendingKey> {
        use secrecy::ExposeSecret;
        let seed = self.seed()?;
        UnifiedSpendingKey::from_seed(&self.network, seed.expose_secret(), zip32::AccountId::ZERO)
            .map_err(|e| anyhow!("key derivation failed: {e:?}"))
    }
}

pub async fn run(cmd: &str, args: &[String]) -> anyhow::Result<()> {
    if cmd == "payer-keygen" {
        let path = args.first().context("usage: payer-keygen <seed file>")?;
        return keygen(path);
    }
    if cmd == "payer-check-address" {
        let network = match env::var("REVOLVE_NETWORK").as_deref() {
            Ok("test") => Network::TestNetwork,
            _ => Network::MainNetwork,
        };
        orchard_recipient(&network, args.first().context("usage: payer-check-address <ua>")?)?;
        return Ok(());
    }
    let cfg = PayerConfig::load()?;
    match cmd {
        "payer-address" => {
            let ua = orchard_address(&cfg.usk()?)?;
            println!("{}", ua.encode(&cfg.network));
            Ok(())
        }
        "payer-balance" => {
            let (db, _client) = open_synced(&cfg).await?;
            let summary = db
                .get_wallet_summary(ConfirmationsPolicy::default())?
                .context("wallet not synced yet")?;
            let (spendable, total) = summary
                .account_balances()
                .values()
                .fold((0u64, 0u64), |(s, t), b| (s + u64::from(b.spendable_value()), t + u64::from(b.total())));
            println!("{}", serde_json::json!({ "spendable_zat": spendable, "total_zat": total }));
            Ok(())
        }
        "payer-send" => {
            let [id, ua, zat] = args else { bail!("usage: payer-send <withdrawal id> <unified address> <zatoshis>") };
            let txid = send(&cfg, id, ua, zat.parse().context("amount must be zatoshis")?).await?;
            println!("{}", serde_json::json!({ "txid": txid }));
            Ok(())
        }
        other => bail!("unknown payer command {other:?}"),
    }
}

fn keygen(path: &str) -> anyhow::Result<()> {
    let mut seed = [0u8; 32];
    SysRng.try_fill_bytes(&mut seed).map_err(|e| anyhow!("rng: {e:?}"))?;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .with_context(|| format!("{path} exists or can't be created; refusing to overwrite a hot wallet seed"))?;
    writeln!(f, "{}", hex::encode(seed))?;
    seed.fill(0);
    println!("wrote the withdrawal hot wallet seed to {path} (mode 600); fund it at the address `payer-address` prints");
    Ok(())
}

/// The hot wallet's own address, Orchard receiver only.
fn orchard_address(usk: &UnifiedSpendingKey) -> anyhow::Result<UnifiedAddress> {
    let (ua, _) = usk
        .to_unified_full_viewing_key()
        .default_address(UnifiedAddressRequest::ORCHARD)
        .map_err(|e| anyhow!("address generation failed: {e:?}"))?;
    Ok(ua)
}

/// A withdrawal recipient: a unified address with an Orchard receiver, reduced to
/// that receiver alone so the payment can only ever be shielded.
pub fn orchard_recipient(network: &Network, s: &str) -> anyhow::Result<Address> {
    match Address::decode(network, s) {
        Some(Address::Unified(ua)) => {
            let orchard = *ua.orchard().context("the address has no Orchard receiver")?;
            let only = UnifiedAddress::from_receivers(Some(orchard), None, None, None, None)
                .context("cannot build an Orchard-only address")?;
            Ok(Address::Unified(Box::new(only)))
        }
        Some(_) => bail!("only unified addresses with an Orchard receiver are accepted"),
        None => bail!("not a valid Zcash address for this network"),
    }
}

async fn open_synced(cfg: &PayerConfig) -> anyhow::Result<(Db, Lwd)> {
    std::fs::create_dir_all(&cfg.data_dir)?;
    let db_path = cfg.data_dir.join("wallet.sqlite");
    let mut db: Db = WalletDb::for_path(&db_path, cfg.network, SystemClock, UnwrapErr(SysRng))?;
    init_wallet_db(&mut db, None).map_err(|e| anyhow!("wallet db init failed: {e:?}"))?;
    let tor = if cfg.tor {
        let dir = cfg.data_dir.join("tor");
        std::fs::create_dir_all(&dir)?;
        Some(zcash_client_backend::tor::Client::create(&dir, |_| {}).await?)
    } else {
        None
    };
    let mut client = connect_lwd(&cfg.lightwalletd, tor.as_ref()).await?;

    if db.get_account_ids()?.is_empty() {
        let treestate = client
            .get_tree_state(BlockId { height: u64::from(cfg.birthday - 1), hash: vec![] })
            .await?
            .into_inner();
        let birthday = AccountBirthday::from_treestate(treestate, None).map_err(|e| anyhow!("bad treestate: {e:?}"))?;
        db.import_account_hd(ACCOUNT_NAME, &cfg.seed()?, zip32::AccountId::ZERO, &birthday, None)?;
        info!("imported the withdrawal hot wallet, birthday {}", cfg.birthday);
    }
    let cache = MemCache::default();
    sync::run(&mut client, &cfg.network, &cache, &mut db, BATCH_SIZE)
        .await
        .map_err(|e| anyhow!("sync: {e}"))?;
    enhance(&mut client, &cfg.network, &mut db).await?;
    Ok((db, client))
}

/// The record of signed withdrawals, kept beside the wallet: id -> txid and raw bytes.
fn sends_db(cfg: &PayerConfig) -> anyhow::Result<rusqlite::Connection> {
    std::fs::create_dir_all(&cfg.data_dir)?;
    let c = rusqlite::Connection::open(cfg.data_dir.join("sends.sqlite"))?;
    c.execute_batch("CREATE TABLE IF NOT EXISTS sends (id TEXT PRIMARY KEY, txid TEXT NOT NULL, raw BLOB NOT NULL)")?;
    Ok(c)
}

async fn broadcast(client: &mut Lwd, raw: Vec<u8>) -> anyhow::Result<()> {
    let r = client.send_transaction(RawTransaction { data: raw, height: 0 }).await?.into_inner();
    // An already-known transaction is the expected answer to a re-broadcast.
    if r.error_code != 0 && !r.error_message.to_lowercase().contains("already") {
        bail!("lightwalletd refused the transaction ({}): {}", r.error_code, r.error_message);
    }
    Ok(())
}

async fn send(cfg: &PayerConfig, id: &str, ua: &str, zat: u64) -> anyhow::Result<String> {
    if !id.starts_with("rw_") || id.len() > 64 {
        bail!("bad withdrawal id");
    }
    let to = orchard_recipient(&cfg.network, ua)?;
    let amount = Zatoshis::from_u64(zat).map_err(|_| anyhow!("bad amount"))?;
    let sends = sends_db(cfg)?;
    let prior: Option<(String, Vec<u8>)> = sends
        .query_row("SELECT txid, raw FROM sends WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
        .ok();

    let (mut db, mut client) = open_synced(cfg).await?;
    if let Some((txid, raw)) = prior {
        info!("withdrawal {id} was signed before; re-broadcasting {txid}");
        broadcast(&mut client, raw).await?;
        return Ok(txid);
    }

    let usk = cfg.usk()?;
    let account = db
        .get_account_for_ufvk(&usk.to_unified_full_viewing_key())?
        .context("the wallet db holds a different seed; use a new REVOLVE_PAYER_DATA_DIR")?;
    let proposal = propose_standard_transfer_to_address::<_, _, std::convert::Infallible>(
        &mut db,
        &cfg.network,
        StandardFeeRule::Zip317,
        zcash_client_backend::data_api::Account::id(&account),
        ConfirmationsPolicy::default(),
        &to,
        amount,
        None,
        None,
        ShieldedPool::Orchard,
        None,
        None,
    )
    .map_err(|e| anyhow!("can't pay this now: {e}"))?;
    let prover = LocalTxProver::bundled();
    let txids = create_proposed_transactions::<_, _, std::convert::Infallible, _, std::convert::Infallible, _>(
        &mut db,
        &cfg.network,
        &SystemClock,
        &mut UnwrapErr(SysRng),
        &prover,
        &prover,
        &SpendingKeys::from_unified_spending_key(usk),
        // Withdrawals stay unreadable to the hot wallet's own keys: a leaked seed can't list who was paid.
        OvkPolicy::Discard,
        &proposal,
        None,
    )
    .map_err(|e| anyhow!("building the transaction failed: {e}"))?;
    if txids.len() != 1 {
        bail!("expected one transaction, the proposal made {}", txids.len());
    }
    let txid = *txids.first();
    let tx = db.get_transaction(txid)?.context("the new transaction is missing from the wallet")?;
    let mut raw = Vec::new();
    tx.write(&mut raw)?;
    sends.execute("INSERT INTO sends (id, txid, raw) VALUES (?1, ?2, ?3)", rusqlite::params![id, txid.to_string(), raw])?;
    broadcast(&mut client, raw).await?;
    Ok(txid.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recipients_must_carry_an_orchard_receiver() {
        let n = Network::MainNetwork;
        assert!(orchard_recipient(&n, "t1dCCf1RHzVnkB6KE8d1bzAQypGNktu8zwh").is_err(), "transparent refused");
        assert!(orchard_recipient(&n, "not an address").is_err());
        let usk = UnifiedSpendingKey::from_seed(&n, &[7u8; 32], zip32::AccountId::ZERO).unwrap();
        let ua = orchard_address(&usk).unwrap().encode(&n);
        match orchard_recipient(&n, &ua).unwrap() {
            Address::Unified(u) => {
                assert!(u.orchard().is_some());
                assert!(u.transparent().is_none());
            }
            _ => panic!("expected a unified address"),
        }
    }
}
