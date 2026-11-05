import path from "node:path";
import { existsSync } from "node:fs";

export function pythonExecutable(project) {
  return process.env.WUWEI_TEST_PYTHON || path.join(project, process.platform === "win32" ? "backend/.venv/Scripts/python.exe" : "backend/.venv/bin/python");
}

export function chromeLaunchOptions() {
  const configured = process.env.WUWEI_TEST_CHROME;
  const windowsChrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
  const executablePath = configured || (process.platform === "win32" && existsSync(windowsChrome) ? windowsChrome : undefined);
  return { ...(executablePath ? { executablePath } : {}), headless: true, args: ["--enable-unsafe-swiftshader"] };
}
