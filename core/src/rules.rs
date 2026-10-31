//! 规则引擎（M3）：在扫描结果之上识别缓存/可清理项、大文件与重复文件。
//!
//! 原则：只读分析、只出建议——任何删除动作都由用户自己决定。
//! 重复文件判定必须基于内容哈希（xxHash64），不得只看文件名或大小。

use crate::model::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

/// 建议的安全等级。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Safety {
    /// 可安全清理：程序可再生的缓存、日志、崩溃报告、临时文件。
    SafeToDelete,
    /// 建议人工确认后再清理（如 node_modules、backups）。
    ReviewAdvised,
}

/// 内置规则命中项（目录级）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleHit {
    pub rule_id: String,
    pub rule_name: String,
    pub rel_path: String,
    pub size: u64,
    pub file_count: u64,
    pub reason: String,
    pub safety: Safety,
}

/// 重复文件组：内容完全相同的一组文件。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DupeGroup {
    pub size: u64,
    pub hash: u64,
    /// 相对路径列表（第一份保留，其余为冗余）。
    pub files: Vec<String>,
    /// 可回收空间 = size × (份数 - 1)。
    pub wasted: u64,
}

/// 完整分析报告。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisReport {
    pub cache_hits: Vec<RuleHit>,
    pub big_files: Vec<FileEntry>,
    pub dupe_groups: Vec<DupeGroup>,
    /// 估算可回收字节：安全级缓存命中 + 重复文件冗余。
    /// 两类命中可能重叠（重复文件落在缓存目录里），故仅为估算上限。
    pub reclaimable_bytes: u64,
    /// 哈希阶段实际读取的字节数（性能观测用）。
    pub hashed_bytes: u64,
    /// 哈希阶段读取失败的文件数。
    pub hash_errors: u64,
}

// ---------------------------------------------------------------------------
// 内置缓存/可清理规则：按目录名匹配（大小写不敏感、精确匹配）。
// 命中目录的整棵子树计入，不再向下重复匹配。
// ---------------------------------------------------------------------------

struct CacheRule {
    id: &'static str,
    name: &'static str,
    dir_names: &'static [&'static str],
    reason: &'static str,
    safety: Safety,
}

const CACHE_RULES: &[CacheRule] = &[
    CacheRule {
        id: "mc.lightspeed-cache",
        name: "MC 模组加载缓存",
        dir_names: &["lightspeed-cache", "dynamic-data-pack-cache"],
        reason: "Lightspeed/动态数据包缓存，删除后下次启动自动重建",
        safety: Safety::SafeToDelete,
    },
    CacheRule {
        id: "generic.cache",
        name: "通用缓存目录",
        dir_names: &["cache", "caches", ".cache"],
        reason: "程序缓存，删除后按需重建",
        safety: Safety::SafeToDelete,
    },
    CacheRule {
        id: "generic.logs",
        name: "日志目录",
        dir_names: &["logs"],
        reason: "运行日志，排障后无保留价值",
        safety: Safety::SafeToDelete,
    },
    CacheRule {
        id: "mc.crash-reports",
        name: "崩溃报告",
        dir_names: &["crash-reports"],
        reason: "历史崩溃报告，看完即可清理",
        safety: Safety::SafeToDelete,
    },
    CacheRule {
        id: "generic.temp",
        name: "临时文件目录",
        dir_names: &["tmp", "temp", ".tmp"],
        reason: "临时文件，程序不保证其长期有效",
        safety: Safety::SafeToDelete,
    },
    CacheRule {
        id: "dev.node-modules",
        name: "npm 依赖目录",
        dir_names: &["node_modules"],
        reason: "可用 npm/pnpm install 重新安装，但请确认项目不再需要离线依赖",
        safety: Safety::ReviewAdvised,
    },
    CacheRule {
        id: "generic.backups",
        name: "自动备份目录",
        dir_names: &["backups", "backup"],
        reason: "启动器/程序自动备份，确认无用后再删",
        safety: Safety::ReviewAdvised,
    },
];

// ---------------------------------------------------------------------------
// 缓存/可清理项识别：在聚合统计树上匹配，直接复用树的目录体积。
// ---------------------------------------------------------------------------

pub fn find_cache_hits(tree: &DirStat) -> Vec<RuleHit> {
    let mut hits = Vec::new();
    walk_tree(tree, &mut hits);
    hits.sort_by(|a, b| b.size.cmp(&a.size));
    hits
}

fn walk_tree(node: &DirStat, hits: &mut Vec<RuleHit>) {
    let lname = node.name.to_lowercase();
    for rule in CACHE_RULES {
        if rule.dir_names.contains(&lname.as_str()) {
            hits.push(RuleHit {
                rule_id: rule.id.into(),
                rule_name: rule.name.into(),
                rel_path: node.rel_path.clone(),
                size: node.total_size,
                file_count: node.file_count,
                reason: rule.reason.into(),
                safety: rule.safety,
            });
            // 整棵子树已计入，不再向下匹配，避免父子重复统计
            return;
        }
    }
    for c in &node.children {
        walk_tree(c, hits);
    }
}

// ---------------------------------------------------------------------------
// 大文件猎人：按体积降序取前 N。
// ---------------------------------------------------------------------------

pub fn find_big_files(outcome: &ScanOutcome, top_n: usize) -> Vec<FileEntry> {
    let mut files: Vec<FileEntry> = outcome.files.clone();
    files.sort_by(|a, b| b.size.cmp(&a.size));
    files.truncate(top_n);
    files
}

// ---------------------------------------------------------------------------
// 重复文件检测：大小分组 → 头部指纹分组 → 全文哈希确认。
// 只有内容哈希一致才判定重复。默认忽略 0 字节文件（无空间意义）。
// ---------------------------------------------------------------------------

/// 头部指纹采样大小。
const HEAD_SAMPLE: usize = 64 * 1024;

/// 重复文件检测的默认最小文件体积：1 MiB。
/// 小于此值的重复对清理空间无实际意义（实测 30 万文件目录中，
/// 1 MiB 阈值保留 83% 可回收空间，候选文件数降到 2%）。
pub const DEFAULT_DUPE_MIN_SIZE: u64 = 1024 * 1024;

/// 重复文件检测进度回调参数：(已哈希文件数, 候选文件总数)。
pub type DupeProgress<'a> = dyn FnMut(u64, u64) + Send + 'a;

/// 并行哈希工作线程数：IO 密集型任务，8 线程在 NVMe 上实测收益明显。
const HASH_WORKERS: usize = 8;

/// 共享进度：原子计数 + 加锁回调（每 200 个文件触发一次）。
struct SharedProgress<'a> {
    done: std::sync::atomic::AtomicU64,
    total: u64,
    cb: std::sync::Mutex<Option<&'a mut DupeProgress<'a>>>,
}
impl<'a> SharedProgress<'a> {
    fn tick(&self) {
        let done = self.done.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        if done % 200 == 0 {
            if let Some(cb) = self.cb.lock().unwrap().as_deref_mut() {
                cb(done, self.total);
            }
        }
    }
}

/// 用 scoped 线程池对文件逐个求哈希，保持输入顺序返回结果。
/// 索引窃取（fetch_add）实现负载均衡：大文件线程不会被小文件线程等。
fn par_hash<'a, F>(
    files: &[&'a FileEntry],
    progress: &SharedProgress,
    hash_fn: F,
) -> Vec<std::io::Result<u64>>
where
    F: Fn(&FileEntry) -> std::io::Result<u64> + Sync,
{
    let next = std::sync::atomic::AtomicUsize::new(0);
    let results: Vec<std::sync::Mutex<Option<std::io::Result<u64>>>> =
        files.iter().map(|_| std::sync::Mutex::new(None)).collect();
    std::thread::scope(|s| {
        for _ in 0..HASH_WORKERS.min(files.len().max(1)) {
            s.spawn(|| loop {
                let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if i >= files.len() {
                    break;
                }
                let r = hash_fn(files[i]);
                *results[i].lock().unwrap() = Some(r);
                progress.tick();
            });
        }
    });
    results
        .into_iter()
        .map(|m| m.into_inner().unwrap().unwrap())
        .collect()
}

pub fn find_duplicates<'a>(
    root: &Path,
    outcome: &ScanOutcome,
    min_size: u64,
    on_progress: Option<&'a mut DupeProgress<'a>>,
) -> (Vec<DupeGroup>, u64, u64) {
    // 1. 按大小分组，只保留有重复嫌疑的组
    let mut by_size: HashMap<u64, Vec<&FileEntry>> = HashMap::new();
    for f in &outcome.files {
        if f.size >= min_size {
            by_size.entry(f.size).or_default().push(f);
        }
    }
    let candidates: Vec<&FileEntry> = by_size
        .into_values()
        .filter(|g| g.len() >= 2)
        .flatten()
        .collect();
    let total_candidates = candidates.len() as u64;

    let progress = SharedProgress {
        done: std::sync::atomic::AtomicU64::new(0),
        total: total_candidates * 2, // 头部 + 全文两个阶段
        cb: std::sync::Mutex::new(on_progress),
    };
    let mut hashed_bytes = 0u64;
    let mut hash_errors = 0u64;

    // 2. 头部指纹（并行），按 (大小, 指纹) 二次分组
    let head_results = par_hash(&candidates, &progress, |f| head_fingerprint(root, f));
    let mut by_head: HashMap<(u64, u64), Vec<&FileEntry>> = HashMap::new();
    for (f, r) in candidates.iter().zip(head_results) {
        match r {
            Ok(h) => {
                hashed_bytes += f.size.min(HEAD_SAMPLE as u64);
                by_head.entry((f.size, h)).or_default().push(f);
            }
            Err(_) => hash_errors += 1,
        }
    }
    let head_files: Vec<&FileEntry> = by_head
        .into_values()
        .filter(|g| g.len() >= 2)
        .flatten()
        .collect();

    // 3. 全文哈希（并行）最终确认，按 (大小, 全文哈希) 分组
    let full_results = par_hash(&head_files, &progress, |f| full_hash(root, f));
    let mut by_hash: HashMap<(u64, u64), Vec<String>> = HashMap::new();
    for (f, r) in head_files.iter().zip(full_results) {
        match r {
            Ok(h) => {
                hashed_bytes += f.size;
                by_hash.entry((f.size, h)).or_default().push(f.rel_path.clone());
            }
            Err(_) => hash_errors += 1,
        }
    }
    let mut final_groups: Vec<DupeGroup> = Vec::new();
    for ((size, hash), files) in by_hash {
        if files.len() >= 2 {
            let mut files = files;
            files.sort();
            final_groups.push(DupeGroup {
                size,
                hash,
                wasted: size * (files.len() as u64 - 1),
                files,
            });
        }
    }
    final_groups.sort_by(|a, b| b.wasted.cmp(&a.wasted));
    (final_groups, hashed_bytes, hash_errors)
}

/// 汇总入口：三类分析一次跑完。
pub fn analyze<'a>(
    root: &Path,
    outcome: &ScanOutcome,
    tree: &DirStat,
    top_n_big: usize,
    dupe_min_size: u64,
    on_dupe_progress: Option<&'a mut DupeProgress<'a>>,
) -> AnalysisReport {
    let cache_hits = find_cache_hits(tree);
    let big_files = find_big_files(outcome, top_n_big);
    let (dupe_groups, hashed_bytes, hash_errors) =
        find_duplicates(root, outcome, dupe_min_size, on_dupe_progress);
    let reclaimable = cache_hits
        .iter()
        .filter(|h| h.safety == Safety::SafeToDelete)
        .map(|h| h.size)
        .sum::<u64>()
        + dupe_groups.iter().map(|g| g.wasted).sum::<u64>();
    AnalysisReport {
        cache_hits,
        big_files,
        dupe_groups,
        reclaimable_bytes: reclaimable,
        hashed_bytes,
        hash_errors,
    }
}

/// 轻量分析：跳过重复文件检测（不读文件内容，秒出）。
pub fn analyze_light(outcome: &ScanOutcome, tree: &DirStat, top_n_big: usize) -> AnalysisReport {
    let cache_hits = find_cache_hits(tree);
    let big_files = find_big_files(outcome, top_n_big);
    let reclaimable = cache_hits
        .iter()
        .filter(|h| h.safety == Safety::SafeToDelete)
        .map(|h| h.size)
        .sum();
    AnalysisReport {
        cache_hits,
        big_files,
        dupe_groups: Vec::new(),
        reclaimable_bytes: reclaimable,
        hashed_bytes: 0,
        hash_errors: 0,
    }
}

// ---------------------------------------------------------------------------
// xxHash64：流式实现，免外部依赖。算法为公开标准，常数取自官方定义。
// ---------------------------------------------------------------------------

const XXP1: u64 = 0x9E3779B185EBCA87;
const XXP2: u64 = 0xC2B2AE3D27D4EB4F;
const XXP3: u64 = 0x165667B19E3779F9;
const XXP4: u64 = 0x85EBCA77C2B2AE63;
const XXP5: u64 = 0x27D4EB2F165667C5;

#[inline]
fn xx_round(acc: u64, lane: u64) -> u64 {
    acc.wrapping_add(lane.wrapping_mul(XXP2))
        .rotate_left(31)
        .wrapping_mul(XXP1)
}

#[derive(Clone)]
struct Xxh64 {
    total: u64,
    v1: u64,
    v2: u64,
    v3: u64,
    v4: u64,
    buf: [u8; 32],
    buflen: usize,
}

impl Xxh64 {
    fn new(seed: u64) -> Self {
        Self {
            total: 0,
            v1: seed.wrapping_add(XXP1).wrapping_add(XXP2),
            v2: seed.wrapping_add(XXP2),
            v3: seed,
            v4: seed.wrapping_sub(XXP1),
            buf: [0; 32],
            buflen: 0,
        }
    }

    fn update(&mut self, mut data: &[u8]) {
        self.total = self.total.wrapping_add(data.len() as u64);

        // 先填满缓冲区
        if self.buflen > 0 {
            let need = 32 - self.buflen;
            let take = need.min(data.len());
            self.buf[self.buflen..self.buflen + take].copy_from_slice(&data[..take]);
            self.buflen += take;
            data = &data[take..];
            if self.buflen == 32 {
                self.consume_block();
            }
        }

        while data.len() >= 32 {
            self.v1 = xx_round(self.v1, u64::from_le_bytes(data[0..8].try_into().unwrap()));
            self.v2 = xx_round(self.v2, u64::from_le_bytes(data[8..16].try_into().unwrap()));
            self.v3 = xx_round(self.v3, u64::from_le_bytes(data[16..24].try_into().unwrap()));
            self.v4 = xx_round(self.v4, u64::from_le_bytes(data[24..32].try_into().unwrap()));
            data = &data[32..];
        }

        if !data.is_empty() {
            self.buf[..data.len()].copy_from_slice(data);
            self.buflen = data.len();
        }
    }

    fn consume_block(&mut self) {
        let b = self.buf;
        self.v1 = xx_round(self.v1, u64::from_le_bytes(b[0..8].try_into().unwrap()));
        self.v2 = xx_round(self.v2, u64::from_le_bytes(b[8..16].try_into().unwrap()));
        self.v3 = xx_round(self.v3, u64::from_le_bytes(b[16..24].try_into().unwrap()));
        self.v4 = xx_round(self.v4, u64::from_le_bytes(b[24..32].try_into().unwrap()));
        self.buflen = 0;
    }

    fn digest(&self) -> u64 {
        let mut h = if self.total >= 32 {
            let mut h = self
                .v1
                .rotate_left(1)
                .wrapping_add(self.v2.rotate_left(7))
                .wrapping_add(self.v3.rotate_left(12))
                .wrapping_add(self.v4.rotate_left(18));
            for v in [self.v1, self.v2, self.v3, self.v4] {
                h ^= xx_round(0, v);
                h = h.wrapping_mul(XXP1).wrapping_add(XXP4);
            }
            h
        } else {
            XXP5 // seed == 0
        };
        h = h.wrapping_add(self.total);

        let mut rest = &self.buf[..self.buflen];
        while rest.len() >= 8 {
            h ^= xx_round(0, u64::from_le_bytes(rest[..8].try_into().unwrap()));
            h = h.rotate_left(27).wrapping_mul(XXP1).wrapping_add(XXP4);
            rest = &rest[8..];
        }
        if rest.len() >= 4 {
            h ^= (u32::from_le_bytes(rest[..4].try_into().unwrap()) as u64).wrapping_mul(XXP1);
            h = h.rotate_left(23).wrapping_mul(XXP2).wrapping_add(XXP3);
            rest = &rest[4..];
        }
        for &b in rest {
            h ^= (b as u64).wrapping_mul(XXP5);
            h = h.rotate_left(11).wrapping_mul(XXP1);
        }

        // 雪崩混合
        h ^= h >> 33;
        h = h.wrapping_mul(XXP2);
        h ^= h >> 29;
        h = h.wrapping_mul(XXP3);
        h ^= h >> 32;
        h
    }
}

fn head_fingerprint(root: &Path, f: &FileEntry) -> std::io::Result<u64> {
    let mut file = std::fs::File::open(root.join(f.rel_path.replace('/', std::path::MAIN_SEPARATOR_STR)))?;
    let mut buf = vec![0u8; HEAD_SAMPLE.min(f.size as usize)];
    file.read_exact(&mut buf)?;
    let mut h = Xxh64::new(0);
    h.update(&buf);
    h.update(&f.size.to_le_bytes()); // 混入大小，防御采样前缀相同但长度不同
    Ok(h.digest())
}

fn full_hash(root: &Path, f: &FileEntry) -> std::io::Result<u64> {
    let mut file = std::fs::File::open(root.join(f.rel_path.replace('/', std::path::MAIN_SEPARATOR_STR)))?;
    let mut h = Xxh64::new(0);
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.digest())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn xxh64_of(data: &[u8]) -> u64 {
        let mut h = Xxh64::new(0);
        h.update(data);
        h.digest()
    }

    #[test]
    fn xxh64_matches_reference_vectors() {
        // 官方测试向量（seed = 0）
        assert_eq!(xxh64_of(b""), 0xEF46DB3751D8E999);
        assert_eq!(xxh64_of(b"abc"), 0x44BC2CF5AD770999);
    }

    #[test]
    fn xxh64_streaming_equals_oneshot() {
        // 跨块喂入与一次性喂入结果必须一致（覆盖 32 字节块边界与尾部各长度）
        let data: Vec<u8> = (0..1000u32).map(|i| (i * 7 + 3) as u8).collect();
        let oneshot = xxh64_of(&data);
        for chunk in [1usize, 7, 31, 32, 33, 64, 256] {
            let mut h = Xxh64::new(0);
            for piece in data.chunks(chunk) {
                h.update(piece);
            }
            assert_eq!(h.digest(), oneshot, "chunk size {chunk}");
        }
    }
}
