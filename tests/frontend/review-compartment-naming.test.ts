// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WorkspacePage } from "../../frontend/src/pages/WorkspacePage";
import { useWorkspace } from "../../frontend/src/store/useWorkspace";
import type { Container, RoomSummary } from "../../frontend/src/api/client";

const me = { user: { id: "u", username: "owner", display_name: "家人", role: "owner" as const }, household: { id: "h", name: "我家" } };
const room = (id: string): RoomSummary => ({ id, floor_id: "f", name: id, width_cm: 460, depth_cm: 360, height_cm: 260, wall_color: null, sort: 0, container_count: id === "a" ? 1 : 0 });
const original: Container = {
  id: "cabinet", room_id: "a", name: "衣柜", preset: "wardrobe", x_cm: 150, z_cm: 80, y_cm: 0, rot_deg: 0,
  width_cm: 180, depth_cm: 58, height_cm: 220, color: null, config: { layers: 2, cols: 1 }, item_count: 0, version: 1,
  compartments: ["顶层", "下层"].map((name, i) => ({ id: `cp${i}`, container_id: "cabinet", name, custom_name: null, default_name: name, kind: "shelf" as const, level_index: i, row: 0, col: 0, sort: i })),
};
type Pending = { path: string; init: RequestInit; respond: (body: unknown, status?: number) => void };
let cabinet: Container;
let requests: Pending[];
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function take(path: string) {
  const index = requests.findIndex(request => request.path.endsWith(path));
  if (index < 0) throw new Error(`No pending request for ${path}`);
  return requests.splice(index, 1)[0];
}
beforeEach(() => {
  useWorkspace.getState().reset();
  cabinet = structuredClone(original);
  requests = [];
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("fetch", (input: string, init: RequestInit = {}) => {
    const path = new URL(input, "http://localhost").pathname;
    if (path.endsWith("/bootstrap")) return Promise.resolve(reply({ ...me, floors: [{ id: "f", name: "1层", level: 1, rooms: [room("a"), room("b")] }] }));
    const roomMatch = /\/rooms\/(a|b)$/.exec(path);
    if (roomMatch) return Promise.resolve(reply({ room: room(roomMatch[1]), containers: cabinet.room_id === roomMatch[1] ? [cabinet] : [] }));
    return new Promise<Response>(resolve => requests.push({ path, init, respond: (body, status) => resolve(reply(body, status)) }));
  });
});
afterEach(() => { cleanup(); useWorkspace.getState().reset(); vi.unstubAllGlobals(); });

describe("independent compartment naming regression review", () => {
  // Re-entering a pending editor is possible through the live shelf grid. Its old
  // request must not discard text entered in the newly mounted editor.
  it("keeps a newer draft after switching away and back while the previous name is saving", async () => {
    render(createElement(WorkspacePage, { me, onLogout: async () => {}, onInventory() {}, target: { roomId: "a", containerId: "cabinet", compartmentId: "cp0" } }));
    const dialog = within(await screen.findByRole("dialog", { name: "衣柜" }));
    fireEvent.change(dialog.getByLabelText("隔层名称"), { target: { value: "证件抽屉" } });
    fireEvent.click(dialog.getByRole("button", { name: "保存名称" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    const first = take("/compartments/cp0");
    fireEvent.click(dialog.getByRole("button", { name: "下层", exact: true }));
    fireEvent.click(dialog.getByRole("button", { name: "顶层", exact: true }));
    fireEvent.change(dialog.getByLabelText("隔层名称"), { target: { value: "证件和票据" } });
    cabinet = { ...cabinet, version: 2, compartments: cabinet.compartments.map(cp => cp.id === "cp0" ? { ...cp, name: "证件抽屉", custom_name: "证件抽屉" } : cp) };
    await act(async () => { first.respond({ container: cabinet }); await flush(); });
    expect((dialog.getByLabelText("隔层名称") as HTMLInputElement).value).toBe("证件和票据");
    fireEvent.click(dialog.getByRole("button", { name: "保存名称" }));
    const second = take("/compartments/cp0");
    expect(JSON.parse(String(second.init.body))).toEqual({ expected_container_version: 2, custom_name: "证件和票据" });
    cabinet = { ...cabinet, version: 3, compartments: cabinet.compartments.map(cp => cp.id === "cp0" ? { ...cp, name: "证件和票据", custom_name: "证件和票据" } : cp) };
    await act(async () => { second.respond({ container: cabinet }); await flush(); });
    fireEvent.click(dialog.getByRole("button", { name: "恢复自动名称" }));
    const reset = take("/compartments/cp0");
    cabinet = { ...cabinet, version: 4, compartments: cabinet.compartments.map(cp => cp.id === "cp0" ? { ...cp, name: "顶层", custom_name: null } : cp) };
    await act(async () => { reset.respond({ container: cabinet }); await flush(); });
    expect((dialog.getByLabelText("隔层名称") as HTMLInputElement).value).toBe("顶层");
  });

  // The retry still belongs to the container after its queued relocation. Users
  // can reach this state by closing the dialog and selecting the target room.
  it("retries a failed queued name from the container's new room after relocation", async () => {
    await useWorkspace.getState().selectRoom("a");
    const moving = useWorkspace.getState().patchContainer("cabinet", { room_id: "b" });
    const naming = useWorkspace.getState().renameCompartment("cabinet", "cp0", "证件抽屉");
    const selecting = useWorkspace.getState().selectRoom("b");
    cabinet = { ...cabinet, room_id: "b", version: 2 };
    take("/containers/cabinet").respond({ container: cabinet });
    await moving; await flush();
    take("/compartments/cp0").respond({ error: { code: "offline", message: "名称保存失败" } }, 503);
    expect(await naming).toBe(false);
    await selecting;
    expect(useWorkspace.getState().activeRoomId).toBe("b");
    const retry = useWorkspace.getState().retryLastMutation();
    await flush();
    const pendingRetry = requests.find(request => request.path.endsWith("/compartments/cp0"));
    expect(pendingRetry, "the visible retry action should resubmit the name in the new room").toBeDefined();
    cabinet = { ...cabinet, version: 3, compartments: cabinet.compartments.map(cp => cp.id === "cp0" ? { ...cp, name: "证件抽屉", custom_name: "证件抽屉" } : cp) };
    pendingRetry?.respond({ container: cabinet });
    expect(await retry).toBe(true);
  });

  it("does not resurrect a removed shelf when a queued naming request fails", async () => {
    await useWorkspace.getState().selectRoom("a");
    const resizing = useWorkspace.getState().patchContainer("cabinet", { config: { layers: 1, cols: 1 } });
    const naming = useWorkspace.getState().renameCompartment("cabinet", "cp1", "过季物品");
    cabinet = { ...cabinet, version: 2, config: { layers: 1, cols: 1 }, compartments: [cabinet.compartments[0]] };
    take("/containers/cabinet").respond({ container: cabinet });
    await resizing; await flush();
    take("/compartments/cp1").respond({ error: { code: "compartment_not_found", message: "隔层不存在" } }, 404);
    expect(await naming).toBe(false);
    expect(useWorkspace.getState().room?.containers[0].compartments.map(cp => cp.id)).toEqual(["cp0"]);
    expect(useWorkspace.getState().saveStatus).toBe("error");
  });
});
