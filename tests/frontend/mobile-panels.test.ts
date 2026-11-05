// @vitest-environment jsdom
import { createElement, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileSizeSheet } from "../../frontend/src/components/MobilePanels";
import { updateContainer, type Container, type ContainerPatch } from "../../frontend/src/api/client";

const cabinet: Container = { id: "c", room_id: "r", preset: "wardrobe", name: "衣柜", x_cm: 150,
  z_cm: 100, y_cm: 0, rot_deg: 0, width_cm: 180, depth_cm: 58, height_cm: 220, color: null,
  config: { layers: 3 }, compartments: [], item_count: 0, version: 1 };
type Pending = { patch: ContainerPatch; finish: (ok: boolean) => void };
let requests: Pending[];

function Editor() {
  const [container, setContainer] = useState(cabinet);
  const [open, setOpen] = useState(true);
  return createElement("div", null,
    createElement("output", { "aria-label": "已保存宽度" }, container.width_cm),
    open && createElement(MobileSizeSheet, {
      container, onClose: () => setOpen(false),
      onPatch: async (patch) => setContainer((await updateContainer(container.id, patch)).container),
    }));
}
beforeEach(() => {
  requests = [];
  vi.useFakeTimers();
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => new Promise<Response>((resolve) => {
    const patch = JSON.parse(String(init.body)) as ContainerPatch;
    requests.push({ patch, finish: (ok) => resolve(new Response(JSON.stringify(ok
      ? { container: { ...cabinet, ...patch, version: 2 } }
      : { error: { code: "request_failed", message: "网络中断，请重试" } }), {
      status: ok ? 200 : 503, headers: { "Content-Type": "application/json" },
    })) });
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function tick(milliseconds = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); }); }
async function finish(ok: boolean) { await act(async () => { requests.shift()!.finish(ok); }); }

describe("mobile size sheet save completion", () => {
  // Closing before debounce expires must still submit the final visible size.
  it("saves an immediate last step before closing with Done", async () => {
    render(createElement(Editor));
    fireEvent.click(screen.getByRole("button", { name: "宽增大" }));
    fireEvent.click(screen.getByRole("button", { name: "完成" })); await tick();
    await finish(true);
    expect(screen.getByLabelText("已保存宽度").textContent).toBe("181");
    expect(screen.queryByRole("heading", { name: "调整尺寸" })).toBeNull();
  });

  // Emptying the pending patch when a request starts must not let Done bypass that pending request.
  it("keeps the sheet open if an already-started save fails after Done is clicked", async () => {
    render(createElement(Editor));
    fireEvent.click(screen.getByRole("button", { name: "宽增大" })); await tick(260);
    fireEvent.click(screen.getByRole("button", { name: "完成" })); await tick();
    await finish(false);
    expect(screen.queryByRole("heading", { name: "调整尺寸" })).not.toBeNull();
    expect(screen.queryByText("网络中断，请重试")).not.toBeNull();
    expect(screen.getByLabelText("已保存宽度").textContent).toBe("180");
  });

  // A failed autosave must retain its payload, so closing cannot silently discard the visible draft.
  it("retries the failed last edit when Close is clicked", async () => {
    render(createElement(Editor));
    fireEvent.click(screen.getByRole("button", { name: "宽增大" })); await tick(260);
    await finish(false);
    fireEvent.click(screen.getByRole("button", { name: "关闭" })); await tick();
    if (requests.length) await finish(true);
    expect(screen.getByLabelText("已保存宽度").textContent).toBe("181");
    expect(screen.queryByRole("heading", { name: "调整尺寸" })).toBeNull();
  });
});
