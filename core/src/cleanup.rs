//! 清理执行：把用户确认的文件/目录移入系统回收站（可恢复）。
//! 不做永久删除；逐条记录成功/失败，不中断批处理。

use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub struct TrashItemResult {
    pub path: String,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrashReport {
    pub results: Vec<TrashItemResult>,
    pub succeeded: usize,
    pub failed: usize,
}

/// 把给定路径逐个移入系统回收站。
/// 安全性约束：
/// - 拒绝空路径、根目录（如 C:\ 或 /）等明显危险目标；
/// - 单条失败不影响其余条目。
pub fn move_to_trash<I, P>(paths: I) -> TrashReport
where
    I: IntoIterator<Item = P>,
    P: AsRef<Path>,
{
    let mut results = Vec::new();
    for p in paths {
        let path = p.as_ref();
        let display = path.display().to_string();
        let result = if display.trim().is_empty() {
            Err("空路径".to_string())
        } else if is_root(path) {
            Err("拒绝删除根目录".to_string())
        } else if !path.exists() {
            Err("路径不存在（可能已被移动或删除）".to_string())
        } else {
            trash::delete(path).map_err(|e| e.to_string())
        };
        match result {
            Ok(()) => results.push(TrashItemResult { path: display, ok: true, error: None }),
            Err(e) => results.push(TrashItemResult { path: display, ok: false, error: Some(e) }),
        }
    }
    let succeeded = results.iter().filter(|r| r.ok).count();
    let failed = results.len() - succeeded;
    TrashReport { results, succeeded, failed }
}

fn is_root(path: &Path) -> bool {
    match path.canonicalize() {
        Ok(c) => c.parent().is_none(),
        Err(_) => false, // 无法解析时不按根目录处理，交给 trash 自身报错
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn rejects_root_and_missing_paths() {
        let report = move_to_trash(["Z:\\definitely-not-exist-storagescope-xyz"]);
        assert_eq!(report.failed, 1);
        assert!(!report.results[0].ok);
        let root = if cfg!(windows) { "C:\\" } else { "/" };
        let report = move_to_trash([root]);
        assert_eq!(report.failed, 1);
        assert!(report.results[0].error.as_deref().unwrap_or("").contains("根目录"));
    }

    #[test]
    fn moves_real_file_to_trash() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("junk.bin");
        fs::write(&file, vec![0u8; 128]).unwrap();
        let report = move_to_trash([&file]);
        assert_eq!(report.succeeded, 1, "失败原因: {:?}", report.results[0].error);
        assert!(!file.exists(), "原位置文件应已消失（进入回收站）");
    }
}
