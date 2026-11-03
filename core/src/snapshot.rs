//! 快照存储：SQLite 持久化扫描结果。
//! 快照格式带版本号（stats_kind）与应用版本号；被取消的扫描结果拒绝入库。

use crate::model::*;
use rusqlite::{params, Connection};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// 统计口径标识：首版仅逻辑大小。口径变化时必须升级该标识，
/// 不同口径的快照禁止比较。
pub const STATS_KIND: &str = "logical-v1";
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

pub type DbResult<T> = Result<T, rusqlite::Error>;

pub fn open(path: &Path) -> DbResult<Connection> {
    let conn = Connection::open(path)?;
    init_schema(&conn)?;
    Ok(conn)
}

fn init_schema(conn: &Connection) -> DbResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS snapshots (
            id INTEGER PRIMARY KEY,
            root TEXT NOT NULL,
            recorded_at INTEGER NOT NULL,
            duration_ms INTEGER NOT NULL,
            status TEXT NOT NULL,
            app_version TEXT NOT NULL,
            stats_kind TEXT NOT NULL,
            file_count INTEGER NOT NULL,
            total_bytes INTEGER NOT NULL,
            error_count INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS nodes (
            snapshot_id INTEGER NOT NULL,
            rel_path TEXT NOT NULL,
            name TEXT NOT NULL,
            node_type TEXT NOT NULL,
            logical_size INTEGER NOT NULL,
            modified INTEGER,
            ext TEXT,
            PRIMARY KEY (snapshot_id, rel_path)
        );
        CREATE TABLE IF NOT EXISTS scan_errors (
            snapshot_id INTEGER NOT NULL,
            path TEXT NOT NULL,
            category TEXT NOT NULL,
            message TEXT NOT NULL
        );",
    )
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SnapshotMeta {
    pub id: i64,
    pub root: String,
    pub recorded_at: i64,
    pub duration_ms: i64,
    pub status: String,
    pub app_version: String,
    pub stats_kind: String,
    pub file_count: i64,
    pub total_bytes: i64,
    pub error_count: i64,
}

/// 保存快照。返回快照 ID；被取消的扫描结果是损坏数据，拒绝入库（Ok(None)）。
pub fn save(conn: &Connection, outcome: &ScanOutcome) -> DbResult<Option<i64>> {
    if outcome.cancelled {
        return Ok(None);
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let status = if outcome.errors.is_empty() {
        "complete"
    } else {
        "incomplete"
    };
    // 元数据、节点和异常必须在同一事务提交，避免强杀或写入失败留下孤立快照。
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO snapshots (root, recorded_at, duration_ms, status, app_version, stats_kind, file_count, total_bytes, error_count)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            outcome.root,
            now,
            outcome.duration_ms as i64,
            status,
            APP_VERSION,
            STATS_KIND,
            outcome.file_count() as i64,
            outcome.total_bytes() as i64,
            outcome.errors.len() as i64
        ],
    )?;
    let id = tx.last_insert_rowid();
    {
        let mut stmt = tx.prepare(
            "INSERT INTO nodes (snapshot_id, rel_path, name, node_type, logical_size, modified, ext)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
        )?;
        for f in &outcome.files {
            stmt.execute(params![
                id,
                f.rel_path,
                f.name,
                "file",
                f.size as i64,
                f.modified,
                f.ext
            ])?;
        }
        for d in &outcome.dirs {
            stmt.execute(params![
                id,
                d.rel_path,
                d.name,
                "dir",
                0i64,
                Option::<i64>::None,
                Option::<String>::None
            ])?;
        }
    }
    {
        let mut stmt = tx.prepare(
            "INSERT INTO scan_errors (snapshot_id, path, category, message) VALUES (?1,?2,?3,?4)",
        )?;
        for e in &outcome.errors {
            stmt.execute(params![id, e.path, format!("{:?}", e.category), e.message])?;
        }
    }
    tx.commit()?;
    Ok(Some(id))
}

pub fn list(conn: &Connection) -> DbResult<Vec<SnapshotMeta>> {
    let mut stmt = conn.prepare(
        "SELECT id, root, recorded_at, duration_ms, status, app_version, stats_kind, file_count, total_bytes, error_count
         FROM snapshots ORDER BY id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(SnapshotMeta {
            id: r.get(0)?,
            root: r.get(1)?,
            recorded_at: r.get(2)?,
            duration_ms: r.get(3)?,
            status: r.get(4)?,
            app_version: r.get(5)?,
            stats_kind: r.get(6)?,
            file_count: r.get(7)?,
            total_bytes: r.get(8)?,
            error_count: r.get(9)?,
        })
    })?;
    rows.collect()
}

pub fn meta(conn: &Connection, id: i64) -> DbResult<SnapshotMeta> {
    conn.query_row(
        "SELECT id, root, recorded_at, duration_ms, status, app_version, stats_kind, file_count, total_bytes, error_count
         FROM snapshots WHERE id = ?1",
        params![id],
        |r| {
            Ok(SnapshotMeta {
                id: r.get(0)?,
                root: r.get(1)?,
                recorded_at: r.get(2)?,
                duration_ms: r.get(3)?,
                status: r.get(4)?,
                app_version: r.get(5)?,
                stats_kind: r.get(6)?,
                file_count: r.get(7)?,
                total_bytes: r.get(8)?,
                error_count: r.get(9)?,
            })
        },
    )
}

/// 载入某快照的全部文件节点。
pub fn load_files(conn: &Connection, snapshot_id: i64) -> DbResult<Vec<FileEntry>> {
    let mut stmt = conn.prepare(
        "SELECT rel_path, name, logical_size, modified, ext
         FROM nodes WHERE snapshot_id = ?1 AND node_type = 'file'",
    )?;
    let rows = stmt.query_map(params![snapshot_id], |r| {
        Ok(FileEntry {
            rel_path: r.get(0)?,
            name: r.get(1)?,
            size: r.get::<_, i64>(2)? as u64,
            modified: r.get(3)?,
            ext: r.get(4)?,
        })
    })?;
    rows.collect()
}
