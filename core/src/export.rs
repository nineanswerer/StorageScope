//! 导出：统计树与差异报告 → JSON／CSV 文本。
//! 导出由用户主动触发；内容包含统计口径说明。

use crate::diff::{ChangeKind, DiffReport};
use crate::model::DirStat;
use std::fs;
use std::io;
use std::path::Path;

fn csv_escape(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn flatten_tree(stat: &DirStat, rows: &mut Vec<String>) {
    rows.push(format!(
        "{},{},{},{},{},{}",
        csv_escape(&stat.rel_path),
        csv_escape(&stat.name),
        stat.total_size,
        stat.file_count,
        stat.subdir_count,
        stat.has_errors
    ));
    for c in &stat.children {
        flatten_tree(c, rows);
    }
}

pub fn tree_csv(tree: &DirStat) -> String {
    let mut rows =
        vec!["rel_path,name,total_size_bytes,file_count,subdir_count,has_errors".to_string()];
    flatten_tree(tree, &mut rows);
    rows.join("\n")
}

pub fn tree_json(tree: &DirStat) -> String {
    serde_json::to_string_pretty(tree).unwrap_or_default()
}

pub fn diff_csv(report: &DiffReport) -> String {
    let mut rows = vec!["rel_path,kind,old_size_bytes,new_size_bytes".to_string()];
    for c in &report.files {
        let kind = match c.kind {
            ChangeKind::Added => "added",
            ChangeKind::Removed => "removed",
            ChangeKind::Grown => "grown",
            ChangeKind::Shrunk => "shrunk",
        };
        rows.push(format!(
            "{},{},{},{}",
            csv_escape(&c.rel_path),
            kind,
            c.old_size.map(|v| v.to_string()).unwrap_or_default(),
            c.new_size.map(|v| v.to_string()).unwrap_or_default()
        ));
    }
    rows.join("\n")
}

pub fn diff_json(report: &DiffReport) -> String {
    serde_json::to_string_pretty(report).unwrap_or_default()
}

pub fn write_text(path: &Path, content: &str) -> io::Result<()> {
    // 统一写 UTF-8 BOM，Excel 打开 CSV 中文不乱码
    fs::write(path, format!("\u{feff}{content}"))
}
