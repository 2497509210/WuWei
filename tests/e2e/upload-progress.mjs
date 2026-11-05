import { pythonExecutable, chromeLaunchOptions } from "./env.mjs";
import { chromium } from "../../frontend/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const testRoot=fileURLToPath(new URL("../",import.meta.url)),project=path.resolve(testRoot,"..");
const runDir=await mkdtemp(path.join(testRoot,".e2e-upload-progress-"));
const shots=path.join(testRoot,"e2e/shots/upload-progress");await mkdir(shots,{recursive:true});
const listener=net.createServer();await new Promise(resolve=>listener.listen(0,"127.0.0.1",resolve));
const backendPort=listener.address().port;await new Promise(resolve=>listener.close(resolve));
let receivedBytes=0;
const proxy=http.createServer((request,response)=>{
  const isUpload=request.method==="POST"&&request.url.endsWith("/api/items/quick");
  if(isUpload)request.on("data",chunk=>{receivedBytes+=chunk.length;});
  const upstream=http.request({host:"127.0.0.1",port:backendPort,path:request.url,method:request.method,headers:request.headers},incoming=>{
    if(!isUpload){response.writeHead(incoming.statusCode,incoming.headers);incoming.pipe(response);return;}
    const chunks=[];incoming.on("data",chunk=>chunks.push(chunk));incoming.on("end",()=>{
      setTimeout(()=>{response.writeHead(incoming.statusCode,incoming.headers);response.end(Buffer.concat(chunks));},2500);
    });
  });
  upstream.on("error",()=>{response.writeHead(502);response.end();});request.pipe(upstream);
});
await new Promise(resolve=>proxy.listen(0,"127.0.0.1",resolve));
const origin=`http://127.0.0.1:${proxy.address().port}`,basePath=process.env.WUWEI_E2E_BASE_PATH||"",base=origin+basePath;
const python=pythonExecutable(project);
const backend=spawn(python,["-B","-m","uvicorn","app.main:app","--app-dir",path.join(project,"backend"),"--host","127.0.0.1","--port",String(backendPort)],{
  cwd:testRoot,windowsHide:true,stdio:["ignore","pipe","pipe"],
  env:{...process.env,WUWEI_DATA_DIR:runDir,WUWEI_STATIC_DIR:path.join(project,"frontend/dist"),WUWEI_BASE_PATH:basePath,WUWEI_ALLOWED_ORIGINS:origin,WUWEI_SECURE_COOKIES:"0"}
});
let log="";backend.stderr.on("data",data=>{log+=data;});
let browser,page;const errors=[],checks=[];
function check(name,value=true){assert.ok(value,name);checks.push(name);console.log(`PASS ${name}`);}
try{
  const fixture=path.join(runDir,"synthetic-12mp.jpg");
  const generator=spawn(python,["-B","-c","from PIL import Image; import sys; im=Image.effect_noise((4000,3000),80).convert('RGB'); im.save(sys.argv[1],quality=85)",fixture],{windowsHide:true,stdio:"pipe"});
  assert.equal(await new Promise(resolve=>generator.on("exit",resolve)),0);
  const source=await readFile(fixture);assert.ok(source.length<8*1024*1024&&source.length>1024*1024);
  let ready=false;for(let i=0;i<80;i++){try{if((await fetch(`${base}/api/health`)).ok){ready=true;break;}}catch{}await delay(100);}assert.ok(ready,log);
  browser=await chromium.launch(chromeLaunchOptions());
  const context=await browser.newContext({viewport:{width:390,height:844}}),api=context.request;
  const token=(await readFile(path.join(runDir,"setup-token"),"utf8")).trim();
  assert.equal((await api.post(`${base}/api/setup`,{data:{token,household_name:"上传进度测试",username:"owner",password:"progress-fixture-2026"}})).status(),201);
  const room=(await(await api.post(`${base}/api/rooms`,{data:{name:"书房",width_cm:460,depth_cm:360,height_cm:260}})).json()).room;
  const cabinet=(await(await api.post(`${base}/api/containers`,{data:{room_id:room.id,preset:"drawer_unit",name:"抽屉柜",x_cm:150,z_cm:60,width_cm:100,depth_cm:50,height_cm:80,config:{layers:2,cols:1}}})).json()).container;
  page=await context.newPage();page.on("pageerror",error=>errors.push(error.message));
  await page.goto(`${base}/find?compartment=${cabinet.compartments[0].id}&capture=1`);
  const dialog=page.getByRole("dialog",{name:"拍照登记",exact:true});await dialog.waitFor();
  await dialog.getByRole("button",{name:cabinet.compartments[0].name,exact:true}).waitFor();
  await dialog.getByLabel("拍摄或选择照片",{exact:true}).setInputFiles({name:"large.jpg",mimeType:"image/jpeg",buffer:source});
  await dialog.getByText(/（已压缩）/).waitFor({timeout:20000});
  const preview=dialog.getByRole("img",{name:"待登记照片预览",exact:true});await preview.waitFor();
  await preview.evaluate(image=>image.decode());
  const dimensions=await preview.evaluate(image=>({width:image.naturalWidth,height:image.naturalHeight}));
  check("12MP合成大图在本机缩至长边1600像素",Math.max(dimensions.width,dimensions.height)===1600);
  await dialog.getByLabel("物品名称",{exact:true}).fill("慢网照片测试");
  const network=await context.newCDPSession(page);
  await network.send("Network.enable");
  await network.send("Network.emulateNetworkConditions",{offline:false,latency:100,downloadThroughput:1024*1024,uploadThroughput:24*1024});
  await dialog.getByRole("button",{name:"保存物品",exact:true}).click();
  await page.waitForFunction(()=>{
    const progress=document.querySelector('[aria-label="上传进度"]');
    const value=Number(progress?.getAttribute("aria-valuenow"));return value>0&&value<100;
  },{},{timeout:20000});
  const before=Number(await dialog.getByRole("progressbar",{name:"上传进度"}).getAttribute("aria-valuenow"));
  await page.waitForFunction(previous=>Number(document.querySelector('[aria-label="上传进度"]')?.getAttribute("aria-valuenow"))>previous,before,{timeout:15000});
  check("真实限速网络下百分比随实际上传字节增长");
  check("保存后手机自动显示完整上传状态与停止按钮",await dialog.getByRole("status",{name:"上传状态"}).evaluate(el=>{
    const state=el.getBoundingClientRect(),outer=el.closest("dialog").getBoundingClientRect();return state.top>=outer.top&&state.bottom<=outer.bottom;
  }));
  await page.screenshot({path:path.join(shots,"uploading.png"),fullPage:true});
  await dialog.getByText("照片已传完，等待服务器确认保存",{exact:true}).waitFor({timeout:60000});
  check("上传完成与保存成功分开展示",await dialog.isVisible()&&await dialog.getByRole("button",{name:"停止等待"}).isEnabled());
  await page.screenshot({path:path.join(shots,"waiting-confirmation.png"),fullPage:true});
  await dialog.waitFor({state:"hidden",timeout:15000});
  const items=(await(await api.get(`${base}/api/items`)).json()).items;
  check("实际传输量明显小于原照片且只保存一条记录",receivedBytes<source.length/2&&items.length===1&&Boolean(items[0].photo_url));
  check("手机页面没有脚本异常",errors.length===0);
  await writeFile(path.join(shots,"results.json"),JSON.stringify({checks,errors,originalBytes:source.length,requestBytes:receivedBytes,dimensions,runDir},null,2));
  console.log(`Original ${source.length} bytes; uploaded multipart ${receivedBytes} bytes.`);
}catch(error){console.error(error);await page?.screenshot({path:path.join(shots,"failure.png"),fullPage:true}).catch(()=>{});process.exitCode=1;}
finally{await browser?.close();backend.kill();proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}
