// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "../../frontend/src/api/client";
import { activateSession, captureSession, invalidateSession, subscribeSessionExpired } from "../../frontend/src/api/sessionEvents";
import { quickRegisterItem } from "../../frontend/src/api/mobile";
import { exportInventory } from "../../frontend/src/api/exports";
import { applyBulkAction } from "../../frontend/src/api/bulk";
import { FakeXHR, installFakeXHR } from "./helpers/fake-xhr";

const unauthorized = () => new Response(JSON.stringify({ error: { code: "not_authenticated", message: "请先登录" } }), { status: 401 });
let notices = 0;
let unsubscribe = () => {};
beforeEach(() => { invalidateSession(); notices = 0; unsubscribe = subscribeSessionExpired(() => { notices++; }); });
afterEach(() => { unsubscribe(); invalidateSession(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("session generation events", () => {
  it("does not notify for initial unauthenticated reads or login/join errors", async () => {
    vi.stubGlobal("fetch", async () => unauthorized());
    await request("/me").catch(() => {});
    expect(notices).toBe(0);
    activateSession();
    await request("/auth/login", { method: "POST", body: '{}' }).catch(() => {});
    await request("/auth/join", { method: "POST", body: '{}' }).catch(() => {});
    expect(notices).toBe(0);
  });

  it("notifies once for concurrent protected 401s in the active generation", async () => {
    activateSession(); const reads: Array<(response: Response) => void> = [];
    vi.stubGlobal("fetch", () => new Promise(resolve => reads.push(resolve)));
    const a = request("/items").catch(() => {}), b = request("/bootstrap").catch(() => {});
    reads[0](unauthorized()); reads[1](unauthorized()); await Promise.all([a, b]);
    expect(notices).toBe(1); expect(captureSession().active).toBe(false);
  });

  it("ignores an old 401 after logout and a later successful login", async () => {
    activateSession(); let finish: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", () => new Promise(resolve => { finish = resolve; }));
    const old = request("/items").catch(() => {});
    invalidateSession(); activateSession();
    finish!(unauthorized()); await old;
    expect(notices).toBe(0); expect(captureSession().active).toBe(true);
  });

  it("ignores 401s from requests already cancelled or timed out", async () => {
    activateSession(); let finish: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", () => new Promise(resolve => { finish = resolve; }));
    const controller = new AbortController();
    const pending = request("/items", { signal: controller.signal }).catch(() => {});
    controller.abort(); await pending; finish!(unauthorized());
    await Promise.resolve(); await Promise.resolve(); expect(notices).toBe(0);
  });

  it("expires a protected 401 even if its error body never finishes", async () => {
    activateSession(); const controller = new AbortController();
    vi.stubGlobal("fetch", async () => ({ status: 401, ok: false, json: () => new Promise(() => {}) }));
    const pending = request("/items", { signal: controller.signal }).catch(() => {});
    await Promise.resolve(); await Promise.resolve(); expect(notices).toBe(1);
    controller.abort(); await pending;
  });

  it("routes upload and export 401s through the same event owner", async () => {
    installFakeXHR(); activateSession();
    const upload = quickRegisterItem({ name: "item", compartmentId: "cp", operationId: "one" }).catch(() => {});
    FakeXHR.latest.respond(401, { error: { code: "not_authenticated", message: "请先登录" } }); await upload;
    expect(notices).toBe(1);
    activateSession(); vi.stubGlobal("fetch", async () => unauthorized());
    await exportInventory({ format: "csv", scope: "all" }).catch(() => {});
    expect(notices).toBe(2);
  });

  it("ignores late independent transport 401s after another login", async () => {
    installFakeXHR(); activateSession();
    const upload = quickRegisterItem({ name: "item", compartmentId: "cp", operationId: "one" }).catch(() => {});
    const oldUpload = FakeXHR.latest;
    let finish: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", () => new Promise(resolve => { finish = resolve; }));
    const exported = exportInventory({ format: "csv", scope: "all" }).catch(() => {});
    activateSession(); oldUpload.respond(401, {}); finish!(unauthorized()); await Promise.all([upload, exported]);
    expect(notices).toBe(0);
  });

  it("retains the bulk idempotency uncertainty message at its dedicated deadline", async () => {
    vi.useFakeTimers(); vi.stubGlobal("fetch", () => new Promise(() => {}));
    const pending = applyBulkAction({ action: "archive", operation_id: "one", items: [{ id: "i", expected_version: 1 }] }).catch(error => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({ code: "bulk_unconfirmed" });
    expect((await pending).message).toContain("保持选择和内容不变"); expect(vi.getTimerCount()).toBe(0);
  });
});
