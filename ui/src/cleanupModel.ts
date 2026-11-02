export type RuleHit = {
  rule_id: string;
  rule_name: string;
  rel_path: string;
  size: number;
  file_count: number;
  reason: string;
  safety: "Recommended" | "ReviewAdvised";
};

export type BigFile = {
  rel_path: string;
  name: string;
  size: number;
  modified?: number | null;
  ext?: string | null;
};

export type DupeGroup = { size: number; hash: string; files: string[]; wasted: number };

export type TargetExpectation = {
  rel_path: string;
  is_dir: boolean;
  logical_size: number;
  file_count: number;
  modified: number | null;
  manifest_hash: string | null;
  file_id: string | null;
  complete: boolean;
};

export type AnalysisReport = {
  scan_id: string;
  baseline_snapshot_id: number | null;
  cache_hits: RuleHit[];
  big_files: BigFile[];
  dupe_groups: DupeGroup[];
  candidate_logical_bytes: number;
  cleanup_targets: TargetExpectation[];
  hashed_bytes: number;
  hash_errors: number;
};

export type CleanupKind = "cache" | "big" | "dupe";

export type CleanupItem = {
  id: string;
  kind: CleanupKind;
  path: string;
  size: number;
  recommended: boolean;
  reason: string;
  searchText: string;
  cache?: RuleHit;
  big?: BigFile;
  dupe?: DupeGroup;
};

/** 每组只调整展示与执行时的锚点，不改写原始扫描结果。 */
export function orderedDupeFiles(group: DupeGroup, keepByGroup: Record<string, string>): string[] {
  const keep = keepByGroup[group.hash];
  if (!keep || !group.files.includes(keep) || group.files[0] === keep) return [...group.files];
  return [keep, ...group.files.filter((path) => path !== keep)];
}

/** 已选重复组更换保留副本时，把旧保留项转入冗余集合，保持整组选择状态。 */
export function updateDupeKeepSelection(
  selected: Set<string>,
  group: DupeGroup,
  keepByGroup: Record<string, string>,
  nextKeep: string,
): Set<string> {
  const wasFullySelected = orderedDupeFiles(group, keepByGroup).slice(1).every((path) => selected.has(path));
  const next = new Set(selected);
  if (!wasFullySelected) {
    next.delete(nextKeep);
    return next;
  }
  for (const path of group.files) next.delete(path);
  const nextKeepByGroup = { ...keepByGroup, [group.hash]: nextKeep };
  for (const path of orderedDupeFiles(group, nextKeepByGroup).slice(1)) next.add(path);
  return next;
}

/** 只有当前保留项以外的所有副本都已勾选，才允许整组合并。 */
export function selectedDupeGroups(
  groups: DupeGroup[],
  selected: Set<string>,
  keepByGroup: Record<string, string>,
): DupeGroup[] {
  return groups.flatMap((group) => {
    const files = orderedDupeFiles(group, keepByGroup);
    return files.length > 1 && files.slice(1).every((path) => selected.has(path))
      ? [{ ...group, files }]
      : [];
  });
}

/** 已选缓存目录包含的文件不重复进入删除队列，也不重复计算体积。 */
export function effectiveSelectedPaths(selected: Set<string>, cacheHits: RuleHit[]): Set<string> {
  const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");
  const selectedDirs = cacheHits
    .filter((hit) => selected.has(hit.rel_path))
    .map((hit) => normalize(hit.rel_path))
    .filter((path) => path.length > 0);
  return new Set([...selected].filter((path) => {
    const normalized = normalize(path);
    return !selectedDirs.some((dir) => normalized !== dir && normalized.startsWith(`${dir}/`));
  }));
}

export function normalizeCleanupPath(path: string): string {
  return path.trim().replace(/\\/g, "/").split("/").filter((part) => part && part !== ".").join("/").replace(/\/+$/, "");
}

function pathWithin(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/** 与 Windows 核心层一致：保护比较不区分大小写，同时保护后代和祖先目标。 */
export function protectionReason(path: string, referenceDirs: string[], excludedDirs: string[]): string | null {
  const normalized = normalizeCleanupPath(path).toLowerCase();
  for (const raw of referenceDirs) {
    const dir = normalizeCleanupPath(raw).toLowerCase();
    if (dir && (pathWithin(normalized, dir) || pathWithin(dir, normalized))) return "参考目录保护";
  }
  for (const raw of excludedDirs) {
    const dir = normalizeCleanupPath(raw).toLowerCase();
    if (dir && (pathWithin(normalized, dir) || pathWithin(dir, normalized))) return "排除目录";
  }
  return null;
}

export function withoutProtectedPaths(
  selected: Set<string>,
  referenceDirs: string[],
  excludedDirs: string[],
): Set<string> {
  return new Set([...selected].filter((path) => !protectionReason(path, referenceDirs, excludedDirs)));
}

/** 按唯一相对路径计算，缓存、大文件与重复组重合时不重复累计。 */
export function selectedCleanupBytes(
  analysis: AnalysisReport,
  selected: Set<string>,
  keepByGroup: Record<string, string>,
): number {
  const sizes = new Map<string, number>();
  for (const hit of analysis.cache_hits) sizes.set(hit.rel_path, hit.size);
  for (const file of analysis.big_files) {
    if (!sizes.has(file.rel_path)) sizes.set(file.rel_path, file.size);
  }
  for (const group of analysis.dupe_groups) {
    for (const path of orderedDupeFiles(group, keepByGroup).slice(1)) {
      if (!sizes.has(path)) sizes.set(path, group.size);
    }
  }
  let total = 0;
  for (const path of effectiveSelectedPaths(selected, analysis.cache_hits)) total += sizes.get(path) ?? 0;
  return total;
}

/** 执行后同步撤下失效目标，避免已合并副本又以大文件身份回到候选清单。 */
export function reconcileAnalysisAfterCleanup(
  analysis: AnalysisReport,
  removedPaths: Set<string>,
  mergedPaths: Set<string>,
  keepByGroup: Record<string, string>,
): AnalysisReport {
  const isGone = (path: string) => [...removedPaths].some((dir) => path === dir || path.startsWith(`${dir}/`));
  const cacheHits = analysis.cache_hits.filter((hit) => !isGone(hit.rel_path));
  const bigFiles = analysis.big_files.filter((file) => !isGone(file.rel_path) && !mergedPaths.has(file.rel_path));
  const dupeGroups = analysis.dupe_groups
    .map((group) => {
      const files = orderedDupeFiles(group, keepByGroup)
        .filter((path, index) => !isGone(path) && (index === 0 || !mergedPaths.has(path)));
      return { ...group, files, wasted: group.size * Math.max(0, files.length - 1) };
    })
    .filter((group) => group.files.length > 1);
  return {
    ...analysis,
    cache_hits: cacheHits,
    big_files: bigFiles,
    dupe_groups: dupeGroups,
    candidate_logical_bytes: cacheHits.reduce((sum, hit) => sum + hit.size, 0)
      + dupeGroups.reduce((sum, group) => sum + group.wasted, 0),
    cleanup_targets: analysis.cleanup_targets.filter((target) => !isGone(target.rel_path) && !mergedPaths.has(target.rel_path)),
  };
}

/**
 * 汇总为一张待处理清单。重复组中的文件不再以大文件身份重复出现；
 * 缓存与重复组可能重叠，选择时由 effectiveSelectedPaths 去除目录内部重复项。
 */
export function buildCleanupItems(analysis: AnalysisReport): CleanupItem[] {
  const dupePaths = new Set(analysis.dupe_groups.flatMap((group) => group.files));
  const caches: CleanupItem[] = analysis.cache_hits.map((hit) => ({
    id: `cache:${hit.rel_path}`,
    kind: "cache",
    path: hit.rel_path,
    size: hit.size,
    recommended: hit.safety === "Recommended",
    reason: hit.reason,
    searchText: `${hit.rel_path} ${hit.rule_name} ${hit.reason}`.toLocaleLowerCase("zh-CN"),
    cache: hit,
  }));
  const bigFiles: CleanupItem[] = analysis.big_files
    .filter((file) => !dupePaths.has(file.rel_path))
    .map((file) => ({
      id: `big:${file.rel_path}`,
      kind: "big",
      path: file.rel_path,
      size: file.size,
      recommended: false,
      reason: "仅表示占用较大，不代表文件无用；确认后才会移入回收站。",
      searchText: `${file.rel_path} ${file.name} ${file.ext ?? ""}`.toLocaleLowerCase("zh-CN"),
      big: file,
    }));
  const dupes: CleanupItem[] = analysis.dupe_groups.map((group) => ({
    id: `dupe:${group.hash}`,
    kind: "dupe",
    path: group.files[0] ?? "",
    size: group.wasted,
    recommended: false,
    reason: "内容哈希一致；相同内容不自动等于路径多余，每组必须保留一份。",
    searchText: group.files.join(" ").toLocaleLowerCase("zh-CN"),
    dupe: group,
  }));
  return [...caches, ...bigFiles, ...dupes].sort((a, b) => b.size - a.size || a.path.localeCompare(b.path, "zh-CN"));
}
