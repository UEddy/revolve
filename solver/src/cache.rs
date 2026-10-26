//! In-memory compact block cache. The watcher scans each batch right after
//! downloading it, so nothing here needs to survive a restart.

use std::{collections::BTreeMap, convert::Infallible, sync::Mutex};

use async_trait::async_trait;
use zcash_client_backend::{
    data_api::{
        chain::{BlockCache, BlockSource, error::Error as ChainError},
        scanning::ScanRange,
    },
    proto::compact_formats::CompactBlock,
};
use zcash_protocol::consensus::BlockHeight;

#[derive(Default)]
pub struct MemCache(Mutex<BTreeMap<BlockHeight, CompactBlock>>);

impl BlockSource for MemCache {
    type Error = Infallible;

    fn with_blocks<F, WalletErrT>(
        &self,
        from_height: Option<BlockHeight>,
        limit: Option<usize>,
        mut with_block: F,
    ) -> Result<(), ChainError<WalletErrT, Self::Error>>
    where
        F: FnMut(CompactBlock) -> Result<(), ChainError<WalletErrT, Self::Error>>,
    {
        let blocks: Vec<CompactBlock> = {
            let map = self.0.lock().unwrap();
            let start = from_height.unwrap_or(BlockHeight::from_u32(0));
            map.range(start..)
                .take(limit.unwrap_or(usize::MAX))
                .map(|(_, b)| b.clone())
                .collect()
        };
        blocks.into_iter().try_for_each(&mut with_block)
    }
}

#[async_trait]
impl BlockCache for MemCache {
    fn get_tip_height(&self, range: Option<&ScanRange>) -> Result<Option<BlockHeight>, Infallible> {
        let map = self.0.lock().unwrap();
        Ok(match range {
            Some(r) => map.range(r.block_range().clone()).next_back(),
            None => map.iter().next_back(),
        }
        .map(|(h, _)| *h))
    }

    async fn read(&self, range: &ScanRange) -> Result<Vec<CompactBlock>, Infallible> {
        let map = self.0.lock().unwrap();
        Ok(map
            .range(range.block_range().clone())
            .map(|(_, b)| b.clone())
            .collect())
    }

    async fn insert(&self, compact_blocks: Vec<CompactBlock>) -> Result<(), Infallible> {
        let mut map = self.0.lock().unwrap();
        for block in compact_blocks {
            map.insert(block.height(), block);
        }
        Ok(())
    }

    async fn delete(&self, range: ScanRange) -> Result<(), Infallible> {
        let mut map = self.0.lock().unwrap();
        map.retain(|h, _| !range.block_range().contains(h));
        Ok(())
    }
}
