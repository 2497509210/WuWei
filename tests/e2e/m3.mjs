import { pythonExecutable, chromeLaunchOptions } from "./env.mjs";
import { chromium } from "../../frontend/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const testRoot=fileURLToPath(new URL("../",import.meta.url));
const project=path.resolve(testRoot,"..");
const runDir=await mkdtemp(path.join(testRoot,".e2e-m3-"));
const shots=path.join(testRoot,"e2e/shots/m3");await mkdir(shots,{recursive:true});
const listener=net.createServer();await new Promise(resolve=>listener.listen(0,"127.0.0.1",resolve));
const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
const origin=`http://127.0.0.1:${port}`,basePath=process.env.WUWEI_E2E_BASE_PATH||"",base=origin+basePath;
const backend=spawn(pythonExecutable(project),["-B","-m","uvicorn","app.main:app","--app-dir",path.join(project,"backend"),"--host","127.0.0.1","--port",String(port)],{
  cwd:testRoot,windowsHide:true,stdio:["ignore","pipe","pipe"],
  env:{...process.env,WUWEI_DATA_DIR:runDir,WUWEI_STATIC_DIR:process.env.WUWEI_E2E_STATIC_DIR||path.join(project,"frontend/dist"),WUWEI_BASE_PATH:basePath,WUWEI_ALLOWED_ORIGINS:origin,WUWEI_SECURE_COOKIES:"0"}
});
let log="";backend.stderr.on("data",data=>{log+=data;});
let browser,page;const errors=[],checks=[];
function check(name,value=true){assert.ok(value,name);checks.push(name);console.log(`PASS ${name}`);}
try{
  let ready=false;for(let i=0;i<80;i++){try{if((await fetch(`${base}/api/health`)).ok){ready=true;break;}}catch{}await delay(100);}assert.ok(ready,log);
  browser=await chromium.launch(chromeLaunchOptions());
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),api=context.request;
  const token=(await readFile(path.join(runDir,"setup-token"),"utf8")).trim();
  const setup=await api.post(`${base}/api/setup`,{data:{token,household_name:"日常管理示例",username:"review",password:"local-review-2026"}});assert.equal(setup.status(),201);
  async function createRoom(name){const response=await api.post(`${base}/api/rooms`,{data:{name,width_cm:460,depth_cm:360,height_cm:260}});assert.equal(response.status(),201);return(await response.json()).room;}
  async function createContainer(room,name){const response=await api.post(`${base}/api/containers`,{data:{room_id:room.id,preset:"wardrobe",name,x_cm:180,z_cm:50,width_cm:180,depth_cm:58,height_cm:220,config:{layers:3,cols:1}}});assert.equal(response.status(),201);return(await response.json()).container;}
  const bedroom=await createRoom("主卧"),study=await createRoom("书房");
  let cabinet=await createContainer(bedroom,"白色衣柜");
  const destination=await createContainer(study,"书房柜");
  const sourceId=cabinet.compartments[0].id,targetId=destination.compartments[0].id;
  const registered=await api.post(`${base}/api/items/batch`,{data:{compartment_id:sourceId,names:["旧相机"],operation_id:"m3-camera"}});
  const item=(await registered.json()).items[0];
  page=await context.newPage();page.on("pageerror",error=>errors.push(error.message));
  await page.goto(`${base}/find`);await page.getByRole("button",{name:"查看旧相机",exact:true}).click();
  await page.getByRole("button",{name:"在房间中定位",exact:true}).click();
  let shelf=page.getByRole("dialog",{name:"白色衣柜",exact:true});await shelf.waitFor();
  await shelf.getByLabel("隔层名称",{exact:true}).fill("相机抽屉");
  await shelf.getByRole("button",{name:"保存名称",exact:true}).click();
  await shelf.getByRole("button",{name:"相机抽屉",exact:true}).waitFor();
  cabinet=(await(await api.get(`${base}/api/rooms/${bedroom.id}`)).json()).containers[0];
  const changed=await api.patch(`${base}/api/containers/${cabinet.id}`,{data:{expected_version:cabinet.version,config:{layers:4,cols:1}}});assert.equal(changed.status(),200);
  const persisted=(await changed.json()).container;
  check("隔层自定义名称和ID在调整层数后保留",persisted.compartments[0].id===sourceId&&persisted.compartments[0].name==="相机抽屉");
  await page.reload();
  shelf=page.getByRole("dialog",{name:"白色衣柜",exact:true});await shelf.getByRole("button",{name:"相机抽屉",exact:true}).waitFor();
  await page.screenshot({path:path.join(shots,"01-compartment-name.png"),fullPage:true});
  await shelf.getByRole("button",{name:"查看隔层里的物品",exact:true}).click();
  await page.getByRole("button",{name:"查看旧相机",exact:true}).click();
  await page.getByRole("button",{name:"移到别处",exact:true}).click();
  await page.getByLabel("房间",{exact:true}).selectOption(study.id);
  await page.getByLabel("容器",{exact:true}).selectOption(destination.id);
  await page.getByRole("button",{name:destination.compartments[0].name,exact:true}).click();
  await page.getByRole("button",{name:"保存新位置",exact:true}).click();
  await page.getByText("位置已更新",{exact:true}).waitFor();
  const history=page.getByRole("region",{name:"操作历史",exact:true});
  await history.getByRole("button",{name:"撤销这次移动",exact:true}).waitFor();
  check("详情显示移动历史与操作者",(await history.innerText()).includes("相机抽屉")&&(await history.innerText()).includes("review"));
  await history.getByRole("button",{name:"撤销这次移动",exact:true}).click();
  await page.getByText("已撤销这次移动",{exact:true}).waitFor();
  let latest=(await(await api.get(`${base}/api/items/${item.id}`)).json()).item;
  check("撤销最近移动回到原隔层",latest.compartment_id===sourceId);
  await page.getByRole("button",{name:"归档物品",exact:true}).click();
  await page.getByLabel("归档原因（选填）",{exact:true}).fill("已经换新，保留记录");
  await page.getByRole("button",{name:"确认归档",exact:true}).click();
  await page.getByText("物品已归档，可在「已归档」中恢复",{exact:true}).waitFor();
  latest=(await(await api.get(`${base}/api/items/${item.id}`)).json()).item;
  check("归档保留位置快照并解除当前隔层",Boolean(latest.archived_at)&&latest.compartment_id===null&&latest.location_path.includes("相机抽屉"));
  await page.getByRole("button",{name:"关闭对话框",exact:true}).click();
  await page.getByRole("button",{name:"查看旧相机",exact:true}).waitFor({state:"hidden"});
  await page.getByRole("button",{name:"已归档",exact:true}).click();
  await page.getByRole("button",{name:"查看旧相机",exact:true}).click();
  check("归档列表可查看，编辑操作已收起",await page.getByRole("button",{name:"编辑资料",exact:true}).count()===0);
  const removalRoom=(await(await api.get(`${base}/api/rooms/${bedroom.id}`)).json()).room;
  assert.equal((await api.delete(`${base}/api/rooms/${bedroom.id}?expected_version=${removalRoom.version}`)).status(),204);
  await page.getByRole("button",{name:"恢复物品",exact:true}).click();
  await page.getByLabel("房间",{exact:true}).selectOption(study.id);
  await page.getByLabel("容器",{exact:true}).selectOption(destination.id);
  await page.getByRole("button",{name:destination.compartments[0].name,exact:true}).click();
  await page.getByRole("button",{name:"确认恢复",exact:true}).click();
  await page.getByText("物品已恢复到所选位置",{exact:true}).waitFor();
  latest=(await(await api.get(`${base}/api/items/${item.id}`)).json()).item;
  check("旧房间删除后仍可恢复至新位置",latest.archived_at===null&&latest.compartment_id===targetId&&latest.location_status==="confirmed");
  await page.getByRole("region",{name:"操作历史",exact:true}).getByText("恢复物品",{exact:true}).waitFor();
  const events=(await(await api.get(`${base}/api/items/${item.id}/events`)).json()).events;
  check("历史快照保留已删除位置及归档原因",events.some(e=>e.type==="move"&&e.from_path?.includes("相机抽屉"))&&events.some(e=>e.type==="archive"));
  await page.setViewportSize({width:390,height:844});
  const itemDialog=page.getByRole("dialog",{name:"旧相机",exact:true});
  check("手机详情与历史无横向溢出",await itemDialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
  await page.screenshot({path:path.join(shots,"02-mobile-history.png"),fullPage:true});
  await page.getByRole("button",{name:"关闭对话框",exact:true}).click();
  await page.getByRole("button",{name:"在用",exact:true}).click();
  await page.getByRole("button",{name:"查看全部",exact:true}).click();
  await page.getByRole("button",{name:"查看旧相机",exact:true}).waitFor();
  await page.reload();await page.getByRole("button",{name:"查看旧相机",exact:true}).waitFor();
  check("恢复后回到在用列表，刷新后保持");
  check("没有未处理的浏览器脚本错误",errors.length===0);
  await writeFile(path.join(shots,"results.json"),JSON.stringify({checks,errors,runDir},null,2));
}catch(error){console.error(error);await page?.screenshot({path:path.join(shots,"failure.png"),fullPage:true}).catch(()=>{});process.exitCode=1;}
finally{await browser?.close();backend.kill();}
