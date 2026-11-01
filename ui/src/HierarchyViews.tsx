import { useMemo, useState } from "react";
import * as THREE from "three";

type DirStat = {
  rel_path: string;
  name: string;
  total_size: number;
  file_count: number;
  children: DirStat[];
};

// ---------------------------------------------------------------------------
// 层级视图：旭日图 / 冰柱图。共用"大小比例划分"，点击下钻，面包屑返回。
// 颜色规则与 3D 城市一致：顶级目录定色相（黄金角散布）。
// ---------------------------------------------------------------------------

function humanSize(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return i === 0 ? `${v} ${units[i]}` : `${v.toFixed(1)} ${units[i]}`;
}

// 顶级目录的色相表（按大小排序后黄金角散布，与 CityView 一致）
function useDistrictHues(tree: DirStat) {
  return useMemo(() => {
    const map = new Map<string, number>();
    (tree.children || [])
      .slice()
      .sort((a, b) => b.total_size - a.total_size)
      .forEach((c, i) => map.set(c.name, (i * 0.6180339887) % 1));
    return map;
  }, [tree]);
}

function nodeColor(node: DirStat, topName: string, hues: Map<string, number>, depth: number, highlight?: Set<string>) {
  if (highlight?.has(node.rel_path)) return "#ff9f43"; // 橙色 = 可清理
  const hue = hues.get(topName) ?? 0.55;
  const c = new THREE.Color();
  c.setHSL(hue, 0.62, Math.min(0.72, 0.5 + depth * 0.045));
  return `#${c.getHexString()}`;
}

/** 找到当前聚焦节点（按 rel_path 链从根向下走） */
function focusOf(tree: DirStat, path: string[]): DirStat {
  let node = tree;
  for (const p of path) {
    const next = node.children.find((c) => c.rel_path === p);
    if (!next) return node;
    node = next;
  }
  return node;
}

// ---------------------------------------------------------------------------
// 旭日图
// ---------------------------------------------------------------------------

type Arc = {
  node: DirStat;
  depth: number;
  a0: number;
  a1: number;
  topName: string;
};

function polar(cx: number, cy: number, r: number, a: number) {
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arcPath(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number) {
  const [x0, y0] = polar(cx, cy, r1, a0);
  const [x1, y1] = polar(cx, cy, r1, a1);
  const [x2, y2] = polar(cx, cy, r0, a1);
  const [x3, y3] = polar(cx, cy, r0, a0);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${x0},${y0} A${r1},${r1} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${r0},${r0} 0 ${large} 0 ${x3},${y3} Z`;
}

function Sunburst({ root, hues, onDrill, highlight }: { root: DirStat; hues: Map<string, number>; onDrill: (n: DirStat) => void; highlight?: Set<string> }) {
  const S = 760, C = S / 2, R0 = 86, RING = 46, MAX_DEPTH = 6;
  const arcs: Arc[] = [];

  function walk(node: DirStat, a0: number, a1: number, depth: number, topName: string) {
    if (depth > MAX_DEPTH || a1 - a0 < 0.004) return;
    arcs.push({ node, depth, a0, a1, topName });
    const total = node.children.reduce((s, c) => s + c.total_size, 0);
    let a = a0;
    for (const c of node.children.slice().sort((x, y) => y.total_size - x.total_size)) {
      const span = total > 0 ? ((a1 - a0) * c.total_size) / total : 0;
      walk(c, a, a + span, depth + 1, depth === 0 ? c.name : topName);
      a += span;
    }
  }
  // 根的孩子从 -90° 开始顺时针
  const rootTotal = root.children.reduce((s, c) => s + c.total_size, 0);
  let a = -Math.PI / 2;
  for (const c of root.children.slice().sort((x, y) => y.total_size - x.total_size)) {
    const span = rootTotal > 0 ? (2 * Math.PI * c.total_size) / rootTotal : 0;
    walk(c, a, a + span, 0, c.name);
    a += span;
  }

  return (
    <svg viewBox={`0 0 ${S} ${S}`} className="hier-svg">
      {/* 中心：点击返回上一级由面包屑处理；这里显示当前根 */}
      <circle cx={C} cy={C} r={R0 - 6} fill="#0d1a29" stroke="#16324a" />
      <text x={C} y={C - 8} textAnchor="middle" fill="#eaf6ff" fontSize="16" fontWeight="bold">
        {root.name}
      </text>
      <text x={C} y={C + 14} textAnchor="middle" fill="#7fd4ff" fontSize="13">
        {humanSize(root.total_size)}
      </text>
      {arcs.map((arc) => {
        const r0 = R0 + arc.depth * RING;
        const r1 = r0 + RING - 2;
        const mid = (arc.a0 + arc.a1) / 2;
        const showLabel = arc.a1 - arc.a0 > 0.13 && arc.depth < 4;
        const [lx, ly] = polar(C, C, (r0 + r1) / 2, mid);
        const deg = (mid * 180) / Math.PI;
        const flip = deg > 90 && deg < 270;
        return (
          <g key={arc.node.rel_path} onClick={() => arc.node.children.length > 0 && onDrill(arc.node)} style={{ cursor: arc.node.children.length ? "pointer" : "default" }}>
            <path d={arcPath(C, C, r0, r1, arc.a0, arc.a1)} fill={nodeColor(arc.node, arc.topName, hues, arc.depth, highlight)} stroke="#0b0e14" strokeWidth="1">
              <title>{`${arc.node.rel_path}\n${humanSize(arc.node.total_size)} · ${arc.node.file_count} 文件`}</title>
            </path>
            {showLabel && (
              <text
                x={lx}
                y={ly}
                textAnchor="middle"
                fill="#0b0e14"
                fontSize="11"
                fontWeight="600"
                transform={`rotate(${flip ? deg + 90 : deg - 90} ${lx} ${ly})`}
                pointerEvents="none"
              >
                {arc.node.name.length > 12 ? arc.node.name.slice(0, 11) + "…" : arc.node.name}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// 冰柱图
// ---------------------------------------------------------------------------

type Cell = {
  node: DirStat;
  depth: number;
  x0: number;
  x1: number;
  topName: string;
};

function Icicle({ root, hues, onDrill, highlight }: { root: DirStat; hues: Map<string, number>; onDrill: (n: DirStat) => void; highlight?: Set<string> }) {
  const W = 1000, ROW = 30, MAX_DEPTH = 15;
  const cells: Cell[] = [];

  function walk(node: DirStat, x0: number, x1: number, depth: number, topName: string) {
    if (depth > MAX_DEPTH || x1 - x0 < 1.5) return;
    cells.push({ node, depth, x0, x1, topName });
    const total = node.children.reduce((s, c) => s + c.total_size, 0);
    let x = x0;
    for (const c of node.children.slice().sort((a, b) => b.total_size - a.total_size)) {
      const w = total > 0 ? ((x1 - x0) * c.total_size) / total : 0;
      walk(c, x, x + w, depth + 1, depth === 0 ? c.name : topName);
      x += w;
    }
  }
  const total = root.children.reduce((s, c) => s + c.total_size, 0);
  let x = 0;
  for (const c of root.children.slice().sort((a, b) => b.total_size - a.total_size)) {
    const w = total > 0 ? (W * c.total_size) / total : 0;
    walk(c, x, x + w, 0, c.name);
    x += w;
  }

  const maxDepth = Math.min(MAX_DEPTH, cells.reduce((m, c) => Math.max(m, c.depth), 0));
  const H = (maxDepth + 1) * ROW + 44;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="hier-svg">
      <rect x={0} y={0} width={W} height={36} rx={6} fill="#0d1a29" stroke="#16324a" />
      <text x={12} y={23} fill="#eaf6ff" fontSize="14" fontWeight="bold">
        {root.name} · {humanSize(root.total_size)} · {root.file_count} 文件
      </text>
      {cells.map((c) => (
        <g key={c.node.rel_path} onClick={() => c.node.children.length > 0 && onDrill(c.node)} style={{ cursor: c.node.children.length ? "pointer" : "default" }}>
          <rect
            x={c.x0}
            y={40 + c.depth * ROW}
            width={Math.max(0.5, c.x1 - c.x0 - 1)}
            height={ROW - 2}
            fill={nodeColor(c.node, c.topName, hues, c.depth, highlight)}
            stroke="#0b0e14"
            strokeWidth="0.5"
          >
            <title>{`${c.node.rel_path}\n${humanSize(c.node.total_size)} · ${c.node.file_count} 文件`}</title>
          </rect>
          {c.x1 - c.x0 > 60 && (
            <text x={c.x0 + 5} y={40 + c.depth * ROW + 19} fill="#0b0e14" fontSize="11" fontWeight="600" pointerEvents="none">
              {c.node.name.length * 12 < c.x1 - c.x0 ? c.node.name : c.node.name.slice(0, Math.floor((c.x1 - c.x0) / 12)) + "…"}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// 容器：视图切换 + 面包屑
// ---------------------------------------------------------------------------

export default function HierarchyViews({ tree, highlight }: { tree: DirStat; highlight?: Set<string> }) {
  const [mode, setMode] = useState<"sunburst" | "icicle">("sunburst");
  const [path, setPath] = useState<string[]>([]);
  const hues = useDistrictHues(tree);
  const focus = focusOf(tree, path);

  // 面包屑：根 / 每层
  const crumbs: { label: string; path: string[] }[] = [{ label: tree.name, path: [] }];
  let node = tree;
  for (let i = 0; i < path.length; i++) {
    const next = node.children.find((c) => c.rel_path === path[i]);
    if (!next) break;
    crumbs.push({ label: next.name, path: path.slice(0, i + 1) });
    node = next;
  }

  return (
    <div>
      <div className="row" style={{ alignItems: "center" }}>
        <button className={mode === "sunburst" ? "primary" : ""} onClick={() => setMode("sunburst")}>
          旭日图
        </button>
        <button className={mode === "icicle" ? "primary" : ""} onClick={() => setMode("icicle")}>
          冰柱图
        </button>
        <span className="crumbs">
          {crumbs.map((c, i) => (
            <span key={i}>
              {i > 0 && " / "}
              <a onClick={() => setPath(c.path)} className="crumb">
                {c.label}
              </a>
            </span>
          ))}
        </span>
      </div>
      <div className="summary" style={{ marginBottom: 6 }}>
        点击任意块下钻进入该目录；点面包屑返回上级。当前聚焦：{focus.rel_path}（{humanSize(focus.total_size)}）
      </div>
      {mode === "sunburst" ? (
        <Sunburst root={focus} hues={hues} onDrill={(n) => setPath([...path, n.rel_path])} highlight={highlight} />
      ) : (
        <Icicle root={focus} hues={hues} onDrill={(n) => setPath([...path, n.rel_path])} highlight={highlight} />
      )}
    </div>
  );
}
