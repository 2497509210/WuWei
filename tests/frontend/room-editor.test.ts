// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WorkspacePage } from "../../frontend/src/pages/WorkspacePage";
import { useWorkspace } from "../../frontend/src/store/useWorkspace";
import type { RoomSummary } from "../../frontend/src/api/client";

const me = { user: { id: "u", username: "owner", display_name: "家人", role: "owner" as "owner" | "member" }, household: { id: "h", name: "我家" } };
let room: RoomSummary;
let mobile: boolean;
let failure: "offline" | "conflict" | null;
let writes: Record<string, unknown>[];
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
beforeEach(() => {
  room = { id: "r", floor_id: "f", name: "主卧", width_cm: 460, depth_cm: 360, height_cm: 260, wall_color: null, sort: 0, container_count: 0, version: 1 };
  mobile = false; failure = null; writes = [];
  useWorkspace.getState().reset();
  vi.stubGlobal("matchMedia", () => ({ matches: mobile, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const path = new URL(input, "http://localhost").pathname;
    if (path.endsWith("/bootstrap")) return reply({ ...me, floors: [{ id: "f", name: "1层", level: 1, rooms: [room] }] });
    if (path.endsWith("/rooms/r") && init.method === "PATCH") {
      const patch = JSON.parse(String(init.body)); writes.push(patch);
      if (failure === "offline") { failure = null; return reply({ error: { code: "offline", message: "连接失败，请重试" } }, 503); }
      if (failure === "conflict") {
        failure = null; room = { ...room, name: "另一个设备的名称", width_cm: 520, version: 2 };
        return reply({ error: { code: "room_version_conflict", message: "房间已被更新", current_room: room } }, 409);
      }
      if (patch.expected_version !== room.version) return reply({ error: { code: "room_version_conflict", message: "房间已被更新", current_room: room } }, 409);
      const { expected_version, ...fields } = patch;
      room = { ...room, ...fields, version: room.version + 1 };
      return reply({ room });
    }
    if (path.endsWith("/rooms/r")) return reply({ room, containers: [] });
    throw new Error(`Unexpected ${init.method ?? "GET"} ${path}`);
  });
});
afterEach(() => { cleanup(); useWorkspace.getState().reset(); vi.unstubAllGlobals(); });
async function openEditor() {
  render(createElement(WorkspacePage, { me, onLogout: async () => {}, onInventory() {} }));
  if (mobile) fireEvent.click(await screen.findByRole("button", { name: "房间设置", exact: true }));
  fireEvent.click(await screen.findByRole("button", { name: "编辑房间", exact: true }));
  return within(await screen.findByRole("dialog", { name: "编辑房间", exact: true }));
}

describe("room editor", () => {
  it("saves trimmed name and dimensions from the desktop entry and updates room navigation", async () => {
    const dialog = await openEditor();
    fireEvent.change(dialog.getByLabelText("房间名称"), { target: { value: "  工作间  " } });
    fireEvent.change(dialog.getByLabelText("宽（厘米）"), { target: { value: "500" } });
    fireEvent.click(dialog.getByRole("button", { name: "保存房间" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑房间" })).toBeNull());
    expect(room.name).toBe("工作间"); expect(room.width_cm).toBe(500);
    expect(writes[0].expected_version).toBe(1);
    expect(screen.getByRole("button", { name: /工作间/ })).toBeTruthy();
  });

  it("keeps the draft on failure and saves it on explicit retry", async () => {
    const dialog = await openEditor(); failure = "offline";
    fireEvent.change(dialog.getByLabelText("房间名称"), { target: { value: "客房" } });
    fireEvent.click(dialog.getByRole("button", { name: "保存房间" }));
    await dialog.findByText("连接失败，请重试", { exact: false });
    expect((dialog.getByLabelText("房间名称") as HTMLInputElement).value).toBe("客房");
    expect(room.name).toBe("主卧");
    fireEvent.click(dialog.getByRole("button", { name: "保存房间" }));
    await waitFor(() => expect(room.name).toBe("客房"));
  });

  it("requires explicit reload after conflict before accepting another edit", async () => {
    const dialog = await openEditor(); failure = "conflict";
    fireEvent.change(dialog.getByLabelText("房间名称"), { target: { value: "我的旧草稿" } });
    fireEvent.click(dialog.getByRole("button", { name: "保存房间" }));
    await dialog.findByText("房间已被更新", { exact: false });
    expect((dialog.getByLabelText("房间名称") as HTMLInputElement).value).toBe("我的旧草稿");
    expect((dialog.getByRole("button", { name: "保存房间" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(dialog.getByRole("button", { name: "加载最新房间" }));
    await waitFor(() => expect((dialog.getByLabelText("房间名称") as HTMLInputElement).value).toBe("另一个设备的名称"));
    fireEvent.change(dialog.getByLabelText("房间名称"), { target: { value: "确认后修改" } });
    fireEvent.click(dialog.getByRole("button", { name: "保存房间" }));
    await waitFor(() => expect(room.name).toBe("确认后修改"));
    expect(writes[1].expected_version).toBe(2);
  });

  it("opens the same editor from mobile room settings", async () => {
    mobile = true;
    const dialog = await openEditor();
    expect((dialog.getByLabelText("高（厘米）") as HTMLInputElement).value).toBe("260");
    fireEvent.change(dialog.getByLabelText("深（厘米）"), { target: { value: "380" } });
    fireEvent.click(dialog.getByRole("button", { name: "保存房间" }));
    await waitFor(() => expect(room.depth_cm).toBe(380));
  });

  it.each([false, true])("hides room mutation controls for a member (mobile=%s)", async mobileMode => {
    mobile = mobileMode;
    render(createElement(WorkspacePage, { me: { ...me, user: { ...me.user, role: "member" } }, onLogout: async () => {}, onInventory() {} }));
    if (mobile) fireEvent.click(await screen.findByRole("button", { name: "房间设置", exact: true }));
    else await screen.findByRole("heading", { name: "主卧", exact: true });
    expect(screen.queryByRole("button", { name: "编辑房间", exact: true })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除房间", exact: true })).toBeNull();
    expect(screen.queryByRole("button", { name: "＋ 房间", exact: true })).toBeNull();
  });
});
