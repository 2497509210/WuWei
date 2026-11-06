// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { InventoryPage } from "../../frontend/src/pages/InventoryPage";
import { LocationPicker } from "../../frontend/src/components/LocationPicker";

const me = { user: { id: "u", username: "owner", display_name: "家人", role: "owner" as const }, household: { id: "h", name: "我家" } };
const room = { id: "r", floor_id: "f", name: "主卧", width_cm: 400, depth_cm: 400, height_cm: 260, wall_color: null, sort: 0, container_count: 1 };
const compartment = { id: "cp", container_id: "c", name: "顶层", kind: "shelf", level_index: 0, row: 0, col: 0, sort: 0 };
const cabinet = { id: "c", room_id: "r", preset: "wardrobe", name: "白色衣柜", x_cm: 150, z_cm: 100, y_cm: 0, rot_deg: 0, width_cm: 180, depth_cm: 58, height_cm: 220, color: null, config: {layers: 1}, compartments: [compartment], item_count: 1, version: 1 };
const item = { id: "passport", name: "护照", aliases: ["证件"], notes: "蓝色袋子", quantity: 1, compartment_id: "cp", room_id: "r", container_id: "c", photo_url: null, location_path: ["主卧", "白色衣柜", "顶层"], version: 2, location_status: "confirmed", last_confirmed_at: "2026-11-04T10:00:00Z", updated_at: "2026-11-04T10:00:00Z" };
type Handler = (url: URL, init: RequestInit) => Promise<Response> | Response;
let handler: Handler;
function response(data: unknown, status = 200) { return new Response(JSON.stringify(data), {status, headers: {"Content-Type": "application/json"}}); }
function normal(url: URL) {
  if (url.pathname.endsWith("/events")) return response({events:[],has_more:false});
  if (url.pathname.endsWith("/bootstrap")) return response({ ...me, floors: [{ id: "f", name: "1 层", level: 1, rooms: [room] }] });
  if (url.pathname.endsWith("/rooms/r")) return response({room, containers: [cabinet]});
  if (url.pathname.endsWith("/items/passport")) return response({item});
  return response({items: [item]});
}
beforeEach(() => {
  handler = (url) => normal(url);
  vi.stubGlobal("fetch", (input: string, init: RequestInit = {}) => Promise.resolve(handler(new URL(input, "http://localhost"), init)));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function show() { return render(createElement(InventoryPage, {me, onLogout: async () => {}, onArrange: () => {}})); }

describe("inventory workflows", () => {
  it("requires reloading the latest item before writing after a detail load fails", async () => {
    let reads = 0;
    handler = (url) => url.pathname.endsWith("/items/passport") && ++reads === 1
      ? response({error:{message:"读取失败"}},503) : normal(url);
    show(); fireEvent.click(await screen.findByRole("button", {name:/查看护照/}));
    await screen.findByText("读取失败", { exact: false });
    expect((screen.getByRole("button", {name:"就在这里"}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", {name:"重新加载记录"}));
    await waitFor(() => expect((screen.getByRole("button", {name:"就在这里"}) as HTMLButtonElement).disabled).toBe(false));
  });
  it("does not hide a failed room request when a bootstrap retry finishes later", async () => {
    let reads = 0;
    let finishBootstrap: ((response: Response) => void) | undefined;
    handler = (url) => {
      if(url.pathname.endsWith("/rooms/r")) return response({error:{message:"房间读取失败"}},503);
      if(url.pathname.endsWith("/bootstrap") && ++reads > 1) return new Promise(resolve => {finishBootstrap=resolve;});
      return normal(url);
    };
    render(createElement(LocationPicker,{value:"",onChange:()=>{}}));
    await within(screen.getByRole("combobox",{name:"房间",exact:true})).findByRole("option",{name:"主卧"});
    fireEvent.change(screen.getByLabelText("房间"),{target:{value:"r"}});
    await screen.findByText("房间读取失败", { exact: false });
    fireEvent.click(screen.getByRole("button",{name:"重试"}));
    await screen.findByText("房间读取失败", { exact: false });
    finishBootstrap?.(normal(new URL("http://localhost/api/bootstrap")));
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(screen.getByText("房间读取失败", { exact: false })).toBeTruthy();
  });
  // A missing location breadcrumb or action would leave users unable to identify the correct shelf.
  it("shows an item's location and confirmation actions after selecting a search result", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: /查看护照/ }));
    expect(await screen.findByText("主卧 / 白色衣柜 / 顶层")).toBeTruthy();
    expect(screen.getByRole("button", { name: "就在这里" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "这里没找到" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "在房间中定位" })).toBeTruthy();
  });
  // Slow results from an earlier keyword must not replace the latest user's search.
  it("ignores old search responses that arrive after the latest query", async () => {
    let resolveOld: ((response: Response) => void) | undefined;
    handler = (url) => {
      if (url.searchParams.get("q") === "旧") return new Promise(resolve => { resolveOld = resolve; });
      if (url.searchParams.get("q") === "新") return response({items: [{...item, id:"key", name:"新钥匙"}]});
      return normal(url);
    };
    show();
    const search = await screen.findByRole("searchbox");
    fireEvent.change(search, { target: { value: "旧" } });
    await waitFor(() => expect(resolveOld).toBeTypeOf("function"));
    fireEvent.change(search, { target: { value: "新" } });
    await screen.findByRole("button", { name: /查看新钥匙/ });
    resolveOld!(response({ items: [{...item, name:"旧钥匙"}] }));
    await waitFor(() => expect(screen.queryByRole("button", {name:/查看旧钥匙/})).toBeNull());
    expect(screen.getByRole("button", {name:/查看新钥匙/})).toBeTruthy();
  });
  // A failed batch request must keep the input, and retry must reuse its idempotency ID.
  it("retains a failed batch draft and retries with the same operation id", async () => {
    const submitted: Array<{names: string[]; operation_id: string}> = [];
    handler = (url, init) => {
      if (url.pathname.endsWith("/items/batch")) {
        const input = JSON.parse(String(init.body)); submitted.push(input);
        return submitted.length === 1 ? response({error:{code:"failed",message:"连接中断，请重试"}}, 503) : response({items:[item]}, 201);
      }
      return normal(url);
    };
    show();
    fireEvent.click(await screen.findByRole("button", {name:"登记物品"}));
    await within(screen.getByRole("combobox",{name:"房间",exact:true})).findByRole("option", {name:"主卧"});
    fireEvent.change(screen.getByLabelText("房间"), {target:{value:"r"}});
    await screen.findByRole("option", {name:"白色衣柜"});
    fireEvent.change(screen.getByLabelText("容器"), {target:{value:"c"}});
    fireEvent.click(await screen.findByRole("button", {name:"顶层"}));
    fireEvent.change(screen.getByLabelText("物品名称，每行一件或一组"), {target:{value:"护照\n备用线材一组"}});
    fireEvent.click(screen.getByRole("button", {name:"保存登记"}));
    await screen.findByText("连接中断，请重试", { exact: false });
    expect((screen.getByLabelText("物品名称，每行一件或一组") as HTMLTextAreaElement).value).toBe("护照\n备用线材一组");
    fireEvent.click(screen.getByRole("button", {name:"保存登记"}));
    await waitFor(() => expect(screen.queryByLabelText("物品名称，每行一件或一组")).toBeNull());
    expect(submitted).toHaveLength(2);
    expect(submitted[1].operation_id).toBe(submitted[0].operation_id);
    expect(submitted[1].names).toEqual(["护照", "备用线材一组"]);
  });
  // Concurrent edits must be visible rather than silently overwritten by a stale confirmation.
  it("shows the newest record and conflict when confirming an outdated location", async () => {
    handler = (url, init) => {
      if (url.pathname.endsWith("/confirm")) {
        const payload = JSON.parse(String(init.body));
        if (payload.expected_version !== 2) return response({error:{message:"wrong version"}}, 400);
        return response({error:{code:"version_conflict",message:"位置已被更新，请核对后重试",current:{...item,version:3,location_path:["书房","抽屉柜","下层"]}}},409);
      }
      return normal(url);
    };
    show(); fireEvent.click(await screen.findByRole("button", {name:/查看护照/}));
    fireEvent.click(await screen.findByRole("button", {name:"就在这里"}));
    expect(await screen.findByText("位置已被更新，请核对后重试", { exact: false })).toBeTruthy();
    expect(screen.getByText("书房 / 抽屉柜 / 下层")).toBeTruthy();
  });
});
