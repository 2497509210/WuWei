import { pythonExecutable, chromeLaunchOptions } from "./env.mjs";
import { chromium } from "../../frontend/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const testRoot=fileURLToPath(new URL("../",import.meta.url)),project=path.resolve(testRoot,"..");
const runDir=await mkdtemp(path.join(testRoot,".e2e-reliability-"));
const shots=path.join(testRoot,"e2e/shots/reliability");await mkdir(shots,{recursive:true});
const listener=net.createServer();await new Promise(resolve=>listener.listen(0,"127.0.0.1",resolve));
const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
const origin=`http://127.0.0.1:${port}`,basePath=process.env.WUWEI_E2E_BASE_PATH||"",base=origin+basePath;
const backend=spawn(pythonExecutable(project),["-B","-m","uvicorn","app.main:app","--app-dir",path.join(project,"backend"),"--host","127.0.0.1","--port",String(port)],{
  cwd:testRoot,windowsHide:true,stdio:["ignore","pipe","pipe"],
  env:{...process.env,WUWEI_DATA_DIR:runDir,WUWEI_STATIC_DIR:path.join(project,"frontend/dist"),WUWEI_BASE_PATH:basePath,WUWEI_ALLOWED_ORIGINS:origin,WUWEI_SECURE_COOKIES:"0"}
});
let log="";backend.stderr.on("data",data=>{log+=data;});
let browser,page;const errors=[],checks=[];
function check(name,value=true){assert.ok(value,name);checks.push(name);console.log(`PASS ${name}`);}
try{
  let ready=false;for(let i=0;i<80;i++){try{if((await fetch(`${base}/api/health`)).ok){ready=true;break;}}catch{}await delay(100);}assert.ok(ready,log);
  browser=await chromium.launch(chromeLaunchOptions());
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),api=context.request;
  const token=(await readFile(path.join(runDir,"setup-token"),"utf8")).trim();
  assert.equal((await api.post(`${base}/api/setup`,{data:{token,household_name:"可靠性测试",username:"owner",password:"reliability-fixture-2026"}})).status(),201);
  const room=(await(await api.post(`${base}/api/rooms`,{data:{name:"书房",width_cm:460,depth_cm:360,height_cm:260}})).json()).room;
  const cabinet=(await(await api.post(`${base}/api/containers`,{data:{room_id:room.id,preset:"drawer_unit",name:"抽屉柜",x_cm:150,z_cm:60,width_cm:100,depth_cm:50,height_cm:80,config:{layers:2,cols:1}}})).json()).container;
  await api.post(`${base}/api/items/batch`,{data:{compartment_id:cabinet.compartments[0].id,names:["护照"],operation_id:"reliability-item"}});
  page=await context.newPage();page.on("pageerror",error=>errors.push(error.message));
  await page.goto(`${base}/find`);
  await page.getByRole("button",{name:"查看护照",exact:true}).waitFor();
  await page.getByRole("button",{name:"批量整理",exact:true}).click();
  await page.getByRole("checkbox",{name:"选择护照",exact:true}).check();
  const failQuery=async route=>{
    const url=new URL(route.request().url());
    if(url.searchParams.get("q")==="断网")await route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:{message:"筛选请求失败"}})});else await route.continue();
  };
  await page.route("**/api/items?*",failQuery);
  await page.getByRole("searchbox").fill("断网");
  await page.getByText("当前筛选未能加载，以下为上次结果",{exact:true}).waitFor();
  check("新筛选失败时旧结果不可勾选或批量提交",!await page.getByRole("checkbox",{name:"选择护照",exact:true}).isEnabled()&&!await page.getByRole("button",{name:"批量归档",exact:true}).isEnabled());
  check("未核验筛选禁止导出",!await page.getByRole("button",{name:"导出清单",exact:true}).isEnabled());
  await page.screenshot({path:path.join(shots,"01-failed-filter.png"),fullPage:true});
  await page.unroute("**/api/items?*",failQuery);await page.getByRole("searchbox").fill("");
  await page.getByRole("checkbox",{name:"选择护照",exact:true}).waitFor();
  await page.waitForFunction(()=>!document.querySelector('input[aria-label="选择护照"]')?.disabled);
  check("当前筛选重新成功后恢复操作",await page.getByRole("button",{name:"导出清单",exact:true}).isEnabled());
  await api.post(`${base}/api/account/logout-all`);
  await page.getByRole("button",{name:"刷新清单",exact:true}).click();
  await page.getByRole("button",{name:"登录",exact:true}).waitFor();
  check("登录被撤销后清理旧页面并保留找物地址",await page.getByRole("button",{name:"查看护照",exact:true}).count()===0&&new URL(page.url()).pathname===`${basePath}/find`);
  await page.getByLabel("用户名",{exact:true}).fill("owner");await page.getByLabel("密码",{exact:true}).fill("reliability-fixture-2026");
  await page.getByRole("button",{name:"登录",exact:true}).click();await page.getByRole("button",{name:"查看护照",exact:true}).waitFor();
  check("重新登录回到原页面");
  const emptyRoom=(await(await api.post(`${base}/api/rooms`,{data:{name:"待核对房间",width_cm:460,depth_cm:360,height_cm:260}})).json()).room;
  await page.goto(base);await page.getByRole("button",{name:/待核对房间/}).click();
  await page.getByRole("button",{name:"删除房间",exact:true}).waitFor();
  await api.patch(`${base}/api/rooms/${emptyRoom.id}`,{data:{expected_version:emptyRoom.version,name:"另一个设备改名"}});
  page.once("dialog",dialog=>dialog.accept());
  await page.getByRole("button",{name:"删除房间",exact:true}).click();
  await page.getByRole("button",{name:"加载最新记录",exact:true}).waitFor();
  check("陈旧房间删除被阻止并保留最新房间",(await api.get(`${base}/api/rooms/${emptyRoom.id}`)).status()===200);
  await page.getByRole("button",{name:"加载最新记录",exact:true}).click();
  await page.getByRole("heading",{name:"另一个设备改名",exact:true}).waitFor();
  check("加载最新记录不自动重发删除",(await api.get(`${base}/api/rooms/${emptyRoom.id}`)).status()===200);
  page.once("dialog",dialog=>dialog.accept());await page.getByRole("button",{name:"删除房间",exact:true}).click();
  await page.getByRole("group",{name:"书房平面图",exact:true}).waitFor();
  check("重新确认后按最新版本删除",(await api.get(`${base}/api/rooms/${emptyRoom.id}`)).status()===404);
  check("没有未处理浏览器错误",errors.length===0);
  await writeFile(path.join(shots,"results.json"),JSON.stringify({checks,errors,runDir},null,2));
}catch(error){console.error(error);await page?.screenshot({path:path.join(shots,"failure.png"),fullPage:true}).catch(()=>{});process.exitCode=1;}
finally{await browser?.close();backend.kill();}
