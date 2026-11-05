// @vitest-environment jsdom
import React, { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { CompartmentGrid } from "../../frontend/src/components/CompartmentGrid";
import { RoomPlan } from "../../frontend/src/components/RoomPlan";
import type { Compartment, Container, RoomSummary } from "../../frontend/src/api/client";

afterEach(cleanup);

const room: RoomSummary = { id: "bedroom", floor_id: "floor", name: "主卧", width_cm: 400,
  depth_cm: 300, height_cm: 260, wall_color: null, sort: 0, container_count: 2 };
const compartments: Compartment[] = [
  { id: "bottom-right", container_id: "wardrobe", name: "底层右侧", kind: "shelf", level_index: 1, row: 0, col: 1, sort: 3 },
  { id: "top-left", container_id: "wardrobe", name: "顶层左侧", kind: "shelf", level_index: 0, row: 0, col: 0, sort: 0 },
  { id: "bottom-left", container_id: "wardrobe", name: "底层左侧", kind: "shelf", level_index: 1, row: 0, col: 0, sort: 2 },
  { id: "top-right", container_id: "wardrobe", name: "顶层右侧", kind: "shelf", level_index: 0, row: 0, col: 1, sort: 1 },
];
const wardrobe: Container = { id: "wardrobe", room_id: room.id, name: "靠窗衣柜", preset: "wardrobe",
  x_cm: 100, z_cm: 30, y_cm: 0, rot_deg: 0, width_cm: 180, depth_cm: 58, height_cm: 220,
  color: null, config: { layers: 2, cols: 2 }, compartments, item_count: 0, version: 1 };
const desk: Container = { ...wardrobe, id: "desk", name: "书桌", preset: "desk", compartments: [],
  x_cm: 300, z_cm: 160, width_cm: 120, depth_cm: 60, height_cm: 75, rot_deg: 90 };

describe("semantic compartment selection", () => {
  // Reversing level_index or relying on transport order would put the named top shelf underneath.
  it("presents named compartments from top to bottom and left to right", () => {
    render(React.createElement(CompartmentGrid, { container: wardrobe, onSelect: () => undefined }));
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label")))
      .toEqual(["顶层左侧", "顶层右侧", "底层左侧", "底层右侧"]);
  });

  // Passing a visual index instead of the stable compartment would select the wrong storage location.
  it("selects the exact compartment represented by an empty shelf and retains selection", () => {
    function Harness() {
      const [selected, setSelected] = useState<Compartment | null>(null);
      return React.createElement(React.Fragment, null,
        React.createElement(CompartmentGrid, { container: wardrobe, selectedId: selected?.id, onSelect: setSelected }),
        React.createElement("output", { "aria-label": "当前隔层" }, selected?.id ?? "未选择"));
    }
    render(React.createElement(Harness));
    fireEvent.click(screen.getByRole("button", { name: "顶层右侧", exact: true }));
    expect(screen.getByLabelText("当前隔层").textContent).toBe("top-right");
    expect(screen.getByRole("button", { name: "顶层右侧", exact: true }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "底层右侧", exact: true }).getAttribute("aria-pressed")).toBe("false");
  });

  // Synthesizing slots for an empty response would create locations that cannot be persisted.
  it("does not invent selectable locations when the container has no compartments", () => {
    render(React.createElement(CompartmentGrid, { container: { ...wardrobe, compartments: [] }, onSelect: () => undefined }));
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toMatch(/隔层/);
  });
});

describe("room plan navigation", () => {
  // Sending room ID or display name instead of the container ID breaks the next navigation step.
  it("opens the container selected in the plan using its stable ID", () => {
    function Harness() {
      const [selected, setSelected] = useState<string | null>(null);
      return React.createElement(React.Fragment, null,
        React.createElement(RoomPlan, { room, containers: [wardrobe, desk], selectedId: selected, onSelect: setSelected }),
        React.createElement("output", { "aria-label": "当前容器" }, selected ?? "未选择"));
    }
    render(React.createElement(Harness));
    const plan = screen.getByRole("group", { name: /主卧.*平面/ });
    fireEvent.click(within(plan).getByRole("button", { name: "书桌", exact: true }));
    expect(screen.getByLabelText("当前容器").textContent).toBe("desk");
    expect(within(plan).getByRole("button", { name: "书桌", exact: true }).getAttribute("aria-pressed")).toBe("true");
  });

  // Tiny physical footprints cannot be the only way to select storage on a narrow phone.
  it("provides a labeled button list as an alternative to small geometric targets", () => {
    render(React.createElement(RoomPlan, { room, containers: [wardrobe, desk], onSelect: () => undefined }));
    const list = screen.getByRole("list", { name: /容器/ });
    expect(within(list).getByRole("button", { name: /靠窗衣柜/ }).tagName).toBe("BUTTON");
    expect(within(list).getByRole("button", { name: /书桌/ }).tagName).toBe("BUTTON");
  });
});
