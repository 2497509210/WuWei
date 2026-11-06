// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InventoryPage } from "../../frontend/src/pages/InventoryPage";
import type { Item } from "../../frontend/src/api/client";

const me={user:{id:"owner",username:"owner",display_name:"家人",role:"owner" as const},household:{id:"home",name:"我家"}};
const room={id:"r",floor_id:"f",name:"主卧",width_cm:460,depth_cm:360,height_cm:260,wall_color:null,sort:0,container_count:1};
const compartment={id:"cp",container_id:"c",name:"证件层",kind:"shelf",level_index:0,row:0,col:0,sort:0};
const cabinet={id:"c",room_id:"r",preset:"wardrobe",name:"白柜",x_cm:150,z_cm:100,y_cm:0,rot_deg:0,width_cm:180,depth_cm:58,height_cm:220,color:null,config:{layers:1},compartments:[compartment],item_count:2,version:1};
const first:Item={id:"one",name:"护照",aliases:[],notes:"",quantity:2,compartment_id:"cp",room_id:"r",container_id:"c",location_path:["主卧","白柜","证件层"],photo_url:null,version:2,location_status:"confirmed",last_confirmed_at:null,updated_at:"2026-11-05T00:00:00Z",archived_at:null,archive_reason:null};
const second:Item={...first,id:"two",name:"相机",quantity:1};
let items:Item[];
type Handler=(url:URL,init:RequestInit)=>Promise<Response>|Response;
let handler:Handler;
function json(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});}
function normal(url:URL){
  if(url.pathname.endsWith("/bootstrap"))return json({...me,floors:[{id:"f",name:"1 层",level:1,rooms:[room]}]});
  if(url.pathname.endsWith("/rooms/r"))return json({room,containers:[cabinet]});
  if(url.pathname.endsWith("/events"))return json({events:[],has_more:false});
  if(url.pathname.endsWith("/items/one"))return json({item:items[0]});
  if(url.pathname.endsWith("/items"))return json({items:items.filter(item=>Boolean(item.archived_at)===(url.searchParams.get("status")==="archived")&&item.name.includes(url.searchParams.get("q")??""))});
  return json({error:{message:"Unexpected request"}},400);
}
beforeEach(()=>{items=[{...first},{...second}];handler=url=>normal(url);vi.stubGlobal("fetch",(path:string,init:RequestInit={})=>Promise.resolve(handler(new URL(path,"http://localhost"),init)));});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.useRealTimers();});
const props=()=>({me,onLogout:async()=>{},onArrange:()=>{}});
async function enter(){await screen.findByRole("button",{name:"查看护照"});fireEvent.click(screen.getByRole("button",{name:"批量整理"}));}
function select(name:string){fireEvent.click(screen.getByRole("checkbox",{name:`选择${name}`}));}
function moreActions(){if(!screen.queryByRole("button",{name:"刷新清单"}))fireEvent.click(screen.getByRole("button",{name:"更多"}));}
async function destination(){await within(screen.getByRole("combobox",{name:"房间",exact:true})).findByRole("option",{name:"主卧"});fireEvent.change(screen.getByLabelText("房间"),{target:{value:"r"}});await screen.findByRole("option",{name:"白柜"});fireEvent.change(screen.getByLabelText("容器"),{target:{value:"c"}});fireEvent.click(screen.getByRole("button",{name:"证件层"}));}

describe("bulk selection",()=>{
  // A selection mode must keep details accessible without nesting interactive controls.
  it("disables bulk writes with no selection and keeps ordinary details separate",async()=>{
    render(createElement(InventoryPage,props()));await enter();
    expect((screen.getByRole("button",{name:"批量移动"}) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button",{name:"批量归档"}) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("checkbox",{name:"选择护照"}).closest("button")).toBeNull();
    fireEvent.click(screen.getByRole("button",{name:"查看护照"}));await screen.findByRole("dialog",{name:"护照"});
  });
  // Select-all must reject an oversized displayed result instead of silently operating on the first hundred.
  it("rejects selecting more than one hundred displayed records without partial selection",async()=>{
    items=Array.from({length:101},(_,index)=>({...first,id:String(index),name:index===0?"护照":`物品${index}`}));
    render(createElement(InventoryPage,props()));await enter();
    fireEvent.click(screen.getByRole("button",{name:"全选当前页"}));
    expect(screen.getByText("当前结果超过 100 条，请缩小筛选范围后再全选")).toBeTruthy();
    expect(screen.getAllByRole("checkbox").filter(input=>(input as HTMLInputElement).checked)).toHaveLength(0);
  });
  // Changing query/status clears hidden selections immediately, including when an older read returns later.
  it("clears selection on a query change and ignores old list results",async()=>{
    let finishOld:((response:Response)=>void)|undefined;
    handler=url=>url.pathname.endsWith("/items")&&url.searchParams.get("q")==="旧"?new Promise(resolve=>{finishOld=resolve;}):normal(url);
    render(createElement(InventoryPage,props()));await enter();select("护照");
    fireEvent.change(screen.getByRole("searchbox"),{target:{value:"旧"}});await waitFor(()=>expect(finishOld).toBeTypeOf("function"));
    fireEvent.change(screen.getByRole("searchbox"),{target:{value:"相机"}});await screen.findByRole("checkbox",{name:"选择相机"});
    await act(async()=>{finishOld?.(json({items:[first]}));});
    expect(screen.queryByRole("checkbox",{name:"选择护照"})).toBeNull();
    expect(screen.getByText("已选 0 条")).toBeTruthy();
  });
  // A background refresh cannot silently upgrade the version chosen before another device changed the item.
  it("keeps selected version snapshots when the visible list is refreshed",async()=>{
    const submitted:Array<{items:Array<{id:string;expected_version:number}>}>=[];
    handler=(url,init)=>{
      if(url.pathname.endsWith("/actions/bulk")){submitted.push(JSON.parse(String(init.body)));return json({items:[first],processed:1,changed:0,replayed:false});}
      return normal(url);
    };
    render(createElement(InventoryPage,props()));await enter();select("护照");
    items=[{...first,version:9},second];moreActions();fireEvent.click(screen.getByRole("button",{name:"刷新清单"}));
    await screen.findByRole("checkbox",{name:"选择护照"});
    fireEvent.click(screen.getByRole("button",{name:"批量归档"}));fireEvent.click(screen.getByRole("button",{name:"确认归档"}));
    await waitFor(()=>expect(submitted).toHaveLength(1));expect(submitted[0].items).toEqual([{id:"one",expected_version:2}]);
  });
  // An identity change must discard selected private records and any open confirmation.
  it("clears the selection and confirmation when the signed-in household changes",async()=>{
    const view=render(createElement(InventoryPage,props()));await enter();select("护照");fireEvent.click(screen.getByRole("button",{name:"批量归档"}));
    await screen.findByRole("dialog",{name:"批量归档"});
    view.rerender(createElement(InventoryPage,{...props(),me:{...me,user:{...me.user,id:"other"},household:{id:"other",name:"别家"}}}));
    expect(screen.queryByRole("dialog")).toBeNull();expect(screen.queryByRole("checkbox")).toBeNull();
  });
  // A refreshed result can remove a record from this scope; it must no longer remain a hidden target.
  it("drops selections that disappear from the refreshed visible results",async()=>{
    render(createElement(InventoryPage,props()));await enter();select("护照");
    items=[second];moreActions();fireEvent.click(screen.getByRole("button",{name:"刷新清单"}));
    await screen.findByRole("checkbox",{name:"选择相机"});
    await waitFor(()=>expect(screen.queryByRole("checkbox",{name:"选择护照"})).toBeNull());
    expect(screen.getByText("已选 0 条")).toBeTruthy();
    expect((screen.getByRole("button",{name:"批量归档"}) as HTMLButtonElement).disabled).toBe(true);
  });
  // The export entry must carry exactly the current filter and selected IDs into its explicit scope chooser.
  it("opens export with the current filter and selected item count",async()=>{
    render(createElement(InventoryPage,{...props(),initialCompartment:"cp"}));await enter();select("护照");
    moreActions();fireEvent.click(screen.getByRole("button",{name:"导出清单"}));
    const dialog=await screen.findByRole("dialog",{name:"导出清单"});
    expect(within(dialog).getByText("范围：在用 · 不限关键词 · 当前隔层")).toBeTruthy();
    expect((within(dialog).getByRole("radio",{name:"所选物品（1 件）"}) as HTMLInputElement).disabled).toBe(false);
  });
});

describe("bulk confirmation and recovery",()=>{
  // A failed write preserves the exact selected versions and reason under the same idempotency ID.
  it("lists selected names and quantities and retries a failed archive with the same request",async()=>{
    const requests:Array<Record<string,unknown>>=[];
    handler=(url,init)=>{
      if(url.pathname.endsWith("/actions/bulk")){
        const input=JSON.parse(String(init.body));requests.push(input);
        if(requests.length===1)return json({error:{message:"暂时无法归档"}},503);
        items=items.map(item=>({...item,archived_at:"2026-11-05T01:00:00Z",archive_reason:input.reason,version:3}));
        return json({items,processed:2,changed:2,replayed:true});
      }return normal(url);
    };
    render(createElement(InventoryPage,props()));await enter();select("护照");select("相机");fireEvent.click(screen.getByRole("button",{name:"批量归档"}));
    const dialog=await screen.findByRole("dialog",{name:"批量归档"});
    expect(within(dialog).getByText("护照")).toBeTruthy();expect(within(dialog).getByText("数量 2")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("归档原因（选填）"),{target:{value:"暂时不用"}});
    fireEvent.click(screen.getByRole("button",{name:"确认归档"}));await screen.findByText("暂时无法归档", { exact: false });
    expect((screen.getByLabelText("归档原因（选填）") as HTMLTextAreaElement).value).toBe("暂时不用");
    fireEvent.click(screen.getByRole("button",{name:"确认归档"}));await screen.findByText("已处理 2 条，实际更改 2 条");
    expect(requests[0]).toEqual(requests[1]);expect(requests[1].reason).toBe("暂时不用");
  });
  // A conflict must block repeating the old batch until the user explicitly refreshes and reselects.
  it("requires refreshing and reselecting after a version conflict",async()=>{
    handler=(url)=>url.pathname.endsWith("/actions/bulk")?json({error:{code:"bulk_conflict",message:"记录已变化，请刷新重新选择"}},409):normal(url);
    render(createElement(InventoryPage,props()));await enter();select("护照");fireEvent.click(screen.getByRole("button",{name:"批量归档"}));
    fireEvent.click(screen.getByRole("button",{name:"确认归档"}));await screen.findByText("记录已变化，请刷新重新选择", { exact: false });
    expect((screen.getByRole("button",{name:"确认归档"}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button",{name:"刷新并重新选择"}));
    await waitFor(()=>expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("已选 0 条")).toBeTruthy();
  });
  // A same-shelf move is valid but must explain that unchanged records keep their versions.
  it("requires a destination and explains unchanged records when moving to their existing shelf",async()=>{
    handler=(url,init)=>{
      if(url.pathname.endsWith("/actions/bulk")){
        const input=JSON.parse(String(init.body));
        return input.action==="move"&&input.compartment_id==="cp"?json({items:[first],processed:1,changed:0,replayed:false}):json({error:{message:"wrong move"}},400);
      }return normal(url);
    };
    render(createElement(InventoryPage,props()));await enter();select("护照");fireEvent.click(screen.getByRole("button",{name:"批量移动"}));
    expect((screen.getByRole("button",{name:"确认移动"}) as HTMLButtonElement).disabled).toBe(true);
    await destination();expect(screen.getByText("1 条记录已在这个隔层，移动时将保持不变")).toBeTruthy();
    fireEvent.click(screen.getByRole("button",{name:"确认移动"}));await screen.findByText("已处理 1 条，实际更改 0 条");
  });
  // Archived mode may restore selected records to a newly chosen location, never expose archive/move actions.
  it("offers only restore for archived records and sends its chosen destination",async()=>{
    items=items.map(item=>({...item,archived_at:"2026-11-05T01:00:00Z",compartment_id:null}));
    handler=(url,init)=>{
      if(url.pathname.endsWith("/actions/bulk")){
        const input=JSON.parse(String(init.body));
        return input.action==="restore"&&input.compartment_id==="cp"?json({items:[first],processed:1,changed:1,replayed:false}):json({error:{message:"wrong restore"}},400);
      }return normal(url);
    };
    render(createElement(InventoryPage,props()));fireEvent.click(screen.getByRole("button",{name:"已归档"}));await enter();select("护照");
    expect(screen.queryByRole("button",{name:"批量移动"})).toBeNull();expect(screen.queryByRole("button",{name:"批量归档"})).toBeNull();
    fireEvent.click(screen.getByRole("button",{name:"批量恢复"}));await destination();
    fireEvent.click(screen.getByRole("button",{name:"确认恢复"}));await screen.findByText("已处理 1 条，实际更改 1 条");
  });
  // A stopped or timed-out batch can have committed; retry must preserve its exact operation and selected versions.
  it("times out a stalled bulk request and retains the same operation for retry",async()=>{
    const requests:Array<Record<string,unknown>>=[];
    handler=(url,init)=>{
      if(url.pathname.endsWith("/actions/bulk")){
        requests.push(JSON.parse(String(init.body)));
        return requests.length===1?new Promise(()=>{}):json({items:[first],processed:1,changed:1,replayed:true});
      }return normal(url);
    };
    render(createElement(InventoryPage,props()));await enter();select("护照");fireEvent.click(screen.getByRole("button",{name:"批量归档"}));
    vi.useFakeTimers();
    try{
      fireEvent.click(screen.getByRole("button",{name:"确认归档"}));await act(async()=>{await vi.advanceTimersByTimeAsync(30_000);});
      expect(screen.queryByText(/尚未确认批量操作结果/)).not.toBeNull();
      expect((screen.getByRole("button",{name:"确认归档"}) as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(screen.getByRole("button",{name:"确认归档"}));await act(async()=>{});
      expect(requests[0]).toEqual(requests[1]);
    }finally{vi.useRealTimers();}
  });
  // A canceled browser wait must preserve the batch and ignore a late successful response when retrying.
  it("stops waiting and retries the same batch without accepting its older response",async()=>{
    const requests:Array<{input:unknown;finish:(response:Response)=>void}>=[];
    handler=(url,init)=>url.pathname.endsWith("/actions/bulk")?new Promise(resolve=>{requests.push({input:JSON.parse(String(init.body)),finish:resolve});}):normal(url);
    render(createElement(InventoryPage,props()));await enter();select("护照");fireEvent.click(screen.getByRole("button",{name:"批量归档"}));
    fireEvent.click(screen.getByRole("button",{name:"确认归档"}));fireEvent.click(screen.getByRole("button",{name:"停止等待"}));
    await screen.findByText(/尚未确认批量操作结果/);
    fireEvent.click(screen.getByRole("button",{name:"确认归档"}));
    await act(async()=>{requests[0].finish(json({items:[first],processed:1,changed:1,replayed:false}));});
    expect(screen.getByRole("dialog",{name:"批量归档"})).toBeTruthy();
    await act(async()=>{requests[1].finish(json({items:[first],processed:1,changed:1,replayed:true}));});
    await screen.findByText("已处理 1 条，实际更改 1 条");
    expect(requests[0].input).toEqual(requests[1].input);
  });
  // A draft edit starts a new idempotency operation, while repeated identical submits are serialized.
  it("creates a new operation after changing a failed reason and blocks duplicate submissions",async()=>{
    const requests:Array<{input:Record<string,unknown>;finish?:(response:Response)=>void}>=[];
    handler=(url,init)=>{
      if(url.pathname.endsWith("/actions/bulk")){
        const input=JSON.parse(String(init.body));
        if(requests.length===0){requests.push({input});return json({error:{message:"再试一次"}},503);}
        return new Promise(resolve=>{requests.push({input,finish:resolve});});
      }return normal(url);
    };
    render(createElement(InventoryPage,props()));await enter();select("护照");fireEvent.click(screen.getByRole("button",{name:"批量归档"}));
    fireEvent.click(screen.getByRole("button",{name:"确认归档"}));await screen.findByText("再试一次", { exact: false });
    fireEvent.change(screen.getByLabelText("归档原因（选填）"),{target:{value:"新的原因"}});
    const form=screen.getByRole("button",{name:"确认归档"}).closest("form")!;
    act(()=>{fireEvent.submit(form);fireEvent.submit(form);});
    expect(requests).toHaveLength(2);expect(requests[0].input.operation_id).not.toBe(requests[1].input.operation_id);
    await act(async()=>{requests[1].finish?.(json({items:[first],processed:1,changed:1,replayed:false}));});
  });
});
