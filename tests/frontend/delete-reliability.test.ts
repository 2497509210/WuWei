import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWorkspace } from "../../frontend/src/store/useWorkspace";
import type { Bootstrap, Container, RoomDetail } from "../../frontend/src/api/client";

const cabinet:Container={id:"c",room_id:"r",name:"衣柜",preset:"wardrobe",width_cm:180,depth_cm:58,height_cm:220,x_cm:120,z_cm:80,y_cm:0,rot_deg:0,color:null,config:{layers:1},compartments:[],item_count:0,version:4};
const detail:RoomDetail={room:{id:"r",floor_id:"f",name:"主卧",width_cm:460,depth_cm:360,height_cm:260,wall_color:null,sort:0,container_count:1,version:7},containers:[cabinet]};
const bootstrap:Bootstrap={user:{id:"u",username:"owner",display_name:"家人",role:"owner"},household:{id:"h",name:"我家"},floors:[{id:"f",name:"1层",level:1,rooms:[detail.room]}]};
type Pending={url:URL;init:RequestInit;respond:(body:unknown,status?:number)=>void};let pending:Pending[];
const flush=async()=>{for(let n=0;n<20;n++)await Promise.resolve();};
function take(method:string,path:string){const index=pending.findIndex(request=>(request.init.method??"GET")===method&&request.url.pathname.endsWith(path));if(index<0)throw new Error(`Missing ${method} ${path}`);return pending.splice(index,1)[0];}
async function enter(){const reading=useWorkspace.getState().selectRoom("r");take("GET","/rooms/r").respond(detail);await reading;}
beforeEach(()=>{
  useWorkspace.getState().reset();useWorkspace.setState({bootstrap});pending=[];
  vi.stubGlobal("fetch",(url:string,init:RequestInit={})=>new Promise<Response>(resolve=>pending.push({url:new URL(url,"http://localhost"),init,respond:(body,status=200)=>resolve(new Response(status===204?null:JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}}))})));
});
afterEach(()=>{useWorkspace.getState().reset();vi.unstubAllGlobals();});

// A pending edit must not silently upgrade the version of the user's earlier deletion confirmation.
it("submits the deletion confirmation version even if an earlier queued edit changes the container",async()=>{
  await enter();
  const editing=useWorkspace.getState().patchContainer("c",{name:"新衣柜"});await flush();
  const removing=useWorkspace.getState().removeContainer("c");
  take("PATCH","/containers/c").respond({container:{...cabinet,name:"新衣柜",version:5},rooms:[{...detail.room,version:8}]});
  await editing;await flush();const deletion=take("DELETE","/containers/c");
  expect(deletion.url.searchParams.get("expected_version")).toBe("4");
  deletion.respond({error:{code:"version_conflict",message:"容器已被更新",current:{...cabinet,name:"新衣柜",version:5}}},409);
  expect(await removing).toBe(false);
  expect(useWorkspace.getState().room?.containers[0].name).toBe("新衣柜");
  const retry=useWorkspace.getState().retryLastMutation();await flush();
  expect(pending.filter(request=>request.init.method==="DELETE")).toHaveLength(0);
  take("GET","/rooms/r").respond({...detail,room:{...detail.room,version:8},containers:[{...cabinet,name:"新衣柜",version:5}]});
  expect(await retry).toBe(false);
});

// A timeout can occur after a successful delete. Retry must inspect the server, not repeat deletion.
it("reloads after an uncertain delete instead of reissuing the write",async()=>{
  await enter();const removing=useWorkspace.getState().removeContainer("c");await flush();
  take("DELETE","/containers/c").respond({error:{code:"write_unconfirmed",message:"结果尚未确认，请刷新核对"}},504);
  expect(await removing).toBe(false);
  const retry=useWorkspace.getState().retryLastMutation();await flush();
  expect(pending.filter(request=>request.init.method==="DELETE")).toHaveLength(0);
  take("GET","/rooms/r").respond({room:{...detail.room,version:8,container_count:0},containers:[]});
  await retry;expect(useWorkspace.getState().room?.containers).toEqual([]);
});

// Parent versions returned with a local container edit must become the baseline for later room settings.
it("accepts server room metadata without losing a newer container preview",async()=>{
  await enter();const editing=useWorkspace.getState().patchContainer("c",{name:"柜子"});await flush();
  useWorkspace.getState().moveLocal("c",200,80);
  take("PATCH","/containers/c").respond({container:{...cabinet,name:"柜子",version:5},rooms:[{...detail.room,version:8}]});
  await editing;
  expect(useWorkspace.getState().room?.room.version).toBe(8);
  expect(useWorkspace.getState().bootstrap?.floors[0].rooms[0].version).toBe(8);
  expect(useWorkspace.getState().room?.containers[0].x_cm).toBe(200);
});

// A room deletion must be conditional on the version the user actually confirmed.
it("sends the confirmed room version and requires reconfirmation after a conflict",async()=>{
  await enter();
  const deleting=useWorkspace.getState().removeRoom("r",7);await flush();
  const deletion=take("DELETE","/rooms/r");
  expect(deletion.url.searchParams.get("expected_version")).toBe("7");
  deletion.respond({error:{code:"room_version_conflict",message:"房间已被更新",current_room:{...detail.room,version:8}}},409);
  expect(await deleting).toBe(false);
  expect(useWorkspace.getState().room?.room.id).toBe("r");
  const retry=useWorkspace.getState().retryLastMutation();await flush();
  expect(pending.filter(request=>request.init.method==="DELETE")).toHaveLength(0);
  take("GET","/bootstrap").respond({...bootstrap,floors:[{...bootstrap.floors[0],rooms:[{...detail.room,version:8}]}]});await flush();
  take("GET","/rooms/r").respond({...detail,room:{...detail.room,version:8}});await retry;
  expect(useWorkspace.getState().room?.room.version).toBe(8);
});

// Completing a deletion of the old room must not reset a newer room selection.
it("keeps a newly selected room when deletion of the old room completes",async()=>{
  await enter();const deleting=useWorkspace.getState().removeRoom("r",7);await flush();
  const deletion=take("DELETE","/rooms/r");
  const other={...detail,room:{...detail.room,id:"b",name:"书房"},containers:[]};
  const navigating=useWorkspace.getState().selectRoom("b");take("GET","/rooms/b").respond(other);await navigating;
  deletion.respond(null,204);expect(await deleting).toBe(true);
  expect(useWorkspace.getState().room?.room.id).toBe("b");
  expect(useWorkspace.getState().bootstrap?.floors[0].rooms).toEqual([]);
});

// Deleting a container advances the server room version; the UI must not retain its old baseline.
it("refreshes the visible parent room after a successful container deletion",async()=>{
  await enter();const deleting=useWorkspace.getState().removeContainer("c");await flush();
  take("DELETE","/containers/c").respond(null,204);expect(await deleting).toBe(true);await flush();
  take("GET","/rooms/r").respond({room:{...detail.room,version:8,container_count:0},containers:[]});await flush();
  expect(useWorkspace.getState().room?.room.version).toBe(8);
  expect(useWorkspace.getState().bootstrap?.floors[0].rooms[0].version).toBe(8);
});
