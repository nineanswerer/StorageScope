import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

type DirStat = {
  rel_path: string;
  name: string;
  total_size: number;
  file_count: number;
  children: DirStat[];
};

// ---------------------------------------------------------------------------
// 3D 立体树（球树布局）：根在中心，每层是一圈向下微倾的环，
// 子节点在父节点的扇形楔内按大小分角度。节点球大小 ∝ log(体积)。
// 点击节点重新以其为根；面包屑返回。缓慢自转，交互时暂停。
// ---------------------------------------------------------------------------

const RING_GAP = 42; // 每层半径间隔
const LAYER_DROP = 9; // 每层向下倾斜（锥形轮廓）
const TOP_K = 8; // 每个节点最多展开的子节点数
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
  pruned: number; // 被折叠隐藏的子树数量（0 = 完整）
};
type Edge = [THREE.Vector3, THREE.Vector3];

/** 球树布局：递归分扇形楔。返回节点与边。 */
function balloonLayout(root: DirStat) {
  const nodes: LayoutNode[] = [];
  const edges: Edge[] = [];
  let budget = MAX_NODES;

  function walk(stat: DirStat, a0: number, a1: number, depth: number, parent: LayoutNode | null, topName: string) {
    if (budget <= 0) return;
    budget--;
    const r = depth * RING_GAP;
    const mid = (a0 + a1) / 2;
    const pos = new THREE.Vector3(r * Math.cos(mid), -depth * LAYER_DROP, r * Math.sin(mid));
    const me: LayoutNode = { stat, pos, depth, topName, pruned: 0 };
    nodes.push(me);
    if (parent) edges.push([parent.pos, pos]);
    if (depth >= MAX_DEPTH) {
      me.pruned = stat.children.length;
      return;
    }

    const kids = stat.children.slice().sort((a, b) => b.total_size - a.total_size);
    const shown = kids.slice(0, TOP_K);
    const hidden = kids.slice(TOP_K);
    if (hidden.length > 0) {
      me.pruned = hidden.length;
      // 折叠部分聚合成一个"其他"叶子
      const restSize = hidden.reduce((s, c) => s + c.total_size, 0);
      const restFiles = hidden.reduce((s, c) => s + c.file_count, 0);
      shown.push({
        rel_path: stat.rel_path + "/…其他",
        name: `…其他 ${hidden.length} 项`,
        total_size: restSize,
        file_count: restFiles,
        children: [],
      });
    }
    const total = shown.reduce((s, c) => s + c.total_size, 0);
    if (total === 0) return;
    let a = a0;
    for (const c of shown) {
      const span = ((a1 - a0) * c.total_size) / total;
      walk(c, a, a + span, depth + 1, me, depth === 0 ? c.name : topName);
      a += span;
    }
  }

  walk(root, 0, Math.PI * 2, 0, null, "");
  return { nodes, edges };
}

function makeTextSprite(text: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 96;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "rgba(8, 14, 24, 0.66)";
  ctx.beginPath();
  ctx.roundRect(4, 4, 504, 88, 14);
  ctx.fill();
  ctx.fillStyle = "#eaf6ff";
  ctx.font = "bold 44px 'Microsoft YaHei', 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(text.length > 14 ? text.slice(0, 13) + "…" : text, 256, 62);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(22, 4.1, 1);
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

export default function Tree3DView({ tree }: { tree: DirStat }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [path, setPath] = useState<string[]>([]);
  const focus = useMemo(() => focusOf(tree, path), [tree, path]);

  const hues = useMemo(() => {
    const map = new Map<string, number>();
    (tree.children || [])
      .slice()
      .sort((a, b) => b.total_size - a.total_size)
      .forEach((c, i) => map.set(c.name, (i * 0.6180339887) % 1));
    return map;
  }, [tree]);

  // 面包屑
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
    const mount = mountRef.current!;
    const width = mount.clientWidth;
    const height = 560;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0e14);
    scene.fog = new THREE.Fog(0x0b0e14, 500, 1600);

    const { nodes, edges } = balloonLayout(focus);
    const maxLog = Math.max(...nodes.map((n) => Math.log10(1 + n.stat.total_size / 1e6)), 1);
    const extent = nodes.reduce((m, n) => Math.max(m, Math.hypot(n.pos.x, n.pos.z)), 60);

    const camera = new THREE.PerspectiveCamera(52, width / height, 0.5, 6000);
    const camR = extent * 1.5 + 120;
    camera.position.set(camR * 0.7, extent * 0.85 + 40, camR * 0.7);
    camera.lookAt(0, -20, 0);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, -18, 0);
    controls.enableDamping = true;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.5;
    let resumeTimer: ReturnType<typeof setTimeout> | null = null;
    controls.addEventListener("start", () => {
      controls.autoRotate = false;
      if (resumeTimer) clearTimeout(resumeTimer);
    });
    controls.addEventListener("end", () => {
      resumeTimer = setTimeout(() => (controls.autoRotate = true), 3000);
    });

    scene.add(new THREE.HemisphereLight(0x3a5a8c, 0x0a0c12, 1.1));
    const key = new THREE.DirectionalLight(0x9fc0ff, 1.2);
    key.position.set(200, 400, 150);
    scene.add(key);

    // 地面参考网格（比树大两圈）
    const grid = new THREE.GridHelper(Math.max(840, extent * 2.6), 42, 0x2a5a8c, 0x14283f);
    (grid.material as THREE.LineBasicMaterial).transparent = true;
    (grid.material as THREE.LineBasicMaterial).opacity = 0.35;
    grid.position.y = -MAX_DEPTH * LAYER_DROP - 8;
    scene.add(grid);

    // 边：一个 LineSegments
    const edgePos = new Float32Array(edges.length * 6);
    edges.forEach(([a, b], i) => {
      edgePos.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
    });
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute("position", new THREE.BufferAttribute(edgePos, 3));
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x3d6a9c, transparent: true, opacity: 0.5 });
    scene.add(new THREE.LineSegments(edgeGeo, edgeMat));

    // 节点：一个 InstancedMesh 球
    const sphereGeo = new THREE.SphereGeometry(1, 20, 14);
    const nodeMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.3,
      metalness: 0.15,
      emissive: 0xffffff,
      emissiveIntensity: 0.35,
    });
    nodeMat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= vColor.rgb;"
      );
    };
    const inst = new THREE.InstancedMesh(sphereGeo, nodeMat, nodes.length);
    const m4 = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const col = new THREE.Color();
    const scl = new THREE.Vector3();
    nodes.forEach((n, i) => {
      const t = Math.log10(1 + n.stat.total_size / 1e6) / maxLog;
      const radius = 1.4 + 5.2 * t;
      scl.setScalar(radius);
      m4.compose(n.pos, quat, scl);
      inst.setMatrixAt(i, m4);
      const hue = hues.get(n.topName) ?? 0.55;
      if (n.stat.name.startsWith("…其他")) col.setHSL(hue, 0.15, 0.35);
      else col.setHSL(hue, 0.7, 0.5 + 0.1 * Math.min(n.depth / MAX_DEPTH, 1));
      inst.setColorAt(i, col);
    });
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    scene.add(inst);

    // 顶层标签（当前聚焦树的直接子节点）
    const labelSprites: THREE.Sprite[] = [];
    for (const n of nodes) {
      if (n.depth === 1) {
        const s = makeTextSprite(n.stat.name);
        s.position.copy(n.pos).add(new THREE.Vector3(0, 9, 0));
        labelSprites.push(s);
        scene.add(s);
      }
    }

    // 悬停拾取 + 点击下钻
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let hoverId = -1;
    const onMove = (ev: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(inst)[0];
      const tip = tooltipRef.current;
      if (hit && hit.instanceId !== undefined) {
        const n = nodes[hit.instanceId];
        hoverId = hit.instanceId;
        if (tip) {
          tip.style.display = "block";
          tip.style.left = `${ev.clientX - rect.left + 14}px`;
          tip.style.top = `${ev.clientY - rect.top + 10}px`;
          tip.textContent = `${n.stat.name} — ${humanSize(n.stat.total_size)} · ${n.stat.file_count} 文件${n.pruned > 0 ? `（另有 ${n.pruned} 个子项已折叠）` : ""}${n.stat.children.length > 0 ? "｜点击下钻" : ""}`;
        }
        renderer.domElement.style.cursor = n.stat.children.length > 0 ? "pointer" : "grab";
      } else {
        hoverId = -1;
        if (tip) tip.style.display = "none";
        renderer.domElement.style.cursor = "grab";
      }
    };
    const onClick = () => {
      if (hoverId >= 0) {
        const n = nodes[hoverId];
        if (n.stat.children.length > 0 && !n.stat.name.startsWith("…其他")) {
          setPath([...path, n.stat.rel_path]);
        }
      }
    };
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("click", onClick);

    let raf = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(raf);
      if (resumeTimer) clearTimeout(resumeTimer);
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("click", onClick);
      controls.dispose();
      renderer.dispose();
      sphereGeo.dispose();
      nodeMat.dispose();
      edgeGeo.dispose();
      edgeMat.dispose();
      labelSprites.forEach((s) => {
        (s.material as THREE.SpriteMaterial).map?.dispose();
        (s.material as THREE.SpriteMaterial).dispose();
      });
      mount.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  return (
    <div>
      <div className="row" style={{ alignItems: "center" }}>
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
        立体树状图：球 = 目录，连线 = 从属关系，球大小 ∝ 体积。点击球下钻，悬停看详情；拖动旋转，停止 3 秒后缓慢自转。
        当前聚焦：{focus.rel_path}（{humanSize(focus.total_size)}）
      </div>
      <div className="city-view" style={{ position: "relative" }}>
        <div ref={mountRef} />
        <div ref={tooltipRef} className="tree3d-tooltip" style={{ display: "none" }} />
      </div>
    </div>
  );
}
