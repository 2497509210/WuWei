// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InventoryPage } from "../../frontend/src/pages/InventoryPage";
import type { Item } from "../../frontend/src/api/client";

const me = { user: { id: "u", username: "owner", display_name: "家人", role: "owner" as const }, household: { id: "h", name: "家" } };
const original: Item = { id: "old", name: "护照", aliases: [], quantity: 1, notes: "", compartment_id: "cp", container_id: "c", room_id: "r", location_path: ["书房", "柜子", "顶层"], photo_url: null, version: 1, location_status: "confirmed", last_confirmed_at: null, updated_at: "2026-11-06", archived_at: null, archive_reason: null };
let items: Item[], listReads: number, fail: boolean, clock: number, visible: boolean, bulkPayload: Record<string, unknown> | undefined;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
beforeEach(() => {
  items = [{ ...original }]; listReads = 0; fail = false; clock = 100_000; visible = true; bulkPayload = undefined;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visible ? "visible" : "hidden");
  localStorage.clear();
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "http://localhost");
    if (url.pathname.endsWith("/bootstrap")) return json({ ...me, floors: [{ id: "f", rooms: [{ id: "r", name: "书房" }] }] });
    if (url.pathname.endsWith("/locations/compartments/cp")) return json({ location: { room_id: "r", container_id: "c", compartment_id: "cp", path: ["书房", "柜子", "顶层"] } });
    if (url.pathname.endsWith("/rooms/r")) return json({ room: { id: "r", name: "书房" }, containers: [{ id: "c", name: "柜子", compartments: [{ id: "cp", name: "顶层" }] }] });
    if (url.pathname.endsWith("/items/batch")) {
      const data = JSON.parse(String(init.body)); const added = data.names.map((name: string, i: number) => ({ ...original, id: `new-${i}`, name })); items.push(...added); return json({ items: added }, 201);
    }
    if (url.pathname.endsWith("/items/actions/bulk")) { bulkPayload = JSON.parse(String(init.body)); return json({ error: { code: "version_conflict", message: "版本已改变" } }, 409); }
    if (url.pathname.endsWith("/events")) return json({ events: [], has_more: false });
    if (url.pathname.endsWith("/items")) {
      listReads++;
      if (fail) return json({ error: { message: "读取中断" } }, 503);
      const result = items.filter(item => !url.searchParams.get("q") || item.name.includes(url.searchParams.get("q")!));
      return json({ items: result, total: result.length, page: 1, page_size: 40, has_more: false });
    }
    const item = items.find(item => url.pathname.endsWith(`/items/${item.id}`));
    return item ? json({ item }) : json({ error: { message: "missing" } }, 404);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });
async function show() { render(createElement(InventoryPage, { me, onLogout: async () => {}, onArrange() {} })); await screen.findByRole("button", { name: "查看护照" }); }
async function register(names: string) {
  fireEvent.click(screen.getByRole("button", { name: "登记物品", exact: true }));
  const dialog = within(screen.getByRole("dialog", { name: "一起记在这个位置" }));
  await dialog.findByRole("option", { name: "书房" }); fireEvent.change(dialog.getByLabelText("房间"), { target: { value: "r" } });
  await dialog.findByRole("option", { name: "柜子" }); fireEvent.change(dialog.getByLabelText("容器"), { target: { value: "c" } });
  fireEvent.click(dialog.getByRole("button", { name: "顶层" }));
  fireEvent.change(dialog.getByLabelText("物品名称，每行一件或一组"), { target: { value: names } });
  fireEvent.click(dialog.getByRole("button", { name: "保存登记" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "一起记在这个位置" })).toBeNull());
}
async function resumeAfter(ms = 61_000) {
  await act(async () => { visible = false; document.dispatchEvent(new Event("visibilitychange")); clock += ms; visible = true; document.dispatchEvent(new Event("visibilitychange")); });
}

it("opens a newly registered item even when the current search excludes it", async () => {
  await show(); fireEvent.change(screen.getByRole("searchbox"), { target: { value: "护照" } });
  await screen.findByRole("button", { name: "查看护照" }); await register("电池");
  await screen.findByText(/未显示在当前页/);
  expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("护照");
  fireEvent.click(screen.getByRole("button", { name: "查看刚登记物品" }));
  await screen.findByRole("dialog", { name: "电池" });
});

it("offers every record in the latest registration batch without changing filters", async () => {
  await show(); await register("电池\n胶带");
  fireEvent.click(await screen.findByRole("button", { name: "查看刚登记的2件物品" }));
  const receipt = within(screen.getByRole("dialog", { name: "刚登记的物品" }));
  fireEvent.click(receipt.getByRole("button", { name: "查看胶带" })); await screen.findByRole("dialog", { name: "胶带" });
});

it("refreshes after a stale background return and coalesces focus and pageshow", async () => {
  await show(); items[0] = { ...original, name: "新护照", version: 2 };
  await resumeAfter(); await screen.findByRole("button", { name: "查看新护照" });
  await act(async () => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("pageshow")); });
  expect(listReads).toBe(2);
});

it("defers the wake-up refresh while selections exist and preserves their versions", async () => {
  await show(); fireEvent.click(screen.getByRole("button", { name: "批量整理" })); fireEvent.click(screen.getByRole("checkbox", { name: "选择护照" }));
  items[0] = { ...original, name: "新护照", version: 2 };
  await resumeAfter(); await screen.findByText(/可能已有更新/);
  expect(listReads).toBe(1); expect((screen.getByRole("checkbox", { name: "选择护照" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "退出批量整理" })); await screen.findByRole("button", { name: "查看新护照" });
});

it("does not replace an open edit, then refreshes after the detail is closed", async () => {
  await show(); fireEvent.click(screen.getByRole("button", { name: "查看护照" }));
  fireEvent.click(await screen.findByRole("button", { name: "编辑资料" }));
  fireEvent.change(screen.getByLabelText("备注"), { target: { value: "我的草稿" } });
  items[0] = { ...original, name: "新护照", version: 2 };
  await resumeAfter(); expect(listReads).toBe(1); expect((screen.getByLabelText("备注") as HTMLTextAreaElement).value).toBe("我的草稿");
  vi.spyOn(window, "confirm").mockReturnValue(true); fireEvent.click(screen.getByRole("button", { name: "关闭对话框" }));
  await screen.findByRole("button", { name: "查看新护照" });
});

it("on reconnect refreshes once, keeps failed rows untrusted and does not loop retries", async () => {
  await show(); fail = true;
  await act(async () => { clock += 1000; window.dispatchEvent(new Event("online")); });
  await screen.findByText(/读取中断/);
  await act(async () => { window.dispatchEvent(new Event("online")); window.dispatchEvent(new Event("focus")); });
  expect(listReads).toBe(2);
  expect(screen.getByText("当前筛选未能加载，以下为上次结果")).toBeTruthy();
});

it("does not refresh after a short background pause", async () => {
  await show(); await resumeAfter(5000); expect(listReads).toBe(1);
});

it("does not lose a wake-up requested while an older list read is in flight", async () => {
  await show();
  const realFetch = globalThis.fetch;
  let finish: ((response: Response) => void) | undefined;
  vi.stubGlobal("fetch", (input: string, init: RequestInit) => {
    if (String(input).includes("/items?") && !finish) return new Promise<Response>(resolve => { finish = resolve; });
    return realFetch(input, init);
  });
  fireEvent.click(screen.getByRole("button", { name: "更多" })); fireEvent.click(screen.getByRole("button", { name: "刷新清单" }));
  await waitFor(() => expect(finish).toBeDefined());
  items[0] = { ...original, name: "新护照", version: 2 };
  await resumeAfter();
  await act(async () => finish!(json({ items: [original], total: 1, page: 1, page_size: 40, has_more: false })));
  await screen.findByRole("button", { name: "查看新护照" });
});

it("preserves the original confirmation version inside an open bulk dialog on return", async () => {
  await show(); fireEvent.click(screen.getByRole("button", { name: "批量整理" })); fireEvent.click(screen.getByRole("checkbox", { name: "选择护照" }));
  fireEvent.click(screen.getByRole("button", { name: "批量归档" }));
  items[0] = { ...original, version: 2 };
  await resumeAfter();
  const dialog = within(screen.getByRole("dialog", { name: "批量归档" }));
  await dialog.findByText(/当前选择与版本保持不变/);
  fireEvent.click(dialog.getByRole("button", { name: "确认归档" }));
  await dialog.findByText(/版本已改变/);
  expect(bulkPayload?.items).toEqual([{ id: "old", expected_version: 1 }]);
  expect(listReads).toBe(1);
});
