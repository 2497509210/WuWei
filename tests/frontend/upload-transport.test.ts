// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quickRegisterItem, replaceItemPhoto } from "../../frontend/src/api/mobile";
import { ApiError } from "../../frontend/src/api/client";
import { FakeXHR, installFakeXHR } from "./helpers/fake-xhr";

const input = { name: "相机", compartmentId: "shelf", operationId: "one-registration" };
const item = { id: "item-1", name: "相机", aliases: [], notes: "", quantity: 1,
  compartment_id: "shelf", room_id: "room", container_id: "box", photo_url: null,
  location_path: ["卧室", "相机箱"], version: 1, location_status: "confirmed",
  last_confirmed_at: null, updated_at: "2026-11-05T00:00:00Z", archived_at: null, archive_reason: null };
type Progress = { phase: "uploading" | "saving"; loaded: number; total: number | null };
// Using the public boundary here also lets this test demonstrate missing progress before implementation.
const upload = quickRegisterItem as (input: typeof input & { image?: File }, signal?: AbortSignal,
  onProgress?: (progress: Progress) => void) => ReturnType<typeof quickRegisterItem>;

beforeEach(() => {
  vi.useFakeTimers();
  installFakeXHR();
  vi.stubGlobal("fetch", () => new Promise(() => {}));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("XHR quick registration transport", () => {
  it("correlates each replacement attempt independently while preserving the operation token", async () => {
    const photo = { itemId: "camera", expectedVersion: 2, operationId: "replace-once", image: new File(["bytes"], "photo.jpg") };
    const first = replaceItemPhoto(photo).catch(error => error);
    const request = FakeXHR.latest;
    expect(request.headers["x-request-id"]).toMatch(/^[0-9a-f]{32}$/);
    request.fail();
    const failure = await first;
    expect(failure.requestId).toBe(request.headers["x-request-id"]);
    expect(failure.message).toContain(failure.requestId);
    const retry = replaceItemPhoto(photo).catch(error => error);
    const second = FakeXHR.latest;
    expect(second.headers["x-request-id"]).not.toBe(request.headers["x-request-id"]);
    expect((second.body as FormData).get("operation_id")).toBe("replace-once");
    second.responseHeaders["x-request-id"] = "abcdefabcdefabcdefabcdefabcdefab";
    second.respond(503, { error: { code: "unavailable", message: "服务器繁忙" } });
    expect((await retry).requestId).toBe("abcdefabcdefabcdefabcdefabcdefab");
  });
  it("sends the original multipart payload with credentials and accepts a validated item", async () => {
    const image = new File(["photo-bytes"], "camera.jpg", { type: "image/jpeg" });
    const result = upload({ ...input, image });
    const request = FakeXHR.latest;
    expect(request).toBeDefined();
    expect(request.method).toBe("POST");
    expect(request.url).toBe(`${import.meta.env.BASE_URL}api/items/quick`);
    expect(request.withCredentials).toBe(true);
    expect(request.headers["content-type"]).toBeUndefined();
    const body = request.body as FormData;
    expect([...body.keys()]).toEqual(["name", "compartment_id", "operation_id", "image"]);
    expect(body.get("name")).toBe("相机");
    expect(body.get("compartment_id")).toBe("shelf");
    expect(body.get("operation_id")).toBe("one-registration");
    expect(body.get("image")).toBe(image);
    request.respond(201, { item });
    await expect(result).resolves.toEqual({ item });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports only real upload byte events, handles unknown totals, and waits for server success", async () => {
    const progress: Progress[] = [];
    const result = upload(input, undefined, value => progress.push(value));
    const request = FakeXHR.latest;
    expect(request).toBeDefined();
    expect(progress).toEqual([{ phase: "uploading", loaded: 0, total: null }]);
    request.emitUploadProgress(0, 0, true);
    expect(progress.at(-1)).toEqual({ phase: "uploading", loaded: 0, total: 0 });
    request.emitUploadProgress(20, 0, false);
    expect(progress.at(-1)).toEqual({ phase: "uploading", loaded: 20, total: null });
    request.emitUploadProgress(100, 100, true);
    expect(progress.at(-1)).toEqual({ phase: "uploading", loaded: 100, total: 100 });
    request.completeUpload(100, 100, true);
    expect(progress.at(-1)).toEqual({ phase: "saving", loaded: 100, total: 100 });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(request.aborted).toBe(false);
    request.respond(200, { item });
    await expect(result).resolves.toEqual({ item });
  });

  it("stops after 30 seconds without increasing uploaded bytes even if zero progress repeats", async () => {
    const result = upload(input).catch(error => error);
    const request = FakeXHR.latest;
    expect(request).toBeDefined();
    await vi.advanceTimersByTimeAsync(20_000);
    request.emitUploadProgress(0, 100, true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toMatchObject({ code: "save_unconfirmed", status: 0 });
    expect(request.aborted).toBe(true);
  });

  it("permits slow uploads beyond 90 seconds while bytes continue to arrive", async () => {
    const result = upload(input);
    const request = FakeXHR.latest;
    expect(request).toBeDefined();
    for (let part = 1; part <= 5; part++) {
      await vi.advanceTimersByTimeAsync(25_000);
      request.emitUploadProgress(part * 10, 100, true);
      expect(request.aborted).toBe(false);
    }
    request.completeUpload(100, 100, true);
    await vi.advanceTimersByTimeAsync(89_999);
    expect(request.aborted).toBe(false);
    request.respond(201, { item });
    await expect(result).resolves.toEqual({ item });
  });

  it("waits at most 90 seconds after upload completion for the full response body", async () => {
    const result = upload(input).catch(error => error);
    const request = FakeXHR.latest;
    expect(request).toBeDefined();
    request.completeUpload();
    await vi.advanceTimersByTimeAsync(89_999);
    expect(request.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ code: "save_unconfirmed" });
    expect(request.aborted).toBe(true);
  });

  it("enforces a ten minute total bound even with continuous progress", async () => {
    const result = upload(input).catch(error => error);
    const request = FakeXHR.latest;
    expect(request).toBeDefined();
    for (let part = 1; part < 24; part++) {
      await vi.advanceTimersByTimeAsync(25_000);
      request.emitUploadProgress(part, 100, true);
    }
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await result).toMatchObject({ code: "save_unconfirmed" });
    expect(request.aborted).toBe(true);
  });

  it("does not send an already cancelled operation", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(upload(input, controller.signal)).rejects.toMatchObject({ code: "save_unconfirmed" });
    expect(FakeXHR.instances).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the request and makes every late callback inert", async () => {
    const controller = new AbortController();
    const progress: Progress[] = [];
    const result = upload(input, controller.signal, value => progress.push(value)).catch(error => error);
    const request = FakeXHR.latest;
    expect(request).toBeDefined();
    controller.abort();
    const failure = await result;
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.message).toContain("保持内容不变后重试");
    const count = progress.length;
    request.emitUploadProgress(100, 100, true); request.completeUpload(); request.respond(201, { item }); request.fail();
    expect(progress).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("also ignores late progress and abort after a confirmed success", async () => {
    const controller = new AbortController(); const progress: Progress[] = [];
    const result = upload(input, controller.signal, value => progress.push(value));
    const request = FakeXHR.latest;
    expect(request).toBeDefined();
    request.respond(200, { item });
    await result;
    const count = progress.length;
    controller.abort(); request.emitUploadProgress(200, 200, true);
    expect(progress).toHaveLength(count);
    expect(request.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps server API errors and conflict details", async () => {
    const result = upload(input).catch(error => error);
    const request = FakeXHR.latest;
    expect(request).toBeDefined();
    request.respond(409, { error: { code: "operation_conflict", message: "内容已改变", current: item } });
    expect(await result).toMatchObject({ status: 409, code: "operation_conflict", message: expect.stringContaining("内容已改变"), current: item });
  });

  it.each(["<html>proxy</html>", "{}", '{"item":null}', '{"item":{"id":"i"}}'])("does not claim success for malformed response %s", async body => {
    const result = upload(input).catch(error => error);
    const request = FakeXHR.latest;
    expect(request).toBeDefined();
    request.respond(201, body, true);
    expect(await result).toMatchObject({ code: "save_unconfirmed" });
  });

  it("gives an ApiError for HTTP failure with non JSON content", async () => {
    const result = upload(input).catch(error => error);
    const request = FakeXHR.latest;
    expect(request).toBeDefined();
    request.respond(502, "<html>Bad gateway</html>", true);
    expect(await result).toMatchObject({ status: 502, code: "save_unconfirmed" });
  });

  it("does not treat a transport failure as a confirmed unsaved result", async () => {
    const result = upload(input).catch(error => error);
    const request = FakeXHR.latest;
    expect(request).toBeDefined();
    request.fail();
    expect(await result).toMatchObject({ code: "save_unconfirmed", status: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
