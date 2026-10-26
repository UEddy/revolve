use std::{env, path::PathBuf};

use anyhow::{Context, anyhow};
use zcash_protocol::consensus::Network;

/// Runtime configuration, read from the process environment after loading the
/// gitignored env file (`REVOLVE_ENV_FILE`, default `.env`).
pub struct Config {
    /// Full UFVK as exported by the solver wallet. Only its Orchard component is used.
    pub ufvk: String,
    pub birthday: u32,
    pub network: Network,
    pub lightwalletd: String,
    pub tor: bool,
    pub data_dir: PathBuf,
    pub poll_secs: u64,
    pub emit_until_confs: u32,
}

impl Config {
    pub fn load() -> anyhow::Result<Self> {
        let env_file = env::var("REVOLVE_ENV_FILE").unwrap_or_else(|_| ".env".into());
        // A missing file is fine: values may come from the real environment instead.
        let _ = dotenvy::from_path(&env_file);

        let network = match var_or("REVOLVE_NETWORK", "main").as_str() {
            "main" => Network::MainNetwork,
            "test" => Network::TestNetwork,
            other => return Err(anyhow!("REVOLVE_NETWORK must be main or test, got {other}")),
        };

        Ok(Self {
            ufvk: env::var("REVOLVE_UFVK").context("REVOLVE_UFVK is not set")?,
            birthday: env::var("REVOLVE_BIRTHDAY")
                .context("REVOLVE_BIRTHDAY is not set")?
                .parse()
                .context("REVOLVE_BIRTHDAY must be a block height")?,
            network,
            lightwalletd: var_or("REVOLVE_LIGHTWALLETD", "https://eu.zec.rocks:443"),
            tor: var_or("REVOLVE_TOR", "1") == "1",
            data_dir: var_or("REVOLVE_DATA_DIR", "./data").into(),
            poll_secs: var_or("REVOLVE_POLL_SECS", "30").parse()?,
            emit_until_confs: var_or("REVOLVE_EMIT_UNTIL_CONFS", "12").parse()?,
        })
    }
}

fn var_or(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.into())
}
