import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import CityView from "./CityView";
import HierarchyViews from "./HierarchyViews";
import Tree3DView from "./Tree3DView";
import TrendChart from "./TrendChart";
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
  recorded_at: number;
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

type Section = "scan" | "structure" | "snap" | "diff" | "clean";

const NAV: { id: Section; no: string; label: string }[] = [
  { id: "scan", no: "01", label: "扫描目录" },
  { id: "structure", no: "02", label: "目录结构" },
  { id: "snap", no: "03", label: "快照与趋势" },
  { id: "diff", no: "04", label: "差异比较" },
  { id: "clean", no: "05", label: "清理建议" },
];

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

/** 品牌标：立体树线稿（与 3D 树视图、应用图标同一语言） */
function BrandMark() {
  return (
    <svg width="34" height="34" viewBox="0 0 34 34" fill="none" aria-hidden>
      <rect x="1" y="1" width="32" height="32" rx="8" fill="#0d1a29" stroke="#23486a" />
      <path d="M17 10v5m0 0-6 4m6-4 6 4M11 19l-3 6m3-6 3 6m9-6-3 6m3-6 3 6" stroke="#6fe0e8" strokeWidth="1.4" />
      <circle cx="17" cy="8" r="2.6" fill="#6fe0e8" />
      <circle cx="11" cy="19" r="2" fill="#6fe0e8" opacity="0.8" />
      <circle cx="23" cy="19" r="2" fill="#6fe0e8" opacity="0.8" />
      <rect x="6" y="24" width="4" height="4" rx="1" fill="#ff9f43" />
      <rect x="15" y="24" width="4" height="4" rx="1" fill="#6fe0e8" opacity="0.65" />
      <rect x="24" y="24" width="4" height="4" rx="1" fill="#6fe0e8" opacity="0.65" />
    </svg>
  );
}

export default function App() {
  const [section, setSection] = useState<Section>("scan");
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
  const [autoMinutes, setAutoMinutes] = useState(0);
  const [viewMode, setViewMode] = useState<"list" | "hier" | "city" | "tree3d">("list");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [trashing, setTrashing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeProgress, setMergeProgress] = useState<AnalyzeProgress | null>(null);

  type MergeReport = {
    results: { path: string; status: string; detail: string | null }[];
    merged_files: number;
    freed_bytes: number;
    skipped: number;
    failed: number;
  };

  // M10 空间合并：重复副本合并为硬链接，路径不动、空间真实释放
  async function doMerge() {
    if (!analysis || analysis.dupe_groups.length === 0) return;
    const totalWasted = analysis.dupe_groups.reduce((s, g) => s + g.wasted, 0);
    if (!window.confirm(
      `把 ${analysis.dupe_groups.length} 组重复文件合并为硬链接？\n预计释放 ${humanSize(totalWasted)}。\n\n所有文件路径保留、程序照常运行；合并前逐组重新校验内容，失败自动回滚。`
    )) return;
    setMerging(true);
    setMessage("");
    setMergeProgress(null);
    try {
      const r = await invoke<MergeReport>("merge_duplicates", {
        root: path,
        groups: analysis.dupe_groups,
      });
      const mergedPaths = new Set(r.results.filter((x) => x.status === "merged").map((x) => x.path));
      setAnalysis({
        ...analysis,
        dupe_groups: analysis.dupe_groups
          .map((g) => {
            const files = g.files.filter((p, i) => i === 0 || !mergedPaths.has(p));
            return { ...g, files, wasted: g.size * Math.max(0, files.length - 1) };
          })
          .filter((g) => g.files.length > 1),
      });
      const failDetail = r.results
        .filter((x) => x.status !== "merged" && x.detail)
        .slice(0, 5)
        .map((x) => `${x.path}：${x.detail}`)
        .join("\n");
      setMessage(
        `空间合并完成：合并 ${r.merged_files} 个副本，实际释放 ${humanSize(r.freed_bytes)}` +
          `${r.skipped > 0 ? `；${r.skipped} 个内容已变化跳过` : ""}${r.failed > 0 ? `；${r.failed} 个失败` : ""}` +
          (failDetail ? `\n${failDetail}` : "")
      );
    } catch (e) {
      setMessage(String(e));
    } finally {
      setMerging(false);
    }
  }

  // 自动快照：应用开着期间按间隔保存；正在扫描时跳过本轮
  useEffect(() => {
    if (autoMinutes <= 0 || !path || !db) return;
    const t = setInterval(() => {
      if (!scanning) void doSaveSnapshot();
    }, autoMinutes * 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoMinutes, path, db, scanning]);

  // 进入快照/差异航段时自动刷新快照列表
  useEffect(() => {
    if (section === "snap" || section === "diff") void refreshSnapshots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section]);

  // M7 视图联动：可清理目录集合 = 缓存命中目录 + 含重复文件的目录
  const cleanableDirs = useMemo(() => {
    const s = new Set<string>();
    if (analysis) {
      for (const h of analysis.cache_hits) s.add(h.rel_path);
      for (const g of analysis.dupe_groups) {
        for (const p of g.files) {
          const i = p.lastIndexOf("/");
          s.add(i >= 0 ? p.slice(0, i) : "");
        }
      }
    }
    return s;
  }, [analysis]);

  type TrashReport = {
    results: { path: string; ok: boolean; error: string | null }[];
    succeeded: number;
    failed: number;
  };

  function toggleOne(rel: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });
  }

  function toggleDupeGroup(g: DupeGroup) {
    const rest = g.files.slice(1);
    setSelected((prev) => {
      const next = new Set(prev);
      const allIn = rest.every((p) => next.has(p));
      for (const p of rest) {
        if (allIn) next.delete(p);
        else next.add(p);
      }
      return next;
    });
  }

  function selectedBytes(): number {
    if (!analysis) return 0;
    let sum = 0;
    for (const h of analysis.cache_hits) if (selected.has(h.rel_path)) sum += h.size;
    for (const g of analysis.dupe_groups) {
      for (const p of g.files.slice(1)) if (selected.has(p)) sum += g.size;
    }
    return sum;
  }

  async function doTrash() {
    if (!analysis || selected.size === 0) return;
    const n = selected.size;
    if (!window.confirm(`确认把 ${n} 项（约 ${humanSize(selectedBytes())}）移入系统回收站？\n可在回收站中恢复。`)) return;
    setTrashing(true);
    setMessage("");
    try {
      const r = await invoke<TrashReport>("move_to_trash", { root: path, relPaths: [...selected] });
      const gone = new Set(r.results.filter((x) => x.ok).map((x) => x.path));
      const isGone = (rel: string) =>
        [...gone].some((p) => p.replace(/\\/g, "/").endsWith(rel.replace(/\\/g, "/")));
      setAnalysis({
        ...analysis,
        cache_hits: analysis.cache_hits.filter((h) => !isGone(h.rel_path)),
        dupe_groups: analysis.dupe_groups
          .map((g) => ({ ...g, files: g.files.filter((p) => !isGone(p)) }))
          .filter((g) => g.files.length > 1),
      });
      setSelected(new Set());
      const failDetail = r.results
        .filter((x) => !x.ok)
        .slice(0, 5)
        .map((x) => `${x.path}：${x.error}`)
        .join("\n");
      setMessage(
        `已移入回收站 ${r.succeeded} 项${r.failed > 0 ? `，失败 ${r.failed} 项：\n${failDetail}` : "，可在系统回收站恢复"}`
      );
    } catch (e) {
      setMessage(String(e));
    } finally {
      setTrashing(false);
    }
  }

  useEffect(() => {
    const un = listen<Progress>("scan-progress", (e) => setProgress(e.payload));
    const un2 = listen<AnalyzeProgress>("analyze-progress", (e) =>
      setAnalyzeProgress(e.payload)
    );
    const un3 = listen<AnalyzeProgress>("merge-progress", (e) => setMergeProgress(e.payload));
    return () => {
      un.then((f) => f());
      un2.then((f) => f());
      un3.then((f) => f());
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
      setSection("structure"); // 扫描完成直接进入海图
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
    setSelected(new Set());
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
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <BrandMark />
          <div>
            <div className="brand-name">StorageScope</div>
            <div className="brand-sub">存储显微镜</div>
          </div>
        </div>
        {NAV.map((n) => (
          <button
            key={n.id}
            className={`nav-leg ${section === n.id ? "active" : ""}`}
            onClick={() => setSection(n.id)}
          >
            <span className="leg-no">{n.no}</span>
            {n.label}
          </button>
        ))}
        <div className="side-status">
          {outcome ? (
            <>
              <b>{outcome.root}</b>
              <br />
              {outcome.files.length} 个文件
              {tree && ` · ${humanSize(tree.total_size)}`}
              <br />
              {snapshots.length} 个快照在册
            </>
          ) : (
            <>尚未测绘任何海域。
              <br />
              从 01 扫描目录开始。</>
          )}
        </div>
      </aside>

      <main className="main">
        {section === "scan" && (
          <div className="page" key="scan">
            <h1 className="page-title">扫描目录</h1>
            <p className="page-desc">选定一片海域开始测绘：递归统计每个目录的体积与文件数。</p>
            <section className="panel">
              <div className="row">
                <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="选择或输入目录路径，如 D:\mc" />
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
            {outcome && !scanning && (
              <div className="empty">
                测绘完成。去 <b>02 目录结构</b> 看立体海图，或到 <b>05 清理建议</b> 打捞暗礁。
              </div>
            )}
          </div>
        )}

        {section === "structure" && (
          <div className="page" key="structure">
            <h1 className="page-title">目录结构</h1>
            <p className="page-desc">目录 = 海沟，体积 = 水深；橙色暗礁 = 含可清理项。</p>
            {tree ? (
              <section className="panel" id="structure-card">
                <div className="row">
                  <button className={viewMode === "list" ? "primary" : ""} onClick={() => setViewMode("list")}>
                    列表
                  </button>
                  <button className={viewMode === "hier" ? "primary" : ""} onClick={() => setViewMode("hier")}>
                    层级图
                  </button>
                  <button className={viewMode === "tree3d" ? "primary" : ""} onClick={() => setViewMode("tree3d")}>
                    3D 树
                  </button>
                  <span style={{ flex: 1 }} />
                  <button onClick={() => exportTree("json")}>导出 JSON</button>
                  <button onClick={() => exportTree("csv")}>导出 CSV</button>
                </div>
                {viewMode === "tree3d" && <Tree3DView tree={tree} highlight={cleanableDirs} />}
                {viewMode === "hier" && <HierarchyViews tree={tree} highlight={cleanableDirs} />}
                {viewMode === "city" && (
                  <>
                    <div className="summary">
                      每栋楼 = 一个目录，楼高 ∝ 体积（对数刻度），同街区同色系。拖动旋转，滚轮缩放。
                    </div>
                    <CityView tree={tree} />
                  </>
                )}
                {viewMode === "list" && (
                  <div className="tree">
                    <TreeNode stat={tree} depth={0} />
                  </div>
                )}
              </section>
            ) : (
              <div className="empty">
                还没有数据。先到 <b>01 扫描目录</b> 完成一次测绘，这里会展开列表、层级图和 3D 立体树。
              </div>
            )}
          </div>
        )}

        {section === "snap" && (
          <div className="page" key="snap">
            <h1 className="page-title">快照与趋势</h1>
            <p className="page-desc">给海域留下坐标记录，看磁盘随时间的膨胀曲线。</p>
            <section className="panel">
              <div className="row">
                <input value={db} onChange={(e) => setDb(e.target.value)} placeholder="快照数据库路径" />
                <button onClick={doSaveSnapshot} disabled={!path || scanning}>
                  扫描并保存快照
                </button>
                <button onClick={refreshSnapshots}>刷新列表</button>
                <span style={{ flex: 1 }} />
                <label className="check">
                  自动快照
                  <select value={autoMinutes} onChange={(e) => setAutoMinutes(Number(e.target.value))}>
                    <option value={0}>关闭</option>
                    <option value={15}>每 15 分钟</option>
                    <option value={60}>每小时</option>
                    <option value={360}>每 6 小时</option>
                  </select>
                </label>
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
              <TrendChart snapshots={snapshots.filter((s) => s.status === "complete")} />
              {snapshots.length === 0 && (
                <div className="empty">还没有快照。设定扫描路径后点"扫描并保存快照"，两次记录后即可看到趋势。</div>
              )}
            </section>
          </div>
        )}

        {section === "diff" && (
          <div className="page" key="diff">
            <h1 className="page-title">差异比较</h1>
            <p className="page-desc">对比两次快照，新增、删除、增长、缩减一目了然。</p>
            <section className="panel">
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
              {report ? (
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
                    <tbody key={`${oldId}-${newId}`}>
                      {report.files.slice(0, 50).map((c) => (
                        <tr key={c.rel_path} className="sounder">
                          <td>{KIND_LABEL[c.kind]}</td>
                          <td className="mono">{c.rel_path}</td>
                          <td>{c.old_size == null ? "—" : humanSize(c.old_size)}</td>
                          <td>{c.new_size == null ? "—" : humanSize(c.new_size)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="empty">选择两个快照后点"比较"。新出现的差异行会以琥珀色闪现提醒。</div>
              )}
            </section>
          </div>
        )}

        {section === "clean" && (
          <div className="page" key="clean">
            <h1 className="page-title">清理建议</h1>
            <p className="page-desc">打捞暗礁：缓存目录、大文件、重复副本。走系统回收站，可恢复。</p>
            <section className="panel">
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
              {!analysis && !analyzing && (
                <div className="empty">
                  在 01 设定扫描路径后点"开始分析"。分析完成后，橙色暗礁会同步标到 02 的 3D 树上。
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

                  <div className="danger-zone">
                    <button
                      className="danger"
                      onClick={doTrash}
                      disabled={selected.size === 0 || trashing}
                    >
                      {trashing ? "正在移入回收站…" : `移入回收站（${selected.size} 项，约 ${humanSize(selectedBytes())}）`}
                    </button>
                    <span className="summary" style={{ margin: 0 }}>
                      勾选要清理的项；重复文件组始终保留第一份。
                    </span>
                    <span style={{ flex: 1 }} />
                    {tree && (
                      <button
                        onClick={() => {
                          setViewMode("tree3d");
                          setSection("structure");
                        }}
                      >
                        在 3D 树中查看（橙色 = 可清理）
                      </button>
                    )}
                  </div>

                  <h3>缓存 / 可清理项（{analysis.cache_hits.length}）</h3>
                  {analysis.cache_hits.length > 0 && (
                    <table>
                      <thead>
                        <tr>
                          <th></th>
                          <th>大小</th>
                          <th>目录</th>
                          <th>建议</th>
                          <th>规则</th>
                        </tr>
                      </thead>
                      <tbody>
                        {analysis.cache_hits.slice(0, 30).map((h) => (
                          <tr key={h.rel_path}>
                            <td>
                              <input
                                type="checkbox"
                                checked={selected.has(h.rel_path)}
                                onChange={() => toggleOne(h.rel_path)}
                              />
                            </td>
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
                      {analysis.dupe_groups.length > 0 && (
                        <div className="row">
                          <button className="primary" onClick={doMerge} disabled={merging}>
                            {merging
                              ? mergeProgress
                                ? `合并校验中 ${mergeProgress.done} / ${mergeProgress.total}…`
                                : "合并中…"
                              : `空间合并（预计释放 ${humanSize(analysis.dupe_groups.reduce((s, g) => s + g.wasted, 0))}）`}
                          </button>
                          <span className="summary" style={{ margin: 0 }}>
                            硬链接合并：所有路径保留、程序照跑，空间真实释放；合并前重新校验，失败回滚。
                          </span>
                        </div>
                      )}
                      {analysis.dupe_groups.length === 0 ? (
                        <div className="summary">未发现内容完全相同的重复文件</div>
                      ) : (
                        <table>
                          <thead>
                            <tr>
                              <th></th>
                              <th>单份大小</th>
                              <th>份数</th>
                              <th>冗余</th>
                              <th>路径（勾选 = 删除第一份以外的所有副本）</th>
                            </tr>
                          </thead>
                          <tbody>
                            {analysis.dupe_groups.slice(0, 20).map((g) => (
                              <tr key={g.hash}>
                                <td>
                                  <input
                                    type="checkbox"
                                    checked={g.files.length > 1 && g.files.slice(1).every((p) => selected.has(p))}
                                    onChange={() => toggleDupeGroup(g)}
                                  />
                                </td>
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
        )}

        {message && <div className="message">{message}</div>}
      </main>
    </div>
  );
}
