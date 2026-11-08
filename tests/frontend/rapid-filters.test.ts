// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InventoryPage } from "../../frontend/src/pages/InventoryPage";
import type { Item } from "../../frontend/src/api/client";

const me = { user: { id: "owner", username: "owner", display_name: "家人", role: "owner" as const }, household: { id: "home", name: "我家" } };
const bedroom = { id: "bedroom", floor_id: "floor", name: "主卧", width_cm: 460, depth_cm: 360, height_cm: 260, wall_color: null, sort: 0, container_count: 1 };
const original: Item = { id: "target", name: "目标物品", aliases: [], notes: "", quantity: 1, compartment_id: "shelf", room_id: "bedroom", container_id: "cabinet", location_path: ["主卧", "衣柜", "顶层"], photo_url: null, version: 2, location_status: "missing", last_confirmed_at: null, updated_at: "2026-11-06T00:00:00Z", archived_at: null, archive_reason: null };
const items: Item[] = [
  original,
  { ...original, id: "confirmed", name: "目标已确认", location_status: "confirmed" },
  { ...original, id: "other-room", name: "目标书房", room_id: "study" },
  { ...original, id: "other-name", name: "其他物品" },
];
const reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  vi.stubGlobal("fetch", (input: string) => {
    const url = new URL(input, "http://localhost");
    if (url.pathname.endsWith("/bootstrap")) return Promise.resolve(reply({ ...me, floors: [{ id: "floor", name: "默认", level: 1, rooms: [bedroom, { ...bedroom, id: "study", name: "书房" }] }] }));
    if (url.pathname.endsWith("/events")) return Promise.resolve(reply({ events: [], has_more: false }));
    if (url.pathname.endsWith("/items")) {
      const filtered = items.filter(item => (!url.searchParams.get("q") || item.name.includes(url.searchParams.get("q")!))
        && (!url.searchParams.get("room_id") || item.room_id === url.searchParams.get("room_id"))
        && (!url.searchParams.get("location_status") || item.location_status === url.searchParams.get("location_status")));
      return Promise.resolve(reply({ items: filtered, total: filtered.length, page: 1, page_size: 40, has_more: false }));
    }
    throw new Error(`Unexpected request: ${url}`);
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// Replacing local state with a captured view would erase the earlier search and status in this batch.
it("retains every rapid filter change when inventory manages its own view", async () => {
  render(createElement(InventoryPage, { me, onLogout: async () => {}, onArrange() {} }));
  await screen.findByText("第 1–4 条，共 4 条");
  await screen.findByRole("option", { name: "主卧", exact: true });
  act(() => {
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "目标" } });
    fireEvent.click(screen.getByRole("button", { name: "待找回", exact: true }));
    fireEvent.change(screen.getByRole("combobox", { name: "筛选房间" }), { target: { value: "bedroom" } });
  });
  await screen.findByText("第 1–1 条，共 1 条");
  expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("目标");
  expect(screen.getByRole("button", { name: "待找回", exact: true }).getAttribute("aria-pressed")).toBe("true");
  expect((screen.getByRole("combobox", { name: "筛选房间" }) as HTMLSelectElement).value).toBe("bedroom");
  expect(screen.getByRole("button", { name: "查看目标物品", exact: true })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "查看目标已确认", exact: true })).toBeNull();
  expect(screen.queryByRole("button", { name: "查看目标书房", exact: true })).toBeNull();
  expect(screen.queryByRole("button", { name: "查看其他物品", exact: true })).toBeNull();
});
