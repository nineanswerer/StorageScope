use crate::model::*;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

/// 扫描配置。
pub struct ScanConfig {
    /// 是否跟随符号链接/重解析点。默认 false，避免目录循环。
    pub follow_links: bool,
    /// 每扫描多少个文件回调一次进度。
    pub progress_every: u64,
}

impl Default for ScanConfig {
    fn default() -> Self {
        Self {
            follow_links: false,
            progress_every: 1000,
        }
    }
}

/// 只读扫描器。协作式取消：设置 `cancel` 标志后，
/// 遍历在下一条目处停止，结果以 `cancelled = true` 返回。
///
/// 实现说明：遍历基于 `std::fs::read_dir` 的迭代式工作栈，
/// 不依赖第三方遍历库。M1 期间实测 jwalk 在真实大型目录
/// （30 万级文件的 Minecraft 目录）上存在活锁，故移除。
/// Windows 下 `DirEntry::file_type` 与 `metadata` 直接来自
/// 目录枚举结果，不产生额外系统调用。
pub struct Scanner {
    pub config: ScanConfig,
    cancel: Arc<AtomicBool>,
}

/// Windows：通过文件属性位识别一切重解析点（符号链接、目录联接等）。
/// `DirEntry::metadata()` 在 Windows 直接复用目录枚举结果，
/// 不产生额外系统调用。
#[cfg(windows)]
fn is_reparse_point(entry: &std::fs::DirEntry) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    match entry.metadata() {
        Ok(md) => md.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0,
        // 读不到元数据宁可按重解析点跳过，避免误入目录循环
        Err(_) => true,
    }
}

#[cfg(not(windows))]
fn is_reparse_point(entry: &std::fs::DirEntry) -> bool {
    entry.file_type().map(|t| t.is_symlink()).unwrap_or(true)
}

impl Scanner {
    pub fn new(config: ScanConfig) -> Self {
        Self {
            config,
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }

    /// 取消句柄：在另一线程（如 Ctrl+C 处理器）中置位即可中止扫描。
    pub fn cancel_handle(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }

    /// 执行只读扫描。`on_progress` 按 `progress_every` 频率回调，
    /// 携带当前进度与最近访问的路径。
    pub fn scan(&self, root: &Path, mut on_progress: impl FnMut(Progress, &Path)) -> ScanOutcome {
        let started = Instant::now();
        let mut files: Vec<FileEntry> = Vec::new();
        let mut dirs: Vec<DirEntry> = Vec::new();
        let mut errors: Vec<ScanError> = Vec::new();
        let mut cancelled = false;
        let mut bytes: u64 = 0;

        // 目录清单含根目录自身（rel_path 为 "."），供 stats 构建树根。
        let root_name = root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.display().to_string());
        dirs.push(DirEntry {
            rel_path: ".".into(),
            name: root_name,
        });

        // 迭代式工作栈：无递归深度限制，无第三方调度黑盒
        let mut stack: Vec<std::path::PathBuf> = vec![root.to_path_buf()];

        while let Some(dir) = stack.pop() {
            if self.cancel.load(Ordering::Relaxed) {
                cancelled = true;
                break;
            }
            let rd = match std::fs::read_dir(&dir) {
                Ok(rd) => rd,
                Err(e) => {
                    errors.push(ScanError {
                        path: dir.display().to_string(),
                        category: ErrorCategory::ReadFailed,
                        message: e.to_string(),
                    });
                    continue;
                }
            };
            for entry in rd {
                if self.cancel.load(Ordering::Relaxed) {
                    cancelled = true;
                    break;
                }
                let entry = match entry {
                    Ok(e) => e,
                    Err(e) => {
                        errors.push(ScanError {
                            path: dir.display().to_string(),
                            category: ErrorCategory::ReadFailed,
                            message: e.to_string(),
                        });
                        continue;
                    }
                };

                let path = entry.path();

                if !self.config.follow_links && is_reparse_point(&entry) {
                    errors.push(ScanError {
                        path: path.display().to_string(),
                        category: ErrorCategory::SkippedReparsePoint,
                        message: "重解析点/符号链接，按默认策略跳过".into(),
                    });
                    continue;
                }

                let rel = rel_path(root, &path);
                let name = entry.file_name().to_string_lossy().into_owned();

                match entry.file_type() {
                    Ok(ft) if ft.is_dir() => {
                        dirs.push(DirEntry {
                            rel_path: rel,
                            name,
                        });
                        stack.push(path);
                    }
                    Ok(ft) if ft.is_file() => {
                        match entry.metadata() {
                            Ok(md) => {
                                let size = md.len();
                                bytes += size;
                                files.push(FileEntry {
                                    rel_path: rel,
                                    name,
                                    size,
                                    modified: md
                                        .modified()
                                        .ok()
                                        .and_then(|t| {
                                            t.duration_since(std::time::UNIX_EPOCH).ok()
                                        })
                                        .map(|d| d.as_secs() as i64),
                                    ext: path
                                        .extension()
                                        .map(|e| e.to_string_lossy().to_lowercase()),
                                });
                                if files.len() as u64 % self.config.progress_every == 0 {
                                    on_progress(
                                        Progress {
                                            files: files.len() as u64,
                                            bytes,
                                            errors: errors.len() as u64,
                                        },
                                        &path,
                                    );
                                }
                            }
                            Err(e) => errors.push(ScanError {
                                path: path.display().to_string(),
                                category: ErrorCategory::MetadataFailed,
                                message: e.to_string(),
                            }),
                        }
                    }
                    _ => {} // 特殊文件（管道、套接字等）忽略
                }
            }
            if cancelled {
                break;
            }
        }

        ScanOutcome {
            root: root.display().to_string(),
            files,
            dirs,
            errors,
            cancelled,
            duration_ms: started.elapsed().as_millis(),
        }
    }
}

/// 规范化相对路径：`/` 分隔，相对根目录；根目录本身为 `.`。
pub fn rel_path(root: &Path, path: &Path) -> String {
    match path.strip_prefix(root) {
        Ok(r) => {
            let s = r
                .components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            if s.is_empty() {
                ".".into()
            } else {
                s
            }
        }
        Err(_) => path.display().to_string(),
    }
}

/// 取 rel_path 的父级；根或顶层返回 `.`。
pub fn parent_of(rel_path: &str) -> &str {
    match rel_path.rfind('/') {
        Some(i) => &rel_path[..i],
        None => ".",
    }
}
