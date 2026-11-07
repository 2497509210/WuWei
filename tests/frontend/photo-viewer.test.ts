// @vitest-environment jsdom
import { createElement, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ItemDetail } from "../../frontend/src/components/ItemDetail";
import type { Item } from "../../frontend/src/api/client";

const item: Item = { id: "camera", name: "相机", aliases: [], notes: "", quantity: 1, compartment_id: "cp", room_id: "r", container_id: "c", photo_url: "/api/items/camera/photo?v=2", thumbnail_url: "/api/items/camera/photo?variant=thumbnail&v=2", location_path: ["书房", "顶层"], version: 2, location_status: "confirmed", last_confirmed_at: null, updated_at: "2026-11-06T00:00:00Z", archived_at: null, archive_reason: null };
let current: Item;
beforeEach(() => {
  current = item;
  vi.stubGlobal("fetch", async (input: string) => new Response(JSON.stringify(new URL(String(input), "http://localhost").pathname.endsWith("/events") ? { events: [], has_more: false } : { item: current }), { headers: { "Content-Type": "application/json" } }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// Safari pointer activation does not necessarily focus the clicked button.
it("restores the explicit photo trigger even when pointer activation did not focus it", async () => {
  render(createElement(ItemDetail, { initial: item, onClose() {}, onUpdated() {}, onLocate() {} }));
  await screen.findByRole("button", { name: "编辑资料" });
  fireEvent.click(screen.getByRole("button", { name: "编辑资料" }));
  const notes = screen.getByLabelText("备注"); notes.focus();
  const trigger = screen.getByRole("button", { name: "查看照片" });
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("button", { name: "关闭照片" }));
  expect(document.activeElement).toBe(trigger);
});
async function detail() {
  function Shell() { const [open, setOpen] = useState(true); return open ? createElement(ItemDetail, { initial: current, onClose: () => setOpen(false), onUpdated() {}, onLocate() {} }) : null; }
  render(createElement(Shell));
  await waitFor(() => expect((screen.getByRole("button", { name: "编辑资料" }) as HTMLButtonElement).disabled).toBe(false));
}
function openPhoto() {
  const button = screen.getByRole("button", { name: "查看照片" }); button.focus(); fireEvent.click(button);
  return screen.getByRole("dialog", { name: "相机照片查看" });
}
function loaded(viewer: HTMLElement) {
  const image = within(viewer).getByAltText("相机原图");
  fireEvent.load(image); return image;
}
function pointer(node: Element, type: string, id: number, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(event, "pointerId", { value: id }); Object.defineProperty(event, "pointerType", { value: "touch" });
  fireEvent(node, event);
}

// The full viewer must use the protected original, and keyboard/button zoom must stay bounded.
it("opens the authenticated original and supports bounded zoom, keyboard controls, and reset", async () => {
  await detail(); const viewer = openPhoto(); const image = loaded(viewer);
  expect(image.getAttribute("src")).toBe("/api/items/camera/photo?v=2");
  fireEvent.click(within(viewer).getByRole("button", { name: "放大" }));
  expect(within(viewer).getByLabelText("缩放比例").textContent).toBe("150%");
  fireEvent.keyDown(viewer, { key: "+" }); expect(within(viewer).getByLabelText("缩放比例").textContent).toBe("200%");
  fireEvent.keyDown(viewer, { key: "-" }); expect(within(viewer).getByLabelText("缩放比例").textContent).toBe("150%");
  for (let index = 0; index < 12; index++) fireEvent.keyDown(viewer, { key: "+" });
  expect(within(viewer).getByLabelText("缩放比例").textContent).toBe("400%");
  fireEvent.click(within(viewer).getByRole("button", { name: "重置缩放" }));
  expect(within(viewer).getByLabelText("缩放比例").textContent).toBe("100%");
  expect((within(viewer).getByRole("button", { name: "缩小" }) as HTMLButtonElement).disabled).toBe(true);
});

// Closing a nested photo must leave the parent's dirty edit open and return keyboard focus to its trigger.
it("closes only the viewer on Escape without prompting to discard the item draft", async () => {
  await detail(); fireEvent.click(screen.getByRole("button", { name: "编辑资料" }));
  fireEvent.change(screen.getByLabelText("备注"), { target: { value: "未保存的草稿" } });
  vi.spyOn(window, "confirm").mockReturnValue(false);
  const viewer = openPhoto(); loaded(viewer); fireEvent.keyDown(viewer, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "相机照片查看" })).toBeNull();
  expect((screen.getByLabelText("备注") as HTMLTextAreaElement).value).toBe("未保存的草稿");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "查看照片" }));
  expect(window.confirm).not.toHaveBeenCalled();
  const unload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(true);
});

// Failed originals must be explicitly retryable without falling back to a public or thumbnail URL.
it("offers a retry after image failure and loads the same protected photo again", async () => {
  await detail(); const viewer = openPhoto(); const first = within(viewer).getByAltText("相机原图");
  fireEvent.error(first); expect(within(viewer).getByRole("alert").textContent).toMatch(/无法加载/);
  fireEvent.click(within(viewer).getByRole("button", { name: "重新加载照片" }));
  const second = within(viewer).getByAltText("相机原图");
  expect(second).not.toBe(first); expect(second.getAttribute("src")).toMatch(/^\/api\/items\/camera\/photo\?v=2&/);
  fireEvent.load(second); expect(within(viewer).queryByRole("alert")).toBeNull();
});

// Touch movement must affect the rendered image, while reset also removes the accumulated pan.
it("supports a two-finger pinch followed by a one-finger drag", async () => {
  await detail(); const viewer = openPhoto(); const image = loaded(viewer) as HTMLImageElement;
  const stage = within(viewer).getByLabelText("照片缩放区域");
  vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON() {} });
  Object.defineProperty(image, "naturalWidth", { value: 1200 }); Object.defineProperty(image, "naturalHeight", { value: 900 });
  pointer(stage, "pointerdown", 1, 300, 300); pointer(stage, "pointerdown", 2, 500, 300); pointer(stage, "pointermove", 2, 700, 300);
  expect(within(viewer).getByLabelText("缩放比例").textContent).toBe("200%");
  pointer(stage, "pointerup", 2, 700, 300); const pinched = image.style.transform;
  pointer(stage, "pointermove", 1, 350, 330); expect(image.style.transform).not.toBe(pinched);
  pointer(stage, "pointerup", 1, 350, 330);
  fireEvent.click(within(viewer).getByRole("button", { name: "重置缩放" }));
  expect(image.style.transform).toBe("translate(0px, 0px) scale(1)");
});

// Rotating a phone changes the available pan range and must not leave the photo beyond its new edge.
it("clamps the existing pan again when the viewport changes", async () => {
  await detail(); const viewer = openPhoto(); const image = loaded(viewer) as HTMLImageElement;
  const stage = within(viewer).getByLabelText("照片缩放区域");
  let width = 800;
  vi.spyOn(stage, "getBoundingClientRect").mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: 600, width, height: 600, toJSON() {} }));
  Object.defineProperty(image, "naturalWidth", { value: 1200 }); Object.defineProperty(image, "naturalHeight", { value: 900 });
  fireEvent.keyDown(viewer, { key: "+" }); fireEvent.keyDown(viewer, { key: "+" });
  pointer(stage, "pointerdown", 1, 300, 300); pointer(stage, "pointermove", 1, 900, 300); pointer(stage, "pointerup", 1, 900, 300);
  expect(image.style.transform).toBe("translate(400px, 0px) scale(2)");
  width = 1200; fireEvent(window, new Event("resize"));
  expect(image.style.transform).toBe("translate(200px, 0px) scale(2)");
});

// Empty photos cannot expose a broken full-screen button.
it("has no viewer trigger when the item has no photo", async () => {
  current = { ...item, photo_url: null, thumbnail_url: null }; await detail();
  expect(screen.queryByRole("button", { name: "查看照片" })).toBeNull();
});
