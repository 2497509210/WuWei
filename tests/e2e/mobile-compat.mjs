// The same user-visible contract runs in real Chromium and WebKit engines.
// Catches broken file decoding, native dialogs/history, downloads and mobile layout.
// Device viewport/touch emulation does not claim physical camera or iOS coverage.
import { availableTestPort, pythonExecutable, launchTestBrowser } from "./env.mjs";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomFillSync } from "node:crypto";
import path from "node:path";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { PNG } = require("pngjs");
const testRoot = fileURLToPath(new URL("../", import.meta.url)), project = path.resolve(testRoot, "..");
const engineName = process.env.WUWEI_TEST_BROWSER || "chromium";
const runDir = await mkdtemp(path.join(testRoot, `.e2e-mobile-${engineName}-`));
const shots = path.join(testRoot, "e2e/shots/mobile-compat", engineName);
await mkdir(shots, { recursive: true });
const port = await availableTestPort();
const origin = `http://127.0.0.1:${port}`, basePath = process.env.WUWEI_E2E_BASE_PATH || "", base = origin + basePath;
const backend = spawn(pythonExecutable(project), ["-B", "-m", "uvicorn", "app.main:app", "--app-dir", path.join(project, "backend"), "--host", "127.0.0.1", "--port", String(port), "--no-access-log"], {
  cwd: testRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, WUWEI_DATA_DIR: runDir, WUWEI_STATIC_DIR: process.env.WUWEI_E2E_STATIC_DIR || path.join(project, "frontend/dist"), WUWEI_BASE_PATH: basePath, WUWEI_ALLOWED_ORIGINS: origin, WUWEI_SECURE_COOKIES: "0" },
});
let serverLog = "", browser, page, width;
backend.stderr.on("data", data => { serverLog += data; });
const checks = [], errors = [], notVerified = [];
function check(name, condition = true) {
  assert.ok(condition, `${engineName} ${width}px ${name}`);
  checks.push({ width, name }); console.log(`PASS ${engineName} ${width ?? "setup"} ${name}`);
}
async function range(value) { await page.getByText(value, { exact: true }).waitFor(); }
async function assertFits() {
  check("页面无横向溢出", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
}

try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(ready, serverLog);
  const launched = await launchTestBrowser(); browser = launched.browser;
  assert.equal(launched.engine, engineName);
  console.log(`ENGINE ${launched.engine} ${browser.version()}`);
  const setup = await browser.newContext(), api = setup.request;
  const token = (await readFile(path.join(runDir, "setup-token"), "utf8")).trim();
  assert.equal((await api.post(`${base}/api/setup`, { data: { token, household_name: "移动兼容测试", username: "owner", password: "mobile-fixture-2026" } })).status(), 201);
  const roomResponse = await api.post(`${base}/api/rooms`, { data: { name: "兼容书房", width_cm: 460, depth_cm: 360, height_cm: 260 } });
  assert.equal(roomResponse.status(), 201); const room = (await roomResponse.json()).room;
  const cabinetResponse = await api.post(`${base}/api/containers`, { data: { room_id: room.id, preset: "drawer_unit", name: "手机抽屉柜", x_cm: 150, z_cm: 60, width_cm: 100, depth_cm: 50, height_cm: 80, config: { layers: 2, cols: 1 } } });
  assert.equal(cabinetResponse.status(), 201); const cabinet = (await cabinetResponse.json()).container, slot = cabinet.compartments[0];
  const batch = await api.post(`${base}/api/items/batch`, { data: { compartment_id: slot.id, names: Array.from({ length: 45 }, (_, i) => `手机核对物品${String(i + 1).padStart(2, "0")}`), operation_id: "mobile-seed" } });
  assert.equal(batch.status(), 201);
  for (const item of (await batch.json()).items) {
    assert.equal((await api.post(`${base}/api/items/${item.id}/missing`, { data: { expected_version: item.version } })).status(), 200);
  }
  const png = new PNG({ width: 1800, height: 1800 }); randomFillSync(png.data);
  for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
  const photo = PNG.sync.write(png); assert.ok(photo.length > 8 * 1024 * 1024);

  for (width of [390, 360]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
    page = await context.newPage(); page.setDefaultTimeout(15_000);
    page.on("pageerror", error => errors.push({ width, message: error.message }));
    await page.goto(`${base}/find`);
    await page.getByLabel("用户名", { exact: true }).fill("owner");
    await page.getByLabel("密码", { exact: true }).fill("mobile-fixture-2026");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("heading", { name: "家庭找物", exact: true }).waitFor();
    check("独立浏览器会话通过真实登录表单进入清单", (await context.request.get(`${base}/api/me`)).ok());
    await assertFits();

    await page.getByRole("searchbox").fill("手机核对");
    await page.getByRole("button", { name: "待找回", exact: true }).click();
    await page.getByRole("combobox", { name: "筛选房间" }).selectOption(room.id);
    await range("第 1–40 条，共 45 条");
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await range("第 41–45 条，共 45 条");
    await page.reload(); await range("第 41–45 条，共 45 条");
    check("刷新恢复搜索房间状态和分页", await page.getByRole("searchbox").inputValue() === "手机核对" && await page.getByRole("combobox", { name: "筛选房间" }).inputValue() === room.id && await page.getByRole("button", { name: "待找回", exact: true }).getAttribute("aria-pressed") === "true");
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.getByRole("button", { name: "导出清单", exact: true }).click();
    const exportDialog = page.getByRole("dialog", { name: "导出清单", exact: true });
    const exportResponse = page.waitForResponse(response => response.url().endsWith("/api/inventory/export") && response.request().method() === "POST");
    await exportDialog.getByRole("button", { name: "生成导出文件", exact: true }).click();
    const generatedFile = await exportResponse;
    const downloaded = page.waitForEvent("download");
    await exportDialog.getByRole("link", { name: "下载 CSV 清单", exact: true }).click();
    const download = await downloaded, csvFile = path.join(runDir, `inventory-${width}.csv`);
    let csv, downloadedToDisk = true;
    try { await download.saveAs(csvFile); csv = await readFile(csvFile, "utf8"); }
    catch (error) {
      // Windows WebKit also cancels downloads on a standalone native Blob link.
      // Linux CI remains strict: this exception never skips its actual download.
      if (process.platform !== "win32" || engineName !== "webkit" || await download.failure() !== "Load request cancelled") throw error;
      downloadedToDisk = false;
      const limitation = { width, name: "Windows WebKit Blob下载落盘和文件字节", reason: "Load request cancelled；原生空白页Blob链接同样复现，需Linux CI及真机下载核验" };
      notVerified.push(limitation); console.log(`NOT VERIFIED ${JSON.stringify(limitation)}`);
      csv = (await generatedFile.body()).toString("utf8");
    }
    assert.ok(download.suggestedFilename().endsWith(".csv"), `下载名称：${download.suggestedFilename()}`);
    if (downloadedToDisk) assert.equal(csv.charCodeAt(0), 0xfeff, "CSV保留UTF-8 BOM");
    assert.equal(csv.split(/\r?\n/).filter(line => line.includes("手机核对物品")).length, 45, "CSV包含全部45条");
    assert.ok(csv.includes("兼容书房 / 手机抽屉柜"), csv.slice(0, 800));
    check(downloadedToDisk ? "CSV真实下载保留中文及全部45条筛选记录" : "CSV响应内容正确（此平台未验证落盘）");
    await exportDialog.getByRole("button", { name: "关闭对话框" }).click();

    await page.getByRole("button", { name: "拍照登记", exact: true }).click();
    const quick = page.getByRole("dialog", { name: "拍照登记", exact: true });
    await quick.getByLabel("房间", { exact: true }).selectOption(room.id);
    await quick.getByLabel("容器", { exact: true }).selectOption(cabinet.id);
    await quick.getByRole("button", { name: slot.name, exact: true }).click();
    await quick.getByLabel("拍摄或选择照片", { exact: true }).setInputFiles({ name: "synthetic-mobile.png", mimeType: "image/png", buffer: photo });
    await quick.getByRole("img", { name: "待登记照片预览", exact: true }).waitFor();
    const previewSize = await quick.getByRole("img", { name: "待登记照片预览", exact: true }).evaluate(async img => { await img.decode(); return { width: img.naturalWidth, height: img.naturalHeight }; });
    check("超过8MiB合成照片在本机压缩且可解码预览", await quick.getByText(/已压缩/).isVisible() && previewSize.width === 1600 && previewSize.height === 1600);
    const name = `手机相机${width}`;
    await quick.getByLabel("物品名称", { exact: true }).fill(name);
    // Fail only the network boundary. The form, multipart body and retry remain real.
    await page.route("**/api/items/quick", route => route.abort("failed"), { times: 1 });
    await quick.getByRole("button", { name: "保存物品", exact: true }).click();
    await quick.getByRole("alert").waitFor();
    check("上传网络失败保留名称位置与照片", await quick.getByLabel("物品名称", { exact: true }).inputValue() === name && await quick.getByRole("button", { name: slot.name, exact: true }).getAttribute("aria-pressed") === "true" && await quick.getByRole("img", { name: "待登记照片预览" }).isVisible());
    await quick.getByRole("button", { name: "保存物品", exact: true }).click(); await quick.waitFor({ state: "hidden" });
    const saved = (await (await api.get(`${base}/api/items?q=${encodeURIComponent(name)}`)).json()).items;
    check("重试保存只创建一件并关联照片", saved.length === 1 && Boolean(saved[0].photo_url) && saved[0].compartment_id === slot.id);
    await page.getByRole("button", { name: "查看刚登记物品", exact: true }).click();
    const detail = page.getByRole("dialog", { name, exact: true });
    await detail.getByRole("button", { name: "编辑资料", exact: true }).click();
    await detail.getByLabel("备注", { exact: true }).fill("手机上未保存的备注");
    page.once("dialog", dialog => dialog.dismiss());
    await detail.getByRole("button", { name: "关闭对话框" }).click();
    check("取消关闭保留草稿", await detail.getByLabel("备注", { exact: true }).inputValue() === "手机上未保存的备注");

    await detail.getByRole("button", { name: "查看照片", exact: true }).click();
    const viewer = page.getByRole("dialog", { name: `${name}照片查看`, exact: true });
    await viewer.getByRole("button", { name: "放大", exact: true }).click();
    check("全屏原图按钮放大", await viewer.getByLabel("缩放比例").textContent() === "150%");
    await page.keyboard.press("+");
    check("原图键盘缩放", await viewer.getByLabel("缩放比例").textContent() === "200%");
    await page.keyboard.press("0");
    check("缩放可重置", await viewer.getByLabel("缩放比例").textContent() === "100%");
    await page.screenshot({ path: path.join(shots, `photo-${width}.png`), fullPage: true });
    await page.keyboard.press("Escape"); await viewer.waitFor({ state: "hidden" });
    check("关闭全屏保留父表单与焦点", await detail.getByLabel("备注", { exact: true }).inputValue() === "手机上未保存的备注" && await detail.getByRole("button", { name: "查看照片", exact: true }).evaluate(button => button === document.activeElement));

    // Simulates lifecycle signals; real device background suspension is a manual check.
    await context.setOffline(true); await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await detail.getByText(/清单可能已有更新/).waitFor();
    check("恢复联网不会覆盖编辑草稿", await detail.getByLabel("备注", { exact: true }).inputValue() === "手机上未保存的备注");
    await page.clock.setFixedTime(new Date(Date.now() + 61_000));
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      delete document.visibilityState;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    check("可见性恢复信号保留草稿及延期核验提示", await detail.getByLabel("备注", { exact: true }).inputValue() === "手机上未保存的备注" && await detail.getByText(/清单可能已有更新/).isVisible());
    const leavePrompt = page.waitForEvent("dialog");
    await page.evaluate(() => history.back()); await (await leavePrompt).dismiss();
    await page.waitForURL(url => url.searchParams.get("page") === "2");
    check("取消浏览器后退保留详情草稿和原筛选", await detail.getByLabel("备注", { exact: true }).inputValue() === "手机上未保存的备注" && new URL(page.url()).searchParams.get("q") === "手机核对");
    await assertFits();
    await page.screenshot({ path: path.join(shots, `draft-${width}.png`), fullPage: true });
    page.once("dialog", dialog => dialog.accept());
    await detail.getByRole("button", { name: "关闭对话框" }).click(); await detail.waitFor({ state: "hidden" });
    await range("第 41–45 条，共 45 条");
    await context.close(); page = undefined;
  }
  check("无未处理浏览器脚本错误", errors.length === 0);
  await setup.close();
  await writeFile(path.join(shots, "results.json"), JSON.stringify({ engine: engineName, version: browser.version(), checks, errors, notVerified, runDir, inputBytes: photo.length }, null, 2));
} catch (error) {
  console.error(error);
  await page?.screenshot({ path: path.join(shots, `failure-${width ?? "setup"}.png`), fullPage: true }).catch(() => {});
  if (page) await writeFile(path.join(shots, `failure-${width ?? "setup"}.html`), await page.content()).catch(() => {});
  await writeFile(path.join(shots, "failure.json"), JSON.stringify({ checks, errors, error: String(error), serverLog }, null, 2));
  process.exitCode = 1;
} finally { await browser?.close(); backend.kill(); }
