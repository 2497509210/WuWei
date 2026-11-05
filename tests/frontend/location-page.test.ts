// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LocationPage } from "../../frontend/src/pages/LocationPage";
import type { Container, RoomSummary } from "../../frontend/src/api/client";

const room: RoomSummary = { id: "new-room", floor_id: "f", name: "搬入后的书房", width_cm: 460, depth_cm: 360, height_cm: 260, version: 1, wall_color: null, sort: 0, container_count: 1 };
const cabinet: Container = { id: "box", room_id: room.id, name: "白色衣柜", preset: "wardrobe", x_cm: 150, z_cm: 80, y_cm: 0, rot_deg: 0, width_cm: 180, depth_cm: 58, height_cm: 220, color: null, config: { layers: 2, cols: 1 }, item_count: 2, version: 2,
  compartments: ["证件", "备用物品"].map((name, i) => ({ id: `cp${i}`, container_id: "box", name, custom_name: name, default_name: `第${i + 1}层`, kind: "shelf", level_index: i, row: 0, col: 0, sort: i })) };
type Handler = (url: URL, init: RequestInit) => Promise<Response> | Response;
let handler: Handler;
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
beforeEach(() => {
  handler = () => response({ room, container: cabinet });
  vi.stubGlobal("fetch", (input: string, init: RequestInit = {}) => Promise.resolve(handler(new URL(input, "http://localhost"), init)));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function show(compartmentId?: string) {
  const actions: string[] = [];
  const view = render(createElement(LocationPage, { containerId: "box", compartmentId,
    onViewItems: id => actions.push(`view:${id}`), onRegister: id => actions.push(`register:${id}`), onCapture: id => actions.push(`capture:${id}`), onBack: () => actions.push("back") }));
  return { ...view, actions };
}

describe("location entry", () => {
  it("uses the current room returned by the stable container endpoint and acts only on the selected shelf", async () => {
    const { actions } = show("cp0");
    await screen.findByText(/搬入后的书房/);
    expect(screen.getByRole("button", { name: "证件", exact: true }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "查看隔层物品" }));
    fireEvent.click(screen.getByRole("button", { name: "登记到此隔层" }));
    fireEvent.click(screen.getByRole("button", { name: "拍照登记到此隔层" }));
    expect(actions).toEqual(["view:cp0", "register:cp0", "capture:cp0"]);
  });

  it("requires a shelf choice for a whole-container link", async () => {
    const { actions } = show();
    await screen.findByText(/搬入后的书房/);
    expect((screen.getByRole("button", { name: "登记到此隔层" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "备用物品", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "登记到此隔层" }));
    expect(actions).toEqual(["register:cp1"]);
  });

  it.each(["deleted", "", "from-another-container"])("does not ignore invalid requested compartment %s", async compartmentId => {
    show(compartmentId);
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "登记到此隔层" })).toBeNull();
    expect(screen.queryByRole("button", { name: "证件", exact: true })).toBeNull();
  });

  it("does not offer actions for inaccessible containers and permits a fresh retry", async () => {
    handler = () => response({ error: { code: "container_not_found", message: "位置不存在或无权访问" } }, 404);
    show("cp0");
    await screen.findByText("位置不存在或无权访问");
    expect(screen.queryByRole("button", { name: "登记到此隔层" })).toBeNull();
    handler = () => response({ room, container: cabinet });
    fireEvent.click(screen.getByRole("button", { name: "重新加载位置" }));
    await screen.findByRole("button", { name: "登记到此隔层" });
  });

  it("does not accept a stale response after the requested location changes", async () => {
    let finishOld: ((result: Response) => void) | undefined;
    handler = url => url.pathname.endsWith("/box") ? new Promise(resolve => { finishOld = resolve; }) : response({ room, container: { ...cabinet, id: "box2", name: "新容器", compartments: [] } });
    const { rerender } = show("cp0");
    await waitFor(() => expect(finishOld).toBeDefined());
    rerender(createElement(LocationPage, { containerId: "box2", onViewItems() {}, onRegister() {}, onBack() {} }));
    await screen.findByRole("heading", { name: "新容器" });
    await act(async () => { finishOld?.(response({ room, container: cabinet })); });
    expect(screen.queryByRole("heading", { name: "白色衣柜" })).toBeNull();
    expect(screen.queryByRole("button", { name: "证件", exact: true })).toBeNull();
  });
});
