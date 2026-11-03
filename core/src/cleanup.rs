//! 清理执行：把用户确认的文件/目录移入系统回收站（可恢复）。
//! Windows 显式要求回收而非永久删除；无法确认回收结果时返回失败。

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

/// 把给定路径逐个移入系统回收站，单条失败不影响其余条目。
pub fn move_to_trash<I, P>(paths: I) -> TrashReport
where
    I: IntoIterator<Item = P>,
    P: AsRef<Path>,
{
    move_to_trash_with(paths, recycle_path)
}

fn move_to_trash_with<I, P, F>(paths: I, mut recycle: F) -> TrashReport
where
    I: IntoIterator<Item = P>,
    P: AsRef<Path>,
    F: FnMut(&Path) -> Result<(), String>,
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
            recycle(path).and_then(|()| {
                if path.exists() {
                    Err("回收操作返回成功，但源路径仍然存在".into())
                } else {
                    Ok(())
                }
            })
        };
        match result {
            Ok(()) => results.push(TrashItemResult {
                path: display,
                ok: true,
                error: None,
            }),
            Err(e) => results.push(TrashItemResult {
                path: display,
                ok: false,
                error: Some(e),
            }),
        }
    }
    let succeeded = results.iter().filter(|r| r.ok).count();
    let failed = results.len() - succeeded;
    TrashReport {
        results,
        succeeded,
        failed,
    }
}

fn is_root(path: &Path) -> bool {
    match path.canonicalize() {
        Ok(c) => c.parent().is_none(),
        Err(_) => false,
    }
}

#[cfg(not(windows))]
fn recycle_path(path: &Path) -> Result<(), String> {
    trash::delete(path).map_err(|e| e.to_string())
}

#[cfg(windows)]
fn recycle_path(path: &Path) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        FileOperation, IFileOperation, IShellItem, SHCreateItemFromParsingName, FOFX_ADDUNDORECORD,
        FOFX_EARLYFAILURE, FOFX_RECYCLEONDELETE, FOF_NO_UI,
    };

    struct ComGuard;
    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe { CoUninitialize() }
        }
    }

    let canonical = path
        .canonicalize()
        .map_err(|error| format!("无法解析回收目标：{error}"))?;
    let parsing_name = to_shell_parsing_name(&canonical);
    let init = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    if init.is_err() {
        return Err(format!("无法初始化 Windows 回收服务：{init}"));
    }
    let _com = ComGuard;
    unsafe {
        let operation: IFileOperation =
            CoCreateInstance(&FileOperation as *const _, None, CLSCTX_INPROC_SERVER)
                .map_err(|error| format!("无法创建 Windows 回收操作：{error}"))?;
        operation
            .SetOperationFlags(
                FOF_NO_UI | FOFX_RECYCLEONDELETE | FOFX_ADDUNDORECORD | FOFX_EARLYFAILURE,
            )
            .map_err(|error| format!("无法设置安全回收策略：{error}"))?;
        let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(parsing_name.as_ptr()), None)
            .map_err(|error| format!("无法读取回收目标：{error}"))?;
        operation
            .DeleteItem(&item, None)
            .map_err(|error| format!("无法加入回收队列：{error}"))?;
        operation
            .PerformOperations()
            .map_err(|error| format!("Windows 回收操作失败：{error}"))?;
        if operation
            .GetAnyOperationsAborted()
            .map_err(|error| format!("无法确认回收结果：{error}"))?
            .as_bool()
        {
            return Err("Windows 回收操作被中止，请检查源路径和回收站".into());
        }
    }
    Ok(())
}

/// Shell 不接受 canonicalize 产生的 verbatim 前缀，转换时保留 Unicode 与长路径组件。
#[cfg(windows)]
fn to_shell_parsing_name(path: &Path) -> Vec<u16> {
    use std::ffi::{OsStr, OsString};
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Component, Prefix};

    fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
        value
            .as_ref()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    let mut components = path.components();
    let mut out = OsString::new();
    let mut needs_separator = false;
    match components.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::VerbatimDisk(letter) => out.push(format!("{}:", letter as char)),
            Prefix::VerbatimUNC(host, share) => {
                out.push(r"\\");
                out.push(host);
                out.push(r"\");
                out.push(share);
            }
            _ => out.push(prefix.as_os_str()),
        },
        Some(component) => {
            out.push(component.as_os_str());
            needs_separator = true;
        }
        None => {}
    }
    for component in components {
        match component {
            Component::RootDir => {
                out.push(r"\");
                needs_separator = false;
            }
            component => {
                if needs_separator {
                    out.push(r"\");
                }
                out.push(component.as_os_str());
                needs_separator = true;
            }
        }
    }
    wide(out)
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
        assert!(report.results[0]
            .error
            .as_deref()
            .unwrap_or("")
            .contains("根目录"));
    }

    #[test]
    fn recycle_failure_preserves_source_and_reports_error() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("keep.bin");
        fs::write(&file, b"keep").unwrap();
        let report = move_to_trash_with([&file], |_| Err("injected recycle failure".into()));
        assert_eq!(report.failed, 1);
        assert_eq!(report.succeeded, 0);
        assert_eq!(fs::read(&file).unwrap(), b"keep");
        assert!(report.results[0]
            .error
            .as_deref()
            .unwrap_or("")
            .contains("injected"));
    }

    #[test]
    fn false_success_with_remaining_source_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("keep.bin");
        fs::write(&file, b"keep").unwrap();
        let report = move_to_trash_with([&file], |_| Ok(()));
        assert_eq!(report.failed, 1);
        assert!(file.exists());
    }

    #[test]
    fn moves_real_file_to_trash() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("junk.bin");
        fs::write(&file, vec![0u8; 128]).unwrap();
        let report = move_to_trash([&file]);
        assert_eq!(
            report.succeeded, 1,
            "失败原因: {:?}",
            report.results[0].error
        );
        assert!(!file.exists(), "原位置文件应已消失（进入回收站）");
    }

    #[cfg(windows)]
    #[test]
    fn shell_names_preserve_long_unicode_paths() {
        let deep = (0..40)
            .map(|i| format!("目录{i:02}"))
            .collect::<Vec<_>>()
            .join(r"\");
        let input = format!(r"\\?\C:\storage\{deep}\文件.bin");
        let converted = to_shell_parsing_name(Path::new(&input));
        let text = String::from_utf16(&converted[..converted.len() - 1]).unwrap();
        assert!(text.len() > 260);
        assert_eq!(text, format!(r"C:\storage\{deep}\文件.bin"));
    }
}
