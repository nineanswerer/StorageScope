//! 差异引擎测试：对已知合成数据集，逐一验证新增、删除、增长、
//! 缩减、重命名（表现为删除＋新增）、大小写改名与不可比快照的处理。

use std::fs;
use std::path::Path;
use storagescope_core::diff::{self, ChangeKind};
use storagescope_core::{fixtures, snapshot, ScanConfig, Scanner};

fn scan_and_save(root: &Path, db: &Path) -> i64 {
    let scanner = Scanner::new(ScanConfig::default());
    let outcome = scanner.scan(root, |_, _| {});
    let conn = snapshot::open(db).unwrap();
    snapshot::save(&conn, &outcome)
        .unwrap()
        .expect("完整扫描应入库")
}

#[test]
fn diff_covers_all_change_kinds() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("fixture");
    let db = tmp.path().join("test.db");
    fixtures::generate(&root).unwrap();

    let old_id = scan_and_save(&root, &db);

    // 制造确定的变更集
    // a) 新增文件
    fs::write(root.join("new.txt"), vec![0u8; 50]).unwrap();
    // b) 删除文件
    fs::remove_file(root.join("单文件目录/one.txt")).unwrap();
    // c) 增长：100 → 150
    fs::write(root.join("中文目录 带空格/数据 文件.txt"), vec![1u8; 150]).unwrap();
    // d) 缩减：11 → 5
    fs::write(root.join("CaseTest/Report.TXT"), vec![2u8; 5]).unwrap();
    // e) 重命名：应表现为 删除＋新增
    fs::rename(
        root.join("emoji 🎮/存档 💾.dat"),
        root.join("emoji 🎮/存档2 💾.dat"),
    )
    .unwrap();
    // f) 新增目录（含文件）
    fs::create_dir(root.join("新目录")).unwrap();
    fs::write(root.join("新目录/a.dat"), vec![3u8; 200]).unwrap();
    fs::write(root.join("新目录/b.dat"), vec![4u8; 300]).unwrap();
    // g) 仅改变大小写：不应产生任何差异
    fs::rename(
        root.join("CaseTest/report2.txt"),
        root.join("CaseTest/REPORT2.txt"),
    )
    .unwrap();

    let new_id = scan_and_save(&root, &db);

    let conn = snapshot::open(&db).unwrap();
    let report = diff::diff(&conn, old_id, new_id).unwrap();
    assert!(report.warnings.is_empty(), "两个完整快照不应有警告");

    let find = |rel: &str| report.files.iter().find(|c| c.rel_path == rel);

    // 新增
    let c = find("new.txt").expect("缺少 new.txt 新增记录");
    assert_eq!(c.kind, ChangeKind::Added);
    assert_eq!(c.new_size, Some(50));
    // 删除
    let c = find("单文件目录/one.txt").expect("缺少 one.txt 删除记录");
    assert_eq!(c.kind, ChangeKind::Removed);
    assert_eq!(c.old_size, Some(5));
    // 增长
    let c = find("中文目录 带空格/数据 文件.txt").expect("缺少增长记录");
    assert_eq!(c.kind, ChangeKind::Grown);
    assert_eq!(c.old_size, Some(100));
    assert_eq!(c.new_size, Some(150));
    // 缩减
    let c = find("CaseTest/Report.TXT").expect("缺少缩减记录");
    assert_eq!(c.kind, ChangeKind::Shrunk);
    assert_eq!(c.old_size, Some(11));
    assert_eq!(c.new_size, Some(5));
    // 重命名 = 删除＋新增
    assert_eq!(
        find("emoji 🎮/存档 💾.dat").map(|c| c.kind),
        Some(ChangeKind::Removed)
    );
    assert_eq!(
        find("emoji 🎮/存档2 💾.dat").map(|c| c.kind),
        Some(ChangeKind::Added)
    );
    // 仅大小写变化不产生差异（REPORT2.txt 的两种写法都不应出现）
    assert!(!report
        .files
        .iter()
        .any(|c| c.rel_path.eq_ignore_ascii_case("casetest/report2.txt")));

    // 汇总口径
    assert_eq!(report.summary.added_files, 4); // new.txt + 新目录2个 + 重命名1个
    assert_eq!(report.summary.removed_files, 2); // one.txt + 重命名旧名
    assert_eq!(report.summary.grown_files, 1);
    assert_eq!(report.summary.shrunk_files, 1);
    assert_eq!(report.summary.added_bytes, 50 + 200 + 300 + 77 + 50);
    assert_eq!(report.summary.removed_bytes, 5 + 77 + 6);
    assert_eq!(
        report.summary.net_bytes,
        report.summary.added_bytes as i64 - report.summary.removed_bytes as i64
    );

    // 目录聚合：根目录净变化 = 文件级净变化之和
    let root_change = report
        .dirs
        .iter()
        .find(|d| d.rel_path == ".")
        .expect("缺少根目录聚合");
    assert_eq!(root_change.net_bytes, report.summary.net_bytes);
    // “新目录”的聚合：新增目录与目录大小变化不重复计算
    let nd = report
        .dirs
        .iter()
        .find(|d| d.rel_path == "新目录")
        .expect("缺少新目录聚合");
    assert_eq!(nd.added_bytes, 500);
    assert_eq!(nd.changed_files, 2);
}

#[test]
fn cancelled_scan_refused_to_save() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("big");
    fixtures::generate_large(&root, 5, 50).unwrap();
    let db = tmp.path().join("test.db");

    let scanner = Scanner::new(ScanConfig::default());
    let cancel = scanner.cancel_handle();
    cancel.store(true, std::sync::atomic::Ordering::Relaxed); // 立即取消
    let outcome = scanner.scan(&root, |_, _| {});
    assert!(outcome.cancelled);

    let conn = snapshot::open(&db).unwrap();
    assert_eq!(
        snapshot::save(&conn, &outcome).unwrap(),
        None,
        "取消的快照不得入库"
    );
    assert!(snapshot::list(&conn).unwrap().is_empty());
}

#[test]
fn different_roots_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("test.db");
    let r1 = tmp.path().join("r1");
    let r2 = tmp.path().join("r2");
    fixtures::generate(&r1).unwrap();
    fixtures::generate(&r2).unwrap();

    let id1 = scan_and_save(&r1, &db);
    let id2 = scan_and_save(&r2, &db);

    let conn = snapshot::open(&db).unwrap();
    let err = diff::diff(&conn, id1, id2).unwrap_err();
    assert!(err.contains("根目录不同"), "应拒绝跨根目录比较：{err}");
}

#[test]
fn snapshot_roundtrip_preserves_stats() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("fixture");
    let expected = fixtures::generate(&root).unwrap();
    let db = tmp.path().join("test.db");

    let id = scan_and_save(&root, &db);
    let conn = snapshot::open(&db).unwrap();
    let m = snapshot::meta(&conn, id).unwrap();
    assert_eq!(m.file_count, expected.file_count as i64);
    assert_eq!(m.total_bytes, expected.total_bytes as i64);
    assert_eq!(m.status, "complete");
    assert_eq!(m.stats_kind, snapshot::STATS_KIND);
}
