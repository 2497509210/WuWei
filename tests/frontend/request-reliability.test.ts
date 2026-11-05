// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request, deleteRoom, deleteContainer, uploadItemPhoto } from "../../frontend/src/api/client";

const json = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("bounded API requests", () => {
  it("ends a stalled read at 15 seconds even if fetch ignores its AbortSignal", async () => {
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => { signal = init.signal; return new Promise(() => {}); });
    const pending = request("/items").catch(error => error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toMatchObject({ code: "request_timeout", status: 0 });
    expect(signal?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });

  it("covers a never-ending successful response body with the read deadline", async () => {
    vi.stubGlobal("fetch", async () => ({ status: 200, ok: true, json: () => new Promise(() => {}) }));
    const pending = request("/items").catch(error => error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toMatchObject({ code: "request_timeout" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses a thirty second write limit without retrying or claiming it was not saved", async () => {
    let writes = 0;
    vi.stubGlobal("fetch", () => { writes++; return new Promise(() => {}); });
    const pending = request("/items/i", { method: "PATCH", body: '{}' }).catch(error => error);
    await vi.advanceTimersByTimeAsync(15_000); expect(writes).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toMatchObject({ code: "request_timeout" });
    expect((await pending).message).toContain("尚未确认"); expect(writes).toBe(1);
  });

  it("preserves parent cancellation as AbortError and releases its timer", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const pending = request("/items", { signal: controller.signal }).catch(error => error);
    controller.abort();
    expect(await pending).toMatchObject({ name: "AbortError" }); expect(vi.getTimerCount()).toBe(0);
  });

  it("does not send a pre-cancelled request", async () => {
    let reads = 0; vi.stubGlobal("fetch", () => { reads++; return Promise.resolve(json({})); });
    const controller = new AbortController(); controller.abort();
    await expect(request("/items", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(reads).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["<html>proxy</html>", "", "null", '"not an object"'])("rejects malformed success %s", async body => {
    vi.stubGlobal("fetch", async () => new Response(body, { status: 200 }));
    await expect(request("/items")).rejects.toMatchObject({ code: "invalid_response", status: 200 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps legitimate 204 and structured API conflict details", async () => {
    vi.stubGlobal("fetch", async () => json(null, 204));
    await expect(request("/items/i", { method: "DELETE" })).resolves.toBeUndefined();
    const current = { id: "r", floor_id: "f", version: 3 };
    vi.stubGlobal("fetch", async () => json({ error: { code: "room_version_conflict", message: "请刷新", current_room: current } }, 409));
    await expect(request("/rooms/r", { method: "PATCH", body: '{}' })).rejects.toMatchObject({ status: 409, code: "room_version_conflict", message: "请刷新", currentRoom: current });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("maps network failures to explicit read and uncertain write errors", async () => {
    vi.stubGlobal("fetch", async () => { throw new TypeError("Failed to fetch"); });
    await expect(request("/items")).rejects.toMatchObject({ code: "network_error", status: 0 });
    const error = await request("/items/batch", { method: "POST", body: '{}' }).catch(error => error);
    expect(error.code).toBe("network_error"); expect(error.message).toContain("尚未确认");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows specialized transports to opt out and does not pass timeoutMs to fetch", async () => {
    let finish: ((response: Response) => void) | undefined;
    let options: RequestInit & { timeoutMs?: number } = {};
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => { options = init; return new Promise(resolve => { finish = resolve; }); });
    const pending = request("/items/actions/bulk", { method: "POST", body: '{}', timeoutMs: 0 });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(options).not.toHaveProperty("timeoutMs"); expect(vi.getTimerCount()).toBe(0);
    finish!(json({ done: true })); await expect(pending).resolves.toEqual({ done: true });
  });

  it("uses the extended ninety second limit for an existing item photo upload", async () => {
    let finish: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", () => new Promise(resolve => { finish = resolve; }));
    const pending = uploadItemPhoto("i", 1, new File(["image"], "photo.png"));
    await vi.advanceTimersByTimeAsync(30_000);
    finish!(json({ item: { id: "i" } })); await expect(pending).resolves.toEqual({ item: { id: "i" } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends explicit confirmation versions with deletes", async () => {
    const paths: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { paths.push(url); return json(null, 204); });
    await deleteRoom("room space", 4); await deleteContainer("cabinet space", 9);
    expect(paths).toEqual(["/api/rooms/room%20space?expected_version=4", "/api/containers/cabinet%20space?expected_version=9"]);
  });
});
