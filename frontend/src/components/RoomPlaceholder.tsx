const S = 54;
const OX = 285;
const OY = 322;

function point(x: number, y: number, z: number): [number, number] {
  return [OX + (x - z) * 0.866 * S, OY + (x + z) * 0.5 * S - y * S];
}

function polygon(points: Array<[number, number, number]>): string {
  return points
    .map(([x, y, z]) => point(x, y, z).join(","))
    .join(" ");
}

function Cuboid({
  x,
  z,
  w,
  d,
  h,
  top,
  front,
  side,
  stroke = "#b99a76",
}: {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  top: string;
  front: string;
  side: string;
  stroke?: string;
}) {
  return (
    <g stroke={stroke} strokeWidth="1.2" strokeLinejoin="round">
      <polygon points={polygon([[x, h, z], [x + w, h, z], [x + w, h, z + d], [x, h, z + d]])} fill={top} />
      <polygon points={polygon([[x, 0, z + d], [x + w, 0, z + d], [x + w, h, z + d], [x, h, z + d]])} fill={front} />
      <polygon points={polygon([[x + w, 0, z], [x + w, 0, z + d], [x + w, h, z + d], [x + w, h, z]])} fill={side} />
    </g>
  );
}

export function RoomPlaceholder() {
  return (
    <div className="room-placeholder">
      <svg viewBox="0 0 620 420" role="img" aria-label="3D 房间占位示意">
        <polygon
          points={polygon([[0, 0, 0], [4.6, 0, 0], [4.6, 0, 3.6], [0, 0, 3.6]])}
          fill="#ddc9ae"
          stroke="#c2a27f"
          strokeWidth="1.4"
        />
        <polygon
          points={polygon([[0, 0, 0], [4.6, 0, 0], [4.6, 2.6, 0], [0, 2.6, 0]])}
          fill="#efe5d6"
          stroke="#d6c5b0"
          strokeWidth="1.4"
        />
        <polygon
          points={polygon([[0, 0, 0], [0, 0, 3.6], [0, 2.6, 3.6], [0, 2.6, 0]])}
          fill="#e7dbc9"
          stroke="#d3c1aa"
          strokeWidth="1.4"
        />
        <polygon
          points={polygon([[2.1, 1.0, 0], [3.1, 1.0, 0], [3.1, 2.2, 0], [2.1, 2.2, 0]])}
          fill="#cfe3ea"
          stroke="#fbf7ef"
          strokeWidth="3"
        />
        <line
          x1={point(2.6, 1.0, 0)[0]}
          y1={point(2.6, 1.0, 0)[1]}
          x2={point(2.6, 2.2, 0)[0]}
          y2={point(2.6, 2.2, 0)[1]}
          stroke="#fbf7ef"
          strokeWidth="2"
        />
        <Cuboid x={0.2} z={0.05} w={1.8} d={0.6} h={2.2} top="#d8bd99" front="#c9a87e" side="#bd986c" />
        <line
          x1={point(1.1, 0, 0.66)[0]}
          y1={point(1.1, 0, 0.66)[1]}
          x2={point(1.1, 2.2, 0.66)[0]}
          y2={point(1.1, 2.2, 0.66)[1]}
          stroke="#a9875f"
          strokeWidth="1"
        />
        <Cuboid x={3.45} z={0.05} w={0.95} d={0.5} h={0.8} top="#c6d2c1" front="#b4c2af" side="#a3b29e" stroke="#8f9f8a" />
        <Cuboid x={2.55} z={2.65} w={0.62} d={0.44} h={0.38} top="#eeddc0" front="#e2cfae" side="#d2bd98" />
        <Cuboid x={3.2} z={2.55} w={0.5} d={0.4} h={0.32} top="#d9c8ae" front="#cbb99e" side="#bda98c" />
      </svg>
      <div className="room-placeholder-label">
        <span className="dot" />
        3D 房间 · M1 将在这里出现
      </div>
    </div>
  );
}
