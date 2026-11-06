// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WorkspacePage } from "../../frontend/src/pages/WorkspacePage";
import { useWorkspace } from "../../frontend/src/store/useWorkspace";
import type { Container } from "../../frontend/src/api/client";

const me={user:{id:"u",username:"owner",display_name:"家人",role:"owner" as const},household:{id:"h",name:"我家"}};
const room={id:"r",floor_id:"f",name:"主卧",width_cm:460,depth_cm:360,height_cm:260,wall_color:null,sort:0,container_count:1};
const original:Container={id:"c",room_id:"r",name:"衣柜",preset:"wardrobe",x_cm:150,z_cm:80,y_cm:0,rot_deg:0,width_cm:180,depth_cm:58,height_cm:220,color:null,config:{layers:1,cols:1},item_count:0,version:1,
  compartments:[{id:"cp",container_id:"c",name:"顶层",custom_name:null,default_name:"顶层",kind:"shelf",level_index:0,row:0,col:0,sort:0}]};
let cabinet:Container;
let failNext:boolean;
function reply(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});}
beforeEach(()=>{
  cabinet=structuredClone(original);failNext=false;useWorkspace.getState().reset();
  vi.stubGlobal("matchMedia",()=>({matches:false,addEventListener(){},removeEventListener(){}}));
  vi.stubGlobal("fetch",async(input:string,init:RequestInit={})=>{
    const url=new URL(input,"http://localhost");
    if(url.pathname.endsWith("/bootstrap"))return reply({...me,floors:[{id:"f",name:"1层",level:1,rooms:[room]}]});
    if(url.pathname.endsWith("/rooms/r"))return reply({room,containers:[cabinet]});
    if(url.pathname.endsWith("/compartments/cp")&&init.method==="PATCH"){
      if(failNext){failNext=false;return reply({error:{code:"offline",message:"网络中断，请重试"}},503);}
      const payload=JSON.parse(String(init.body));
      if(payload.expected_container_version!==cabinet.version)return reply({error:{code:"version_conflict",message:"容器已更新"}},409);
      cabinet={...cabinet,version:cabinet.version+1,compartments:[{...cabinet.compartments[0],name:payload.custom_name??"顶层",custom_name:payload.custom_name}]};
      return reply({container:cabinet});
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  });
});
afterEach(()=>{cleanup();useWorkspace.getState().reset();vi.unstubAllGlobals();});
async function show(){
  render(createElement(WorkspacePage,{me,onLogout:async()=>{},onInventory:()=>{},target:{roomId:"r",containerId:"c",compartmentId:"cp"}}));
  return within(await screen.findByRole("dialog",{name:"衣柜"}));
}
describe("compartment custom naming",()=>{
  // Updating only a transient label would fail to update both cabinet navigation and the backend record.
  it("saves a custom name and restores the generated default in the same selected compartment",async()=>{
    const dialog=await show();
    const input=dialog.getByLabelText("隔层名称");
    fireEvent.change(input,{target:{value:"证件抽屉"}});
    fireEvent.click(dialog.getByRole("button",{name:"保存名称"}));
    await waitFor(()=>expect(dialog.getByRole("button",{name:"证件抽屉",exact:true}).getAttribute("aria-pressed")).toBe("true"));
    expect(cabinet.compartments[0].id).toBe("cp");
    fireEvent.click(dialog.getByRole("button",{name:"恢复自动名称"}));
    await waitFor(()=>expect(dialog.getByRole("button",{name:"顶层",exact:true}).getAttribute("aria-pressed")).toBe("true"));
    expect(cabinet.compartments[0].custom_name).toBeNull();
  });
  // An offline error must leave the typed name available for retry instead of reverting the input.
  it("retains the name draft on a failed save and permits an explicit retry",async()=>{
    const dialog=await show();failNext=true;
    fireEvent.change(dialog.getByLabelText("隔层名称"),{target:{value:"常用药品"}});
    fireEvent.click(dialog.getByRole("button",{name:"保存名称"}));
    await dialog.findByText("网络中断，请重试", { exact: false });
    expect((dialog.getByLabelText("隔层名称") as HTMLInputElement).value).toBe("常用药品");
    expect(cabinet.compartments[0].name).toBe("顶层");
    fireEvent.click(dialog.getByRole("button",{name:"保存名称"}));
    await dialog.findByRole("button",{name:"常用药品",exact:true});
  });
});
