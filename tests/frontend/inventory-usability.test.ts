// @vitest-environment jsdom
import { createElement, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InventoryPage } from "../../frontend/src/pages/InventoryPage";
import type { Item } from "../../frontend/src/api/client";

const me = {user:{id:"owner",username:"owner",display_name:"家人",role:"owner" as const},household:{id:"home",name:"我家"}};
const bedroom = {id:"bedroom",floor_id:"floor",name:"主卧",width_cm:460,depth_cm:360,height_cm:260,wall_color:null,sort:0,container_count:1};
const study = {...bedroom,id:"study",name:"书房"};
const original:Item = {id:"item-1",name:"物品1",aliases:[],notes:"",quantity:1,compartment_id:"shelf",room_id:"bedroom",container_id:"cabinet",location_path:["主卧","衣柜","顶层"],photo_url:null,version:2,location_status:"confirmed",last_confirmed_at:null,updated_at:"2026-11-05T00:00:00Z",archived_at:null,archive_reason:null};
let items:Item[];
type Handler=(url:URL,init:RequestInit)=>Promise<Response>|Response;
let handler:Handler;
let exported:Record<string,unknown>|undefined;
const originalCreateURL=Object.getOwnPropertyDescriptor(URL,"createObjectURL");
const originalRevokeURL=Object.getOwnPropertyDescriptor(URL,"revokeObjectURL");
function json(data:unknown,status=200){return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json"}});}
function normal(url:URL,init:RequestInit):Response {
  if(url.pathname.endsWith("/locations/compartments/shelf")) return json({location:{room_id:"bedroom",container_id:"cabinet",compartment_id:"shelf",path:["主卧","衣柜","顶层"]}});
  if(url.pathname.endsWith("/bootstrap")) return json({...me,floors:[{id:"floor",name:"1 层",level:1,rooms:[bedroom,study]}]});
  if(url.pathname.endsWith("/events")) return json({events:[],has_more:false});
  if(url.pathname.endsWith("/items/item-1")) return json({item:items[0]});
  if(url.pathname.endsWith("/inventory/export")) {
    exported=JSON.parse(String(init.body));
    return new Response("\ufeff名称\n物品1",{headers:{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":'attachment; filename="wuwei-inventory.csv"'}});
  }
  if(url.pathname.endsWith("/items")) {
    const filtered=items.filter(item=>Boolean(item.archived_at)===(url.searchParams.get("status")==="archived")
      &&(!url.searchParams.get("q")||item.name.includes(url.searchParams.get("q")!))
      &&(!url.searchParams.get("room_id")||item.room_id===url.searchParams.get("room_id"))
      &&(!url.searchParams.get("location_status")||item.location_status===url.searchParams.get("location_status"))
      &&(!url.searchParams.get("compartment_id")||item.compartment_id===url.searchParams.get("compartment_id")));
    if(!url.searchParams.has("page"))return json({items:filtered});
    const page=Number(url.searchParams.get("page")),size=Number(url.searchParams.get("page_size"));
    return json({items:filtered.slice((page-1)*size,page*size),total:filtered.length,page,page_size:size,has_more:page*size<filtered.length});
  }
  return json({error:{message:"Unexpected request"}},400);
}
beforeEach(()=>{
  items=Array.from({length:81},(_,index)=>({...original,id:`item-${index+1}`,name:`物品${index+1}`}));exported=undefined;
  handler=normal;
  vi.stubGlobal("fetch",(input:string,init:RequestInit={})=>Promise.resolve(handler(new URL(input,"http://localhost"),init)));
  Object.defineProperty(URL,"createObjectURL",{configurable:true,value:()=>"blob:export-test"});
  Object.defineProperty(URL,"revokeObjectURL",{configurable:true,value:()=>{}});
});
afterEach(()=>{
  cleanup();vi.unstubAllGlobals();
  if(originalCreateURL)Object.defineProperty(URL,"createObjectURL",originalCreateURL);else Reflect.deleteProperty(URL,"createObjectURL");
  if(originalRevokeURL)Object.defineProperty(URL,"revokeObjectURL",originalRevokeURL);else Reflect.deleteProperty(URL,"revokeObjectURL");
});
const props=()=>({me,onLogout:async()=>{},onArrange:()=>{}});
async function show(){render(createElement(InventoryPage,props()));await screen.findByRole("button",{name:"查看物品1",exact:true});}

describe("inventory everyday controls",()=>{
  // Secondary actions should not take first-screen space until the user explicitly opens More.
  it("keeps secondary controls in More while search and registration stay available",async()=>{
    await show();
    expect(screen.getByRole("searchbox",{name:"搜索物品"})).toBeTruthy();
    expect(screen.getByRole("button",{name:"拍照登记",exact:true})).toBeTruthy();
    expect(screen.getByRole("button",{name:"登记物品",exact:true})).toBeTruthy();
    expect(screen.queryByRole("button",{name:"刷新清单"})).toBeNull();
    expect(screen.queryByRole("button",{name:"导出清单"})).toBeNull();
    expect(screen.queryByRole("button",{name:"添加到手机桌面"})).toBeNull();
    fireEvent.click(screen.getByRole("button",{name:"更多"}));
    expect(screen.getByRole("button",{name:"刷新清单"})).toBeTruthy();
    expect(screen.getByRole("button",{name:"导出清单"})).toBeTruthy();
    expect(screen.getByRole("button",{name:"添加到手机桌面"})).toBeTruthy();
    fireEvent.click(screen.getByRole("button",{name:"更多"}));
    expect(screen.queryByRole("button",{name:"添加到手机桌面"})).toBeNull();
  });
  // Missing means active+missing, not every active record or archived records with historical missing state.
  it("filters pending finds separately and clears room filtering when switching to archived",async()=>{
    items=[{...original,location_status:"missing"},{...original,id:"two",name:"已确认物品"},
      {...original,id:"three",name:"归档旧物",archived_at:"2026-11-05T01:00:00Z",compartment_id:null,room_id:null,container_id:null,location_status:"missing"}];
    await show();
    await screen.findByRole("option",{name:"主卧"});
    fireEvent.change(screen.getByRole("combobox",{name:"筛选房间"}),{target:{value:"bedroom"}});
    fireEvent.click(screen.getByRole("button",{name:"待找回",exact:true}));
    await waitFor(()=>expect(screen.queryByRole("button",{name:"查看已确认物品"})).toBeNull());
    expect(await screen.findByRole("button",{name:"查看物品1",exact:true})).toBeTruthy();
    fireEvent.click(screen.getByRole("button",{name:"已归档",exact:true}));
    expect(await screen.findByRole("button",{name:"查看归档旧物"})).toBeTruthy();
    expect((screen.getByRole("combobox",{name:"筛选房间"}) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole("combobox",{name:"筛选房间"}) as HTMLSelectElement).value).toBe("");
  });
  // Picking a different room must clear a deep-linked shelf instead of accidentally intersecting incompatible locations.
  it("clears the current shelf when choosing a different room",async()=>{
    items=[original,{...original,id:"study-item",name:"书房物品",room_id:"study",compartment_id:"study-shelf"}];
    let clears=0;
    render(createElement(InventoryPage,{...props(),initialCompartment:"shelf",onClearCompartment:()=>{clears++;}}));
    await screen.findByRole("button",{name:"查看物品1",exact:true});await screen.findByRole("option",{name:"书房"});
    fireEvent.change(screen.getByRole("combobox",{name:"筛选房间"}),{target:{value:"study"}});
    expect(await screen.findByRole("button",{name:"查看书房物品"})).toBeTruthy();
    expect(screen.queryByRole("button",{name:"查看物品1",exact:true})).toBeNull();
    expect(clears).toBe(1);
  });
  // The parent removes the old shelf URL after room selection; that acknowledgement must not erase the new room.
  it("retains the selected room after the route clears its previous shelf",async()=>{
    items=[original,{...original,id:"study-item",name:"书房物品",room_id:"study",compartment_id:"study-shelf"}];
    function Route(){const[shelf,setShelf]=useState("shelf");return createElement(InventoryPage,{...props(),initialCompartment:shelf,onClearCompartment:()=>setShelf("")});}
    render(createElement(Route));await screen.findByRole("button",{name:"查看物品1",exact:true});await screen.findByRole("option",{name:"书房"});
    fireEvent.change(screen.getByRole("combobox",{name:"筛选房间"}),{target:{value:"study"}});
    await screen.findByRole("button",{name:"查看书房物品"});
    expect((screen.getByRole("combobox",{name:"筛选房间"}) as HTMLSelectElement).value).toBe("study");
    expect(screen.queryByRole("button",{name:"查看物品1",exact:true})).toBeNull();
  });
  // Empty result rows cannot establish the shelf's room; use its independently resolved location before clearing it.
  it("preserves an empty shelf when the selected room is its actual room",async()=>{
    items=[];let cleared=0;const queries:URL[]=[];
    handler=(url,init)=>{if(url.pathname.endsWith("/items"))queries.push(url);return normal(url,init);};
    render(createElement(InventoryPage,{...props(),initialCompartment:"shelf",onClearCompartment:()=>{cleared++;}}));
    await screen.findByRole("option",{name:"主卧"});await screen.findByText("给第一件物品留下位置");
    fireEvent.change(screen.getByRole("combobox",{name:"筛选房间"}),{target:{value:"bedroom"}});
    await waitFor(()=>expect(queries.at(-1)?.searchParams.get("room_id")).toBe("bedroom"));
    expect(queries.at(-1)?.searchParams.get("compartment_id")).toBe("shelf");
    expect(cleared).toBe(0);
  });
  // Slow location lookup must apply only the latest explicit room choice, without widening an empty shelf early.
  it("does not clear the shelf from a superseded room choice while location resolution is pending",async()=>{
    items=[];let cleared=0;let resolveLocation:((response:Response)=>void)|undefined;
    handler=(url,init)=>url.pathname.includes("/locations/compartments/")?new Promise(resolve=>{resolveLocation=resolve;}):normal(url,init);
    render(createElement(InventoryPage,{...props(),initialCompartment:"shelf",onClearCompartment:()=>{cleared++;}}));
    await screen.findByRole("option",{name:"书房"});await screen.findByText("给第一件物品留下位置");
    fireEvent.change(screen.getByRole("combobox",{name:"筛选房间"}),{target:{value:"study"}});
    fireEvent.change(screen.getByRole("combobox",{name:"筛选房间"}),{target:{value:"bedroom"}});
    expect(cleared).toBe(0);
    await act(async()=>{resolveLocation?.(json({location:{room_id:"bedroom",container_id:"cabinet",compartment_id:"shelf",path:[]}}));});
    expect((screen.getByRole("combobox",{name:"筛选房间"}) as HTMLSelectElement).value).toBe("bedroom");
    expect(cleared).toBe(0);
  });
  // If the lookup fails, do not silently broaden the saved shelf; explicit retry can verify and apply the room.
  it("retains the shelf on a location lookup failure and retries before switching rooms",async()=>{
    items=[];let cleared=0;let attempts=0;
    handler=(url,init)=>url.pathname.includes("/locations/compartments/")&&++attempts===1?json({error:{message:"无法核对隔层位置"}},503):normal(url,init);
    render(createElement(InventoryPage,{...props(),initialCompartment:"shelf",onClearCompartment:()=>{cleared++;}}));
    await screen.findByRole("option",{name:"书房"});await screen.findByText("无法核对隔层位置");
    fireEvent.change(screen.getByRole("combobox",{name:"筛选房间"}),{target:{value:"study"}});
    expect(cleared).toBe(0);
    fireEvent.click(screen.getByRole("button",{name:"重试隔层位置"}));
    await waitFor(()=>expect(cleared).toBe(1));
    expect((screen.getByRole("combobox",{name:"筛选房间"}) as HTMLSelectElement).value).toBe("study");
  });
});

describe("inventory paging and photos",()=>{
  // Visible rows must be requested page by page and the range must refer to the server's full matching count.
  it("requests forty records per page and reports the complete match count",async()=>{
    await show();
    expect(screen.getAllByRole("button",{name:/^查看物品/})).toHaveLength(40);
    expect(screen.getByText("第 1–40 条，共 81 条")).toBeTruthy();
    expect((screen.getByRole("button",{name:"上一页"}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button",{name:"下一页"}));
    await screen.findByRole("button",{name:"查看物品41",exact:true});
    expect(screen.queryByRole("button",{name:"查看物品1",exact:true})).toBeNull();
    expect(screen.getByText("第 41–80 条，共 81 条")).toBeTruthy();
    fireEvent.click(screen.getByRole("button",{name:"下一页"}));
    await screen.findByRole("button",{name:"查看物品81",exact:true});
    expect(screen.getByText("第 81–81 条，共 81 条")).toBeTruthy();
    expect((screen.getByRole("button",{name:"下一页"}) as HTMLButtonElement).disabled).toBe(true);
  });
  // Selection must never cross pages; select-all should explicitly mean the forty displayed records.
  it("limits select-all to the current page and clears selection before the next page",async()=>{
    await show();fireEvent.click(screen.getByRole("button",{name:"批量整理"}));
    fireEvent.click(screen.getByRole("button",{name:"全选当前页"}));
    expect(screen.getByText("已选 40 条")).toBeTruthy();
    fireEvent.click(screen.getByRole("button",{name:"下一页"}));await screen.findByRole("checkbox",{name:"选择物品41",exact:true});
    expect(screen.getByText("已选 0 条")).toBeTruthy();
    expect((screen.getByRole("button",{name:"批量归档"}) as HTMLButtonElement).disabled).toBe(true);
  });
  // A new filter starts at page one; late page-two data cannot overwrite its new scope.
  it("resets to the first page on search and ignores the previous page response",async()=>{
    let oldPage:((response:Response)=>void)|undefined;
    handler=(url,init)=>url.pathname.endsWith("/items")&&url.searchParams.get("page")==="2"&&!url.searchParams.get("q")
      ?new Promise(resolve=>{oldPage=resolve;}):normal(url,init);
    await show();fireEvent.click(screen.getByRole("button",{name:"下一页"}));await waitFor(()=>expect(oldPage).toBeTypeOf("function"));
    fireEvent.change(screen.getByRole("searchbox"),{target:{value:"物品81"}});await screen.findByRole("button",{name:"查看物品81",exact:true});
    await act(async()=>{oldPage?.(json({items:[{...original,id:"late",name:"旧页物品"}],page:2,page_size:40,total:81,has_more:true}));});
    expect(screen.queryByRole("button",{name:"查看旧页物品"})).toBeNull();
    expect(screen.getByText("第 1–1 条，共 1 条")).toBeTruthy();
  });
  // A failed next page cannot leave previous rows actionable under the new page number.
  it("keeps failed-page rows untrusted until that page loads successfully",async()=>{
    handler=(url,init)=>url.searchParams.get("page")==="2"?json({error:{message:"下一页读取失败"}},503):normal(url,init);
    await show();fireEvent.click(screen.getByRole("button",{name:"批量整理"}));fireEvent.click(screen.getByRole("checkbox",{name:"选择物品1",exact:true}));
    fireEvent.click(screen.getByRole("button",{name:"下一页"}));await screen.findByText("下一页读取失败");
    expect(screen.getByText("已选 0 条")).toBeTruthy();
    expect((screen.getByRole("checkbox",{name:"选择物品1",exact:true}) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByText("第 41–80 条，共 81 条")).toBeNull();
    fireEvent.click(screen.getByRole("button",{name:"更多"}));expect((screen.getByRole("button",{name:"导出清单"}) as HTMLButtonElement).disabled).toBe(true);
    handler=normal;fireEvent.click(screen.getByRole("button",{name:"重新加载"}));
    expect(await screen.findByRole("checkbox",{name:"选择物品41",exact:true})).toBeTruthy();
    expect(screen.getByText("第 41–80 条，共 81 条")).toBeTruthy();
  });
  // Thumbnails reduce list transfers without replacing the original in the details viewer.
  it("uses an authenticated thumbnail for list cards and the original for details",async()=>{
    items=[{...original,photo_url:"/api/items/item-1/photo?v=2",thumbnail_url:"/api/items/item-1/photo?variant=thumbnail&v=2"}];
    await show();const card=screen.getByRole("button",{name:"查看物品1",exact:true});
    expect(card.querySelector("img")?.getAttribute("src")).toBe("/api/items/item-1/photo?variant=thumbnail&v=2");
    fireEvent.click(card);const dialog=await screen.findByRole("dialog",{name:"物品1"});
    expect(within(dialog).getByRole("img",{name:"物品1"}).getAttribute("src")).toBe("/api/items/item-1/photo?v=2");
  });
});

describe("exporting the matching scope",()=>{
  // Export must carry room and missing filters, but never page/page_size which would silently truncate it.
  it("exports all matching records with room and missing filters rather than only the displayed page",async()=>{
    items=items.map(item=>({...item,location_status:"missing"}));
    await show();await screen.findByRole("option",{name:"主卧"});
    fireEvent.change(screen.getByRole("combobox",{name:"筛选房间"}),{target:{value:"bedroom"}});
    fireEvent.click(screen.getByRole("button",{name:"待找回",exact:true}));
    await waitFor(()=>expect((screen.getByRole("button",{name:"下一页"}) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button",{name:"下一页"}));await screen.findByRole("button",{name:"查看物品41",exact:true});
    fireEvent.click(screen.getByRole("button",{name:"更多"}));fireEvent.click(screen.getByRole("button",{name:"导出清单"}));
    const dialog=await screen.findByRole("dialog",{name:"导出清单"});
    expect(within(dialog).queryByText("导出当前筛选的全部匹配记录，不仅是当前页。")).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("button",{name:"生成导出文件"}));await within(dialog).findByRole("link",{name:"下载 CSV 清单"});
    expect(exported).toEqual({format:"csv",scope:"filtered",status:"active",room_id:"bedroom",location_status:"missing"});
  });
});
