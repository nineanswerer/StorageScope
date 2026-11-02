import { useMemo, useState } from "react";
import { buildCleanupItems, orderedDupeFiles, protectionReason, selectedDupeGroups } from "./cleanupModel";
import type { AnalysisReport, CleanupKind, DupeGroup, RuleHit } from "./cleanupModel";

type Progress = { done: number; total: number };

type Props = {
  analysis: AnalysisReport;
  selected: Set<string>;
  dupeKeep: Record<string, string>;
  referenceDirs: string[];
  excludedDirs: string[];
  busy: boolean;
  merging: boolean;
  trashing: boolean;
  mergeProgress: Progress | null;
  onToggleOne: (path: string) => void;
  onToggleDupeGroup: (group: DupeGroup) => void;
  onKeepDupe: (hash: string, path: string) => void;
  onReveal: (path: string) => void;
  onCopyPath: (path: string) => void;
  onMerge: () => void;
};

function humanSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return index === 0 ? `${value} ${units[index]}` : `${value.toFixed(1)} ${units[index]}`;
}

function formatModified(seconds: number | null | undefined): string {
  if (seconds == null) return "修改时间未知";
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.valueOf())) return "修改时间未知";
  return `修改于 ${new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date)}`;
}

const FILTERS: { id: "all" | CleanupKind; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "big", label: "大文件" },
  { id: "cache", label: "缓存目录" },
  { id: "dupe", label: "重复副本" },
];

export default function CleanupList({
  analysis,
  selected,
  dupeKeep,
  referenceDirs,
  excludedDirs,
  busy,
  merging,
  trashing,
  mergeProgress,
  onToggleOne,
  onToggleDupeGroup,
  onKeepDupe,
  onReveal,
  onCopyPath,
  onMerge,
}: Props) {
  const [filter, setFilter] = useState<"all" | CleanupKind>("all");
  const [query, setQuery] = useState("");
  const items = useMemo(() => buildCleanupItems(analysis), [analysis]);
  const counts = useMemo(() => ({
    all: items.length,
    big: items.filter((item) => item.kind === "big").length,
    cache: items.filter((item) => item.kind === "cache").length,
    dupe: items.filter((item) => item.kind === "dupe").length,
  }), [items]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    return items.filter((item) => (filter === "all" || item.kind === filter) && (!normalized || item.searchText.includes(normalized)));
  }, [filter, items, query]);
  const mergeGroups = useMemo(
    () => selectedDupeGroups(analysis.dupe_groups, selected, dupeKeep),
    [analysis.dupe_groups, dupeKeep, selected],
  );
  const dupeBytes = mergeGroups.reduce((sum, group) => sum + group.wasted, 0);

  function itemKindLabel(kind: CleanupKind): string {
    if (kind === "big") return "大文件";
    if (kind === "cache") return "缓存目录";
    return "重复副本";
  }

  function renderProject(item: ReturnType<typeof buildCleanupItems>[number]) {
    if (item.kind === "dupe" && item.dupe) {
      const group = item.dupe;
      const files = orderedDupeFiles(group, dupeKeep);
      return (
        <div className="dupe-keep-group">
          <div className="cleanup-item-meta">{group.files.length} 份相同内容 · 单份 {humanSize(group.size)} · 当前保留 {files[0]}</div>
          <div className="dupe-keep-list">
            {files.map((path, index) => {
              const protection = protectionReason(path, referenceDirs, excludedDirs);
              return (
                <div className="dupe-keep-row" key={path}>
                  <label className="dupe-keep-choice">
                    <input
                      type="radio"
                      name={`dupe-keep-${group.hash}`}
                      aria-label={`保留 ${path}`}
                      checked={index === 0}
                      disabled={busy || merging || trashing}
                      onChange={() => onKeepDupe(group.hash, path)}
                    />
                    保留
                  </label>
                  <span className="mono" title={path}>
                    {path}
                    {protection && <small className="protected-path">{protection}</small>}
                  </span>
                  <button type="button" className="row-link" onClick={() => onReveal(path)}>定位</button>
                </div>
              );
            })}
          </div>
        </div>
      );
    }
    if (item.kind === "cache" && item.cache) {
      const hit: RuleHit = item.cache;
      return (
        <>
          <div className="cleanup-item-path mono" title={hit.rel_path}>{hit.rel_path || "（扫描根目录）"}</div>
          <div className="cleanup-item-meta">{hit.file_count.toLocaleString("zh-CN")} 个文件 · {hit.rule_name}</div>
        </>
      );
    }
    return (
      <>
        <div className="cleanup-item-path mono" title={item.path}>{item.path}</div>
        <div className="cleanup-item-meta">
          {item.big?.ext ? `${item.big.ext.toUpperCase()} · ` : ""}{formatModified(item.big?.modified)}
        </div>
      </>
    );
  }

  return (
    <section className="cleanup-section cleanup-workspace" aria-labelledby="cleanup-items-heading">
      <div className="section-heading">
        <h2 id="cleanup-items-heading">待处理项目</h2>
        <span>{counts.all} 项</span>
        {analysis.dupe_groups.length > 0 && (
          <button
            className="primary section-action"
            onClick={onMerge}
            disabled={mergeGroups.length === 0 || busy || merging || trashing}
            title={mergeGroups.length === 0 ? "先完整勾选至少一个重复组的冗余副本" : "只合并完整勾选的重复组"}
          >
            {merging
              ? mergeProgress
                ? `合并校验中 ${mergeProgress.done} / ${mergeProgress.total}…`
                : "合并中…"
              : `合并已选重复组 · ${mergeGroups.length} 组 · ${humanSize(dupeBytes)}`}
          </button>
        )}
      </div>
      <p className="section-desc">
        按逻辑大小排序。重复组可更换保留副本，再选择移入回收站或合并为硬链接。{analysis.dupe_groups.length > 0 &&
          (mergeGroups.length > 0 ? `已完整选择 ${mergeGroups.length} 组；其他组不参与合并。` : "请先完整勾选重复组的冗余副本，再执行合并。")}
      </p>

      <div className="cleanup-list-toolbar">
        <div className="cleanup-filter-tabs" role="group" aria-label="待处理项目类型">
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              className={filter === entry.id ? "active" : ""}
              aria-pressed={filter === entry.id}
              onClick={() => setFilter(entry.id)}
            >
              {entry.label} <span>{counts[entry.id]}</span>
            </button>
          ))}
        </div>
        <label className="cleanup-query">
          <span>筛选路径</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入名称、路径或规则" />
        </label>
      </div>

      {filtered.length > 0 ? (
        <div className="table-scroll">
          <table className="cleanup-table cleanup-unified-table">
            <thead>
              <tr>
                <th className="check-cell"><span className="sr-only">选择</span></th>
                <th>类型与判断</th>
                <th className="size-cell">逻辑大小</th>
                <th>项目与保留选择</th>
                <th>建议依据</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 50).map((item) => {
                const dupeFiles = item.dupe ? orderedDupeFiles(item.dupe, dupeKeep) : [];
                const selectableDupeFiles = dupeFiles.slice(1).filter((path) => !protectionReason(path, referenceDirs, excludedDirs));
                const protection = item.kind === "dupe" ? null : protectionReason(item.path, referenceDirs, excludedDirs);
                const checked = item.kind === "dupe"
                  ? selectableDupeFiles.length > 0 && selectableDupeFiles.every((path) => selected.has(path))
                  : selected.has(item.path);
                return (
                  <tr key={item.id}>
                    <td className="check-cell">
                      <input
                        type="checkbox"
                        aria-label={item.kind === "dupe" ? `选择重复组 ${item.dupe?.hash} 的冗余副本` : `选择${itemKindLabel(item.kind)} ${item.path}`}
                        checked={checked}
                        disabled={busy || merging || trashing || Boolean(protection) || (item.kind === "dupe" && selectableDupeFiles.length === 0)}
                        onChange={() => item.kind === "dupe" && item.dupe ? onToggleDupeGroup(item.dupe) : onToggleOne(item.path)}
                      />
                    </td>
                    <td>
                      <span className="cleanup-kind">{itemKindLabel(item.kind)}</span>
                      <span className={item.recommended ? "status-safe cleanup-risk" : "status-review cleanup-risk"}>
                        {item.recommended ? "优先复核" : "人工确认"}
                      </span>
                    </td>
                    <td className="size-cell">
                      {humanSize(item.size)}
                      {item.kind === "dupe" && <small>副本逻辑大小</small>}
                    </td>
                    <td>
                      {renderProject(item)}
                      {protection && <div className="protected-path">{protection}，不可选择</div>}
                    </td>
                    <td>
                      <strong className="cleanup-reason-title">
                        {item.kind === "cache" ? item.cache?.rule_name : item.kind === "big" ? "需要人工判断" : "内容已校验一致"}
                      </strong>
                      <p className="cleanup-reason">{item.reason}</p>
                    </td>
                    <td className="row-actions">
                      {item.kind === "dupe" ? (
                        <span className="cleanup-item-meta">逐份定位</span>
                      ) : (
                        <>
                          <button type="button" className="row-link" onClick={() => onReveal(item.path)}>定位</button>
                          <button type="button" className="row-link" onClick={() => onCopyPath(item.path)}>复制路径</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="section-empty">{items.length === 0 ? "没有发现可列出的项目。" : "当前筛选条件下没有匹配项目。"}</div>
      )}
      {filtered.length > 50 && <div className="summary">仅显示前 50 项，共 {filtered.length} 项；可继续筛选缩小范围。</div>}
      <p className="cleanup-list-note">与重复组重合的大文件只显示一次；选择缓存目录后，其内部文件不重复计数。保护边界同时由界面与后端执行层校验。</p>
    </section>
  );
}
