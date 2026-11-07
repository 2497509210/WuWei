import { availableTestPort, pythonExecutable, chromeLaunchOptions } from "./env.mjs";
import { chromium } from "../../frontend/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(new URL("../../frontend/package.json", import.meta.url)), { PNG } = require("pngjs");
const testRoot = fileURLToPath(new URL("../", import.meta.url)), project = path.resolve(testRoot, "..");
const runDir = await mkdtemp(path.join(testRoot, ".e2e-field-photo-"));
const shots = path.join(testRoot, "e2e/shots/field-photo"); await mkdir(shots, { recursive: true });
const port = await availableTestPort();
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
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }), api = context.request;
  const token = (await readFile(path.join(runDir, "setup-token"), "utf8")).trim();
  assert.equal((await api.post(`${base}/api/setup`, { data: { token, household_name: "字段照片测试", username: "owner", password: "field-photo-fixture-2026" } })).status(), 201);
  const room = (await (await api.post(`${base}/api/rooms`, { data: { name: "书房", width_cm: 460, depth_cm: 360, height_cm: 260 } })).json()).room;
  const cabinet = (await (await api.post(`${base}/api/containers`, { data: { room_id: room.id, preset: "drawer_unit", name: "抽屉柜", x_cm: 150, z_cm: 60, width_cm: 100, depth_cm: 50, height_cm: 80, config: { layers: 2, cols: 1 } } })).json()).container;
  const item = (await (await api.post(`${base}/api/items/batch`, { data: { compartment_id: cabinet.compartments[0].id, names: ["相机"], operation_id: "field-seed" } })).json()).items[0];
  const getItem = async () => (await (await api.get(`${base}/api/items/${item.id}`)).json()).item;
  const update = async values => { const current = await getItem(); const response = await api.patch(`${base}/api/items/${item.id}`, { data: { expected_version: current.version, ...values } }); assert.equal(response.status(), 200); return (await response.json()).item; };
  const png = new PNG({ width: 1200, height: 900 });
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) { const offset = (y * png.width + x) * 4; png.data[offset] = x % 256; png.data[offset + 1] = y % 256; png.data[offset + 2] = (x + y) % 256; png.data[offset + 3] = 255; }
  const image = PNG.sync.write(png);
  assert.equal((await api.post(`${base}/api/items/${item.id}/photo`, { multipart: { expected_version: String(item.version), operation_id: "photo-seed", image: { name: "labels.png", mimeType: "image/png", buffer: image } } })).status(), 200);
  page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}/find`); await page.getByRole("button", { name: "查看相机", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "相机", exact: true });
  await detail.getByRole("button", { name: "编辑资料", exact: true }).click();
  await detail.getByLabel("备注", { exact: true }).fill("我的保留备注");
  await update({ quantity: 7 });
  await detail.getByRole("button", { name: "保存资料", exact: true }).click();
  await detail.getByRole("region", { name: "资料更新冲突" }).waitFor();
  check("不同字段冲突保留我的备注并采用最新数量", await detail.getByLabel("备注", { exact: true }).inputValue() === "我的保留备注" && await detail.getByLabel("数量", { exact: true }).inputValue() === "7");
  check("不同字段修改仍需核对且没有虚构选择", !await detail.getByRole("button", { name: "保存资料", exact: true }).isEnabled() && await detail.getByRole("radio").count() === 0);
  await detail.getByRole("button", { name: "核对后继续编辑", exact: true }).click();
  await detail.getByRole("button", { name: "保存资料", exact: true }).click(); await detail.getByText("资料已保存", { exact: true }).waitFor();
  check("增量重试没有覆盖家人的数量", (await getItem()).quantity === 7 && (await getItem()).notes === "我的保留备注");
  await detail.getByRole("button", { name: "编辑资料", exact: true }).click(); await detail.getByLabel("备注", { exact: true }).fill("我的二次备注");
  await update({ notes: "家人二次备注", quantity: 9 });
  await detail.getByRole("button", { name: "保存资料", exact: true }).click(); await detail.getByRole("radio", { name: "备注：保留我的修改", exact: true }).waitFor();
  check("同字段冲突在逐项选择前不能继续", !await detail.getByRole("button", { name: "核对后继续编辑", exact: true }).isEnabled());
  await detail.getByRole("radio", { name: "备注：使用最新值", exact: true }).check();
  check("选择最新值会即时更新编辑区", await detail.getByLabel("备注", { exact: true }).inputValue() === "家人二次备注");
  await detail.getByRole("radio", { name: "备注：保留我的修改", exact: true }).check();
  await page.screenshot({ path: path.join(shots, "01-field-review-mobile.png"), fullPage: true });
  await detail.getByRole("button", { name: "核对后继续编辑", exact: true }).click();
  await detail.getByRole("button", { name: "保存资料", exact: true }).click(); await detail.getByText("资料已保存", { exact: true }).waitFor();
  check("明确选择后只保存我的冲突字段", (await getItem()).notes === "我的二次备注" && (await getItem()).quantity === 9);

  await detail.getByRole("button", { name: "编辑资料", exact: true }).click(); await detail.getByLabel("备注", { exact: true }).fill("查看照片时的草稿");
  await detail.getByRole("button", { name: "查看照片", exact: true }).click();
  const viewer = page.getByRole("dialog", { name: "相机照片查看", exact: true });
  await viewer.getByRole("button", { name: "放大", exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('.photo-viewer img')?.naturalWidth > 0);
  const fullImage = viewer.getByRole("img", { name: "相机原图", exact: true });
  check("全屏使用有会话鉴权的原图", (await fullImage.getAttribute("src")).includes(`/api/items/${item.id}/photo`) && !(await fullImage.getAttribute("src")).includes("thumbnail"));
  const anonymous = await browser.newContext(); check("未登录无法读取同一原图", (await anonymous.request.get(new URL(await fullImage.getAttribute("src"), base).href)).status() === 401); await anonymous.close();
  await viewer.getByRole("button", { name: "放大", exact: true }).click();
  check("按钮放大图片", await viewer.getByLabel("缩放比例").textContent() === "150%");
  await page.keyboard.press("+"); check("键盘可以继续放大", await viewer.getByLabel("缩放比例").textContent() === "200%");
  await viewer.getByRole("button", { name: "重置缩放", exact: true }).click();
  const stage = viewer.getByLabel("照片缩放区域"), box = await stage.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
  const cdp = await context.newCDPSession(page);
  const touch = async (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([id, px, py]) => ({ id, x: px, y: py, radiusX: 1, radiusY: 1, force: 1 })) });
  await touch("touchStart", [[1, x - 45, y], [2, x + 45, y]]);
  await touch("touchMove", [[1, x - 85, y], [2, x + 85, y]]);
  await touch("touchEnd", []);
  check("手机双指可放大原图", Number((await viewer.getByLabel("缩放比例").textContent()).replace("%", "")) > 150);
  const beforePan = await fullImage.getAttribute("style");
  await touch("touchStart", [[1, x, y]]); await touch("touchMove", [[1, x + 35, y]]); await touch("touchEnd", []);
  check("放大后可单指拖动查看", await fullImage.getAttribute("style") !== beforePan);
  await page.screenshot({ path: path.join(shots, "02-photo-zoom-mobile.png"), fullPage: true });
  let discardPrompt = false; const dismiss = async dialog => { discardPrompt = true; await dialog.dismiss(); }; page.on("dialog", dismiss);
  await page.keyboard.press("Escape"); await viewer.waitFor({ state: "hidden" }); page.off("dialog", dismiss);
  check("Esc只关闭照片并保留草稿", !discardPrompt && await detail.getByLabel("备注", { exact: true }).inputValue() === "查看照片时的草稿");
  check("关闭照片恢复到原按钮焦点", await detail.getByRole("button", { name: "查看照片", exact: true }).evaluate(button => button === document.activeElement));
  check("手机内容没有横向溢出", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check("没有未处理浏览器异常", errors.length === 0);
  await writeFile(path.join(shots, "results.json"), JSON.stringify({ checks, errors, runDir }, null, 2));
} catch (error) { console.error(error); await page?.screenshot({ path: path.join(shots, "failure.png"), fullPage: true }).catch(() => {}); if (page) await writeFile(path.join(shots, "failure.html"), await page.content()).catch(() => {}); process.exitCode = 1; }
finally { await browser?.close(); backend.kill(); }
