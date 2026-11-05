import { ApiError, request, type Item } from "./client";
import { captureSession, notifyUnauthorized } from "./sessionEvents";

export type CompartmentLocation = {
  room_id: string;
  container_id: string;
  compartment_id: string;
  path: string[];
};

export function resolveCompartment(id: string, signal?: AbortSignal): Promise<{ location: CompartmentLocation }> {
  return request(`/locations/compartments/${encodeURIComponent(id)}`, { signal });
}

const UNCONFIRMED_SAVE = "尚未确认保存结果，请保持内容不变后重试，将核对同一次登记，避免重复创建。";

export type UploadProgress = { phase: "uploading" | "saving"; loaded: number; total: number | null };

function isItem(value: unknown): value is Item {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  const nullableString = (entry: unknown) => entry === null || typeof entry === "string";
  return typeof item.id === "string" && item.id.length > 0 && typeof item.name === "string"
    && Array.isArray(item.aliases) && item.aliases.every(alias => typeof alias === "string")
    && nullableString(item.notes) && Number.isInteger(item.quantity) && Number(item.quantity) > 0
    && nullableString(item.compartment_id) && nullableString(item.container_id) && nullableString(item.room_id)
    && nullableString(item.photo_url) && Array.isArray(item.location_path)
    && item.location_path.every(part => typeof part === "string")
    && Number.isInteger(item.version) && Number(item.version) > 0
    && (item.location_status === "confirmed" || item.location_status === "missing")
    && nullableString(item.last_confirmed_at) && typeof item.updated_at === "string"
    && nullableString(item.archived_at) && nullableString(item.archive_reason);
}

export function quickRegisterItem(
  input: { name: string; compartmentId: string; operationId: string; image?: File },
  signal?: AbortSignal, onProgress?: (progress: UploadProgress) => void,
): Promise<{ item: Item }> {
  if (signal?.aborted) return Promise.reject(new ApiError(0, "save_unconfirmed", UNCONFIRMED_SAVE));
  const session = captureSession();
  const body = new FormData();
  body.set("name", input.name);
  body.set("compartment_id", input.compartmentId);
  body.set("operation_id", input.operationId);
  if (input.image) body.set("image", input.image);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    let progress: UploadProgress = { phase: "uploading", loaded: 0, total: null };
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let totalTimer: ReturnType<typeof setTimeout> | undefined;

    function cleanup() {
      globalThis.clearTimeout(idleTimer); globalThis.clearTimeout(totalTimer);
      signal?.removeEventListener("abort", stop);
      xhr.upload.removeEventListener("progress", uploaded);
      xhr.upload.removeEventListener("load", uploadFinished);
      xhr.removeEventListener("load", completed);
      xhr.removeEventListener("error", failed);
      xhr.removeEventListener("abort", failed);
      xhr.removeEventListener("timeout", failed);
    }

    function finish(error?: ApiError, item?: Item) {
      if (settled) return;
      settled = true; cleanup();
      if (error) reject(error);
      else resolve({ item: item! });
    }

    function failed() { finish(new ApiError(0, "save_unconfirmed", UNCONFIRMED_SAVE)); }
    function stop() {
      if (settled) return;
      // Reject before aborting, so even a late or missing abort event cannot leave a pending save.
      failed();
      xhr.abort();
    }
    function deadline(milliseconds: number) {
      globalThis.clearTimeout(idleTimer);
      idleTimer = globalThis.setTimeout(stop, milliseconds);
    }
    function report() { if (!settled) onProgress?.({ ...progress }); }
    function uploaded(event: ProgressEvent) {
      if (settled || progress.phase !== "uploading") return;
      const loaded = Number.isFinite(event.loaded) ? Math.max(progress.loaded, event.loaded, 0) : progress.loaded;
      if (loaded > progress.loaded) deadline(30_000);
      progress = {
        phase: "uploading", loaded,
        total: event.lengthComputable && Number.isFinite(event.total) && event.total >= 0 ? event.total : null,
      };
      report();
    }
    function uploadFinished(event: ProgressEvent) {
      if (settled || progress.phase === "saving") return;
      progress = {
        phase: "saving",
        loaded: Number.isFinite(event.loaded) ? Math.max(progress.loaded, event.loaded, 0) : progress.loaded,
        total: event.lengthComputable && Number.isFinite(event.total) && event.total >= 0 ? event.total : progress.total,
      };
      // Upload completion only means the browser finished sending. Wait for the full server response.
      deadline(90_000); report();
    }
    function completed() {
      if (settled) return;
      notifyUnauthorized(session, "/items/quick", xhr.status);
      let payload: { item?: unknown; error?: { code?: unknown; message?: unknown; current?: Item } } | null = null;
      try { payload = JSON.parse(xhr.responseText); } catch { /* A proxy may return HTML instead of the API response. */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        if (isItem(payload?.item)) finish(undefined, payload.item);
        else finish(new ApiError(xhr.status, "save_unconfirmed", UNCONFIRMED_SAVE));
        return;
      }
      if (payload?.error && typeof payload.error.message === "string") {
        finish(new ApiError(xhr.status, typeof payload.error.code === "string" ? payload.error.code : "request_failed",
          payload.error.message, payload.error.current));
      } else finish(new ApiError(xhr.status, "save_unconfirmed", UNCONFIRMED_SAVE));
    }

    xhr.upload.addEventListener("progress", uploaded);
    xhr.upload.addEventListener("load", uploadFinished);
    xhr.addEventListener("load", completed);
    xhr.addEventListener("error", failed);
    xhr.addEventListener("abort", failed);
    xhr.addEventListener("timeout", failed);
    signal?.addEventListener("abort", stop, { once: true });
    try {
      xhr.open("POST", `${import.meta.env.BASE_URL}api/items/quick`, true);
      xhr.withCredentials = true;
      deadline(30_000);
      totalTimer = globalThis.setTimeout(stop, 600_000);
      report();
      if (signal?.aborted) stop();
      if (!settled) xhr.send(body);
    } catch {
      stop();
    }
  });
}
