import { availableTestPort, pythonExecutable, chromeLaunchOptions } from "./env.mjs";
import { chromium } from "../../frontend/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const testRoot=fileURLToPath(new URL("../",import.meta.url)),project=path.resolve(testRoot,"..");
const runDir=await mkdtemp(path.join(testRoot,".e2e-photo-save-"));
const shots=path.join(testRoot,"e2e/shots/photo-save");await mkdir(shots,{recursive:true});
const port = await availableTestPort();
const origin=`http://127.0.0.1:${port}`,basePath=process.env.WUWEI_E2E_BASE_PATH||"",base=origin+basePath;
const backend=spawn(pythonExecutable(project),["-B","-m","uvicorn","app.main:app","--app-dir",path.join(project,"backend"),"--host","127.0.0.1","--port",String(port)],{
  cwd:testRoot,windowsHide:true,stdio:["ignore","pipe","pipe"],
  env:{...process.env,WUWEI_DATA_DIR:runDir,WUWEI_STATIC_DIR:path.join(project,"frontend/dist"),WUWEI_BASE_PATH:basePath,WUWEI_ALLOWED_ORIGINS:origin,WUWEI_SECURE_COOKIES:"0"}
});
let log="";backend.stderr.on("data",data=>{log+=data;});
let browser,page,releaseResponse;const errors=[],checks=[];
function check(name,value=true){assert.ok(value,name);checks.push(name);console.log(`PASS ${name}`);}
try{
  let ready=false;for(let i=0;i<80;i++){try{if((await fetch(`${base}/api/health`)).ok){ready=true;break;}}catch{}await delay(100);}assert.ok(ready,log);
  browser=await chromium.launch(chromeLaunchOptions());
  const context=await browser.newContext({viewport:{width:390,height:844}}),api=context.request;
  const token=(await readFile(path.join(runDir,"setup-token"),"utf8")).trim();
  assert.equal((await api.post(`${base}/api/setup`,{data:{token,household_name:"保存重试测试",username:"owner",password:"photo-fixture-2026"}})).status(),201);
  const room=(await(await api.post(`${base}/api/rooms`,{data:{name:"书房",width_cm:460,depth_cm:360,height_cm:260}})).json()).room;
  const cabinet=(await(await api.post(`${base}/api/containers`,{data:{room_id:room.id,preset:"drawer_unit",name:"抽屉柜",x_cm:150,z_cm:60,width_cm:100,depth_cm:50,height_cm:80,config:{layers:2,cols:1}}})).json()).container;
  const compartment=cabinet.compartments[0];
  page=await context.newPage();page.on("pageerror",error=>errors.push(error.message));
  await page.goto(`${base}/find?compartment=${compartment.id}&capture=1`);
  const dialog=page.getByRole("dialog",{name:"拍照登记",exact:true});await dialog.waitFor();
  await dialog.getByRole("button",{name:compartment.name,exact:true}).waitFor();
  await dialog.getByLabel("拍摄或选择照片",{exact:true}).setInputFiles({name:"photo.png",mimeType:"image/png",buffer:await readFile(path.join(project,"frontend/public/app-icons/icon-192.png"))});
  await dialog.getByRole("button",{name:"保存物品",exact:true}).click();
  await dialog.getByRole("alert").filter({hasText:/名称/}).waitFor({timeout:3000});
  check("未填写名称时显示明确错误并定位名称输入框",await dialog.getByLabel("物品名称",{exact:true}).evaluate(el=>document.activeElement===el));
  await dialog.getByLabel("物品名称",{exact:true}).fill("相机上传重试");
  let serverItem;let first=true;
  let savedOnServer;const committed=new Promise(resolve=>{savedOnServer=resolve;});
  const heldResponse=new Promise(resolve=>{releaseResponse=resolve;});
  await page.route("**/api/items/quick",async route=>{
    if(!first){await route.continue();return;}first=false;
    const response=await route.fetch();assert.equal(response.status(),201);
    serverItem=(await response.json()).item;savedOnServer();
    await heldResponse;await route.fulfill({response}).catch(()=>{});
  });
  await dialog.getByRole("button",{name:"保存物品",exact:true}).click();
  await committed;
  await dialog.getByRole("button",{name:"停止等待",exact:true}).click();
  await dialog.getByRole("button",{name:"保存物品",exact:true}).waitFor();
  check("服务器已保存但响应挂起时可以停止等待",await dialog.getByRole("button",{name:"关闭对话框",exact:true}).isEnabled());
  check("停止等待仍保留名称和照片",await dialog.getByLabel("物品名称",{exact:true}).inputValue()==="相机上传重试"&&await dialog.getByRole("img",{name:"待登记照片预览",exact:true}).isVisible());
  await page.screenshot({path:path.join(shots,"retry-preserved.png"),fullPage:true});
  await dialog.getByRole("button",{name:"保存物品",exact:true}).click();
  await dialog.waitFor({state:"hidden"});
  releaseResponse();
  const items=(await(await api.get(`${base}/api/items`)).json()).items;
  const history=(await(await api.get(`${base}/api/items/${serverItem.id}/events`)).json()).events;
  check("不确定结果后原样重试仍只有一条物品和一次照片记录",items.length===1&&items[0].id===serverItem.id&&history.filter(event=>event.type==="photo").length===1);
  check("无未处理浏览器错误",errors.length===0);
  await writeFile(path.join(shots,"results.json"),JSON.stringify({checks,errors,runDir},null,2));
}catch(error){console.error(error);await page?.screenshot({path:path.join(shots,"failure.png"),fullPage:true}).catch(()=>{});process.exitCode=1;}
finally{releaseResponse?.();await browser?.close();backend.kill();}
