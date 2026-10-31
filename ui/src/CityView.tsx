import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

type DirStat = {
  rel_path: string;
  name: string;
  total_size: number;
  file_count: number;
  subdir_count: number;
  has_errors: boolean;
  children: DirStat[];
};

// ---------------------------------------------------------------------------
// 布局：slice-and-dice 树图，顶级目录为街区，楼高 ∝ log(大小)
// ---------------------------------------------------------------------------

const CITY_SIZE = 220;
const DISTRICT_GAP = 6;
const LOT_GAP = 0.7;

type Building = {
  x: number; z: number; w: number; d: number;
  size: number; name: string; depth: number; district: string; self: boolean;
};
type District = { name: string; size: number; x: number; z: number; w: number; d: number };

function layoutCity(tree: DirStat) {
  const buildings: Building[] = [];
  const districts: District[] = [];

  function layout(node: DirStat, x: number, z: number, w: number, d: number, depth: number, district: string) {
    const kids = node.children || [];
    const kidSum = kids.reduce((s, c) => s + c.total_size, 0);
    const selfSize = Math.max(0, node.total_size - kidSum);
    if (kids.length === 0) {
      if (node.total_size > 0) {
        buildings.push({ x: x + w / 2, z: z + d / 2, w, d, size: node.total_size, name: node.name, depth, district, self: false });
      }
      return;
    }
    const items = kids.map((c) => ({ node: c, size: c.total_size, self: false }));
    if (selfSize > Math.max(node.total_size * 0.02, 4 * 1024 * 1024)) {
      items.push({ node: { ...node, children: [] }, size: selfSize, self: true });
    }
    const total = items.reduce((s, i) => s + i.size, 0);
    const horizontal = w >= d;
    let offset = 0;
    for (const item of items) {
      const frac = item.size / total;
      const self = item.self;
      if (horizontal) {
        const cw = w * frac;
        if (self) {
          buildings.push({ x: x + offset + cw / 2, z: z + d / 2, w: cw, d, size: item.size, name: item.node.name, depth, district, self: true });
        } else {
          layout(item.node, x + offset, z, cw, d, depth + 1, district);
        }
        offset += cw;
      } else {
        const cd = d * frac;
        if (self) {
          buildings.push({ x: x + w / 2, z: z + offset + cd / 2, w, d: cd, size: item.size, name: item.node.name, depth, district, self: true });
        } else {
          layout(item.node, x, z + offset, w, cd, depth + 1, district);
        }
        offset += cd;
      }
    }
  }

  const top = (tree.children || []).slice().sort((a, b) => b.total_size - a.total_size);
  const total = top.reduce((s, c) => s + c.total_size, 0);
  if (total === 0) return { buildings, districts };

  // 行打包：按面积平方根换行
  const rows: { d: DirStat; side: number }[][] = [];
  let row: { d: DirStat; side: number }[] = [];
  let rowWidth = 0;
  for (const d of top) {
    const side = Math.sqrt((d.total_size / total) * CITY_SIZE * CITY_SIZE);
    if (rowWidth + side > CITY_SIZE && row.length > 0) {
      rows.push(row); row = []; rowWidth = 0;
    }
    row.push({ d, side });
    rowWidth += side;
  }
  if (row.length > 0) rows.push(row);

  let z = -CITY_SIZE / 2;
  for (const r of rows) {
    const rowArea = r.reduce((s, { d }) => s + (d.total_size / total) * CITY_SIZE * CITY_SIZE, 0);
    const rh = rowArea / CITY_SIZE;
    let cx = -CITY_SIZE / 2;
    for (const { d } of r) {
      const w = ((d.total_size / total) * CITY_SIZE * CITY_SIZE) / rh;
      const ix = cx + DISTRICT_GAP / 2, iz = z + DISTRICT_GAP / 2;
      const iw = Math.max(w - DISTRICT_GAP, 4), ih = Math.max(rh - DISTRICT_GAP, 4);
      districts.push({ name: d.name, size: d.total_size, x: ix, z: iz, w: iw, d: ih });
      layout(d, ix, iz, iw, ih, 1, d.name);
      cx += w;
    }
    z += rh;
  }
  return { buildings, districts };
}

function buildingHeight(size: number) {
  return Math.max(0.6, 28 * Math.log10(1 + size / 1e6));
}

function humanSize(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return i === 0 ? `${v} ${units[i]}` : `${v.toFixed(1)} ${units[i]}`;
}

function makeLabelSprite(title: string, subtitle: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 512; canvas.height = 160;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "rgba(8, 14, 24, 0.72)";
  ctx.beginPath();
  ctx.roundRect(6, 6, 500, 116, 18);
  ctx.fill();
  ctx.strokeStyle = "rgba(90, 200, 255, 0.8)";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = "#eaf6ff";
  ctx.font = "bold 56px 'Microsoft YaHei', 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(title, 256, 62);
  ctx.fillStyle = "#7fd4ff";
  ctx.font = "40px 'Segoe UI', sans-serif";
  ctx.fillText(subtitle, 256, 108);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(24, 7.5, 1);
  return sprite;
}

export default function CityView({ tree }: { tree: DirStat }) {
  const mountRef = useRef<HTMLDivElement>(null);

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
    scene.fog = new THREE.Fog(0x0b0e14, 400, 1400);

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.5, 4000);
    camera.position.set(200, 165, 245);
    camera.lookAt(0, 12, 0);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 12, 0);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2.05;
    controls.maxDistance = 1200;

    // 夜空氛围：半球底光 + 一盏月光
    scene.add(new THREE.HemisphereLight(0x3a5a8c, 0x0a0c12, 0.9));
    const moon = new THREE.DirectionalLight(0x8fb4ff, 0.7);
    moon.position.set(-180, 260, -120);
    scene.add(moon);

    // 地面
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(420, 72),
      new THREE.MeshStandardMaterial({ color: 0x0a0e14, roughness: 0.9 })
    );
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
    const grid = new THREE.GridHelper(840, 84, 0x2a5a8c, 0x14283f);
    (grid.material as THREE.LineBasicMaterial).transparent = true;
    (grid.material as THREE.LineBasicMaterial).opacity = 0.55;
    grid.position.y = 0.08;
    scene.add(grid);

    // 楼群
    const { buildings, districts } = layoutCity(tree);
    const districtHues = new Map<string, number>();
    districts.forEach((d, i) => districtHues.set(d.name, (i * 0.6180339887) % 1));

    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    boxGeo.translate(0, 0.5, 0);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.35, metalness: 0.1,
      emissive: 0xffffff, emissiveIntensity: 0.42,
    });
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= vColor.rgb;"
      );
    };
    const mesh = new THREE.InstancedMesh(boxGeo, mat, buildings.length);
    const m4 = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const col = new THREE.Color();
    buildings.forEach((b, i) => {
      pos.set(b.x, 0, b.z);
      scl.set(Math.max(0.8, b.w - LOT_GAP), buildingHeight(b.size), Math.max(0.8, b.d - LOT_GAP));
      m4.compose(pos, quat, scl);
      mesh.setMatrixAt(i, m4);
      const hue = districtHues.get(b.district) ?? 0.5;
      if (b.self) col.setHSL(hue, 0.25, 0.32);
      else col.setHSL(hue, 0.7, 0.48 + 0.12 * ((b.depth % 3) / 2));
      mesh.setColorAt(i, col);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    scene.add(mesh);

    // 街区标签（前 8 大）
    const labels: THREE.Sprite[] = [];
    districts.slice(0, 8).forEach((d) => {
      const tallest = Math.max(4, ...buildings.filter((b) => b.district === d.name).map((b) => buildingHeight(b.size)));
      const sprite = makeLabelSprite(d.name, humanSize(d.size));
      sprite.position.set(d.x + d.w / 2, tallest + 9, d.z + d.d / 2);
      labels.push(sprite);
      scene.add(sprite);
    });

    let raf = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(raf);
      controls.dispose();
      renderer.dispose();
      boxGeo.dispose();
      mat.dispose();
      labels.forEach((s) => {
        (s.material as THREE.SpriteMaterial).map?.dispose();
        (s.material as THREE.SpriteMaterial).dispose();
      });
      mount.removeChild(renderer.domElement);
    };
  }, [tree]);

  return <div ref={mountRef} className="city-view" />;
}
