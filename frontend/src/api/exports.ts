import { ApiError } from "./client";
import { captureSession, notifyUnauthorized } from "./sessionEvents";

export type ExportFilter = { status: "active" | "archived"; q: string; compartmentId: string; roomId?: string; roomName?: string; locationStatus?: "confirmed" | "missing" };
export type ExportFormat = "csv" | "json";
export type ExportScope = "filtered" | "selected" | "all";
export type ExportInput = { format: ExportFormat } & (
  { scope: "filtered"; status: "active" | "archived"; q?: string; compartment_id?: string; room_id?: string; location_status?: "confirmed" | "missing" }
  | { scope: "selected"; ids: string[] }
  | { scope: "all" }
);
export type ExportFile = { blob: Blob; filename: string; format: ExportFormat };

export async function exportInventory(input: ExportInput, signal?: AbortSignal): Promise<ExportFile> {
  if (signal?.aborted) throw new DOMException("已取消导出", "AbortError");
  const session = captureSession();
  const controller = new AbortController();
  let rejectStopped: (error: Error) => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
  const cancel = () => { rejectStopped(new DOMException("已取消导出", "AbortError")); controller.abort(); };
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = globalThis.setTimeout(() => {
    rejectStopped(new Error("导出超时，请缩小范围或重试")); controller.abort();
  }, 30_000);
  const expectedType = input.format === "csv" ? "text/csv" : "application/json";
  const filename = `wuwei-inventory.${input.format}`;
  try {
    if (signal?.aborted) { cancel(); return await stopped; }
    return await Promise.race([(async () => {
      const response = await fetch(`${import.meta.env.BASE_URL}api/inventory/export`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "include", body: JSON.stringify(input), signal: controller.signal,
      });
      if (controller.signal.aborted) throw new DOMException("已取消导出", "AbortError");
      notifyUnauthorized(session, "/inventory/export", response.status);
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new ApiError(response.status, body?.error?.code ?? "export_failed", body?.error?.message ?? `导出失败（${response.status}）`);
      }
      const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      const disposition = response.headers.get("content-disposition") ?? "";
      if (type !== expectedType || disposition !== `attachment; filename="${filename}"`) {
        throw new Error("服务器未返回有效清单，请重新登录或稍后重试");
      }
      const blob = await response.blob();
      if (!blob.size) throw new Error("服务器返回的清单为空，请重试");
      return { blob, filename, format: input.format };
    })(), stopped]);
  } finally {
    globalThis.clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
