// @vitest-environment jsdom
import { createElement, useLayoutEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InventoryPage } from "../../frontend/src/pages/InventoryPage";

const me = {user:{id:"u",username:"owner",display_name:"家人",role:"owner" as const},household:{id:"h",name:"我家"}};
const original = {id:"one",name:"护照",aliases:[],notes:"",quantity:1,compartment_id:"cp",room_id:"r",container_id:"c",location_path:["卧室","衣柜","顶层"],photo_url:null,version:2,location_status:"confirmed",last_confirmed_at:null,updated_at:"2026-11-05T00:00:00Z",archived_at:null,archive_reason:null};
const second = {...original,id:"two",name:"相机"};
type Handler=(url:URL,init:RequestInit)=>Promise<Response>|Response;
let handler:Handler;
function json(data:unknown,status=200){return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json"}});}
function normal(url:URL){
  if(url.pathname.endsWith("/events"))return json({events:[],has_more:false});
  if(url.pathname.endsWith("/items/one"))return json({item:original});
  return json({items:[original]});
}
const props=()=>({me,onLogout:async()=>{},onArrange:()=>{}});
beforeEach(()=>{handler=url=>normal(url);vi.stubGlobal("fetch",(input:string,init:RequestInit={})=>Promise.resolve(handler(new URL(input,"http://localhost"),init)));});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
async function ready(){await screen.findByRole("button",{name:"查看护照"});fireEvent.click(screen.getByRole("button",{name:"批量整理"}));fireEvent.click(screen.getByRole("checkbox",{name:"选择护照"}));}
function moreActions(){if(!screen.queryByRole("button",{name:"刷新清单"}))fireEvent.click(screen.getByRole("button",{name:"更多"}));}
function expectUnavailable(){
  moreActions();
  expect((screen.getByRole("checkbox",{name:"选择护照"}) as HTMLInputElement).disabled).toBe(true);
  for(const label of ["全选当前页","批量移动","批量归档","导出清单"]){
    expect((screen.getByRole("button",{name:label}) as HTMLButtonElement).disabled).toBe(true);
  }
}

describe("inventory query trust",()=>{
  // Failed new criteria must not relabel the last successful rows as current selectable results.
  it("marks old rows read-only after a new query fails and never reports their count as current",async()=>{
    handler=url=>url.searchParams.get("q")==="钥匙"?json({error:{message:"搜索暂时不可用"}},503):normal(url);
    render(createElement(InventoryPage,props()));await ready();
    fireEvent.change(screen.getByRole("searchbox"),{target:{value:"钥匙"}});
    await screen.findByText("搜索暂时不可用", { exact: false });
    expect(screen.queryByText("当前筛选未能加载，以下为上次结果")).not.toBeNull();
    expect(screen.queryByText("1 条记录")).toBeNull();
    expect(screen.queryByRole("heading",{name:"搜索结果"})).toBeNull();
    expect(screen.getByText("已选 0 条")).toBeTruthy();
    expectUnavailable();
    fireEvent.click(screen.getByRole("button",{name:"查看护照"}));
    await screen.findByRole("dialog",{name:"护照"});
  });
  // Same-query refresh also revokes trust, and failure clears existing selections and dialogs.
  it.each(["批量归档","导出清单"])("clears selection and closes %s when a refresh fails",async(dialogName)=>{
    let reads=0;
    handler=url=>url.pathname.endsWith("/items")&&++reads>1?json({error:{message:"刷新失败"}},503):normal(url);
    render(createElement(InventoryPage,props()));await ready();
    if(dialogName === "导出清单") moreActions();
    fireEvent.click(screen.getByRole("button",{name:dialogName}));await screen.findByRole("dialog",{name:dialogName});
    moreActions();
    fireEvent.click(screen.getByRole("button",{name:"刷新清单"}));
    await screen.findByText("刷新失败", { exact: false });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("已选 0 条")).toBeTruthy();
    expectUnavailable();
  });
  // Only a successful read for current criteria can restore selection/export eligibility.
  it("restores actions only after retry successfully loads the current query",async()=>{
    let searchAttempts=0;
    handler=url=>url.searchParams.get("q")==="相机"
      ?++searchAttempts===1?json({error:{message:"请重试查询"}},503):json({items:[second]})
      :normal(url);
    render(createElement(InventoryPage,props()));await ready();
    fireEvent.change(screen.getByRole("searchbox"),{target:{value:"相机"}});await screen.findByText("请重试查询", { exact: false });
    expectUnavailable();
    fireEvent.click(screen.getByRole("button",{name:"重新加载"}));
    await waitFor(()=>expect((screen.getByRole("button",{name:"导出清单"}) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole("checkbox",{name:"选择护照"})).toBeNull();
    expect((screen.getByRole("checkbox",{name:"选择相机"}) as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByText("当前筛选未能加载，以下为上次结果")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox",{name:"选择相机"}));
    expect((screen.getByRole("button",{name:"批量归档"}) as HTMLButtonElement).disabled).toBe(false);
  });
  // A late success for abandoned criteria must not erase the latest failure or re-enable bulk actions.
  it("keeps the newest failed query untrusted when an older request succeeds late",async()=>{
    let finishOld:((response:Response)=>void)|undefined;
    handler=url=>url.searchParams.get("q")==="旧查询"?new Promise(resolve=>{finishOld=resolve;})
      :url.searchParams.get("q")==="新查询"?json({error:{message:"当前查询失败"}},503):normal(url);
    render(createElement(InventoryPage,props()));await ready();
    fireEvent.change(screen.getByRole("searchbox"),{target:{value:"旧查询"}});await waitFor(()=>expect(finishOld).toBeTypeOf("function"));
    fireEvent.change(screen.getByRole("searchbox"),{target:{value:"新查询"}});await screen.findByText("当前查询失败", { exact: false });
    await act(async()=>{finishOld?.(json({items:[second]}));});
    expect(screen.getByText("当前查询失败", { exact: false })).toBeTruthy();
    expect(screen.queryByRole("button",{name:"查看相机"})).toBeNull();
    expectUnavailable();
  });
  // New route/state criteria must revoke an already prepared action at render time, before effects load data.
  it("disables export and drops the open dialog immediately on a compartment change",async()=>{
    let atLayout:{exportDisabled:boolean;dialogOpen:boolean}|undefined;
    function Route({compartment}:{compartment:string}){
      useLayoutEffect(()=>{
        if(compartment==="new")atLayout={exportDisabled:(screen.queryByRole("button",{name:"导出清单"}) as HTMLButtonElement|null)?.disabled ?? true,dialogOpen:screen.queryByRole("dialog")!==null};
      },[compartment]);
      return createElement(InventoryPage,{...props(),initialCompartment:compartment});
    }
    handler=url=>url.searchParams.get("compartment_id")==="new"?new Promise(()=>{}):normal(url);
    const view=render(createElement(Route,{compartment:"old"}));await ready();
    moreActions();fireEvent.click(screen.getByRole("button",{name:"导出清单"}));await screen.findByRole("dialog",{name:"导出清单"});
    view.rerender(createElement(Route,{compartment:"new"}));
    expect(atLayout).toEqual({exportDisabled:true,dialogOpen:false});
    moreActions();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((screen.getByRole("button",{name:"导出清单"}) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button",{name:"全选当前页"}) as HTMLButtonElement).disabled).toBe(true);
  });
  // Changing status must not allow active records to be submitted through the archived restore action.
  it("keeps old active rows unselectable when the archived filter fails",async()=>{
    handler=url=>url.searchParams.get("status")==="archived"?json({error:{message:"归档读取失败"}},503):normal(url);
    render(createElement(InventoryPage,props()));await ready();
    fireEvent.click(screen.getByRole("button",{name:"已归档"}));await screen.findByText("归档读取失败", { exact: false });
    expect(screen.queryByText("当前筛选未能加载，以下为上次结果")).not.toBeNull();
    expect((screen.getByRole("checkbox",{name:"选择护照"}) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button",{name:"批量恢复"}) as HTMLButtonElement).disabled).toBe(true);
    moreActions();
    expect((screen.getByRole("button",{name:"导出清单"}) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("已选 0 条")).toBeTruthy();
  });
  // Successful refreshes keep the deliberate selection version rather than silently upgrading the pending write.
  it("retains the selected version snapshot after a successful refresh",async()=>{
    let reads=0;let submitted:unknown;
    handler=(url,init)=>{
      if(url.pathname.endsWith("/items"))return json({items:[{...original,version:++reads===1?2:9}]});
      if(url.pathname.endsWith("/actions/bulk")){submitted=JSON.parse(String(init.body));return json({items:[original],processed:1,changed:1,replayed:false});}
      return normal(url);
    };
    render(createElement(InventoryPage,props()));await ready();moreActions();fireEvent.click(screen.getByRole("button",{name:"刷新清单"}));
    await waitFor(()=>expect((screen.getByRole("button",{name:"批量归档"}) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button",{name:"批量归档"}));fireEvent.click(screen.getByRole("button",{name:"确认归档"}));
    await waitFor(()=>expect(submitted).toMatchObject({items:[{id:"one",expected_version:2}]}));
  });
});
