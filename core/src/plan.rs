//! 可信清理计划：扫描基线、保留边界、执行前复核与空间结果口径。
//! 删除动作仍只进入系统回收站；本模块不会永久删除或清空回收站。

use crate::model::*;
use crate::rules::{self, AnalysisReport, DupeGroup, RuleHit};
use crate::scanner::parent_of;
use crate::{ScanConfig, Scanner};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// 规范化扫描根内的相对路径，拒绝绝对路径、盘符和父级跳转。
pub fn normalize_relative(path: &str) -> Result<String, String> {
    let original = path.trim();
    if original.is_empty() || original.contains('\0') {
        return Err("路径为空或包含无效字符".into());
    }
    let replaced = original.replace('\\', "/");
    if replaced.starts_with('/') {
        return Err(format!("{original}：不允许绝对路径"));
    }
    let mut parts = Vec::new();
    for (index, part) in replaced.split('/').enumerate() {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." || (index == 0 && part.ends_with(':')) {
            return Err(format!("{original}：路径必须位于扫描根目录内"));
        }
        parts.push(part);
    }
    if parts.is_empty() {
        return Err("不允许把整个扫描根目录作为清理目标".into());
    }
    Ok(parts.join("/"))
}

fn normalize_dirs(paths: &[String]) -> Result<Vec<String>, String> {
    let mut result = paths
        .iter()
        .map(|path| normalize_relative(path))
        .collect::<Result<Vec<_>, _>>()?;
    result.sort();
    result.dedup();
    Ok(result)
}

#[cfg(windows)]
fn comparison_key(path: &str) -> String {
    // Windows 普通目录不区分大小写。保护判断宁可保守多拦截，也不能漏掉同一目录。
    path.to_lowercase()
}

#[cfg(not(windows))]
fn comparison_key(path: &str) -> String {
    path.to_string()
}

fn within(path: &str, dir: &str) -> bool {
    let path = comparison_key(path);
    let dir = comparison_key(dir);
    path == dir
        || path
            .strip_prefix(&dir)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// 目标本身位于保护目录，或目标是保护目录的祖先时，都必须拦截。
pub fn protection_reason(
    rel_path: &str,
    reference_dirs: &[String],
    excluded_dirs: &[String],
) -> Option<String> {
    if reference_dirs
        .iter()
        .any(|dir| within(rel_path, dir) || within(dir, rel_path))
    {
        return Some("位于参考目录保护范围".into());
    }
    if excluded_dirs
        .iter()
        .any(|dir| within(rel_path, dir) || within(dir, rel_path))
    {
        return Some("位于排除目录范围".into());
    }
    None
}

// 确定性的元数据清单指纹，只用于变化检测，不用于内容判重或安全凭证。
const PRIME1: u64 = 0x9E3779B185EBCA87;
const PRIME2: u64 = 0xC2B2C2D7A8B9C1D3;
const PRIME3: u64 = 0x165667B19E3779F9;
const PRIME4: u64 = 0x85EBCA77C2B2AE63;
const PRIME5: u64 = 0x27D4EB2F165667C5;

#[derive(Clone)]
struct ManifestHash {
    state: u64,
    length: u64,
}

impl ManifestHash {
    fn new() -> Self {
        Self {
            state: 0,
            length: 0,
        }
    }

    // 采用带长度记录的交换律组合，使目录枚举顺序不影响最终指纹。
    fn record(&mut self, tag: u8, rel: &str, size: u64, modified: Option<i64>) {
        let mut hash = tag as u64;
        for byte in rel.as_bytes() {
            hash ^= *byte as u64;
            hash = hash
                .wrapping_mul(PRIME1)
                .rotate_left(13)
                .wrapping_mul(PRIME2);
        }
        hash ^= size.wrapping_mul(PRIME3);
        hash ^= (modified.unwrap_or(i64::MIN) as u64).wrapping_mul(PRIME4);
        hash ^= (rel.len() as u64).wrapping_mul(PRIME5);
        hash ^= hash >> 29;
        self.state = self.state.wrapping_add(hash);
        self.length += 1;
    }

    fn finish(&self) -> String {
        let mut value = self.state ^ self.length.wrapping_mul(PRIME2);
        value ^= value >> 33;
        value = value.wrapping_mul(PRIME2);
        value ^= value >> 29;
        value = value.wrapping_mul(PRIME3);
        value ^= value >> 32;
        format!("{value:016x}")
    }
}

fn descendant<'a>(ancestor: &str, rel: &'a str) -> &'a str {
    if ancestor == "." {
        rel
    } else {
        &rel[ancestor.len() + 1..]
    }
}

fn record_for_ancestors(
    manifests: &mut HashMap<String, ManifestHash>,
    rel: &str,
    tag: u8,
    size: u64,
    modified: Option<i64>,
) {
    let mut ancestor = parent_of(rel).to_string();
    loop {
        manifests
            .entry(ancestor.clone())
            .or_insert_with(ManifestHash::new)
            .record(tag, descendant(&ancestor, rel), size, modified);
        if ancestor == "." {
            break;
        }
        ancestor = parent_of(&ancestor).to_string();
    }
}

/// 自底向上建立所有目录的后代清单指纹；排序消除 read_dir 顺序差异。
fn directory_manifests(outcome: &ScanOutcome) -> HashMap<String, String> {
    let mut manifests = HashMap::new();
    manifests.insert(".".to_string(), ManifestHash::new());
    let mut dirs: Vec<_> = outcome
        .dirs
        .iter()
        .filter(|dir| dir.rel_path != ".")
        .collect();
    dirs.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    for dir in dirs {
        record_for_ancestors(&mut manifests, &dir.rel_path, b'D', 0, None);
    }
    let mut files: Vec<_> = outcome.files.iter().collect();
    files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    for file in files {
        record_for_ancestors(
            &mut manifests,
            &file.rel_path,
            b'F',
            file.size,
            file.modified,
        );
    }
    manifests
        .into_iter()
        .map(|(path, hash)| (path, hash.finish()))
        .collect()
}

pub fn scan_id(outcome: &ScanOutcome) -> String {
    directory_manifests(outcome)
        .remove(".")
        .unwrap_or_else(|| ManifestHash::new().finish())
}

fn identity_string(path: &Path) -> Option<String> {
    rules::file_identity(path)
        .ok()
        .flatten()
        .map(|(volume, index)| format!("{volume:016x}:{index:016x}"))
}

fn index_tree(tree: &DirStat, output: &mut HashMap<String, (u64, u64, bool)>) {
    output.insert(
        tree.rel_path.clone(),
        (tree.total_size, tree.file_count, !tree.has_errors),
    );
    for child in &tree.children {
        index_tree(child, output);
    }
}

/// 给所有可能被用户选择的目录和文件建立执行基线。
pub fn build_expectations(
    root: &Path,
    outcome: &ScanOutcome,
    tree: &DirStat,
    cache_hits: &[RuleHit],
    big_files: &[FileEntry],
    dupe_groups: &[DupeGroup],
) -> Vec<TargetExpectation> {
    let manifests = directory_manifests(outcome);
    let mut tree_info = HashMap::new();
    index_tree(tree, &mut tree_info);
    let files: HashMap<_, _> = outcome
        .files
        .iter()
        .map(|file| (file.rel_path.as_str(), file))
        .collect();
    let dirs: HashSet<&str> = cache_hits.iter().map(|hit| hit.rel_path.as_str()).collect();
    let file_paths: HashSet<&str> = big_files
        .iter()
        .map(|file| file.rel_path.as_str())
        .chain(
            dupe_groups
                .iter()
                .flat_map(|group| group.files.iter().map(String::as_str)),
        )
        .collect();
    let mut result = Vec::new();

    for rel in dirs {
        let Some((size, count, complete)) = tree_info.get(rel).copied() else {
            continue;
        };
        result.push(TargetExpectation {
            rel_path: rel.to_string(),
            is_dir: true,
            logical_size: size,
            file_count: count,
            modified: None,
            manifest_hash: manifests.get(rel).cloned(),
            file_id: None,
            complete: complete && manifests.contains_key(rel),
        });
    }
    for rel in file_paths {
        let Some(file) = files.get(rel) else {
            continue;
        };
        let absolute = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        let file_id = identity_string(&absolute);
        #[cfg(any(windows, unix))]
        let complete = file_id.is_some();
        #[cfg(not(any(windows, unix)))]
        let complete = true;
        result.push(TargetExpectation {
            rel_path: rel.to_string(),
            is_dir: false,
            logical_size: file.size,
            file_count: 1,
            modified: file.modified,
            manifest_hash: None,
            file_id,
            complete,
        });
    }
    result.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    result
}

/// 从用户选择生成固定计划；参考目录和每组至少保留一份在这里再次约束。
pub fn build_cleanup_plan(
    analysis: &AnalysisReport,
    selected_paths: &[String],
    reference_dirs: &[String],
    excluded_dirs: &[String],
) -> Result<CleanupPlan, String> {
    let reference_dirs = normalize_dirs(reference_dirs)?;
    let excluded_dirs = normalize_dirs(excluded_dirs)?;
    let mut selected = selected_paths
        .iter()
        .map(|path| normalize_relative(path))
        .collect::<Result<Vec<_>, _>>()?;
    selected.sort_by_key(|path| path.len());
    selected.dedup();
    for rel in &selected {
        if let Some(reason) = protection_reason(rel, &reference_dirs, &excluded_dirs) {
            return Err(format!("{rel}：{reason}，不能加入清理计划"));
        }
    }
    let expectations: HashMap<_, _> = analysis
        .cleanup_targets
        .iter()
        .map(|target| (target.rel_path.as_str(), target))
        .collect();
    let mut unique = Vec::new();
    for rel in selected {
        if unique.iter().any(|parent: &PlannedTarget| {
            parent.expectation.is_dir && within(&rel, &parent.expectation.rel_path)
        }) {
            continue;
        }
        let expectation = (**expectations
            .get(rel.as_str())
            .ok_or_else(|| format!("{rel}：缺少扫描基线，请重新分析"))?)
        .clone();
        unique.push(PlannedTarget {
            expectation,
            action: CleanupAction::MoveToTrash,
        });
    }

    let mut duplicate_checks = Vec::new();
    for group in &analysis.dupe_groups {
        let is_selected = |file: &String| {
            unique.iter().any(|target: &PlannedTarget| {
                target.expectation.is_dir && within(file, &target.expectation.rel_path)
                    || target.expectation.rel_path == *file
            })
        };
        let survives = group.files.iter().any(|file| !is_selected(file));
        if !survives {
            return Err(format!(
                "重复组 {} 不能删除全部副本，每组至少保留一份",
                group.hash
            ));
        }
        if group.files.iter().any(is_selected) {
            for copy in group.files.iter().skip(1) {
                duplicate_checks.push(DuplicateContentCheck {
                    anchor: group.files[0].clone(),
                    copy: copy.clone(),
                    expected_hash: group.hash,
                });
            }
        }
    }
    Ok(CleanupPlan {
        scan_id: analysis.scan_id.clone(),
        targets: unique,
        reference_dirs,
        excluded_dirs,
        duplicate_checks,
    })
}

/// 合并前验证所有组，任何保留边界冲突都在首个文件变化前中止。
pub fn validate_merge_groups(
    groups: &[DupeGroup],
    reference_dirs: &[String],
    excluded_dirs: &[String],
) -> Result<(), String> {
    let reference_dirs = normalize_dirs(reference_dirs)?;
    let excluded_dirs = normalize_dirs(excluded_dirs)?;
    for group in groups {
        if group.files.len() < 2 {
            return Err(format!("重复组 {} 不足两份，无法合并", group.hash));
        }
        for file in &group.files {
            normalize_relative(file)?;
        }
        for copy in &group.files[1..] {
            if let Some(reason) = protection_reason(copy, &reference_dirs, &excluded_dirs) {
                return Err(format!(
                    "{copy}：{reason}，不能作为合并目标；请把该路径设为保留项"
                ));
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_system_critical(path: &Path) -> bool {
    let target = path.display().to_string().to_lowercase();
    [
        "SystemRoot",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramData",
    ]
    .iter()
    .filter_map(std::env::var_os)
    .filter_map(|value| PathBuf::from(value).canonicalize().ok())
    .any(|critical| {
        let prefix = critical.display().to_string().to_lowercase();
        target == prefix
            || target
                .strip_prefix(&prefix)
                .is_some_and(|rest| rest.starts_with('\\'))
    })
}

#[cfg(not(windows))]
fn is_system_critical(_path: &Path) -> bool {
    false
}

pub fn resolve_cleanup_target(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = normalize_relative(rel)?;
    let absolute = root
        .join(rel.replace('/', std::path::MAIN_SEPARATOR_STR))
        .canonicalize()
        .map_err(|error| format!("无法重新解析目标：{error}"))?;
    if absolute == root {
        return Err("拒绝处理整个扫描根目录".into());
    }
    if !absolute.starts_with(root) {
        return Err("链接或路径解析后越出扫描根目录".into());
    }
    if is_system_critical(&absolute) {
        return Err("目标位于系统关键目录保护范围".into());
    }
    Ok(absolute)
}

struct VerifyFailure {
    status: &'static str,
    detail: String,
}

fn changed(detail: impl Into<String>) -> VerifyFailure {
    VerifyFailure {
        status: "skipped_changed",
        detail: detail.into(),
    }
}

fn protected(detail: impl Into<String>) -> VerifyFailure {
    VerifyFailure {
        status: "skipped_protected",
        detail: detail.into(),
    }
}

fn verify_target(
    root: &Path,
    target: &PlannedTarget,
    plan: &CleanupPlan,
) -> Result<PathBuf, VerifyFailure> {
    let expected = &target.expectation;
    if !expected.complete {
        return Err(changed("原始扫描不完整或文件身份未知，请重新分析"));
    }
    if let Some(reason) = protection_reason(
        &expected.rel_path,
        &plan.reference_dirs,
        &plan.excluded_dirs,
    ) {
        return Err(protected(reason));
    }
    let absolute = resolve_cleanup_target(root, &expected.rel_path).map_err(protected)?;
    if expected.is_dir {
        let outcome = Scanner::new(ScanConfig {
            follow_links: false,
            progress_every: u64::MAX,
        })
        .scan(&absolute, |_, _| {});
        if outcome.cancelled || !outcome.errors.is_empty() {
            return Err(changed("目录重新扫描不完整，未执行"));
        }
        if outcome.total_bytes() != expected.logical_size
            || outcome.file_count() != expected.file_count
            || scan_id(&outcome) != expected.manifest_hash.as_deref().unwrap_or("")
        {
            return Err(changed("目录内容自分析后发生变化，未执行"));
        }
    } else {
        let metadata = std::fs::symlink_metadata(&absolute)
            .map_err(|error| changed(format!("无法复核文件：{error}")))?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(changed("目标已不再是普通文件，未执行"));
        }
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs() as i64);
        if metadata.len() != expected.logical_size || modified != expected.modified {
            return Err(changed("文件大小或修改时间已变化，未执行"));
        }
        if let Some(expected_id) = &expected.file_id {
            if identity_string(&absolute).as_deref() != Some(expected_id.as_str()) {
                return Err(changed("文件实体已变化，未执行"));
            }
        }
    }
    Ok(absolute)
}

fn verify_duplicate_content(root: &Path, plan: &CleanupPlan) -> Result<(), String> {
    for check in &plan.duplicate_checks {
        let verify = || -> std::io::Result<bool> {
            let anchor = root.join(check.anchor.replace('/', std::path::MAIN_SEPARATOR_STR));
            let copy = root.join(check.copy.replace('/', std::path::MAIN_SEPARATOR_STR));
            let anchor_hash = rules::hash_file_for_merge(&anchor)?;
            let copy_hash = rules::hash_file_for_merge(&copy)?;
            Ok(anchor_hash == check.expected_hash
                && copy_hash == check.expected_hash
                && rules::files_have_same_content(&anchor, &copy)?)
        };
        match verify() {
            Ok(true) => {}
            Ok(false) => {
                return Err(format!(
                    "重复内容最终确认失败：{} 与 {} 已变化或不一致，未执行任何清理",
                    check.anchor, check.copy
                ));
            }
            Err(error) => {
                return Err(format!(
                    "重复内容最终确认无法读取：{} 与 {}：{error}，未执行任何清理",
                    check.anchor, check.copy
                ));
            }
        }
    }
    Ok(())
}

/// 逐项复核并移入回收站。回收站结果只记为待清空，不伪造实际释放字节。
pub fn execute_cleanup_plan(
    root: &Path,
    plan: &CleanupPlan,
) -> Result<CleanupExecutionReport, String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("扫描根目录不可解析：{error}"))?;
    verify_duplicate_content(&root, plan)?;
    let mut results = Vec::new();
    for target in &plan.targets {
        let expected = &target.expectation;
        match verify_target(&root, target, plan) {
            Ok(absolute) => {
                let report = crate::cleanup::move_to_trash([&absolute]);
                if let Some(item) = report.results.first() {
                    results.push(CleanupItemResult {
                        path: expected.rel_path.clone(),
                        status: if item.ok {
                            "moved_to_trash".into()
                        } else {
                            "failed".into()
                        },
                        logical_bytes: expected.logical_size,
                        detail: item.error.clone(),
                    });
                }
            }
            Err(error) => results.push(CleanupItemResult {
                path: expected.rel_path.clone(),
                status: error.status.into(),
                logical_bytes: expected.logical_size,
                detail: Some(error.detail),
            }),
        }
    }
    let succeeded = results
        .iter()
        .filter(|item| item.status == "moved_to_trash")
        .count();
    let skipped = results
        .iter()
        .filter(|item| item.status.starts_with("skipped_"))
        .count();
    let failed = results
        .iter()
        .filter(|item| item.status == "failed")
        .count();
    Ok(CleanupExecutionReport {
        scan_id: plan.scan_id.clone(),
        selected_logical_bytes: plan
            .targets
            .iter()
            .map(|target| target.expectation.logical_size)
            .sum(),
        pending_recycle_bin_bytes: results
            .iter()
            .filter(|item| item.status == "moved_to_trash")
            .map(|item| item.logical_bytes)
            .sum(),
        results,
        succeeded,
        skipped,
        failed,
        verified_freed_bytes: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{stats, ScanConfig, Scanner};
    use std::fs;

    fn analysis(root: &Path) -> AnalysisReport {
        let outcome = Scanner::new(ScanConfig::default()).scan(root, |_, _| {});
        let tree = stats::aggregate(&outcome);
        rules::analyze_light(&outcome, &tree, 50)
    }

    #[test]
    fn relative_paths_cannot_escape_or_use_drive_names() {
        for path in [
            "../outside",
            "a/../../outside",
            "C:/outside",
            "/outside",
            ".",
        ] {
            assert!(normalize_relative(path).is_err(), "应拒绝 {path}");
        }
        assert_eq!(normalize_relative("a\\b/./c").unwrap(), "a/b/c");
    }

    #[test]
    fn reference_directory_also_protects_its_ancestors() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("cache/originals")).unwrap();
        fs::write(tmp.path().join("cache/originals/a.bin"), b"keep").unwrap();
        let report = analysis(tmp.path());
        let error =
            build_cleanup_plan(&report, &["cache".into()], &["cache/originals".into()], &[])
                .unwrap_err();
        assert!(error.contains("参考目录"));
    }

    #[cfg(windows)]
    #[test]
    fn protection_directories_ignore_windows_case() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("cache/originals")).unwrap();
        fs::write(tmp.path().join("cache/originals/a.bin"), b"keep").unwrap();
        let report = analysis(tmp.path());

        let reference =
            build_cleanup_plan(&report, &["cache".into()], &["Cache/Originals".into()], &[])
                .unwrap_err();
        assert!(reference.contains("参考目录"));
        let excluded =
            build_cleanup_plan(&report, &["cache".into()], &[], &["Cache/Originals".into()])
                .unwrap_err();
        assert!(excluded.contains("排除目录"));
        assert!(tmp.path().join("cache/originals/a.bin").exists());
    }

    #[test]
    fn changed_directory_is_skipped_without_deleting_new_content() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("cache")).unwrap();
        fs::write(tmp.path().join("cache/a.bin"), b"old").unwrap();
        let report = analysis(tmp.path());
        let plan = build_cleanup_plan(&report, &["cache".into()], &[], &[]).unwrap();
        fs::write(tmp.path().join("cache/new.bin"), b"new").unwrap();
        let execution = execute_cleanup_plan(tmp.path(), &plan).unwrap();
        assert_eq!(execution.succeeded, 0);
        assert_eq!(execution.skipped, 1);
        assert_eq!(execution.results[0].status, "skipped_changed");
        assert!(tmp.path().join("cache/new.bin").exists());
        assert_eq!(execution.verified_freed_bytes, None);
    }

    #[test]
    fn trash_success_is_pending_not_verified_free_space() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("cache")).unwrap();
        fs::write(tmp.path().join("cache/a.bin"), b"cache").unwrap();
        let report = analysis(tmp.path());
        let plan = build_cleanup_plan(&report, &["cache".into()], &[], &[]).unwrap();
        let execution = execute_cleanup_plan(tmp.path(), &plan).unwrap();
        assert_eq!(execution.succeeded, 1, "结果：{:?}", execution.results);
        assert_eq!(execution.pending_recycle_bin_bytes, 5);
        assert_eq!(execution.verified_freed_bytes, None);
        assert!(!tmp.path().join("cache").exists());
    }

    #[test]
    fn duplicate_group_must_keep_at_least_one_path() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("a.bin"), b"same").unwrap();
        fs::write(tmp.path().join("b.bin"), b"same").unwrap();
        let outcome = Scanner::new(ScanConfig::default()).scan(tmp.path(), |_, _| {});
        let tree = stats::aggregate(&outcome);
        let report = rules::analyze(tmp.path(), &outcome, &tree, 50, 1, None);
        let error =
            build_cleanup_plan(&report, &["a.bin".into(), "b.bin".into()], &[], &[]).unwrap_err();
        assert!(error.contains("至少保留一份"));
    }

    #[test]
    fn changed_duplicate_anchor_blocks_all_trash_operations() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("a.bin"), b"same").unwrap();
        fs::write(tmp.path().join("b.bin"), b"same").unwrap();
        let outcome = Scanner::new(ScanConfig::default()).scan(tmp.path(), |_, _| {});
        let tree = stats::aggregate(&outcome);
        let report = rules::analyze(tmp.path(), &outcome, &tree, 50, 1, None);
        let plan = build_cleanup_plan(&report, &["b.bin".into()], &[], &[]).unwrap();
        assert_eq!(plan.duplicate_checks.len(), 1);

        fs::write(tmp.path().join("a.bin"), b"DIFF").unwrap();
        let error = execute_cleanup_plan(tmp.path(), &plan).unwrap_err();
        assert!(error.contains("最终确认失败"));
        assert!(tmp.path().join("a.bin").exists());
        assert!(tmp.path().join("b.bin").exists());
    }

    #[test]
    fn missing_duplicate_anchor_blocks_other_trash_targets() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir(tmp.path().join("cache")).unwrap();
        fs::write(tmp.path().join("cache/old.tmp"), b"old").unwrap();
        fs::write(tmp.path().join("a.bin"), b"same").unwrap();
        fs::write(tmp.path().join("b.bin"), b"same").unwrap();
        let outcome = Scanner::new(ScanConfig::default()).scan(tmp.path(), |_, _| {});
        let tree = stats::aggregate(&outcome);
        let report = rules::analyze(tmp.path(), &outcome, &tree, 50, 1, None);
        let plan =
            build_cleanup_plan(&report, &["b.bin".into(), "cache".into()], &[], &[]).unwrap();

        fs::remove_file(tmp.path().join("a.bin")).unwrap();
        let error = execute_cleanup_plan(tmp.path(), &plan).unwrap_err();
        assert!(error.contains("无法读取"));
        assert!(tmp.path().join("b.bin").exists());
        assert!(tmp.path().join("cache/old.tmp").exists());
    }

    #[test]
    fn unreadable_duplicate_anchor_blocks_all_trash_operations() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("a.bin"), b"same").unwrap();
        fs::write(tmp.path().join("b.bin"), b"same").unwrap();
        let outcome = Scanner::new(ScanConfig::default()).scan(tmp.path(), |_, _| {});
        let tree = stats::aggregate(&outcome);
        let report = rules::analyze(tmp.path(), &outcome, &tree, 50, 1, None);
        let plan = build_cleanup_plan(&report, &["b.bin".into()], &[], &[]).unwrap();

        fs::remove_file(tmp.path().join("a.bin")).unwrap();
        fs::create_dir(tmp.path().join("a.bin")).unwrap();
        let error = execute_cleanup_plan(tmp.path(), &plan).unwrap_err();
        assert!(error.contains("无法读取"));
        assert!(tmp.path().join("b.bin").exists());
    }
}
