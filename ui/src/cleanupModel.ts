export type RuleHit = {
  rule_id: string;
  rule_name: string;
  rel_path: string;
  size: number;
  file_count: number;
  reason: string;
  safety: "SafeToDelete" | "ReviewAdvised";
};

export type BigFile = {
  rel_path: string;
  name: string;
  size: number;
  modified?: number | null;
  ext?: string | null;
};

export type DupeGroup = { size: number; hash: number; files: string[]; wasted: number };

export type AnalysisReport = {
  cache_hits: RuleHit[];
  big_files: BigFile[];
  dupe_groups: DupeGroup[];
  reclaimable_bytes: number;
  hashed_bytes: number;
  hash_errors: number;
};

export type CleanupKind = "cache" | "big" | "dupe";

export type CleanupItem = {
  id: string;
  kind: CleanupKind;
  path: string;
  size: number;
  safe: boolean;
  reason: string;
  searchText: string;
  cache?: RuleHit;
  big?: BigFile;
  dupe?: DupeGroup;
};

/** 每组只调整展示与执行时的锚点，不改写原始扫描结果。 */
export function orderedDupeFiles(group: DupeGroup, keepByGroup: Record<number, string>): string[] {
  const keep = keepByGroup[group.hash];
  if (!keep || !group.files.includes(keep) || group.files[0] === keep) return [...group.files];
  return [keep, ...group.files.filter((path) => path !== keep)];
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

/** 按唯一相对路径计算，缓存、大文件与重复组重合时不重复累计。 */
export function selectedCleanupBytes(
  analysis: AnalysisReport,
  selected: Set<string>,
  keepByGroup: Record<number, string>,
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
    safe: hit.safety === "SafeToDelete",
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
      safe: false,
      reason: "仅表示占用较大，不代表文件无用；确认后才会移入回收站。",
      searchText: `${file.rel_path} ${file.name} ${file.ext ?? ""}`.toLocaleLowerCase("zh-CN"),
      big: file,
    }));
  const dupes: CleanupItem[] = analysis.dupe_groups.map((group) => ({
    id: `dupe:${group.hash}`,
    kind: "dupe",
    path: group.files[0] ?? "",
    size: group.wasted,
    safe: false,
    reason: "内容哈希一致；选择保留一份，其余副本可移入回收站或合并为硬链接。",
    searchText: group.files.join(" ").toLocaleLowerCase("zh-CN"),
    dupe: group,
  }));
  return [...caches, ...bigFiles, ...dupes].sort((a, b) => b.size - a.size || a.path.localeCompare(b.path, "zh-CN"));
}
