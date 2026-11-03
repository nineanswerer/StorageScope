//! StorageScope 桌面端：Tauri 命令桥接。
//! 核心逻辑全部在 storagescope-core；这里只做调用、事件转发与状态管理。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use storagescope_core::diff::DiffReport;
use storagescope_core::model::DirStat;
use storagescope_core::{diff as ssdiff, export, snapshot, stats, ScanConfig, Scanner};
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
fn snapshot_database_path(app: AppHandle) -> Result<String, String> {
    let dir = match std::env::var_os("STORAGESCOPE_DATA_DIR") {
        Some(override_dir) => {
            let path = PathBuf::from(override_dir);
            if !path.is_absolute() {
                return Err("STORAGESCOPE_DATA_DIR 必须是绝对路径".into());
            }
            path
        }
        None => app
            .path()
            .app_local_data_dir()
            .map_err(|e| format!("无法定位应用数据目录：{e}"))?,
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建应用数据目录：{e}"))?;
    let dir = dir
        .canonicalize()
        .map_err(|e| format!("无法解析应用数据目录：{e}"))?;
    Ok(dir.join("storagescope-snapshots.db").display().to_string())
}

/// 串行执行扫描、分析与写操作，取消令牌只属于当前操作。
struct OperationState {
    active: Mutex<Option<ActiveOperation>>,
}

struct ActiveOperation {
    id: u64,
    cancel: Arc<AtomicBool>,
}

struct OperationGuard {
    state: Arc<OperationState>,
    id: u64,
    cancel: Arc<AtomicBool>,
}

impl Drop for OperationGuard {
    fn drop(&mut self) {
        let mut active = self.state.active.lock().unwrap();
        if active.as_ref().is_some_and(|operation| operation.id == self.id) {
            *active = None;
        }
    }
}

static NEXT_OPERATION_ID: AtomicU64 = AtomicU64::new(1);

fn begin_operation(state: &Arc<OperationState>) -> Result<OperationGuard, String> {
    let mut active = state.active.lock().unwrap();
    if active.is_some() {
        return Err("另一个扫描、分析或文件操作仍在进行，请等待完成或先取消".into());
    }
    let id = NEXT_OPERATION_ID.fetch_add(1, Ordering::Relaxed);
    let cancel = Arc::new(AtomicBool::new(false));
    *active = Some(ActiveOperation {
        id,
        cancel: cancel.clone(),
    });
    Ok(OperationGuard {
        state: state.clone(),
        id,
        cancel,
    })
}

fn emit_recovery(app: &AppHandle, root: &Path) {
    let messages = storagescope_core::dedup::recover_interrupted_merges(root);
    if !messages.is_empty() {
        let _ = app.emit("merge-recovery", serde_json::json!({ "messages": messages }));
    }
}

/// 所有文件操作共用的边界校验：相对路径解析后必须仍位于已规范化的扫描根目录内。
fn resolve_within_root(root_path: &Path, rel: &str) -> Result<PathBuf, String> {
    let canonical = root_path
        .join(rel.replace('/', std::path::MAIN_SEPARATOR_STR))
        .canonicalize()
        .map_err(|e| format!("{rel}：无法解析（{e}）"))?;
    if !canonical.starts_with(root_path) {
        return Err(format!("{rel}：目标不在扫描根目录内，已拒绝"));
    }
    Ok(canonical)
}

/// 回收站目标必须比扫描根更严格：允许定位根目录，但绝不允许删除整个扫描根。
#[cfg(test)]
fn resolve_trash_target(root_path: &Path, rel: &str) -> Result<PathBuf, String> {
    let canonical = resolve_within_root(root_path, rel)?;
    if canonical == root_path {
        return Err("拒绝将扫描根目录移入回收站".into());
    }
    Ok(canonical)
}

#[tauri::command]
fn cancel_operation(state: State<Arc<OperationState>>) -> bool {
    if let Some(operation) = state.active.lock().unwrap().as_ref() {
        operation.cancel.store(true, Ordering::Relaxed);
        true
    } else {
        false
    }
}

/// 扫描目录：后台线程执行，进度通过 scan-progress 事件推送。
/// 返回 { outcome, tree }。
#[tauri::command]
async fn scan_directory(
    app: AppHandle,
    state: State<'_, Arc<OperationState>>,
    path: String,
) -> Result<serde_json::Value, String> {
    let _operation = begin_operation(state.inner())?;
    let scanner = Scanner::with_cancel(
        ScanConfig {
            follow_links: false,
            progress_every: 500,
        },
        _operation.cancel.clone(),
    );
    tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&path)
            .canonicalize()
            .map_err(|e| format!("扫描根目录不可解析：{e}"))?;
        emit_recovery(&app, &root);
        let app2 = app.clone();
        let outcome = scanner.scan(&root, move |p, cur| {
            let _ = app2.emit(
                "scan-progress",
                serde_json::json!({
                    "files": p.files,
                    "bytes": p.bytes,
                    "errors": p.errors,
                    "current": cur.display().to_string(),
                }),
            );
        });
        let tree = stats::aggregate(&outcome);
        serde_json::to_value(serde_json::json!({ "outcome": outcome, "tree": tree }))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 扫描并保存快照。取消时返回错误，不留下损坏快照。
#[tauri::command]
async fn save_snapshot(
    app: AppHandle,
    state: State<'_, Arc<OperationState>>,
    path: String,
    db: String,
) -> Result<serde_json::Value, String> {
    let _operation = begin_operation(state.inner())?;
    let scanner = Scanner::with_cancel(
        ScanConfig {
            follow_links: false,
            progress_every: 500,
        },
        _operation.cancel.clone(),
    );
    tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&path)
            .canonicalize()
            .map_err(|e| format!("扫描根目录不可解析：{e}"))?;
        emit_recovery(&app, &root);
        let app2 = app.clone();
        let outcome = scanner.scan(&root, move |p, cur| {
            let _ = app2.emit(
                "scan-progress",
                serde_json::json!({
                    "files": p.files,
                    "bytes": p.bytes,
                    "errors": p.errors,
                    "current": cur.display().to_string(),
                }),
            );
        });
        if outcome.cancelled {
            return Err("扫描已取消：快照未保存（取消的结果不完整，不得入库）".into());
        }
        let conn = snapshot::open(Path::new(&db)).map_err(|e| e.to_string())?;
        let id = snapshot::save(&conn, &outcome)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "快照未保存".to_string())?;
        Ok(serde_json::json!({
            "id": id,
            "file_count": outcome.file_count(),
            "total_bytes": outcome.total_bytes(),
            "complete": outcome.is_complete(),
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn list_snapshots(db: String) -> Result<serde_json::Value, String> {
    let conn = snapshot::open(Path::new(&db)).map_err(|e| e.to_string())?;
    let list = snapshot::list(&conn).map_err(|e| e.to_string())?;
    serde_json::to_value(list).map_err(|e| e.to_string())
}

#[tauri::command]
async fn diff_snapshots(
    state: State<'_, Arc<OperationState>>,
    db: String,
    old: i64,
    new: i64,
) -> Result<DiffReport, String> {
    let _operation = begin_operation(state.inner())?;
    tauri::async_runtime::spawn_blocking(move || {
        let conn = snapshot::open(Path::new(&db)).map_err(|e| e.to_string())?;
        ssdiff::diff(&conn, old, new)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 清理分析（M3）：扫描 + 缓存识别 + 大文件 + 重复文件检测。
/// 哈希阶段通过 analyze-progress 事件推送进度。
#[tauri::command]
async fn analyze_cleanup(
    app: AppHandle,
    state: State<'_, Arc<OperationState>>,
    path: String,
    db: String,
    top: usize,
    dupe_min_mib: u64,
    skip_dupes: bool,
) -> Result<serde_json::Value, String> {
    let _operation = begin_operation(state.inner())?;
    let scanner = Scanner::with_cancel(
        ScanConfig {
            follow_links: false,
            progress_every: 500,
        },
        _operation.cancel.clone(),
    );
    let cancel = _operation.cancel.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&path)
            .canonicalize()
            .map_err(|e| format!("扫描根目录不可解析：{e}"))?;
        emit_recovery(&app, &root);
        let app2 = app.clone();
        let outcome = scanner.scan(&root, move |p, cur| {
            let _ = app2.emit(
                "scan-progress",
                serde_json::json!({
                    "files": p.files,
                    "bytes": p.bytes,
                    "errors": p.errors,
                    "current": cur.display().to_string(),
                }),
            );
        });
        if outcome.cancelled {
            return Err("扫描已取消：分析中止".into());
        }
        let tree = stats::aggregate(&outcome);
        let app3 = app.clone();
        let mut dupe_cb = move |done: u64, total: u64| {
            let _ = app3.emit(
                "analyze-progress",
                serde_json::json!({ "done": done, "total": total }),
            );
        };
        let mut report = if skip_dupes {
            storagescope_core::rules::analyze_light(&outcome, &tree, top)
        } else {
            storagescope_core::rules::analyze_cancellable(
                &root,
                &outcome,
                &tree,
                top,
                dupe_min_mib.max(1) * 1024 * 1024,
                Some(&mut dupe_cb),
                &cancel,
            )
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::Interrupted {
                    "分析已取消：未生成清理计划".into()
                } else {
                    format!("分析失败：{e}")
                }
            })?
        };
        let baseline_snapshot_id = if db.trim().is_empty() {
            None
        } else {
            let conn = snapshot::open(Path::new(&db)).map_err(|e| e.to_string())?;
            snapshot::save(&conn, &outcome).map_err(|e| e.to_string())?
        };
        report.baseline_snapshot_id = baseline_snapshot_id;
        serde_json::to_value(report).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 导出统计树为 JSON 或 CSV。
#[tauri::command]
fn export_tree(tree: DirStat, path: String, format: String) -> Result<(), String> {
    let content = match format.as_str() {
        "csv" => export::tree_csv(&tree),
        _ => export::tree_json(&tree),
    };
    export::write_text(&PathBuf::from(path), &content).map_err(|e| e.to_string())
}

/// 导出差异报告为 JSON 或 CSV。
#[tauri::command]
fn export_diff(report: DiffReport, path: String, format: String) -> Result<(), String> {
    let content = match format.as_str() {
        "csv" => export::diff_csv(&report),
        _ => export::diff_json(&report),
    };
    export::write_text(&PathBuf::from(path), &content).map_err(|e| e.to_string())
}

/// 由扫描报告与用户选择生成固定清理计划，复核后移入回收站。
/// 报告只记录待清空大小，不把回收站动作写成已经释放空间。
#[tauri::command]
async fn execute_cleanup_plan(
    state: State<'_, Arc<OperationState>>,
    root: String,
    analysis: storagescope_core::rules::AnalysisReport,
    rel_paths: Vec<String>,
    reference_dirs: Vec<String>,
    excluded_dirs: Vec<String>,
) -> Result<serde_json::Value, String> {
    let _operation = begin_operation(state.inner())?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&root)
            .canonicalize()
            .map_err(|e| format!("扫描根目录不可解析：{e}"))?;
        let plan = storagescope_core::plan::build_cleanup_plan(
            &analysis,
            &rel_paths,
            &reference_dirs,
            &excluded_dirs,
        )?;
        let report = storagescope_core::plan::execute_cleanup_plan(&root, &plan)?;
        serde_json::to_value(report).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 空间合并：先验证保留边界与路径，再逐组重新校验全文哈希。
#[tauri::command]
async fn merge_duplicates(
    app: AppHandle,
    state: State<'_, Arc<OperationState>>,
    root: String,
    groups: Vec<storagescope_core::rules::DupeGroup>,
    reference_dirs: Vec<String>,
    excluded_dirs: Vec<String>,
) -> Result<serde_json::Value, String> {
    let _operation = begin_operation(state.inner())?;
    tauri::async_runtime::spawn_blocking(move || {
        storagescope_core::plan::validate_merge_groups(&groups, &reference_dirs, &excluded_dirs)?;
        let root_path = Path::new(&root)
            .canonicalize()
            .map_err(|e| format!("扫描根目录不可解析：{e}"))?;
        for group in &groups {
            for rel in &group.files {
                storagescope_core::plan::resolve_cleanup_target(&root_path, rel)?;
            }
        }
        let total: usize = groups.iter().map(|g| g.files.len().saturating_sub(1)).sum();
        let _ = app.emit(
            "merge-progress",
            serde_json::json!({ "done": 0, "total": total }),
        );
        let report = storagescope_core::dedup::merge_duplicates(&root_path, &groups);
        let _ = app.emit(
            "merge-progress",
            serde_json::json!({ "done": total, "total": total }),
        );
        serde_json::to_value(report).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 操作闭环：在资源管理器中定位文件（选中）或打开目录。
#[tauri::command]
fn reveal_in_explorer(root: String, rel_path: String) -> Result<(), String> {
    let root_path = Path::new(&root)
        .canonicalize()
        .map_err(|e| format!("扫描根目录不可解析：{e}"))?;
    let abs = resolve_within_root(&root_path, &rel_path)?;
    let mut cmd = std::process::Command::new("explorer");
    if abs.is_dir() {
        cmd.arg(abs);
    } else {
        cmd.arg(format!("/select,{}", abs.display()));
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(OperationState {
            active: Mutex::new(None),
        }))
        .invoke_handler(tauri::generate_handler![
            snapshot_database_path,
            scan_directory,
            cancel_operation,
            save_snapshot,
            list_snapshots,
            diff_snapshots,
            analyze_cleanup,
            execute_cleanup_plan,
            merge_duplicates,
            reveal_in_explorer,
            export_tree,
            export_diff,
        ])
        .run(tauri::generate_context!())
        .expect("运行 StorageScope 桌面端失败");
}

#[cfg(test)]
mod tests {
    use super::{begin_operation, resolve_trash_target, resolve_within_root, OperationState};
    use std::sync::{Arc, Mutex};

    #[test]
    fn operations_are_mutually_exclusive_and_release_on_drop() {
        let state = Arc::new(OperationState {
            active: Mutex::new(None),
        });
        let first = begin_operation(&state).unwrap();
        assert!(begin_operation(&state).is_err());
        assert!(!first.cancel.load(std::sync::atomic::Ordering::Relaxed));
        let id = first.id;
        drop(first);
        let second = begin_operation(&state).unwrap();
        assert_ne!(id, second.id);
    }

    #[test]
    fn file_operations_reject_parent_directory_escape() {
        let root = std::env::temp_dir().canonicalize().unwrap();
        assert!(resolve_within_root(&root, ".").is_ok());
        let error = resolve_within_root(&root, "..").unwrap_err();
        assert!(error.contains("目标不在扫描根目录内"));
    }

    #[test]
    fn trash_rejects_scan_root_even_with_indirect_paths() {
        let root = std::env::temp_dir().canonicalize().unwrap();
        let child_name = format!("storagescope-path-test-{}", std::process::id());
        std::fs::create_dir_all(root.join(&child_name)).unwrap();
        for rel in ["", ".", &format!("{child_name}/..")] {
            let error = resolve_trash_target(&root, rel).unwrap_err();
            assert!(error.contains("拒绝将扫描根目录"));
        }
        std::fs::remove_dir(root.join(child_name)).unwrap();
    }
}
