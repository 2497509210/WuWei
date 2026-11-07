import path from "node:path";
import { existsSync } from "node:fs";
import net from "node:net";
import { randomInt } from "node:crypto";

// Some Windows hosts allocate port 0 inside the browser-blocked IRC range.
// Use an available high port so fetch and the browser can both reach the fixture.
export async function availableTestPort() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const port = randomInt(20_000, 60_000);
    const server = net.createServer();
    try {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      return port;
    } catch (error) {
      if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
    }
  }
  throw new Error("Unable to reserve a browser-accessible local test port");
}

export function pythonExecutable(project) {
  return process.env.WUWEI_TEST_PYTHON || path.join(project, process.platform === "win32" ? "backend/.venv/Scripts/python.exe" : "backend/.venv/bin/python");
}

export function chromeLaunchOptions() {
  const configured = process.env.WUWEI_TEST_CHROME;
  const windowsChrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
  const executablePath = configured || (process.platform === "win32" && existsSync(windowsChrome) ? windowsChrome : undefined);
  return { ...(executablePath ? { executablePath } : {}), headless: true, args: ["--enable-unsafe-swiftshader"] };
}

export async function launchTestBrowser() {
  const engine = process.env.WUWEI_TEST_BROWSER || "chromium";
  if (!["chromium", "webkit"].includes(engine)) {
    throw new Error(`Unsupported WUWEI_TEST_BROWSER: ${engine}; expected chromium or webkit`);
  }
  const { chromium, webkit } = await import("../../frontend/node_modules/playwright/index.mjs");
  const browser = engine === "webkit"
    ? await webkit.launch({ headless: true })
    : await chromium.launch(chromeLaunchOptions());
  return { browser, engine };
}
