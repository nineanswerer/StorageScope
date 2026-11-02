import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCleanupItems,
  effectiveSelectedPaths,
  orderedDupeFiles,
  selectedCleanupBytes,
} from "../src/cleanupModel.ts";

const emptyAnalysis = () => ({
  cache_hits: [],
  big_files: [],
  dupe_groups: [],
  reclaimable_bytes: 0,
  hashed_bytes: 0,
  hash_errors: 0,
});

const cache = (rel_path, size) => ({
  rule_id: "generic.cache",
  rule_name: "通用缓存目录",
  rel_path,
  size,
  file_count: 1,
  reason: "测试缓存",
  safety: "SafeToDelete",
});

const big = (rel_path, size) => ({ rel_path, name: rel_path.split("/").at(-1), size, modified: null, ext: "bin" });
const group = (files, size = 300) => ({ hash: 42, files, size, wasted: size * (files.length - 1) });

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
