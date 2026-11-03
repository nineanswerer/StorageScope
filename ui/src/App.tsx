import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import CityView from "./CityView";
import StorageOverview from "./StorageOverview";
import HierarchyViews from "./HierarchyViews";
import Tree3DView from "./Tree3DView";
import TrendChart from "./TrendChart";
import CleanupList from "./CleanupList";
import {
  effectiveSelectedPaths,
  normalizeCleanupPath,
  orderedDupeFiles,
  protectionReason,
  reconcileAnalysisAfterCleanup,
  selectedCleanupBytes,
  selectedDupeGroups,
  updateDupeKeepSelection,
  withoutProtectedPaths,
} from "./cleanupModel";
import type { AnalysisReport, DupeGroup } from "./cleanupModel";
import "./App.css";

type DirStat = {
  rel_path: string;
  name: string;
  total_size: number;
  file_count: number;
  subdir_count: number;
  has_errors: boolean;
  type_sizes: Record<string, number>;
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
        className={`tree-row${hasChildren ? " is-expandable" : ""}${open_ ? " is-open" : ""}`}
        role={hasChildren ? "button" : undefined}
        tabIndex={hasChildren ? 0 : undefined}
        aria-expanded={hasChildren ? open_ : undefined}
        aria-label={hasChildren ? `${open_ ? "收起" : "展开"} ${stat.name}，${stat.file_count} 个文件，${humanSize(stat.total_size)}` : undefined}
        onClick={() => hasChildren && setOpen(!open_)}
        onKeyDown={(event) => {
          if (hasChildren && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            setOpen(!open_);
          }
        }}
      >
        <span className={`tree-toggle${open_ ? " is-open" : ""}`} aria-hidden>
          {hasChildren && (
            <svg viewBox="0 0 16 16" fill="none">
              <path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>
        <span className={`tree-folder${open_ ? " is-open" : ""}`} aria-hidden>
          <svg viewBox="0 0 20 20" fill="none">
            {open_ ? (
              <>
                <path d="M2.5 6.5V5.2c0-.7.5-1.2 1.2-1.2h4l1.8 2h6.8c.7 0 1.2.5 1.2 1.2v1.3" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                <path d="m3.2 8.5 1 6.2c.1.7.6 1.1 1.3 1.1h9.7c.6 0 1.1-.4 1.3-1l1.4-5.2c.2-.8-.4-1.6-1.3-1.6H4.4c-.5 0-1 .2-1.2.5Z" fill="currentColor" fillOpacity=".16" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
              </>
            ) : (
              <path d="M2.8 6.8V5.3c0-.8.5-1.3 1.3-1.3h4l1.8 2h6.8c.7 0 1.3.5 1.3 1.3v7.5c0 .8-.6 1.2-1.3 1.2H3.8c-.7 0-1-.5-1-1.2V6.8Z" fill="currentColor" fillOpacity=".12" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
            )}
          </svg>
        </span>
        <span className="tree-name">
          {stat.name}
          {stat.has_errors && <span className="warn">（统计可能不完整）</span>}
        </span>
        <span className="tree-count">{stat.file_count} 文件</span>
        <span className="tree-size">{humanSize(stat.total_size)}</span>
      </div>
      {open_ && hasChildren && (
        <div className="tree-children">
          {stat.children.map((c) => <TreeNode key={c.rel_path} stat={c} depth={depth + 1} />)}
        </div>
      )}
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
  const [db, setDb] = useState("");
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
  const [dupeKeep, setDupeKeep] = useState<Record<string, string>>({});
  const [trashing, setTrashing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeProgress, setMergeProgress] = useState<AnalyzeProgress | null>(null);
  const [referenceDirs, setReferenceDirs] = useState<string[]>([]);
  const [excludedDirs, setExcludedDirs] = useState<string[]>([]);
  const [protectionInput, setProtectionInput] = useState("");

  type MergeReport = {
    results: { path: string; status: string; detail: string | null; verified_freed_bytes: number | null }[];
    merged_files: number;
    merged_logical_bytes: number;
    verified_freed_bytes: number | null;
    skipped: number;
    failed: number;
    recovery: string[];
  };
  type CleanupExecutionReport = {
    results: { path: string; status: string; logical_bytes: number; detail: string | null }[];
    succeeded: number;
    skipped: number;
    failed: number;
    selected_logical_bytes: number;
    pending_recycle_bin_bytes: number;
    verified_freed_bytes: number | null;
  };
  const [lastCleanupResult, setLastCleanupResult] = useState<
    | { kind: "trash"; report: CleanupExecutionReport }
    | { kind: "merge"; report: MergeReport }
    | null
  >(null);

  async function doMerge() {
    if (!analysis || analysis.dupe_groups.length === 0 || scanning || analyzing || trashing || merging) return;
    const groups = selectedDupeGroups(analysis.dupe_groups, allowedSelected, dupeKeep);
    if (groups.length === 0) {
      setMessage("请先完整勾选至少一个重复组的冗余副本；部分选择的组不会参与合并。");
      return;
    }
    const copies = groups.flatMap((group) => group.files.slice(1));
    const totalWasted = groups.reduce((sum, group) => sum + group.wasted, 0);
    const preview = copies.slice(0, 8).join("\n");
    const remaining = copies.length > 8 ? `\n另有 ${copies.length - 8} 个副本` : "";
    if (!window.confirm(
      `合并已选的 ${groups.length} 组、${copies.length} 个副本？\n副本逻辑大小 ${humanSize(totalWasted)}，实际分配空间以执行结果为准。\n\n${preview}${remaining}\n\n所有路径保留，但此后通过任一路径修改内容，其他硬链接路径也会看到变化。合并前重新校验全文，失败自动回滚。`
    )) return;
    setMerging(true);
    setMessage("");
    setMergeProgress(null);
    setLastCleanupResult(null);
    try {
      const r = await invoke<MergeReport>("merge_duplicates", {
        root: path,
        groups,
        referenceDirs,
        excludedDirs,
      });
      const mergedPaths = new Set(r.results.filter((x) => x.status === "merged" || x.status === "skipped_linked").map((x) => x.path));
      setAnalysis(reconcileAnalysisAfterCleanup(analysis, new Set(), mergedPaths, dupeKeep));
      setSelected((previous) => new Set([...previous].filter((rel) => !mergedPaths.has(rel))));
      setLastCleanupResult({ kind: "merge", report: r });
      const resultNotes = r.results
        .filter((x) => x.status !== "merged" && x.detail)
        .slice(0, 5)
        .map((x) => `${x.path}：${x.detail}`)
        .join("\n");
      const freed = r.verified_freed_bytes == null
        ? "实际分配空间释放暂无法完整核实"
        : `已核实释放 ${humanSize(r.verified_freed_bytes)}`;
      setMessage(
        `空间合并完成：${r.merged_files} 个副本，合并逻辑大小 ${humanSize(r.merged_logical_bytes)}；${freed}` +
          `${r.skipped > 0 ? `；${r.skipped} 个跳过` : ""}${r.failed > 0 ? `；${r.failed} 个失败` : ""}` +
          (resultNotes ? `\n${resultNotes}` : "") +
          (r.recovery.length > 0 ? `\n恢复记录：\n${r.recovery.join("\n")}` : "")
      );
    } catch (e) {
      setMessage(String(e));
    } finally {
      setMerging(false);
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

  // 自动快照与扫描、分析、清理共用目录状态，任何操作进行中都跳过本轮。
  useEffect(() => {
    if (autoMinutes <= 0 || !path || !db) return;
    const t = setInterval(() => {
      if (!scanning && !analyzing && !trashing && !merging) void doSaveSnapshot();
    }, autoMinutes * 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoMinutes, path, db, scanning, analyzing, trashing, merging]);

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

  function addProtection(kind: "reference" | "excluded") {
    const normalized = normalizeCleanupPath(protectionInput);
    if (!normalized || normalized.split("/").includes("..") || /^[a-zA-Z]:/.test(normalized)) {
      setMessage("请输入扫描根目录内的相对路径，例如 originals/项目原件。");
      return;
    }
    const update = kind === "reference" ? setReferenceDirs : setExcludedDirs;
    update((previous) => previous.includes(normalized) ? previous : [...previous, normalized]);
    setProtectionInput("");
    setMessage("");
  }

  function toggleOne(rel: string) {
    if (protectionReason(rel, referenceDirs, excludedDirs)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });
  }

  function toggleDupeGroup(g: DupeGroup) {
    const rest = orderedDupeFiles(g, dupeKeep).slice(1)
      .filter((rel) => !protectionReason(rel, referenceDirs, excludedDirs));
    setSelected((prev) => {
      const next = new Set(prev);
      const allIn = rest.length > 0 && rest.every((p) => next.has(p));
      for (const p of rest) {
        if (allIn) next.delete(p);
        else next.add(p);
      }
      return next;
    });
  }

  function chooseDupeKeep(hash: string, keep: string) {
    const group = analysis?.dupe_groups.find((item) => item.hash === hash);
    setDupeKeep((prev) => ({ ...prev, [hash]: keep }));
    setSelected((prev) => {
      if (!group) {
        const next = new Set(prev);
        next.delete(keep);
        return next;
      }
      return withoutProtectedPaths(
        updateDupeKeepSelection(prev, group, dupeKeep, keep),
        referenceDirs,
        excludedDirs,
      );
    });
  }

  const allowedSelected = useMemo(
    () => withoutProtectedPaths(selected, referenceDirs, excludedDirs),
    [selected, referenceDirs, excludedDirs]
  );

  function selectedBytes(): number {
    return analysis ? selectedCleanupBytes(analysis, allowedSelected, dupeKeep) : 0;
  }

  useEffect(() => {
    if (!analysis) return;
    setDupeKeep((previous) => {
      const next = { ...previous };
      for (const group of analysis.dupe_groups) {
        const reference = group.files.find((rel) => protectionReason(rel, referenceDirs, []));
        if (reference) next[group.hash] = reference;
      }
      return next;
    });
    setSelected((previous) => withoutProtectedPaths(previous, referenceDirs, excludedDirs));
  }, [analysis, referenceDirs, excludedDirs]);

  async function doTrash() {
    if (!analysis || allowedSelected.size === 0 || scanning || analyzing || trashing || merging) return;
    const targets = effectiveSelectedPaths(allowedSelected, analysis.cache_hits);
    const n = targets.size;
    if (n === 0) return;
    if (!window.confirm(
      `确认把 ${n} 项（逻辑大小 ${humanSize(selectedBytes())}）移入系统回收站？\n\n执行前会复核路径和内容变化。移入后可在回收站恢复，但在清空前不会计为已实际释放。`
    )) return;
    setTrashing(true);
    setMessage("");
    setLastCleanupResult(null);
    try {
      const r = await invoke<CleanupExecutionReport>("execute_cleanup_plan", {
        root: path,
        analysis,
        relPaths: [...targets],
        referenceDirs,
        excludedDirs,
      });
      const removedRels = r.results.filter((item) => item.status === "moved_to_trash").map((item) => item.path);
      setAnalysis(reconcileAnalysisAfterCleanup(analysis, new Set(removedRels), new Set(), dupeKeep));
      setSelected(new Set());
      setLastCleanupResult({ kind: "trash", report: r });
      const notes = r.results
        .filter((item) => item.status !== "moved_to_trash")
        .slice(0, 5)
        .map((item) => `${item.path}：${item.detail ?? item.status}`)
        .join("\n");
      setMessage(
        `已移入回收站 ${r.succeeded} 项，待清空 ${humanSize(r.pending_recycle_bin_bytes)}；尚未计为实际释放` +
          `${r.skipped > 0 ? `；${r.skipped} 项因变化或保护边界跳过` : ""}${r.failed > 0 ? `；${r.failed} 项失败` : ""}` +
          (notes ? `\n${notes}` : "")
      );
    } catch (e) {
      setMessage(String(e));
    } finally {
      setTrashing(false);
    }
  }

  async function verifyCleanupSnapshot() {
    const baseline = analysis?.baseline_snapshot_id;
    if (!path.trim() || !db.trim() || !baseline || scanning || analyzing || trashing || merging) {
      if (!baseline) setMessage("没有可比较的基准快照，请重新分析。");
      return;
    }
    setScanning(true);
    setMessage("");
    setProgress(null);
    try {
      const saved = await invoke<{ id: number }>("save_snapshot", { path, db });
      await refreshSnapshots();
      const difference = await invoke<DiffReport>("diff_snapshots", { db, old: baseline, new: saved.id });
      setOldId(baseline);
      setNewId(saved.id);
      setReport(difference);
      setSection("diff");
      setMessage(`已比较基准快照 #${baseline} 与结果快照 #${saved.id}。逻辑大小变化不等于分配空间或卷可用空间变化。`);
    } catch (e) {
      setMessage(String(e));
    } finally {
      setScanning(false);
    }
  }

  useEffect(() => {
    void invoke<string>("snapshot_database_path").then(setDb).catch((error) => {
      setMessage(`快照数据库初始化失败：${String(error)}`);
    });
    const un = listen<Progress>("scan-progress", (e) => setProgress(e.payload));
    const un2 = listen<AnalyzeProgress>("analyze-progress", (e) =>
      setAnalyzeProgress(e.payload)
    );
    const un3 = listen<AnalyzeProgress>("merge-progress", (e) => setMergeProgress(e.payload));
    const un4 = listen<{ messages: string[] }>("merge-recovery", (e) => {
      setMessage(`合并中断恢复：\n${e.payload.messages.join("\n")}`);
    });
    return () => {
      un.then((f) => f());
      un2.then((f) => f());
      un3.then((f) => f());
      un4.then((f) => f());
    };
  }, []);

  function resetCleanup() {
    setAnalysis(null);
    setAnalyzeProgress(null);
    setMergeProgress(null);
    setSelected(new Set());
    setDupeKeep({});
    setLastCleanupResult(null);
  }

  function changePath(next: string) {
    if (next === path || scanning || analyzing || trashing || merging) return;
    setPath(next);
    setTree(null);
    setOutcome(null);
    setReferenceDirs([]);
    setExcludedDirs([]);
    setProtectionInput("");
    resetCleanup();
  }

  async function pickDir() {
    if (scanning || analyzing || trashing || merging) return;
    const p = await open({ directory: true });
    if (typeof p === "string") changePath(p);
  }

  async function doScan() {
    if (!path.trim() || scanning || analyzing || trashing || merging) return;
    resetCleanup();
    setScanning(true);
    setMessage("");
    setProgress(null);
    const root = path;
    try {
      const r = await invoke<{ outcome: ScanOutcome; tree: DirStat }>("scan_directory", { path: root });
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
    if (!path.trim() || !db.trim() || scanning || analyzing || trashing || merging) return;
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
    if (!db.trim()) return;
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
    if (!path.trim() || scanning || analyzing || trashing || merging) return;
    setAnalyzing(true);
    setMessage("");
    setAnalysis(null);
    setAnalyzeProgress(null);
    setSelected(new Set());
    setDupeKeep({});
    setLastCleanupResult(null);
    const root = path;
    try {
      const r = await invoke<AnalysisReport>("analyze_cleanup", {
        path: root,
        db,
        top: 50,
        dupeMinMib: dupeMinMib,
        skipDupes,
      });
      setAnalysis(r);
      await refreshSnapshots();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setAnalyzing(false);
    }
  }

  async function exportTree(fmt: string) {
    if (!tree) return;
    try {
      const p = await save({ defaultPath: `storagescope-统计.${fmt}` });
      if (!p) return;
      await invoke("export_tree", { tree, path: p, format: fmt });
      setMessage(`已导出：${p}`);
    } catch (error) {
      setMessage(`导出统计失败：${String(error)}`);
    }
  }

  async function exportDiff(fmt: string) {
    if (!report) return;
    try {
      const p = await save({ defaultPath: `storagescope-差异.${fmt}` });
      if (!p) return;
      await invoke("export_diff", { report, path: p, format: fmt });
      setMessage(`已导出：${p}`);
    } catch (error) {
      setMessage(`导出差异失败：${String(error)}`);
    }
  }

  async function exportDiagnostics() {
    try {
      const p = await save({ defaultPath: "storagescope-诊断.json" });
      if (!p) return;
      await invoke("export_diagnostics", { path: p });
      setMessage(`诊断已导出：${p}\n分享前请检查文件内容。`);
    } catch (error) {
      setMessage(`导出诊断失败：${String(error)}`);
    }
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
    const recommendedHits = analysis?.cache_hits.filter((h) => h.safety === "Recommended") ?? [];
    const reviewHits = analysis?.cache_hits.filter((h) => h.safety === "ReviewAdvised") ?? [];
    return {
      recommendedCount: recommendedHits.length,
      recommendedBytes: recommendedHits.reduce((sum, h) => sum + h.size, 0),
      reviewCount: reviewHits.length,
      reviewBytes: reviewHits.reduce((sum, h) => sum + h.size, 0),
      dupeBytes: analysis?.dupe_groups.reduce((sum, g) => sum + g.wasted, 0) ?? 0,
    };
  }, [analysis]);

  const selectedTargets = useMemo(
    () => effectiveSelectedPaths(allowedSelected, analysis?.cache_hits ?? []),
    [analysis, allowedSelected]
  );

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
                    onChange={(e) => changePath(e.target.value)}
                    placeholder="例如 D:\Games 或 C:\Users"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={scanning || analyzing || trashing || merging}
                  />
                  <button onClick={pickDir} disabled={scanning || analyzing || trashing || merging}>选择目录</button>
                </div>
                <div className="scan-form-footer">
                  <span className="field-hint">只读取目录与文件信息，不会修改文件内容。</span>
                  {!scanning ? (
                    <button className="primary" onClick={doScan} disabled={!path.trim() || analyzing || trashing || merging}>
                      开始扫描
                    </button>
                  ) : (
                    <button className="danger" onClick={() => invoke("cancel_operation")}>
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
                    <input aria-label="快照数据库路径" value={db} readOnly placeholder="正在定位应用数据目录…" title="快照保存在固定的用户应用数据目录" />
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
                  <button onClick={refreshSnapshots} disabled={!db.trim()}>刷新</button>
                  <button onClick={exportDiagnostics} title="导出脱敏操作日志和应用环境信息">导出诊断</button>
                  <button className="primary" onClick={doSaveSnapshot} disabled={!path.trim() || !db.trim() || scanning || analyzing || trashing || merging}>
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
                    <div className="action-note">净变化 = 新增与增长增加的逻辑大小 − 删除与缩减减少的逻辑大小。</div>
                  </div>

                  {report.warnings.length > 0 && (
                    <div className="warning-list" role="status">
                      {report.warnings.map((w, i) => <div key={i} className="warn">⚠ {w}</div>)}
                    </div>
                  )}

                  <dl className="cleanup-breakdown diff-breakdown" aria-label="文件变化分类统计">
                    <div>
                      <dt>新增文件 <span>逻辑大小增加</span></dt>
                      <dd>{report.summary.added_files.toLocaleString("zh-CN")} <span>+{humanSize(diffBytes.Added)}</span></dd>
                    </div>
                    <div>
                      <dt>删除文件 <span>逻辑大小减少</span></dt>
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
            <p className="page-desc">目录名称只提供复核线索，不代表可以安全删除。先设定保留边界，再手动确认；执行前还会复核扫描基线。</p>
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
                      disabled={analyzing || trashing || merging}
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
                      disabled={skipDupes || analyzing || trashing || merging}
                      onChange={(e) => setDupeMinMib(Number(e.target.value) || 1)}
                    />
                    <span>MiB</span>
                  </label>
                  {!analyzing ? (
                    <button className="primary" onClick={doAnalyze} disabled={!path.trim() || scanning || trashing || merging}>
                      {analysis ? "重新分析" : "开始分析"}
                    </button>
                  ) : (
                    <button className="danger" onClick={() => invoke("cancel_operation")}>
                      取消分析
                    </button>
                  )}
                </div>
              </div>

              <section className="protection-editor" aria-labelledby="protection-heading">
                <div className="protection-copy">
                  <h2 id="protection-heading">保留边界</h2>
                  <p>参考目录是重复文件的保留锚点；排除目录完全不参与清理。两者的内部与祖先目录都不可选。</p>
                </div>
                <div className="protection-add">
                  <input
                    aria-label="保护目录相对路径"
                    value={protectionInput}
                    onChange={(event) => setProtectionInput(event.target.value)}
                    placeholder="例如 originals/项目原件"
                    disabled={scanning || analyzing || trashing || merging}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") addProtection("reference");
                    }}
                  />
                  <button onClick={() => addProtection("reference")} disabled={!protectionInput.trim() || scanning || analyzing || trashing || merging}>添加参考目录</button>
                  <button onClick={() => addProtection("excluded")} disabled={!protectionInput.trim() || scanning || analyzing || trashing || merging}>添加排除目录</button>
                </div>
                <div className="protection-lists">
                  {([
                    ["参考目录", referenceDirs, setReferenceDirs],
                    ["排除目录", excludedDirs, setExcludedDirs],
                  ] as const).map(([label, dirs, update]) => (
                    <div className="protection-list" key={label}>
                      <strong>{label}</strong>
                      {dirs.length === 0 ? <span>未设置</span> : dirs.map((dir) => (
                        <span className="protection-chip" key={dir}>
                          <span className="mono">{dir}</span>
                          <button
                            type="button"
                            aria-label={`移除${label} ${dir}`}
                            title={`移除${label}`}
                            disabled={scanning || analyzing || trashing || merging}
                            onClick={() => update((previous) => previous.filter((item) => item !== dir))}
                          >×</button>
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
              </section>

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
                        候选逻辑大小 <b>{humanSize(analysis.candidate_logical_bytes)}</b>
                      </div>
                      <div className="action-sub">
                        分类估算，缓存与重复文件可能重叠，不等于实际可释放空间
                        {!skipDupes &&
                          ` · 已校验 ${humanSize(analysis.hashed_bytes)}${analysis.hash_errors > 0 ? ` · ${analysis.hash_errors} 个文件校验失败` : ""}`}
                      </div>
                    </div>
                    <div className="action-btns">
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
                      分析基准：{analysis.scan_id} · {analysis.baseline_snapshot_id ? `快照 #${analysis.baseline_snapshot_id}` : "未保存快照，请在快照设置中填写数据库后重新分析"}。所有清理动作均需手动确认。
                    </div>
                  </div>

                  <dl className="cleanup-breakdown" aria-label="清理结果分类统计">
                    <div>
                      <dt>建议优先复核 <span>{cleanupStats.recommendedCount} 项</span></dt>
                      <dd>{humanSize(cleanupStats.recommendedBytes)}</dd>
                    </div>
                    <div>
                      <dt>需人工判断 <span>{cleanupStats.reviewCount} 项</span></dt>
                      <dd>{humanSize(cleanupStats.reviewBytes)}</dd>
                    </div>
                    <div>
                      <dt>重复副本逻辑大小 <span>{analysis.dupe_groups.length} 组</span></dt>
                      <dd>{humanSize(cleanupStats.dupeBytes)}</dd>
                    </div>
                  </dl>

                  <div className="selection-bar">
                    <div className="selection-copy">
                      <strong>复核后清理</strong>
                      <span>逻辑大小仅供选择参考；移入回收站不等于已经释放，每组重复文件至少保留一份。</span>
                    </div>
                    <button
                      className="danger"
                      onClick={doTrash}
                      disabled={selectedTargets.size === 0 || scanning || analyzing || trashing || merging}
                    >
                      {trashing ? "正在复核并移入回收站…" : `移入回收站（${selectedTargets.size} 项 · ${humanSize(selectedBytes())}）`}
                    </button>
                  </div>

                  <CleanupList
                    analysis={analysis}
                    selected={allowedSelected}
                    dupeKeep={dupeKeep}
                    referenceDirs={referenceDirs}
                    excludedDirs={excludedDirs}
                    busy={scanning || analyzing}
                    merging={merging}
                    trashing={trashing}
                    mergeProgress={mergeProgress}
                    onToggleOne={toggleOne}
                    onToggleDupeGroup={toggleDupeGroup}
                    onKeepDupe={chooseDupeKeep}
                    onReveal={reveal}
                    onCopyPath={copyPath}
                    onMerge={doMerge}
                  />

                  {lastCleanupResult && (
                    <section className="cleanup-result-review" aria-labelledby="cleanup-result-heading">
                      <div className="section-heading">
                        <h2 id="cleanup-result-heading">执行结果</h2>
                        <span>{lastCleanupResult.kind === "trash" ? "回收站" : "重复文件合并"}</span>
                        <button
                          onClick={verifyCleanupSnapshot}
                          disabled={!analysis.baseline_snapshot_id || !db.trim() || scanning || analyzing || trashing || merging}
                        >
                          保存结果快照并比较
                        </button>
                      </div>
                      {lastCleanupResult.kind === "trash" ? (
                        <>
                          <dl className="cleanup-breakdown" aria-label="回收站执行统计">
                            <div><dt>已移入 <span>{lastCleanupResult.report.succeeded} 项</span></dt><dd>{humanSize(lastCleanupResult.report.pending_recycle_bin_bytes)}</dd></div>
                            <div><dt>实际释放 <span>回收站尚未清空</span></dt><dd>未核实</dd></div>
                            <div><dt>未执行 <span>跳过 {lastCleanupResult.report.skipped} · 失败 {lastCleanupResult.report.failed}</span></dt><dd>{lastCleanupResult.report.skipped + lastCleanupResult.report.failed} 项</dd></div>
                          </dl>
                          <p className="section-desc">上述大小是仍待清空回收站的逻辑大小，不会记作已释放空间。结果快照用于复核文件变化，不直接测量卷可用空间。</p>
                        </>
                      ) : (
                        <>
                          <dl className="cleanup-breakdown" aria-label="重复文件合并统计">
                            <div><dt>已合并 <span>{lastCleanupResult.report.merged_files} 个副本</span></dt><dd>{humanSize(lastCleanupResult.report.merged_logical_bytes)}</dd></div>
                            <div><dt>已核实分配空间释放 <span>按文件分配大小计算</span></dt><dd>{lastCleanupResult.report.verified_freed_bytes == null ? "无法完整核实" : humanSize(lastCleanupResult.report.verified_freed_bytes)}</dd></div>
                            <div><dt>未执行 <span>跳过 {lastCleanupResult.report.skipped} · 失败 {lastCleanupResult.report.failed}</span></dt><dd>{lastCleanupResult.report.skipped + lastCleanupResult.report.failed} 项</dd></div>
                          </dl>
                          <p className="section-desc">合并逻辑大小不等于已释放空间。只有成功读取各项分配大小时，才显示已核实释放量。</p>
                        </>
                      )}
                      <details className="execution-details">
                        <summary>查看逐项执行记录</summary>
                        <ul>
                          {lastCleanupResult.report.results.slice(0, 50).map((item) => (
                            <li key={item.path}>
                              <span className="mono">{item.path}</span>
                              <span>{item.status}{item.detail ? ` · ${item.detail}` : ""}</span>
                            </li>
                          ))}
                        </ul>
                      </details>
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
