//! 空间合并（硬链接去重）：把内容完全相同的 N 份文件合并为磁盘上的一份实体。
//! 与删除的根本区别：每个路径都保留，程序照常运行，空间真实释放。
//! 安全约束：
//! - 合并前重新计算双方全文哈希（分析后文件可能已变化，变化则跳过）；
//! - 先改名备份 → 建硬链接 → 删备份；任一步失败自动回滚；
//! - 逐条记录结果，单条失败不影响其余。

use crate::model::FileEntry;
use crate::rules::DupeGroup;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct MergeItemResult {
    pub path: String,
    pub status: String, // merged / skipped_changed / skipped_linked / failed
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MergeReport {
    pub results: Vec<MergeItemResult>,
    pub merged_files: usize,
    pub freed_bytes: u64,
    pub skipped: usize,
    pub failed: usize,
}

fn abs(root: &Path, rel: &str) -> PathBuf {
    root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR))
}

/// 对单个副本执行 备份→硬链接→清理 合并。返回 (状态, 说明)。
fn merge_one(
    root: &Path,
    anchor: &FileEntry,
    copy: &FileEntry,
    expected_hash: u64,
) -> MergeItemResult {
    let display = copy.rel_path.clone();
    let anchor_abs = abs(root, &anchor.rel_path);
    let copy_abs = abs(root, &copy.rel_path);

    // 已经是同一实体的路径不再重复合并，也不能虚报可释放空间。
    match (
        crate::rules::file_identity(&anchor_abs),
        crate::rules::file_identity(&copy_abs),
    ) {
        (Ok(Some(anchor_id)), Ok(Some(copy_id))) if anchor_id == copy_id => {
            return MergeItemResult {
                path: display,
                status: "skipped_linked".into(),
                detail: Some("原本就是同一硬链接，无需合并".into()),
            };
        }
        (Err(e), _) | (_, Err(e)) => {
            return MergeItemResult {
                path: display,
                status: "failed".into(),
                detail: Some(format!("文件实体校验失败：{e}")),
            };
        }
        _ => {}
    }

    // 合并前重新校验：双方必须保持分析时的大小与全文哈希，任何变化都跳过。
    let verified = (|| -> std::io::Result<bool> {
        let anchor_size = std::fs::metadata(&anchor_abs)?.len();
        let copy_size = std::fs::metadata(&copy_abs)?.len();
        if anchor_size != copy_size || anchor_size != anchor.size || copy_size != copy.size {
            return Ok(false);
        }
        let ha = crate::rules::hash_file_for_merge(&anchor_abs)?;
        let hc = crate::rules::hash_file_for_merge(&copy_abs)?;
        Ok(ha == hc && ha == expected_hash)
    })();
    match verified {
        Ok(true) => {}
        Ok(false) => {
            return MergeItemResult {
                path: display,
                status: "skipped_changed".into(),
                detail: Some("内容已与分析时不同，未合并".into()),
            }
        }
        Err(e) => {
            return MergeItemResult {
                path: display,
                status: "failed".into(),
                detail: Some(format!("校验失败：{e}")),
            }
        }
    }

    // 先独占创建空备份占位，避免 rename 在 Unix 上覆盖已有同名文件。
    let bak = copy_abs.with_extension("ss-merge-bak");
    let reservation = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&bak);
    match reservation {
        Ok(file) => drop(file),
        Err(e) => {
            return MergeItemResult {
                path: display,
                status: "failed".into(),
                detail: Some(format!("无法创建安全备份（同名文件可能已存在）：{e}")),
            };
        }
    }
    // 备份 → 硬链接 → 删备份；失败回滚
    if let Err(e) = std::fs::rename(&copy_abs, &bak) {
        let _ = std::fs::remove_file(&bak);
        return MergeItemResult {
            path: display,
            status: "failed".into(),
            detail: Some(format!("备份失败：{e}")),
        };
    }
    match std::fs::hard_link(&anchor_abs, &copy_abs) {
        Ok(()) => {
            let detail = match std::fs::remove_file(&bak) {
                Ok(()) => None,
                Err(e) => Some(format!("已合并，但备份文件残留（可手动删除）：{e}")),
            };
            MergeItemResult {
                path: display,
                status: "merged".into(),
                detail,
            }
        }
        Err(e) => {
            // 回滚：恢复原文件
            let rollback = std::fs::rename(&bak, &copy_abs);
            MergeItemResult {
                path: display,
                status: "failed".into(),
                detail: Some(match rollback {
                    Ok(()) => format!("硬链接失败（已回滚）：{e}"),
                    Err(re) => format!(
                        "硬链接失败：{e}；且回滚失败，备份在 {}：{re}",
                        bak.display()
                    ),
                }),
            }
        }
    }
}

/// 合并全部重复组。每组第一份为锚点保留原位，其余副本合并到锚点。
pub fn merge_duplicates(root: &Path, groups: &[DupeGroup]) -> MergeReport {
    let mut results = Vec::new();
    let mut freed_bytes = 0u64;
    for g in groups {
        if g.files.len() < 2 {
            continue;
        }
        let anchor = FileEntry {
            rel_path: g.files[0].clone(),
            name: String::new(),
            size: g.size,
            modified: None,
            ext: None,
        };
        for rel in &g.files[1..] {
            let copy = FileEntry {
                rel_path: rel.clone(),
                name: String::new(),
                size: g.size,
                modified: None,
                ext: None,
            };
            let r = merge_one(root, &anchor, &copy, g.hash);
            if r.status == "merged" {
                freed_bytes += g.size;
            }
            results.push(r);
        }
    }
    let merged_files = results.iter().filter(|r| r.status == "merged").count();
    let skipped = results
        .iter()
        .filter(|r| r.status.starts_with("skipped"))
        .count();
    let failed = results.iter().filter(|r| r.status == "failed").count();
    MergeReport {
        results,
        merged_files,
        freed_bytes,
        skipped,
        failed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    fn group(root: &Path, size: u64, files: &[&str]) -> DupeGroup {
        DupeGroup {
            size,
            hash: crate::rules::hash_file_for_merge(&root.join(files[0])).unwrap(),
            wasted: size * (files.len() as u64 - 1),
            files: files.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn merges_identical_files_into_one_entity() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir(root.join("sub")).unwrap();
        fs::write(root.join("a.bin"), b"same-content").unwrap();
        fs::write(root.join("sub/b.bin"), b"same-content").unwrap();
        fs::write(root.join("c.bin"), b"different").unwrap();

        let report = merge_duplicates(root, &[group(root, 12, &["a.bin", "sub/b.bin"])]);
        assert_eq!(report.merged_files, 1);
        assert_eq!(report.freed_bytes, 12);

        // 两个路径都在，内容一致；改锚点，副本同步可见（同一实体）
        assert_eq!(fs::read(root.join("a.bin")).unwrap(), b"same-content");
        assert_eq!(fs::read(root.join("sub/b.bin")).unwrap(), b"same-content");
        fs::write(root.join("a.bin"), b"updated!").unwrap();
        assert_eq!(fs::read(root.join("sub/b.bin")).unwrap(), b"updated!");
        // 不相关文件不受影响
        assert_eq!(fs::read(root.join("c.bin")).unwrap(), b"different");
        // 无备份残留
        assert!(!root.join("sub/b.ss-merge-bak").exists());
    }

    #[test]
    fn skips_copy_that_changed_since_analysis() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.bin"), b"same-content").unwrap();
        fs::write(root.join("b.bin"), b"same-content").unwrap();
        // 组记录仍是相同大小，但 b 已被改写成同大小的不同内容
        fs::write(root.join("b.bin"), b"DIFF-content").unwrap();

        let report = merge_duplicates(root, &[group(root, 12, &["a.bin", "b.bin"])]);
        assert_eq!(report.merged_files, 0);
        assert_eq!(report.skipped, 1);
        // b 保持自己的内容，未被合并
        assert_eq!(fs::read(root.join("b.bin")).unwrap(), b"DIFF-content");
        assert_eq!(fs::read(root.join("a.bin")).unwrap(), b"same-content");
    }

    #[test]
    fn never_overwrites_an_existing_backup_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.bin"), b"same-content").unwrap();
        fs::write(root.join("b.bin"), b"same-content").unwrap();
        fs::write(root.join("b.ss-merge-bak"), b"keep-this-backup").unwrap();

        let report = merge_duplicates(root, &[group(root, 12, &["a.bin", "b.bin"])]);
        assert_eq!(report.merged_files, 0);
        assert_eq!(report.freed_bytes, 0);
        assert_eq!(report.failed, 1);
        assert_eq!(fs::read(root.join("a.bin")).unwrap(), b"same-content");
        assert_eq!(fs::read(root.join("b.bin")).unwrap(), b"same-content");
        assert_eq!(
            fs::read(root.join("b.ss-merge-bak")).unwrap(),
            b"keep-this-backup"
        );
    }

    #[test]
    fn skips_paths_that_already_share_one_file_entity() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.bin"), b"same-content").unwrap();
        fs::hard_link(root.join("a.bin"), root.join("b.bin")).unwrap();

        let report = merge_duplicates(root, &[group(root, 12, &["a.bin", "b.bin"])]);
        assert_eq!(report.merged_files, 0);
        assert_eq!(report.freed_bytes, 0);
        assert_eq!(report.skipped, 1);
        assert_eq!(report.failed, 0);
        assert_eq!(report.results[0].status, "skipped_linked");
        assert_eq!(fs::read(root.join("a.bin")).unwrap(), b"same-content");
        assert_eq!(fs::read(root.join("b.bin")).unwrap(), b"same-content");
    }

    #[test]
    fn skips_when_both_files_changed_even_if_they_still_match() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.bin"), b"same-content").unwrap();
        fs::write(root.join("b.bin"), b"same-content").unwrap();
        let original = group(root, 12, &["a.bin", "b.bin"]);
        // 分析后两份一起改成相同的新内容，也不得冒充原分析结果合并。
        fs::write(root.join("a.bin"), b"NEW-content!").unwrap();
        fs::write(root.join("b.bin"), b"NEW-content!").unwrap();

        let report = merge_duplicates(root, &[original]);
        assert_eq!(report.merged_files, 0);
        assert_eq!(report.skipped, 1);
        fs::write(root.join("a.bin"), b"updated!").unwrap();
        assert_eq!(fs::read(root.join("b.bin")).unwrap(), b"NEW-content!");
    }
}
