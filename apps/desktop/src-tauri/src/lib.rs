//! StorageScope 桌面端：Tauri 命令桥接。
//! 核心逻辑全部在 storagescope-core；这里只做调用、事件转发与状态管理。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use storagescope_core::diff::DiffReport;
use storagescope_core::model::DirStat;
use storagescope_core::{diff as ssdiff, export, snapshot, stats, ScanConfig, Scanner};
use tauri::{AppHandle, Emitter, State};

/// 当前扫描的取消句柄（同一时间只允许一个扫描）。
struct ScanCancel(Mutex<Option<Arc<AtomicBool>>>);

#[tauri::command]
fn cancel_scan(state: State<ScanCancel>) {
    if let Some(c) = state.0.lock().unwrap().as_ref() {
        c.store(true, Ordering::Relaxed);
    }
}

/// 扫描目录：后台线程执行，进度通过 scan-progress 事件推送。
/// 返回 { outcome, tree }。
#[tauri::command]
async fn scan_directory(
    app: AppHandle,
    state: State<'_, ScanCancel>,
    path: String,
) -> Result<serde_json::Value, String> {
    let scanner = Scanner::new(ScanConfig {
        follow_links: false,
        progress_every: 500,
    });
    *state.0.lock().unwrap() = Some(scanner.cancel_handle());
    tauri::async_runtime::spawn_blocking(move || {
        let app2 = app.clone();
        let outcome = scanner.scan(Path::new(&path), move |p, cur| {
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
    state: State<'_, ScanCancel>,
    path: String,
    db: String,
) -> Result<serde_json::Value, String> {
    let scanner = Scanner::new(ScanConfig {
        follow_links: false,
        progress_every: 500,
    });
    *state.0.lock().unwrap() = Some(scanner.cancel_handle());
    tauri::async_runtime::spawn_blocking(move || {
        let app2 = app.clone();
        let outcome = scanner.scan(Path::new(&path), move |p, cur| {
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
async fn diff_snapshots(db: String, old: i64, new: i64) -> Result<DiffReport, String> {
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
    state: State<'_, ScanCancel>,
    path: String,
    top: usize,
    dupe_min_mib: u64,
    skip_dupes: bool,
) -> Result<serde_json::Value, String> {
    let scanner = Scanner::new(ScanConfig {
        follow_links: false,
        progress_every: 500,
    });
    *state.0.lock().unwrap() = Some(scanner.cancel_handle());
    tauri::async_runtime::spawn_blocking(move || {
        let app2 = app.clone();
        let outcome = scanner.scan(Path::new(&path), move |p, cur| {
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
        let report = if skip_dupes {
            storagescope_core::rules::analyze_light(&outcome, &tree, top)
        } else {
            storagescope_core::rules::analyze(
                Path::new(&path),
                &outcome,
                &tree,
                top,
                dupe_min_mib.max(1) * 1024 * 1024,
                Some(&mut dupe_cb),
            )
        };
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ScanCancel(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            scan_directory,
            cancel_scan,
            save_snapshot,
            list_snapshots,
            diff_snapshots,
            analyze_cleanup,
            export_tree,
            export_diff,
        ])
        .run(tauri::generate_context!())
        .expect("运行 StorageScope 桌面端失败");
}
