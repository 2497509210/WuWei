// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../frontend/src/App";
import type { Item } from "../../frontend/src/api/client";
import { useWorkspace } from "../../frontend/src/store/useWorkspace";

const owner = { user: { id: "owner", username: "owner", display_name: "家人", role: "owner" as const }, household: { id: "home", name: "我家" } };
const bedroom = { id: "bedroom", floor_id: "floor", name: "主卧", width_cm: 460, depth_cm: 360, height_cm: 260, wall_color: null, sort: 0, container_count: 1 };
const item: Item = { id: "one", name: "物品1", aliases: [], notes: "", quantity: 1, compartment_id: "shelf", room_id: "bedroom", container_id: "cabinet", location_path: ["主卧", "衣柜", "顶层"], photo_url: null, version: 2, location_status: "missing", last_confirmed_at: null, updated_at: "2026-11-06T00:00:00Z", archived_at: null, archive_reason: null };
const reply = (value: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
let me = owner, signedIn = true, position = 0;
let items: Item[];
type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
let handler: Handler;
const path = () => window.location.pathname + window.location.search;
function normal(url: URL, init: RequestInit): Response {
  if (url.pathname.endsWith("/setup/status")) return reply({ needed: false });
  if (url.pathname.endsWith("/api/me")) return signedIn ? reply(me) : reply({ error: { code: "not_authenticated" } }, 401);
  if (url.pathname.endsWith("/auth/logout")) { signedIn = false; return reply(null, 204); }
  if (url.pathname.endsWith("/auth/login")) { signedIn = true; return reply({ user: me.user }); }
  if (url.pathname.endsWith("/auth/join")) { signedIn = true; return reply(me, 201); }
  if (url.pathname.endsWith("/bootstrap")) return reply({ ...me, floors: window.location.pathname === "/" ? [] : [{ id: "floor", name: "默认", level: 1, rooms: [bedroom] }] });
  if (url.pathname.endsWith("/account/devices")) return reply({ devices: [] });
  if (url.pathname.endsWith("/household/members")) return reply({ members: [] });
  if (url.pathname.endsWith("/household/invites")) return reply({ invites: [] });
  if (url.pathname.endsWith("/locations/compartments/shelf")) return reply({ location: { room_id: "bedroom", container_id: "cabinet", compartment_id: "shelf", path: ["主卧", "衣柜", "顶层"] } });
  if (url.pathname.endsWith("/rooms/bedroom")) return reply({ room: bedroom, containers: [{ id: "cabinet", room_id: "bedroom", preset: "wardrobe", name: "衣柜", x_cm: 150, z_cm: 100, y_cm: 0, rot_deg: 0, width_cm: 180, depth_cm: 58, height_cm: 220, color: null, config: { layers: 1 }, compartments: [{ id: "shelf", container_id: "cabinet", name: "顶层", kind: "shelf", level_index: 0, row: 0, col: 0, sort: 0 }], item_count: 81, version: 1 }] });
  if (url.pathname.endsWith("/items")) {
    const filtered = items.filter(row => (!url.searchParams.get("q") || row.name.includes(url.searchParams.get("q")!))
      && Boolean(row.archived_at) === (url.searchParams.get("status") === "archived")
      && (!url.searchParams.get("room_id") || row.room_id === url.searchParams.get("room_id"))
      && (!url.searchParams.get("compartment_id") || row.compartment_id === url.searchParams.get("compartment_id"))
      && (!url.searchParams.get("location_status") || row.location_status === url.searchParams.get("location_status")));
    const page = Number(url.searchParams.get("page") || 1), size = Number(url.searchParams.get("page_size") || 40);
    return reply({ items: filtered.slice((page - 1) * size, page * size), total: filtered.length, page, page_size: size, has_more: page * size < filtered.length });
  }
  throw new Error(`Unexpected ${init.method || "GET"} ${url}`);
}
beforeEach(() => {
  me = owner; signedIn = true; position = 0; sessionStorage.clear();
  items = Array.from({ length: 81 }, (_, index) => ({ ...item, id: `item-${index + 1}`, name: `物品${index + 1}` }));
  handler = normal;
  window.history.replaceState(null, "", "/find");
  vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => Promise.resolve(handler(new URL(url, "http://localhost"), init)));
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(window, "scrollY", "get").mockImplementation(() => position);
  vi.spyOn(window, "scrollTo").mockImplementation((options: number | ScrollToOptions, y?: number) => { position = typeof options === "number" ? y || 0 : options.top || 0; });
});
afterEach(() => { cleanup(); useWorkspace.getState().reset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); window.history.replaceState(null, "", "/"); });
async function show(url = "/find") { window.history.replaceState(null, "", url); render(createElement(App)); await screen.findByRole("searchbox"); }
async function back() { await act(async () => { window.history.back(); await new Promise(resolve => setTimeout(resolve, 30)); }); }
async function forward() { await act(async () => { window.history.forward(); await new Promise(resolve => setTimeout(resolve, 30)); }); }

describe("find URLs and history", () => {
  // Consecutive user events can arrive before a router transition paints its first
  // location. Each later filter must retain every earlier change, including on reload.
  it("keeps search, missing status and room when filters change before a transition paints", async () => {
    await show(); await screen.findByText("第 1–40 条，共 81 条");
    await screen.findByRole("option", { name: "主卧", exact: true });
    act(() => {
      fireEvent.change(screen.getByRole("searchbox"), { target: { value: "物品" } });
      fireEvent.click(screen.getByRole("button", { name: "待找回", exact: true }));
      fireEvent.change(screen.getByRole("combobox", { name: "筛选房间" }), { target: { value: "bedroom" } });
    });
    await screen.findByText("第 1–40 条，共 81 条");
    expect(Object.fromEntries(new URLSearchParams(window.location.search))).toEqual({ q: "物品", status: "missing", room: "bedroom" });
    expect(screen.getByRole("button", { name: "待找回", exact: true }).getAttribute("aria-pressed")).toBe("true");
    cleanup(); render(createElement(App));
    await screen.findByText("第 1–40 条，共 81 条");
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("物品");
    expect(screen.getByRole("button", { name: "待找回", exact: true }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("combobox", { name: "筛选房间" }) as HTMLSelectElement).value).toBe("bedroom");
  });
  // A subsequent search must not restore a shelf removed by the selected room's correction.
  it("keeps a conflicting shelf cleared when search follows a room change before a transition paints", async () => {
    const study = { ...bedroom, id: "study", name: "书房" };
    items = [item, { ...item, id: "study-item", name: "书房物品", room_id: "study", compartment_id: "study-shelf" }];
    let finishLocation: ((response: Response) => void) | undefined;
    handler = (url, init) => {
      if (url.pathname.endsWith("/bootstrap")) return reply({ ...me, floors: [{ id: "floor", name: "默认", level: 1, rooms: [bedroom, study] }] });
      if (url.pathname.endsWith("/locations/compartments/shelf")) return new Promise(resolve => { finishLocation = resolve; });
      return normal(url, init);
    };
    await show("/find?compartment=shelf");
    await screen.findByRole("button", { name: "查看物品1", exact: true });
    await screen.findByRole("option", { name: "书房", exact: true });
    await act(async () => { finishLocation!(normal(new URL("http://localhost/api/locations/compartments/shelf"), {})); });
    act(() => {
      fireEvent.change(screen.getByRole("combobox", { name: "筛选房间" }), { target: { value: "study" } });
      fireEvent.change(screen.getByRole("searchbox"), { target: { value: "书房" } });
    });
    expect(Object.fromEntries(new URLSearchParams(window.location.search))).toEqual({ q: "书房", room: "study" });
    await screen.findByRole("button", { name: "查看书房物品", exact: true });
    expect(screen.queryByRole("button", { name: "查看全部", exact: true })).toBeNull();
    expect((screen.getByRole("combobox", { name: "筛选房间" }) as HTMLSelectElement).value).toBe("study");
  });
  // Ignoring any deep-link criterion must expose the wrong rows, tab, or count here.
  it("opens a shared missing-room search on its requested page", async () => {
    await show("/find?q=物品&status=missing&room=bedroom&page=2");
    await screen.findByText("第 41–80 条，共 81 条");
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("物品");
    expect(screen.getByRole("button", { name: "待找回", exact: true }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("combobox", { name: "筛选房间" }) as HTMLSelectElement).value).toBe("bedroom");
    expect(screen.queryByRole("button", { name: "查看物品1", exact: true })).toBeNull();
  });
  // A malformed URL must not send a failing status/page or retain an unusable selector value.
  it("normalizes invalid filters to a usable first page", async () => {
    await show("/find?status=other&page=-2&room=%3Cbad%3E");
    await screen.findByText("第 1–40 条，共 81 条");
    expect(screen.getByRole("button", { name: "在用", exact: true }).getAttribute("aria-pressed")).toBe("true");
    expect(path()).toBe("/find");
  });
  // Search must reset page without losing the compatible room/status/shelf scope.
  it("writes changes into the address and keeps filters when resetting the page for search", async () => {
    await show("/find?status=missing&room=bedroom&compartment=shelf&page=2");
    await screen.findByText("第 41–80 条，共 81 条");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "物品81" } });
    await screen.findByText("第 1–1 条，共 1 条");
    const query = new URLSearchParams(window.location.search);
    expect(Object.fromEntries(query)).toEqual({ q: "物品81", status: "missing", room: "bedroom", compartment: "shelf" });
    cleanup(); render(createElement(App));
    await screen.findByRole("button", { name: "查看物品81", exact: true });
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("物品81");
  });
  // Browser navigation must invalidate selection and trust just like a clicked page change.
  it("restores back and forward pages while isolating selection and failed results", async () => {
    await show(); await screen.findByRole("button", { name: "查看物品1", exact: true });
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await screen.findByText("第 41–80 条，共 81 条");
    expect(new URLSearchParams(window.location.search).get("page")).toBe("2");
    fireEvent.click(screen.getByRole("button", { name: "批量整理" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择物品41", exact: true }));
    await back(); await screen.findByText("第 1–40 条，共 81 条");
    expect(screen.getByText("已选 0 条")).toBeTruthy();
    handler = (url, init) => url.pathname.endsWith("/items") && url.searchParams.get("page") === "2" ? reply({ error: { message: "第二页暂不可用" } }, 503) : normal(url, init);
    await forward(); await screen.findByText(/^第二页暂不可用/);
    expect((screen.getByRole("checkbox", { name: "选择物品1", exact: true }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByText("第 41–80 条，共 81 条")).toBeNull();
    handler = normal; fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    await screen.findByText("第 41–80 条，共 81 条");
  });
  // Settings returnTo previously dropped search and therefore silently widened the result scope.
  it("returns from settings to the complete filtered address", async () => {
    await show("/find?q=物品&status=missing&room=bedroom&page=2");
    await screen.findByText("第 41–80 条，共 81 条");
    const target = path();
    fireEvent.click(screen.getByRole("button", { name: "账号与家庭" }));
    fireEvent.click(await screen.findByRole("button", { name: "返回找物" }));
    await screen.findByText("第 41–80 条，共 81 条");
    expect(path()).toBe(target);
  });
  // The general find entry after a space visit should resume the latest same-account scope.
  it("resumes the last find scope from the workspace", async () => {
    await show("/find?q=物品&status=missing&room=bedroom&page=2");
    await screen.findByText("第 41–80 条，共 81 条");
    const target = path();
    fireEvent.click(screen.getByRole("button", { name: "空间", exact: true }));
    await waitFor(() => expect(screen.queryByRole("searchbox")).toBeNull());
    fireEvent.click(await screen.findByRole("button", { name: "家庭找物", exact: true }));
    await screen.findByText("第 41–80 条，共 81 条");
    expect(path()).toBe(target);
  });
  // Canonical URL replacement must not replay or leave behind a one-shot scanned action.
  it("consumes a legacy shelf registration action once while preserving that shelf", async () => {
    window.history.replaceState({ usr: { compartment: "shelf" } }, "", "/find?register=1&status=archived&page=2");
    render(createElement(App));
    const dialog = await screen.findByRole("dialog", { name: "一起记在这个位置" });
    await waitFor(() => expect(new URLSearchParams(window.location.search).has("register")).toBe(false));
    expect(new URLSearchParams(window.location.search).get("compartment")).toBe("shelf");
    expect(screen.getByRole("button", { name: "在用", exact: true }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(dialog.querySelector('button[aria-label="关闭对话框"]')!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("find scroll and account boundaries", () => {
  // Revalidating the same URL also collapses the grid; its loading layout must not erase the reading position.
  it("keeps the reading position while refreshing the current list", async () => {
    await show("/find?page=2"); await screen.findByText("第 41–80 条，共 81 条");
    position = 640; fireEvent.scroll(window);
    let finish: ((response: Response) => void) | undefined;
    handler = (url, init) => url.pathname.endsWith("/items") ? new Promise(resolve => { finish = resolve; }) : normal(url, init);
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    fireEvent.click(screen.getByRole("button", { name: "刷新清单" }));
    await screen.findByText("正在读取物品…");
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    position = 0; fireEvent.scroll(window);
    await act(async () => { finish!(normal(new URL("http://localhost/api/items?page=2&page_size=40"), {})); });
    await screen.findByText("第 41–80 条，共 81 条");
    expect(position).toBe(640);
  });
  // A failed or pending list must never restore against a short loading/error layout and lose its saved offset.
  it("restores saved scroll only after the matching list successfully renders", async () => {
    await show("/find?page=2"); await screen.findByText("第 41–80 条，共 81 条");
    await waitFor(() => expect(position).toBe(0));
    position = 720; fireEvent.scroll(window); fireEvent(window, new Event("pagehide"));
    cleanup(); position = 0;
    handler = (url, init) => url.pathname.endsWith("/items") ? reply({ error: { message: "网络稍后重试" } }, 503) : normal(url, init);
    render(createElement(App)); await screen.findByText(/^网络稍后重试/);
    expect(position).toBe(0);
    handler = normal; fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    await screen.findByText("第 41–80 条，共 81 条");
    await waitFor(() => expect(position).toBe(720));
  });
  // The old account's cached query may not populate a different account after logout/login.
  it("clears remembered scope and scroll when a different user signs in", async () => {
    await show("/find?q=物品&status=missing&page=2"); await screen.findByText("第 41–80 条，共 81 条");
    position = 640; fireEvent.scroll(window);
    fireEvent.click(screen.getByRole("button", { name: "退出", exact: true }));
    await screen.findByRole("button", { name: "登录", exact: true });
    me = { ...owner, user: { ...owner.user, id: "another", username: "another" } };
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "another" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "synthetic-password" } });
    fireEvent.click(screen.getByRole("button", { name: "登录", exact: true }));
    fireEvent.click(await screen.findByRole("button", { name: "家庭找物", exact: true }));
    await screen.findByText("第 1–40 条，共 81 条");
    expect(path()).toBe("/find");
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
    await waitFor(() => expect(position).toBe(0));
  });
  // An account changed in another tab must not recover the prior account's persisted query on reload.
  it("discards an old account's find view when authentication returns another identity", async () => {
    await show("/find?q=物品&status=missing&page=2"); await screen.findByText("第 41–80 条，共 81 条");
    cleanup();
    me = { ...owner, household: { id: "new-home", name: "其他家庭" } };
    render(createElement(App));
    await screen.findByText("第 1–40 条，共 81 条");
    expect(path()).toBe("/find");
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
  });
  // Identity changes must discard hidden returnTo state as well as the currently visible URL.
  it("clears the previous account's find return target when changing accounts on settings", async () => {
    await show("/find?q=物品&status=missing&page=2"); await screen.findByText("第 41–80 条，共 81 条");
    fireEvent.click(screen.getByRole("button", { name: "账号与家庭" }));
    await screen.findByRole("button", { name: "返回找物" }); cleanup();
    me = { ...owner, user: { ...owner.user, id: "other", username: "other" } };
    render(createElement(App));
    fireEvent.click(await screen.findByRole("button", { name: "返回空间" }));
    await screen.findByRole("button", { name: "家庭找物", exact: true });
    expect(path()).toBe("/");
  });
  // Joining with a new identity must not revive the signed-out account's saved search through joinReturnTo.
  it("clears the previous account's find destination after joining with another identity", async () => {
    await show("/find?q=物品&status=missing&page=2"); await screen.findByText("第 41–80 条，共 81 条");
    cleanup(); signedIn = false;
    me = { ...owner, user: { ...owner.user, id: "joined", username: "joined" } };
    render(createElement(App));
    fireEvent.click(await screen.findByRole("button", { name: "使用邀请码加入家庭" }));
    fireEvent.change(await screen.findByLabelText("邀请码"), { target: { value: "synthetic-invite" } });
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "joined" } });
    fireEvent.change(screen.getByLabelText("昵称"), { target: { value: "家人" } });
    fireEvent.change(screen.getByLabelText("密码", { exact: true }), { target: { value: "synthetic-password" } });
    fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "synthetic-password" } });
    fireEvent.click(screen.getByRole("button", { name: "加入家庭" }));
    await waitFor(() => expect(path()).toBe("/"));
    await screen.findByRole("button", { name: "家庭找物", exact: true });
  });
  // Old in-app history can outlive logout; Back must not consume another identity's search parameters.
  it("rejects a previous account's internal find history after signing in as another user", async () => {
    await show(); await screen.findByText("第 1–40 条，共 81 条");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "物品" } });
    await screen.findByText("第 1–40 条，共 81 条");
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await screen.findByText("第 41–80 条，共 81 条");
    fireEvent.click(screen.getByRole("button", { name: "待找回", exact: true }));
    await screen.findByText("第 1–40 条，共 81 条");
    fireEvent.click(screen.getByRole("button", { name: "退出", exact: true }));
    await screen.findByRole("button", { name: "登录", exact: true });
    me = { ...owner, user: { ...owner.user, id: "history-other", username: "history-other" } };
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "history-other" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "synthetic-password" } });
    fireEvent.click(screen.getByRole("button", { name: "登录", exact: true }));
    await screen.findByRole("button", { name: "家庭找物", exact: true });
    await back(); await screen.findByText("第 1–40 条，共 81 条");
    expect(path()).toBe("/find");
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
  });
});
