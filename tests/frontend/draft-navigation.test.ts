// @vitest-environment jsdom
import { createElement, StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../../frontend/src/App";
import { request } from "../../frontend/src/api/client";
import { useWorkspace } from "../../frontend/src/store/useWorkspace";
import { FakeXHR, installFakeXHR } from "./helpers/fake-xhr";
import { createBrowserRouter, RouterProvider, useLocation, useNavigate } from "../../frontend/node_modules/react-router-dom/dist/index.mjs";
import { Modal } from "../../frontend/src/components/Modal";
import { activateSession, invalidateSession } from "../../frontend/src/api/sessionEvents";

const me = { user: { id: "u", username: "owner", display_name: "家人", role: "owner" }, household: { id: "h", name: "我家" } };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
beforeEach(() => {
  sessionStorage.clear(); window.history.replaceState(null, "", "/");
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  installFakeXHR();
  vi.stubGlobal("fetch", async (path: string) => {
    if (path.endsWith("/setup/status")) return reply({ needed: false });
    if (path.endsWith("/api/me")) return reply(me);
    if (path.endsWith("/bootstrap")) return reply({ ...me, floors: window.location.pathname === "/" ? [] : [{ id: "f", rooms: [{ id: "r", name: "书房" }] }] });
    if (path.endsWith("/rooms/r")) return reply({ room: { id: "r", name: "书房" }, containers: [{ id: "c", name: "白柜", compartments: [{ id: "cp", name: "顶层" }] }] });
    if (path.endsWith("/protected")) return reply({ error: { code: "not_authenticated", message: "请先登录" } }, 401);
    return reply({ items: [], total: 0, page: 1, page_size: 40, has_more: false });
  });
});
afterEach(() => { cleanup(); useWorkspace.getState().reset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); window.history.replaceState(null, "", "/"); });
async function openDraft(strict = false) {
  render(strict ? createElement(StrictMode, null, createElement(App)) : createElement(App));
  fireEvent.click(await screen.findByRole("button", { name: "家庭找物", exact: true }));
  fireEvent.click(await screen.findByRole("button", { name: "登记物品", exact: true }));
  fireEvent.change(screen.getByLabelText("物品名称，每行一件或一组"), { target: { value: "未保存的私人草稿" } });
}
async function back() { await act(async () => { window.history.back(); await new Promise(resolve => setTimeout(resolve, 50)); }); }

// Native SPA Back must consult the dirty form before React Router unmounts it.
it("keeps the page and draft when browser Back is cancelled, then leaves when confirmed", async () => {
  await openDraft(); const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await back();
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  expect(window.location.pathname).toBe("/find");
  expect((screen.getByLabelText("物品名称，每行一件或一组") as HTMLTextAreaElement).value).toBe("未保存的私人草稿");
  confirm.mockReturnValue(true); await back();
  await waitFor(() => expect(window.location.pathname).toBe("/"));
  expect(screen.queryByRole("dialog")).toBeNull();
});

// Authentication revocation must remove private drafts regardless of a pending discard preference.
it("clears a dirty form immediately when the session expires", async () => {
  await openDraft(); const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await act(async () => { await request("/protected").catch(() => {}); });
  await screen.findByRole("button", { name: "登录", exact: true });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(confirm).not.toHaveBeenCalled();
});

// Development StrictMode recreates effects; it must not leave the browser router disposed.
it("preserves browser history guards under StrictMode", async () => {
  await openDraft(true); const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await back();
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  expect(window.location.pathname).toBe("/find");
});

// Back during a pending write must not abort it or imply that the server operation was cancelled.
it("keeps an in-flight registration on the page until the user explicitly stops waiting", async () => {
  render(createElement(App)); fireEvent.click(await screen.findByRole("button", { name: "家庭找物", exact: true }));
  fireEvent.click(await screen.findByRole("button", { name: "拍照登记", exact: true }));
  fireEvent.change(screen.getByLabelText("物品名称"), { target: { value: "相机" } });
  await screen.findByRole("option", { name: "书房" }); fireEvent.change(screen.getByLabelText("房间"), { target: { value: "r" } });
  await screen.findByRole("option", { name: "白柜" }); fireEvent.change(screen.getByLabelText("容器"), { target: { value: "c" } });
  fireEvent.click(screen.getByRole("button", { name: "顶层" }));
  fireEvent.click(screen.getByRole("button", { name: "保存物品" }));
  const pending = FakeXHR.latest; expect(pending).toBeDefined();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  await back(); await waitFor(() => expect(window.location.pathname).toBe("/find"));
  expect(screen.getByRole("dialog", { name: "拍照登记" })).toBeTruthy();
  expect(pending.aborted).toBe(false); expect(confirm).not.toHaveBeenCalled();
  await act(async () => pending.fail());
  await back(); await waitFor(() => expect(window.location.pathname).toBe("/"));
  expect(screen.queryByRole("dialog")).toBeNull();
});

// A clean secondary dialog must not replace the dirty parent's single router blocker.
it("keeps the dirty guard active when a clean secondary modal is open", async () => {
  activateSession();
  function Shell() {
    const navigate = useNavigate(), location = useLocation();
    return location.pathname === "/" ? createElement("button", { onClick: () => navigate("/edit") }, "打开编辑")
      : createElement(Modal, { title: "编辑草稿", dirty: true, onClose() {}, children: createElement(Modal, { title: "只读标签", onClose() {}, children: "二维码" }) });
  }
  const router = createBrowserRouter([{ path: "*", element: createElement(Shell) }]);
  try {
    render(createElement(RouterProvider, { router })); fireEvent.click(screen.getByRole("button", { name: "打开编辑" }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await back(); await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(window.location.pathname).toBe("/edit");
    expect(screen.getByRole("dialog", { name: "编辑草稿" })).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "只读标签" })).toBeTruthy();
  } finally { cleanup(); router.dispose(); invalidateSession(); }
});
