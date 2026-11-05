// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../../frontend/src/App";
import { request } from "../../frontend/src/api/client";
import { useWorkspace } from "../../frontend/src/store/useWorkspace";

const me = { user: { id: "u", username: "owner", display_name: "家人", role: "owner" }, household: { id: "h", name: "我家" } };
const reply = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let signedIn: boolean;
beforeEach(() => { signedIn = true; window.history.replaceState(null, "", "/find?compartment=cp"); });
afterEach(() => { cleanup(); useWorkspace.getState().reset(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });
function normal(path: string, init: RequestInit) {
  if (path.endsWith("/setup/status")) return reply({ needed: false });
  if (path.endsWith("/api/me")) return signedIn ? reply(me) : reply({ error: { code: "not_authenticated", message: "请先登录" } }, 401);
  if (path.includes("/items?")) return reply({ items: [] });
  if (path.endsWith("/auth/login") && init.method === "POST") { signedIn = true; return reply({ user: me.user }); }
  if (path.endsWith("/auth/logout")) { signedIn = false; return reply(null, 204); }
  if (path.endsWith("/bootstrap")) return reply({ ...me, floors: [] });
  throw new Error(`Unexpected request ${path}`);
}

it("expires the active session once and returns to the same filtered location after login", async () => {
  vi.stubGlobal("fetch", async (path: string, init: RequestInit = {}) => path.endsWith("/protected")
    ? reply({ error: { code: "not_authenticated", message: "请先登录" } }, 401) : normal(path, init));
  render(createElement(App));
  await screen.findByRole("searchbox");
  await act(async () => { signedIn = false; await Promise.all([request("/protected").catch(() => {}), request("/protected").catch(() => {})]); });
  await screen.findByText("登录已失效，请重新登录");
  expect(window.location.pathname + window.location.search).toBe("/find?compartment=cp");
  expect(screen.queryByRole("searchbox")).toBeNull();
  fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "owner" } });
  fireEvent.change(screen.getByLabelText("密码"), { target: { value: "password123" } });
  fireEvent.click(screen.getByRole("button", { name: "登录", exact: true }));
  await screen.findByRole("searchbox");
  expect(window.location.pathname + window.location.search).toBe("/find?compartment=cp");
});

it("does not let a protected response from the previous session sign out a new login", async () => {
  let finish: ((response: Response) => void) | undefined;
  vi.stubGlobal("fetch", (path: string, init: RequestInit = {}) => path.endsWith("/slow-protected")
    ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(normal(path, init)));
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  render(createElement(App)); await screen.findByRole("searchbox");
  const pending = request("/slow-protected").catch(() => {});
  fireEvent.click(screen.getByRole("button", { name: "退出", exact: true }));
  await screen.findByRole("button", { name: "登录", exact: true });
  fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "owner" } });
  fireEvent.change(screen.getByLabelText("密码"), { target: { value: "password123" } });
  fireEvent.click(screen.getByRole("button", { name: "登录", exact: true }));
  await screen.findByRole("button", { name: "账号与家庭" });
  await act(async () => { finish!(reply({ error: { code: "not_authenticated", message: "请先登录" } }, 401)); await pending; });
  expect(screen.queryByRole("button", { name: "登录", exact: true })).toBeNull();
  expect(screen.queryByText("登录已失效，请重新登录")).toBeNull();
});

it("ignores an aborted account read while password change returns its specific logout notice", async () => {
  window.history.replaceState(null, "", "/settings");
  let deviceRead: ((response: Response) => void) | undefined;
  let passwordWrite: ((response: Response) => void) | undefined;
  vi.stubGlobal("fetch", (path: string, init: RequestInit = {}) => {
    if (path.endsWith("/account/devices")) return new Promise(resolve => { deviceRead = resolve; });
    if (path.endsWith("/household/members")) return Promise.resolve(reply({ members: [] }));
    if (path.endsWith("/household/invites")) return Promise.resolve(reply({ invites: [] }));
    if (path.endsWith("/account/password")) return new Promise(resolve => { passwordWrite = resolve; });
    return Promise.resolve(normal(path, init));
  });
  render(createElement(App)); await screen.findByLabelText("当前密码");
  await waitFor(() => expect(deviceRead).toBeDefined());
  fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: "password123" } });
  fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "newpassword123" } });
  fireEvent.change(screen.getByLabelText("确认新密码"), { target: { value: "newpassword123" } });
  fireEvent.click(screen.getByRole("button", { name: "修改密码并退出" }));
  await act(async () => { deviceRead!(reply({ error: { code: "not_authenticated" } }, 401)); passwordWrite!(reply(null, 204)); });
  await screen.findByText("密码已修改，请重新登录");
});
