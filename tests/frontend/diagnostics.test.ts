// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { ApiError, request } from "../../frontend/src/api/client";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("sends a diagnostic id and exposes the server id without dropping conflict details", async () => {
  let sent = "";
  const id = "a1".repeat(16);
  const current = { id: "r", floor_id: "f", version: 4 };
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    sent = new Headers(init.headers).get("X-Request-ID") ?? "";
    return new Response(JSON.stringify({ error: { code: "conflict", message: "请核对新记录", current_room: current } }), { status: 409, headers: { "X-Request-ID": id } });
  });
  const error = await request("/rooms/r").catch(error => error);
  expect(sent).toMatch(/^[0-9a-f]{32}$/);
  expect(error).toMatchObject({ requestId: id, currentRoom: current, code: "conflict" });
  expect(error.message).toContain(id);
});

it("retains an attempt id on a network failure without claiming the save failed", async () => {
  let sent = "";
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { sent = new Headers(init.headers).get("X-Request-ID") ?? ""; throw new TypeError("offline"); });
  const error = await request("/items/i", { method: "PATCH", body: "{}" }).catch(error => error);
  expect(sent).toMatch(/^[0-9a-f]{32}$/);
  expect(error.requestId).toBe(sent);
  expect(error.message).toContain("尚未确认");
});

it("never displays an untrusted diagnostic response value", async () => {
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 500, headers: { "X-Request-ID": "secret-or-html" } }));
  const error = await request("/items").catch(error => error);
  expect(error).toBeInstanceOf(ApiError);
  expect(error.message).not.toContain("secret-or-html");
});
