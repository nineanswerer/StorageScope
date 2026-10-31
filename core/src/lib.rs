//! StorageScope 核心库：目录扫描、聚合统计、清理执行与合成测试数据。
//! 不依赖任何桌面 UI，可独立通过 CLI 与自动化测试验证。

pub mod cleanup;
pub mod diff;
pub mod export;
pub mod fixtures;
pub mod model;
pub mod rules;
pub mod scanner;
pub mod snapshot;
pub mod stats;

pub use model::*;
pub use scanner::{ScanConfig, Scanner};
