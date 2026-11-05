export type PreparedPhoto = { file: File; originalBytes: number; compressed: boolean };

const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const KEEP_BYTES = 400 * 1024;
const MAX_PIXELS = 20_000_000;
const MAX_EDGE = 1600;

function supportedHeader(bytes: Uint8Array): boolean {
  const png = [137, 80, 78, 71, 13, 10, 26, 10];
  return (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    || (bytes.length >= 8 && png.every((value, index) => bytes[index] === value))
    || (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
      && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP");
}

function cancelled(): DOMException { return new DOMException("照片处理已取消", "AbortError"); }

export function preparePhoto(file: File, signal?: AbortSignal): Promise<PreparedPhoto> {
  if (signal?.aborted) return Promise.reject(cancelled());
  if (file.size > MAX_INPUT_BYTES) return Promise.reject(new Error("原照片不能超过 25 MiB，请选择较小的照片"));
  if (!file.size) return Promise.reject(new Error("请选择有效的 JPEG、PNG 或 WebP 照片"));

  return new Promise((resolve, reject) => {
    let finished = false;
    let bitmap: ImageBitmap | undefined;
    let image: HTMLImageElement | undefined;
    let objectUrl: string | undefined;
    let canvas: HTMLCanvasElement | undefined;
    let reader: FileReader | undefined;
    const stop = () => finish(cancelled());
    const timeout = globalThis.setTimeout(() => finish(new Error("照片处理超时，请重新选择或使用较小的照片")), 15_000);

    function cleanup() {
      globalThis.clearTimeout(timeout);
      signal?.removeEventListener("abort", stop);
      bitmap?.close(); bitmap = undefined;
      if (image) { image.onload = null; image.onerror = null; image.src = ""; image = undefined; }
      if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = undefined; }
      if (canvas) { canvas.width = 0; canvas.height = 0; }
      if (reader) {
        reader.onload = null; reader.onerror = null; reader.onabort = null;
        if (reader.readyState === FileReader.LOADING) reader.abort();
        reader = undefined;
      }
    }

    function finish(error?: Error, result?: PreparedPhoto) {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) reject(error); else resolve(result!);
    }

    function active() { if (finished || signal?.aborted) throw cancelled(); }

    function readHeader(): Promise<ArrayBuffer> {
      const header = file.slice(0, 12);
      if (typeof header.arrayBuffer === "function") return header.arrayBuffer();
      return new Promise((done, failed) => {
        reader = new FileReader();
        reader.onload = () => done(reader!.result as ArrayBuffer);
        reader.onerror = () => failed(new Error("无法读取照片，请重新选择"));
        reader.onabort = () => failed(cancelled());
        reader.readAsArrayBuffer(header);
      });
    }

    async function decode(): Promise<{ source: CanvasImageSource; width: number; height: number }> {
      if (typeof createImageBitmap === "function") {
        let decoded: ImageBitmap;
        try { decoded = await createImageBitmap(file, { imageOrientation: "from-image" }); }
        catch { throw new Error("无法读取照片，请选择有效的 JPEG、PNG 或 WebP 图片"); }
        // Decoding itself cannot be aborted. Dispose a late result rather than
        // drawing it or retaining its pixel buffer after cancellation/timeout.
        if (finished || signal?.aborted) { decoded.close(); throw cancelled(); }
        bitmap = decoded;
        return { source: decoded, width: decoded.width, height: decoded.height };
      }
      return new Promise((done, failed) => {
        image = new Image();
        const decoded = image;
        decoded.onload = () => done({ source: decoded, width: decoded.naturalWidth, height: decoded.naturalHeight });
        decoded.onerror = () => failed(new Error("无法读取照片，请选择有效的 JPEG、PNG 或 WebP 图片"));
        objectUrl = URL.createObjectURL(file);
        decoded.src = objectUrl;
      });
    }

    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) { stop(); return; }
    void (async () => {
      const bytes = new Uint8Array(await readHeader());
      active();
      if (!supportedHeader(bytes)) throw new Error("请选择有效的 JPEG、PNG 或 WebP 照片");
      const decoded = await decode();
      active();
      const { width, height } = decoded;
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
        throw new Error("无法读取照片尺寸，请重新选择有效图片");
      }
      if (width * height > MAX_PIXELS) throw new Error("照片分辨率不能超过 2000 万像素");
      if (file.size <= KEEP_BYTES && Math.max(width, height) <= MAX_EDGE) {
        return { file, originalBytes: file.size, compressed: false };
      }
      const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
      canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("此浏览器无法处理照片，请使用其他浏览器重试");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((done, failed) => {
        canvas!.toBlob(result => {
          if (result && result.size > 0 && result.type === "image/jpeg") done(result);
          else failed(new Error("照片处理失败，请重新选择或使用其他浏览器"));
        }, "image/jpeg", .82);
      });
      active();
      if (Math.min(blob.size, file.size) > MAX_UPLOAD_BYTES) throw new Error("照片压缩后仍超过 8 MiB，请选择较小的照片");
      if (blob.size >= file.size) return { file, originalBytes: file.size, compressed: false };
      const name = (file.name.replace(/\.[^.]*$/, "") || "photo") + ".jpg";
      return { file: new File([blob], name, { type: "image/jpeg", lastModified: file.lastModified }), originalBytes: file.size, compressed: true };
    })().then(result => finish(undefined, result), error => finish(error instanceof Error ? error : new Error("照片处理失败，请重新选择")));
  });
}
