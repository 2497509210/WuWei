// @vitest-environment jsdom
import { createElement, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "../../frontend/src/pages/SettingsPage";
import { JoinPage } from "../../frontend/src/pages/JoinPage";
import type { MeResponse } from "../../frontend/src/api/client";

const owner: MeResponse = {user:{id:"owner",username:"owner",display_name:"家长",role:"owner"},household:{id:"home",name:"我家"}};
const member = {id:"member",username:"xiaoming",display_name:"小明",role:"member",created_at:"2026-11-05T00:00:00Z"};
const phone = {id:"phone",device_name:"手机",created_at:"2026-11-05T00:00:00Z",last_seen_at:"2026-11-05T00:00:00Z",expires_at:"2027-11-05T00:00:00Z",current:false,legacy:false};
const current = {...phone,id:"browser",device_name:"浏览器",current:true};
const invitation = {id:"invite",created_at:"2026-11-05T00:00:00Z",expires_at:"2026-11-12T00:00:00Z",used_at:null,revoked_at:null};
type Handler=(url:URL,init:RequestInit)=>Promise<Response>|Response;
let handler:Handler;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator,"clipboard");
function json(body:unknown,status=200){return new Response(status===204?null:JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});}
function normal(url:URL){
  if(url.pathname.endsWith("/devices"))return json({devices:[current,phone]});
  if(url.pathname.endsWith("/members"))return json({members:[{...owner.user,created_at:member.created_at},member]});
  if(url.pathname.endsWith("/invites"))return json({invites:[]});
  return json({error:{message:"Unexpected request"}},400);
}
beforeEach(()=>{
  handler=url=>normal(url);
  vi.stubGlobal("fetch",(path:string,init:RequestInit={})=>Promise.resolve(handler(new URL(path,"http://localhost"),init)));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();if(originalClipboard)Object.defineProperty(navigator,"clipboard",originalClipboard);else Reflect.deleteProperty(navigator,"clipboard");});
function SettingsHarness({initial=owner}:{initial?:MeResponse}){
  const [me,setMe]=useState(initial),[ended,setEnded]=useState("");
  return ended?createElement("p",null,ended):createElement("div",null,
    createElement("output",{"aria-label":"当前昵称"},me.user.display_name),
    createElement(SettingsPage,{me,onMeChanged:user=>setMe({...me,user}),onSessionEnded:setEnded,onBack:()=>{}}));
}

describe("account settings",()=>{
  // Failed writes must retain edited names and a successful profile update must reach the app.
  it("preserves a failed nickname draft and updates the signed-in profile on retry",async()=>{
    let attempt=0;
    handler=(url,init)=>{
      if(url.pathname.endsWith("/profile")){
        const input=JSON.parse(String(init.body));
        if(input.display_name!=="新的昵称")return json({error:{message:"wrong nickname"}},400);
        return ++attempt===1?json({error:{message:"昵称保存失败"}},503):json({user:{...owner.user,display_name:input.display_name}});
      }
      return normal(url);
    };
    render(createElement(SettingsHarness));
    fireEvent.change(screen.getByLabelText("昵称"),{target:{value:" 新的昵称 "}});
    fireEvent.click(screen.getByRole("button",{name:"保存昵称"}));await screen.findByText("昵称保存失败", { exact: false });
    expect((screen.getByLabelText("昵称") as HTMLInputElement).value).toBe(" 新的昵称 ");
    fireEvent.click(screen.getByRole("button",{name:"保存昵称"}));
    await waitFor(()=>expect(screen.getByLabelText("当前昵称").textContent).toBe("新的昵称"));
  });
  // A password change validates confirmation before submitting and logs out only after server success.
  it("keeps password inputs after failure and ends the session after a successful password change",async()=>{
    let attempt=0;
    handler=(url,init)=>{
      if(url.pathname.endsWith("/password")){
        const input=JSON.parse(String(init.body));
        if(input.current_password!=="old-password"||input.new_password!=="new-password")return json({error:{message:"wrong password request"}},400);
        return ++attempt===1?json({error:{message:"当前密码不正确"}},400):json(null,204);
      }return normal(url);
    };
    render(createElement(SettingsHarness));
    fireEvent.change(screen.getByLabelText("当前密码"),{target:{value:"old-password"}});
    fireEvent.change(screen.getByLabelText("新密码"),{target:{value:"new-password"}});
    fireEvent.change(screen.getByLabelText("确认新密码"),{target:{value:"different"}});
    fireEvent.click(screen.getByRole("button",{name:"修改密码并退出"}));await screen.findByText("两次新密码不一致");
    fireEvent.change(screen.getByLabelText("确认新密码"),{target:{value:"new-password"}});
    fireEvent.click(screen.getByRole("button",{name:"修改密码并退出"}));await screen.findByText("当前密码不正确", { exact: false });
    expect((screen.getByLabelText("新密码") as HTMLInputElement).value).toBe("new-password");
    fireEvent.click(screen.getByRole("button",{name:"修改密码并退出"}));
    await screen.findByText("密码已修改，请重新登录");
    expect(screen.queryByLabelText("新密码")).toBeNull();
  });
  // Revoking a foreign device must remove that whole group without logging out the current device.
  it("revokes another device group and displays the upgrade-era group warning",async()=>{
    handler=(url,init)=>{
      if(url.pathname.endsWith("/devices")&&init.method!=="DELETE")return json({devices:[current,phone,{...phone,id:"legacy",legacy:true,device_name:"旧设备"}]});
      if(url.pathname.endsWith("/devices/phone")&&init.method==="DELETE")return json({current_revoked:false});
      return normal(url);
    };
    render(createElement(SettingsHarness));
    await screen.findByText("升级前登录（可能包含多台设备）");
    fireEvent.click(screen.getByRole("button",{name:"退出设备 手机"}));
    fireEvent.click(screen.getByRole("button",{name:"确认退出此设备"}));
    await waitFor(()=>expect(screen.queryByRole("button",{name:"退出设备 手机"})).toBeNull());
    expect(screen.getByRole("button",{name:"退出设备 浏览器"})).toBeTruthy();
  });
  // The current flag must use the API result so revoking the active group reliably clears the app session.
  it("returns to login after revoking the current device group",async()=>{
    handler=(url,init)=>url.pathname.endsWith("/devices/browser")&&init.method==="DELETE"?json({current_revoked:true}):normal(url);
    render(createElement(SettingsHarness));
    fireEvent.click(await screen.findByRole("button",{name:"退出设备 浏览器"}));
    fireEvent.click(screen.getByRole("button",{name:"确认退出此设备"}));
    await screen.findByText("当前设备已退出，请重新登录");
  });
  // Members must never see or request owner-only membership/invitation administration.
  it("hides owner controls for ordinary members",async()=>{
    const forbidden:string[]=[];
    handler=url=>{if(url.pathname.includes("/household/"))forbidden.push(url.pathname);return normal(url);};
    render(createElement(SettingsHarness,{initial:{...owner,user:{...owner.user,role:"member"}}}));
    await screen.findByRole("button",{name:"退出设备 浏览器"});
    expect(screen.queryByRole("button",{name:"生成邀请码"})).toBeNull();
    expect(screen.queryByRole("button",{name:"移除成员 小明"})).toBeNull();
    expect(forbidden).toEqual([]);
  });
  // Removing a member is explicit, preserves the failed confirmation, and can never target the owner.
  it("confirms member removal, retains a failed action, and excludes the owner",async()=>{
    let attempt=0;
    handler=(url,init)=>url.pathname.endsWith("/members/member")&&init.method==="DELETE"
      ?++attempt===1?json({error:{message:"移除失败"}},503):json(null,204):normal(url);
    render(createElement(SettingsHarness));
    fireEvent.click(await screen.findByRole("button",{name:"移除成员 小明"}));
    expect(screen.queryByRole("button",{name:"移除成员 家长"})).toBeNull();
    fireEvent.click(screen.getByRole("button",{name:"确认移除成员"}));await screen.findByText("移除失败", { exact: false });
    fireEvent.click(screen.getByRole("button",{name:"确认移除成员"}));
    await waitFor(()=>expect(screen.queryByRole("button",{name:"移除成员 小明"})).toBeNull());
  });
  // A generated code must be displayed only in this page lifetime and disappear when its invite is revoked.
  it("shows a new invitation once and clears its code after revocation",async()=>{
    handler=(url,init)=>{
      if(url.pathname.endsWith("/invites")&&init.method==="POST")return json({invite:invitation,code:"one-time-invite"},201);
      if(url.pathname.endsWith("/invites/invite")&&init.method==="DELETE")return json(null,204);
      return normal(url);
    };
    const view=render(createElement(SettingsHarness));
    fireEvent.click(await screen.findByRole("button",{name:"生成邀请码"}));
    await screen.findByLabelText("新邀请码");
    expect((screen.getByLabelText("新邀请码") as HTMLInputElement).value).toBe("one-time-invite");
    fireEvent.click(screen.getByRole("button",{name:"撤销邀请码"}));
    await waitFor(()=>expect(screen.queryByLabelText("新邀请码")).toBeNull());
    view.unmount();render(createElement(SettingsHarness));
    await screen.findByRole("button",{name:"退出设备 浏览器"});
    expect(screen.queryByLabelText("新邀请码")).toBeNull();
  });
  // A response from a read started before revocation must not resurrect the revoked device.
  it("ignores a stale devices refresh completed after a revocation",async()=>{
    let reads=0,finishOld:((response:Response)=>void)|undefined;
    handler=(url,init)=>{
      if(url.pathname.endsWith("/devices")&&++reads>1)return new Promise(resolve=>{finishOld=resolve;});
      if(url.pathname.endsWith("/devices/phone")&&init.method==="DELETE")return json({current_revoked:false});
      return normal(url);
    };
    render(createElement(SettingsHarness));await screen.findByRole("button",{name:"退出设备 手机"});
    fireEvent.click(screen.getByRole("button",{name:"刷新设备"}));
    fireEvent.click(screen.getByRole("button",{name:"退出设备 手机"}));
    fireEvent.click(screen.getByRole("button",{name:"确认退出此设备"}));
    await waitFor(()=>expect(screen.queryByRole("button",{name:"退出设备 手机"})).toBeNull());
    await act(async()=>{finishOld?.(json({devices:[current,phone]}));});
    expect(screen.queryByRole("button",{name:"退出设备 手机"})).toBeNull();
  });
  // A refresh can reveal that another admin already revoked or used the newly displayed code.
  it("clears a newly generated code if a refresh shows it is no longer usable",async()=>{
    let created=false;
    handler=(url,init)=>{
      if(url.pathname.endsWith("/invites")&&init.method==="POST") {created=true;return json({invite:invitation,code:"visible-only-now"},201);}
      if(url.pathname.endsWith("/invites"))return json({invites:created?[{...invitation,used_at:"2026-11-05T01:00:00Z"}]:[]});
      return normal(url);
    };
    render(createElement(SettingsHarness));fireEvent.click(await screen.findByRole("button",{name:"生成邀请码"}));
    await screen.findByLabelText("新邀请码");fireEvent.click(screen.getByRole("button",{name:"刷新邀请"}));
    await screen.findByText("已使用");
    await waitFor(()=>expect(screen.queryByLabelText("新邀请码")).toBeNull());
  });
  // A delayed clipboard response for code A must not claim that newly generated code B was copied.
  it("ignores an old clipboard completion after generating a newer invitation",async()=>{
    let inviteNumber=0,finishCopy:(()=>void)|undefined;
    Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:()=>new Promise<void>(resolve=>{finishCopy=resolve;})}});
    handler=(url,init)=>url.pathname.endsWith("/invites")&&init.method==="POST"
      ?json({invite:{...invitation,id:`invite-${++inviteNumber}`},code:`code-${inviteNumber}`},201):normal(url);
    render(createElement(SettingsHarness));fireEvent.click(await screen.findByRole("button",{name:"生成邀请码"}));
    await screen.findByLabelText("新邀请码");fireEvent.click(screen.getByRole("button",{name:"复制邀请码"}));
    fireEvent.click(screen.getByRole("button",{name:"生成邀请码"}));
    await waitFor(()=>expect((screen.getByLabelText("新邀请码") as HTMLInputElement).value).toBe("code-2"));
    await act(async()=>{finishCopy?.();});
    expect(screen.queryByText("邀请码已复制，请自行分享给家人")).toBeNull();
  });
  // Exiting all devices must require confirmation and clear the current app only after a successful POST.
  it("confirms logout-all and ends the session after completion",async()=>{
    handler=(url,init)=>url.pathname.endsWith("/logout-all")&&init.method==="POST"?json(null,204):normal(url);
    render(createElement(SettingsHarness));fireEvent.click(screen.getByRole("button",{name:"退出所有设备"}));
    expect(screen.getByRole("heading",{name:"账号与家庭"})).toBeTruthy();
    fireEvent.click(screen.getByRole("button",{name:"确认退出所有设备"}));
    await screen.findByText("所有设备已退出，请重新登录");
  });
  // Reads started before a password mutation may get 401 after commit; they must not steal its success message.
  it("keeps the password-change reason when an older devices request expires during the change",async()=>{
    let finishDevices:((response:Response)=>void)|undefined,finishPassword:((response:Response)=>void)|undefined;
    handler=(url)=>{
      if(url.pathname.endsWith("/devices"))return new Promise(resolve=>{finishDevices=resolve;});
      if(url.pathname.endsWith("/password"))return new Promise(resolve=>{finishPassword=resolve;});
      return normal(url);
    };
    render(createElement(SettingsHarness));
    fireEvent.change(screen.getByLabelText("当前密码"),{target:{value:"old-password"}});
    fireEvent.change(screen.getByLabelText("新密码"),{target:{value:"new-password"}});
    fireEvent.change(screen.getByLabelText("确认新密码"),{target:{value:"new-password"}});
    fireEvent.click(screen.getByRole("button",{name:"修改密码并退出"}));
    await act(async()=>{finishDevices?.(json({error:{code:"unauthorized",message:"请登录"}},401));});
    await act(async()=>{finishPassword?.(json(null,204));});
    expect(screen.queryByText("密码已修改，请重新登录")).not.toBeNull();
  });
  // Migrated devices may have no recorded usage time; null must never render as the Unix epoch.
  it("shows an unrecorded last-use date for legacy devices with no timestamp",async()=>{
    handler=url=>url.pathname.endsWith("/devices")?json({devices:[{...phone,legacy:true,last_seen_at:null}]}):normal(url);
    render(createElement(SettingsHarness));await screen.findByText("升级前登录（可能包含多台设备）");
    expect(screen.queryByText(/最近使用 未记录/)).not.toBeNull();
    expect(screen.queryByText(/1970/)).toBeNull();
  });
});

describe("joining a household",()=>{
  function fillJoin(password="password123",confirmation=password){
    fireEvent.change(screen.getByLabelText("邀请码"),{target:{value:" invited-code "}});
    fireEvent.change(screen.getByLabelText("用户名"),{target:{value:" newuser "}});
    fireEvent.change(screen.getByLabelText("昵称"),{target:{value:" 新家人 "}});
    fireEvent.change(screen.getByLabelText("密码"),{target:{value:password}});
    fireEvent.change(screen.getByLabelText("确认密码"),{target:{value:confirmation}});
  }
  // Invalid and failed enrollment must retain the form, while a retry submits only the promised fields.
  it("validates passwords and retains the join draft after server failure",async()=>{
    let attempts=0;
    handler=(url,init)=>{
      if(url.pathname.endsWith("/auth/join")){
        const input=JSON.parse(String(init.body));
        if(input.username!=="newuser"||input.display_name!=="新家人"||input.code!=="invited-code"||input.password!=="password123"||input.remember!==true)return json({error:{message:"wrong enrollment"}},400);
        return ++attempts===1?json({error:{message:"邀请码无效或已过期"}},400):json({...owner,user:{...owner.user,role:"member"}},201);
      }return normal(url);
    };
    function Joining(){const[joined,setJoined]=useState(false);return joined?createElement("p",null,"已进入家庭"):createElement(JoinPage,{onDone:async()=>setJoined(true),onBack:()=>{}});}
    render(createElement(Joining));fillJoin("short","short");
    fireEvent.submit(screen.getByRole("button",{name:"加入家庭"}).closest("form")!);await screen.findByText("密码需为 8–200 个字符");
    fillJoin("password123","different");fireEvent.submit(screen.getByRole("button",{name:"加入家庭"}).closest("form")!);await screen.findByText("两次密码不一致");
    fillJoin();fireEvent.click(screen.getByRole("button",{name:"加入家庭"}));await screen.findByText("邀请码无效或已过期", { exact: false });
    expect((screen.getByLabelText("邀请码") as HTMLInputElement).value).toBe(" invited-code ");
    fireEvent.click(screen.getByRole("button",{name:"加入家庭"}));await screen.findByText("已进入家庭");
  });
  // If sign-in bootstrap fails after code redemption, retry only entry and never redeem the code again.
  it("retries entering the app without reusing an already consumed invitation",async()=>{
    let redeemed=false,entries=0;
    handler=(url)=>{
      if(url.pathname.endsWith("/auth/join")){
        if(redeemed)return json({error:{message:"邀请码已经使用"}},400);
        redeemed=true;return json(owner,201);
      }return normal(url);
    };
    render(createElement(JoinPage,{onDone:async()=>{if(++entries===1)throw new Error("页面暂时无法加载");},onBack:()=>{}}));
    fillJoin();fireEvent.click(screen.getByRole("button",{name:"加入家庭"}));
    await screen.findByText("已加入家庭，页面加载失败，请重试进入");
    fireEvent.click(screen.getByRole("button",{name:"进入家庭"}));
    await waitFor(()=>expect(screen.queryByText("已加入家庭，页面加载失败，请重试进入")).toBeNull());
    expect(screen.queryByText("邀请码已经使用")).toBeNull();
  });
});
