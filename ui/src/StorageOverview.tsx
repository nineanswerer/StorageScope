type DirStat = {
  rel_path: string;
  name: string;
  total_size: number;
  children: DirStat[];
};

type Segment = {
  key: string;
  name: string;
  size: number;
  color: string;
};

const COLORS = ["#7189a5", "#7c8f84", "#a08b72", "#7d7f96", "#8a736e"];

function humanSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${value} ${units[unit]}` : `${value.toFixed(1)} ${units[unit]}`;
}

/** 用真实目录数据构成比例条与图例；颜色只承担区分目录的职责。 */
export default function StorageOverview({ tree }: { tree: DirStat }) {
  const sorted = tree.children.slice().sort((a, b) => b.total_size - a.total_size);
  const visible = sorted.slice(0, COLORS.length);
  const segments: Segment[] = visible.map((dir, index) => ({
    key: dir.rel_path,
    name: dir.name,
    size: dir.total_size,
    color: COLORS[index],
  }));

  const rest = sorted.slice(COLORS.length).reduce((sum, dir) => sum + dir.total_size, 0);
  if (rest > 0) segments.push({ key: "other-dirs", name: "其他目录", size: rest, color: "#454c54" });

  const childBytes = sorted.reduce((sum, dir) => sum + dir.total_size, 0);
  const directBytes = Math.max(0, tree.total_size - childBytes);
  if (directBytes > 0) segments.push({ key: "root-files", name: "根目录中的文件", size: directBytes, color: "#626a73" });

  const total = Math.max(tree.total_size, 1);
  const description = segments.map((s) => `${s.name} ${humanSize(s.size)}`).join("，");

  return (
    <section className="storage-overview" aria-labelledby="storage-overview-title">
      <div className="overview-heading">
        <h2 id="storage-overview-title">空间分布</h2>
        <span>{sorted.length} 个一级目录</span>
      </div>
      <div className="storage-bar" role="img" aria-label={`${tree.name}：${description}`}>
        {segments.map((segment) => (
          <span
            key={segment.key}
            className="storage-segment"
            style={{ width: `${(segment.size / total) * 100}%`, backgroundColor: segment.color }}
            title={`${segment.name} · ${humanSize(segment.size)}`}
          />
        ))}
      </div>
      <div className="overview-legend">
        {segments.map((segment) => (
          <div className="overview-item" key={segment.key}>
            <span className="overview-swatch" style={{ backgroundColor: segment.color }} aria-hidden />
            <span className="overview-name" title={segment.name}>{segment.name}</span>
            <span className="overview-percent">{((segment.size / total) * 100).toFixed(1)}%</span>
            <span className="overview-size">{humanSize(segment.size)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
