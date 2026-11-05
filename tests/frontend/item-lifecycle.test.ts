// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InventoryPage } from "../../frontend/src/pages/InventoryPage";
import * as api from "../../frontend/src/api/client";

const me = { user: { id: "u", username: "owner", display_name: "家人", role: "owner" as const }, household: { id: "h", name: "我家" } };
const room = { id: "r", floor_id: "f", name: "书房", width_cm: 400, depth_cm: 400, height_cm: 260, wall_color: null, sort: 0, container_count: 1 };
const compartment = { id: "cp", container_id: "c", name: "证件层", default_name: "顶层", custom_name: "证件层", kind: "shelf", level_index: 0, row: 0, col: 0, sort: 0 };
const cabinet = { id: "c", room_id: "r", preset: "wardrobe", name: "白柜", x_cm: 150, z_cm: 100, y_cm: 0, rot_deg: 0, width_cm: 180, depth_cm: 58, height_cm: 220, color: null, config: {layers: 1}, compartments: [compartment], item_count: 1, version: 4 };
const original = { id: "passport", name: "护照", aliases: ["证件"], notes: "蓝色袋子", quantity: 1, compartment_id: "cp", room_id: "r", container_id: "c", photo_url: null, location_path: ["书房", "白柜", "证件层"], version: 2, location_status: "confirmed", last_confirmed_at: "2026-11-05T10:00:00Z", updated_at: "2026-11-05T10:00:00Z", archived_at: null as string|null, archive_reason: null as string|null };
const move = { id: "event-move", type: "move", created_at: "2026-11-05T10:00:00Z", actor_name: "小林", from_path: ["旧卧室", "旧抽屉", "上层"], to_path: ["旧书房", "旧白柜", "证件层"], changes: {}, item_version: 2, can_undo: true, legacy: false };
let item: typeof original;
type Handler = (url: URL, init: RequestInit) => Promise<Response>|Response;
let handler: Handler;
function response(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: {"Content-Type": "application/json"} }); }
function normal(url: URL): Response {
  if (url.pathname.endsWith("/bootstrap")) return response({...me, floors: [{id: "f", name: "1 层", level: 1, rooms: [room]}]});
  if (url.pathname.endsWith("/rooms/r")) return response({room, containers: [cabinet]});
  if (url.pathname.endsWith("/events")) return response({ events: [], has_more: false });
  if (url.pathname.endsWith("/items/passport")) return response({item});
  if (url.pathname.endsWith("/items")) return response({items: (url.searchParams.get("status") === "archived") === Boolean(item.archived_at) ? [item] : []});
  return response({error: {message: "Unexpected request"}}, 400);
}
beforeEach(() => {
  item = {...original};
  handler = url => normal(url);
  vi.stubGlobal("fetch", (input: string, init: RequestInit = {}) => Promise.resolve(handler(new URL(input, "http://localhost"), init)));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function show() { render(createElement(InventoryPage, { me, onLogout: async () => {}, onArrange: () => {} })); }
async function openItem() { fireEvent.click(await screen.findByRole("button", {name: "查看护照"})); await waitFor(() => expect(screen.queryByText("正在核对最新记录…")).toBeNull()); }

describe("item archive and history workflows", () => {
  // A status switch must request archived data rather than showing archived items in the default list.
  it("shows active items by default and loads archived items on demand", async () => {
    item = {...original, archived_at: "2026-11-05T11:00:00Z", archive_reason: "已换新证"};
    show(); await screen.findByText("给第一件物品留下位置");
    expect(screen.queryByRole("button", {name: "查看护照"})).toBeNull();
    fireEvent.click(screen.getByRole("button", {name: "已归档"}));
    expect(await screen.findByRole("button", {name: "查看护照"})).toBeTruthy();
    expect(screen.queryByRole("button", {name: "登记物品"})).toBeNull();
  });
  // A failed archive must retain the reason and retry the intended version, then leave active results.
  it("retains an archive reason after failure and refreshes the list after retry", async () => {
    let attempts = 0;
    handler = (url, init) => {
      if (url.pathname.endsWith("/archive")) {
        const payload = JSON.parse(String(init.body));
        if (payload.expected_version !== 2 || payload.reason !== "已换新证") return response({error:{message:"wrong archive payload"}},400);
        if (++attempts === 1) return response({error:{message:"归档连接失败"}},503);
        item = {...item, archived_at: "2026-11-05T11:00:00Z", archive_reason: payload.reason, version: 3};
        return response({item});
      }
      return normal(url);
    };
    show(); await openItem();
    fireEvent.click(screen.getByRole("button", {name:"归档物品"}));
    fireEvent.change(screen.getByLabelText("归档原因（选填）"), {target:{value:"已换新证"}});
    fireEvent.click(screen.getByRole("button", {name:"确认归档"}));
    await screen.findByText("归档连接失败");
    expect((screen.getByLabelText("归档原因（选填）") as HTMLTextAreaElement).value).toBe("已换新证");
    fireEvent.click(screen.getByRole("button", {name:"确认归档"}));
    await screen.findByText("物品已归档，可在「已归档」中恢复");
    fireEvent.click(screen.getByRole("button", {name:"关闭对话框"}));
    await waitFor(() => expect(screen.queryByRole("button", {name:"查看护照"})).toBeNull());
  });
  // Archived details must not expose writes; restoration requires an explicitly selected valid shelf.
  it("keeps archived details read only and preserves the selected destination after a failed restore", async () => {
    item = {...original, archived_at:"2026-11-05T11:00:00Z", archive_reason:"暂时收起"};
    let attempts = 0;
    handler = (url, init) => {
      if (url.pathname.endsWith("/restore")) {
        const payload = JSON.parse(String(init.body));
        if (payload.expected_version !== 2 || payload.compartment_id !== "cp") return response({error:{message:"wrong restore payload"}},400);
        if (++attempts === 1) return response({error:{message:"恢复连接失败"}},503);
        item = {...original,version:3}; return response({item});
      }
      return normal(url);
    };
    show(); fireEvent.click(screen.getByRole("button", {name:"已归档"})); await openItem();
    expect(screen.queryByRole("button", {name:"就在这里"})).toBeNull();
    expect(screen.queryByRole("button", {name:"编辑资料"})).toBeNull();
    expect(screen.queryByLabelText("物品照片")).toBeNull();
    fireEvent.click(screen.getByRole("button", {name:"恢复物品"}));
    expect((screen.getByRole("button", {name:"确认恢复"}) as HTMLButtonElement).disabled).toBe(true);
    await within(screen.getByRole("combobox",{name:"房间",exact:true})).findByRole("option", {name:"书房"});
    fireEvent.change(screen.getByLabelText("房间"), {target:{value:"r"}});
    await screen.findByRole("option", {name:"白柜"});
    fireEvent.change(screen.getByLabelText("容器"), {target:{value:"c"}});
    fireEvent.click(screen.getByRole("button", {name:"证件层"}));
    fireEvent.click(screen.getByRole("button", {name:"确认恢复"}));
    await screen.findByText("恢复连接失败");
    expect(screen.getByRole("button", {name:"证件层"}).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", {name:"确认恢复"}));
    await screen.findByText("物品已恢复到所选位置");
    expect(screen.getByRole("button", {name:"就在这里"})).toBeTruthy();
  });
  // History uses stored names and can retry pagination without replacing previously loaded entries.
  it("shows actor and historical paths and retries a failed next page", async () => {
    let nextAttempts = 0;
    handler = url => {
      if (url.pathname.endsWith("/events")) {
        if (url.searchParams.get("offset") === "0") return response({events:[move],has_more:true});
        if (++nextAttempts === 1) return response({error:{message:"历史加载失败"}},503);
        return response({events:[{...move,id:"legacy",type:"create",actor_name:null,from_path:null,to_path:null,can_undo:false,legacy:true}],has_more:false});
      }
      return normal(url);
    };
    show(); await openItem();
    const history = await screen.findByRole("region", {name:"操作历史"});
    expect(await within(history).findByText("小林")).toBeTruthy();
    expect(within(history).getByText("旧卧室 / 旧抽屉 / 上层")).toBeTruthy();
    expect(within(history).getByText("旧书房 / 旧白柜 / 证件层")).toBeTruthy();
    fireEvent.click(within(history).getByRole("button", {name:"加载更早记录"}));
    await within(history).findByText("历史加载失败");
    expect(within(history).getByText("小林")).toBeTruthy();
    fireEvent.click(within(history).getByRole("button", {name:"重试历史"}));
    await within(history).findByText("历史信息不完整");
    expect(within(history).queryByRole("button", {name:"加载更早记录"})).toBeNull();
  });
  // Undo must use the current item version and reload event eligibility after success.
  it("undoes an eligible move and refreshes history and the current location", async () => {
    let undone = false;
    handler = (url, init) => {
      if (url.pathname.endsWith("/events")) return response({events:undone ? [{...move,type:"undo",id:"undo",can_undo:false}] : [move],has_more:false});
      if (url.pathname.endsWith("/events/event-move/undo")) {
        if (JSON.parse(String(init.body)).expected_version !== 2) return response({error:{message:"wrong undo version"}},400);
        undone = true; item = {...item, location_path:move.from_path, version:3}; return response({item});
      }
      return normal(url);
    };
    show(); await openItem();
    fireEvent.click(await screen.findByRole("button", {name:"撤销这次移动"}));
    await screen.findByText("已撤销这次移动");
    const location = screen.getByText("记录的位置").parentElement!;
    expect(within(location).getByText("旧卧室 / 旧抽屉 / 上层")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", {name:"撤销这次移动"})).toBeNull());
  });
  // A concurrent update must replace stale data, invalidate old undo controls, and never repeat a write.
  it("shows the latest record and history when undo returns a version conflict", async () => {
    handler = (url, init) => {
      if (url.pathname.endsWith("/events")) return response({events:[{...move,can_undo:item.version===2}],has_more:false});
      if (url.pathname.endsWith("/undo")) {
        item = {...item,version:3,location_path:["新的房间","新的柜子"]};
        return response({error:{code:"version_conflict",message:"物品已被更新",current:item}},409);
      }
      return normal(url);
    };
    show(); await openItem(); fireEvent.click(await screen.findByRole("button", {name:"撤销这次移动"}));
    await screen.findByText("物品已被更新");
    expect(screen.getByText("新的房间 / 新的柜子")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", {name:"撤销这次移动"})).toBeNull());
  });
  // The archived tab must clear the current shelf filter because archived items have no live shelf.
  it("finds archived items even when opening inventory from a particular shelf", async () => {
    item = {...original,archived_at:"2026-11-05T11:00:00Z",archive_reason:"暂时不用"};
    handler = url => url.pathname.endsWith("/items") && url.searchParams.has("compartment_id")
      ? response({items:[]}) : normal(url);
    render(createElement(InventoryPage, {me,onLogout:async()=>{},onArrange:()=>{},initialCompartment:"old-shelf"}));
    fireEvent.click(screen.getByRole("button",{name:"已归档"}));
    expect(await screen.findByRole("button",{name:"查看护照"})).toBeTruthy();
  });
  // A version conflict must preserve an unfinished reason but require a second, fresh confirmation.
  it("retains the archive reason after a conflict and uses the newly displayed version only on reconfirmation", async () => {
    let attempted = false;
    handler = (url, init) => {
      if (url.pathname.endsWith("/archive")) {
        const input = JSON.parse(String(init.body));
        if (!attempted) {
          attempted = true; item = {...item,version:3,notes:"另一位家人补充了备注"};
          return response({error:{code:"version_conflict",message:"记录已被其他家人更新",current:item}},409);
        }
        if (input.expected_version !== 3 || input.reason !== "暂时不用") return response({error:{message:"wrong reconfirmation"}},400);
        item = {...item,version:4,archived_at:"2026-11-05T11:00:00Z",archive_reason:input.reason}; return response({item});
      }
      return normal(url);
    };
    show(); await openItem();
    fireEvent.click(screen.getByRole("button",{name:"归档物品"}));
    fireEvent.change(screen.getByLabelText("归档原因（选填）"),{target:{value:"暂时不用"}});
    fireEvent.click(screen.getByRole("button",{name:"确认归档"}));
    await screen.findByText("记录已被其他家人更新");
    expect((screen.getByLabelText("归档原因（选填）") as HTMLTextAreaElement).value).toBe("暂时不用");
    expect(screen.getByText("另一位家人补充了备注")).toBeTruthy();
    fireEvent.click(screen.getByRole("button",{name:"确认归档"}));
    await screen.findByText("物品已归档，可在「已归档」中恢复");
  });
  // A stale page that arrives after a mutation cannot restore obsolete undo permissions.
  it("ignores a history page that arrives after the item has changed", async () => {
    let finishOld: ((response:Response)=>void)|undefined;
    handler = (url, init) => {
      if (url.pathname.endsWith("/events")) {
        if (url.searchParams.get("offset") !== "0") return new Promise(resolve=>{finishOld=resolve;});
        return response({events:[{...move,can_undo:item.version===2}],has_more:item.version===2});
      }
      if (url.pathname.endsWith("/confirm")) {item={...item,version:3};return response({item});}
      return normal(url);
    };
    show(); await openItem();
    fireEvent.click(await screen.findByRole("button",{name:"加载更早记录"}));
    fireEvent.click(screen.getByRole("button",{name:"就在这里"}));
    await screen.findByText("已确认物品就在这里");
    await act(async()=>{finishOld?.(response({events:[{...move,id:"stale-event",actor_name:"过期分页"}],has_more:false}));});
    await waitFor(()=>expect(screen.queryByRole("button",{name:"撤销这次移动"})).toBeNull());
    expect(screen.queryByText("过期分页")).toBeNull();
  });
  // A non-version conflict can mean the object was archived elsewhere; reload before exposing writes.
  it("reloads a remotely archived item when undo is no longer available", async () => {
    handler = (url, init) => {
      if(url.pathname.endsWith("/events")) return response({events:[{...move,can_undo:!item.archived_at}],has_more:false});
      if(url.pathname.endsWith("/undo")) {
        item={...item,version:3,archived_at:"2026-11-05T11:00:00Z",archive_reason:"家人已归档"};
        return response({error:{code:"item_archived",message:"物品已归档"}},409);
      }
      return normal(url);
    };
    show(); await openItem();fireEvent.click(await screen.findByRole("button",{name:"撤销这次移动"}));
    await screen.findByText("家人已归档");
    expect(screen.queryByRole("button",{name:"编辑资料"})).toBeNull();
    expect(screen.getByRole("button",{name:"恢复物品"})).toBeTruthy();
  });
});

describe("compartment API contract", () => {
  // Renaming must carry the containing cabinet version and allow null to restore its automatic name.
  it("renames and resets a compartment through the versioned API", async () => {
    handler = (url, init) => {
      const input = JSON.parse(String(init.body));
      if (!url.pathname.endsWith("/compartments/cp") || init.method !== "PATCH" || input.expected_container_version !== 4) {
        return response({error:{message:"wrong rename request"}},400);
      }
      return response({container:{...cabinet,version:5,compartments:[{...compartment,custom_name:input.custom_name,name:input.custom_name ?? "顶层"}]}});
    };
    expect(typeof api.renameCompartment).toBe("function");
    expect((await api.renameCompartment("cp",4,"证件资料")).container.compartments[0].name).toBe("证件资料");
    expect((await api.renameCompartment("cp",4,null)).container.compartments[0].name).toBe("顶层");
  });
});
