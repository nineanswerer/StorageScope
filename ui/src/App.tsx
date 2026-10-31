import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import "./App.css";

type DirStat = {
  rel_path: string;
  name: string;
  total_size: number;
  file_count: number;
  subdir_count: number;
  has_errors: boolean;
  children: DirStat[];
};

type ScanOutcome = {
  root: string;
  errors: { path: string; category: string; message: string }[];
  cancelled: boolean;
  duration_ms: number;
  files: unknown[];
  dirs: unknown[];
};

type SnapshotMeta = {
  id: number;
  root: string;
  status: string;
  file_count: number;
  total_bytes: number;
};

type FileChange = {
  rel_path: string;
  kind: "Added" | "Removed" | "Grown" | "Shrunk";
  old_size: number | null;
  new_size: number | null;
};

type DiffReport = {
  warnings: string[];
  files: FileChange[];
  dirs: { rel_path: string; net_bytes: number; changed_files: number }[];
  summary: {
    added_files: number;
    removed_files: number;
    grown_files: number;
    shrunk_files: number;
    added_bytes: number;
    removed_bytes: number;
    net_bytes: number;
  };
};

type Progress = { files: number; bytes: number; errors: number; current: string };

type RuleHit = {
  rule_id: string;
  rule_name: string;
  rel_path: string;
  size: number;
  file_count: number;
  reason: string;
  safety: "SafeToDelete" | "ReviewAdvised";
};

type DupeGroup = { size: number; hash: number; files: string[]; wasted: number };

type AnalysisReport = {
  cache_hits: RuleHit[];
  big_files: { rel_path: string; name: string; size: number }[];
  dupe_groups: DupeGroup[];
  reclaimable_bytes: number;
  hashed_bytes: number;
  hash_errors: number;
};

type AnalyzeProgress = { done: number; total: number };

function humanSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${v} ${units[i]}` : `${v.toFixed(1)} ${units[i]}`;
}

const KIND_LABEL: Record<string, string> = {
  Added: "新增",
  Removed: "删除",
  Grown: "增长",
  Shrunk: "缩减",
};

function TreeNode({ stat, depth }: { stat: DirStat; depth: number }) {
  const [open_, setOpen] = useState(depth < 1);
  return (
    <div className="tree-node">
      <div className="tree-row" onClick={() => setOpen(!open_)}>
        <span className="tree-toggle">{stat.children.length > 0 ? (open_ ? "▾" : "▸") : "·"}</span>
        <span className="tree-name">
          {stat.name}
          {stat.has_errors && <span className="warn"> ⚠ 统计可能不完整</span>}
        </span>
        <span className="tree-count">{stat.file_count} 文件</span>
        <span className="tree-size">{humanSize(stat.total_size)}</span>
      </div>
      {open_ &&
        stat.children.map((c) => <TreeNode key={c.rel_path} stat={c} depth={depth + 1} />)}
    </div>
  );
}

export default function App() {
  const [path, setPath] = useState("");
  const [db, setDb] = useState("storagescope-snapshots.db");
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [tree, setTree] = useState<DirStat | null>(null);
  const [outcome, setOutcome] = useState<ScanOutcome | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [oldId, setOldId] = useState<number | null>(null);
  const [newId, setNewId] = useState<number | null>(null);
  const [report, setReport] = useState<DiffReport | null>(null);
  const [message, setMessage] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState<AnalyzeProgress | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisReport | null>(null);
  const [skipDupes, setSkipDupes] = useState(false);
  const [dupeMinMib, setDupeMinMib] = useState(1);

  useEffect(() => {
    const un = listen<Progress>("scan-progress", (e) => setProgress(e.payload));
    const un2 = listen<AnalyzeProgress>("analyze-progress", (e) =>
      setAnalyzeProgress(e.payload)
    );
    return () => {
      un.then((f) => f());
      un2.then((f) => f());
    };
  }, []);

  async function pickDir() {
    const p = await open({ directory: true });
    if (typeof p === "string") setPath(p);
  }

  async function doScan() {
    if (!path) return;
    setScanning(true);
    setMessage("");
    setProgress(null);
    try {
      const r = await invoke<{ outcome: ScanOutcome; tree: DirStat }>("scan_directory", { path });
      setOutcome(r.outcome);
      setTree(r.tree);
    } catch (e) {
      setMessage(String(e));
    } finally {
      setScanning(false);
    }
  }

  async function doSaveSnapshot() {
    if (!path || !db) return;
    setScanning(true);
    setMessage("");
    try {
      const r = await invoke<{ id: number; file_count: number; total_bytes: number }>(
        "save_snapshot",
        { path, db }
      );
      setMessage(`快照 #${r.id} 已保存（${r.file_count} 个文件，${humanSize(r.total_bytes)}）`);
      await refreshSnapshots();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setScanning(false);
    }
  }

  async function refreshSnapshots() {
    try {
      const list = await invoke<SnapshotMeta[]>("list_snapshots", { db });
      setSnapshots(list);
    } catch (e) {
      setMessage(String(e));
    }
  }

  async function doDiff() {
    if (oldId == null || newId == null) return;
    setMessage("");
    try {
      const r = await invoke<DiffReport>("diff_snapshots", { db, old: oldId, new: newId });
      setReport(r);
    } catch (e) {
      setMessage(String(e));
      setReport(null);
    }
  }

  async function doAnalyze() {
    if (!path) return;
    setAnalyzing(true);
    setMessage("");
    setAnalysis(null);
    setAnalyzeProgress(null);
    try {
      const r = await invoke<AnalysisReport>("analyze_cleanup", {
        path,
        top: 50,
        dupeMinMib: dupeMinMib,
        skipDupes,
      });
      setAnalysis(r);
    } catch (e) {
      setMessage(String(e));
    } finally {
      setAnalyzing(false);
    }
  }

  async function exportTree(fmt: string) {
    if (!tree) return;
    const p = await save({ defaultPath: `storagescope-统计.${fmt}` });
    if (!p) return;
    await invoke("export_tree", { tree, path: p, format: fmt });
    setMessage(`已导出：${p}`);
  }

  async function exportDiff(fmt: string) {
    if (!report) return;
    const p = await save({ defaultPath: `storagescope-差异.${fmt}` });
    if (!p) return;
    await invoke("export_diff", { report, path: p, format: fmt });
    setMessage(`已导出：${p}`);
  }

  return (
    <div className="app">
      <h1>StorageScope 存储显微镜</h1>

      <section className="card">
        <h2>1. 扫描目录</h2>
        <div className="row">
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="选择或输入目录路径" />
          <button onClick={pickDir}>浏览…</button>
          {!scanning ? (
            <button className="primary" onClick={doScan} disabled={!path}>
              开始扫描
            </button>
          ) : (
            <button className="danger" onClick={() => invoke("cancel_scan")}>
              取消
            </button>
          )}
        </div>
        {scanning && progress && (
          <div className="progress">
            已扫描 {progress.files} 个文件，{humanSize(progress.bytes)}
            {progress.errors > 0 && `，${progress.errors} 条异常`}
            <div className="current">{progress.current}</div>
          </div>
        )}
        {outcome && !scanning && (
          <div className="summary">
            {outcome.cancelled ? "⚠ 扫描被取消，结果不完整" : "扫描完成"}：
            {outcome.files.length} 个文件，耗时 {outcome.duration_ms} ms
            {outcome.errors.length > 0 && `，${outcome.errors.length} 条异常`}
          </div>
        )}
      </section>

      {tree && (
        <section className="card">
          <h2>2. 目录结构</h2>
          <div className="row">
            <button onClick={() => exportTree("json")}>导出 JSON</button>
            <button onClick={() => exportTree("csv")}>导出 CSV</button>
          </div>
          <div className="tree">
            <TreeNode stat={tree} depth={0} />
          </div>
        </section>
      )}

      <section className="card">
        <h2>3. 快照</h2>
        <div className="row">
          <input value={db} onChange={(e) => setDb(e.target.value)} placeholder="快照数据库路径" />
          <button onClick={doSaveSnapshot} disabled={!path || scanning}>
            扫描并保存快照
          </button>
          <button onClick={refreshSnapshots}>刷新列表</button>
        </div>
        {snapshots.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>根目录</th>
                <th>文件数</th>
                <th>大小</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((s) => (
                <tr key={s.id}>
                  <td>#{s.id}</td>
                  <td className="mono">{s.root}</td>
                  <td>{s.file_count}</td>
                  <td>{humanSize(s.total_bytes)}</td>
                  <td>{s.status === "complete" ? "完整" : "⚠ 不完整"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>4. 差异比较</h2>
        <div className="row">
          <select value={oldId ?? ""} onChange={(e) => setOldId(Number(e.target.value) || null)}>
            <option value="">旧快照…</option>
            {snapshots.map((s) => (
              <option key={s.id} value={s.id}>
                #{s.id}（{s.file_count} 文件）
              </option>
            ))}
          </select>
          <select value={newId ?? ""} onChange={(e) => setNewId(Number(e.target.value) || null)}>
            <option value="">新快照…</option>
            {snapshots.map((s) => (
              <option key={s.id} value={s.id}>
                #{s.id}（{s.file_count} 文件）
              </option>
            ))}
          </select>
          <button className="primary" onClick={doDiff} disabled={oldId == null || newId == null}>
            比较
          </button>
          {report && (
            <>
              <button onClick={() => exportDiff("json")}>导出 JSON</button>
              <button onClick={() => exportDiff("csv")}>导出 CSV</button>
            </>
          )}
        </div>
        {report && (
          <div>
            {report.warnings.map((w, i) => (
              <div key={i} className="warn">⚠ {w}</div>
            ))}
            <div className="summary">
              新增 {report.summary.added_files}（+{humanSize(report.summary.added_bytes)}），删除{" "}
              {report.summary.removed_files}（-{humanSize(report.summary.removed_bytes)}），增长{" "}
              {report.summary.grown_files}，缩减 {report.summary.shrunk_files}；净变化{" "}
              {report.summary.net_bytes} B
            </div>
            <table>
              <thead>
                <tr>
                    <th>变化</th>
                  <th>文件</th>
                  <th>旧大小</th>
                  <th>新大小</th>
                </tr>
              </thead>
              <tbody>
                {report.files.slice(0, 50).map((c) => (
                  <tr key={c.rel_path}>
                    <td>{KIND_LABEL[c.kind]}</td>
                    <td className="mono">{c.rel_path}</td>
                    <td>{c.old_size == null ? "—" : humanSize(c.old_size)}</td>
                    <td>{c.new_size == null ? "—" : humanSize(c.new_size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {message && <div className="message">{message}</div>}

      <section className="card">
        <h2>5. 清理建议</h2>
        <div className="row">
          <label className="check">
            <input
              type="checkbox"
              checked={skipDupes}
              onChange={(e) => setSkipDupes(e.target.checked)}
            />
            跳过重复文件检测（秒出，但不挖重复占的空间）
          </label>
          <label className="check">
            重复检测最小体积
            <input
              className="num"
              type="number"
              min={1}
              value={dupeMinMib}
              onChange={(e) => setDupeMinMib(Number(e.target.value) || 1)}
            />
            MiB
          </label>
          {!analyzing ? (
            <button className="primary" onClick={doAnalyze} disabled={!path}>
              开始分析
            </button>
          ) : (
            <button className="danger" onClick={() => invoke("cancel_scan")}>
              取消
            </button>
          )}
        </div>
        {analyzing && (
          <div className="progress">
            {analyzeProgress
              ? `哈希校验中：${analyzeProgress.done} / ${analyzeProgress.total} 个候选文件`
              : progress
                ? `扫描中：${progress.files} 个文件，${humanSize(progress.bytes)}`
                : "正在启动…"}
          </div>
        )}
        {analysis && (
          <div>
            <div className="summary">
              估算可回收：<b>{humanSize(analysis.reclaimable_bytes)}</b>
              （安全级缓存 + 重复冗余，为估算上限）
              {!skipDupes &&
                `；哈希校验读取 ${humanSize(analysis.hashed_bytes)}，失败 ${analysis.hash_errors} 个文件`}
            </div>

            <h3>缓存 / 可清理项（{analysis.cache_hits.length}）</h3>
            {analysis.cache_hits.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>大小</th>
                    <th>目录</th>
                    <th>建议</th>
                    <th>规则</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.cache_hits.slice(0, 30).map((h) => (
                    <tr key={h.rel_path}>
                      <td>{humanSize(h.size)}</td>
                      <td className="mono">{h.rel_path}</td>
                      <td>{h.safety === "SafeToDelete" ? "可安全清理" : "建议确认"}</td>
                      <td title={h.reason}>{h.rule_name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <h3>大文件 Top {analysis.big_files.length}</h3>
            <table>
              <thead>
                <tr>
                  <th>大小</th>
                  <th>文件</th>
                </tr>
              </thead>
              <tbody>
                {analysis.big_files.slice(0, 20).map((f) => (
                  <tr key={f.rel_path}>
                    <td>{humanSize(f.size)}</td>
                    <td className="mono">{f.rel_path}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {!skipDupes && (
              <>
                <h3>重复文件组（{analysis.dupe_groups.length} 组）</h3>
                {analysis.dupe_groups.length === 0 ? (
                  <div className="summary">未发现内容完全相同的重复文件</div>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>单份大小</th>
                        <th>份数</th>
                        <th>冗余</th>
                        <th>路径（第一份保留，其余可删）</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analysis.dupe_groups.slice(0, 20).map((g) => (
                        <tr key={g.hash}>
                          <td>{humanSize(g.size)}</td>
                          <td>×{g.files.length}</td>
                          <td>{humanSize(g.wasted)}</td>
                          <td className="mono">
                            {g.files.slice(0, 4).map((p) => (
                              <div key={p}>{p}</div>
                            ))}
                            {g.files.length > 4 && <div>… 以及另外 {g.files.length - 4} 份</div>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {analysis.dupe_groups.length > 20 && (
                  <div className="summary">仅显示前 20 组，共 {analysis.dupe_groups.length} 组</div>
                )}
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
