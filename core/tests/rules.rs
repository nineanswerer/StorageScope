//! 规则引擎集成测试：在构造的目录上验证缓存识别、大文件榜单与重复文件检测。

use std::fs;
use std::path::Path;
use storagescope_core::rules::{self, Safety};
use storagescope_core::{stats, ScanConfig, Scanner};

/// 构造一个包含已知答案的目录：
/// - 三份内容相同的重复文件（含一份在深层目录）
/// - 两个名字相同但内容不同的文件（不得判为重复）
/// - lightspeed-cache 与 logs 目录（应命中缓存规则）
/// - cache 外套 cache（子级不得重复统计）
fn build_case(root: &Path) {
    let dupe_content: Vec<u8> = (0..150_000u32).map(|i| (i * 13 + 7) as u8).collect();

    let a = root.join("游戏A/mods");
    let b = root.join("游戏B/mods");
    let deep = root.join("游戏A/备份/深层");
    fs::create_dir_all(&a).unwrap();
    fs::create_dir_all(&b).unwrap();
    fs::create_dir_all(&deep).unwrap();

    fs::write(a.join("jei.jar"), &dupe_content).unwrap();
    fs::write(b.join("jei.jar"), &dupe_content).unwrap();
    fs::write(deep.join("jei-backup.jar"), &dupe_content).unwrap();

    // 同名不同内容：不是重复
    fs::write(a.join("config.txt"), b"aaa").unwrap();
    fs::write(b.join("config.txt"), b"bbb").unwrap();

    // 同大小不同内容：大小碰撞，头部指纹应分流
    fs::write(a.join("x.bin"), vec![1u8; 5000]).unwrap();
    fs::write(b.join("y.bin"), vec![2u8; 5000]).unwrap();

    // 缓存规则目录
    let cache = root.join("游戏A/lightspeed-cache/1.20.1");
    fs::create_dir_all(&cache).unwrap();
    fs::write(cache.join("a.ser"), vec![9u8; 20_000]).unwrap();

    let logs = root.join("游戏A/logs");
    fs::create_dir_all(&logs).unwrap();
    fs::write(logs.join("latest.log"), b"log text").unwrap();

    // 嵌套 cache：外层命中后内层不得重复计数
    let nested = root.join("工具/cache/inner/cache");
    fs::create_dir_all(&nested).unwrap();
    fs::write(nested.join("t.tmp"), vec![5u8; 1000]).unwrap();

    // 一个明显的大文件；同目录的小文件不得进入大文件清单。
    fs::write(root.join("光影包.zip"), vec![7u8; 2_000_000]).unwrap();
}

#[test]
fn rules_detect_cache_bigfiles_and_dupes() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("case");
    build_case(&root);

    let outcome = Scanner::new(ScanConfig::default()).scan(&root, |_, _| {});
    assert!(outcome.is_complete(), "构造目录不应产生扫描异常");
    let tree = stats::aggregate(&outcome);
    let report = rules::analyze(&root, &outcome, &tree, 10, 1, None);

    // ── 缓存识别 ──
    let cache_paths: Vec<&str> = report
        .cache_hits
        .iter()
        .map(|h| h.rel_path.as_str())
        .collect();
    assert!(
        cache_paths.contains(&"游戏A/lightspeed-cache"),
        "应命中 lightspeed-cache，实际：{cache_paths:?}"
    );
    assert!(
        cache_paths.contains(&"游戏A/logs"),
        "应命中 logs，实际：{cache_paths:?}"
    );
    assert!(
        cache_paths.contains(&"工具/cache"),
        "应命中外层 cache，实际：{cache_paths:?}"
    );
    assert!(
        !cache_paths.contains(&"工具/cache/inner/cache"),
        "嵌套 cache 不得重复统计：{cache_paths:?}"
    );
    let cache_hit = report
        .cache_hits
        .iter()
        .find(|h| h.rel_path == "工具/cache")
        .unwrap();
    assert_eq!(cache_hit.size, 1000, "外层命中应含整棵子树的大小");
    assert!(matches!(cache_hit.safety, Safety::ReviewAdvised));

    // ── 大文件猎人 ──
    assert_eq!(report.big_files[0].rel_path, "光影包.zip");
    assert_eq!(report.big_files[0].size, 2_000_000);
    assert!(report
        .big_files
        .iter()
        .all(|f| f.size >= rules::BIG_FILE_MIN_SIZE));
    assert!(!report
        .big_files
        .iter()
        .any(|f| f.rel_path.ends_with("latest.log")));

    // ── 重复文件检测 ──
    assert_eq!(
        report.dupe_groups.len(),
        1,
        "应恰好一组重复：{:?}",
        report.dupe_groups
    );
    let g = &report.dupe_groups[0];
    assert_eq!(g.files.len(), 3);
    assert_eq!(g.size, 150_000);
    assert_eq!(g.wasted, 300_000, "3 份冗余 2 份");
    assert!(g.files.contains(&"游戏A/mods/jei.jar".to_string()));
    assert!(g.files.contains(&"游戏B/mods/jei.jar".to_string()));
    assert!(g
        .files
        .contains(&"游戏A/备份/深层/jei-backup.jar".to_string()));
    assert_eq!(report.hash_errors, 0);

    // 候选逻辑大小包含全部候选与重复冗余，分类可能重叠，不能称为实际释放。
    let expected_cache: u64 = 20_000 + 8 + 1000; // cache + logs("log text") + 嵌套
    assert_eq!(report.candidate_logical_bytes, expected_cache + 300_000);
    assert!(report
        .cache_hits
        .iter()
        .all(|hit| hit.safety == Safety::ReviewAdvised));
    assert!(!report.scan_id.is_empty());
    assert!(report
        .cleanup_targets
        .iter()
        .any(|target| target.rel_path == "工具/cache" && target.manifest_hash.is_some()));
}

#[test]
fn dupes_respect_cancellation_free_empty_dir() {
    // 空目录：无候选，不得 panic，结果为空
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("empty");
    fs::create_dir_all(&root).unwrap();
    let outcome = Scanner::new(ScanConfig::default()).scan(&root, |_, _| {});
    let (groups, hashed, errors) = rules::find_duplicates(&root, &outcome, 1, None);
    assert!(groups.is_empty());
    assert_eq!(hashed, 0);
    assert_eq!(errors, 0);
}

#[test]
fn duplicate_hashing_stops_when_operation_is_cancelled() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    // 进度回调每 200 个文件触发；202 组确保测试覆盖真实的阶段内取消。
    for index in 0..202 {
        let content = format!("duplicate-content-{index:04}");
        fs::write(root.join(format!("a-{index}.bin")), &content).unwrap();
        fs::write(root.join(format!("b-{index}.bin")), &content).unwrap();
    }
    let outcome = Scanner::new(ScanConfig::default()).scan(root, |_, _| {});
    let cancel = std::sync::atomic::AtomicBool::new(false);
    let mut progress = |done, _total| {
        if done > 0 {
            cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    };
    let error =
        rules::find_duplicates_cancellable(root, &outcome, 1, Some(&mut progress), Some(&cancel))
            .unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::Interrupted);
}

#[test]
fn existing_hard_links_are_not_counted_as_reclaimable_duplicates() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    fs::write(root.join("a.bin"), b"same-content").unwrap();
    fs::write(root.join("c.bin"), b"same-content").unwrap();
    fs::hard_link(root.join("a.bin"), root.join("b.bin")).unwrap();
    let outcome = Scanner::new(ScanConfig::default()).scan(root, |_, _| {});
    let (groups, _, errors) = rules::find_duplicates(root, &outcome, 1, None);

    assert_eq!(errors, 0);
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].files.len(), 2, "同一硬链接只保留一个路径代表");
    assert_eq!(groups[0].wasted, 12, "只有另一份独立实体可释放 12 字节");
    let linked_paths = groups[0]
        .files
        .iter()
        .filter(|path| path.as_str() == "a.bin" || path.as_str() == "b.bin")
        .count();
    assert_eq!(linked_paths, 1);
}

#[test]
fn dupe_hash_json_preserves_all_u64_bits() {
    let group = rules::DupeGroup {
        size: 1,
        hash: u64::MAX - 1,
        files: vec!["a.bin".into(), "b.bin".into()],
        wasted: 1,
    };
    let encoded = serde_json::to_string(&group).unwrap();
    assert!(encoded.contains("\"hash\":\"18446744073709551614\""));
    let decoded: rules::DupeGroup = serde_json::from_str(&encoded).unwrap();
    assert_eq!(decoded.hash, u64::MAX - 1);
}

#[test]
fn scan_root_is_never_a_cache_cleanup_target() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("cache");
    fs::create_dir_all(root.join("logs")).unwrap();
    fs::write(root.join("logs/latest.log"), b"log").unwrap();
    let outcome = Scanner::new(ScanConfig::default()).scan(&root, |_, _| {});
    let tree = stats::aggregate(&outcome);
    let hits = rules::find_cache_hits(&tree);
    assert!(hits.iter().all(|hit| !hit.rel_path.is_empty()));
    assert!(hits.iter().any(|hit| hit.rel_path == "logs"));
}

#[test]
fn backup_directory_names_are_not_cleanup_suggestions() {
    let tmp = tempfile::tempdir().unwrap();
    for name in ["backup", "backups", "Backup"] {
        fs::create_dir_all(tmp.path().join(name)).unwrap();
        fs::write(tmp.path().join(name).join("only-copy.bin"), b"important").unwrap();
    }
    let outcome = Scanner::new(ScanConfig::default()).scan(tmp.path(), |_, _| {});
    let tree = stats::aggregate(&outcome);
    let hits = rules::find_cache_hits(&tree);
    assert!(hits.is_empty(), "备份目录不应成为清理候选：{hits:?}");
}
