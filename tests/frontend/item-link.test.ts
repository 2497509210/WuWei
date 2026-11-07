// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://user:secret@bd-a.tail3c54de.ts.net/wuwei/find?q=private-note"}
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ItemDetail } from "../../frontend/src/components/ItemDetail";
import type { Item } from "../../frontend/src/api/client";

const original: Item = { id: "camera", name: "相机", aliases: ["摄影机"], notes: "私人备注", quantity: 1, compartment_id: "cp", room_id: "r", container_id: "c", photo_url: null, location_path: ["书房", "白柜", "顶层"], version: 2, location_status: "confirmed", last_confirmed_at: null, updated_at: "2026-11-07T00:00:00Z", archived_at: null, archive_reason: null };
let server: Item;
let clipboard: string[];
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } }); }
function setClipboard(writeText: (value: string) => Promise<void>) { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } }); }
function detail(initial = original) { return createElement(ItemDetail, { initial, onClose() {}, onUpdated() {}, onLocate() {} }); }
async function ready() {
  await waitFor(() => expect((screen.getByRole("button", { name: "复制物品链接" }) as HTMLButtonElement).disabled).toBe(false));
}
function link() { return screen.getByLabelText("物品链接") as HTMLInputElement; }
beforeEach(() => {
  vi.stubEnv("BASE_URL", "/wuwei/");
  server = { ...original }; clipboard = [];
  setClipboard(async value => { clipboard.push(value); });
  vi.stubGlobal("fetch", async (input: string) => {
    return json(input.includes("/events") ? { events: [], has_more: false } : { item: server });
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

// Copying an unverified list snapshot can advertise a removed or inaccessible record.
it("disables copying until the server verifies the item, then copies only its canonical ID link", async () => {
  let finishRead!: (value: Response) => void;
  vi.stubGlobal("fetch", async (input: string) => new URL(input, window.location.origin).pathname.endsWith("/events")
    ? json({ events: [], has_more: false }) : new Promise<Response>(resolve => { finishRead = resolve; }));
  render(detail());
  expect((screen.getByRole("button", { name: "复制物品链接" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "复制物品链接" }));
  expect(clipboard).toEqual([]);
  await act(async () => { finishRead(json({ item: server })); });
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "复制物品链接" }));
  await screen.findByText("物品链接已复制");
  expect(clipboard).toEqual(["https://bd-a.tail3c54de.ts.net/wuwei/items/camera"]);
});

// The original URL, credentials, query text and item fields must never enter the shared URL.
it("exposes a selectable read-only link without current-page query text or credentials", async () => {
  server = { ...original, id: "photo_123-abc" };
  render(detail(server)); await ready();
  fireEvent.click(screen.getByRole("button", { name: "链接选项" }));
  expect(link().value).toBe("https://bd-a.tail3c54de.ts.net/wuwei/items/photo_123-abc");
  expect(link().readOnly).toBe(true);
  fireEvent.focus(link());
  expect(link().selectionStart).toBe(0); expect(link().selectionEnd).toBe(link().value.length);
  expect(screen.getByText(/仍需登录本家庭账号/)).toBeTruthy();
});

// Unsafe or unsupported IDs must not generate a link which resolves as a different route.
it.each(["../other", "photo / #?中文", "", "x".repeat(129)])("does not share unsupported item ID %s", async id => {
  server = { ...original, id };
  render(detail(server));
  await waitFor(() => expect((screen.getByRole("button", { name: "编辑资料" }) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByRole("button", { name: "复制物品链接" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "复制物品链接" }));
  expect(clipboard).toEqual([]);
});

// A root deployment must not acquire a second slash or accidentally use the current /find path.
it("shares a valid item from a root deployment", async () => {
  vi.stubEnv("BASE_URL", "/");
  render(detail()); await ready();
  fireEvent.click(screen.getByRole("button", { name: "复制物品链接" }));
  await screen.findByText("物品链接已复制");
  expect(clipboard).toEqual(["https://bd-a.tail3c54de.ts.net/items/camera"]);
});

// Invalid deployment bases must not redirect a copied link to another host or outside the app.
it.each(["//evil.test/", "/wuwei/../", "/wuwei/%2e%2e/", "/wuwei/\\evil/"])('does not share from invalid base %s', async base => {
  vi.stubEnv("BASE_URL", base);
  render(detail());
  await waitFor(() => expect((screen.getByRole("button", { name: "编辑资料" }) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByRole("button", { name: "复制物品链接" }) as HTMLButtonElement).disabled).toBe(true);
  expect(clipboard).toEqual([]);
});

// Denied clipboard permission must not report success or hide the only manual-copy fallback.
it("opens and selects the manual-copy link when clipboard access is denied", async () => {
  setClipboard(async () => { throw new Error("denied"); });
  render(detail()); await ready();
  fireEvent.click(screen.getByRole("button", { name: "复制物品链接" }));
  await screen.findByText("复制未成功，请长按或选中链接复制。");
  expect(screen.queryByText("物品链接已复制")).toBeNull();
  expect(document.activeElement).toBe(link());
  expect(link().selectionStart).toBe(0); expect(link().selectionEnd).toBe(link().value.length);
});

// A delayed clipboard result describes the old entry point, not the newly selected public link.
it("ignores a late copy result after changing the entry point and copies the new choice", async () => {
  let finishCopy!: () => void;
  setClipboard(value => { clipboard.push(value); return new Promise<void>(resolve => { finishCopy = resolve; }); });
  render(detail()); await ready();
  fireEvent.click(screen.getByRole("button", { name: "链接选项" }));
  fireEvent.click(screen.getByRole("button", { name: "复制物品链接" }));
  fireEvent.change(screen.getByLabelText("物品链接入口"), { target: { value: "public" } });
  await act(async () => { finishCopy(); });
  expect(screen.queryByText("物品链接已复制")).toBeNull();
  expect(link().value).toBe("https://bd-a.tail3c54de.ts.net:8443/wuwei/items/camera");
  setClipboard(async value => { clipboard.push(value); });
  fireEvent.click(screen.getByRole("button", { name: "复制物品链接" }));
  await screen.findByText("物品链接已复制");
  expect(clipboard).toEqual(["https://bd-a.tail3c54de.ts.net/wuwei/items/camera", "https://bd-a.tail3c54de.ts.net:8443/wuwei/items/camera"]);
});

// Failure of an obsolete copy must not select or report an error for the new entry point.
it("ignores a late copy failure after changing the entry point", async () => {
  let failCopy!: (error: Error) => void;
  setClipboard(() => new Promise<void>((_resolve, reject) => { failCopy = reject; }));
  render(detail()); await ready();
  fireEvent.click(screen.getByRole("button", { name: "链接选项" }));
  fireEvent.click(screen.getByRole("button", { name: "复制物品链接" }));
  fireEvent.change(screen.getByLabelText("物品链接入口"), { target: { value: "tailnet" } });
  await act(async () => { failCopy(new Error("denied")); });
  expect(screen.queryByText("复制未成功，请长按或选中链接复制。")).toBeNull();
});

// A previous item's pending clipboard write must not label a different item as copied.
it("resets the share status and disables copying while a newly selected item is being verified", async () => {
  let finishCopy!: () => void;
  setClipboard(() => new Promise<void>(resolve => { finishCopy = resolve; }));
  const view = render(detail()); await ready();
  fireEvent.click(screen.getByRole("button", { name: "复制物品链接" }));
  server = { ...original, id: "charger", name: "充电器" };
  let finishRead!: (value: Response) => void;
  vi.stubGlobal("fetch", async (input: string) => new URL(input, window.location.origin).pathname.endsWith("/events")
    ? json({ events: [], has_more: false }) : new Promise<Response>(resolve => { finishRead = resolve; }));
  view.rerender(detail(server));
  expect((screen.getByRole("button", { name: "复制物品链接" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { finishCopy(); finishRead(json({ item: server })); }); await ready();
  expect(screen.queryByText("物品链接已复制")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "链接选项" }));
  expect(link().value).toBe("https://bd-a.tail3c54de.ts.net/wuwei/items/charger");
});

// Archived items retain their private history and must keep the same usable share link.
it("permits a verified archived item to be shared", async () => {
  server = { ...original, archived_at: "2026-11-07T01:00:00Z", compartment_id: null };
  render(detail(server)); await ready();
  fireEvent.click(screen.getByRole("button", { name: "复制物品链接" }));
  await screen.findByText("物品链接已复制");
  expect(clipboard).toEqual(["https://bd-a.tail3c54de.ts.net/wuwei/items/camera"]);
});

// A failed latest-record fetch must not permit a stale list entry to be shared.
it("keeps copying disabled when the current record cannot be verified", async () => {
  vi.stubGlobal("fetch", async () => json({ error: { message: "记录不可用" } }, 404));
  render(detail());
  await screen.findByRole("button", { name: "重新加载记录" });
  expect((screen.getByRole("button", { name: "复制物品链接" }) as HTMLButtonElement).disabled).toBe(true);
  expect(clipboard).toEqual([]);
});
