import { describe, expect, it } from "vitest";
import { clampContainerCenter, footprint, snapContainerToWalls } from "../../frontend/src/three/layout";

describe("container footprint", () => {
  it("swaps width and depth at 90/270 degrees", () => {
    expect(footprint(120, 35, 0)).toEqual({ halfW: 60, halfD: 17.5 });
    expect(footprint(120, 35, 90)).toEqual({ halfW: 17.5, halfD: 60 });
    expect(footprint(120, 35, 270)).toEqual({ halfW: 17.5, halfD: 60 });
  });
});

describe("clampContainerCenter", () => {
  it("lets a rotated shelf reach the right wall", () => {
    expect(
      clampContainerCenter({ x: 999, z: 999, width: 120, depth: 35, rot: 270, roomWidth: 360, roomDepth: 460 })
    ).toEqual({ x: 342, z: 399.5 });
  });

  it("uses the rotated footprint for a bed", () => {
    expect(
      clampContainerCenter({ x: 999, z: 999, width: 180, depth: 200, rot: 270, roomWidth: 360, roomDepth: 460 })
    ).toEqual({ x: 259.5, z: 369.5 });
  });

  it("keeps an unrotated shelf away from the side wall by its own half width", () => {
    expect(
      clampContainerCenter({ x: 999, z: 20, width: 120, depth: 35, rot: 0, roomWidth: 360, roomDepth: 460 })
    ).toEqual({ x: 299.5, z: 20 });
  });
});

describe("snapContainerToWalls", () => {
  it("snaps a near-wall shelf flush", () => {
    expect(
      snapContainerToWalls({ x: 338, z: 70, width: 120, depth: 35, rot: 270, roomWidth: 360, roomDepth: 460 })
    ).toEqual({ x: 342, z: 70 });
  });

  it("moves a rotated shelf inward when it is rotated at the back wall", () => {
    expect(
      clampContainerCenter({ x: 200, z: 18, width: 120, depth: 35, rot: 270, roomWidth: 360, roomDepth: 460 })
    ).toEqual({ x: 200, z: 60.5 });
  });
});


