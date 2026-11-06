import { pythonExecutable, chromeLaunchOptions } from "./env.mjs";
import { chromium } from "../../frontend/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const testRoot = fileURLToPath(new URL("../", import.meta.url)), project = path.resolve(testRoot, "..");
const runDir = await mkdtemp(path.join(testRoot, ".e2e-form-guards-"));
const shots = path.join(testRoot, "e2e/shots/form-guards"); await mkdir(shots, { recursive: true });
const listener = net.createServer(); await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`, basePath = process.env.WUWEI_E2E_BASE_PATH || "", base = origin + basePath;
const backend = spawn(pythonExecutable(project), ["-B", "-m", "uvicorn", "app.main:app", "--app-dir", path.join(project, "backend"), "--host", "127.0.0.1", "--port", String(port), "--no-access-log"], {
  cwd: testRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, WUWEI_DATA_DIR: runDir, WUWEI_STATIC_DIR: process.env.WUWEI_E2E_STATIC_DIR || path.join(project, "frontend/dist"), WUWEI_BASE_PATH: basePath, WUWEI_ALLOWED_ORIGINS: origin, WUWEI_SECURE_COOKIES: "0" },
});
let log = "", browser, page; const checks = [], errors = [];
backend.stderr.on("data", data => { log += data; });
function check(name, value = true) { assert.ok(value, name); checks.push(name); console.log(`PASS ${name}`); }
async function confirmAction(action, accept = false) {
  const prompt = page.waitForEvent("dialog"); const pending = action();
  const dialog = await prompt; assert.equal(dialog.type(), "confirm");
  if (accept) await dialog.accept(); else await dialog.dismiss();
  await pending;
}
async function selectLocation(dialog, room, cabinet, compartment) {
  await dialog.getByRole("combobox", { name: "房间", exact: true }).selectOption(room.id);
  await dialog.getByRole("combobox", { name: "容器", exact: true }).selectOption(cabinet.id);
  await dialog.getByRole("button", { name: compartment.name, exact: true }).click();
}
try {
  let ready = false; for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch {} await delay(100); } assert.ok(ready, log);
  browser = await chromium.launch(chromeLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } }), api = context.request;
  const token = (await readFile(path.join(runDir, "setup-token"), "utf8")).trim();
  assert.equal((await api.post(`${base}/api/setup`, { data: { token, household_name: "表单保护测试", username: "owner", password: "form-guards-fixture-2026" } })).status(), 201);
  const room = (await (await api.post(`${base}/api/rooms`, { data: { name: "草稿书房", width_cm: 460, depth_cm: 360, height_cm: 260 } })).json()).room;
  const cabinet = (await (await api.post(`${base}/api/containers`, { data: { room_id: room.id, preset: "drawer_unit", name: "草稿抽屉柜", x_cm: 150, z_cm: 60, width_cm: 100, depth_cm: 50, height_cm: 80, config: { layers: 2, cols: 1 } } })).json()).container;
  const seeds = (await (await api.post(`${base}/api/items/batch`, { data: { compartment_id: cabinet.compartments[0].id, names: ["草稿护照", "草稿相机"], operation_id: "form-guard-seed" } })).json()).items;
  const passport = seeds.find(item => item.name === "草稿护照"), camera = seeds.find(item => item.name === "草稿相机");
  assert.ok(passport && camera);
  page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));

  await page.goto(`${base}/find`); await page.getByRole("button", { name: "空间", exact: true }).click();
  await page.getByRole("button", { name: "房间设置", exact: true }).click();
  await page.getByRole("button", { name: "编辑房间", exact: true }).click();
  const roomDialog = page.getByRole("dialog", { name: "编辑房间", exact: true });
  await roomDialog.getByLabel("房间名称", { exact: true }).fill("我未保存的房间名");
  await confirmAction(() => roomDialog.getByRole("button", { name: "取消", exact: true }).click());
  check("取消房间编辑时拒绝放弃会保留草稿", await roomDialog.getByLabel("房间名称", { exact: true }).inputValue() === "我未保存的房间名");
  await confirmAction(() => page.keyboard.press("Escape"));
  check("Escape保护房间草稿", await roomDialog.isVisible());
  await confirmAction(() => roomDialog.getByRole("button", { name: "关闭对话框" }).click());
  check("关闭按钮保护房间草稿", await roomDialog.getByLabel("房间名称", { exact: true }).inputValue() === "我未保存的房间名");
  await confirmAction(() => page.evaluate(() => history.back()));
  await page.waitForURL(url => url.pathname === basePath || url.pathname === `${basePath}/`);
  check("浏览器返回拒绝放弃时停留房间编辑", await roomDialog.getByLabel("房间名称", { exact: true }).inputValue() === "我未保存的房间名");
  const latestRoom = (await (await api.get(`${base}/api/rooms/${room.id}`)).json()).room;
  assert.equal((await api.patch(`${base}/api/rooms/${room.id}`, { data: { expected_version: latestRoom.version, name: "家人修改的书房" } })).status(), 200);
  await roomDialog.getByRole("button", { name: "保存房间", exact: true }).click();
  await roomDialog.getByRole("button", { name: "加载最新房间", exact: true }).waitFor();
  await confirmAction(() => roomDialog.getByRole("button", { name: "加载最新房间", exact: true }).click());
  check("拒绝重载房间时保留冲突草稿且不能盲目重试", await roomDialog.getByLabel("房间名称", { exact: true }).inputValue() === "我未保存的房间名" && !await roomDialog.getByRole("button", { name: "保存房间", exact: true }).isEnabled());
  await confirmAction(() => roomDialog.getByRole("button", { name: "加载最新房间", exact: true }).click(), true);
  await page.waitForFunction(() => document.querySelector(".room-editor input").value === "家人修改的书房");
  await roomDialog.getByLabel("房间名称", { exact: true }).fill("整理书房");
  await roomDialog.getByRole("button", { name: "保存房间", exact: true }).click(); await roomDialog.waitFor({ state: "hidden" });
  check("明确放弃旧稿后加载最新版本并正常保存", (await (await api.get(`${base}/api/rooms/${room.id}`)).json()).room.name === "整理书房");

  // Push a fresh find entry so native Back has an in-app destination.
  await page.getByRole("button", { name: "家庭找物", exact: true }).click();
  await page.getByRole("button", { name: "批量整理", exact: true }).click();
  await page.getByRole("checkbox", { name: "选择草稿护照", exact: true }).check();
  await page.getByRole("button", { name: "批量归档", exact: true }).click();
  const archive = page.getByRole("dialog", { name: "批量归档", exact: true });
  await archive.getByLabel("归档原因（选填）", { exact: true }).fill("这个原因还没保存");
  await confirmAction(() => archive.getByRole("button", { name: "关闭对话框" }).click());
  check("批量归档关闭保留原因和选择", await archive.getByLabel("归档原因（选填）", { exact: true }).inputValue() === "这个原因还没保存" && await archive.getByText("草稿护照", { exact: true }).isVisible());
  await confirmAction(() => page.keyboard.press("Escape"));
  check("Escape保护批量归档原因", await archive.isVisible());
  await confirmAction(() => page.evaluate(() => history.back()));
  await page.waitForURL(url => url.pathname === `${basePath}/find`);
  check("浏览器返回保护批量归档原因", await archive.getByLabel("归档原因（选填）", { exact: true }).inputValue() === "这个原因还没保存");

  // Commit on the server, withhold the first response, then stop waiting and retry the same operation.
  const requests = []; let releaseFirst, firstSaved;
  const held = new Promise(resolve => { releaseFirst = resolve; });
  const committed = new Promise(resolve => { firstSaved = resolve; });
  await page.route("**/api/items/actions/bulk", async route => {
    requests.push(route.request().postDataJSON());
    if (requests.length > 1) { await route.continue(); return; }
    const response = await route.fetch(); assert.equal(response.status(), 200); firstSaved();
    await held; await route.fulfill({ response }).catch(() => {});
  });
  await archive.getByRole("button", { name: "确认归档", exact: true }).click(); await committed;
  await archive.getByRole("button", { name: "停止等待", exact: true }).click();
  await archive.getByRole("alert").filter({ hasText: "尚未确认批量操作结果" }).waitFor();
  await confirmAction(() => archive.getByRole("button", { name: "关闭对话框" }).click());
  check("停止等待后关闭保护仍保留批量输入", await archive.getByLabel("归档原因（选填）", { exact: true }).inputValue() === "这个原因还没保存");
  releaseFirst();
  await archive.getByRole("button", { name: "确认归档", exact: true }).click(); await archive.waitFor({ state: "hidden" });
  const events = (await (await api.get(`${base}/api/items/${passport.id}/events`)).json()).events;
  check("保留草稿后重试沿用operation并只归档一次", requests.length === 2 && requests[0].operation_id === requests[1].operation_id && requests[1].reason === "这个原因还没保存" && events.filter(event => event.type === "archive").length === 1);
  await page.unroute("**/api/items/actions/bulk");

  await page.getByRole("checkbox", { name: "选择草稿相机", exact: true }).check();
  await page.getByRole("button", { name: "批量移动", exact: true }).click();
  const move = page.getByRole("dialog", { name: "批量移动", exact: true });
  await selectLocation(move, room, cabinet, cabinet.compartments[1]);
  await confirmAction(() => move.getByRole("button", { name: "关闭对话框" }).click());
  check("批量移动关闭保留已选目标", await move.getByRole("button", { name: cabinet.compartments[1].name, exact: true }).getAttribute("aria-pressed") === "true");
  await confirmAction(() => move.getByRole("button", { name: "关闭对话框" }).click(), true);
  check("明确放弃移动草稿不会移动物品", (await (await api.get(`${base}/api/items/${camera.id}`)).json()).item.compartment_id === cabinet.compartments[0].id);

  await page.getByRole("button", { name: "已归档", exact: true }).click();
  await page.getByRole("checkbox", { name: "选择草稿护照", exact: true }).check();
  await page.getByRole("button", { name: "批量恢复", exact: true }).click();
  const restore = page.getByRole("dialog", { name: "批量恢复", exact: true });
  await selectLocation(restore, room, cabinet, cabinet.compartments[1]);
  await confirmAction(() => page.keyboard.press("Escape"));
  check("批量恢复拒绝放弃保留已选目标", await restore.getByRole("button", { name: cabinet.compartments[1].name, exact: true }).getAttribute("aria-pressed") === "true");
  await restore.getByRole("button", { name: "确认恢复", exact: true }).click(); await restore.waitFor({ state: "hidden" });
  const restored = (await (await api.get(`${base}/api/items/${passport.id}`)).json()).item;
  check("批量恢复成功正常关闭并写入目标", restored.archived_at === null && restored.compartment_id === cabinet.compartments[1].id);
  check("手机页面没有横向溢出", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check("没有未处理浏览器异常", errors.length === 0);
  await writeFile(path.join(shots, "results.json"), JSON.stringify({ checks, errors, runDir }, null, 2));
} catch (error) {
  console.error(error); await page?.screenshot({ path: path.join(shots, "failure.png"), fullPage: true }).catch(() => {});
  if (page) await writeFile(path.join(shots, "failure.html"), await page.content()).catch(() => {}); process.exitCode = 1;
} finally { await browser?.close(); backend.kill(); }
