// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../frontend/src/App";
import { request, type Item, type MeResponse } from "../../frontend/src/api/client";
import { activateFindNavigation, rememberFindPath } from "../../frontend/src/lib/findNavigation";
import { useWorkspace } from "../../frontend/src/store/useWorkspace";

const originalOwner: MeResponse = { user: { id: "owner", username: "owner", display_name: "家人", role: "owner" }, household: { id: "home", name: "我家" } };
const originalItem: Item = { id: "item-one", name: "共享的卷尺", aliases: ["尺子"], notes: "抽屉左侧", quantity: 1, compartment_id: "shelf", room_id: "bedroom", container_id: "cabinet", location_path: ["卧室", "衣柜", "顶层"], photo_url: null, version: 2, location_status: "confirmed", last_confirmed_at: "2026-11-07T00:00:00Z", updated_at: "2026-11-07T00:00:00Z", archived_at: null, archive_reason: null };
const reply = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
let owner: MeResponse, item: Item, signedIn: boolean, handler: Handler;
function normal(url: URL, init: RequestInit): Response {
  if (url.pathname.endsWith("/setup/status")) return reply({ needed: false });
  if (url.pathname.endsWith("/api/me")) return signedIn ? reply(owner) : reply({ error: { code: "not_authenticated", message: "请先登录" } }, 401);
  if (url.pathname.endsWith("/auth/login")) { signedIn = true; return reply({ user: owner.user }); }
  if (url.pathname.endsWith("/auth/join")) { signedIn = true; return reply(owner, 201); }
  if (url.pathname.endsWith("/bootstrap")) return reply({ ...owner, floors: [] });
  if (url.pathname.endsWith("/items/item-one")) return reply({ item });
  if (url.pathname.endsWith("/items/item-one/events")) return reply({ events: [], has_more: false });
  if (url.pathname.endsWith("/items")) return reply({ items: [], total: 0, page: 1, page_size: 40, has_more: false });
  throw new Error(`Unexpected ${init.method || "GET"} ${url.pathname}`);
}
beforeEach(() => {
  owner = originalOwner; item = { ...originalItem }; signedIn = true; handler = normal;
  sessionStorage.clear(); window.history.replaceState(null, "", "/items/item-one");
  vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => Promise.resolve(handler(new URL(url, "http://localhost"), init)));
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => { cleanup(); useWorkspace.getState().reset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); window.history.replaceState(null, "", "/"); });
async function open() { render(createElement(App)); return screen.findByRole("dialog", { name: item.name }); }
async function login() {
  fireEvent.change(await screen.findByLabelText("用户名"), { target: { value: owner.user.username } });
  fireEvent.change(screen.getByLabelText("密码"), { target: { value: "synthetic-password" } });
  fireEvent.click(screen.getByRole("button", { name: "登录", exact: true }));
}

describe("shared item address", () => {
  // Falling back to the workspace, or hydrating an old remembered item, loses the shared record on reload.
  it("loads the current authorized record directly and refreshes it at the same address", async () => {
    await open(); await screen.findByText("抽屉左侧");
    expect(window.location.pathname).toBe("/items/item-one");
    cleanup(); item = { ...item, name: "家人更新的卷尺", notes: "已经移到右侧" };
    render(createElement(App));
    await screen.findByRole("dialog", { name: "家人更新的卷尺" });
    expect(screen.queryByText("抽屉左侧")).toBeNull();
    expect(window.location.pathname).toBe("/items/item-one");
  });
  // A failed initial read must never produce an editable placeholder, and retry must fetch again.
  it("shows a recoverable error without item actions until a fresh read succeeds", async () => {
    handler = (url, init) => url.pathname.endsWith("/items/item-one") ? reply({ error: { message: "临时无法读取" } }, 503) : normal(url, init);
    render(createElement(App));
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "编辑资料" })).toBeNull();
    handler = normal;
    fireEvent.click(screen.getByRole("button", { name: "重新加载物品" }));
    await screen.findByRole("dialog", { name: "共享的卷尺" });
  });
  // Authorization failures must not expose either a cached record or backend-provided identifying detail.
  it.each([403, 404])("shows the same non-identifying outcome for inaccessible item HTTP %s", async status => {
    handler = (url, init) => url.pathname.endsWith("/items/item-one") ? reply({ error: { message: "另一个家庭的私密名称" } }, status) : normal(url, init);
    render(createElement(App));
    expect((await screen.findByRole("alert")).textContent).toMatch(/不存在.*无权访问/);
    expect(screen.queryByText("另一个家庭的私密名称")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  // An archived record remains a valid shared destination, with its normal read-only/restore behavior.
  it("opens archived records through the same link", async () => {
    item = { ...item, archived_at: "2026-11-07T02:00:00Z", archive_reason: "已有新卷尺", compartment_id: null, room_id: null, container_id: null };
    await open(); await screen.findByText("已有新卷尺");
    expect(screen.getByRole("button", { name: "恢复物品", exact: true })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "编辑资料" })).toBeNull();
  });
  // Decoded slash/query characters may not turn a route id into another API endpoint.
  it.each(["%2E%2E%2Fme", "bad%3Fitem", "a".repeat(129)])("rejects malformed item id %s", async id => {
    window.history.replaceState(null, "", `/items/${id}`);
    render(createElement(App));
    expect((await screen.findByRole("alert")).textContent).toMatch(/链接.*无效/);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  // Closing a shared entry should resume this account's actual list scope rather than an arbitrary returnTo URL.
  it("returns to the current account's remembered find filters when closed", async () => {
    activateFindNavigation(owner); rememberFindPath(owner, "/find?q=卷尺&status=missing");
    await open(); fireEvent.click(screen.getByRole("button", { name: "关闭对话框" }));
    await screen.findByRole("searchbox");
    expect(new URLSearchParams(window.location.search).get("q")).toBe("卷尺");
    expect(new URLSearchParams(window.location.search).get("status")).toBe("missing");
  });
  // Route navigation must retain Modal's dirty guard and must not ask twice after accepting that guard.
  it("preserves an edit when closing is declined and leaves after one accepted confirmation", async () => {
    await open();
    await waitFor(() => expect((screen.getByRole("button", { name: "编辑资料" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "编辑资料" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "未保存的草稿" } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "关闭对话框" }));
    expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe("未保存的草稿");
    confirm.mockReset().mockReturnValueOnce(true).mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "关闭对话框" }));
    await screen.findByRole("searchbox");
    expect(window.location.pathname).toBe("/find");
  });
});

describe("shared item authentication boundaries", () => {
  // An external unowned link must survive old device memory and be checked under the newly logged-in identity.
  it("keeps an external item link through login despite another account's remembered search", async () => {
    activateFindNavigation(originalOwner); rememberFindPath(originalOwner, "/find?q=旧账号的搜索");
    owner = { ...owner, user: { ...owner.user, id: "new-owner", username: "new-owner" } }; signedIn = false;
    render(createElement(App)); await login();
    await screen.findByRole("dialog", { name: "共享的卷尺" });
    expect(window.location.pathname).toBe("/items/item-one");
    fireEvent.click(screen.getByRole("button", { name: "关闭对话框" }));
    await screen.findByRole("searchbox"); expect(window.location.search).toBe("");
  });
  // Keeping a safe path on session expiry is necessary for a shared record to reopen after reauthentication.
  it("returns to the same item after session expiry and same-account login", async () => {
    await open();
    handler = (url, init) => url.pathname.endsWith("/expired") ? reply({ error: { code: "not_authenticated" } }, 401) : normal(url, init);
    await act(async () => { signedIn = false; await request("/expired").catch(() => {}); });
    await screen.findByText("登录已失效，请重新登录");
    expect(window.location.pathname).toBe("/items/item-one");
    await login(); await screen.findByRole("dialog", { name: "共享的卷尺" });
  });
  // Explicit old in-app ownership is different from a newly pasted link and may not restore another account's item.
  it("discards an old account's owned item history when a different account signs in", async () => {
    activateFindNavigation(originalOwner);
    window.history.replaceState({ usr: { findOwner: "home:owner" } }, "", "/items/item-one");
    owner = { ...owner, user: { ...owner.user, id: "other", username: "other" } };
    render(createElement(App));
    await screen.findByRole("button", { name: "家庭找物", exact: true });
    expect(window.location.pathname).toBe("/");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  // Join must preserve the shared URL on both its back action and successful creation of a fresh identity.
  it("keeps an external item link through invitation registration even with old account memory", async () => {
    activateFindNavigation(originalOwner); owner = { ...owner, user: { ...owner.user, id: "joined", username: "joined" } }; signedIn = false;
    render(createElement(App));
    fireEvent.click(await screen.findByRole("button", { name: "使用邀请码加入家庭" }));
    fireEvent.click(await screen.findByRole("button", { name: "返回登录" }));
    await screen.findByRole("button", { name: "登录", exact: true });
    expect(window.location.pathname).toBe("/items/item-one");
    fireEvent.click(screen.getByRole("button", { name: "使用邀请码加入家庭" }));
    fireEvent.change(await screen.findByLabelText("邀请码"), { target: { value: "synthetic-invite" } });
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "joined" } });
    fireEvent.change(screen.getByLabelText("昵称"), { target: { value: "家人" } });
    fireEvent.change(screen.getByLabelText("密码", { exact: true }), { target: { value: "synthetic-password" } });
    fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "synthetic-password" } });
    fireEvent.click(screen.getByRole("button", { name: "加入家庭" }));
    await screen.findByRole("dialog", { name: "共享的卷尺" });
    expect(window.location.pathname).toBe("/items/item-one");
  });
  // Returning from Join may not strip ownership and reclassify old internal history as a fresh shared link.
  it("retains old item ownership when returning from Join before another account logs in", async () => {
    activateFindNavigation(originalOwner);
    window.history.replaceState({ usr: { findOwner: "home:owner" } }, "", "/items/item-one");
    owner = { ...owner, user: { ...owner.user, id: "new-account", username: "new-account" } }; signedIn = false;
    render(createElement(App));
    fireEvent.click(await screen.findByRole("button", { name: "使用邀请码加入家庭" }));
    fireEvent.click(await screen.findByRole("button", { name: "返回登录" }));
    await login();
    await screen.findByRole("button", { name: "家庭找物", exact: true });
    expect(window.location.pathname).toBe("/");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  // Navigation to another item must revoke the pending first read rather than showing its late result.
  it("does not show a late item read after navigating away from its address", async () => {
    let finish: ((result: Response) => void) | undefined;
    handler = (url, init) => url.pathname.endsWith("/items/item-one") ? new Promise(resolve => { finish = resolve; }) : normal(url, init);
    render(createElement(App)); await screen.findByText("正在读取物品…");
    await waitFor(() => expect(finish).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "返回找物" }));
    await screen.findByRole("searchbox");
    await act(async () => { finish!(reply({ item })); });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.location.pathname).toBe("/find");
  });
});
