import { pythonExecutable, chromeLaunchOptions } from "./env.mjs";
import { chromium } from "../../frontend/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const testRoot = fileURLToPath(new URL("../", import.meta.url));
const project = path.resolve(testRoot, "..");
const runDir = await mkdtemp(path.join(testRoot, ".e2e-navigation-"));
const shots = path.join(testRoot, "e2e/shots/navigation");
await mkdir(shots, { recursive: true });
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const basePath = process.env.WUWEI_E2E_BASE_PATH || "";
const base = origin + basePath;
const backend = spawn(pythonExecutable(project), ["-B", "-m", "uvicorn", "app.main:app", "--app-dir", path.join(project, "backend"), "--host", "127.0.0.1", "--port", String(port)], {
  cwd: testRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, WUWEI_DATA_DIR: runDir, WUWEI_STATIC_DIR: process.env.WUWEI_E2E_STATIC_DIR || path.join(project, "frontend/dist"), WUWEI_BASE_PATH: basePath, WUWEI_ALLOWED_ORIGINS: origin, WUWEI_SECURE_COOKIES: "0" },
});
let serverLog = "", browser, page;
backend.stderr.on("data", data => { serverLog += data; });
const checks = [], errors = [];
function check(name, condition = true) { assert.ok(condition, name); checks.push(name); console.log(`PASS ${name}`); }
const range = value => page.getByText(value, { exact: true }).waitFor();
async function scrollTo(y) {
  await page.evaluate(value => window.scrollTo({ top: value, behavior: "instant" }), y);
  await page.waitForFunction(value => Math.abs(scrollY - value) < 3, y);
  await delay(80);
}
async function restored(y) { await page.waitForFunction(value => Math.abs(scrollY - value) < 4, y); }

try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(ready, serverLog);
  browser = await chromium.launch(chromeLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const api = context.request;
  const token = (await readFile(path.join(runDir, "setup-token"), "utf8")).trim();
  assert.equal((await api.post(`${base}/api/setup`, { data: { token, household_name: "找物导航测试", username: "owner", password: "navigation-fixture-2026" } })).status(), 201);
  const roomResponse = await api.post(`${base}/api/rooms`, { data: { name: "导航卧室", width_cm: 460, depth_cm: 360, height_cm: 260 } });
  assert.equal(roomResponse.status(), 201); const room = (await roomResponse.json()).room;
  const cabinetResponse = await api.post(`${base}/api/containers`, { data: { room_id: room.id, preset: "wardrobe", name: "导航衣柜", x_cm: 150, z_cm: 60, width_cm: 100, depth_cm: 50, height_cm: 200, config: { layers: 2, cols: 1 } } });
  assert.equal(cabinetResponse.status(), 201); const cabinet = (await cabinetResponse.json()).container;
  const batch = await api.post(`${base}/api/items/batch`, { data: { compartment_id: cabinet.compartments[0].id, names: Array.from({ length: 81 }, (_, i) => `导航物品${String(i + 1).padStart(2, "0")}`), operation_id: "navigation-seed" } });
  assert.equal(batch.status(), 201);
  for (const item of (await batch.json()).items) assert.equal((await api.post(`${base}/api/items/${item.id}/missing`, { data: { expected_version: item.version } })).status(), 200);
  page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));

  const shared = `${base}/find?${new URLSearchParams({ q: "导航", status: "missing", room: room.id, page: "2" })}`;
  await page.goto(shared);
  await range("第 41–80 条，共 81 条");
  check("分享链接恢复搜索、待找回、房间和第2页", await page.getByRole("searchbox").inputValue() === "导航" && await page.getByRole("button", { name: "待找回", exact: true }).getAttribute("aria-pressed") === "true" && await page.getByRole("combobox", { name: "筛选房间" }).inputValue() === room.id);
  await scrollTo(900);
  await page.reload(); await range("第 41–80 条，共 81 条"); await restored(900);
  check("刷新在成功呈现列表后恢复滚动位置");

  // Dispatch the header action without Playwright scrolling it into view first.
  await page.getByRole("button", { name: "账号与家庭" }).evaluate(button => button.click());
  await page.getByRole("heading", { name: "账号与家庭" }).waitFor();
  await page.getByRole("button", { name: "返回找物", exact: true }).click();
  await range("第 41–80 条，共 81 条"); await restored(900);
  check("账号页面返回保留完整筛选及滚动", page.url() === shared);

  await page.locator(".inventory-grid .inventory-item").nth(10).click();
  const detail = page.getByRole("dialog"); await detail.waitFor();
  const beforeLocate = await page.evaluate(() => scrollY);
  await detail.getByRole("button", { name: "在房间中定位", exact: true }).click();
  await page.waitForURL(url => url.pathname === `${basePath}/` || url.pathname === basePath);
  await page.getByRole("dialog", { name: "导航衣柜", exact: true }).getByRole("button", { name: "关闭对话框" }).click();
  await page.getByRole("button", { name: "家庭找物", exact: true }).click();
  await range("第 41–80 条，共 81 条"); await restored(beforeLocate);
  check("从物品定位到空间后恢复原筛选及阅读位置", page.url() === shared);

  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await range("第 81–81 条，共 81 条");
  await page.waitForFunction(() => { const top = document.querySelector(".inventory-list-heading").getBoundingClientRect().top; return top >= -3 && top < innerHeight - 100; });
  check("主动翻页把新页面的列表头滚入视口", new URL(page.url()).searchParams.get("page") === "3");
  await page.goBack(); await range("第 41–80 条，共 81 条");
  const backOffset = await page.evaluate(() => scrollY);
  check("浏览器后退恢复第2页且不被主动翻页滚动覆盖", backOffset > 400);
  await page.goForward(); await range("第 81–81 条，共 81 条");
  check("浏览器前进恢复第3页", new URL(page.url()).searchParams.get("page") === "3");
  await page.getByRole("searchbox").fill("导航物品81"); await range("第 1–1 条，共 1 条");
  check("改搜索回第1页并保留状态及房间", !new URL(page.url()).searchParams.has("page") && new URL(page.url()).searchParams.get("status") === "missing" && new URL(page.url()).searchParams.get("room") === room.id);
  await page.reload(); await range("第 1–1 条，共 1 条");
  check("修改后的筛选可直接刷新打开", await page.getByRole("searchbox").inputValue() === "导航物品81");

  await page.goto(`${base}/find?compartment=${cabinet.compartments[0].id}&capture=1`);
  await page.getByRole("dialog", { name: "拍照登记", exact: true }).waitFor();
  await page.waitForURL(url => !url.searchParams.has("capture"));
  await page.getByRole("button", { name: "关闭对话框" }).click();
  await page.reload(); await range("第 1–40 条，共 81 条");
  check("扫码拍照动作只消费一次且保留隔层", await page.getByRole("dialog").count() === 0 && new URL(page.url()).searchParams.get("compartment") === cabinet.compartments[0].id);
  await page.goto(`${base}/find?status=bad&page=-1&room=%3Cbad%3E`);
  await range("第 1–40 条，共 81 条");
  check("无效URL参数安全回默认清单", page.url() === `${base}/find`);
  check("没有未处理浏览器错误", errors.length === 0);
  await page.screenshot({ path: path.join(shots, "navigation-result.png"), fullPage: false });
  await writeFile(path.join(shots, "results.json"), JSON.stringify({ checks, errors, runDir }, null, 2));
} catch (error) {
  console.error(error);
  await page?.screenshot({ path: path.join(shots, "failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally { await browser?.close(); backend.kill(); }
