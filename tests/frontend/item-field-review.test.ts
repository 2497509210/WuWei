// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ItemDetail } from "../../frontend/src/components/ItemDetail";
import type { Item } from "../../frontend/src/api/client";

const original: Item = { id: "camera", name: "相机", aliases: ["摄影机"], notes: "原备注", quantity: 1, compartment_id: "cp", room_id: "r", container_id: "c", photo_url: "/api/items/camera/photo?v=2", location_path: ["书房", "白柜", "顶层"], version: 2, location_status: "confirmed", last_confirmed_at: null, updated_at: "2026-11-06T00:00:00Z", archived_at: null, archive_reason: null };
let server: Item;
let writes: Record<string, unknown>[];
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } }); }
beforeEach(() => {
  server = { ...original }; writes = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const path = new URL(input, "http://localhost").pathname;
    if (path.endsWith("/events")) return json({ events: [], has_more: false });
    if (init.method === "PATCH") {
      const body = JSON.parse(String(init.body)); writes.push(body);
      if (body.expected_version !== server.version) return json({ error: { code: "version_conflict", message: "资料已更新", current: server } }, 409);
      server = { ...server, ...body, version: server.version + 1 }; return json({ item: server });
    }
    return json({ item: server });
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function edit() {
  render(createElement(ItemDetail, { initial: original, onClose() {}, onUpdated() {}, onLocate() {} }));
  await waitFor(() => expect((screen.getByRole("button", { name: "编辑资料" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "编辑资料" }));
}
function change(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }
function save() { fireEvent.click(screen.getByRole("button", { name: "保存资料" })); }
async function conflict() { save(); return screen.findByRole("region", { name: "资料更新冲突" }); }

// Sending untouched fields can overwrite a family member's update during a later conflict retry.
it("sends only changed fields and normalizes unchanged aliases", async () => {
  await edit(); change("备注", "我的备注"); change("别名（用顿号分隔）", " 摄影机、摄影机 "); save();
  await screen.findByText("资料已保存");
  expect(writes).toEqual([{ expected_version: 2, notes: "我的备注" }]);
});

// A non-overlapping edit must be rebased onto the server's quantity before the user retries.
it("adopts untouched server fields while preserving a changed note and requiring review", async () => {
  await edit(); change("备注", "我的备注"); server = { ...server, quantity: 7, name: "家人命名", version: 3 };
  const review = await conflict();
  expect((screen.getByLabelText("数量") as HTMLInputElement).value).toBe("7");
  expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe("家人命名");
  expect((screen.getByLabelText("备注") as HTMLTextAreaElement).value).toBe("我的备注");
  expect(within(review).queryAllByRole("radio")).toHaveLength(0);
  expect((screen.getByRole("button", { name: "保存资料" }) as HTMLButtonElement).disabled).toBe(true);
  expect(writes).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "核对后继续编辑" })); save();
  await screen.findByText("资料已保存");
  expect(writes[1]).toEqual({ expected_version: 3, notes: "我的备注" });
  expect(server.quantity).toBe(7); expect(server.name).toBe("家人命名");
});

// The same field edited differently on both sides cannot silently pick either value.
it("requires one choice per conflicting field and can retain the server's value", async () => {
  await edit(); change("备注", "我的备注"); change("名称", "我的名称");
  server = { ...server, notes: "家人备注", name: "家人名称", quantity: 8, version: 3 };
  const review = await conflict();
  expect(within(review).getByText("我的备注")).toBeTruthy(); expect(within(review).getByText("家人备注")).toBeTruthy();
  const proceed = screen.getByRole("button", { name: "核对后继续编辑" }) as HTMLButtonElement;
  expect(proceed.disabled).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "备注：使用最新值" })); expect(proceed.disabled).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "名称：保留我的修改" })); expect(proceed.disabled).toBe(false);
  fireEvent.click(proceed); save(); await screen.findByText("资料已保存");
  expect(writes[1]).toEqual({ expected_version: 3, name: "我的名称" });
  expect(server.notes).toBe("家人备注"); expect(server.quantity).toBe(8);
});

// Concurrent equal values are already reconciled; forcing a choice would invent a conflict.
it("does not ask for a field choice when both sides made the same change", async () => {
  await edit(); change("备注", "相同备注"); change("数量", "2");
  server = { ...server, notes: "相同备注", version: 3 };
  const review = await conflict(); expect(within(review).queryAllByRole("radio")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "核对后继续编辑" })); save(); await screen.findByText("资料已保存");
  expect(writes[1]).toEqual({ expected_version: 3, quantity: 2 });
});

// A second conflict must compare against the first reviewed version, without restoring discarded edits.
it("preserves earlier choices and rebases again when another update races the retry", async () => {
  await edit(); change("备注", "我的备注"); change("名称", "我的名称");
  server = { ...server, notes: "家人备注", name: "家人名称", version: 3 };
  await conflict();
  fireEvent.click(screen.getByRole("radio", { name: "备注：使用最新值" }));
  fireEvent.click(screen.getByRole("radio", { name: "名称：保留我的修改" }));
  fireEvent.click(screen.getByRole("button", { name: "核对后继续编辑" }));
  server = { ...server, notes: "家人再次备注", quantity: 9, version: 4 };
  await conflict();
  expect((screen.getByLabelText("备注") as HTMLTextAreaElement).value).toBe("家人再次备注");
  expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe("我的名称");
  expect(screen.queryAllByRole("radio")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "核对后继续编辑" })); save(); await screen.findByText("资料已保存");
  expect(writes[2]).toEqual({ expected_version: 4, name: "我的名称" }); expect(server.quantity).toBe(9);
});

// A new server value for the same field needs a new explicit decision, even if "mine" was chosen earlier.
it("asks again when the same field changes after the first review", async () => {
  await edit(); change("备注", "我的备注"); server = { ...server, notes: "家人备注", version: 3 };
  await conflict(); fireEvent.click(screen.getByRole("radio", { name: "备注：保留我的修改" }));
  fireEvent.click(screen.getByRole("button", { name: "核对后继续编辑" }));
  server = { ...server, notes: "更新的家人备注", version: 4 }; await conflict();
  expect((screen.getByRole("radio", { name: "备注：保留我的修改" }) as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole("button", { name: "核对后继续编辑" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText("备注") as HTMLTextAreaElement).value).toBe("我的备注");
  fireEvent.click(screen.getByRole("radio", { name: "备注：保留我的修改" }));
  fireEvent.click(screen.getByRole("button", { name: "核对后继续编辑" })); save(); await screen.findByText("资料已保存");
  expect(writes[2]).toEqual({ expected_version: 4, notes: "我的备注" });
});

// When a conflict response omits its current record and the follow-up read fails, reloading must still merge.
it("merges a later successful reload after the conflict's current-record request failed", async () => {
  await edit(); change("备注", "我的备注"); server = { ...server, quantity: 12, version: 3 };
  const normalFetch = globalThis.fetch; let failRead = true;
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    if (init.method === "PATCH") return json({ error: { code: "version_conflict", message: "资料已更新" } }, 409);
    if (!new URL(input, "http://localhost").pathname.endsWith("/events") && failRead) return json({ error: { message: "暂时断线" } }, 503);
    return normalFetch(input, init);
  });
  save(); await screen.findByRole("button", { name: "重新加载记录" });
  expect((screen.getByRole("button", { name: "核对后继续编辑" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText("备注") as HTMLTextAreaElement).value).toBe("我的备注");
  failRead = false; fireEvent.click(screen.getByRole("button", { name: "重新加载记录" }));
  await waitFor(() => expect((screen.getByLabelText("数量") as HTMLInputElement).value).toBe("12"));
  fireEvent.click(screen.getByRole("button", { name: "核对后继续编辑" })); vi.stubGlobal("fetch", normalFetch);
  save(); await screen.findByText("资料已保存");
  expect(writes[0]).toEqual({ expected_version: 3, notes: "我的备注" }); expect(server.quantity).toBe(12);
});
