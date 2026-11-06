// @vitest-environment jsdom
import { createElement, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InventoryPage } from "../../frontend/src/pages/InventoryPage";
import { LocationPicker } from "../../frontend/src/components/LocationPicker";
import { FakeXHR, installFetchXHRBridge } from "./helpers/fake-xhr";

const me = {user:{id:"u",username:"owner",display_name:"家人",role:"owner" as const},household:{id:"h",name:"我家"}};
const room = {id:"r",floor_id:"f",name:"主卧",width_cm:400,depth_cm:400,height_cm:260,wall_color:null,sort:0,container_count:1};
const compartment = {id:"cp",container_id:"c",name:"证件层",kind:"shelf",level_index:0,row:0,col:0,sort:0};
const cabinet = {id:"c",room_id:"r",preset:"wardrobe",name:"白柜",x_cm:150,z_cm:100,y_cm:0,rot_deg:0,width_cm:180,depth_cm:58,height_cm:220,color:null,config:{layers:1},compartments:[compartment],item_count:0,version:1};
const item = {id:"i",name:"相机",aliases:[],notes:"",quantity:1,compartment_id:"cp",room_id:"r",container_id:"c",photo_url:null,location_path:["主卧","白柜","证件层"],version:1,location_status:"confirmed",last_confirmed_at:null,updated_at:"2026-11-05T00:00:00Z",archived_at:null,archive_reason:null};
const location = {room_id:"r",container_id:"c",compartment_id:"cp",path:["主卧","白柜","证件层"]};
type Handler=(url:URL,init:RequestInit)=>Promise<Response>|Response;
let handler:Handler;
let revoked:string[];
let nextBlob:number;
type DecodedPhoto = { width: number; height: number; close: () => void };
let decodePhoto: (blob: Blob) => Promise<DecodedPhoto>;
let encodedPhoto: Blob;
const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalToBlob = HTMLCanvasElement.prototype.toBlob;
const createObjectURL=Object.getOwnPropertyDescriptor(URL,"createObjectURL");
const revokeObjectURL=Object.getOwnPropertyDescriptor(URL,"revokeObjectURL");
function json(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});}
function normal(url:URL){
  if(url.pathname.endsWith("/bootstrap"))return json({...me,floors:[{id:"f",name:"1 层",level:1,rooms:[room,{...room,id:"r2",name:"书房"}]}]});
  if(url.pathname.endsWith("/rooms/r"))return json({room,containers:[cabinet]});
  if(url.pathname.endsWith("/rooms/r2"))return json({room:{...room,id:"r2",name:"书房"},containers:[{...cabinet,id:"c2",room_id:"r2",name:"书柜",compartments:[{...compartment,id:"cp2",container_id:"c2",name:"资料层"}]}]});
  if(url.pathname.endsWith("/locations/compartments/cp"))return json({location});
  if(url.pathname.endsWith("/items/batch"))return json({items:[item]},201);
  return json({items:[]});
}
beforeEach(()=>{
  localStorage.clear();revoked=[];nextBlob=0;handler=url=>normal(url);
  vi.stubGlobal("fetch",(path:string,init:RequestInit={})=>Promise.resolve(handler(new URL(path,"http://localhost"),init)));
  installFetchXHRBridge();
  decodePhoto = async () => ({width:800,height:600,close:()=>{}});
  encodedPhoto = new Blob([new Uint8Array(100_000)],{type:"image/jpeg"});
  vi.stubGlobal("createImageBitmap",(blob:Blob)=>decodePhoto(blob));
  HTMLCanvasElement.prototype.getContext = (()=>({fillStyle:"",fillRect(){},drawImage(){}})) as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toBlob = callback=>callback(encodedPhoto);
  Object.defineProperty(URL,"createObjectURL",{configurable:true,value:()=>`blob:preview-${++nextBlob}`});
  Object.defineProperty(URL,"revokeObjectURL",{configurable:true,value:(url:string)=>revoked.push(url)});
});
afterEach(()=>{
  cleanup();vi.unstubAllGlobals();localStorage.clear();
  HTMLCanvasElement.prototype.getContext=originalGetContext;HTMLCanvasElement.prototype.toBlob=originalToBlob;
  if(createObjectURL)Object.defineProperty(URL,"createObjectURL",createObjectURL);else Reflect.deleteProperty(URL,"createObjectURL");
  if(revokeObjectURL)Object.defineProperty(URL,"revokeObjectURL",revokeObjectURL);else Reflect.deleteProperty(URL,"revokeObjectURL");
});
function props(){return {me,onLogout:async()=>{},onArrange:()=>{}};}
function photoFile(name="camera.png",bytes=1200,content=1):File {
  const data=new Uint8Array(bytes);data.set([137,80,78,71,13,10,26,10]);data[data.length-1]=content;
  return new File([data],name,{type:"image/png",lastModified:1});
}
async function chooseLocation(){
  await within(screen.getByRole("combobox",{name:"房间",exact:true})).findByRole("option",{name:"主卧"});fireEvent.change(screen.getByLabelText("房间"),{target:{value:"r"}});
  await screen.findByRole("option",{name:"白柜"});fireEvent.change(screen.getByLabelText("容器"),{target:{value:"c"}});
  fireEvent.click(screen.getByRole("button",{name:"证件层"}));
}
async function registerOnce(){
  fireEvent.click(screen.getByRole("button",{name:"登记物品"}));await chooseLocation();
  fireEvent.change(screen.getByLabelText("物品名称，每行一件或一组"),{target:{value:"相机"}});
  fireEvent.click(screen.getByRole("button",{name:"保存登记"}));await screen.findByText("已登记 1 条物品记录");
}

describe("verified location defaults",()=>{
  // Opening registration inside a shelf should select that verified shelf without another manual round trip.
  it("prefills the active shelf for batch registration and consumes the launch action once",async()=>{
    function Page(){const[action,setAction]=useState<"register"|undefined>("register");return createElement(InventoryPage,{...props(),initialCompartment:"cp",initialAction:action,onConsumedAction:()=>setAction(undefined)});}
    render(createElement(Page));
    const selected=await screen.findByRole("button",{name:"证件层"});
    await waitFor(()=>expect(selected.getAttribute("aria-pressed")).toBe("true"));
    expect((screen.getByLabelText("房间") as HTMLSelectElement).value).toBe("r");
    fireEvent.click(screen.getByRole("button",{name:"关闭对话框"}));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  // Recent storage must hold IDs only; names and ownership are freshly checked on each use.
  it("remembers a successful location by ID and resolves its current name when opened again",async()=>{
    render(createElement(InventoryPage,props()));await registerOnce();
    expect(Object.values(localStorage)).toEqual(["cp"]);
    handler=url=>url.pathname.endsWith("/rooms/r")?json({room,containers:[{...cabinet,compartments:[{...compartment,name:"新的层名"}]}]}):normal(url);
    fireEvent.click(screen.getByRole("button",{name:"登记物品"}));
    expect((await screen.findByRole("button",{name:"新的层名"})).getAttribute("aria-pressed")).toBe("true");
  });
  // A deleted/forbidden saved shelf must be cleared both from the form and the scoped remembered value.
  it("clears an invalid recent shelf instead of submitting its stale ID",async()=>{
    render(createElement(InventoryPage,props()));await registerOnce();
    handler=url=>url.pathname.includes("/locations/compartments/")?json({error:{code:"compartment_not_found",message:"隔层已不存在"}},404):normal(url);
    fireEvent.click(screen.getByRole("button",{name:"登记物品"}));await screen.findByText(/隔层已不存在/);
    fireEvent.change(screen.getByLabelText("物品名称，每行一件或一组"),{target:{value:"钥匙"}});
    fireEvent.click(screen.getByRole("button",{name:"保存登记"}));
    await screen.findByText("请选择隔层，并填写至少一件物品");
    expect(localStorage.length).toBe(0);
  });
  // Navigating to another account must discard private registration drafts and not restore the other account's shelf.
  it("isolates recent locations and open drafts across users and households",async()=>{
    const view=render(createElement(InventoryPage,props()));await registerOnce();
    fireEvent.click(screen.getByRole("button",{name:"登记物品"}));await screen.findByRole("button",{name:"证件层"});
    fireEvent.change(screen.getByLabelText("物品名称，每行一件或一组"),{target:{value:"私人物品"}});
    view.rerender(createElement(InventoryPage,{...props(),me:{...me,user:{...me.user,id:"other"},household:{id:"other-home",name:"其他家庭"}}}));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button",{name:"登记物品"}));await within(screen.getByRole("combobox",{name:"房间",exact:true})).findByRole("option",{name:"主卧"});
    expect((screen.getByLabelText("房间") as HTMLSelectElement).value).toBe("");
    expect((screen.getByLabelText("物品名称，每行一件或一组") as HTMLTextAreaElement).value).toBe("");
  });
  // Slow automatic resolution must not replace a room/shelf that the user has since explicitly selected.
  it("ignores an initial-location response after the user chooses a different room",async()=>{
    let finishInitial:((response:Response)=>void)|undefined;
    handler=url=>url.pathname.includes("/locations/compartments/")?new Promise(resolve=>{finishInitial=resolve;}):normal(url);
    function Picker(){const[value,setValue]=useState("");return createElement("div",null,createElement("output",{"aria-label":"所选隔层"},value),createElement(LocationPicker,{value,onChange:setValue,initialCompartmentId:"cp"}));}
    render(createElement(Picker));await screen.findByRole("option",{name:"书房"});
    fireEvent.change(screen.getByLabelText("房间"),{target:{value:"r2"}});await screen.findByRole("option",{name:"书柜"});
    fireEvent.change(screen.getByLabelText("容器"),{target:{value:"c2"}});fireEvent.click(screen.getByRole("button",{name:"资料层"}));
    await act(async()=>{finishInitial?.(json({location}));});
    expect((screen.getByLabelText("房间") as HTMLSelectElement).value).toBe("r2");
    expect(screen.getByLabelText("所选隔层").textContent).toBe("cp2");
  });
  // An explicit shelf is more authoritative than the saved recent ID and must not silently fall back.
  it("reports a broken explicit shelf even when a valid recent shelf exists",async()=>{
    const view=render(createElement(InventoryPage,props()));await registerOnce();
    handler=url=>url.pathname.endsWith("/locations/compartments/deleted")?json({error:{code:"compartment_not_found",message:"链接位置已删除"}},404):normal(url);
    view.rerender(createElement(InventoryPage,{...props(),initialCompartment:"deleted",initialAction:"register"}));
    await within(screen.getByRole("dialog",{name:"一起记在这个位置"})).findByText(/链接位置已删除/);
    expect((screen.getByLabelText("房间") as HTMLSelectElement).value).toBe("");
    expect(screen.queryByRole("button",{name:"证件层"})).toBeNull();
  });
  // Room contents can change between resolving an ID and reading the room; only an existing compartment is selectable.
  it("refuses an initially resolved compartment missing from the current room",async()=>{
    handler=url=>url.pathname.endsWith("/rooms/r")?json({room,containers:[{...cabinet,compartments:[]}]}):normal(url);
    render(createElement(InventoryPage,{...props(),initialCompartment:"cp",initialAction:"register"}));
    await screen.findByText("原来的隔层已不可用，请重新选择位置");
    fireEvent.change(screen.getByLabelText("物品名称，每行一件或一组"),{target:{value:"相机"}});
    fireEvent.click(screen.getByRole("button",{name:"保存登记"}));await screen.findByText("请选择隔层，并填写至少一件物品");
  });
});

describe("camera registration",()=>{
  // Saving while another photo is decoding must not submit the previous file or a photo-less item.
  it("blocks saving during photo processing and uses only the most recently chosen photo",async()=>{
    const decoding:Array<(value:DecodedPhoto)=>void>=[];const submitted:FormData[]=[];
    decodePhoto=()=>new Promise(resolve=>decoding.push(resolve));
    handler=(url,init)=>{if(url.pathname.endsWith("/items/quick")){submitted.push(init.body as FormData);return json({item},201);}return normal(url);};
    render(createElement(InventoryPage,{...props(),initialCompartment:"cp",initialAction:"capture"}));
    await screen.findByRole("button",{name:"证件层"});fireEvent.change(screen.getByLabelText("物品名称"),{target:{value:"相机"}});
    const first=photoFile("first.png"),second=photoFile("second.png");
    fireEvent.change(screen.getByLabelText("拍摄或选择照片"),{target:{files:[first]}});
    expect(screen.queryByText("正在处理照片…")).not.toBeNull();
    expect((screen.getByRole("button",{name:"保存物品"}) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(()=>expect(decoding.length).toBe(1));
    fireEvent.change(screen.getByLabelText("拍摄或选择照片"),{target:{files:[second]}});
    await waitFor(()=>expect(decoding.length).toBe(2));
    await act(async()=>{decoding[1]({width:800,height:600,close:()=>{}});});
    await screen.findByRole("img",{name:"待登记照片预览"});
    await act(async()=>{decoding[0]({width:800,height:600,close:()=>{}});});
    fireEvent.click(screen.getByRole("button",{name:"保存物品"}));await screen.findByText("已登记「相机」");
    expect(submitted[0].get("image")).toBe(second);
  });
  // Canceling an in-flight local preparation must leave no old photo to be uploaded accidentally.
  it("allows canceling photo processing and ignores its late decoded image",async()=>{
    let finishDecode:((value:DecodedPhoto)=>void)|undefined;
    decodePhoto=()=>new Promise(resolve=>{finishDecode=resolve;});
    render(createElement(InventoryPage,{...props(),initialCompartment:"cp",initialAction:"capture"}));
    await screen.findByRole("button",{name:"证件层"});
    fireEvent.change(screen.getByLabelText("拍摄或选择照片"),{target:{files:[photoFile()]}});
    expect(screen.queryByRole("button",{name:"取消照片处理"})).not.toBeNull();
    await waitFor(()=>expect(finishDecode).toBeTypeOf("function"));
    fireEvent.click(screen.getByRole("button",{name:"取消照片处理"}));
    await act(async()=>{finishDecode?.({width:800,height:600,close:()=>{}});});
    expect(screen.queryByRole("img",{name:"待登记照片预览"})).toBeNull();
    expect(screen.queryByText("正在处理照片…")).toBeNull();
    expect((screen.getByRole("button",{name:"保存物品"}) as HTMLButtonElement).disabled).toBe(false);
  });
  // Process only once: the exact same reduced File and operation ID must be reused after failure.
  it("shows the reduced upload size and reuses the processed file on retry",async()=>{
    let decodes=0;decodePhoto=async()=>{decodes++;return {width:4000,height:3000,close:()=>{}};};
    encodedPhoto=new Blob([new Uint8Array(102400)],{type:"image/jpeg"});
    const submitted:FormData[]=[];
    handler=(url,init)=>{
      if(url.pathname.endsWith("/items/quick")){submitted.push(init.body as FormData);return submitted.length===1?json({error:{message:"请重试上传"}},503):json({item},201);}return normal(url);
    };
    render(createElement(InventoryPage,{...props(),initialCompartment:"cp",initialAction:"capture"}));
    await screen.findByRole("button",{name:"证件层"});fireEvent.change(screen.getByLabelText("物品名称"),{target:{value:"相机"}});
    fireEvent.change(screen.getByLabelText("拍摄或选择照片"),{target:{files:[photoFile("large.png",1024*1024)]}});
    await screen.findByRole("img",{name:"待登记照片预览"});
    expect(screen.queryByText("原照片 1.00 MB · 待上传 100 KB（已压缩）")).not.toBeNull();
    fireEvent.click(screen.getByRole("button",{name:"保存物品"}));await screen.findByText(/请重试上传/);
    fireEvent.click(screen.getByRole("button",{name:"保存物品"}));await screen.findByText("已登记「相机」");
    expect(decodes).toBe(1);
    expect((submitted[0].get("image") as File).size).toBe(102400);
    expect(submitted[0].get("image")).toBe(submitted[1].get("image"));
    expect(submitted[0].get("operation_id")).toBe(submitted[1].get("operation_id"));
  });
  // Percentages must follow actual byte events and completion must wait for the business response.
  it("shows real transferred bytes, speed, and elapsed time before waiting for server confirmation",async()=>{
    installFetchXHRBridge({completeUpload:false});
    handler=(url)=>url.pathname.endsWith("/items/quick")?new Promise(()=>{}):normal(url);
    render(createElement(InventoryPage,{...props(),initialCompartment:"cp",initialAction:"capture"}));
    await screen.findByRole("button",{name:"证件层"});fireEvent.change(screen.getByLabelText("物品名称"),{target:{value:"相机"}});
    fireEvent.change(screen.getByLabelText("拍摄或选择照片"),{target:{files:[photoFile()]}});
    await screen.findByRole("img",{name:"待登记照片预览"});
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button",{name:"保存物品"}));
      await act(async()=>{await vi.advanceTimersByTimeAsync(2000);FakeXHR.latest.emitUploadProgress(102400,409600,true);});
      expect(screen.queryByRole("progressbar",{name:"上传进度"})).not.toBeNull();
      expect(screen.getByRole("progressbar",{name:"上传进度"}).getAttribute("aria-valuenow")).toBe("25");
      expect(screen.getByText("已发送 100 KB / 400 KB")).toBeTruthy();
      expect(screen.getByText("平均速度 50 KB/s")).toBeTruthy();
      expect(screen.getByText("已用时 2 秒")).toBeTruthy();
      await act(async()=>{await vi.advanceTimersByTimeAsync(11_000);});
      expect(screen.getByText("已 11 秒没有新的上传进度，可继续等待或停止等待")).toBeTruthy();
      expect(screen.getByRole("progressbar",{name:"上传进度"}).getAttribute("aria-valuenow")).toBe("25");
      await act(async()=>{FakeXHR.latest.completeUpload(409600,409600,true);});
      expect(screen.getByText("照片已传完，等待服务器确认保存")).toBeTruthy();
      expect((screen.getByRole("button",{name:"正在保存…"}) as HTMLButtonElement).disabled).toBe(true);
      expect(screen.queryByText("已登记「相机」")).toBeNull();
      await act(async()=>{FakeXHR.latest.respond(201,{item});});
      expect(screen.getByText("已登记「相机」")).toBeTruthy();
    }finally{vi.useRealTimers();}
  });
  // When the browser cannot compute a total, there must be no invented determinate percentage.
  it("shows indeterminate upload progress when the browser supplies no total",async()=>{
    installFetchXHRBridge({completeUpload:false});
    handler=(url)=>url.pathname.endsWith("/items/quick")?new Promise(()=>{}):normal(url);
    render(createElement(InventoryPage,{...props(),initialCompartment:"cp",initialAction:"capture"}));
    await screen.findByRole("button",{name:"证件层"});fireEvent.change(screen.getByLabelText("物品名称"),{target:{value:"相机"}});
    fireEvent.click(screen.getByRole("button",{name:"保存物品"}));
    await act(async()=>{FakeXHR.latest.emitUploadProgress(2048,0,false);});
    expect(screen.queryByRole("progressbar",{name:"上传进度"})).not.toBeNull();
    expect(screen.getByRole("progressbar",{name:"上传进度"}).hasAttribute("aria-valuenow")).toBe(false);
    expect(screen.getByText("已发送 2 KB / 总量未知")).toBeTruthy();
    fireEvent.click(screen.getByRole("button",{name:"停止等待"}));
    await screen.findByText(/尚未确认保存结果，请保持内容不变后重试，将核对同一次登记，避免重复创建。/);
  });
  // Previous request progress cannot repaint a newer retry's byte count or phase.
  it("ignores late progress from a stopped upload while retrying",async()=>{
    installFetchXHRBridge({completeUpload:false});
    handler=(url)=>url.pathname.endsWith("/items/quick")?new Promise(()=>{}):normal(url);
    render(createElement(InventoryPage,{...props(),initialCompartment:"cp",initialAction:"capture"}));
    await screen.findByRole("button",{name:"证件层"});fireEvent.change(screen.getByLabelText("物品名称"),{target:{value:"相机"}});
    fireEvent.click(screen.getByRole("button",{name:"保存物品"}));const old=FakeXHR.latest;
    fireEvent.click(screen.getByRole("button",{name:"停止等待"}));await screen.findByRole("button",{name:"保存物品"});
    fireEvent.click(screen.getByRole("button",{name:"保存物品"}));
    await act(async()=>{FakeXHR.latest.emitUploadProgress(1024,4096,true);old.completeUpload(4096,4096,true);});
    expect(screen.queryByRole("progressbar",{name:"上传进度"})).not.toBeNull();
    expect(screen.getByRole("progressbar",{name:"上传进度"}).getAttribute("aria-valuenow")).toBe("25");
    expect(screen.getByText("已发送 1 KB / 4 KB")).toBeTruthy();
    fireEvent.click(screen.getByRole("button",{name:"停止等待"}));
    await screen.findByRole("button",{name:"保存物品"});
  });
  // A stalled upload must not permanently disable every control, including the modal close button.
  it("releases a stalled photo save within two minutes and retains a retryable draft",async()=>{
    handler=(url,init)=>{
      if(url.pathname.endsWith("/items/quick"))return new Promise<Response>((_resolve,reject)=>{
        init.signal?.addEventListener("abort",()=>reject(new DOMException("Aborted","AbortError")),{once:true});
      });
      return normal(url);
    };
    render(createElement(InventoryPage,{...props(),initialCompartment:"cp",initialAction:"capture"}));
    await screen.findByRole("button",{name:"证件层"});
    fireEvent.change(screen.getByLabelText("物品名称"),{target:{value:"相机"}});
    fireEvent.change(screen.getByLabelText("拍摄或选择照片"),{target:{files:[photoFile("large.png",7*1024*1024)]}});
    await screen.findByRole("img",{name:"待登记照片预览"});
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button",{name:"保存物品"}));
      await act(async()=>{await vi.advanceTimersByTimeAsync(120_000);});
      expect(screen.queryByRole("button",{name:"正在保存…"})).toBeNull();
      expect((screen.getByRole("button",{name:"关闭对话框"}) as HTMLButtonElement).disabled).toBe(false);
      expect((screen.getByLabelText("物品名称") as HTMLInputElement).value).toBe("相机");
      expect(screen.getByRole("img",{name:"待登记照片预览"})).toBeTruthy();
      expect(screen.getByRole("alert")).toBeTruthy();
    } finally { vi.useRealTimers(); }
  });
  // Clicking Save with no name must produce a visible explanation instead of only native validation.
  it("explains an empty name visibly and focuses it without uploading",async()=>{
    let uploads=0;
    handler=(url)=>{if(url.pathname.endsWith("/items/quick")){uploads++;return json({item},201);}return normal(url);};
    render(createElement(InventoryPage,{...props(),initialCompartment:"cp",initialAction:"capture"}));
    await screen.findByRole("button",{name:"证件层"});
    fireEvent.change(screen.getByLabelText("拍摄或选择照片"),{target:{files:[photoFile()]}});
    await screen.findByRole("img",{name:"待登记照片预览"});
    fireEvent.click(screen.getByRole("button",{name:"保存物品"}));
    expect(screen.queryByText("请填写 1–120 字的物品名称")).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText("物品名称"));
    expect((screen.getByLabelText("物品名称") as HTMLInputElement).validity.valueMissing).toBe(true);
    expect(screen.queryByRole("button",{name:"正在保存…"})).toBeNull();
    expect(uploads).toBe(0);
    expect((screen.getByRole("button",{name:"关闭对话框"}) as HTMLButtonElement).disabled).toBe(false);
  });
  // Missing location must guide the user to the position input, rather than leave them at Save.
  it("focuses location selection when saving without a shelf",async()=>{
    render(createElement(InventoryPage,props()));fireEvent.click(screen.getByRole("button",{name:"拍照登记"}));
    await within(screen.getByRole("combobox",{name:"房间",exact:true})).findByRole("option",{name:"主卧"});fireEvent.change(screen.getByLabelText("物品名称"),{target:{value:"相机"}});
    fireEvent.click(screen.getByRole("button",{name:"保存物品"}));
    expect(screen.getByText("请选择物品所在的隔层")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("房间"));
  });
  // Some browser environments can fail UUID creation; surface that failure without a rejected event handler.
  it("reports inability to create a registration ID and stays editable",async()=>{
    render(createElement(InventoryPage,{...props(),initialCompartment:"cp",initialAction:"capture"}));
    await screen.findByRole("button",{name:"证件层"});fireEvent.change(screen.getByLabelText("物品名称"),{target:{value:"相机"}});
    const uuid=vi.spyOn(crypto,"randomUUID").mockImplementation(()=>{throw new Error("UUID unavailable");});
    try {
      fireEvent.click(screen.getByRole("button",{name:"保存物品"}));
      expect(screen.queryByText("无法开始登记，请刷新页面后重试")).not.toBeNull();
      expect((screen.getByRole("button",{name:"保存物品"}) as HTMLButtonElement).disabled).toBe(false);
      expect((screen.getByLabelText("物品名称") as HTMLInputElement).value).toBe("相机");
    } finally {uuid.mockRestore();}
  });
  // Cancellation ends only the browser wait; retry must reuse the original operation and ignore its late response.
  it("lets the user stop waiting and retry the same draft without accepting the late response",async()=>{
    const requests:Array<{input:FormData;signal:AbortSignal|null|undefined;finish:(response:Response)=>void}>=[];
    handler=(url,init)=>url.pathname.endsWith("/items/quick")?new Promise(resolve=>{
      requests.push({input:init.body as FormData,signal:init.signal,finish:resolve});
    }):normal(url);
    render(createElement(InventoryPage,{...props(),initialCompartment:"cp",initialAction:"capture"}));
    await screen.findByRole("button",{name:"证件层"});fireEvent.change(screen.getByLabelText("物品名称"),{target:{value:"相机"}});
    fireEvent.change(screen.getByLabelText("拍摄或选择照片"),{target:{files:[photoFile()]}});
    await screen.findByRole("img",{name:"待登记照片预览"});
    fireEvent.click(screen.getByRole("button",{name:"保存物品"}));
    fireEvent.click(screen.getByRole("button",{name:"停止等待"}));
    await screen.findByText(/尚未确认保存结果，请保持内容不变后重试，将核对同一次登记，避免重复创建。/);
    expect(requests[0].signal?.aborted).toBe(true);
    expect(screen.getByRole("img",{name:"待登记照片预览"})).toBeTruthy();
    expect((screen.getByRole("button",{name:"关闭对话框"}) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button",{name:"保存物品"}));
    await act(async()=>{requests[0].finish(json({item:{...item,name:"旧响应"}},201));});
    expect(screen.queryByText("已登记「旧响应」")).toBeNull();
    expect(screen.getByRole("button",{name:"正在保存…"})).toBeTruthy();
    await act(async()=>{requests[1].finish(json({item},200));});
    await screen.findByText("已登记「相机」");
    expect(requests[1].input.get("operation_id")).toBe(requests[0].input.get("operation_id"));
    expect(requests[1].input.get("image")).toBe(requests[0].input.get("image"));
  });
  // Headers can arrive while the response body never completes; the timeout must cover body reading too.
  it("times out while a successful response body is stalled",async()=>{
    handler=(url)=>url.pathname.endsWith("/items/quick")?Promise.resolve({
      status:201,ok:true,json:()=>new Promise(()=>{}),
    } as Response):normal(url);
    render(createElement(InventoryPage,{...props(),initialCompartment:"cp",initialAction:"capture"}));
    await screen.findByRole("button",{name:"证件层"});fireEvent.change(screen.getByLabelText("物品名称"),{target:{value:"相机"}});
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button",{name:"保存物品"}));
      await act(async()=>{await vi.advanceTimersByTimeAsync(120_000);});
      expect(screen.queryByText(/尚未确认保存结果，请保持内容不变后重试，将核对同一次登记，避免重复创建。/)).not.toBeNull();
      expect((screen.getByRole("button",{name:"保存物品"}) as HTMLButtonElement).disabled).toBe(false);
    } finally {vi.useRealTimers();}
  });
  // Leaving the account must abort its active upload as well as ignore its eventual response.
  it("aborts an active upload when its dialog unmounts",async()=>{
    let signal:AbortSignal|null|undefined;
    handler=(url,init)=>url.pathname.endsWith("/items/quick")?new Promise((_resolve,reject)=>{
      signal=init.signal;signal?.addEventListener("abort",()=>reject(new DOMException("Aborted","AbortError")),{once:true});
    }):normal(url);
    const view=render(createElement(InventoryPage,{...props(),initialCompartment:"cp",initialAction:"capture"}));
    await screen.findByRole("button",{name:"证件层"});fireEvent.change(screen.getByLabelText("物品名称"),{target:{value:"相机"}});
    fireEvent.click(screen.getByRole("button",{name:"保存物品"}));
    view.unmount();await act(async()=>{});
    expect(signal?.aborted).toBe(true);
  });
  // Retry must carry the same name/location/photo operation, and success must remember the chosen location.
  it("retains a failed photo draft and retries the same multipart operation",async()=>{
    const inputs:FormData[]=[];
    handler=(url,init)=>{
      if(url.pathname.endsWith("/items/quick")){
        const input=init.body as FormData;inputs.push(input);
        if(input.get("name")!=="相机"||input.get("compartment_id")!=="cp"||!(input.get("image") instanceof File))return json({error:{message:"wrong quick input"}},400);
        return inputs.length===1?json({error:{message:"上传失败，请重试"}},503):json({item},201);
      }return normal(url);
    };
    render(createElement(InventoryPage,props()));fireEvent.click(screen.getByRole("button",{name:"拍照登记"}));
    const photo=screen.getByLabelText("拍摄或选择照片");expect(photo.getAttribute("capture")).toBe("environment");
    fireEvent.change(photo,{target:{files:[photoFile()]}});
    await screen.findByRole("img",{name:"待登记照片预览"});
    fireEvent.change(screen.getByLabelText("物品名称"),{target:{value:" 相机 "}});await chooseLocation();
    fireEvent.click(screen.getByRole("button",{name:"保存物品"}));await screen.findByText(/上传失败，请重试/);
    expect((screen.getByLabelText("物品名称") as HTMLInputElement).value).toBe(" 相机 ");
    expect(screen.getByRole("img",{name:"待登记照片预览"})).toBeTruthy();
    fireEvent.click(screen.getByRole("button",{name:"保存物品"}));await screen.findByText("已登记「相机」");
    expect(inputs[0].get("operation_id")).toBe(inputs[1].get("operation_id"));
    expect(Object.values(localStorage)).toEqual(["cp"]);expect(revoked).toEqual(["blob:preview-1"]);
  });
  // A changed photo may share its filename/size; file replacement must still start a new operation.
  it("uses a new operation after replacing a failed photo with different content",async()=>{
    const ids:string[]=[];
    handler=(url,init)=>{
      if(url.pathname.endsWith("/items/quick")){ids.push(String((init.body as FormData).get("operation_id")));return json({error:{message:"临时失败"}},503);}return normal(url);
    };
    render(createElement(InventoryPage,{...props(),initialCompartment:"cp",initialAction:"capture"}));
    await screen.findByRole("button",{name:"证件层"});
    fireEvent.change(screen.getByLabelText("物品名称"),{target:{value:"相机"}});
    fireEvent.change(screen.getByLabelText("拍摄或选择照片"),{target:{files:[photoFile("same.png",1200,1)]}});
    await screen.findByRole("img",{name:"待登记照片预览"});
    fireEvent.click(screen.getByRole("button",{name:"保存物品"}));await screen.findByText(/临时失败/);
    fireEvent.change(screen.getByLabelText("拍摄或选择照片"),{target:{files:[photoFile("same.png",1200,2)]}});
    await waitFor(()=>expect(screen.queryByText("正在处理照片…")).toBeNull());
    fireEvent.click(screen.getByRole("button",{name:"保存物品"}));await waitFor(()=>expect(ids.length).toBe(2));
    expect(ids[0]).not.toBe(ids[1]);expect(revoked).toContain("blob:preview-1");
  });
  // Two submit events in the same render must send one request, and no photo is a supported input.
  it("prevents duplicate quick submissions and permits registration without a photo",async()=>{
    let finish:((response:Response)=>void)|undefined;let writes=0;
    handler=(url,init)=>{
      if(url.pathname.endsWith("/items/quick")){
        writes++;expect((init.body as FormData).has("image")).toBe(false);
        return new Promise(resolve=>{finish=resolve;});
      }return normal(url);
    };
    render(createElement(InventoryPage,{...props(),initialCompartment:"cp",initialAction:"capture"}));
    await screen.findByRole("button",{name:"证件层"});fireEvent.change(screen.getByLabelText("物品名称"),{target:{value:"相机"}});
    const form=screen.getByRole("button",{name:"保存物品"}).closest("form")!;
    act(()=>{fireEvent.submit(form);fireEvent.submit(form);});
    await act(async()=>{finish?.(json({item},201));});
    await screen.findByText("已登记「相机」");expect(writes).toBe(1);
  });
  // A successful old-account upload must neither close the new account's form nor write its recent storage.
  it("ignores an upload response after switching accounts",async()=>{
    let finish:((response:Response)=>void)|undefined;
    handler=(url)=>url.pathname.endsWith("/items/quick")?new Promise(resolve=>{finish=resolve;}):normal(url);
    const view=render(createElement(InventoryPage,{...props(),initialCompartment:"cp",initialAction:"capture"}));
    await screen.findByRole("button",{name:"证件层"});fireEvent.change(screen.getByLabelText("物品名称"),{target:{value:"旧账号物品"}});
    fireEvent.click(screen.getByRole("button",{name:"保存物品"}));
    view.rerender(createElement(InventoryPage,{...props(),me:{...me,user:{...me.user,id:"another"}}}));
    fireEvent.click(screen.getByRole("button",{name:"拍照登记"}));
    fireEvent.change(screen.getByLabelText("物品名称"),{target:{value:"新账号草稿"}});
    await act(async()=>{finish?.(json({item},201));});
    expect((screen.getByLabelText("物品名称") as HTMLInputElement).value).toBe("新账号草稿");
    expect(localStorage.length).toBe(0);
  });
  // Moving to another registration destination must invalidate an older upload's completion.
  it("does not close a newly opened destination form when an older upload completes",async()=>{
    let finish:((response:Response)=>void)|undefined;
    handler=(url)=>{
      if(url.pathname.endsWith("/items/quick"))return new Promise(resolve=>{finish=resolve;});
      if(url.pathname.endsWith("/locations/compartments/cp2"))return json({location:{room_id:"r2",container_id:"c2",compartment_id:"cp2",path:["书房","书柜","资料层"]}});
      return normal(url);
    };
    const view=render(createElement(InventoryPage,{...props(),initialCompartment:"cp",initialAction:"capture"}));
    await screen.findByRole("button",{name:"证件层"});fireEvent.change(screen.getByLabelText("物品名称"),{target:{value:"旧位置提交"}});
    fireEvent.click(screen.getByRole("button",{name:"保存物品"}));
    view.rerender(createElement(InventoryPage,{...props(),initialCompartment:"cp2",initialAction:"capture"}));
    await screen.findByRole("button",{name:"资料层"});
    await act(async()=>{finish?.(json({item},201));});
    expect(screen.queryByRole("dialog",{name:"拍照登记"})).not.toBeNull();
    expect((screen.getByLabelText("房间") as HTMLSelectElement).value).toBe("r2");
  });
});
