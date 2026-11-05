export type Footprint = { halfW: number; halfD: number };

export function footprint(width: number, depth: number, rotDeg: number): Footprint {
  const rot = ((rotDeg % 360) + 360) % 360;
  return rot % 180 === 90 ? { halfW: depth / 2, halfD: width / 2 } : { halfW: width / 2, halfD: depth / 2 };
}

export function clampContainerCenter(input: {
  x: number;
  z: number;
  width: number;
  depth: number;
  rot: number;
  roomWidth: number;
  roomDepth: number;
  margin?: number;
}): { x: number; z: number } {
  const margin = input.margin ?? 0.5;
  const { halfW, halfD } = footprint(input.width, input.depth, input.rot);
  const minX = halfW + margin;
  const maxX = input.roomWidth - halfW - margin;
  const minZ = halfD + margin;
  const maxZ = input.roomDepth - halfD - margin;
  return {
    x: minX > maxX ? input.roomWidth / 2 : Math.min(Math.max(input.x, minX), maxX),
    z: minZ > maxZ ? input.roomDepth / 2 : Math.min(Math.max(input.z, minZ), maxZ),
  };
}

export function snapContainerToWalls(input: {
  x: number;
  z: number;
  width: number;
  depth: number;
  rot: number;
  roomWidth: number;
  roomDepth: number;
  margin?: number;
  threshold?: number;
}): { x: number; z: number } {
  const margin = input.margin ?? 0.5;
  const threshold = input.threshold ?? 7;
  const clamped = clampContainerCenter({ ...input, margin });
  const { halfW, halfD } = footprint(input.width, input.depth, input.rot);
  const minX = halfW + margin;
  const maxX = input.roomWidth - halfW - margin;
  const minZ = halfD + margin;
  const maxZ = input.roomDepth - halfD - margin;
  let { x, z } = clamped;
  if (Math.abs(x - minX) <= threshold) x = minX;
  else if (Math.abs(x - maxX) <= threshold) x = maxX;
  if (Math.abs(z - minZ) <= threshold) z = minZ;
  else if (Math.abs(z - maxZ) <= threshold) z = maxZ;
  return { x, z };
}
