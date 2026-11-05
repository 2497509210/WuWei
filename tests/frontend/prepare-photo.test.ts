// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preparePhoto } from "../../frontend/src/lib/preparePhoto";

function photo(bytes = 1200, type = "image/png") {
  const data = new Uint8Array(bytes); data.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const file = new File([data], "camera.png", { type, lastModified: 4 });
  // jsdom lacks Blob.arrayBuffer; expose the browser's byte-reading boundary.
  Object.defineProperty(file, "slice", { value: (start = 0, end = data.length) => ({ arrayBuffer: async () => data.slice(start, end).buffer }) });
  return file;
}
let decode: () => Promise<{ width: number; height: number; close: () => void }>;
let width: number;
let height: number;
let closed: number;
let encoded: Blob | null;
let encode: (callback: BlobCallback) => void;
let painted: string[];
let canvas: HTMLCanvasElement | undefined;
const originalContext = HTMLCanvasElement.prototype.getContext;
const originalBlob = HTMLCanvasElement.prototype.toBlob;
beforeEach(() => {
  width = 800; height = 600; closed = 0; painted = [];
  encoded = new Blob([new Uint8Array(1000)], { type: "image/jpeg" });
  encode = callback => callback(encoded);
  decode = async () => ({ width, height, close: () => closed++ });
  vi.stubGlobal("createImageBitmap", () => decode());
  HTMLCanvasElement.prototype.getContext = function () {
    canvas = this;
    return { fillStyle: "", fillRect() { painted.push("background"); }, drawImage() { painted.push("image"); } };
  } as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
    expect(type).toBe("image/jpeg"); expect(quality).toBe(.82); encode(callback);
  };
});
afterEach(() => {
  vi.unstubAllGlobals(); vi.useRealTimers();
  HTMLCanvasElement.prototype.getContext = originalContext;
  HTMLCanvasElement.prototype.toBlob = originalBlob;
});

describe("photo preparation", () => {
  it("decodes small files but returns the exact original File when no resize is needed", async () => {
    const file = photo();
    const result = await preparePhoto(file);
    expect(result).toEqual({ file, originalBytes: file.size, compressed: false });
    expect(result.file).toBe(file); expect(closed).toBe(1); expect(painted).toEqual([]);
  });

  it("resizes a 12MP photo once, paints white first, and returns the smaller JPEG", async () => {
    width = 4000; height = 3000;
    let dimensions: number[] = [];
    encode = callback => { dimensions = [canvas!.width, canvas!.height]; callback(encoded); };
    const result = await preparePhoto(photo(7 * 1024 * 1024));
    expect(dimensions).toEqual([1600, 1200]);
    expect(result.file.type).toBe("image/jpeg"); expect(result.file.size).toBe(1000);
    expect(result.compressed).toBe(true); expect(result.originalBytes).toBe(7 * 1024 * 1024);
    expect(painted).toEqual(["background", "image"]);
    expect(closed).toBe(1); expect([canvas!.width, canvas!.height]).toEqual([0, 0]);
  });

  it("resizes a small but oversized-dimension photo", async () => {
    width = 2000; height = 1000;
    const result = await preparePhoto(photo(3000));
    expect(result.compressed).toBe(true); expect(painted).toEqual(["background", "image"]);
  });

  it("keeps the original File when JPEG encoding increases its size", async () => {
    width = 2000; height = 1000; encoded = new Blob([new Uint8Array(4000)], { type: "image/jpeg" });
    const file = photo(3000), result = await preparePhoto(file);
    expect(result.file).toBe(file); expect(result.compressed).toBe(false); expect(closed).toBe(1);
  });

  it("rejects a disguised non-image before attempting browser decoding", async () => {
    decode = async () => { throw new Error("must not decode disguised content"); };
    await expect(preparePhoto(new File(["<svg>fake</svg>"], "image.jpg", { type: "image/jpeg" }))).rejects.toThrow(/JPEG.*PNG.*WebP/);
  });

  it("rejects invalid decoding rather than silently uploading the original file", async () => {
    decode = async () => { throw new Error("decoder rejected"); };
    await expect(preparePhoto(photo())).rejects.toThrow(/无法读取|有效/);
  });

  it("rejects files larger than 8 MiB and decoded images larger than 20MP", async () => {
    await expect(preparePhoto(photo(8 * 1024 * 1024 + 1))).rejects.toThrow(/8 MiB/);
    width = 6000; height = 4000;
    await expect(preparePhoto(photo())).rejects.toThrow(/2000 万|20/);
    expect(closed).toBe(1);
  });

  it("fails explicitly when the browser cannot encode JPEG", async () => {
    width = 2000; height = 1000; encoded = null;
    await expect(preparePhoto(photo())).rejects.toThrow(/处理失败/);
    expect(closed).toBe(1); expect([canvas!.width, canvas!.height]).toEqual([0, 0]);
  });

  it("cancels decoding and closes a bitmap that arrives after cancellation", async () => {
    let finish: ((value: { width: number; height: number; close: () => void }) => void) | undefined;
    decode = () => new Promise(resolve => { finish = resolve; });
    const controller = new AbortController();
    const pending = preparePhoto(photo(), controller.signal);
    const failure = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(finish).toBeDefined());
    controller.abort(); await failure;
    finish!({ width: 800, height: 600, close: () => closed++ });
    await Promise.resolve(); await Promise.resolve();
    expect(closed).toBe(1); expect(painted).toEqual([]);
  });

  it("times out a stalled decoder within 15 seconds and closes its late bitmap", async () => {
    let finish: ((value: { width: number; height: number; close: () => void }) => void) | undefined;
    decode = () => new Promise(resolve => { finish = resolve; });
    vi.useFakeTimers();
    const pending = preparePhoto(photo()); const failure = expect(pending).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(15_000); await failure;
    finish?.({ width: 800, height: 600, close: () => closed++ });
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a stalled encoder and releases its canvas and bitmap", async () => {
    width = 4000; height = 3000;
    encode = () => {};
    vi.useFakeTimers();
    const pending = preparePhoto(photo(500_000)); const failure = expect(pending).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(0);
    expect(painted).toEqual(["background", "image"]);
    await vi.advanceTimersByTimeAsync(15_000); await failure;
    expect(closed).toBe(1); expect([canvas!.width, canvas!.height]).toEqual([0, 0]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
