import { availableTestPort, pythonExecutable, launchTestBrowser } from "./env.mjs";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const testRoot = fileURLToPath(new URL("../", import.meta.url)), project = path.resolve(testRoot, "..");
const runDir = await mkdtemp(path.join(testRoot, ".e2e-item-links-"));
const engineName = process.env.WUWEI_TEST_BROWSER || "chromium";
const shots = path.join(testRoot, `e2e/shots/item-links-${engineName}`); await mkdir(shots, { recursive: true });
const port = await availableTestPort();
const origin = `http://127.0.0.1:${port}`, basePath = process.env.WUWEI_E2E_BASE_PATH || "", base = origin + basePath;
const backend = spawn(pythonExecutable(project), ["-B", "-m", "uvicorn", "app.main:app", "--app-dir", path.join(project, "backend"), "--host", "127.0.0.1", "--port", String(port), "--no-access-log"], {
  cwd: testRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, WUWEI_DATA_DIR: runDir, WUWEI_STATIC_DIR: path.join(project, "frontend/dist"), WUWEI_BASE_PATH: basePath, WUWEI_ALLOWED_ORIGINS: origin, WUWEI_SECURE_COOKIES: "0" },
});
let log = "", browser, page; const checks = [], errors = [];
backend.stderr.on("data", data => { log += data; });
function check(name, value = true) { assert.ok(value, name); checks.push(name); console.log(`PASS ${name}`); }
async function login(target, username = "owner", password = "item-link-fixture-2026") {
  await target.getByLabel("用户名", { exact: true }).fill(username);
  await target.getByLabel("密码", { exact: true }).fill(password);
  await target.getByRole("button", { name: "登录", exact: true }).click();
}
try {
  let ready = false; for (let i = 0; i < 120; i++) { try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch {} await delay(100); } assert.ok(ready, log);
  const launched = await launchTestBrowser(); browser = launched.browser; assert.equal(launched.engine, engineName);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true }), api = context.request;
  const token = (await readFile(path.join(runDir, "setup-token"), "utf8")).trim();
  assert.equal((await api.post(`${base}/api/setup`, { data: { token, household_name: "物品链接测试", username: "owner", password: "item-link-fixture-2026" } })).status(), 201);
  const room = (await (await api.post(`${base}/api/rooms`, { data: { name: "书房", width_cm: 460, depth_cm: 360, height_cm: 260 } })).json()).room;
  const cabinet = (await (await api.post(`${base}/api/containers`, { data: { room_id: room.id, preset: "drawer_unit", name: "抽屉柜", x_cm: 150, z_cm: 60, width_cm: 100, depth_cm: 50, height_cm: 80, config: { layers: 2, cols: 1 } } })).json()).container;
  const items = (await (await api.post(`${base}/api/items/batch`, { data: { compartment_id: cabinet.compartments[0].id, names: ["共享相机", "旧证件袋"], operation_id: "link-seed" } })).json()).items;
  const item = items.find(item => item.name === "共享相机"), archived = items.find(item => item.name === "旧证件袋");
  assert.equal((await api.post(`${base}/api/items/${archived.id}/archive`, { data: { expected_version: archived.version, reason: "暂不使用" } })).status(), 200);
  const shared = `${base}/items/${item.id}`;
  const foreignFixture = spawnSync(pythonExecutable(project), ["-B", "-c", `import sqlite3,sys
from app.security import hash_password
db=sqlite3.connect(sys.argv[1])
db.execute("INSERT INTO households(id,name,created_at) VALUES ('foreign-home','Foreign fixture','2026-11-07')")
db.execute("INSERT INTO users(id,household_id,username,password_hash,display_name,role,created_at) VALUES ('foreign-user','foreign-home','foreign',?,'Foreign fixture','owner','2026-11-07')",(hash_password('foreign-fixture-2026'),))
db.commit();db.close()`, path.join(runDir, "wuwei.db")], { cwd: path.join(project, "backend"), windowsHide: true, encoding: "utf8" });
  assert.equal(foreignFixture.status, 0, foreignFixture.stderr);
  page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  const find = `${base}/find?q=${encodeURIComponent("共享")}`;
  await page.goto(find); await page.getByRole("button", { name: "查看共享相机", exact: true }).click();
  let detail = page.getByRole("dialog", { name: "共享相机", exact: true });
  await detail.getByRole("button", { name: "链接选项", exact: true }).click();
  check("物品链接只含当前入口部署路径和物品ID", await detail.getByLabel("物品链接", { exact: true }).inputValue() === shared);
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("fixture denied"); } } }));
  await detail.getByRole("button", { name: "复制物品链接", exact: true }).click();
  await detail.getByText("复制未成功，请长按或选中链接复制。", { exact: true }).waitFor();
  check("复制受限时提供已选中的手动复制地址", await detail.getByLabel("物品链接", { exact: true }).evaluate(input => input.selectionStart === 0 && input.selectionEnd === input.value.length));
  await page.goto(shared); detail = page.getByRole("dialog", { name: "共享相机", exact: true }); await detail.waitFor();
  await page.reload(); await detail.waitFor();
  check("已登录物品地址可直接打开并刷新", page.url() === shared);
  await detail.getByRole("button", { name: "关闭对话框" }).click();
  await page.waitForURL(find);
  check("关闭独立物品页返回原找物筛选");
  const anonymous = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const guest = await anonymous.newPage(); guest.on("pageerror", error => errors.push(error.message));
  await guest.goto(shared);
  check("未登录不展示物品内容", await guest.getByRole("dialog", { name: "共享相机" }).count() === 0 && (await anonymous.request.get(`${base}/api/items/${item.id}`)).status() === 401);
  await login(guest); await guest.getByRole("dialog", { name: "共享相机", exact: true }).waitFor();
  check("登录后回到原物品地址", guest.url() === shared);
  await anonymous.close();
  const foreign = await browser.newContext({ viewport: { width: 390, height: 844 } }), foreignPage = await foreign.newPage();
  foreignPage.on("pageerror", error => errors.push(error.message));
  await foreignPage.goto(shared); await login(foreignPage, "foreign", "foreign-fixture-2026");
  await foreignPage.getByRole("button", { name: "重新加载物品", exact: true }).waitFor();
  check("其他家庭登录后不能借链接读取物品", (await foreign.request.get(`${base}/api/items/${item.id}`)).status() === 404 && await foreignPage.getByRole("dialog").count() === 0 && !await foreignPage.getByText("共享相机", { exact: true }).count());
  await foreign.close();
  const invite = (await (await api.post(`${base}/api/household/invites`)).json()).code;
  const joining = await browser.newContext({ viewport: { width: 360, height: 780 } }), joinPage = await joining.newPage(); joinPage.on("pageerror", error => errors.push(error.message));
  await joinPage.goto(shared); await joinPage.getByRole("button", { name: "使用邀请码加入家庭", exact: true }).click();
  for (const [label, value] of [["邀请码", invite], ["用户名", "link-member"], ["昵称", "家人"], ["密码", "member-fixture-2026"], ["确认密码", "member-fixture-2026"]]) await joinPage.getByLabel(label, { exact: true }).fill(value);
  await joinPage.getByRole("button", { name: "加入家庭", exact: true }).click(); await joinPage.getByRole("dialog", { name: "共享相机", exact: true }).waitFor();
  check("通过邀请码加入后仍打开原共享物品", joinPage.url() === shared);
  await joining.close();
  await page.goto(`${base}/items/${archived.id}`); await page.getByRole("dialog", { name: "旧证件袋", exact: true }).waitFor();
  check("归档物品可通过原链接查看且不能直接编辑", await page.getByText("暂不使用", { exact: true }).isVisible() && await page.getByRole("button", { name: "编辑资料", exact: true }).count() === 0);
  await page.goto(`${base}/items/nonexistent`); await page.getByRole("button", { name: "重新加载物品", exact: true }).waitFor();
  check("不存在的物品明确报错且不残留上一件资料", await page.getByRole("dialog").count() === 0 && await page.getByText("暂不使用", { exact: true }).count() === 0);
  await page.goto(shared); detail = page.getByRole("dialog", { name: "共享相机", exact: true }); await detail.waitFor();
  assert.equal((await api.post(`${base}/api/account/logout-all`)).status(), 204);
  await page.reload(); await page.getByRole("button", { name: "登录", exact: true }).waitFor();
  await login(page); await detail.waitFor();
  check("会话失效后重新登录仍保留物品地址", page.url() === shared);
  await detail.getByRole("button", { name: "编辑资料", exact: true }).click(); await detail.getByLabel("备注", { exact: true }).fill("未提交的链接页草稿");
  page.once("dialog", prompt => prompt.dismiss()); await detail.getByRole("button", { name: "关闭对话框" }).click();
  check("独立链接页沿用草稿保护", await detail.getByLabel("备注", { exact: true }).inputValue() === "未提交的链接页草稿");
  await page.screenshot({ path: path.join(shots, "item-mobile.png"), fullPage: true });
  check("390px独立物品页无横向溢出", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check("没有未处理脚本异常", errors.length === 0);
  await writeFile(path.join(shots, "results.json"), JSON.stringify({ engine: launched.engine, checks, errors, runDir }, null, 2));
} catch (error) { console.error(error); await page?.screenshot({ path: path.join(shots, "failure.png"), fullPage: true }).catch(() => {}); process.exitCode = 1; }
finally { await browser?.close(); backend.kill(); }
