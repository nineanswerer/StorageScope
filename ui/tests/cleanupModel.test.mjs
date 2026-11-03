import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCleanupItems,
  effectiveSelectedPaths,
  normalizeCleanupPath,
  orderedDupeFiles,
  protectionReason,
  sectionAfterScan,
  selectedCleanupBytes,
  selectedDupeGroups,
  updateDupeKeepSelection,
  withoutProtectedPaths,
} from "../src/cleanupModel.ts";

test("取消扫描停留在结果页，完整扫描才进入目录结构", () => {
  assert.equal(sectionAfterScan(true), "scan");
  assert.equal(sectionAfterScan(false), "structure");
});

const emptyAnalysis = () => ({
  scan_id: "test-scan",
  baseline_snapshot_id: 1,
  cache_hits: [],
  big_files: [],
  dupe_groups: [],
  candidate_logical_bytes: 0,
  cleanup_targets: [],
  hashed_bytes: 0,
  hash_errors: 0,
});

const cache = (rel_path, size) => ({
  rule_id: "generic.cache",
  rule_name: "通用缓存目录",
  rel_path,
  size,
  file_count: 1,
  reason: "测试缓存，仅作人工判断线索",
  safety: "ReviewAdvised",
});

const big = (rel_path, size) => ({ rel_path, name: rel_path.split("/").at(-1), size, modified: null, ext: "bin" });
const group = (files, size = 300) => ({ hash: "42", files, size, wasted: size * (files.length - 1) });

test("统一清单合并三类项目，并避免大文件与重复组重复出现", () => {
  const analysis = emptyAnalysis();
  analysis.cache_hits = [cache("cache", 400)];
  analysis.big_files = [big("large.bin", 500), big("a.bin", 300), big("b.bin", 300)];
  analysis.dupe_groups = [group(["a.bin", "b.bin"])];
  const items = buildCleanupItems(analysis);
  assert.deepEqual(items.map((item) => item.kind), ["big", "cache", "dupe"]);
  assert.equal(items.filter((item) => item.kind === "big").length, 1);
  assert.equal(items[0].path, "large.bin");
});

test("大文件可以进入手动选择并计入释放空间", () => {
  const analysis = emptyAnalysis();
  analysis.big_files = [big("large.bin", 500)];
  assert.equal(selectedCleanupBytes(analysis, new Set(["large.bin"]), {}), 500);
});

test("已选缓存目录包含的文件不会重复执行或重复计数", () => {
  const analysis = emptyAnalysis();
  analysis.cache_hits = [cache("cache", 400)];
  analysis.big_files = [big("cache/child.bin", 100)];
  const selected = new Set(["cache", "cache/child.bin"]);
  assert.deepEqual([...effectiveSelectedPaths(selected, analysis.cache_hits)], ["cache"]);
  assert.equal(selectedCleanupBytes(analysis, selected, {}), 400);
});

test("更换重复组保留副本后，删除体积只计算其余副本", () => {
  const analysis = emptyAnalysis();
  analysis.dupe_groups = [group(["a.bin", "b.bin", "c.bin"])];
  const keep = { 42: "c.bin" };
  assert.deepEqual(orderedDupeFiles(analysis.dupe_groups[0], keep), ["c.bin", "a.bin", "b.bin"]);
  assert.equal(selectedCleanupBytes(analysis, new Set(["a.bin", "c.bin"]), keep), 300);
  assert.equal(selectedCleanupBytes(analysis, new Set(["a.bin", "b.bin"]), keep), 600);
});

test("缓存、大文件与重复路径重合时，同一路径只计算一次", () => {
  const analysis = emptyAnalysis();
  analysis.big_files = [big("a.bin", 300)];
  analysis.dupe_groups = [group(["a.bin", "b.bin"])];
  assert.equal(selectedCleanupBytes(analysis, new Set(["a.bin", "b.bin"]), {}), 600);
});

test("已选重复组更换保留副本后仍保持整组选择", () => {
  const analysis = emptyAnalysis();
  analysis.dupe_groups = [group(["a.bin", "b.bin", "c.bin"])];
  const selected = new Set(["b.bin", "c.bin"]);
  const next = updateDupeKeepSelection(selected, analysis.dupe_groups[0], {}, "c.bin");
  assert.deepEqual([...next].sort(), ["a.bin", "b.bin"]);
  assert.equal(selectedCleanupBytes(analysis, next, { 42: "c.bin" }), 600);
  const restored = updateDupeKeepSelection(next, analysis.dupe_groups[0], { 42: "c.bin" }, "a.bin");
  assert.deepEqual([...restored].sort(), ["b.bin", "c.bin"]);
  assert.equal(selectedCleanupBytes(analysis, restored, {}), 600);
});

test("只有完整勾选冗余副本的重复组可以合并", () => {
  const groups = [group(["a.bin", "b.bin", "c.bin"])];
  assert.deepEqual(selectedDupeGroups(groups, new Set(["b.bin", "c.bin"]), {}), groups);
  assert.deepEqual(selectedDupeGroups(groups, new Set(["b.bin"]), {}), []);
  assert.deepEqual(selectedDupeGroups(groups, new Set(), {}), []);
});

test("部分选择的组不会被其他完整组带入合并", () => {
  const first = group(["a.bin", "b.bin"]);
  const second = { ...group(["c.bin", "d.bin", "e.bin"]), hash: "43" };
  const actual = selectedDupeGroups([first, second], new Set(["b.bin", "d.bin"]), {});
  assert.deepEqual(actual, [first]);
});

test("更换保留项后按新的副本集合确定整组选择", () => {
  const original = group(["a.bin", "b.bin", "c.bin"]);
  const selected = updateDupeKeepSelection(new Set(["b.bin", "c.bin"]), original, {}, "c.bin");
  assert.deepEqual([...selected].sort(), ["a.bin", "b.bin"]);
  assert.deepEqual(
    selectedDupeGroups([original], selected, { 42: "c.bin" }),
    [{ ...original, files: ["c.bin", "a.bin", "b.bin"] }],
  );
});

test("范围外的已选路径与展示筛选不会扩大合并范围", () => {
  const shown = group(["visible/a.bin", "visible/b.bin"]);
  const hidden = { ...group(["other/a.bin", "other/b.bin"]), hash: "43" };
  const selected = new Set(["visible/b.bin", "other/b.bin", "unrelated.bin"]);
  assert.deepEqual(selectedDupeGroups([shown, hidden], selected, {}), [shown, hidden]);
  assert.deepEqual(selectedDupeGroups([shown], new Set(["other/b.bin"]), {}), []);
});

test("64 位重复组哈希作为字符串保留完整精度", () => {
  const preciseHash = "18446744073709551614";
  const preciseGroup = { ...group(["a.bin", "b.bin"]), hash: preciseHash };
  const keep = { [preciseHash]: "b.bin" };
  assert.equal(preciseGroup.hash, preciseHash);
  assert.deepEqual(orderedDupeFiles(preciseGroup, keep), ["b.bin", "a.bin"]);
});

test("参考目录同时保护目录自身、后代和祖先", () => {
  assert.equal(protectionReason("projects/originals/a.bin", ["projects/originals"], []), "参考目录保护");
  assert.equal(protectionReason("projects/originals", ["projects/originals"], []), "参考目录保护");
  assert.equal(protectionReason("projects", ["projects/originals"], []), "参考目录保护");
  assert.equal(protectionReason("projects-other/a.bin", ["projects/originals"], []), null);
});

test("Windows 保护目录输入不区分大小写", () => {
  assert.equal(protectionReason("cache", ["Cache/Originals"], []), "参考目录保护");
  assert.equal(protectionReason("cache/originals/a.bin", ["Cache/Originals"], []), "参考目录保护");
  assert.equal(protectionReason("cache", [], ["Cache/Originals"]), "排除目录");
  assert.deepEqual([...withoutProtectedPaths(new Set(["cache", "other.bin"]), ["Cache/Originals"], [])], ["other.bin"]);
});

test("排除目录保护内部项目，也禁止选择其祖先目录绕过边界", () => {
  assert.equal(protectionReason("work/private/a.bin", [], ["work/private"]), "排除目录");
  assert.equal(protectionReason("work", [], ["work/private"]), "排除目录");
  assert.deepEqual([...withoutProtectedPaths(new Set(["work/private/a.bin", "work", "other.bin"]), [], ["work/private"])], ["other.bin"]);
});

test("路径规范化统一分隔符并去除当前目录片段", () => {
  assert.equal(normalizeCleanupPath(" originals\\drafts/./a.bin/ "), "originals/drafts/a.bin");
  assert.equal(selectedCleanupBytes({ ...emptyAnalysis(), big_files: [big("originals/a.bin", 200)] }, new Set(["originals\\a.bin"]), {}), 0);
});

test("保护目录和已排除路径不进入实际选择统计", () => {
  const analysis = emptyAnalysis();
  analysis.big_files = [big("originals/a.bin", 300), big("cache/b.bin", 400), big("other.bin", 100)];
  const selected = new Set(["originals/a.bin", "cache/b.bin", "other.bin"]);
  const allowed = withoutProtectedPaths(selected, ["originals"], ["cache"]);
  assert.deepEqual([...allowed], ["other.bin"]);
  assert.equal(selectedCleanupBytes(analysis, allowed, {}), 100);
});

test("缓存目录命中保持建议确认，不宣称安全删除", () => {
  const analysis = emptyAnalysis();
  analysis.cache_hits = [cache("cache", 400)];
  const [item] = buildCleanupItems(analysis);
  assert.equal(item.recommended, false);
  assert.equal(item.cache.safety, "ReviewAdvised");
});

test("合并后撤下副本及其执行基线，不把它重新列为大文件", async () => {
  const { reconcileAnalysisAfterCleanup } = await import("../src/cleanupModel.ts");
  const analysis = emptyAnalysis();
  analysis.cache_hits = [cache("Backups", 200)];
  analysis.big_files = [big("Packages/a.bin", 200), big("Backups/a.bin", 200), big("Archive/a.bin", 200)];
  analysis.dupe_groups = [group(["Packages/a.bin", "Backups/a.bin", "Archive/a.bin"], 200)];
  analysis.cleanup_targets = analysis.big_files.map((file) => ({ rel_path: file.rel_path }));
  analysis.candidate_logical_bytes = 600;
  const next = reconcileAnalysisAfterCleanup(analysis, new Set(), new Set(["Backups/a.bin", "Archive/a.bin"]), { 42: "Packages/a.bin" });
  assert.deepEqual(next.big_files.map((file) => file.rel_path), ["Packages/a.bin"]);
  assert.equal(next.dupe_groups.length, 0);
  assert.deepEqual(next.cleanup_targets.map((target) => target.rel_path), ["Packages/a.bin"]);
  assert.equal(next.candidate_logical_bytes, 200);
  assert.deepEqual(buildCleanupItems(next).map((item) => item.id).sort(), ["big:Packages/a.bin", "cache:Backups"]);
});

test("回收站结果按目录撤下候选和基线，但保留被跳过的变化目录", async () => {
  const { reconcileAnalysisAfterCleanup } = await import("../src/cleanupModel.ts");
  const analysis = emptyAnalysis();
  analysis.cache_hits = [cache("cache", 400), cache("Backups", 200)];
  analysis.big_files = [big("cache/a.bin", 300), big("other.bin", 100)];
  analysis.cleanup_targets = [{ rel_path: "cache" }, { rel_path: "cache/a.bin" }, { rel_path: "other.bin" }];
  const next = reconcileAnalysisAfterCleanup(analysis, new Set(["cache", "other.bin"]), new Set(), {});
  assert.deepEqual(next.cache_hits.map((hit) => hit.rel_path), ["Backups"]);
  assert.equal(next.big_files.length, 0);
  assert.deepEqual(next.cleanup_targets, []);
  assert.equal(next.candidate_logical_bytes, 200);
});
