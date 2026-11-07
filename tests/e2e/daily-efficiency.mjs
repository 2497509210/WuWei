import { availableTestPort, pythonExecutable, chromeLaunchOptions } from "./env.mjs";
import { chromium } from "../../frontend/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const testRoot = fileURLToPath(new URL("../", import.meta.url)), project = path.resolve(testRoot, "..");
const runDir = await mkdtemp(path.join(testRoot, ".e2e-daily-"));
const shots = path.join(testRoot, "e2e/shots/daily-efficiency"); await mkdir(shots, { recursive: true });
const port = await availableTestPort();
const origin = `http://127.0.0.1:${port}`, basePath = process.env.WUWEI_E2E_BASE_PATH || "", base = origin + basePath;
const backend = spawn(pythonExecutable(project), ["-B", "-m", "uvicorn", "app.main:app", "--app-dir", path.join(project, "backend"), "--host", "127.0.0.1", "--port", String(port), "--no-access-log"], {
  cwd: testRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, WUWEI_DATA_DIR: runDir, WUWEI_STATIC_DIR: path.join(project, "frontend/dist"), WUWEI_BASE_PATH: basePath, WUWEI_ALLOWED_ORIGINS: origin, WUWEI_SECURE_COOKIES: "0" },
});
let serverLog = ""; backend.stderr.on("data", data => { serverLog += data; });
let browser, page; const checks = [], errors = [];
function check(name, value = true) { assert.ok(value, name); checks.push(name); console.log(`PASS ${name}`); }
try {
  let ready = false; for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch {} await delay(100); } assert.ok(ready, serverLog);
  browser = await chromium.launch(chromeLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } }), api = context.request;
  const token = (await readFile(path.join(runDir, "setup-token"), "utf8")).trim();
  assert.equal((await api.post(`${base}/api/setup`, { data: { token, household_name: "日常整理测试", username: "owner", password: "daily-fixture-2026" } })).status(), 201);
  const room = (await (await api.post(`${base}/api/rooms`, { data: { name: "书房", width_cm: 460, depth_cm: 360, height_cm: 260 } })).json()).room;
  const cabinet = (await (await api.post(`${base}/api/containers`, { data: { room_id: room.id, preset: "drawer_unit", name: "抽屉柜", x_cm: 150, z_cm: 60, width_cm: 100, depth_cm: 50, height_cm: 80, config: { layers: 2, cols: 1 } } })).json()).container;
  const slot = cabinet.compartments[0];
  const original = (await (await api.post(`${base}/api/items/batch`, { data: { compartment_id: slot.id, names: ["护照"], operation_id: "daily-seed" } })).json()).items[0];
  page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}/find?q=${encodeURIComponent("护照")}`);
  await page.getByRole("button", { name: "拍照登记", exact: true }).click();
  const quick = page.getByRole("dialog", { name: "拍照登记", exact: true });
  await quick.getByLabel("房间", { exact: true }).selectOption(room.id);
  await quick.getByLabel("容器", { exact: true }).selectOption(cabinet.id);
  await quick.getByRole("button", { name: slot.name, exact: true }).click();
  await quick.getByLabel("拍摄或选择照片", { exact: true }).setInputFiles({ name: "fixture.png", mimeType: "image/png", buffer: await readFile(path.join(project, "frontend/public/app-icons/icon-192.png")) });
  await quick.getByLabel("物品名称", { exact: true }).fill("电池");
  await quick.getByRole("button", { name: "保存并继续", exact: true }).click();
  await quick.getByText(/可以继续登记下一件/).waitFor();
  check("保存并继续保留位置清空本件且焦点回名称", await quick.getByLabel("物品名称", { exact: true }).inputValue() === "" && await quick.getByRole("img", { name: "待登记照片预览" }).count() === 0 && await quick.getByRole("button", { name: slot.name, exact: true }).getAttribute("aria-pressed") === "true" && await quick.getByLabel("物品名称", { exact: true }).evaluate(input => input === document.activeElement));
  await quick.getByLabel("物品名称", { exact: true }).fill("电池");
  await quick.getByRole("button", { name: "保存物品", exact: true }).click(); await quick.waitFor({ state: "hidden" });
  const batteries = (await (await api.get(`${base}/api/items?q=${encodeURIComponent("电池")}`)).json()).items;
  check("连续同名同位置建立两件且第二件不继承第一件照片", batteries.length === 2 && batteries.filter(item => item.photo_url).length === 1);
  await page.getByText(/未显示在当前页/).waitFor();
  check("保存回执说明筛选影响并保留原搜索", await page.getByRole("searchbox").inputValue() === "护照");
  await page.getByRole("button", { name: "查看刚登记物品", exact: true }).click();
  const batteryDetail = page.getByRole("dialog", { name: "电池", exact: true }); await batteryDetail.waitFor();
  check("无需清空筛选可直接核验刚登记物品");
  await batteryDetail.getByRole("button", { name: "关闭对话框" }).click();
  await page.getByRole("button", { name: "登记物品", exact: true }).click();
  const register = page.getByRole("dialog", { name: "一起记在这个位置", exact: true });
  const recent = register.getByRole("button", { name: /使用最近位置：书房 \/ 抽屉柜/ }); await recent.waitFor();
  await recent.click(); await register.getByRole("button", { name: slot.name, exact: true }).waitFor();
  await register.getByLabel("物品名称，每行一件或一组").fill("胶带\n剪刀");
  await register.getByRole("button", { name: "保存登记", exact: true }).click(); await register.waitFor({ state: "hidden" });
  check("最近位置可在批量登记中复用并完成核验");
  await page.getByRole("button", { name: "查看刚登记的2件物品", exact: true }).click();
  const receipt = page.getByRole("dialog", { name: "刚登记的物品" });
  await receipt.getByRole("button", { name: "查看剪刀", exact: true }).click();
  const scissors = page.getByRole("dialog", { name: "剪刀", exact: true }); await scissors.waitFor();
  check("批量回执提供所有本次新记录入口");
  await scissors.getByRole("button", { name: "关闭对话框" }).click();
  await page.getByRole("button", { name: "查看护照", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "护照", exact: true });
  await detail.getByRole("button", { name: "编辑资料", exact: true }).click();
  await detail.getByLabel("备注", { exact: true }).fill("我正在编辑的备注");
  assert.equal((await api.patch(`${base}/api/items/${original.id}`, { data: { expected_version: original.version, name: "护照新位置", compartment_id: cabinet.compartments[1].id } })).status(), 200);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await detail.getByText(/清单可能已有更新/).waitFor();
  check("网络恢复不会覆盖正在编辑的草稿", await detail.getByLabel("备注", { exact: true }).inputValue() === "我正在编辑的备注");
  await page.screenshot({ path: path.join(shots, "01-deferred-refresh.png"), fullPage: true });
  page.once("dialog", dialog => dialog.accept()); await detail.getByRole("button", { name: "关闭对话框" }).click();
  await page.getByRole("button", { name: "查看护照新位置", exact: true }).waitFor();
  check("结束编辑后自动读取最新位置且保留搜索", await page.getByRole("searchbox").inputValue() === "护照");
  await page.screenshot({ path: path.join(shots, "02-receipt-mobile.png"), fullPage: true });
  check("390px页面没有横向溢出", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check("没有未处理脚本错误", errors.length === 0);
  await writeFile(path.join(shots, "results.json"), JSON.stringify({ checks, errors, runDir }, null, 2));
} catch (error) { console.error(error); await page?.screenshot({ path: path.join(shots, "failure.png"), fullPage: true }).catch(() => {}); process.exitCode = 1; }
finally { await browser?.close(); backend.kill(); }
