// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportDialog } from "../../frontend/src/components/ExportDialog";
import { exportInventory } from "../../frontend/src/api/exports";

type Handler = (input: string, init: RequestInit) => Promise<Response> | Response;
let handler: Handler;
let bodies: Record<string, unknown>[];
let urls: Blob[];
let revoked: string[];
const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
const metadata = { schema_version: 1, exported_at: "2026-11-05T00:00:00Z", item_count: 1, scope: "filtered", items: [{ id: "i", name: "护照" }] };
function attachment(format: "csv" | "json" = "csv") {
  return new Response(format === "csv" ? '\ufeff"ID","名称"\r\n"i","护照"\r\n' : JSON.stringify(metadata), { headers: {
    "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/json",
    "Content-Disposition": `attachment; filename="wuwei-inventory.${format}"`,
  } });
}
function show(selectedIds: string[] = []) {
  return render(createElement(ExportDialog, { filter: { status: "active", q: "证件", compartmentId: "cp" }, selectedIds, onClose() {} }));
}
beforeEach(() => {
  bodies = []; urls = []; revoked = [];
  handler = (_input, init) => attachment(JSON.parse(String(init.body)).format);
  vi.stubGlobal("fetch", (input: string, init: RequestInit = {}) => {
    bodies.push(JSON.parse(String(init.body))); return Promise.resolve(handler(input, init));
  });
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: (blob: Blob) => { urls.push(blob); return `blob:export-${urls.length}`; } });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: (url: string) => revoked.push(url) });
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); vi.useRealTimers();
  if (originalCreate) Object.defineProperty(URL, "createObjectURL", originalCreate); else Reflect.deleteProperty(URL, "createObjectURL");
  if (originalRevoke) Object.defineProperty(URL, "revokeObjectURL", originalRevoke); else Reflect.deleteProperty(URL, "revokeObjectURL");
});

describe("export dialog", () => {
  it("exports exactly the current filter and provides a user-clicked download with Unicode data", async () => {
    const view = show();
    fireEvent.click(screen.getByRole("button", { name: "生成导出文件" }));
    const link = await screen.findByRole("link", { name: "下载 CSV 清单" });
    expect(bodies[0]).toEqual({ format: "csv", scope: "filtered", status: "active", q: "证件", compartment_id: "cp" });
    expect(link.getAttribute("download")).toBe("wuwei-inventory.csv");
    expect(await urls[0].text()).toContain("护照");
    expect(new Uint8Array(await urls[0].arrayBuffer()).slice(0, 3)).toEqual(new Uint8Array([239, 187, 191]));
    view.unmount(); expect(revoked).toEqual(["blob:export-1"]);
  });

  it("selected scope sends only IDs, and all scope sends no hidden filters", async () => {
    show(["one", "two"]);
    fireEvent.click(screen.getByLabelText(/所选物品/));
    fireEvent.change(screen.getByLabelText("文件格式"), { target: { value: "json" } });
    fireEvent.click(screen.getByRole("button", { name: "生成导出文件" }));
    await screen.findByRole("link", { name: "下载 JSON 清单" });
    expect(bodies[0]).toEqual({ format: "json", scope: "selected", ids: ["one", "two"] });
    expect(JSON.parse(await urls[0].text()).items[0].name).toBe("护照");
    fireEvent.click(screen.getByLabelText("全部物品（含归档）"));
    expect(screen.queryByRole("link")).toBeNull(); expect(revoked).toContain("blob:export-1");
    fireEvent.click(screen.getByRole("button", { name: "生成导出文件" }));
    await screen.findByRole("link", { name: "下载 JSON 清单" });
    expect(bodies[1]).toEqual({ format: "json", scope: "all" });
  });

  it.each([{ selected: [] }, { selected: Array.from({ length: 101 }, (_, i) => `id${i}`) }])("disables selected scope when the selection count is invalid", ({ selected }) => {
    show(selected);
    expect((screen.getByLabelText(/所选物品/) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "生成导出文件" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not download a JSON API error or an HTML response", async () => {
    handler = () => new Response(JSON.stringify({ error: { code: "export_limit_exceeded", message: "请缩小筛选范围" } }), { status: 413, headers: { "Content-Type": "application/json" } });
    show(); fireEvent.click(screen.getByRole("button", { name: "生成导出文件" }));
    await screen.findByText("请缩小筛选范围"); expect(urls).toHaveLength(0);
    handler = () => new Response("<html>login page</html>", { headers: { "Content-Type": "text/html" } });
    fireEvent.click(screen.getByRole("button", { name: "生成导出文件" }));
    await screen.findByText("服务器未返回有效清单，请重新登录或稍后重试");
    expect(urls).toHaveLength(0); expect(screen.queryByRole("link")).toBeNull();
  });

  it("cancels a request without accepting a late file and permits a new request", async () => {
    let late: ((response: Response) => void) | undefined;
    let signal: AbortSignal | null | undefined;
    handler = (_input, init) => { signal = init.signal; return new Promise(resolve => { late = resolve; }); };
    show(); fireEvent.click(screen.getByRole("button", { name: "生成导出文件" }));
    fireEvent.click(screen.getByRole("button", { name: "取消导出" }));
    await screen.findByText("已取消导出，可以重新生成"); expect(signal?.aborted).toBe(true);
    handler = () => attachment();
    fireEvent.click(screen.getByRole("button", { name: "生成导出文件" }));
    await screen.findByRole("link", { name: "下载 CSV 清单" });
    await act(async () => { late?.(attachment()); });
    expect(urls).toHaveLength(1);
  });

  it("aborts on unmount and does not allocate a download for a late response", async () => {
    let late: ((response: Response) => void) | undefined;
    let signal: AbortSignal | null | undefined;
    handler = (_input, init) => { signal = init.signal; return new Promise(resolve => { late = resolve; }); };
    const view = show(); fireEvent.click(screen.getByRole("button", { name: "生成导出文件" }));
    view.unmount(); expect(signal?.aborted).toBe(true);
    await act(async () => { late?.(attachment()); }); expect(urls).toHaveLength(0);
  });

  it("covers a stalled response body with the thirty second deadline", async () => {
    vi.useFakeTimers();
    handler = () => ({ ok: true, status: 200, headers: new Headers({ "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="wuwei-inventory.csv"' }), blob: () => new Promise(() => {}) }) as Response;
    const pending = exportInventory({ format: "csv", scope: "filtered", status: "active" });
    const failure = expect(pending).rejects.toThrow("导出超时，请缩小范围或重试");
    await vi.advanceTimersByTimeAsync(30_000); await failure;
    expect(vi.getTimerCount()).toBe(0);
  });
});
