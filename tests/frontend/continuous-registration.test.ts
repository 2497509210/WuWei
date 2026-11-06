// @vitest-environment jsdom
import { createElement, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickRegisterDialog } from "../../frontend/src/components/QuickRegisterDialog";
import { RegisterDialog } from "../../frontend/src/components/RegisterDialog";
import { LocationPicker } from "../../frontend/src/components/LocationPicker";
import { forgetLocation, recentLocation, rememberLocation } from "../../frontend/src/lib/recentLocation";
import { FakeXHR, installFetchXHRBridge } from "./helpers/fake-xhr";
import type { Item, MeResponse } from "../../frontend/src/api/client";

const me: MeResponse = { user: { id: "owner", username: "owner", display_name: "家人", role: "owner" }, household: { id: "home", name: "我家" } };
const room = { id: "room", version: 1, floor_id: "floor", name: "书房", width_cm: 400, depth_cm: 400, height_cm: 260, wall_color: null, sort: 0, container_count: 1 };
const compartments = Array.from({ length: 7 }, (_, index) => ({ id: `cp${index + 1}`, container_id: "cabinet", name: `第${index + 1}层`, kind: "shelf", level_index: index, row: 0, col: 0, sort: index }));
const cabinet = { id: "cabinet", room_id: "room", preset: "wardrobe", name: "书柜", x_cm: 0, z_cm: 0, y_cm: 0, rot_deg: 0, width_cm: 180, depth_cm: 58, height_cm: 220, color: null, config: { layers: 7 }, compartments, item_count: 0, version: 1 };
const item: Item = { id: "item1", name: "相机", aliases: [], notes: "", quantity: 1, compartment_id: "cp1", room_id: "room", container_id: "cabinet", photo_url: null, location_path: ["书房", "书柜", "第1层"], version: 1, location_status: "confirmed", last_confirmed_at: null, updated_at: "2026-11-06T00:00:00Z", archived_at: null, archive_reason: null };
type Handler = (url: URL, init: RequestInit) => Promise<Response> | Response;
let handler: Handler;
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }
function normal(url: URL) {
  if (url.pathname.endsWith("/bootstrap")) return json({ ...me, floors: [{ id: "floor", name: "一层", level: 1, rooms: [room] }] });
  if (url.pathname.endsWith("/rooms/room")) return json({ room, containers: [cabinet] });
  const id = url.pathname.match(/\/locations\/compartments\/(cp\d)$/)?.[1];
  if (id) return json({ location: { room_id: "room", container_id: "cabinet", compartment_id: id, path: ["旧名称", "旧柜名", id] } });
  if (url.pathname.endsWith("/items/batch")) return json({ items: [item] }, 201);
  return json({ item }, 201);
}
function savedIds() { return JSON.parse(localStorage.getItem("wuwei:recent-locations:home:owner") ?? "[]") as string[]; }
beforeEach(() => {
  localStorage.clear(); handler = url => normal(url);
  vi.stubGlobal("fetch", (path: string, init: RequestInit = {}) => Promise.resolve(handler(new URL(path, "http://localhost"), init)));
  installFetchXHRBridge();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

describe("recent location IDs", () => {
  // A single-value store would lose all but the newest shelf; duplicate choices must reorder without growing the list.
  it("keeps the five most recent unique locations and deletes only a matching ID", () => {
    for (const id of ["cp1", "cp2", "cp3", "cp4", "cp5", "cp6", "cp3"]) rememberLocation(me, id);
    expect(savedIds()).toEqual(["cp3", "cp6", "cp5", "cp4", "cp2"]);
    forgetLocation(me, "cp5");
    expect(savedIds()).toEqual(["cp3", "cp6", "cp4", "cp2"]);
    expect(recentLocation(me)).toBe("cp3");
  });
  // Existing installations must retain their one saved shelf while moving to the ID-only list.
  it("migrates a legacy saved shelf and isolates the same user in another household", () => {
    localStorage.setItem("wuwei:recent-location:home:owner", "cp1");
    expect(recentLocation(me)).toBe("cp1");
    expect(savedIds()).toEqual(["cp1"]);
    expect(localStorage.getItem("wuwei:recent-location:home:owner")).toBeNull();
    const other = { ...me, household: { id: "other", name: "其他家" } };
    rememberLocation(other, "cp7");
    expect(recentLocation(me)).toBe("cp1"); expect(recentLocation(other)).toBe("cp7");
  });
  // Corrupt or unavailable browser storage must not turn a successful server write into a failure.
  it("ignores malformed lists and tolerates denied storage", () => {
    localStorage.setItem("wuwei:recent-locations:home:owner", '{"private":"not an ID list"}');
    expect(recentLocation(me)).toBe("");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    expect(() => rememberLocation(me, "cp1")).not.toThrow();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    expect(recentLocation(me)).toBe(""); expect(() => forgetLocation(me, "cp1")).not.toThrow();
  });
});

describe("verified recent location choices", () => {
  // Labels from local storage or an old resolution path may be stale; display current room/container/compartment data.
  it.each(["quick", "batch"])("shows current names in the %s form and verifies a recent choice again", async kind => {
    rememberLocation(me, "cp1"); rememberLocation(me, "cp2");
    render(kind === "quick" ? createElement(QuickRegisterDialog, { me, onClose() {}, onSaved() {} }) : createElement(RegisterDialog, { me, onClose() {}, onSaved() {} }));
    const recent = await screen.findByRole("button", { name: "使用最近位置：书房 / 书柜 / 第2层" });
    handler = url => url.pathname.endsWith("/locations/compartments/cp2") ? json({ error: { code: "compartment_not_found", message: "该位置刚刚删除" } }, 404) : normal(url);
    fireEvent.click(recent);
    await screen.findByText(/该位置刚刚删除/);
    expect(savedIds()).toEqual(["cp1"]);
    expect((screen.getByLabelText("房间") as HTMLSelectElement).value).toBe("");
  });
  // Temporary failures are not proof that a shelf was deleted, and retry must be possible without losing other entries.
  it("removes forbidden shelves but retains and retries a temporary failure", async () => {
    rememberLocation(me, "cp1"); rememberLocation(me, "cp2"); rememberLocation(me, "cp3");
    handler = url => url.pathname.endsWith("/locations/compartments/cp3") ? json({ error: { code: "forbidden", message: "位置不可用" } }, 403)
      : url.pathname.endsWith("/locations/compartments/cp2") ? json({ error: { code: "unavailable", message: "稍后重试" } }, 503) : normal(url);
    render(createElement(QuickRegisterDialog, { me, onClose() {}, onSaved() {} }));
    await screen.findByRole("button", { name: "使用最近位置：书房 / 书柜 / 第1层" });
    expect(savedIds()).toEqual(["cp2", "cp1"]);
    const retry = await screen.findByRole("button", { name: "重试读取最近位置" });
    handler = url => normal(url); fireEvent.click(retry);
    await screen.findByRole("button", { name: "使用最近位置：书房 / 书柜 / 第2层" });
    expect(savedIds()).toEqual(["cp2", "cp1"]);
  });
  // Late requests from another account must neither expose old labels nor mutate its new user's location.
  it("ignores recent resolutions from the previous account", async () => {
    rememberLocation(me, "cp1");
    let finish: ((value: Response) => void) | undefined;
    handler = url => url.pathname.endsWith("/locations/compartments/cp1") ? new Promise(resolve => { finish = resolve; }) : normal(url);
    const view = render(createElement(QuickRegisterDialog, { me, onClose() {}, onSaved() {} }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    view.rerender(createElement(QuickRegisterDialog, { me: { ...me, user: { ...me.user, id: "other" } }, onClose() {}, onSaved() {} }));
    await act(async () => { finish?.(normal(new URL("http://localhost/api/locations/compartments/cp1"))); });
    expect(screen.queryByRole("button", { name: /使用最近位置/ })).toBeNull();
    expect((screen.getByLabelText("房间") as HTMLSelectElement).value).toBe("");
  });
  // A slow recent-location selection must not overwrite an explicit later choice in the same form.
  it("keeps the manual location when a previous recent selection resolves late", async () => {
    rememberLocation(me, "cp2");
    function Picker() { const [value, setValue] = useState(""); return createElement(LocationPicker, { me, value, onChange: setValue }); }
    render(createElement(Picker));
    const recent = await screen.findByRole("button", { name: "使用最近位置：书房 / 书柜 / 第2层" });
    let finish: ((value: Response) => void) | undefined;
    handler = url => url.pathname.endsWith("/locations/compartments/cp2") ? new Promise(resolve => { finish = resolve; }) : normal(url);
    fireEvent.click(recent); await waitFor(() => expect(finish).toBeTypeOf("function"));
    fireEvent.change(screen.getByLabelText("房间"), { target: { value: "room" } });
    await screen.findByRole("option", { name: "书柜" }); fireEvent.change(screen.getByLabelText("容器"), { target: { value: "cabinet" } });
    fireEvent.click(screen.getByRole("button", { name: "第1层", exact: true }));
    await act(async () => { finish?.(normal(new URL("http://localhost/api/locations/compartments/cp2"))); });
    expect(screen.getByRole("button", { name: "第1层", exact: true }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "第2层", exact: true }).getAttribute("aria-pressed")).toBe("false");
  });
});

describe("continuous photo registration", () => {
  // Reusing the prior successful idempotency key would silently collapse two intentionally identical items into one.
  it("saves two identical items as distinct operations and leaves a clean form with the same location", async () => {
    const written = new Map<string, Item>();
    handler = (url, init) => {
      if (!url.pathname.endsWith("/items/quick")) return normal(url);
      const form = init.body as FormData; const id = String(form.get("operation_id"));
      if (!written.has(id)) written.set(id, { ...item, id: `item${written.size + 1}` });
      return json({ item: written.get(id) }, 201);
    };
    function Shell() {
      const [open, setOpen] = useState(true); const [saved, setSaved] = useState<string[]>([]);
      return createElement("div", null, createElement("output", { "aria-label": "已保存记录" }, saved.join(",")), open && createElement(QuickRegisterDialog, {
        me, onClose: () => setOpen(false),
        onSaved: (savedItem: Item, options?: { continueRegistration?: boolean }) => { setSaved(previous => [...previous, savedItem.id]); if (!options?.continueRegistration) setOpen(false); },
      }));
    }
    render(createElement(Shell));
    await screen.findByRole("option", { name: "书房" }); fireEvent.change(screen.getByLabelText("房间"), { target: { value: "room" } });
    await screen.findByRole("option", { name: "书柜" }); fireEvent.change(screen.getByLabelText("容器"), { target: { value: "cabinet" } });
    fireEvent.click(screen.getByRole("button", { name: "第1层", exact: true }));
    await waitFor(() => expect(screen.getByRole("button", { name: "第1层", exact: true }).getAttribute("aria-pressed")).toBe("true"));
    for (const expected of ["item1", "item1,item2"]) {
      fireEvent.change(screen.getByLabelText("物品名称"), { target: { value: "相机" } });
      fireEvent.click(screen.getByRole("button", { name: "保存并继续" }));
      await waitFor(() => expect(screen.getByLabelText("已保存记录").textContent).toBe(expected));
      expect((screen.getByLabelText("物品名称") as HTMLInputElement).value).toBe("");
      expect(screen.getByRole("button", { name: "第1层", exact: true }).getAttribute("aria-pressed")).toBe("true");
      expect(document.activeElement).toBe(screen.getByLabelText("物品名称"));
    }
    const unload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(false);
    vi.spyOn(window, "confirm").mockReturnValue(false); fireEvent.click(screen.getByRole("button", { name: "关闭对话框" }));
    expect(screen.queryByRole("dialog")).toBeNull(); expect(written.size).toBe(2);
  });
  // Cancellation is an unknown result: preserve the draft and operation key until the same write is confirmed.
  it("preserves a cancelled draft and retries the same operation before clearing it", async () => {
    const sent: string[] = []; let confirmed = false;
    handler = (url, init) => {
      if (!url.pathname.endsWith("/items/quick")) return normal(url);
      sent.push(String((init.body as FormData).get("operation_id")));
      return sent.length === 1 ? new Promise(() => {}) : json({ item }, 201);
    };
    render(createElement(QuickRegisterDialog, { me, initialCompartmentId: "cp1", onClose() {}, onSaved() { confirmed = true; } }));
    await screen.findByRole("button", { name: "第1层", exact: true });
    fireEvent.change(screen.getByLabelText("物品名称"), { target: { value: "相机" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并继续" }));
    await screen.findByRole("button", { name: "停止等待" }); fireEvent.click(screen.getByRole("button", { name: "停止等待" }));
    await screen.findByText(/尚未确认保存结果/);
    expect((screen.getByLabelText("物品名称") as HTMLInputElement).value).toBe("相机"); expect(savedIds()).toEqual([]); expect(confirmed).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "保存并继续" }));
    await waitFor(() => expect((screen.getByLabelText("物品名称") as HTMLInputElement).value).toBe(""));
    expect(sent).toHaveLength(2); expect(sent[0]).toBe(sent[1]); expect(savedIds()).toEqual(["cp1"]);
    expect(FakeXHR.instances[0].aborted).toBe(true);
  });
  // Switching from “continue” to “close” after an uncertain result is a retry of the same item, not a new write.
  it("retries a failed continue submission through save-and-close with the same operation", async () => {
    const sent: string[] = [];
    handler = (url, init) => {
      if (!url.pathname.endsWith("/items/quick")) return normal(url);
      sent.push(String((init.body as FormData).get("operation_id")));
      return sent.length === 1 ? json({ error: { code: "temporary_error", message: "暂时无法保存" } }, 503) : json({ item }, 201);
    };
    function Shell() { const [open, setOpen] = useState(true); return open ? createElement(QuickRegisterDialog, { me, initialCompartmentId: "cp1", onClose: () => setOpen(false), onSaved: (_item: Item, options?: { continueRegistration?: boolean }) => { if (!options?.continueRegistration) setOpen(false); } }) : createElement("p", null, "保存后已关闭"); }
    render(createElement(Shell)); await screen.findByRole("button", { name: "第1层", exact: true });
    fireEvent.change(screen.getByLabelText("物品名称"), { target: { value: "相机" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并继续" })); await screen.findByText(/暂时无法保存/);
    expect((screen.getByLabelText("物品名称") as HTMLInputElement).value).toBe("相机"); expect(savedIds()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "保存物品" })); await screen.findByText("保存后已关闭");
    expect(sent).toHaveLength(2); expect(sent[0]).toBe(sent[1]); expect(savedIds()).toEqual(["cp1"]);
  });
  // The completion callback must receive actual new records so the caller can offer direct detail links.
  it("reports newly registered batch items before the existing count callback", async () => {
    const observed: string[] = [];
    render(createElement(RegisterDialog, { me, initialCompartmentId: "cp1", onClose() {}, onRegistered: (items: Item[]) => observed.push(items[0].id), onSaved: count => observed.push(`count:${count}`) }));
    await screen.findByRole("button", { name: "第1层", exact: true });
    fireEvent.change(screen.getByLabelText("物品名称，每行一件或一组"), { target: { value: "相机" } });
    fireEvent.click(screen.getByRole("button", { name: "保存登记" }));
    await waitFor(() => expect(observed).toEqual(["item1", "count:1"]));
  });
});
