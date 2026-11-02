use serde::{Deserialize, Serialize};

/// 文件条目：仅记录元数据，不读取内容。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    /// 规范化相对路径（`/` 分隔，相对扫描根目录；保留原始名称用于展示）。
    pub rel_path: String,
    pub name: String,
    /// 逻辑大小（字节）。分配大小为后续可选字段，不与此混用。
    pub size: u64,
    /// 修改时间，Unix 秒；读取失败为 None。
    pub modified: Option<i64>,
    /// 小写扩展名（不含点）。
    pub ext: Option<String>,
}

/// 目录条目。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirEntry {
    pub rel_path: String,
    pub name: String,
}

/// 错误类别。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ErrorCategory {
    /// 目录/文件读取失败（无权限、路径中途消失等）。
    ReadFailed,
    /// 元数据读取失败。
    MetadataFailed,
    /// 重解析点/符号链接，按默认策略跳过以避免循环。
    SkippedReparsePoint,
    Other,
}

/// 单条扫描异常。扫描不会因单条异常中断。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanError {
    pub path: String,
    pub category: ErrorCategory,
    pub message: String,
}

/// 一次扫描的完整结果。`cancelled == true` 或 `errors` 非空时，
/// 上层必须将快照标记为不完整。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanOutcome {
    pub root: String,
    pub files: Vec<FileEntry>,
    pub dirs: Vec<DirEntry>,
    pub errors: Vec<ScanError>,
    pub cancelled: bool,
    pub duration_ms: u128,
}

impl ScanOutcome {
    pub fn file_count(&self) -> u64 {
        self.files.len() as u64
    }
    pub fn total_bytes(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }
    pub fn is_complete(&self) -> bool {
        !self.cancelled && self.errors.is_empty()
    }
}

/// 进度快照，由扫描器定期回调。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Progress {
    pub files: u64,
    pub bytes: u64,
    pub errors: u64,
}

/// 目录聚合统计。目录大小一律由文件节点聚合，
/// 不信任遍历过程中的临时累计值。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirStat {
    pub rel_path: String,
    pub name: String,
    pub total_size: u64,
    pub file_count: u64,
    /// 直接子目录数。
    pub subdir_count: u64,
    /// 本目录或其后代存在扫描异常，统计可能不完整。
    pub has_errors: bool,
    /// 各内容类型及其后代的逻辑大小，用于目录类型徽章。
    pub type_sizes: std::collections::BTreeMap<String, u64>,
    pub children: Vec<DirStat>,
}

/// 清理目标的扫描基线。预览与执行传递同一份期望，执行端重新读取并核对。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TargetExpectation {
    pub rel_path: String,
    pub is_dir: bool,
    pub logical_size: u64,
    pub file_count: u64,
    pub modified: Option<i64>,
    /// 目录后代清单的确定性指纹；单文件使用大小、时间与实体身份。
    pub manifest_hash: Option<String>,
    pub file_id: Option<String>,
    /// 原始扫描是否足以支撑安全执行；重解析点或读取异常会令其失败。
    pub complete: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum CleanupAction {
    MoveToTrash,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlannedTarget {
    pub expectation: TargetExpectation,
    pub action: CleanupAction,
}

/// 重复组删除前的最终内容确认。哈希用于变化检测，逐字节比较用于最终判等。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuplicateContentCheck {
    pub anchor: String,
    pub copy: String,
    pub expected_hash: u64,
}

/// 用户确认后的不可变清理计划。执行端不得按名称重新发现或扩大目标。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanupPlan {
    pub scan_id: String,
    pub targets: Vec<PlannedTarget>,
    pub reference_dirs: Vec<String>,
    pub excluded_dirs: Vec<String>,
    pub duplicate_checks: Vec<DuplicateContentCheck>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanupItemResult {
    pub path: String,
    pub status: String,
    pub logical_bytes: u64,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanupExecutionReport {
    pub scan_id: String,
    pub results: Vec<CleanupItemResult>,
    pub succeeded: usize,
    pub skipped: usize,
    pub failed: usize,
    pub selected_logical_bytes: u64,
    pub pending_recycle_bin_bytes: u64,
    /// 回收站动作本身不能证明空间已释放，因此该值保持 None。
    pub verified_freed_bytes: Option<u64>,
}
