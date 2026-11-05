// @vitest-environment jsdom
import { StrictMode, createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "../../frontend/src/App";
import { useWorkspace } from "../../frontend/src/store/useWorkspace";

const me={user:{id:"u",username:"owner",display_name:"家长",role:"owner"},household:{id:"h",name:"我家"}};
const reply=(body:unknown,status=200)=>new Response(status===204?null:JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});
afterEach(()=>{cleanup();useWorkspace.getState().reset();vi.unstubAllGlobals();window.history.replaceState(null,"","/");});

// A slow authentication read from before password change must not reopen the now-revoked session.
it("ignores an old bootstrap after password change ends the current session",async()=>{
  window.history.replaceState(null,"","/settings");
  const reads:Array<(response:Response)=>void>=[];
  vi.stubGlobal("fetch",(path:string,init:RequestInit={})=>{
    if(path.endsWith("/setup/status"))return Promise.resolve(reply({needed:false}));
    if(path.endsWith("/api/me"))return new Promise<Response>(resolve=>reads.push(resolve));
    if(path.endsWith("/account/devices"))return Promise.resolve(reply({devices:[]}));
    if(path.endsWith("/household/members"))return Promise.resolve(reply({members:[{...me.user,created_at:"2026-11-05T00:00:00Z"}]}));
    if(path.endsWith("/household/invites"))return Promise.resolve(reply({invites:[]}));
    if(path.endsWith("/account/password")&&init.method==="POST")return Promise.resolve(reply(null,204));
    if(path.endsWith("/bootstrap"))return Promise.resolve(reply({...me,floors:[]}));
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal("matchMedia",()=>({matches:false,addEventListener(){},removeEventListener(){}}));
  render(createElement(StrictMode,null,createElement(App)));
  await waitFor(()=>expect(reads.length).toBe(2));
  await act(async()=>{reads[1](reply(me));});
  await screen.findByRole("heading",{name:"账号与家庭"});
  fireEvent.change(screen.getByLabelText("当前密码"),{target:{value:"password123"}});
  fireEvent.change(screen.getByLabelText("新密码"),{target:{value:"new-password"}});
  fireEvent.change(screen.getByLabelText("确认新密码"),{target:{value:"new-password"}});
  fireEvent.click(screen.getByRole("button",{name:"修改密码并退出"}));
  await screen.findByText("密码已修改，请重新登录");
  await act(async()=>{reads[0](reply(me));});
  expect(screen.queryByRole("button",{name:"登录",exact:true})).not.toBeNull();
  expect(screen.queryByText("密码已修改，请重新登录")).not.toBeNull();
});

// Redemption cannot be retried with a consumed invite when only loading the new profile failed.
it("keeps the joined confirmation when profile loading fails and retries entry without redemption",async()=>{
  window.history.replaceState(null,"","/join");
  let joined=false,profileReads=0,redemptions=0;
  vi.stubGlobal("fetch",async(path:string,init:RequestInit={})=>{
    if(path.endsWith("/setup/status"))return reply({needed:false});
    if(path.endsWith("/api/me")){
      if(!joined)return reply({error:{code:"not_authenticated",message:"请先登录"}},401);
      if(++profileReads===1)return reply({error:{code:"offline",message:"暂时不可用"}},503);
      return reply({...me,user:{...me.user,role:"member"}});
    }
    if(path.endsWith("/auth/join")&&init.method==="POST"){
      redemptions++;
      if(joined)return reply({error:{code:"invalid_invite",message:"邀请码已使用"}},400);
      joined=true;return reply({...me,user:{...me.user,role:"member"}},201);
    }
    if(path.endsWith("/bootstrap"))return reply({...me,user:{...me.user,role:"member"},floors:[]});
    throw new Error(`Unexpected ${path}`);
  });
  vi.stubGlobal("matchMedia",()=>({matches:false,addEventListener(){},removeEventListener(){}}));
  render(createElement(App));
  fireEvent.change(await screen.findByLabelText("邀请码"),{target:{value:"sample-invite"}});
  fireEvent.change(screen.getByLabelText("用户名"),{target:{value:"family"}});
  fireEvent.change(screen.getByLabelText("昵称"),{target:{value:"家人"}});
  fireEvent.change(screen.getByLabelText("密码",{exact:true}),{target:{value:"password123"}});
  fireEvent.change(screen.getByLabelText("确认密码"),{target:{value:"password123"}});
  fireEvent.click(screen.getByRole("button",{name:"加入家庭"}));
  await screen.findByText("已加入家庭，页面加载失败，请重试进入");
  fireEvent.click(screen.getByRole("button",{name:"进入家庭"}));
  await screen.findByRole("button",{name:"账号与家庭"});
  expect(redemptions).toBe(1);
});

// Visiting the join form from a scanned link must not discard its location or requested action.
it("preserves a pending mobile deep link when visiting Join and returning to login",async()=>{
  const target="/find?compartment=cp&capture=1";
  window.history.replaceState(null,"",target);
  vi.stubGlobal("fetch",async(path:string)=>path.endsWith("/setup/status")?reply({needed:false}):reply({error:{code:"not_authenticated",message:"请先登录"}},401));
  render(createElement(App));
  fireEvent.click(await screen.findByRole("button",{name:"使用邀请码加入家庭"}));
  await screen.findByRole("heading",{name:"加入家人的空间"});
  fireEvent.click(screen.getByRole("button",{name:"返回登录"}));
  await screen.findByRole("button",{name:"登录",exact:true});
  expect(window.location.pathname+window.location.search).toBe(target);
});
