import { pythonExecutable, chromeLaunchOptions } from "./env.mjs";
import { chromium } from "../../frontend/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomFillSync } from "node:crypto";
import path from "node:path";
import net from "node:net";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { PNG } = require("pngjs");
const testRoot = fileURLToPath(new URL("../", import.meta.url)), project = path.resolve(testRoot, "..");
const runDir = await mkdtemp(path.join(testRoot, ".e2e-photo-drafts-"));
const shots = path.join(testRoot, "e2e/shots/photo-drafts"); await mkdir(shots, { recursive: true });
const listener = net.createServer(); await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`, basePath = process.env.WUWEI_E2E_BASE_PATH || "", base = origin + basePath;
const backend = spawn(pythonExecutable(project), ["-B", "-m", "uvicorn", "app.main:app", "--app-dir", path.join(project, "backend"), "--host", "127.0.0.1", "--port", String(port), "--no-access-log"], {
  cwd: testRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, WUWEI_DATA_DIR: runDir, WUWEI_STATIC_DIR: path.join(project, "frontend/dist"), WUWEI_BASE_PATH: basePath, WUWEI_ALLOWED_ORIGINS: origin, WUWEI_SECURE_COOKIES: "0" },
});
let log = ""; backend.stderr.on("data", data => { log += data; });
let browser, page; const errors = [], checks = [];
function check(name, value = true) { assert.ok(value, name); checks.push(name); console.log(`PASS ${name}`); }
try {
  let ready = false; for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch {} await delay(100); } assert.ok(ready, log);
  browser = await chromium.launch(chromeLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } }), api = context.request;
  const token = (await readFile(path.join(runDir, "setup-token"), "utf8")).trim();
  assert.equal((await api.post(`${base}/api/setup`, { data: { token, household_name: "照片草稿测试", username: "owner", password: "draft-fixture-2026" } })).status(), 201);
  const room = (await (await api.post(`${base}/api/rooms`, { data: { name: "书房", width_cm: 460, depth_cm: 360, height_cm: 260 } })).json()).room;
  const cabinet = (await (await api.post(`${base}/api/containers`, { data: { room_id: room.id, preset: "drawer_unit", name: "抽屉柜", x_cm: 150, z_cm: 60, width_cm: 100, depth_cm: 50, height_cm: 80, config: { layers: 2, cols: 1 } } })).json()).container;
  const item = (await (await api.post(`${base}/api/items/batch`, { data: { compartment_id: cabinet.compartments[0].id, names: ["相机"], operation_id: "draft-seed" } })).json()).items[0];
  page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  await page.goto(base); await page.getByRole("button", { name: "家庭找物", exact: true }).click();
  await page.getByRole("button", { name: "查看相机", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "相机", exact: true });
  const png = new PNG({ width: 1800, height: 1800 }); randomFillSync(png.data);
  for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
  const photo = PNG.sync.write(png); assert.ok(photo.length > 8 * 1024 * 1024);
  await detail.getByLabel("物品照片", { exact: true }).setInputFiles({ name: "synthetic-large.png", mimeType: "image/png", buffer: photo });
  await detail.getByRole("img", { name: "待上传照片预览", exact: true }).waitFor();
  check("已有物品换图接受超过8MiB原图并先本机压缩", await detail.getByText(/已在本机压缩/).isVisible());
  const operationIds = []; let intercepted = false;
  await page.route(`**/api/items/${item.id}/photo`, async route => {
    const body = route.request().postDataBuffer().toString("latin1");
    operationIds.push(body.match(/name="operation_id"\r\n\r\n([^\r\n]+)/)?.[1]);
    if (intercepted) { await route.continue(); return; }
    intercepted = true; const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort("failed");
  });
  await detail.getByRole("button", { name: "保存照片", exact: true }).click();
  await detail.getByRole("alert").filter({ hasText: "尚未确认" }).waitFor();
  check("照片已保存但响应丢失时保留预览和诊断编号", await detail.getByRole("img", { name: "待上传照片预览" }).isVisible() && await detail.getByText(/诊断编号：[0-9a-f]{32}/).isVisible());
  await detail.getByRole("button", { name: "保存照片", exact: true }).click(); await detail.getByText("照片已保存", { exact: true }).waitFor();
  const events = (await (await api.get(`${base}/api/items/${item.id}/events`)).json()).events;
  check("换图原样重试只写一次照片历史", operationIds.length === 2 && operationIds[0] && operationIds[0] === operationIds[1] && events.filter(event => event.type === "photo").length === 1);
  await page.unroute(`**/api/items/${item.id}/photo`);
  await detail.getByRole("button", { name: "编辑资料", exact: true }).click();
  await detail.getByLabel("备注", { exact: true }).fill("我尚未保存的备注");
  page.once("dialog", dialog => dialog.dismiss()); await detail.getByRole("button", { name: "关闭对话框" }).click();
  check("取消放弃草稿会保留编辑内容", await detail.getByLabel("备注", { exact: true }).inputValue() === "我尚未保存的备注");
  const current = (await (await api.get(`${base}/api/items/${item.id}`)).json()).item;
  assert.equal((await api.patch(`${base}/api/items/${item.id}`, { data: { expected_version: current.version, notes: "家人刚保存的备注" } })).status(), 200);
  await detail.getByRole("button", { name: "保存资料", exact: true }).click(); await detail.getByRole("button", { name: "核对后继续编辑", exact: true }).waitFor();
  check("编辑冲突保留草稿并在核对前禁用保存", await detail.getByLabel("备注", { exact: true }).inputValue() === "我尚未保存的备注" && !await detail.getByRole("button", { name: "保存资料" }).isEnabled() && await detail.getByRole("region", { name: "资料更新冲突" }).getByText("家人刚保存的备注", { exact: true }).isVisible());
  await page.screenshot({ path: path.join(shots, "01-conflict-mobile.png"), fullPage: true });
  await detail.getByRole("radio", { name: "备注：保留我的修改", exact: true }).check();
  await detail.getByRole("button", { name: "核对后继续编辑", exact: true }).click(); await detail.getByRole("button", { name: "保存资料", exact: true }).click(); await detail.getByText("资料已保存", { exact: true }).waitFor();
  check("明确核对后可提交保留的草稿", (await (await api.get(`${base}/api/items/${item.id}`)).json()).item.notes === "我尚未保存的备注");
  await detail.getByRole("button", { name: "关闭对话框" }).click();
  await page.getByRole("button", { name: "登记物品", exact: true }).click();
  const register = page.getByRole("dialog", { name: "一起记在这个位置", exact: true });
  await register.getByLabel("物品名称，每行一件或一组", { exact: true }).fill("未保存的批量登记");
  page.once("dialog", dialog => dialog.dismiss()); await page.keyboard.press("Escape");
  check("Escape不会直接丢弃批量登记草稿", await register.getByRole("textbox", { name: /^物品名称/ }).inputValue() === "未保存的批量登记");
  let leavePrompt = page.waitForEvent("dialog"); await page.evaluate(() => history.back());
  await (await leavePrompt).dismiss(); await page.waitForURL(url => url.pathname === `${basePath}/find`);
  check("取消浏览器返回保留当前页和草稿", await register.getByRole("textbox", { name: /^物品名称/ }).inputValue() === "未保存的批量登记");
  leavePrompt = page.waitForEvent("dialog"); await page.evaluate(() => history.back()); await (await leavePrompt).accept();
  await page.waitForURL(url => url.pathname === basePath || url.pathname === `${basePath}/`); await register.waitFor({ state: "hidden" });
  check("确认放弃后关闭且不创建物品", (await (await api.get(`${base}/api/items`)).json()).items.length === 1);
  check("手机弹窗无横向溢出", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check("没有未处理浏览器异常", errors.length === 0);
  await writeFile(path.join(shots, "results.json"), JSON.stringify({ checks, errors, runDir, inputBytes: photo.length }, null, 2));
} catch (error) { console.error(error); await page?.screenshot({ path: path.join(shots, "failure.png"), fullPage: true }).catch(() => {}); if(page) await writeFile(path.join(shots,"failure.html"),await page.content()).catch(()=>{}); process.exitCode = 1; }
finally { await browser?.close(); backend.kill(); }
