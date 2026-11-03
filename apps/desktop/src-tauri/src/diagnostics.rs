//! 本地结构化诊断日志与用户主动导出。
//! 默认日志不记录扫描根或数据库的完整路径；错误文本中的这些路径也会脱敏。

use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const LOG_FILE: &str = "operations.jsonl";
const PREVIOUS_LOG_FILE: &str = "operations.previous.jsonl";
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
const MAX_EXPORT_EVENTS: usize = 1000;

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn sanitize(detail: &str, redactions: &[String]) -> String {
    let mut result = detail.to_string();
    for (index, path) in redactions.iter().filter(|path| !path.is_empty()).enumerate() {
        result = result.replace(path, &format!("$PATH_{}", index + 1));
    }
    result
}

pub fn append(
    data_dir: &Path,
    operation: &str,
    id: u64,
    phase: &str,
    detail: Option<&str>,
    redactions: &[String],
) -> std::io::Result<()> {
    std::fs::create_dir_all(data_dir)?;
    let path = data_dir.join(LOG_FILE);
    if path.metadata().is_ok_and(|metadata| metadata.len() >= MAX_LOG_BYTES) {
        let previous = data_dir.join(PREVIOUS_LOG_FILE);
        if previous.exists() {
            std::fs::remove_file(&previous)?;
        }
        std::fs::rename(&path, previous)?;
    }
    let event = json!({
        "timestamp_ms": now_ms(),
        "app_version": env!("CARGO_PKG_VERSION"),
        "operation": operation,
        "operation_id": id,
        "phase": phase,
        "detail": detail.map(|text| sanitize(text, redactions)),
    });
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    serde_json::to_writer(&mut file, &event)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    file.write_all(b"\n")?;
    file.sync_data()
}

fn read_events(path: &Path) -> (Vec<Value>, usize) {
    let Ok(content) = std::fs::read_to_string(path) else {
        return (Vec::new(), 0);
    };
    let mut events = Vec::new();
    let mut invalid = 0;
    for line in content.lines() {
        match serde_json::from_str(line) {
            Ok(event) => events.push(event),
            Err(_) => invalid += 1,
        }
    }
    (events, invalid)
}

pub fn export(data_dir: &Path, output: &Path) -> Result<PathBuf, String> {
    let (mut previous, mut invalid_events) = read_events(&data_dir.join(PREVIOUS_LOG_FILE));
    let (current, invalid_current) = read_events(&data_dir.join(LOG_FILE));
    invalid_events += invalid_current;
    previous.extend(current);
    let skipped_events = previous.len().saturating_sub(MAX_EXPORT_EVENTS);
    if skipped_events > 0 {
        previous.drain(..skipped_events);
    }
    let report = json!({
        "schema": "storagescope-diagnostics-v1",
        "generated_at_ms": now_ms(),
        "app_version": env!("CARGO_PKG_VERSION"),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "database": "app-data/storagescope-snapshots.db",
        "events": previous,
        "skipped_older_events": skipped_events,
        "invalid_log_lines": invalid_events,
        "privacy": "扫描根和数据库路径以 $PATH_N 占位；导出前仍请检查内容。",
    });
    let content = serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?;
    storagescope_core::export::write_text(output, &content)
        .map_err(|error| format!("无法导出诊断文件：{error}"))?;
    Ok(output.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_and_export_redact_personal_paths() {
        let temp = tempfile::tempdir().unwrap();
        let private_root = temp.path().join("个人资料");
        let redactions = vec![private_root.display().to_string()];
        append(
            temp.path(),
            "cleanup",
            7,
            "failed",
            Some(&format!("无法读取 {}", private_root.display())),
            &redactions,
        )
        .unwrap();
        let raw = std::fs::read_to_string(temp.path().join(LOG_FILE)).unwrap();
        assert!(!raw.contains("个人资料"));
        assert!(raw.contains("$PATH_1"));
        let event: Value = serde_json::from_str(raw.trim()).unwrap();
        assert_eq!(event["operation_id"], 7);
        assert_eq!(event["phase"], "failed");

        let output = temp.path().join("diagnostic.json");
        export(temp.path(), &output).unwrap();
        let exported = std::fs::read_to_string(output).unwrap();
        assert!(!exported.contains("个人资料"));
        assert!(exported.contains("storagescope-diagnostics-v1"));
    }
}
