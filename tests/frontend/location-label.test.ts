// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WorkspacePage } from "../../frontend/src/pages/WorkspacePage";
import { useWorkspace } from "../../frontend/src/store/useWorkspace";

const me = { user: { id: "u", username: "owner", display_name: "家人", role: "owner" as const }, household: { id: "h", name: "我家" } };
const room = { id: "r", floor_id: "f", name: "主卧", width_cm: 460, depth_cm: 360, height_cm: 260, wall_color: null, sort: 0, container_count: 1, version: 1 };
const cabinet = { id: "box", room_id: "r", name: "衣柜", preset: "wardrobe", x_cm: 150, z_cm: 80, y_cm: 0, rot_deg: 0, width_cm: 180, depth_cm: 58, height_cm: 220, color: null, config: { layers: 1, cols: 1 }, item_count: 0, version: 1,
  compartments: [{ id: "cp", container_id: "box", name: "证件区", custom_name: "证件区", default_name: "顶层", kind: "shelf", level_index: 0, row: 0, col: 0, sort: 0 }] };
beforeEach(() => {
  useWorkspace.getState().reset();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("fetch", async (input: string) => {
    const path = new URL(input, "http://localhost").pathname;
    const body = path.endsWith("/bootstrap") ? { ...me, floors: [{ id: "f", name: "1层", level: 1, rooms: [room] }] } : { room, containers: [cabinet] };
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  });
});
afterEach(() => { cleanup(); useWorkspace.getState().reset(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function show() {
  render(createElement(WorkspacePage, { me, onLogout: async () => {}, onInventory() {}, target: { roomId: "r", containerId: "box", compartmentId: "cp" } }));
  const cabinetDialog = within(await screen.findByRole("dialog", { name: "衣柜" }));
  fireEvent.click(cabinetDialog.getByRole("button", { name: "位置标签" }));
  return within(await screen.findByRole("dialog", { name: "位置标签" }));
}

describe("workspace location labels", () => {
  it("generates the selected shelf link and permits switching to the whole container", async () => {
    const dialog = await show();
    const link = dialog.getByLabelText("位置链接") as HTMLInputElement;
    expect(new URL(link.value).pathname).toBe("/location/box");
    expect(new URL(link.value).searchParams.get("compartment")).toBe("cp");
    expect(dialog.getAllByRole("option").filter(option => option.textContent?.includes("入口"))).toHaveLength(1);
    await dialog.findByRole("img", { name: "位置二维码" });
    const download = dialog.getByRole("link", { name: "下载标签（SVG）" });
    expect(download.getAttribute("href")).toMatch(/^data:image\/svg\+xml/);
    expect(download.getAttribute("download")).toMatch(/\.svg$/);
    fireEvent.change(dialog.getByLabelText("标签位置"), { target: { value: "" } });
    await waitFor(() => expect(new URL(link.value).search).toBe(""));
    await dialog.findByRole("img", { name: "位置二维码" });
  });

  it("offers manual copy after a denied clipboard action", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } });
    const dialog = await show();
    fireEvent.click(dialog.getByRole("button", { name: "复制链接" }));
    await dialog.findByText("复制未成功，请长按或选中链接复制。");
    expect((dialog.getByLabelText("位置链接") as HTMLInputElement).value).toContain("/location/box");
  });

  it("does not mark a newer target as copied when an old clipboard action finishes", async () => {
    let finishCopy: (() => void) | undefined;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => new Promise<void>(resolve => { finishCopy = resolve; }) } });
    const dialog = await show();
    fireEvent.click(dialog.getByRole("button", { name: "复制链接" }));
    fireEvent.change(dialog.getByLabelText("标签位置"), { target: { value: "" } });
    await act(async () => { finishCopy?.(); });
    expect(dialog.queryByText("链接已复制")).toBeNull();
    expect(new URL((dialog.getByLabelText("位置链接") as HTMLInputElement).value).search).toBe("");
  });
});
