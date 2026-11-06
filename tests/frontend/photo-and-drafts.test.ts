// @vitest-environment jsdom
import { createElement, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ItemDetail } from "../../frontend/src/components/ItemDetail";
import { QuickRegisterDialog } from "../../frontend/src/components/QuickRegisterDialog";
import { RegisterDialog } from "../../frontend/src/components/RegisterDialog";
import { Modal } from "../../frontend/src/components/Modal";
import { FakeXHR, installFakeXHR } from "./helpers/fake-xhr";
import type { Item } from "../../frontend/src/api/client";

const me = { user: { id: "u", username: "owner", display_name: "家人", role: "owner" as const }, household: { id: "h", name: "我家" } };
const item: Item = { id: "camera", name: "相机", aliases: [], notes: "旧备注", quantity: 1, compartment_id: "cp", room_id: "r", container_id: "c", photo_url: "/original.jpg", location_path: ["书房", "白柜", "顶层"], version: 2, location_status: "confirmed", last_confirmed_at: null, updated_at: "2026-11-06T00:00:00Z", archived_at: null, archive_reason: null };
const current = { ...item, name: "新名称", notes: "家人改了备注", version: 3 };
type Handler = (url: URL, init: RequestInit) => Promise<Response> | Response;
let handler: Handler;
let saved: Item | null;
const getContext = HTMLCanvasElement.prototype.getContext;
const toBlob = HTMLCanvasElement.prototype.toBlob;
function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }); }
function normal(url: URL) {
  if (url.pathname.endsWith("/events")) return json({ events: [], has_more: false });
  if (url.pathname.endsWith("/bootstrap")) return json({ ...me, floors: [] });
  return json({ item });
}
beforeEach(() => {
  saved = null; handler = url => normal(url);
  vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => Promise.resolve(handler(new URL(url, "http://localhost"), init)));
  installFakeXHR();
  vi.stubGlobal("createImageBitmap", async () => ({ width: 4000, height: 3000, close() {} }));
  HTMLCanvasElement.prototype.getContext = (() => ({ fillStyle: "", fillRect() {}, drawImage() {} })) as typeof getContext;
  HTMLCanvasElement.prototype.toBlob = callback => callback(new Blob([new Uint8Array(100_000)], { type: "image/jpeg" }));
  vi.stubGlobal("URL", class extends URL { static createObjectURL() { return "blob:prepared-photo"; } static revokeObjectURL() {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); HTMLCanvasElement.prototype.getContext = getContext; HTMLCanvasElement.prototype.toBlob = toBlob; });
async function detail() {
  function Shell() { const [open, setOpen] = useState(true); return open ? createElement(ItemDetail, { initial: item, onClose: () => setOpen(false), onUpdated: value => { saved = value; }, onLocate() {} }) : createElement("p", null, "已关闭"); }
  render(createElement(Shell));
  await waitFor(() => expect((screen.getByRole("button", { name: "编辑资料" }) as HTMLButtonElement).disabled).toBe(false));
}
function bigPhoto() { const bytes = new Uint8Array(12 * 1024 * 1024); bytes.set([137,80,78,71,13,10,26,10]); return new File([bytes], "camera.png", { type: "image/png" }); }

// The replacement flow must prepare large local photos and retain one operation across uncertain retries.
it("prepares a 12 MiB replacement, exposes progress, and retries the same pending photo after cancellation", async () => {
  await detail(); fireEvent.change(screen.getByLabelText("物品照片"), { target: { files: [bigPhoto()] } });
  await screen.findByRole("img", { name: "待上传照片预览" });
  expect(FakeXHR.instances).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "保存照片" }));
  const first = FakeXHR.latest;
  expect((first.body as FormData).get("image")).toBeInstanceOf(File);
  expect(((first.body as FormData).get("image") as File).size).toBe(100_000);
  act(() => first.emitUploadProgress(50_000, 100_000, true));
  expect(screen.getByRole("progressbar").getAttribute("value")).toBe("50");
  fireEvent.click(screen.getByRole("button", { name: "取消上传" }));
  await screen.findByText(/尚未确认保存结果/);
  expect(first.aborted).toBe(true);
  expect(screen.getByRole("img", { name: "待上传照片预览" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存照片" }));
  const retry = FakeXHR.latest;
  expect((retry.body as FormData).get("operation_id")).toBe((first.body as FormData).get("operation_id"));
  expect((retry.body as FormData).get("expected_version")).toBe("2");
  expect((retry.body as FormData).get("image")).toBe((first.body as FormData).get("image"));
  await act(async () => retry.respond(200, { item: { ...item, version: 3 } }));
  await screen.findByText("照片已保存");
  expect(saved?.version).toBe(3);
  expect(screen.queryByRole("img", { name: "待上传照片预览" })).toBeNull();
});

// The prepared photo survives a conflicting family edit; accepting the new version is a separate action.
it("keeps a conflicting replacement pending until the latest version is explicitly accepted", async () => {
  await detail(); fireEvent.change(screen.getByLabelText("物品照片"), { target: { files: [bigPhoto()] } });
  await screen.findByRole("img", { name: "待上传照片预览" });
  fireEvent.click(screen.getByRole("button", { name: "保存照片" }));
  const first = FakeXHR.latest;
  await act(async () => first.respond(409, { error: { code: "version_conflict", message: "物品已被更新", current } }));
  await screen.findByText("家人改了备注");
  expect(screen.getByRole("img", { name: "待上传照片预览" })).toBeTruthy();
  expect((screen.getByRole("button", { name: "保存照片" }) as HTMLButtonElement).disabled).toBe(true);
  expect(FakeXHR.instances).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "核对后继续换图" }));
  fireEvent.click(screen.getByRole("button", { name: "保存照片" }));
  const retry = FakeXHR.latest;
  expect((retry.body as FormData).get("expected_version")).toBe("3");
  expect((retry.body as FormData).get("operation_id")).not.toBe((first.body as FormData).get("operation_id"));
  expect((retry.body as FormData).get("image")).toBe((first.body as FormData).get("image"));
  await act(async () => retry.respond(200, { item: { ...current, version: 4 } }));
  await screen.findByText("照片已保存");
});

// An archive conflict must not offer a mode switch that unmounts and silently drops the retained photo.
it("keeps the pending photo visible after an archive conflict until it is deliberately discarded", async () => {
  await detail(); fireEvent.change(screen.getByLabelText("物品照片"), { target: { files: [bigPhoto()] } });
  await screen.findByRole("img", { name: "待上传照片预览" });
  fireEvent.click(screen.getByRole("button", { name: "保存照片" }));
  await act(async () => FakeXHR.latest.respond(409, { error: { code: "version_conflict", message: "已归档", current: { ...current, archived_at: "2026-11-06T01:00:00Z", archive_reason: "家人归档" } } }));
  await screen.findByText("家人归档");
  expect(screen.getByRole("img", { name: "待上传照片预览" })).toBeTruthy();
  expect((screen.getByRole("button", { name: "恢复物品" }) as HTMLButtonElement).disabled).toBe(true);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "放弃所选照片" }));
  expect(screen.queryByRole("img", { name: "待上传照片预览" })).toBeNull();
  expect((screen.getByRole("button", { name: "恢复物品" }) as HTMLButtonElement).disabled).toBe(false);
});

// A user cannot type changes during an in-flight save which would otherwise be silently discarded on success.
it("freezes edit fields while the server is saving", async () => {
  handler = (url, init) => init.method === "PATCH" ? new Promise(() => {}) : normal(url);
  await detail(); fireEvent.click(screen.getByRole("button", { name: "编辑资料" }));
  fireEvent.change(screen.getByLabelText("备注"), { target: { value: "正在保存的内容" } });
  fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
  expect((screen.getByLabelText("备注") as HTMLTextAreaElement).matches(":disabled")).toBe(true);
});

// After a conflicting archive the typed edit must remain available for copying and cannot overwrite an archived item.
it("retains an edit if another family member archived the item", async () => {
  handler = (url, init) => init.method === "PATCH" ? json({ error: { code: "version_conflict", message: "已归档", current: { ...current, archived_at: "2026-11-06T01:00:00Z", archive_reason: "家人归档" } } }, 409) : normal(url);
  await detail(); fireEvent.click(screen.getByRole("button", { name: "编辑资料" }));
  fireEvent.change(screen.getByLabelText("备注"), { target: { value: "要保留的草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
  await screen.findByText("家人归档");
  expect((screen.getByLabelText("备注") as HTMLTextAreaElement).value).toBe("要保留的草稿");
  expect((screen.getByRole("button", { name: "保存资料" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "核对后继续编辑" }) as HTMLButtonElement).disabled).toBe(true);
});

// Abandoning the archive form is distinct from confirming the archive, and must respect a cancelled discard.
it("protects an archive reason from both cancelling the form and closing the detail", async () => {
  await detail(); fireEvent.click(screen.getByRole("button", { name: "归档物品" }));
  fireEvent.change(screen.getByLabelText("归档原因（选填）"), { target: { value: "想保留的原因" } });
  vi.spyOn(window, "confirm").mockReturnValue(false);
  fireEvent.click(screen.getByRole("button", { name: "取消", exact: true }));
  expect((screen.getByLabelText("归档原因（选填）") as HTMLTextAreaElement).value).toBe("想保留的原因");
  fireEvent.click(screen.getByRole("button", { name: "关闭对话框" }));
  expect((screen.getByLabelText("归档原因（选填）") as HTMLTextAreaElement).value).toBe("想保留的原因");
});

// Refreshing the server version must not erase unsaved fields or silently submit against that version.
it("retains an edit on conflict and requires explicit confirmation against the latest item", async () => {
  let writes = 0;
  handler = (url, init) => {
    if (init.method === "PATCH") {
      writes++; const body = JSON.parse(String(init.body));
      if (writes === 1) return json({ error: { code: "version_conflict", message: "物品已被更新", current } }, 409);
      if (body.expected_version !== 3 || body.notes !== "我还没保存的备注") return json({ error: { message: "incorrect overwrite" } }, 400);
      return json({ item: { ...current, ...body, version: 4 } });
    }
    return normal(url);
  };
  await detail(); fireEvent.click(screen.getByRole("button", { name: "编辑资料" }));
  fireEvent.change(screen.getByLabelText("备注"), { target: { value: "我还没保存的备注" } });
  fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
  await screen.findAllByText("家人改了备注");
  expect((screen.getByLabelText("备注") as HTMLTextAreaElement).value).toBe("我还没保存的备注");
  expect((screen.getByRole("button", { name: "保存资料" }) as HTMLButtonElement).disabled).toBe(true);
  expect(writes).toBe(1);
  fireEvent.click(screen.getByRole("radio", { name: "备注：保留我的修改" }));
  fireEvent.click(screen.getByRole("button", { name: "核对后继续编辑" }));
  fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
  await screen.findByText("资料已保存");
  expect(writes).toBe(2); expect(saved?.notes).toBe("我还没保存的备注");
});

// Closing or refreshing a dirty form must be guarded, while cancelling the prompt keeps the typed content.
it("protects detail edits from close and page refresh and removes the guard after saving", async () => {
  handler = (url, init) => init.method === "PATCH" ? json({ item: { ...item, notes: "未保存", version: 3 } }) : normal(url);
  await detail(); fireEvent.click(screen.getByRole("button", { name: "编辑资料" }));
  fireEvent.change(screen.getByLabelText("备注"), { target: { value: "未保存" } });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  fireEvent.click(screen.getByRole("button", { name: "关闭对话框" }));
  expect((screen.getByLabelText("备注") as HTMLTextAreaElement).value).toBe("未保存");
  const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "保存资料" })); await screen.findByText("资料已保存");
  const after = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(after); expect(after.defaultPrevented).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "关闭对话框" })); expect(screen.getByText("已关闭")).toBeTruthy();
  expect(confirm).toHaveBeenCalledTimes(1);
});

// Batch and quick forms must use the same protection without persisting private values.
it.each(["register", "capture"])("protects typed %s input on Escape without storing it", async kind => {
  function Shell() { const [open, setOpen] = useState(true); return !open ? null : kind === "register" ? createElement(RegisterDialog, { me, onClose: () => setOpen(false), onSaved() {} }) : createElement(QuickRegisterDialog, { me, onClose: () => setOpen(false), onSaved() {} }); }
  render(createElement(Shell));
  const label = kind === "register" ? "物品名称，每行一件或一组" : "物品名称";
  fireEvent.change(screen.getByLabelText(label), { target: { value: "私人物品" } });
  vi.spyOn(window, "confirm").mockReturnValue(false);
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe("私人物品");
  expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
});

// Untouched forms should remain one-click dismissible.
it("closes a clean modal without a confirmation", () => {
  function Shell() { const [open, setOpen] = useState(true); return open ? createElement(Modal, { title: "空表单", onClose: () => setOpen(false), children: "内容" }) : null; }
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  render(createElement(Shell)); fireEvent.click(screen.getByRole("button", { name: "关闭对话框" }));
  expect(screen.queryByRole("dialog")).toBeNull(); expect(confirm).not.toHaveBeenCalled();
});
