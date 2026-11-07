import { availableTestPort, pythonExecutable, chromeLaunchOptions } from "./env.mjs";
import { chromium } from "../../frontend/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const testRoot = fileURLToPath(new URL("../", import.meta.url));
const project = path.resolve(testRoot, "..");
const runDir = await mkdtemp(path.join(testRoot, ".e2e-usability-"));
const shots = path.join(testRoot, "e2e/shots/usability");
await mkdir(shots, { recursive: true });
const port = await availableTestPort();
const origin = `http://127.0.0.1:${port}`;
const basePath = process.env.WUWEI_E2E_BASE_PATH || "";
const base = origin + basePath;
const backend = spawn(pythonExecutable(project), ["-B", "-m", "uvicorn", "app.main:app", "--app-dir", path.join(project, "backend"), "--host", "127.0.0.1", "--port", String(port)], {
  cwd: testRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, WUWEI_DATA_DIR: runDir, WUWEI_STATIC_DIR: process.env.WUWEI_E2E_STATIC_DIR || path.join(project, "frontend/dist"), WUWEI_BASE_PATH: basePath, WUWEI_ALLOWED_ORIGINS: origin, WUWEI_SECURE_COOKIES: "0" },
});
let serverLog = "";
backend.stderr.on("data", data => { serverLog += data; });
let browser, page;
const checks = [], errors = [], listRequests = [];
function check(name, condition = true) { assert.ok(condition, name); checks.push(name); console.log(`PASS ${name}`); }
async function fullyVisible(locator) {
  return locator.evaluate(element => {
    const box = element.getBoundingClientRect();
    return box.top >= 0 && box.left >= 0 && box.bottom <= window.innerHeight + 1 && box.right <= window.innerWidth + 1;
  });
}

try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(ready, serverLog);
  browser = await chromium.launch(chromeLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const api = context.request;
  const token = (await readFile(path.join(runDir, "setup-token"), "utf8")).trim();
  assert.equal((await api.post(`${base}/api/setup`, { data: { token, household_name: "日常体验测试", username: "owner", password: "usability-fixture-2026" } })).status(), 201);
  async function createRoom(name) {
    const response = await api.post(`${base}/api/rooms`, { data: { name, width_cm: 460, depth_cm: 360, height_cm: 260 } });
    assert.equal(response.status(), 201); return (await response.json()).room;
  }
  async function createCabinet(room, name) {
    const response = await api.post(`${base}/api/containers`, { data: { room_id: room.id, preset: "wardrobe", name, x_cm: 150, z_cm: 60, width_cm: 100, depth_cm: 50, height_cm: 200, config: { layers: 2, cols: 1 } } });
    assert.equal(response.status(), 201); return (await response.json()).container;
  }
  async function register(compartmentId, prefix, count, operationId) {
    const response = await api.post(`${base}/api/items/batch`, { data: { compartment_id: compartmentId, names: Array.from({ length: count }, (_, i) => `${prefix}${String(i + 1).padStart(2, "0")}`), operation_id: operationId } });
    assert.equal(response.status(), 201); return (await response.json()).items;
  }
  const bedroom = await createRoom("主卧"), study = await createRoom("书房");
  const wardrobe = await createCabinet(bedroom, "衣柜"), bookcase = await createCabinet(study, "书柜");
  const bedroomItems = await register(wardrobe.compartments[0].id, "卧室物品", 60, "seed-bedroom");
  const studyItems = await register(bookcase.compartments[0].id, "书房物品", 26, "seed-study");
  for (const item of [...bedroomItems.slice(0, 45), ...studyItems.slice(0, 10)]) {
    assert.equal((await api.post(`${base}/api/items/${item.id}/missing`, { data: { expected_version: item.version } })).status(), 200);
  }

  page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.endsWith("/api/items")) listRequests.push(Object.fromEntries(url.searchParams));
  });
  const imageData = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 1600; canvas.height = 1200;
    const paint = canvas.getContext("2d"), gradient = paint.createLinearGradient(0, 0, 1600, 1200);
    gradient.addColorStop(0, "#dfab71"); gradient.addColorStop(1, "#628ba7"); paint.fillStyle = gradient; paint.fillRect(0, 0, 1600, 1200);
    paint.fillStyle = "#fff"; paint.font = "bold 100px sans-serif"; paint.fillText("Synthetic inventory photo", 80, 600);
    return canvas.toDataURL("image/jpeg", .9).split(",")[1];
  });
  const firstItem = (await (await api.get(`${base}/api/items/${bedroomItems[0].id}`)).json()).item;
  const upload = await api.post(`${base}/api/items/${firstItem.id}/photo`, { multipart: { expected_version: String(firstItem.version), image: { name: "synthetic.jpg", mimeType: "image/jpeg", buffer: Buffer.from(imageData, "base64") } } });
  assert.equal(upload.status(), 200);
  const picturedItem = (await upload.json()).item;

  await page.goto(`${base}/find`);
  await page.getByText("第 1–40 条，共 86 条", { exact: true }).waitFor();
  const firstCard = page.getByRole("button", { name: `查看${picturedItem.name}`, exact: true });
  await firstCard.waitFor();
  check("390px首屏搜索、拍照登记及首条物品完整可见", await fullyVisible(page.getByRole("searchbox")) && await fullyVisible(page.getByRole("button", { name: "拍照登记", exact: true })) && await fullyVisible(page.locator(".inventory-grid .inventory-item").first()));
  check("手机首页无横向溢出", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    const layout = await page.evaluate(() => {
      const tabs = document.querySelector('.inventory-status-tabs').getBoundingClientRect();
      const label = document.querySelector('.inventory-room-filter>span').getBoundingClientRect();
      const select = document.querySelector('[aria-label="筛选房间"]').getBoundingClientRect();
      return { tabsBottom: tabs.bottom, selectTop: select.top, selectWidth: select.width, labelHeight: label.height,
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1 };
    });
    check(`${width}px状态标签独占一行且房间筛选文字宽度足够`, layout.selectTop >= layout.tabsBottom && layout.selectWidth >= 104 && layout.labelHeight <= 22 && !layout.overflow);
    await page.screenshot({ path: path.join(shots, `mobile-${width}-filters.png`), fullPage: false });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  check("日常首页只请求40条并显示总匹配数", await page.locator(".inventory-grid .inventory-item").count() === 40 && listRequests[0].page === "1" && listRequests[0].page_size === "40");
  await page.screenshot({ path: path.join(shots, "01-mobile-first-screen.png"), fullPage: false });

  check("刷新导出和桌面入口默认收进更多", await page.getByRole("button", { name: "刷新清单", exact: true }).count() === 0 && await page.getByRole("button", { name: "导出清单", exact: true }).count() === 0 && await page.getByRole("button", { name: "添加到手机桌面", exact: true }).count() === 0);
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: "添加到手机桌面", exact: true }).waitFor();
  await page.getByRole("button", { name: "更多", exact: true }).click();

  const thumb = firstCard.locator("img");
  await thumb.scrollIntoViewIfNeeded();
  await thumb.evaluate(image => image.decode());
  const thumbDimensions = await thumb.evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight, src: image.getAttribute("src") }));
  check("列表使用不超过320px的鉴权缩略图", thumbDimensions.src.includes("variant=thumbnail") && Math.max(thumbDimensions.width, thumbDimensions.height) === 320);
  await firstCard.click();
  const detail = page.getByRole("dialog", { name: picturedItem.name, exact: true });
  await detail.getByRole("img", { name: picturedItem.name, exact: true }).evaluate(image => image.decode());
  const originalDimensions = await detail.getByRole("img", { name: picturedItem.name, exact: true }).evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight, src: image.getAttribute("src") }));
  check("详情保留原照片而非缩略图", !originalDimensions.src.includes("variant=thumbnail") && Math.max(originalDimensions.width, originalDimensions.height) === 1600);
  await detail.getByRole("button", { name: "关闭对话框", exact: true }).click();
  const guest = await browser.newContext();
  check("原照片和已生成的缩略图均拒绝匿名访问", (await guest.request.get(new URL(thumbDimensions.src, origin).href)).status() === 401 && (await guest.request.get(new URL(originalDimensions.src, origin).href)).status() === 401);
  await guest.close();

  await page.getByRole("button", { name: "批量整理", exact: true }).click();
  await page.getByRole("button", { name: "全选当前页", exact: true }).click();
  await page.getByText("已选 40 条", { exact: true }).waitFor();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page.getByText("第 41–80 条，共 86 条", { exact: true }).waitFor();
  check("切换40条分页清空本页选择", await page.getByText("已选 0 条", { exact: true }).isVisible() && await page.getByRole("checkbox", { checked: true }).count() === 0 && await page.getByRole("button", { name: "批量归档", exact: true }).isDisabled());
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page.getByText("第 81–86 条，共 86 条", { exact: true }).waitFor();
  check("末页仅六条且下一页不可用", await page.locator(".inventory-grid .inventory-item").count() === 6 && await page.getByRole("button", { name: "下一页", exact: true }).isDisabled());
  await page.getByRole("button", { name: "退出批量整理", exact: true }).click();

  await page.getByRole("combobox", { name: "筛选房间", exact: true }).selectOption(bedroom.id);
  await page.getByRole("button", { name: "待找回", exact: true }).click();
  await page.getByText("第 1–40 条，共 45 条", { exact: true }).waitFor();
  check("待找回与房间筛选组合并重置页码", listRequests.at(-1).status === "active" && listRequests.at(-1).location_status === "missing" && listRequests.at(-1).room_id === bedroom.id && listRequests.at(-1).page === "1");
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page.getByText("第 41–45 条，共 45 条", { exact: true }).waitFor();
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: "导出清单", exact: true }).click();
  const exporting = page.getByRole("dialog", { name: "导出清单", exact: true });
  await exporting.getByText("导出当前筛选的全部匹配记录，不仅是当前页。", { exact: true }).waitFor();
  await exporting.getByLabel("文件格式", { exact: true }).selectOption("json");
  const exportRequest = page.waitForRequest(request => request.method() === "POST" && request.url().endsWith("/api/inventory/export"));
  await exporting.getByRole("button", { name: "生成导出文件", exact: true }).click();
  const sent = (await exportRequest).postDataJSON();
  const downloadEvent = page.waitForEvent("download");
  await exporting.getByRole("link", { name: "下载 JSON 清单", exact: true }).click();
  const download = await downloadEvent, output = path.join(runDir, "filtered-missing-bedroom.json");
  await download.saveAs(output);
  const exported = JSON.parse(await readFile(output, "utf8"));
  const expectedIds = new Set(bedroomItems.slice(0, 45).map(item => item.id));
  check("筛选JSON导出全部45条而非当前页5条", exported.item_count === 45 && exported.items.length === 45 && exported.items.every(item => expectedIds.has(item.id) && item.location_status === "missing") && sent.room_id === bedroom.id && sent.location_status === "missing" && !("page" in sent) && !("page_size" in sent));
  check("手机导出弹窗无横向溢出", await exporting.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
  await page.screenshot({ path: path.join(shots, "02-filtered-export.png"), fullPage: false });
  await exporting.getByRole("button", { name: "关闭对话框", exact: true }).click();

  await page.goto(`${base}/find?compartment=${wardrobe.compartments[0].id}`);
  await page.getByText("第 1–40 条，共 60 条", { exact: true }).waitFor();
  await page.getByRole("combobox", { name: "筛选房间", exact: true }).selectOption(study.id);
  await page.waitForURL(url => !url.searchParams.has("compartment"));
  await page.getByText("第 1–26 条，共 26 条", { exact: true }).waitFor();
  check("跨房间筛选清旧隔层并保留新房间选择", await page.getByRole("combobox", { name: "筛选房间", exact: true }).inputValue() === study.id && !listRequests.at(-1).compartment_id && listRequests.at(-1).room_id === study.id);
  await page.getByRole("button", { name: "待找回", exact: true }).click();
  await page.getByText("第 1–10 条，共 10 条", { exact: true }).waitFor();
  await page.getByRole("button", { name: "已归档", exact: true }).click();
  await page.getByText("第 0–0 条，共 0 条", { exact: true }).waitFor();
  check("归档状态清空并禁用房间筛选", await page.getByRole("combobox", { name: "筛选房间", exact: true }).inputValue() === "" && await page.getByRole("combobox", { name: "筛选房间", exact: true }).isDisabled() && !listRequests.at(-1).room_id && !listRequests.at(-1).location_status);
  await page.screenshot({ path: path.join(shots, "03-mobile-archived.png"), fullPage: false });
  check("没有未处理浏览器错误", errors.length === 0);
  await writeFile(path.join(shots, "results.json"), JSON.stringify({ checks, errors, runDir, listRequests, thumbnail: thumbDimensions, original: originalDimensions, exportCount: exported.item_count }, null, 2));
} catch (error) {
  console.error(error);
  await page?.screenshot({ path: path.join(shots, "failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close(); backend.kill();
}
