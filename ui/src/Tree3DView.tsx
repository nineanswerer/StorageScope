import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

type DirStat = {
  rel_path: string;
  name: string;
  total_size: number;
  file_count: number;
  type_sizes?: Record<string, number>;
  children: DirStat[];
};

type NodeKind = "root" | "folder" | "files" | "more";
type ContentType = "images" | "video" | "audio" | "code" | "documents" | "archives" | "installers" | "other" | "mixed";

const TYPE_LABEL: Record<ContentType, string> = {
  images: "图片",
  video: "视频",
  audio: "音频",
  code: "代码",
  documents: "文档",
  archives: "压缩包",
  installers: "安装程序",
  other: "其他文件",
  mixed: "混合内容",
};

// ---------------------------------------------------------------------------
// 3D 立体树：位置表达层级，造型表达内容，大小表达占用，颜色表达分支。
// 根=档案托盘 / 目录=纸雕文件夹 / 直属文件=叠页 / 折叠项=文件堆。
// 拾取用放大的隐形球代理，小节点也好点；拖动超过 6px 不算点击。
// ---------------------------------------------------------------------------

const RING_GAP = 42;
const LAYER_DROP = 9;
const TOP_K = 8;
const MAX_DEPTH = 6;
const MAX_NODES = 900;

function humanSize(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return i === 0 ? `${v} ${units[i]}` : `${v.toFixed(1)} ${units[i]}`;
}

type LayoutNode = {
  stat: DirStat;
  pos: THREE.Vector3;
  depth: number;
  topName: string;
  pruned: number;
  kind: NodeKind;
};
type Edge = [THREE.Vector3, THREE.Vector3];

function kindOf(stat: DirStat, depth: number): NodeKind {
  if (depth === 0) return "root";
  if (stat.name.startsWith("…其他")) return "more";
  if (stat.name.startsWith("…直属文件")) return "files";
  return "folder";
}

function sumTypes(stats: DirStat[]) {
  const result: Record<string, number> = {};
  for (const stat of stats) {
    for (const [kind, bytes] of Object.entries(stat.type_sizes ?? {})) {
      result[kind] = (result[kind] ?? 0) + bytes;
    }
  }
  return result;
}

function ownTypes(stat: DirStat) {
  const result = { ...(stat.type_sizes ?? {}) };
  for (const child of stat.children) {
    for (const [kind, bytes] of Object.entries(child.type_sizes ?? {})) {
      result[kind] = Math.max(0, (result[kind] ?? 0) - bytes);
    }
  }
  return result;
}

function dominantType(stat: DirStat): ContentType | null {
  const entries = Object.entries(stat.type_sizes ?? {}).filter(([, bytes]) => bytes > 0);
  if (entries.length === 0 || stat.total_size === 0) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][1] / stat.total_size >= 0.35 ? entries[0][0] as ContentType : "mixed";
}

function depthLimitFor(root: DirStat) {
  // 按真实目录复杂度做细节分级，而不是按文件总数或某种应用名称特判。
  let directories = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    directories++;
    for (const child of current.children) pending.push(child);
  }
  return directories > 600 ? 3 : directories > 250 ? 4 : MAX_DEPTH;
}

function balloonLayout(root: DirStat) {
  const nodes: LayoutNode[] = [];
  const edges: Edge[] = [];
  const depthLimit = depthLimitFor(root);
  let budget = MAX_NODES;

  function walk(stat: DirStat, a0: number, a1: number, depth: number, parent: LayoutNode | null, topName: string) {
    if (budget <= 0) return;
    budget--;
    const r = depth * RING_GAP;
    const mid = (a0 + a1) / 2;
    const pos = new THREE.Vector3(r * Math.cos(mid), -depth * LAYER_DROP, r * Math.sin(mid));
    const me: LayoutNode = { stat, pos, depth, topName, pruned: 0, kind: kindOf(stat, depth) };
    nodes.push(me);
    if (parent) edges.push([parent.pos, pos]);
    if (depth >= depthLimit) {
      me.pruned = stat.children.length;
      return;
    }

    const kids = stat.children.slice().sort((a, b) => b.total_size - a.total_size);
    const topK = depthLimit < MAX_DEPTH && depth >= 2 ? 5 : TOP_K;
    const shown = kids.slice(0, topK);
    const hidden = kids.slice(topK);
    if (hidden.length > 0) {
      me.pruned = hidden.length;
      const restSize = hidden.reduce((s, c) => s + c.total_size, 0);
      const restFiles = hidden.reduce((s, c) => s + c.file_count, 0);
      shown.push({
        rel_path: stat.rel_path + "/…其他",
        name: `…其他 ${hidden.length} 项`,
        total_size: restSize,
        file_count: restFiles,
        type_sizes: sumTypes(hidden),
        children: [],
      });
    }

    const ownFiles = Math.max(0, stat.file_count - stat.children.reduce((s, c) => s + c.file_count, 0));
    const ownSize = Math.max(0, stat.total_size - stat.children.reduce((s, c) => s + c.total_size, 0));
    if (ownFiles > 0) {
      shown.push({
        rel_path: stat.rel_path + "/…直属文件",
        name: `…直属文件 ${ownFiles} 个`,
        total_size: ownSize,
        file_count: ownFiles,
        type_sizes: ownTypes(stat),
        children: [],
      });
    }

    const total = shown.reduce((s, c) => s + c.total_size, 0);
    if (total === 0) return;
    let a = a0;
    for (const c of shown) {
      const span = ((a1 - a0) * c.total_size) / total;
      walk(c, a, a + span, depth + 1, me, depth === 0 && !c.name.startsWith("…") ? c.name : topName);
      a += span;
    }
  }

  walk(root, 0, Math.PI * 2, 0, null, "");
  return { nodes, edges, depthLimit };
}

function makeTextSprite(text: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 96;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "rgba(18, 19, 21, 0.86)";
  ctx.beginPath();
  ctx.roundRect(4, 4, 504, 88, 14);
  ctx.fill();
  ctx.fillStyle = "#e8eaed";
  ctx.font = "bold 44px 'Microsoft YaHei', 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(text.length > 14 ? text.slice(0, 13) + "…" : text, 256, 62);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(22, 4.1, 1);
  return sprite;
}

function makeBadgeSprite(type: ContentType) {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "rgba(25, 27, 30, 0.94)";
  ctx.strokeStyle = "#737d87";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(7, 7, 114, 114, 28);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = "#eef0f2";
  ctx.fillStyle = "#eef0f2";
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();

  if (type === "images") {
    ctx.roundRect(29, 33, 70, 60, 6);
    ctx.moveTo(36, 82); ctx.lineTo(53, 63); ctx.lineTo(65, 74); ctx.lineTo(77, 58); ctx.lineTo(93, 80);
    ctx.moveTo(77, 47); ctx.arc(72, 47, 5, 0, Math.PI * 2);
  } else if (type === "video") {
    ctx.roundRect(26, 34, 76, 60, 8);
    ctx.moveTo(55, 49); ctx.lineTo(78, 64); ctx.lineTo(55, 79); ctx.closePath();
  } else if (type === "audio") {
    ctx.moveTo(54, 79); ctx.lineTo(54, 38); ctx.lineTo(84, 32); ctx.lineTo(84, 71);
    ctx.moveTo(54, 79); ctx.arc(44, 79, 10, 0, Math.PI * 2);
    ctx.moveTo(84, 71); ctx.arc(74, 71, 10, 0, Math.PI * 2);
  } else if (type === "code") {
    ctx.moveTo(45, 39); ctx.lineTo(27, 64); ctx.lineTo(45, 89);
    ctx.moveTo(83, 39); ctx.lineTo(101, 64); ctx.lineTo(83, 89);
    ctx.moveTo(71, 32); ctx.lineTo(57, 96);
  } else if (type === "archives") {
    ctx.roundRect(31, 34, 66, 60, 6);
    ctx.moveTo(64, 35); ctx.lineTo(64, 91);
    ctx.moveTo(52, 48); ctx.lineTo(76, 48);
    ctx.moveTo(52, 80); ctx.lineTo(76, 80);
  } else if (type === "installers") {
    ctx.moveTo(64, 27); ctx.lineTo(64, 70);
    ctx.moveTo(49, 56); ctx.lineTo(64, 71); ctx.lineTo(79, 56);
    ctx.moveTo(29, 73); ctx.lineTo(29, 94); ctx.lineTo(99, 94); ctx.lineTo(99, 73);
  } else {
    ctx.moveTo(36, 27); ctx.lineTo(75, 27); ctx.lineTo(94, 46); ctx.lineTo(94, 101); ctx.lineTo(36, 101); ctx.closePath();
    ctx.moveTo(75, 28); ctx.lineTo(75, 47); ctx.lineTo(93, 47);
    if (type === "documents") {
      ctx.moveTo(47, 61); ctx.lineTo(82, 61);
      ctx.moveTo(47, 75); ctx.lineTo(82, 75);
      ctx.moveTo(47, 89); ctx.lineTo(72, 89);
    }
  }
  ctx.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(5.4, 5.4, 1);
  return sprite;
}

function focusOf(tree: DirStat, path: string[]): DirStat {
  let node = tree;
  for (const p of path) {
    const next = node.children.find((c) => c.rel_path === p);
    if (!next) return node;
    node = next;
  }
  return node;
}

function makeFolderGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo(-1.08, -0.72);
  shape.lineTo(1.08, -0.72);
  shape.lineTo(1.08, 0.5);
  shape.lineTo(0.02, 0.5);
  shape.lineTo(-0.24, 0.82);
  shape.lineTo(-1.08, 0.82);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.3,
    bevelEnabled: true,
    bevelSegments: 3,
    bevelSize: 0.07,
    bevelThickness: 0.07,
    curveSegments: 4,
  });
  geo.center();
  return geo;
}

function makePageGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo(-0.7, -0.96);
  shape.lineTo(0.7, -0.96);
  shape.lineTo(0.7, 0.38);
  shape.lineTo(0.2, 0.96);
  shape.lineTo(-0.7, 0.96);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.16,
    bevelEnabled: true,
    bevelSegments: 2,
    bevelSize: 0.045,
    bevelThickness: 0.045,
  });
  geo.center();
  return geo;
}

function transformed(geo: THREE.BufferGeometry, x: number, y: number, z: number, angle: number) {
  const copy = geo.clone();
  copy.rotateY(angle);
  copy.translate(x, y, z);
  return copy;
}

/** 纸雕语义模型：同一组实例共享几何体，保留大目录性能预算。 */
function makeShapeGeos(): { key: NodeKind; geo: THREE.BufferGeometry }[] {
  const tray = new THREE.CylinderGeometry(1.12, 1.22, 0.34, 48, 1);
  const rim = new THREE.TorusGeometry(1.13, 0.07, 8, 48);
  rim.rotateX(Math.PI / 2);
  rim.translate(0, 0.19, 0);
  const root = mergeGeometries([tray, rim])!;

  const folder = makeFolderGeometry();
  const page = makePageGeometry();
  const files = mergeGeometries([
    transformed(page, -0.1, -0.1, -0.1, -0.12),
    transformed(page, 0.08, 0.04, 0.08, 0.08),
  ])!;
  const more = mergeGeometries([
    transformed(folder, -0.12, -0.2, -0.12, -0.08),
    transformed(folder, 0.02, 0.02, 0.04, 0.04),
    transformed(folder, 0.12, 0.23, 0.15, 0.1),
  ])!;

  return [
    { key: "root", geo: root },
    { key: "folder", geo: folder },
    { key: "files", geo: files },
    { key: "more", geo: more },
  ];
}

export default function Tree3DView({ tree, highlight }: { tree: DirStat; highlight?: Set<string> }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const resetViewRef = useRef<(() => void) | null>(null);
  const [path, setPathState] = useState<string[]>([]);
  const setPath: typeof setPathState = (next) => {
    const scrollTop = window.scrollY;
    setPathState(next);
    // 所有目录切换都保留阅读位置，避免画布替换后跳回页面顶部。
    window.setTimeout(() => window.scrollTo(0, scrollTop), 0);
  };
  const focus = useMemo(() => focusOf(tree, path), [tree, path]);

  const hues = useMemo(() => {
    const map = new Map<string, number>();
    (tree.children || [])
      .slice()
      .sort((a, b) => b.total_size - a.total_size)
      .forEach((c, i) => map.set(c.name, (i * 0.6180339887) % 1));
    return map;
  }, [tree]);

  const crumbs: { label: string; path: string[] }[] = [{ label: tree.name, path: [] }];
  {
    let n = tree;
    for (let i = 0; i < path.length; i++) {
      const next = n.children.find((c) => c.rel_path === path[i]);
      if (!next) break;
      crumbs.push({ label: next.name, path: path.slice(0, i + 1) });
      n = next;
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (event.key.toLowerCase() === "r") {
        event.preventDefault();
        resetViewRef.current?.();
      } else if (event.key === "Escape") {
        event.preventDefault();
        setPath((current) => current.slice(0, -1));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const mount = mountRef.current!;
    if (tooltipRef.current) tooltipRef.current.style.display = "none";
    const heightFor = (w: number) => Math.max(400, Math.min(560, Math.round(w * 0.62)));
    let width = Math.max(1, mount.clientWidth);
    let height = heightFor(width);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute("role", "img");
    renderer.domElement.setAttribute(
      "aria-label",
      "三维目录树。拖动旋转，滚轮缩放；按 R 重置视角，按 Escape 返回上级目录。"
    );
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x121315);
    scene.fog = new THREE.Fog(0x121315, 700, 1800);

    const { nodes, edges } = balloonLayout(focus);
    const maxLog = Math.max(...nodes.map((n) => Math.log10(1 + n.stat.total_size / 1e6)), 1);
    const extent = nodes.reduce((m, n) => Math.max(m, Math.hypot(n.pos.x, n.pos.z)), 60);

    const camera = new THREE.PerspectiveCamera(48, width / height, 0.5, 6000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    controls.autoRotate = false;
    controls.minDistance = 45;
    controls.maxDistance = 3600;
    controls.maxPolarAngle = Math.PI * 0.48;

    let hasInteracted = false;
    const textLabels: { sprite: THREE.Sprite; position: THREE.Vector3 }[] = [];
    const layoutTextLabels = () => {
      const distance = camera.position.distanceTo(controls.target);
      const worldPerPixel = 2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) / height;
      const occupied: { left: number; right: number; top: number; bottom: number }[] = [];
      for (const { sprite, position } of textLabels) {
        sprite.scale.set(144 * worldPerPixel, 27 * worldPerPixel, 1);
        const projected = position.clone().project(camera);
        const x = (projected.x * 0.5 + 0.5) * width;
        const y = (-projected.y * 0.5 + 0.5) * height;
        const rect = { left: x - 72, right: x + 72, top: y - 16, bottom: y + 16 };
        const collides = occupied.some((other) =>
          rect.left < other.right && rect.right > other.left && rect.top < other.bottom && rect.bottom > other.top
        );
        sprite.visible = projected.z >= -1 && projected.z <= 1 && !collides;
        if (sprite.visible) occupied.push(rect);
      }
    };
    const onControlsStart = () => { hasInteracted = true; };
    controls.addEventListener("start", onControlsStart);
    const resetView = () => {
      // 从较近位置开始，只在投影可能裁切时后退，避免深层小目录缩得过小。
      const target = new THREE.Vector3(0, -28, 0);
      const direction = new THREE.Vector3(0.72, 0.66, 0.72).normalize();
      const projected = new THREE.Vector3();
      let distance = Math.max(140, extent * 1.05 + 60);
      for (let attempt = 0; attempt < 18; attempt++) {
        camera.position.copy(target).addScaledVector(direction, distance);
        camera.lookAt(target);
        camera.updateMatrixWorld();
        let peak = 0;
        for (const node of nodes) {
          // 上方预留名称与徽章，下方预留纸雕模型厚度。
          for (const offsetY of [-10, 20]) {
            projected.copy(node.pos);
            projected.y += offsetY;
            projected.project(camera);
            peak = Math.max(peak, Math.abs(projected.x) / 0.86, Math.abs(projected.y) / 0.82);
          }
        }
        if (peak <= 1) break;
        distance *= Math.min(2.2, Math.max(1.08, peak * 1.04));
      }
      controls.target.copy(target);
      camera.lookAt(target);
      controls.update();
      layoutTextLabels();
      hasInteracted = false;
    };
    resetViewRef.current = resetView;
    resetView();

    const resizeObserver = new ResizeObserver(([entry]) => {
      const nextWidth = Math.max(1, Math.round(entry.contentRect.width));
      const nextHeight = heightFor(nextWidth);
      if (nextWidth === width && nextHeight === height) return;
      width = nextWidth;
      height = nextHeight;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      if (!hasInteracted) resetView();
    });
    resizeObserver.observe(mount);

    scene.add(new THREE.HemisphereLight(0xb8c0c8, 0x242629, 1.45));
    const key = new THREE.DirectionalLight(0xf0f1f2, 1.8);
    key.position.set(200, 400, 150);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xaeb8c4, 0.65);
    fill.position.set(-180, 120, -120);
    scene.add(fill);

    // 单一 LineSegments 绘制柔和弧线，避免每个分支一次 draw call。
    const EDGE_SEGMENTS = 10;
    const edgePos = new Float32Array(edges.length * EDGE_SEGMENTS * 6);
    edges.forEach(([a, b], i) => {
      const control = a.clone().add(b).multiplyScalar(0.5);
      control.y += Math.min(8, 2 + a.distanceTo(b) * 0.04);
      const points = new THREE.QuadraticBezierCurve3(a, control, b).getPoints(EDGE_SEGMENTS);
      for (let j = 0; j < EDGE_SEGMENTS; j++) {
        const p = points[j];
        const q = points[j + 1];
        edgePos.set([p.x, p.y, p.z, q.x, q.y, q.z], (i * EDGE_SEGMENTS + j) * 6);
      }
    });
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute("position", new THREE.BufferAttribute(edgePos, 3));
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x7d858e, transparent: true, opacity: 0.52 });
    scene.add(new THREE.LineSegments(edgeGeo, edgeMat));

    // 哑光纸雕材质：以漫反射为主，不使用荧光或金属高光。
    const nodeMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.82,
      metalness: 0,
      emissive: 0xffffff,
      emissiveIntensity: 0.1,
    });
    nodeMat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= vColor.rgb;"
      );
    };

    // 按内容类型分组：每组一个可见 InstancedMesh + 一个放大的隐形拾取代理
    const shapeGeos = makeShapeGeos();
    const pickGeo = new THREE.SphereGeometry(1, 10, 8);
    const pickMat = new THREE.MeshBasicMaterial();
    pickMat.visible = false; // 不渲染，但 raycast 仍命中
    const disposables: { dispose: () => void }[] = [...shapeGeos.map((g) => g.geo), pickGeo, pickMat, nodeMat, edgeGeo, edgeMat];

    const groups = new Map<NodeKind, LayoutNode[]>();
    for (const n of nodes) {
      if (!groups.has(n.kind)) groups.set(n.kind, []);
      groups.get(n.kind)!.push(n);
    }

    const radiusOf = (n: LayoutNode) => {
      const t = Math.log10(1 + n.stat.total_size / 1e6) / maxLog;
      return 1.4 + 5.2 * t;
    };
    const colorOf = (n: LayoutNode) => {
      const col = new THREE.Color();
      const hue = hues.get(n.topName) ?? 0.55;
      if (highlight?.has(n.stat.rel_path)) col.setHSL(0.075, 0.64, 0.58); // 柔和橙 = 可清理
      else if (n.kind === "more") col.setHSL(hue, 0.1, 0.44);
      else if (n.kind === "files") col.setHSL(hue, 0.2, 0.7);
      else if (n.kind === "root") col.setHSL(0.58, 0.16, 0.62);
      else col.setHSL(hue, 0.38, 0.54 + 0.06 * Math.min(n.depth / MAX_DEPTH, 1));
      return col;
    };

    const pickMeshes: THREE.InstancedMesh[] = [];
    const m4 = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    for (const { key, geo } of shapeGeos) {
      const group = groups.get(key);
      if (!group || group.length === 0) continue;
      quat.setFromEuler(key === "root" ? new THREE.Euler(0, 0, 0) : new THREE.Euler(-0.12, Math.PI / 4, 0));
      const inst = new THREE.InstancedMesh(geo, nodeMat, group.length);
      const pick = new THREE.InstancedMesh(pickGeo, pickMat, group.length);
      pick.userData.nodes = group;
      group.forEach((n, i) => {
        scl.setScalar(radiusOf(n) * (key === "more" ? 0.8 : key === "files" ? 0.9 : 1));
        m4.compose(n.pos, quat, scl);
        inst.setMatrixAt(i, m4);
        inst.setColorAt(i, colorOf(n));
        // 拾取代理放大 1.9 倍，小节点不再难瞄准
        scl.setScalar(radiusOf(n) * 1.9);
        m4.compose(n.pos, quat, scl);
        pick.setMatrixAt(i, m4);
      });
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      pick.instanceMatrix.needsUpdate = true;
      scene.add(inst);
      scene.add(pick);
      pickMeshes.push(pick);
    }

    // 近两层显示类型徽章；折叠堆不额外抢占画面。
    const labelSprites: THREE.Sprite[] = [];
    for (const n of nodes) {
      const content = dominantType(n.stat);
      if (n.depth >= 1 && n.depth <= 2 && (n.kind === "folder" || n.kind === "files") && content && content !== "mixed") {
        const badge = makeBadgeSprite(content);
        badge.position.copy(n.pos).add(new THREE.Vector3(0, radiusOf(n) + 3, 0));
        labelSprites.push(badge);
        scene.add(badge);
      }
    }

    // 顶层名称按占用优先排列；每次重置或 resize 都重新做屏幕空间碰撞检测。
    const topLabels = nodes
      .filter((n) => n.depth === 1 && n.kind === "folder")
      .sort((a, b) => b.stat.total_size - a.stat.total_size);
    for (const n of topLabels) {
      const labelPosition = n.pos.clone().add(new THREE.Vector3(0, radiusOf(n) + 9, 0));
      const sprite = makeTextSprite(n.stat.name);
      sprite.position.copy(labelPosition);
      textLabels.push({ sprite, position: labelPosition });
      labelSprites.push(sprite);
      scene.add(sprite);
    }
    layoutTextLabels();

    // 单一相机对齐高亮环：只显示当前拾取项，不给整棵树增加光效。
    const ringCanvas = document.createElement("canvas");
    ringCanvas.width = 128;
    ringCanvas.height = 128;
    const ringCtx = ringCanvas.getContext("2d")!;
    ringCtx.strokeStyle = "#c4d5e6";
    ringCtx.lineWidth = 5;
    ringCtx.beginPath();
    ringCtx.arc(64, 64, 50, 0, Math.PI * 2);
    ringCtx.stroke();
    const ringTexture = new THREE.CanvasTexture(ringCanvas);
    ringTexture.colorSpace = THREE.SRGBColorSpace;
    const hoverRing = new THREE.Sprite(new THREE.SpriteMaterial({
      map: ringTexture,
      transparent: true,
      depthWrite: false,
      opacity: 0.9,
    }));
    hoverRing.visible = false;
    hoverRing.renderOrder = 2;
    scene.add(hoverRing);
    disposables.push(ringTexture, hoverRing.material);

    // 悬停拾取（只打代理球）+ 点击下钻（拖动 >6px 不算点击）
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let hoverNode: LayoutNode | null = null;
    let downX = 0, downY = 0;
    const clearHover = () => {
      hoverNode = null;
      hoverRing.visible = false;
      if (tooltipRef.current) tooltipRef.current.style.display = "none";
      renderer.domElement.style.cursor = "grab";
    };
    const onMove = (ev: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(pickMeshes)[0];
      const tip = tooltipRef.current;
      if (hit && hit.instanceId !== undefined) {
        const n = (hit.object.userData.nodes as LayoutNode[])[hit.instanceId];
        hoverNode = n;
        hoverRing.visible = true;
        hoverRing.position.copy(n.pos);
        hoverRing.scale.set(radiusOf(n) * 3, radiusOf(n) * 3, 1);
        if (tip) {
          const content = dominantType(n.stat);
          tip.style.display = "block";
          tip.style.left = `${Math.min(ev.clientX - rect.left + 14, Math.max(8, rect.width - 320))}px`;
          tip.style.top = `${ev.clientY - rect.top + 10}px`;
          tip.textContent = `${n.stat.name} — ${humanSize(n.stat.total_size)} · ${n.stat.file_count} 文件${content ? `｜主要内容：${TYPE_LABEL[content]}` : ""}${highlight?.has(n.stat.rel_path) ? "｜含可清理项" : ""}${n.pruned > 0 ? `（另有 ${n.pruned} 个子项已折叠）` : ""}${n.stat.children.length > 0 ? "｜点击下钻" : ""}`;
        }
        renderer.domElement.style.cursor = n.stat.children.length > 0 ? "pointer" : "grab";
      } else {
        clearHover();
      }
    };
    const onDown = (ev: PointerEvent) => {
      downX = ev.clientX;
      downY = ev.clientY;
      renderer.domElement.focus({ preventScroll: true });
    };
    const onUp = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > 6) return; // 拖动不触发
      const n = hoverNode;
      if (n && n.stat.children.length > 0 && !n.stat.name.startsWith("…其他")) {
        setPath((current) => [...current, n.stat.rel_path]);
      }
    };
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);
    renderer.domElement.addEventListener("pointerleave", clearHover);

    let raf = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      resetViewRef.current = null;
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      renderer.domElement.removeEventListener("pointerleave", clearHover);
      controls.removeEventListener("start", onControlsStart);
      controls.dispose();
      renderer.dispose();
      disposables.forEach((d) => d.dispose());
      labelSprites.forEach((s) => {
        (s.material as THREE.SpriteMaterial).map?.dispose();
        (s.material as THREE.SpriteMaterial).dispose();
      });
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, highlight]);

  return (
    <div className="tree3d">
      <div className="row tree3d-toolbar">
        <span className="crumbs" aria-label="当前目录路径">
          {crumbs.map((c, i) => (
            <span key={i}>
              {i > 0 && " / "}
              <button type="button" onClick={() => setPath(c.path)} className="crumb">
                {c.label}
              </button>
            </span>
          ))}
        </span>
        <div className="tree3d-actions">
          <button type="button" disabled={path.length === 0} onClick={() => setPath((current) => current.slice(0, -1))}>
            返回上级
          </button>
          <button type="button" onClick={() => resetViewRef.current?.()}>
            重置视角（R）
          </button>
        </div>
      </div>
      <div className="summary" id="tree3d-help" style={{ marginBottom: 6 }}>
        托盘 = 根目录，文件夹 = 可下钻目录，叠页 = 直属文件，文件堆 = 折叠项；徽章 = 主导类型，大小 ∝ 占用，橙色 = 可清理。
        复杂目录会自动折叠深层分支；点击文件夹继续下钻，悬停看详情；拖动旋转，滚轮缩放；R 重置，Esc 返回上级。
        当前聚焦：{focus.rel_path}（{humanSize(focus.total_size)}）
      </div>
      <div className="city-view" style={{ position: "relative" }}>
        <div ref={mountRef} />
        <div ref={tooltipRef} className="tree3d-tooltip" style={{ display: "none" }} />
      </div>
    </div>
  );
}
