import QRCode from "qrcode";

export type LocationEntrance = { id: "current" | "tailnet" | "public"; label: string; origin: string };
const DEPLOYED_HOST = "bd-a.tail3c54de.ts.net";

export function locationEntrances(currentOrigin: string): LocationEntrance[] {
  const current = new URL(currentOrigin);
  const options: LocationEntrance[] = [{ id: "current", label: "当前入口", origin: current.origin }];
  if (current.hostname === DEPLOYED_HOST) options.push(
    { id: "tailnet", label: "Tailscale 内网（已连接设备）", origin: `https://${DEPLOYED_HOST}` },
    { id: "public", label: "公网（无需 Tailscale）", origin: `https://${DEPLOYED_HOST}:8443` },
  );
  return options;
}

export function locationUrl({ origin, basePath, containerId, compartmentId }: {
  origin: string; basePath: string; containerId: string; compartmentId?: string;
}): string {
  const entry = new URL(origin);
  if (!["https:", "http:"].includes(entry.protocol) || !containerId) throw new Error("位置地址无效");
  const base = basePath.replace(/\/+$/, "");
  if ((base && !base.startsWith("/")) || /[?#]/.test(base)) throw new Error("应用路径无效");
  const url = new URL(`${base}/location/${encodeURIComponent(containerId)}`, entry.origin);
  if (compartmentId !== undefined) url.searchParams.set("compartment", compartmentId);
  return url.href;
}

function escapeXml(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function lines(value: string, length: number, maximum: number): string[] {
  const characters = Array.from(value);
  const result: string[] = [];
  for (let i = 0; i < characters.length && result.length < maximum; i += length) {
    const last = result.length === maximum - 1;
    result.push(characters.slice(i, i + length).join("") + (last && i + length < characters.length ? "…" : ""));
  }
  return result;
}

export async function createLocationLabel(url: string, name: string, description: string): Promise<{ svg: string; dataUrl: string }> {
  // The QR writer supplies the full encoded symbol and quiet zone. Text below it
  // is a printable caption; location resolution always uses IDs in the URL.
  const qr = await QRCode.toString(url, { type: "svg", width: 320, margin: 4, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } });
  const title = lines(name, 17, 4);
  const context = lines(description, 25, 3);
  const height = 436 + title.length * 25 + context.length * 19;
  const titleSvg = title.map((line, index) => `<text x="200" y="${398 + index * 25}" font-size="21" font-weight="600">${escapeXml(line)}</text>`).join("");
  const contextSvg = context.map((line, index) => `<text x="200" y="${408 + title.length * 25 + index * 19}" font-size="14" fill="#555555">${escapeXml(line)}</text>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="${height}" viewBox="0 0 400 ${height}">
<rect width="400" height="${height}" fill="#ffffff"/>
<g font-family="sans-serif" text-anchor="middle" fill="#17251f"><text x="200" y="32" font-size="16">物位 · 位置标签</text></g>
${qr.replace(/<svg\b/, '<svg x="40" y="48"')}
<g font-family="sans-serif" text-anchor="middle" fill="#17251f">${titleSvg}${contextSvg}<text x="200" y="${height - 16}" font-size="12" fill="#555555">扫码后登录，查看当前位置</text></g>
</svg>`;
  return { svg, dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` };
}
