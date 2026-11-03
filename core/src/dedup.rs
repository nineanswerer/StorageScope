//! 空间合并（硬链接去重）：把内容完全相同的 N 份文件合并为磁盘上的一份实体。
//! 与删除的根本区别：每个路径都保留；释放量按独立实体的分配大小核实。
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
    /// 旧实体仍有其他硬链接时按 0 计；分配大小未知或备份残留时为 None。
    pub verified_freed_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MergeReport {
    pub results: Vec<MergeItemResult>,
    pub merged_files: usize,
    /// 被合并副本的逻辑大小之和，不等同于物理释放。
    pub merged_logical_bytes: u64,
    /// 任一已合并项无法核实时为 None，避免用逻辑大小补齐。
    pub verified_freed_bytes: Option<u64>,
    pub skipped: usize,
    pub failed: usize,
    /// 启动时处理的中断恢复记录；需要人工检查的记录也在这里报告。
    pub recovery: Vec<String>,
}

fn abs(root: &Path, rel: &str) -> PathBuf {
    root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR))
}

#[derive(Clone, Copy)]
struct AllocationInfo {
    bytes: u64,
    link_count: u32,
}

#[cfg(windows)]
fn allocation_info(path: &Path) -> std::io::Result<Option<AllocationInfo>> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FileStandardInfo, GetFileInformationByHandleEx, FILE_STANDARD_INFO,
    };
    let file = std::fs::File::open(path)?;
    let mut info: FILE_STANDARD_INFO = unsafe { std::mem::zeroed() };
    let ok = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE,
            FileStandardInfo,
            &mut info as *mut _ as *mut core::ffi::c_void,
            std::mem::size_of::<FILE_STANDARD_INFO>() as u32,
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(Some(AllocationInfo {
        bytes: info.AllocationSize.max(0) as u64,
        link_count: info.NumberOfLinks,
    }))
}

#[cfg(not(windows))]
fn allocation_info(_path: &Path) -> std::io::Result<Option<AllocationInfo>> {
    Ok(None)
}

fn item(path: String, status: &str, detail: Option<String>) -> MergeItemResult {
    MergeItemResult {
        path,
        status: status.into(),
        detail,
        verified_freed_bytes: None,
    }
}

/// 不替换地恢复备份：目标已存在时同时保留新文件和备份，绝不覆盖并发新内容。
fn restore_backup_no_replace(bak: &Path, copy: &Path) -> std::io::Result<()> {
    if copy.try_exists()? {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "原路径已出现新文件，备份已保留",
        ));
    }
    std::fs::hard_link(bak, copy)?;
    std::fs::remove_file(bak)
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct MergeJournal {
    anchor: String,
    copy: String,
    backup: String,
    expected_hash: u64,
}

fn journal_path(root: &Path, copy: &str) -> PathBuf {
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    copy.hash(&mut hash);
    root.join(format!(".storagescope-merge-{:016x}.json", hash.finish()))
}

fn write_journal(
    root: &Path,
    anchor: &str,
    copy: &str,
    backup: &Path,
    expected_hash: u64,
) -> std::io::Result<PathBuf> {
    let backup_rel = backup
        .strip_prefix(root)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "备份越出扫描根"))?
        .to_string_lossy()
        .replace('\\', "/");
    let journal = MergeJournal {
        anchor: anchor.into(),
        copy: copy.into(),
        backup: backup_rel,
        expected_hash,
    };
    let path = journal_path(root, copy);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    serde_json::to_writer(&mut file, &journal)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    file.sync_all()?;
    Ok(path)
}

/// 恢复上次中断留下的合并状态。无法判定时同时保留原路径、备份和恢复记录。
pub fn recover_interrupted_merges(root: &Path) -> Vec<String> {
    let mut messages = Vec::new();
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) => return vec![format!("无法检查合并恢复记录：{error}")],
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with(".storagescope-merge-") || !name.ends_with(".json") {
            continue;
        }
        let journal = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<MergeJournal>(&bytes).ok());
        let Some(journal) = journal else {
            messages.push(format!("恢复记录损坏，已保留：{}", path.display()));
            continue;
        };
        if [
            journal.anchor.as_str(),
            journal.copy.as_str(),
            journal.backup.as_str(),
        ]
        .into_iter()
        .any(|rel| crate::plan::normalize_relative(rel).is_err())
            || journal.anchor == journal.copy
            || journal.copy == journal.backup
        {
            messages.push(format!("恢复记录包含危险路径，已保留：{}", path.display()));
            continue;
        }
        let anchor = abs(root, &journal.anchor);
        let copy = abs(root, &journal.copy);
        let backup = abs(root, &journal.backup);
        match (copy.try_exists(), backup.try_exists()) {
            (Ok(false), Ok(true)) => {
                let verified = crate::rules::hash_file_for_merge(&backup)
                    .map(|hash| hash == journal.expected_hash)
                    .unwrap_or(false)
                    && crate::rules::files_have_same_content(&anchor, &backup).unwrap_or(false);
                if !verified {
                    messages.push(format!("备份内容无法确认，已保留：{}", backup.display()));
                    continue;
                }
                match restore_backup_no_replace(&backup, &copy) {
                    Ok(()) => {
                        let _ = std::fs::remove_file(&path);
                        messages.push(format!("已从中断合并恢复原路径：{}", journal.copy));
                    }
                    Err(error) => messages.push(format!(
                        "原路径恢复失败，备份仍保留：{}：{error}",
                        backup.display()
                    )),
                }
            }
            (Ok(true), Ok(true)) => messages.push(format!(
                "原路径与合并备份同时存在，两者均已保留：{} / {}",
                journal.copy, journal.backup
            )),
            (Ok(true), Ok(false)) => match std::fs::remove_file(&path) {
                Ok(()) => messages.push(format!("合并目标存在，已清理恢复记录：{}", journal.copy)),
                Err(error) => {
                    messages.push(format!("无法清理恢复记录 {}：{error}", path.display()))
                }
            },
            (Ok(false), Ok(false)) => messages.push(format!(
                "原路径与备份均缺失，需要人工检查：{} / {}",
                journal.copy, journal.backup
            )),
            (Err(error), _) | (_, Err(error)) => messages.push(format!(
                "无法确认中断合并的文件状态，恢复记录已保留：{}：{error}",
                path.display()
            )),
        }
    }
    messages
}

/// 对单个副本执行 备份→硬链接→清理 合并。
fn merge_one(
    root: &Path,
    anchor: &FileEntry,
    copy: &FileEntry,
    expected_hash: u64,
) -> MergeItemResult {
    merge_one_guarded(root, anchor, copy, expected_hash, || {})
}

fn merge_one_guarded(
    root: &Path,
    anchor: &FileEntry,
    copy: &FileEntry,
    expected_hash: u64,
    before_link: impl FnOnce(),
) -> MergeItemResult {
    let display = copy.rel_path.clone();
    let anchor_abs = abs(root, &anchor.rel_path);
    let copy_abs = abs(root, &copy.rel_path);

    match (
        crate::rules::file_identity(&anchor_abs),
        crate::rules::file_identity(&copy_abs),
    ) {
        (Ok(Some(anchor_id)), Ok(Some(copy_id))) if anchor_id == copy_id => {
            return item(
                display,
                "skipped_linked",
                Some("原本就是同一硬链接，无需合并".into()),
            );
        }
        (Err(e), _) | (_, Err(e)) => {
            return item(display, "failed", Some(format!("文件实体校验失败：{e}")));
        }
        _ => {}
    }

    // 内容复核保持不变；分配大小只用于结果计量，不作为合并依据。
    let verified = (|| -> std::io::Result<bool> {
        let anchor_size = std::fs::metadata(&anchor_abs)?.len();
        let copy_size = std::fs::metadata(&copy_abs)?.len();
        if anchor_size != copy_size || anchor_size != anchor.size || copy_size != copy.size {
            return Ok(false);
        }
        let ha = crate::rules::hash_file_for_merge(&anchor_abs)?;
        let hc = crate::rules::hash_file_for_merge(&copy_abs)?;
        Ok(ha == hc
            && ha == expected_hash
            && crate::rules::files_have_same_content(&anchor_abs, &copy_abs)?)
    })();
    match verified {
        Ok(true) => {}
        Ok(false) => {
            return item(
                display,
                "skipped_changed",
                Some("内容已与分析时不同，未合并".into()),
            );
        }
        Err(e) => {
            return item(display, "failed", Some(format!("校验失败：{e}")));
        }
    }
    let allocation_before = allocation_info(&copy_abs).ok().flatten();

    let bak = copy_abs.with_extension("ss-merge-bak");
    let reservation = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&bak);
    match reservation {
        Ok(file) => drop(file),
        Err(e) => {
            return item(
                display,
                "failed",
                Some(format!("无法创建安全备份（同名文件可能已存在）：{e}")),
            );
        }
    }
    let journal = match write_journal(root, &anchor.rel_path, &display, &bak, expected_hash) {
        Ok(path) => path,
        Err(e) => {
            let _ = std::fs::remove_file(&bak);
            return item(
                display,
                "failed",
                Some(format!("无法写入中断恢复记录，未移动原文件：{e}")),
            );
        }
    };
    if let Err(e) = std::fs::rename(&copy_abs, &bak) {
        let _ = std::fs::remove_file(&bak);
        let _ = std::fs::remove_file(&journal);
        return item(display, "failed", Some(format!("备份失败：{e}")));
    }
    before_link();
    match std::fs::hard_link(&anchor_abs, &copy_abs) {
        Ok(()) => {
            let (mut detail, verified_freed_bytes) = match std::fs::remove_file(&bak) {
                Ok(()) => match allocation_before {
                    Some(info) if info.link_count <= 1 => (None, Some(info.bytes)),
                    Some(info) => (
                        Some(format!(
                            "旧实体仍有 {} 个其他硬链接，本项释放按 0 计",
                            info.link_count - 1
                        )),
                        Some(0),
                    ),
                    None => (None, None),
                },
                Err(e) => (
                    Some(format!("已合并，但备份文件残留，将在下次启动时提示：{e}")),
                    None,
                ),
            };
            if let Err(e) = std::fs::remove_file(&journal) {
                let note = format!("恢复记录残留，将在下次启动时处理：{e}");
                detail = Some(detail.map_or(note.clone(), |text| format!("{text}；{note}")));
            }
            MergeItemResult {
                path: display,
                status: "merged".into(),
                detail,
                verified_freed_bytes,
            }
        }
        Err(e) => {
            let rollback = restore_backup_no_replace(&bak, &copy_abs);
            let journal_cleanup = if rollback.is_ok() {
                std::fs::remove_file(&journal).err()
            } else {
                None
            };
            item(
                display,
                "failed",
                Some(match rollback {
                    Ok(()) => match journal_cleanup {
                        Some(cleanup) => format!(
                            "硬链接失败（已回滚）：{e}；恢复记录清理失败，将在下次启动时处理：{cleanup}"
                        ),
                        None => format!("硬链接失败（已回滚）：{e}"),
                    },
                    Err(re) => format!(
                        "硬链接失败：{e}；且回滚未替换现有路径，备份在 {}：{re}",
                        bak.display()
                    ),
                }),
            )
        }
    }
}

/// 合并全部重复组。每组第一份为锚点保留原位，其余副本合并到锚点。
pub fn merge_duplicates(root: &Path, groups: &[DupeGroup]) -> MergeReport {
    let recovery = recover_interrupted_merges(root);
    let mut results = Vec::new();
    let mut merged_logical_bytes = 0u64;
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
                merged_logical_bytes += g.size;
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
    let merged_results: Vec<_> = results.iter().filter(|r| r.status == "merged").collect();
    let verified_freed_bytes = if merged_results
        .iter()
        .all(|r| r.verified_freed_bytes.is_some())
    {
        Some(
            merged_results
                .iter()
                .filter_map(|r| r.verified_freed_bytes)
                .sum(),
        )
    } else {
        None
    };
    MergeReport {
        results,
        merged_files,
        merged_logical_bytes,
        verified_freed_bytes,
        skipped,
        failed,
        recovery,
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
        assert_eq!(report.merged_logical_bytes, 12);

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
        assert_eq!(report.merged_logical_bytes, 0);
        assert_eq!(report.failed, 1);
        assert_eq!(fs::read(root.join("a.bin")).unwrap(), b"same-content");
        assert_eq!(fs::read(root.join("b.bin")).unwrap(), b"same-content");
        assert_eq!(
            fs::read(root.join("b.ss-merge-bak")).unwrap(),
            b"keep-this-backup"
        );
    }

    #[test]
    fn rollback_never_overwrites_a_new_file_at_the_copy_path() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.bin"), b"same-content").unwrap();
        fs::write(root.join("b.bin"), b"same-content").unwrap();
        let anchor = FileEntry {
            rel_path: "a.bin".into(),
            name: "a.bin".into(),
            size: 12,
            modified: None,
            ext: Some("bin".into()),
        };
        let copy = FileEntry {
            rel_path: "b.bin".into(),
            name: "b.bin".into(),
            size: 12,
            modified: None,
            ext: Some("bin".into()),
        };
        let hash = crate::rules::hash_file_for_merge(&root.join("a.bin")).unwrap();
        let result = merge_one_guarded(root, &anchor, &copy, hash, || {
            fs::write(root.join("b.bin"), b"concurrent-new").unwrap();
        });

        assert_eq!(result.status, "failed");
        assert_eq!(fs::read(root.join("b.bin")).unwrap(), b"concurrent-new");
        assert_eq!(
            fs::read(root.join("b.ss-merge-bak")).unwrap(),
            b"same-content"
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
        assert_eq!(report.merged_logical_bytes, 0);
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

    #[test]
    fn missing_copy_fails_without_changing_the_anchor() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.bin"), b"same-content").unwrap();
        fs::write(root.join("b.bin"), b"same-content").unwrap();
        let original = group(root, 12, &["a.bin", "b.bin"]);
        fs::remove_file(root.join("b.bin")).unwrap();

        let report = merge_duplicates(root, &[original]);
        assert_eq!(report.merged_files, 0);
        assert_eq!(report.failed, 1);
        assert!(report.results[0]
            .detail
            .as_deref()
            .unwrap_or("")
            .contains("失败"));
        assert_eq!(fs::read(root.join("a.bin")).unwrap(), b"same-content");
    }

    #[cfg(windows)]
    #[test]
    fn other_hard_links_keep_allocation_from_being_counted() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.bin"), b"same-content").unwrap();
        fs::write(root.join("b.bin"), b"same-content").unwrap();
        fs::hard_link(root.join("b.bin"), root.join("x-other-link.bin")).unwrap();
        let old_copy_id = crate::rules::file_identity(&root.join("b.bin"))
            .unwrap()
            .unwrap();

        let report = merge_duplicates(root, &[group(root, 12, &["a.bin", "b.bin"])]);
        assert_eq!(report.merged_files, 1);
        assert_eq!(report.verified_freed_bytes, Some(0));
        assert_eq!(report.results[0].verified_freed_bytes, Some(0));
        assert!(report.results[0]
            .detail
            .as_deref()
            .unwrap_or("")
            .contains("其他硬链接"));

        let anchor_id = crate::rules::file_identity(&root.join("a.bin"))
            .unwrap()
            .unwrap();
        let merged_id = crate::rules::file_identity(&root.join("b.bin"))
            .unwrap()
            .unwrap();
        let other_id = crate::rules::file_identity(&root.join("x-other-link.bin"))
            .unwrap()
            .unwrap();
        assert_eq!(merged_id, anchor_id);
        assert_eq!(other_id, old_copy_id);
        assert_ne!(other_id, anchor_id);
        assert_eq!(
            fs::read(root.join("x-other-link.bin")).unwrap(),
            b"same-content"
        );
    }

    #[cfg(windows)]
    #[test]
    fn last_link_removal_counts_old_entity_allocation() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.bin"), b"same-content").unwrap();
        fs::write(root.join("b.bin"), b"same-content").unwrap();
        let before = allocation_info(&root.join("b.bin")).unwrap().unwrap();
        assert_eq!(before.link_count, 1);

        let report = merge_duplicates(root, &[group(root, 12, &["a.bin", "b.bin"])]);
        assert_eq!(report.merged_files, 1);
        assert_eq!(report.verified_freed_bytes, Some(before.bytes));
    }

    #[test]
    fn merge_process_abort_child() {
        let Some(root) = std::env::var_os("STORAGESCOPE_TEST_ABORT_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        let anchor = FileEntry {
            rel_path: "a.bin".into(),
            name: String::new(),
            size: 12,
            modified: None,
            ext: None,
        };
        let copy = FileEntry {
            rel_path: "b.bin".into(),
            size: 12,
            ..anchor.clone()
        };
        let hash = crate::rules::hash_file_for_merge(&root.join("a.bin")).unwrap();
        merge_one_guarded(&root, &anchor, &copy, hash, || std::process::abort());
    }

    #[test]
    fn merge_recovers_after_real_process_abort() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.bin"), b"same-content").unwrap();
        fs::write(root.join("b.bin"), b"same-content").unwrap();
        let original = group(root, 12, &["a.bin", "b.bin"]);
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "dedup::tests::merge_process_abort_child",
                "--nocapture",
            ])
            .env("STORAGESCOPE_TEST_ABORT_ROOT", root)
            .status()
            .unwrap();
        assert!(!status.success());
        assert!(!root.join("b.bin").exists());
        assert_eq!(
            fs::read(root.join("b.ss-merge-bak")).unwrap(),
            b"same-content"
        );
        assert!(journal_path(root, "b.bin").exists());

        let report = merge_duplicates(root, &[original]);
        assert_eq!(report.merged_files, 1);
        assert!(report
            .recovery
            .iter()
            .any(|message| message.contains("已从中断合并恢复")));
        assert_eq!(fs::read(root.join("b.bin")).unwrap(), b"same-content");
        assert!(!root.join("b.ss-merge-bak").exists());
        assert!(!journal_path(root, "b.bin").exists());
    }

    #[test]
    fn interrupted_merge_restores_before_retrying() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.bin"), b"same-content").unwrap();
        fs::write(root.join("b.bin"), b"same-content").unwrap();
        let anchor = FileEntry {
            rel_path: "a.bin".into(),
            name: String::new(),
            size: 12,
            modified: None,
            ext: None,
        };
        let copy = FileEntry {
            rel_path: "b.bin".into(),
            size: 12,
            ..anchor.clone()
        };
        let original = group(root, 12, &["a.bin", "b.bin"]);
        let journal = journal_path(root, "b.bin");
        let interrupted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            merge_one_guarded(root, &anchor, &copy, original.hash, || {
                panic!("simulated process interruption after backup rename")
            });
        }));
        assert!(interrupted.is_err());
        assert!(!root.join("b.bin").exists());
        assert_eq!(
            fs::read(root.join("b.ss-merge-bak")).unwrap(),
            b"same-content"
        );
        assert!(journal.exists());

        let report = merge_duplicates(root, &[original]);
        assert_eq!(report.merged_files, 1);
        assert_eq!(report.failed, 0);
        assert!(report
            .recovery
            .iter()
            .any(|message| message.contains("已从中断合并恢复")));
        assert_eq!(fs::read(root.join("a.bin")).unwrap(), b"same-content");
        assert_eq!(fs::read(root.join("b.bin")).unwrap(), b"same-content");
        assert_eq!(
            crate::rules::file_identity(&root.join("a.bin")).unwrap(),
            crate::rules::file_identity(&root.join("b.bin")).unwrap()
        );
        assert!(!root.join("b.ss-merge-bak").exists());
        assert!(!journal.exists());
    }

    #[test]
    fn unicode_paths_merge_without_backup_or_journal_residue() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir(root.join("资料 📁")).unwrap();
        fs::write(root.join("锚点 😀.bin"), b"same-content").unwrap();
        fs::write(root.join("资料 📁/副本 ②.bin"), b"same-content").unwrap();
        let report = merge_duplicates(
            root,
            &[group(root, 12, &["锚点 😀.bin", "资料 📁/副本 ②.bin"])],
        );
        assert_eq!(report.merged_files, 1);
        assert_eq!(report.failed, 0);
        assert_eq!(
            fs::read(root.join("资料 📁/副本 ②.bin")).unwrap(),
            b"same-content"
        );
        assert!(!root.join("资料 📁/副本 ②.ss-merge-bak").exists());
        assert_eq!(
            fs::read_dir(root)
                .unwrap()
                .flatten()
                .filter(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".storagescope-merge-"))
                .count(),
            0
        );
    }

    #[test]
    fn long_paths_execute_or_fail_without_losing_the_copy() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let deep = (0..22)
            .map(|index| format!("long-directory-{index:02}"))
            .collect::<Vec<_>>()
            .join("/");
        let copy_rel = format!("{deep}/copy.bin");
        let copy_abs = root.join(copy_rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        fs::create_dir_all(copy_abs.parent().unwrap()).unwrap();
        fs::write(root.join("a.bin"), b"same-content").unwrap();
        fs::write(&copy_abs, b"same-content").unwrap();
        assert!(copy_abs.to_string_lossy().len() > 260);

        let report = merge_duplicates(root, &[group(root, 12, &["a.bin", &copy_rel])]);
        assert_eq!(report.failed, 0, "{:?}", report.results);
        assert_eq!(report.merged_files, 1);
        assert_eq!(fs::read(&copy_abs).unwrap(), b"same-content");
        assert_eq!(
            crate::rules::file_identity(&root.join("a.bin")).unwrap(),
            crate::rules::file_identity(&copy_abs).unwrap()
        );
        assert!(!copy_abs.with_extension("ss-merge-bak").exists());
        assert!(!journal_path(root, &copy_rel).exists());
    }

    #[cfg(windows)]
    #[test]
    fn locked_copy_fails_without_changing_content_or_identity() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.bin"), b"same-content").unwrap();
        fs::write(root.join("b.bin"), b"same-content").unwrap();
        let before = crate::rules::file_identity(&root.join("b.bin"))
            .unwrap()
            .unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(root.join("b.bin"))
            .unwrap();

        let report = merge_duplicates(root, &[group(root, 12, &["a.bin", "b.bin"])]);
        drop(lock);
        assert_eq!(report.merged_files, 0);
        assert_eq!(report.failed, 1);
        assert_eq!(fs::read(root.join("b.bin")).unwrap(), b"same-content");
        assert_eq!(
            crate::rules::file_identity(&root.join("b.bin")).unwrap(),
            Some(before)
        );
        assert!(!root.join("b.ss-merge-bak").exists());
        assert!(!journal_path(root, "b.bin").exists());
    }

    #[cfg(windows)]
    #[test]
    fn access_denied_copy_is_preserved_and_acl_is_restored() {
        struct ResetAcl(PathBuf);
        impl Drop for ResetAcl {
            fn drop(&mut self) {
                let _ = std::process::Command::new("icacls")
                    .arg(&self.0)
                    .args(["/reset"])
                    .status();
            }
        }

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let copy = root.join("b.bin");
        fs::write(root.join("a.bin"), b"same-content").unwrap();
        fs::write(&copy, b"same-content").unwrap();
        let reset = ResetAcl(copy.clone());
        let user = std::env::var("USERNAME").unwrap();
        let status = std::process::Command::new("icacls")
            .arg(&copy)
            .args(["/deny", &format!("{user}:(R,W)")])
            .status()
            .unwrap();
        assert!(status.success());

        let report = merge_duplicates(root, &[group(root, 12, &["a.bin", "b.bin"])]);
        assert_eq!(report.merged_files, 0);
        assert_eq!(report.failed, 1);
        assert!(!root.join("b.ss-merge-bak").exists());
        assert!(!journal_path(root, "b.bin").exists());
        drop(reset);
        assert_eq!(fs::read(copy).unwrap(), b"same-content");
    }
}
