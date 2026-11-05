import { ApiError, request, type Item } from "./client";

export type BulkAction = "move" | "archive" | "restore";
export type BulkInput = {
  operation_id: string;
  action: BulkAction;
  items: Array<{ id: string; expected_version: number }>;
  compartment_id?: string;
  reason?: string;
};
export type BulkResult = { items: Item[]; processed: number; changed: number; replayed: boolean };
const UNCERTAIN = "尚未确认批量操作结果，请保持选择和内容不变后重试，将核对同一次操作，避免重复处理。";

export async function applyBulkAction(input: BulkInput, signal?: AbortSignal): Promise<BulkResult> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  let rejectWait: (error: ApiError) => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => { rejectWait = reject; });
  const aborted = () => rejectWait(new ApiError(0, "bulk_unconfirmed", UNCERTAIN));
  controller.signal.addEventListener("abort", aborted, { once: true });
  signal?.addEventListener("abort", stop, { once: true });
  const timer = globalThis.setTimeout(stop, 30_000);
  try {
    if (signal?.aborted) { stop(); return await stopped; }
    const result = await Promise.race([
      request<BulkResult>("/items/actions/bulk", { method: "POST", body: JSON.stringify(input), signal: controller.signal, timeoutMs: 0 }), stopped,
    ]);
    if (!result || !Array.isArray(result.items) || !Number.isInteger(result.processed) || !Number.isInteger(result.changed)
      || result.processed !== input.items.length || result.changed < 0 || result.changed > result.processed || typeof result.replayed !== "boolean") {
      throw new ApiError(0, "bulk_unconfirmed", UNCERTAIN);
    }
    return result;
  } catch (error) {
    if (error instanceof ApiError && !["network_error", "invalid_response", "request_timeout"].includes(error.code)) throw error;
    throw new ApiError(0, "bulk_unconfirmed", UNCERTAIN);
  } finally {
    globalThis.clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    controller.signal.removeEventListener("abort", aborted);
  }
}
