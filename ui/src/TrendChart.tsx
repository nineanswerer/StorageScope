// 快照趋势图：总量随时间的折线 + 面积图，段间标注净增减。
// 纯 SVG，无依赖。数据来自快照库（recorded_at 为 Unix 秒）。

type Point = { id: number; recorded_at: number; total_bytes: number; file_count: number };

function humanSize(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return i === 0 ? `${Math.round(v)} ${units[i]}` : `${v.toFixed(1)} ${units[i]}`;
}
function fmtTime(sec: number) {
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function TrendChart({ snapshots }: { snapshots: Point[] }) {
  const pts = snapshots.slice().sort((a, b) => a.recorded_at - b.recorded_at);
  if (pts.length === 0) return null;
  if (pts.length === 1) {
    return <div className="summary">已记录 1 个有效快照，再保存一次即可看到占用变化。</div>;
  }

  const W = 1000, H = 250, PL = 70, PR = 70, PT = 26, PB = 42;
  const t0 = pts[0].recorded_at, t1 = pts[pts.length - 1].recorded_at;
  const maxB = Math.max(1, ...pts.map((p) => p.total_bytes)) * 1.08;
  const labelEvery = Math.ceil(pts.length / 6);
  const x = (t: number) => PL + (t1 > t0 ? ((t - t0) / (t1 - t0)) * (W - PL - PR) : (W - PL - PR) / 2);
  const y = (b: number) => PT + (1 - b / maxB) * (H - PT - PB);

  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.recorded_at)},${y(p.total_bytes)}`).join(" ");
  const area = `${line} L${x(t1)},${y(0)} L${x(t0)},${y(0)} Z`;
  const net = pts[pts.length - 1].total_bytes - pts[0].total_bytes;

  return (
    <div>
      <div className="summary">
        {fmtTime(t0)} → {fmtTime(t1)} · 净变化{" "}
        <b style={{ color: net > 0 ? "#c79a62" : net < 0 ? "#8eb59d" : "#a6adb5" }}>
          {net > 0 ? "+" : net < 0 ? "−" : ""}{humanSize(Math.abs(net))}
        </b>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="hier-svg" role="img" aria-label={`快照占用趋势，净变化 ${net} 字节`}>
        {/* Y 轴网格与刻度 */}
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PL} x2={W - PR} y1={y(maxB * f)} y2={y(maxB * f)} stroke="#30353b" />
            <text x={PL - 8} y={y(maxB * f) + 4} textAnchor="end" fill="#a6adb5" fontSize="12">
              {humanSize(maxB * f)}
            </text>
          </g>
        ))}
        <path d={area} fill="rgba(142, 169, 196, 0.10)" />
        <path d={line} fill="none" stroke="#8ea9c4" strokeWidth="2" />
        {/* 少量快照时标出相邻净增减，避免密集标签互相遮挡。 */}
        {pts.length <= 8 && pts.slice(1).map((p, i) => {
          const prev = pts[i];
          const d = p.total_bytes - prev.total_bytes;
          const mx = (x(prev.recorded_at) + x(p.recorded_at)) / 2;
          const my = (y(prev.total_bytes) + y(p.total_bytes)) / 2 - 10;
          return (
            <text key={p.id} x={mx} y={my} textAnchor="middle" fontSize="12" fill={d >= 0 ? "#c79a62" : "#8eb59d"}>
              {d >= 0 ? "+" : "−"}{humanSize(Math.abs(d))}
            </text>
          );
        })}
        {/* 数据点保留全部快照，时间刻度按密度抽稀。 */}
        {pts.map((p, i) => (
          <g key={p.id}>
            <circle cx={x(p.recorded_at)} cy={y(p.total_bytes)} r={4.5} fill="#8ea9c4" stroke="#121315" strokeWidth="1.5">
              <title>{`快照 #${p.id} · ${fmtTime(p.recorded_at)}\n${humanSize(p.total_bytes)} · ${p.file_count} 文件`}</title>
            </circle>
            {(i % labelEvery === 0 || i === pts.length - 1) && (
              <>
                <text x={x(p.recorded_at)} y={H - 22} textAnchor="middle" fill="#a6adb5" fontSize="11">
                  {fmtTime(p.recorded_at)}
                </text>
                <text x={x(p.recorded_at)} y={H - 8} textAnchor="middle" fill="#808993" fontSize="10">
                  #{p.id}
                </text>
              </>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}
