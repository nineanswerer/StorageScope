import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import CityView from "./CityView";
import StorageOverview from "./StorageOverview";
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

function signedSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  return `${bytes > 0 ? "+" : "−"}${humanSize(Math.abs(bytes))}`;
}

function formatSnapshotTime(seconds: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(seconds * 1000));
}

const KIND_LABEL: Record<string, string> = {
  Added: "新增",
  Removed: "删除",
  Grown: "增长",
  Shrunk: "缩减",
};

function TreeNode({ stat, depth }: { stat: DirStat; depth: number }) {
  const [open_, setOpen] = useState(depth < 1);
  const hasChildren = stat.children.length > 0;
  return (
    <div className="tree-node">
      <div
        className="tree-row"
        role={hasChildren ? "button" : undefined}
        tabIndex={hasChildren ? 0 : undefined}
        aria-expanded={hasChildren ? open_ : undefined}
        onClick={() => hasChildren && setOpen(!open_)}
        onKeyDown={(event) => {
          if (hasChildren && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            setOpen(!open_);
          }
        }}
      >
        <span className="tree-toggle" aria-hidden>{hasChildren ? (open_ ? "▾" : "▸") : "·"}</span>
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

/** 品牌标：磁盘与占用量线稿，直接表达工具用途。 */
function BrandMark() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden>
      <path d="M6 6h20l2 14H4L6 6Z" stroke="#8ea9c4" strokeWidth="1.4" />
      <path d="M4 20h24v6H4v-6Z" stroke="#8ea9c4" strokeWidth="1.4" />
      <path d="M8 23h10" stroke="#8ea9c4" strokeWidth="2" />
      <path d="M9 11h14" stroke="#808993" strokeWidth="1.2" />
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

  // 一键安全释放（M11）：零决策路径——安全缓存进回收站 + 重复文件自动硬链接合并。
  // 需要人工判断的项（ReviewAdvised、大文件）绝不动。
  const [quickRunning, setQuickRunning] = useState(false);
  async function doQuickRelease() {
    if (!analysis) return;
    const safeHits = analysis.cache_hits.filter((h) => h.safety === "SafeToDelete");
    const cacheBytes = safeHits.reduce((s, h) => s + h.size, 0);
    const dupeBytes = analysis.dupe_groups.reduce((s, g) => s + g.wasted, 0);
    if (safeHits.length === 0 && analysis.dupe_groups.length === 0) {
      setMessage("没有可安全释放的项（无安全级缓存、无重复文件）。");
      return;
    }
    if (!window.confirm(
      `一键安全释放约 ${humanSize(cacheBytes + dupeBytes)}？\n\n` +
        `· ${safeHits.length} 个安全级缓存目录（${humanSize(cacheBytes)}）→ 回收站\n` +
        `· ${analysis.dupe_groups.length} 组重复文件（${humanSize(dupeBytes)}）→ 硬链接合并，路径不动\n\n` +
        `需要你判断的项目不会动。`
    )) return;
    setQuickRunning(true);
    setMessage("");
    const notes: string[] = [];
    let next = analysis;
    try {
      // 先合并（不删数据），再清缓存
      if (analysis.dupe_groups.length > 0) {
        const r = await invoke<MergeReport>("merge_duplicates", {
          root: path,
          groups: analysis.dupe_groups,
        });
        notes.push(`合并 ${r.merged_files} 个副本，释放 ${humanSize(r.freed_bytes)}`);
        const mergedPaths = new Set(r.results.filter((x) => x.status === "merged").map((x) => x.path));
        next = {
          ...next,
          dupe_groups: next.dupe_groups
            .map((g) => {
              const files = g.files.filter((p, i) => i === 0 || !mergedPaths.has(p));
              return { ...g, files, wasted: g.size * Math.max(0, files.length - 1) };
            })
            .filter((g) => g.files.length > 1),
        };
        if (r.failed > 0 || r.skipped > 0) notes.push(`${r.skipped} 个已变化跳过、${r.failed} 个失败`);
      }
      if (safeHits.length > 0) {
        const r = await invoke<TrashReport>("move_to_trash", {
          root: path,
          relPaths: safeHits.map((h) => h.rel_path),
        });
        notes.push(`${r.succeeded} 个缓存目录进回收站`);
        const gone = new Set(r.results.filter((x) => x.ok).map((x) => x.path));
        const isGone = (rel: string) =>
          [...gone].some((p) => p.replace(/\\/g, "/").endsWith(rel.replace(/\\/g, "/")));
        next = { ...next, cache_hits: next.cache_hits.filter((h) => !isGone(h.rel_path)) };
        if (r.failed > 0) notes.push(`${r.failed} 个缓存删除失败`);
      }
      setAnalysis(next);
      setSelected(new Set());
      setMessage(`一键安全释放完成：${notes.join("；")}`);
    } catch (e) {
      setMessage(String(e));
    } finally {
      setQuickRunning(false);
    }
  }

  // 操作闭环：定位到资源管理器 / 复制绝对路径
  function absOf(rel: string) {
    return `${path.replace(/[\\/]+$/, "")}\\${rel.replace(/\//g, "\\")}`;
  }
  async function reveal(rel: string) {
    try {
      await invoke("reveal_in_explorer", { root: path, relPath: rel });
    } catch (e) {
      setMessage(String(e));
    }
  }
  async function copyPath(rel: string) {
    try {
      await navigator.clipboard.writeText(absOf(rel));
      setMessage(`已复制路径：${absOf(rel)}`);
    } catch {
      setMessage(`复制失败，请手动复制：${absOf(rel)}`);
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

  // 进入快照/差异页面时自动刷新快照列表
  useEffect(() => {
    if (section === "snap" || section === "diff") void refreshSnapshots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section]);

  // 首次进入差异页时预选最近两次快照，用户仍可手动更换。
  useEffect(() => {
    if (section !== "diff" || snapshots.length < 2 || oldId != null || newId != null) return;
    setOldId(snapshots[snapshots.length - 2].id);
    setNewId(snapshots[snapshots.length - 1].id);
  }, [section, snapshots, oldId, newId]);

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
      setSection("structure"); // 扫描完成直接进入目录结构
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
    setProgress(null);
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
    if (oldId == null || newId == null || oldId === newId) return;
    setMessage("");
    setReport(null);
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

  const snapshotStats = useMemo(() => {
    const complete = snapshots.filter((s) => s.status === "complete");
    const latest = complete[complete.length - 1];
    const previous = complete[complete.length - 2];
    return {
      complete,
      latest,
      delta: latest && previous ? latest.total_bytes - previous.total_bytes : null,
    };
  }, [snapshots]);

  const changedDirs = useMemo(
    () => report?.dirs.slice().sort((a, b) => Math.abs(b.net_bytes) - Math.abs(a.net_bytes)) ?? [],
    [report]
  );

  const diffBytes = useMemo(() => {
    const bytes: Record<FileChange["kind"], number> = { Added: 0, Removed: 0, Grown: 0, Shrunk: 0 };
    for (const c of report?.files ?? []) {
      if (c.kind === "Added") bytes.Added += c.new_size ?? 0;
      if (c.kind === "Removed") bytes.Removed += c.old_size ?? 0;
      if (c.kind === "Grown") bytes.Grown += (c.new_size ?? 0) - (c.old_size ?? 0);
      if (c.kind === "Shrunk") bytes.Shrunk += (c.old_size ?? 0) - (c.new_size ?? 0);
    }
    return bytes;
  }, [report]);

  const cleanupStats = useMemo(() => {
    const safeHits = analysis?.cache_hits.filter((h) => h.safety === "SafeToDelete") ?? [];
    const reviewHits = analysis?.cache_hits.filter((h) => h.safety === "ReviewAdvised") ?? [];
    return {
      safeCount: safeHits.length,
      safeBytes: safeHits.reduce((sum, h) => sum + h.size, 0),
      reviewCount: reviewHits.length,
      reviewBytes: reviewHits.reduce((sum, h) => sum + h.size, 0),
      dupeBytes: analysis?.dupe_groups.reduce((sum, g) => sum + g.wasted, 0) ?? 0,
    };
  }, [analysis]);

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <BrandMark />
          <div className="brand-copy">
            <div className="brand-name">StorageScope</div>
            <div className="brand-sub">磁盘空间管理</div>
          </div>
        </div>
        <nav className="workflow-nav" aria-label="磁盘管理工作流">
          {NAV.map((n) => (
            <button
              key={n.id}
              className={`nav-leg ${section === n.id ? "active" : ""}`}
              aria-current={section === n.id ? "page" : undefined}
              onClick={() => setSection(n.id)}
            >
              <span className="leg-no">{n.no}</span>
              <span className="leg-label">{n.label}</span>
            </button>
          ))}
        </nav>
        <div className="side-status">
          {outcome ? (
            <>
              <b>{outcome.root}</b>
              <br />
              {outcome.files.length} 个文件
              {tree && ` · ${humanSize(tree.total_size)}`}
              <br />
              {snapshots.length} 个快照
            </>
          ) : path ? (
            <>
              <b>{path}</b>
              <br />
              已设置目录，尚未生成结构扫描结果。
              <br />
              {snapshots.length} 个快照
            </>
          ) : (
            <>尚未扫描目录。
              <br />
              从 01 扫描目录开始。</>
          )}
        </div>
      </aside>

      <main className="main">
        {section === "scan" && (
          <div className="page" key="scan">
            <h1 className="page-title">扫描目录</h1>
            <p className="page-desc">选择要检查的目录，递归统计每个目录的空间占用与文件数。</p>
            <section className="panel scan-panel" aria-label="目录扫描设置">
              <div className="scan-form">
                <label className="field-label" htmlFor="scan-path">目录路径</label>
                <div className="scan-input-row">
                  <input
                    id="scan-path"
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    placeholder="例如 D:\Games 或 C:\Users"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button onClick={pickDir}>选择目录</button>
                </div>
                <div className="scan-form-footer">
                  <span className="field-hint">只读取目录与文件信息，不会修改文件内容。</span>
                  {!scanning ? (
                    <button className="primary" onClick={doScan} disabled={!path.trim()}>
                      开始扫描
                    </button>
                  ) : (
                    <button className="danger" onClick={() => invoke("cancel_scan")}>
                      取消扫描
                    </button>
                  )}
                </div>
              </div>
              {scanning && progress && (
                <div className="progress" role="status">
                  已扫描 {progress.files} 个文件，{humanSize(progress.bytes)}
                  {progress.errors > 0 && `，${progress.errors} 条异常`}
                  <div className="current">{progress.current}</div>
                </div>
              )}
              {outcome && !scanning && (
                <div className="scan-result" role="status">
                  <div className="scan-result-copy">
                    <strong>{outcome.cancelled ? "扫描已取消，结果不完整" : "扫描完成"}</strong>
                    <span>
                      {outcome.files.length} 个文件{tree && ` · ${humanSize(tree.total_size)}`} · 耗时 {outcome.duration_ms} ms
                      {outcome.errors.length > 0 && ` · ${outcome.errors.length} 条异常`}
                    </span>
                  </div>
                  <div className="result-actions">
                    <button className="primary" onClick={() => setSection("structure")}>查看目录结构</button>
                    <button onClick={() => setSection("clean")}>分析可回收空间</button>
                  </div>
                </div>
              )}
            </section>
            {outcome && tree && !scanning && <StorageOverview tree={tree} />}
          </div>
        )}

        {section === "structure" && (
          <div className="page" key="structure">
            <h1 className="page-title">目录结构</h1>
            <p className="page-desc">按目录查看空间占用；橙色标记表示包含可清理项。</p>
            {tree ? (
              <>
                <StorageOverview tree={tree} />
                <section className="panel" id="structure-card">
                  <div className="view-toolbar">
                    <div className="segmented-control" role="group" aria-label="目录视图">
                      <button className={viewMode === "list" ? "active" : ""} aria-pressed={viewMode === "list"} onClick={() => setViewMode("list")}>
                        列表
                      </button>
                      <button className={viewMode === "hier" ? "active" : ""} aria-pressed={viewMode === "hier"} onClick={() => setViewMode("hier")}>
                        层级图
                      </button>
                      <button className={viewMode === "tree3d" ? "active" : ""} aria-pressed={viewMode === "tree3d"} onClick={() => setViewMode("tree3d")}>
                        3D 树
                      </button>
                    </div>
                    <div className="toolbar-actions">
                      <button onClick={() => exportTree("json")}>导出 JSON</button>
                      <button onClick={() => exportTree("csv")}>导出 CSV</button>
                    </div>
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
              </>
            ) : (
              <div className="empty">
                <div>还没有扫描数据。完成一次扫描后，这里会显示空间分布、层级图和 3D 立体树。</div>
                <button onClick={() => setSection("scan")}>前往扫描目录</button>
              </div>
            )}
          </div>
        )}

        {section === "snap" && (
          <div className="page" key="snap">
            <h1 className="page-title">快照与趋势</h1>
            <p className="page-desc">定期记录目录状态，用真实快照观察占用变化，并为差异比较提供依据。</p>
            <section className="panel snapshot-panel" aria-label="快照记录与趋势">
              <div className="cleanup-settings">
                <div className="cleanup-settings-copy">
                  <h2>记录设置</h2>
                  <p>快照保存文件清单与大小，不复制文件内容；应用运行期间可按间隔自动记录。</p>
                </div>
                <div className="cleanup-controls">
                  <label className="db-field">
                    <span>快照数据库</span>
                    <input aria-label="快照数据库路径" value={db} onChange={(e) => setDb(e.target.value)} placeholder="快照数据库路径" />
                  </label>
                  <label className="check">
                    自动快照
                    <select aria-label="自动快照间隔" value={autoMinutes} onChange={(e) => setAutoMinutes(Number(e.target.value))}>
                      <option value={0}>关闭</option>
                      <option value={15}>每 15 分钟</option>
                      <option value={60}>每小时</option>
                      <option value={360}>每 6 小时</option>
                    </select>
                  </label>
                  <button onClick={refreshSnapshots}>刷新</button>
                  <button className="primary" onClick={doSaveSnapshot} disabled={!path.trim() || !db.trim() || scanning}>
                    {scanning ? "正在保存…" : "扫描并保存快照"}
                  </button>
                </div>
              </div>

              {scanning && (
                <div className="progress cleanup-progress" role="status">
                  {progress
                    ? `正在记录：${progress.files} 个文件，${humanSize(progress.bytes)}`
                    : "正在准备快照…"}
                  {progress?.current && <div className="current">{progress.current}</div>}
                </div>
              )}

              {snapshots.length === 0 && !scanning && (
                <div className="empty cleanup-empty">
                  {path
                    ? "还没有快照。点击“扫描并保存快照”建立第一条记录，保存两次后即可看到趋势。"
                    : "先选择要跟踪的目录，再回来保存快照。"}
                  {!path && <button onClick={() => setSection("scan")}>前往扫描目录</button>}
                </div>
              )}

              {snapshotStats.latest && (
                <dl className="cleanup-breakdown snapshot-breakdown" aria-label="最新快照统计">
                  <div>
                    <dt>最新占用 <span>#{snapshotStats.latest.id} · {formatSnapshotTime(snapshotStats.latest.recorded_at)}</span></dt>
                    <dd>{humanSize(snapshotStats.latest.total_bytes)}</dd>
                  </div>
                  <div>
                    <dt>较上次变化 <span>{snapshotStats.delta == null ? "需要两个有效快照" : "相邻有效快照"}</span></dt>
                    <dd className={snapshotStats.delta == null || snapshotStats.delta === 0 ? "delta-neutral" : snapshotStats.delta > 0 ? "delta-up" : "delta-down"}>
                      {snapshotStats.delta == null ? "—" : signedSize(snapshotStats.delta)}
                    </dd>
                  </div>
                  <div>
                    <dt>有效快照 <span>不完整记录不会进入趋势</span></dt>
                    <dd>{snapshotStats.complete.length} <span className="metric-total">/ {snapshots.length}</span></dd>
                  </div>
                </dl>
              )}

              {snapshotStats.complete.length > 0 && (
                <section className="cleanup-section trend-section" aria-labelledby="trend-heading">
                  <div className="section-heading">
                    <h2 id="trend-heading">占用趋势</h2>
                    <span>{snapshotStats.complete.length} 个有效快照</span>
                  </div>
                  <p className="section-desc">折线展示总占用；数据点包含快照编号、时间、文件数和大小。</p>
                  <TrendChart snapshots={snapshotStats.complete} />
                </section>
              )}

              {snapshots.length > 0 && (
                <section className="cleanup-section" aria-labelledby="snapshot-list-heading">
                  <div className="section-heading">
                    <h2 id="snapshot-list-heading">快照记录</h2>
                    <span>最新优先 · 共 {snapshots.length} 条</span>
                    {snapshots.length >= 2 && (
                      <button
                        className="section-action"
                        onClick={() => {
                          setOldId(snapshots[snapshots.length - 2].id);
                          setNewId(snapshots[snapshots.length - 1].id);
                          setReport(null);
                          setSection("diff");
                        }}
                      >
                        比较最近两次
                      </button>
                    )}
                  </div>
                  <p className="section-desc">每条记录包含扫描时的文件总数和总大小；不完整记录可用于排查，但不进入趋势图。</p>
                  <div className="table-scroll">
                    <table className="cleanup-table snapshot-table">
                      <thead>
                        <tr>
                          <th>ID</th>
                          <th>记录时间</th>
                          <th>根目录</th>
                          <th className="size-cell">文件数</th>
                          <th className="size-cell">大小</th>
                          <th>状态</th>
                        </tr>
                      </thead>
                      <tbody>
                        {snapshots.slice().reverse().map((s) => (
                          <tr key={s.id}>
                            <td>#{s.id}</td>
                            <td className="snapshot-time">{formatSnapshotTime(s.recorded_at)}</td>
                            <td className="mono" title={s.root}>{s.root}</td>
                            <td className="size-cell">{s.file_count.toLocaleString("zh-CN")}</td>
                            <td className="size-cell">{humanSize(s.total_bytes)}</td>
                            <td className={s.status === "complete" ? "status-safe" : "status-review"}>
                              {s.status === "complete" ? "完整" : "不完整"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
            </section>
          </div>
        )}

        {section === "diff" && (
          <div className="page" key="diff">
            <h1 className="page-title">差异比较</h1>
            <p className="page-desc">比较两个时点的文件与目录变化，区分新增、删除、增长和缩减。</p>
            <section className="panel diff-panel" aria-label="快照差异比较">
              <div className="cleanup-settings">
                <div className="cleanup-settings-copy">
                  <h2>比较范围</h2>
                  <p>旧快照作为基准，新快照作为结果；净变化为正表示占用增加。</p>
                </div>
                <div className="diff-picker">
                  <label className="snapshot-select">
                    <span>旧快照</span>
                    <select
                      aria-label="旧快照"
                      value={oldId ?? ""}
                      onChange={(e) => {
                        setOldId(Number(e.target.value) || null);
                        setReport(null);
                      }}
                    >
                      <option value="">选择基准…</option>
                      {snapshots.map((s) => (
                        <option key={s.id} value={s.id}>
                          #{s.id} · {formatSnapshotTime(s.recorded_at)} · {humanSize(s.total_bytes)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    aria-label="交换新旧快照"
                    disabled={oldId == null || newId == null}
                    onClick={() => {
                      setOldId(newId);
                      setNewId(oldId);
                      setReport(null);
                    }}
                  >
                    交换
                  </button>
                  <label className="snapshot-select">
                    <span>新快照</span>
                    <select
                      aria-label="新快照"
                      value={newId ?? ""}
                      onChange={(e) => {
                        setNewId(Number(e.target.value) || null);
                        setReport(null);
                      }}
                    >
                      <option value="">选择结果…</option>
                      {snapshots.map((s) => (
                        <option key={s.id} value={s.id}>
                          #{s.id} · {formatSnapshotTime(s.recorded_at)} · {humanSize(s.total_bytes)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button className="primary" onClick={doDiff} disabled={oldId == null || newId == null || oldId === newId}>
                    比较
                  </button>
                </div>
              </div>

              {oldId != null && oldId === newId && (
                <div className="warn selection-warning">请选择两个不同的快照。</div>
              )}

              {!report && (
                <div className="empty cleanup-empty">
                  {snapshots.length < 2
                    ? "至少需要两个快照才能比较。先保存另一条记录，再回来查看变化。"
                    : "选择两个不同的快照后点击“比较”，结果会按文件和目录分别展示。"}
                  {snapshots.length < 2 && <button onClick={() => setSection("snap")}>前往快照与趋势</button>}
                </div>
              )}

              {report && (
                <div className="diff-results">
                  <div className="action-panel">
                    <div className="action-main">
                      <div className="action-figure">
                        净变化 <b className={report.summary.net_bytes > 0 ? "delta-up" : report.summary.net_bytes < 0 ? "delta-down" : "delta-neutral"}>
                          {signedSize(report.summary.net_bytes)}
                        </b>
                      </div>
                      <div className="action-sub">
                        快照 #{oldId} → #{newId} · {report.files.length.toLocaleString("zh-CN")} 个文件发生变化
                      </div>
                    </div>
                    <div className="action-btns">
                      <button onClick={() => exportDiff("json")}>导出 JSON</button>
                      <button onClick={() => exportDiff("csv")}>导出 CSV</button>
                    </div>
                    <div className="action-note">净变化 = 新增与增长增加的空间 − 删除与缩减释放的空间。</div>
                  </div>

                  {report.warnings.length > 0 && (
                    <div className="warning-list" role="status">
                      {report.warnings.map((w, i) => <div key={i} className="warn">⚠ {w}</div>)}
                    </div>
                  )}

                  <dl className="cleanup-breakdown diff-breakdown" aria-label="文件变化分类统计">
                    <div>
                      <dt>新增文件 <span>增加占用</span></dt>
                      <dd>{report.summary.added_files.toLocaleString("zh-CN")} <span>+{humanSize(diffBytes.Added)}</span></dd>
                    </div>
                    <div>
                      <dt>删除文件 <span>释放占用</span></dt>
                      <dd>{report.summary.removed_files.toLocaleString("zh-CN")} <span>−{humanSize(diffBytes.Removed)}</span></dd>
                    </div>
                    <div>
                      <dt>增长文件 <span>内容体积增加</span></dt>
                      <dd>{report.summary.grown_files.toLocaleString("zh-CN")} <span>+{humanSize(diffBytes.Grown)}</span></dd>
                    </div>
                    <div>
                      <dt>缩减文件 <span>内容体积减少</span></dt>
                      <dd>{report.summary.shrunk_files.toLocaleString("zh-CN")} <span>−{humanSize(diffBytes.Shrunk)}</span></dd>
                    </div>
                  </dl>

                  <section className="cleanup-section" aria-labelledby="file-diff-heading">
                    <div className="section-heading">
                      <h2 id="file-diff-heading">文件变化</h2>
                      <span>{report.files.length.toLocaleString("zh-CN")} 项</span>
                    </div>
                    <p className="section-desc">变化量为新大小减去旧大小；新增文件的旧大小、删除文件的新大小显示为“—”。</p>
                    {report.files.length > 0 ? (
                      <div className="table-scroll">
                        <table className="cleanup-table diff-table">
                          <thead>
                            <tr>
                              <th>变化</th>
                              <th>文件</th>
                              <th className="size-cell">变化量</th>
                              <th className="size-cell">旧大小</th>
                              <th className="size-cell">新大小</th>
                            </tr>
                          </thead>
                          <tbody key={`${oldId}-${newId}`}>
                            {report.files.slice(0, 50).map((c) => {
                              const delta = (c.new_size ?? 0) - (c.old_size ?? 0);
                              return (
                                <tr key={c.rel_path}>
                                  <td className={`change-${c.kind.toLowerCase()}`}>{KIND_LABEL[c.kind]}</td>
                                  <td className="mono" title={c.rel_path}>{c.rel_path}</td>
                                  <td className={`size-cell ${delta > 0 ? "delta-up" : delta < 0 ? "delta-down" : "delta-neutral"}`}>{signedSize(delta)}</td>
                                  <td className="size-cell">{c.old_size == null ? "—" : humanSize(c.old_size)}</td>
                                  <td className="size-cell">{c.new_size == null ? "—" : humanSize(c.new_size)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="section-empty">两个快照之间没有文件大小或增删变化。</div>
                    )}
                    {report.files.length > 50 && (
                      <div className="summary">仅显示前 50 项，共 {report.files.length.toLocaleString("zh-CN")} 项；导出文件包含完整结果。</div>
                    )}
                  </section>

                  <section className="cleanup-section" aria-labelledby="dir-diff-heading">
                    <div className="section-heading">
                      <h2 id="dir-diff-heading">目录净变化</h2>
                      <span>{changedDirs.length.toLocaleString("zh-CN")} 个目录</span>
                    </div>
                    <p className="section-desc">按绝对变化量排序，快速定位空间增加或释放最集中的目录。</p>
                    {changedDirs.length > 0 ? (
                      <div className="table-scroll">
                        <table className="cleanup-table dir-diff-table">
                          <thead>
                            <tr>
                              <th>目录</th>
                              <th className="size-cell">净变化</th>
                              <th className="size-cell">变化文件数</th>
                            </tr>
                          </thead>
                          <tbody>
                            {changedDirs.slice(0, 20).map((d) => (
                              <tr key={d.rel_path}>
                                <td className="mono" title={d.rel_path}>{d.rel_path || "（根目录直属文件）"}</td>
                                <td className={`size-cell ${d.net_bytes > 0 ? "delta-up" : d.net_bytes < 0 ? "delta-down" : "delta-neutral"}`}>{signedSize(d.net_bytes)}</td>
                                <td className="size-cell">{d.changed_files.toLocaleString("zh-CN")}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="section-empty">没有目录级净变化。</div>
                    )}
                    {changedDirs.length > 20 && (
                      <div className="summary">仅显示绝对变化最大的前 20 个目录，共 {changedDirs.length.toLocaleString("zh-CN")} 个。</div>
                    )}
                  </section>
                </div>
              )}
            </section>
          </div>
        )}

        {section === "clean" && (
          <div className="page" key="clean">
            <h1 className="page-title">清理建议</h1>
            <p className="page-desc">先区分可安全释放与需要确认的项目，再决定如何处理；删除项进入系统回收站。</p>
            <section className="panel cleanup-panel" aria-label="可回收空间分析">
              <div className="cleanup-settings">
                <div className="cleanup-settings-copy">
                  <h2>分析设置</h2>
                  <p>重复检测会读取候选文件并校验内容，大目录需要更长时间。</p>
                </div>
                <div className="cleanup-controls">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={!skipDupes}
                      onChange={(e) => setSkipDupes(!e.target.checked)}
                    />
                    检测重复文件
                  </label>
                  <label className="dupe-threshold">
                    <span>最小体积</span>
                    <input
                      className="num"
                      aria-label="重复检测最小体积（MiB）"
                      type="number"
                      min={1}
                      value={dupeMinMib}
                      disabled={skipDupes}
                      onChange={(e) => setDupeMinMib(Number(e.target.value) || 1)}
                    />
                    <span>MiB</span>
                  </label>
                  {!analyzing ? (
                    <button className="primary" onClick={doAnalyze} disabled={!path.trim()}>
                      {analysis ? "重新分析" : "开始分析"}
                    </button>
                  ) : (
                    <button className="danger" onClick={() => invoke("cancel_scan")}>
                      取消分析
                    </button>
                  )}
                </div>
              </div>

              {analyzing && (
                <div className="progress cleanup-progress" role="status">
                  {analyzeProgress
                    ? `正在校验重复内容：${analyzeProgress.done} / ${analyzeProgress.total} 个候选文件`
                    : progress
                      ? `正在扫描：${progress.files} 个文件，${humanSize(progress.bytes)}`
                      : "正在启动分析…"}
                  {progress?.current && <div className="current">{progress.current}</div>}
                </div>
              )}

              {!analysis && !analyzing && (
                <div className="empty cleanup-empty">
                  {path
                    ? "点击“开始分析”，结果会按缓存、大文件和重复副本分类，并同步标记到目录结构。"
                    : "先选择要分析的目录，再回来查看清理建议。"}
                  {!path && <button onClick={() => setSection("scan")}>前往扫描目录</button>}
                </div>
              )}

              {analysis && (
                <div className="cleanup-results">
                  <div className="action-panel">
                    <div className="action-main">
                      <div className="action-figure">
                        可安全释放 <b>{humanSize(cleanupStats.safeBytes + cleanupStats.dupeBytes)}</b>
                      </div>
                      <div className="action-sub">
                        安全缓存与重复冗余的估算上限
                        {!skipDupes &&
                          ` · 已校验 ${humanSize(analysis.hashed_bytes)}${analysis.hash_errors > 0 ? ` · ${analysis.hash_errors} 个文件校验失败` : ""}`}
                      </div>
                    </div>
                    <div className="action-btns">
                      <button
                        className="primary"
                        onClick={doQuickRelease}
                        disabled={quickRunning || merging || trashing || cleanupStats.safeBytes + cleanupStats.dupeBytes === 0}
                      >
                        {quickRunning ? "正在安全释放…" : "一键安全释放"}
                      </button>
                      {tree && (
                        <button
                          onClick={() => {
                            setViewMode("tree3d");
                            setSection("structure");
                          }}
                        >
                          在目录结构中查看
                        </button>
                      )}
                    </div>
                    <div className="action-note">
                      安全缓存移入回收站；重复文件合并为硬链接并保留所有路径。待确认项目和大文件不会自动处理。
                    </div>
                  </div>

                  <dl className="cleanup-breakdown" aria-label="清理结果分类统计">
                    <div>
                      <dt>安全缓存 <span>{cleanupStats.safeCount} 项</span></dt>
                      <dd>{humanSize(cleanupStats.safeBytes)}</dd>
                    </div>
                    <div>
                      <dt>待确认缓存 <span>{cleanupStats.reviewCount} 项</span></dt>
                      <dd>{humanSize(cleanupStats.reviewBytes)}</dd>
                    </div>
                    <div>
                      <dt>重复冗余 <span>{analysis.dupe_groups.length} 组</span></dt>
                      <dd>{humanSize(cleanupStats.dupeBytes)}</dd>
                    </div>
                  </dl>

                  <div className="selection-bar">
                    <div className="selection-copy">
                      <strong>手动清理</strong>
                      <span>勾选缓存或重复副本后移入回收站；每组重复文件始终保留第一份。</span>
                    </div>
                    <button
                      className="danger"
                      onClick={doTrash}
                      disabled={selected.size === 0 || trashing || quickRunning}
                    >
                      {trashing ? "正在移入回收站…" : `移入回收站（${selected.size} 项 · ${humanSize(selectedBytes())}）`}
                    </button>
                  </div>

                  <section className="cleanup-section" aria-labelledby="cache-heading">
                    <div className="section-heading">
                      <h2 id="cache-heading">缓存与可清理目录</h2>
                      <span>{analysis.cache_hits.length} 项</span>
                    </div>
                    <p className="section-desc">“可安全清理”会进入一键释放；“建议确认”只能由你手动勾选。</p>
                    {analysis.cache_hits.length > 0 ? (
                      <div className="table-scroll">
                        <table className="cleanup-table cache-table">
                          <thead>
                            <tr>
                              <th className="check-cell"><span className="sr-only">选择</span></th>
                              <th className="size-cell">大小</th>
                              <th>目录</th>
                              <th>建议</th>
                              <th>识别规则</th>
                              <th>操作</th>
                            </tr>
                          </thead>
                          <tbody>
                            {analysis.cache_hits.slice(0, 30).map((h) => (
                              <tr key={h.rel_path}>
                                <td className="check-cell">
                                  <input
                                    type="checkbox"
                                    aria-label={`选择 ${h.rel_path}`}
                                    checked={selected.has(h.rel_path)}
                                    onChange={() => toggleOne(h.rel_path)}
                                  />
                                </td>
                                <td className="size-cell">{humanSize(h.size)}</td>
                                <td className="mono" title={h.rel_path}>{h.rel_path}</td>
                                <td className={h.safety === "SafeToDelete" ? "status-safe" : "status-review"}>
                                  {h.safety === "SafeToDelete" ? "可安全清理" : "建议确认"}
                                </td>
                                <td title={h.reason}>{h.rule_name}</td>
                                <td className="row-actions">
                                  <button type="button" className="row-link" onClick={() => reveal(h.rel_path)}>定位</button>
                                  <button type="button" className="row-link" onClick={() => copyPath(h.rel_path)}>复制路径</button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="section-empty">未命中缓存或可清理目录规则。</div>
                    )}
                    {analysis.cache_hits.length > 30 && (
                      <div className="summary">仅显示前 30 项，共 {analysis.cache_hits.length} 项；一键释放会处理全部安全级项目。</div>
                    )}
                  </section>

                  <section className="cleanup-section" aria-labelledby="large-heading">
                    <div className="section-heading">
                      <h2 id="large-heading">大文件</h2>
                      <span>Top {analysis.big_files.length}</span>
                    </div>
                    <p className="section-desc">仅用于定位和判断，不参与一键释放，也不能在此直接勾选删除。</p>
                    {analysis.big_files.length > 0 ? (
                      <div className="table-scroll">
                        <table className="cleanup-table large-file-table">
                          <thead>
                            <tr>
                              <th className="size-cell">大小</th>
                              <th>文件</th>
                              <th>操作</th>
                            </tr>
                          </thead>
                          <tbody>
                            {analysis.big_files.slice(0, 20).map((f) => (
                              <tr key={f.rel_path}>
                                <td className="size-cell">{humanSize(f.size)}</td>
                                <td className="mono" title={f.rel_path}>{f.rel_path}</td>
                                <td className="row-actions">
                                  <button type="button" className="row-link" onClick={() => reveal(f.rel_path)}>定位</button>
                                  <button type="button" className="row-link" onClick={() => copyPath(f.rel_path)}>复制路径</button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="section-empty">当前目录没有可列出的大文件。</div>
                    )}
                  </section>

                  {!skipDupes && (
                    <section className="cleanup-section" aria-labelledby="dupe-heading">
                      <div className="section-heading">
                        <h2 id="dupe-heading">重复文件</h2>
                        <span>{analysis.dupe_groups.length} 组</span>
                        {analysis.dupe_groups.length > 0 && (
                          <button className="primary section-action" onClick={doMerge} disabled={merging || quickRunning || trashing}>
                            {merging
                              ? mergeProgress
                                ? `合并校验中 ${mergeProgress.done} / ${mergeProgress.total}…`
                                : "合并中…"
                              : `合并全部重复组 · 释放 ${humanSize(cleanupStats.dupeBytes)}`}
                          </button>
                        )}
                      </div>
                      <p className="section-desc">空间合并保留所有文件路径；手动勾选则删除第一份以外的副本。合并前会重新校验，失败自动回滚。</p>
                      {analysis.dupe_groups.length > 0 ? (
                        <div className="table-scroll">
                          <table className="cleanup-table dupe-table">
                            <thead>
                              <tr>
                                <th className="check-cell"><span className="sr-only">选择</span></th>
                                <th className="size-cell">单份大小</th>
                                <th>份数</th>
                                <th className="size-cell">冗余</th>
                                <th>文件路径</th>
                              </tr>
                            </thead>
                            <tbody>
                              {analysis.dupe_groups.slice(0, 20).map((g) => (
                                <tr key={g.hash}>
                                  <td className="check-cell">
                                    <input
                                      type="checkbox"
                                      aria-label={`选择重复文件组 ${g.hash}`}
                                      checked={g.files.length > 1 && g.files.slice(1).every((p) => selected.has(p))}
                                      onChange={() => toggleDupeGroup(g)}
                                    />
                                  </td>
                                  <td className="size-cell">{humanSize(g.size)}</td>
                                  <td>×{g.files.length}</td>
                                  <td className="size-cell">{humanSize(g.wasted)}</td>
                                  <td className="mono dupe-paths">
                                    {g.files.slice(0, 4).map((p) => (
                                      <div key={p} title={p}>{p}</div>
                                    ))}
                                    {g.files.length > 4 && <div>… 以及另外 {g.files.length - 4} 份</div>}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div className="section-empty">未发现内容完全相同的重复文件。</div>
                      )}
                      {analysis.dupe_groups.length > 20 && (
                        <div className="summary">仅显示前 20 组，共 {analysis.dupe_groups.length} 组；空间合并会处理全部组。</div>
                      )}
                    </section>
                  )}
                </div>
              )}
            </section>
          </div>
        )}

        {message && <div className="message" role="status">{message}</div>}
      </main>
    </div>
  );
}
