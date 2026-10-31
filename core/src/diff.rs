//! 快照差异：以规范化相对路径匹配文件节点，目录变化由文件级差异向上聚合。
//! 规则对应技术方案 §4：重命名表现为删除＋新增；不完整快照给出可比性警告。

use crate::model::FileEntry;
use crate::scanner::parent_of;
use crate::snapshot::{self, SnapshotMeta};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChangeKind {
    Added,
    Removed,
    Grown,
    Shrunk,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileChange {
    pub rel_path: String,
    pub kind: ChangeKind,
    pub old_size: Option<u64>,
    pub new_size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirChange {
    pub rel_path: String,
    pub added_bytes: i64,
    pub removed_bytes: i64,
    pub net_bytes: i64,
    pub changed_files: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DiffSummary {
    pub added_files: u64,
    pub removed_files: u64,
    pub grown_files: u64,
    pub shrunk_files: u64,
    pub added_bytes: u64,
    pub removed_bytes: u64,
    pub net_bytes: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DiffReport {
    pub old_id: i64,
    pub new_id: i64,
    pub root: String,
    pub warnings: Vec<String>,
    pub files: Vec<FileChange>,
    pub dirs: Vec<DirChange>,
    pub summary: DiffSummary,
}

/// Windows 路径语义：不区分大小写，但不改动原始名称。
fn key(rel_path: &str) -> String {
    rel_path.to_lowercase()
}

pub fn diff(conn: &Connection, old_id: i64, new_id: i64) -> Result<DiffReport, String> {
    let old_m: SnapshotMeta =
        snapshot::meta(conn, old_id).map_err(|_| format!("快照 #{old_id} 不存在"))?;
    let new_m: SnapshotMeta =
        snapshot::meta(conn, new_id).map_err(|_| format!("快照 #{new_id} 不存在"))?;

    // 1. 校验可比性
    if old_m.root.to_lowercase() != new_m.root.to_lowercase() {
        return Err(format!(
            "根目录不同，不可比较：{} vs {}",
            old_m.root, new_m.root
        ));
    }
    if old_m.stats_kind != new_m.stats_kind {
        return Err(format!(
            "统计口径不同，不可比较：{} vs {}",
            old_m.stats_kind, new_m.stats_kind
        ));
    }
    let mut warnings = Vec::new();
    if old_m.app_version != new_m.app_version {
        warnings.push(format!(
            "两个快照由不同版本生成（{} vs {}），结果仅供参考",
            old_m.app_version, new_m.app_version
        ));
    }
    if old_m.status != "complete" {
        warnings.push(format!(
            "旧快照 #{old_id} 存在扫描异常，差异结果可能不完整"
        ));
    }
    if new_m.status != "complete" {
        warnings.push(format!(
            "新快照 #{new_id} 存在扫描异常，差异结果可能不完整"
        ));
    }

    // 2. 按规范化相对路径匹配
    let old_files = snapshot::load_files(conn, old_id).map_err(|e| e.to_string())?;
    let new_files = snapshot::load_files(conn, new_id).map_err(|e| e.to_string())?;
    let old_map: HashMap<String, &FileEntry> = old_files
        .iter()
        .map(|f| (key(&f.rel_path), f))
        .collect();
    let new_map: HashMap<String, &FileEntry> = new_files
        .iter()
        .map(|f| (key(&f.rel_path), f))
        .collect();

    let mut files: Vec<FileChange> = Vec::new();
    for (k, nf) in &new_map {
        match old_map.get(k) {
            None => files.push(FileChange {
                rel_path: nf.rel_path.clone(),
                kind: ChangeKind::Added,
                old_size: None,
                new_size: Some(nf.size),
            }),
            Some(of) => {
                if nf.size > of.size {
                    files.push(FileChange {
                        rel_path: nf.rel_path.clone(),
                        kind: ChangeKind::Grown,
                        old_size: Some(of.size),
                        new_size: Some(nf.size),
                    });
                } else if nf.size < of.size {
                    files.push(FileChange {
                        rel_path: nf.rel_path.clone(),
                        kind: ChangeKind::Shrunk,
                        old_size: Some(of.size),
                        new_size: Some(nf.size),
                    });
                }
            }
        }
    }
    for (k, of) in &old_map {
        if !new_map.contains_key(k) {
            files.push(FileChange {
                rel_path: of.rel_path.clone(),
                kind: ChangeKind::Removed,
                old_size: Some(of.size),
                new_size: None,
            });
        }
    }

    // 3. 目录变化由文件级差异向上聚合，避免重复计算
    let mut dir_map: HashMap<String, DirChange> = HashMap::new();
    for c in &files {
        let (add, rem): (i64, i64) = match c.kind {
            ChangeKind::Added => (c.new_size.unwrap_or(0) as i64, 0),
            ChangeKind::Removed => (0, c.old_size.unwrap_or(0) as i64),
            ChangeKind::Grown => (
                (c.new_size.unwrap_or(0) - c.old_size.unwrap_or(0)) as i64,
                0,
            ),
            ChangeKind::Shrunk => (
                0,
                (c.old_size.unwrap_or(0) - c.new_size.unwrap_or(0)) as i64,
            ),
        };
        let mut p = parent_of(&c.rel_path).to_string();
        loop {
            let e = dir_map.entry(p.clone()).or_insert(DirChange {
                rel_path: p.clone(),
                added_bytes: 0,
                removed_bytes: 0,
                net_bytes: 0,
                changed_files: 0,
            });
            e.added_bytes += add;
            e.removed_bytes += rem;
            e.net_bytes += add - rem;
            e.changed_files += 1;
            if p == "." {
                break;
            }
            p = parent_of(&p).to_string();
        }
    }

    // 4. 汇总与排序：按绝对变化量降序
    let delta_of = |c: &FileChange| -> i64 {
        match c.kind {
            ChangeKind::Added => c.new_size.unwrap_or(0) as i64,
            ChangeKind::Removed => c.old_size.unwrap_or(0) as i64,
            ChangeKind::Grown | ChangeKind::Shrunk => {
                (c.new_size.unwrap_or(0) as i64 - c.old_size.unwrap_or(0) as i64).abs()
            }
        }
    };
    files.sort_by_key(|c| std::cmp::Reverse(delta_of(c)));
    let mut dirs: Vec<DirChange> = dir_map.into_values().collect();
    dirs.sort_by_key(|d| std::cmp::Reverse(d.added_bytes.abs() + d.removed_bytes.abs()));

    let summary = DiffSummary {
        added_files: files.iter().filter(|c| c.kind == ChangeKind::Added).count() as u64,
        removed_files: files
            .iter()
            .filter(|c| c.kind == ChangeKind::Removed)
            .count() as u64,
        grown_files: files.iter().filter(|c| c.kind == ChangeKind::Grown).count() as u64,
        shrunk_files: files
            .iter()
            .filter(|c| c.kind == ChangeKind::Shrunk)
            .count() as u64,
        added_bytes: files
            .iter()
            .map(|c| match c.kind {
                ChangeKind::Added => c.new_size.unwrap_or(0),
                ChangeKind::Grown => c.new_size.unwrap_or(0) - c.old_size.unwrap_or(0),
                _ => 0,
            })
            .sum(),
        removed_bytes: files
            .iter()
            .map(|c| match c.kind {
                ChangeKind::Removed => c.old_size.unwrap_or(0),
                ChangeKind::Shrunk => c.old_size.unwrap_or(0) - c.new_size.unwrap_or(0),
                _ => 0
            })
            .sum(),
        net_bytes: new_m.total_bytes - old_m.total_bytes,
    };

    Ok(DiffReport {
        old_id,
        new_id,
        root: new_m.root,
        warnings,
        files,
        dirs,
        summary,
    })
}
