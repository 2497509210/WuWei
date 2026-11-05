import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createLocationLabel, locationEntrances, locationUrl } from "../../frontend/src/utils/locationLabel";

const require = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { Resvg } = require("@resvg/resvg-js");
const { PNG } = require("pngjs");
const jsQR = require("jsqr");

function decodeSvg(svg: string): string | undefined {
  const rendered = new Resvg(svg).render().asPng();
  const raster = PNG.sync.read(rendered);
  return jsQR(new Uint8ClampedArray(raster.data), raster.width, raster.height)?.data;
}

describe("stable location labels", () => {
  it("keeps the current origin and app base while encoding only stable location IDs", () => {
    expect(locationUrl({ origin: "https://home.example:9443", basePath: "/wuwei/", containerId: "box-one", compartmentId: "slot-two" }))
      .toBe("https://home.example:9443/wuwei/location/box-one?compartment=slot-two");
    expect(locationUrl({ origin: "http://192.168.1.80:5173", basePath: "/", containerId: "box-one" }))
      .toBe("http://192.168.1.80:5173/location/box-one");
  });

  it("offers internal and public entrance choices only on the exact deployed hostname", () => {
    expect(locationEntrances("http://192.168.1.80:5173").map(option => option.id)).toEqual(["current"]);
    expect(locationEntrances("https://bd-a.tail3c54de.ts.net.attacker.test").map(option => option.id)).toEqual(["current"]);
    expect(locationEntrances("https://bd-a.tail3c54de.ts.net:8443").map(option => option.origin))
      .toEqual(["https://bd-a.tail3c54de.ts.net:8443", "https://bd-a.tail3c54de.ts.net", "https://bd-a.tail3c54de.ts.net:8443"]);
  });

  // Decode the actual downloadable SVG through a different QR implementation;
  // checking only the encoded URL or QR writer arguments would miss broken labels.
  it.each(["https://bd-a.tail3c54de.ts.net", "https://bd-a.tail3c54de.ts.net:8443"])("decodes a generated SVG label for %s", async origin => {
    const link = locationUrl({ origin, basePath: "/wuwei/", containerId: "7c2ae139-6d4c-475a-a8c9-e00a19daa29c", compartmentId: "94ba1097-3d81-4d3b-85cd-73df2d526e9d" });
    const label = await createLocationLabel(link, "证件抽屉", "书房 / 白色衣柜");
    expect(decodeSvg(label.svg)).toBe(link);
    expect(label.dataUrl.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
  });

  it("escapes user-controlled names in the downloadable SVG", async () => {
    const label = await createLocationLabel("https://home.example/location/box", '<script>alert("name")</script>', '<image href="https://outside.test">');
    expect(label.svg).not.toContain("<script>");
    expect(label.svg).not.toContain('<image href="https://outside.test">');
    expect(decodeSvg(label.svg)).toBe("https://home.example/location/box");
  });
});
