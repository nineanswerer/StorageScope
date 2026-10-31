//! 黄金测试：以独立的朴素递归遍历作为参照实现，
//! 验证扫描器在合成数据集上的统计完全一致；另覆盖取消行为。

use std::path::Path;
use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;
use storagescope_core::{fixtures, scanner::Scanner, stats, ScanConfig};

/// 参照实现：刻意简单的 std::fs 递归遍历，与扫描器实现完全独立。
fn naive_reference(root: &Path) -> (u64, u64, u64) {
    let mut files = 0u64;
    let mut dirs = 0u64;
    let mut bytes = 0u64;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let entry = entry.unwrap();
            let ft = entry.file_type().unwrap();
            if ft.is_symlink() {
                continue;
            } else if ft.is_dir() {
                dirs += 1;
                stack.push(entry.path());
            } else if ft.is_file() {
                files += 1;
                bytes += entry.metadata().unwrap().len();
            }
        }
    }
    // 根目录本身不计入参照实现的 dirs
    (files, dirs + 1, bytes)
}

#[test]
fn golden_stats_match_reference() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("fixture");
    let expected = fixtures::generate(&root).unwrap();

    // 生成器自报与参照实现必须一致（双保险）
    let (ref_files, ref_dirs, ref_bytes) = naive_reference(&root);
    assert_eq!(expected.file_count, ref_files, "生成器文件数与参照不符");
    assert_eq!(expected.dir_count, ref_dirs, "生成器目录数与参照不符");
    assert_eq!(expected.total_bytes, ref_bytes, "生成器字节数与参照不符");

    // 被测扫描器
    let scanner = Scanner::new(ScanConfig::default());
    let outcome = scanner.scan(&root, |_, _| {});

    assert!(!outcome.cancelled, "不应被取消");
    assert_eq!(outcome.file_count(), ref_files, "文件数不一致");
    assert_eq!(outcome.total_bytes(), ref_bytes, "总字节数不一致");
    assert_eq!(
        outcome.dirs.len() as u64,
        ref_dirs,
        "目录数不一致（扫描器结果含根目录自身）"
    );

    // 聚合统计：根目录总计必须等于全部文件之和
    let tree = stats::aggregate(&outcome);
    assert_eq!(tree.file_count, ref_files);
    assert_eq!(tree.total_size, ref_bytes);

    // 抽查具体目录：宽目录 = 20 子目录 × 5 文件 × 32 字节 = 3200 字节
    let wide = tree
        .children
        .iter()
        .find(|c| c.name == "宽目录")
        .expect("缺少宽目录");
    assert_eq!(wide.file_count, 100);
    assert_eq!(wide.total_size, 3200);
    assert_eq!(wide.subdir_count, 20);

    // 深目录：10 层，文件大小 10+20+...+100 = 550 字节
    let deep = tree
        .children
        .iter()
        .find(|c| c.name == "深01")
        .expect("缺少深目录");
    assert_eq!(deep.total_size, 550);
    assert_eq!(deep.file_count, 10);

    // 中文与 emoji 路径可正常统计
    let zh = tree
        .children
        .iter()
        .find(|c| c.name == "中文目录 带空格")
        .expect("缺少中文目录");
    assert_eq!(zh.total_size, 100);
    assert!(tree.children.iter().any(|c| c.name == "emoji 🎮"));
}

#[test]
fn cancellation_stops_scan_cleanly() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("big");
    let expected = fixtures::generate_large(&root, 50, 200).unwrap();

    let scanner = Scanner::new(ScanConfig {
        follow_links: false,
        progress_every: 50,
    });
    let cancel = scanner.cancel_handle();

    // 另一线程在短暂延迟后取消
    let handle = thread::spawn(move || {
        thread::sleep(Duration::from_millis(5));
        cancel.store(true, Ordering::Relaxed);
    });

    let outcome = scanner.scan(&root, |_, _| {});
    handle.join().unwrap();

    assert!(outcome.cancelled, "取消后结果必须标记为不完整");
    assert!(
        outcome.file_count() < expected.file_count,
        "取消后应为部分结果"
    );
    // 取消不产生 panic、不产生错误条目
    assert!(outcome.errors.is_empty());
}

#[test]
fn missing_root_reports_error_not_panic() {
    let scanner = Scanner::new(ScanConfig::default());
    let outcome = scanner.scan(Path::new("Z:/不存在的路径-xyz"), |_, _| {});
    assert!(!outcome.errors.is_empty(), "不存在的根目录应进入错误清单");
}
