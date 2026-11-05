import { pythonExecutable, chromeLaunchOptions } from "./env.mjs";
import { createRequire } from "node:module";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const testRoot = fileURLToPath(new URL("../", import.meta.url));
const project = path.resolve(testRoot, "..");
const require = createRequire(path.join(project, "frontend/package.json"));
const { chromium } = require("playwright");
const { transform } = require("esbuild");
const source = await readFile(path.join(project, "frontend/src/lib/preparePhoto.ts"), "utf8");
const compiled = await transform(source, { loader: "ts", format: "iife", globalName: "PhotoPreparation", target: "es2022" });
const browser = await chromium.launch(chromeLaunchOptions());
try {
  const page = await browser.newPage();
  await page.setContent("<!doctype html><title>Photo preparation synthetic fixtures</title>");
  await page.addScriptTag({ content: compiled.code });
  const results = await page.evaluate(async () => {
    const { preparePhoto } = window.PhotoPreparation;
    const blob = (canvas, type, quality) => new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("fixture encoding failed")), type, quality));
    const canvas = (width, height) => Object.assign(document.createElement("canvas"), { width, height });
    const imageInfo = async file => {
      const bitmap = await createImageBitmap(file);
      const info = { width: bitmap.width, height: bitmap.height, size: file.size, type: file.type };
      bitmap.close(); return info;
    };
    const output = {};

    // Camera-like high-frequency fixture: 12MP, generated in memory, no user files.
    const largeCanvas = canvas(4000, 3000), largeContext = largeCanvas.getContext("2d");
    const pixels = largeContext.createImageData(4000, 3000);
    let seed = 123456789;
    for (let i = 0; i < pixels.data.length; i += 4) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      pixels.data[i] = seed & 255; pixels.data[i + 1] = (seed >>> 8) & 255; pixels.data[i + 2] = (seed >>> 16) & 255; pixels.data[i + 3] = 255;
    }
    largeContext.putImageData(pixels, 0, 0);
    let large;
    for (const quality of [.84, .8, .75, .7]) {
      large = await blob(largeCanvas, "image/jpeg", quality);
      if (large.size <= 8 * 1024 * 1024) break;
    }
    const largeFile = new File([large], "synthetic-12mp.jpg", { type: "image/jpeg" });
    const started = performance.now(), prepared = await preparePhoto(largeFile);
    output.large = { originalBytes: largeFile.size, compressed: prepared.compressed, elapsedMs: performance.now() - started, ...await imageInfo(prepared.file) };
    const oversizedBlob = await blob(largeCanvas, "image/jpeg", .96);
    const oversizedFile = new File([oversizedBlob], "large-local-12mp.jpg", { type: "image/jpeg" });
    const oversizedPrepared = await preparePhoto(oversizedFile);
    output.largeLocalInput = { originalBytes: oversizedFile.size, compressed: oversizedPrepared.compressed, ...await imageInfo(oversizedPrepared.file) };
    largeCanvas.width = 0; largeCanvas.height = 0;

    const smallCanvas = canvas(80, 60);
    smallCanvas.getContext("2d").fillRect(0, 0, 80, 60);
    const small = new File([await blob(smallCanvas, "image/png")], "small.png", { type: "image/png" });
    const smallPrepared = await preparePhoto(small);
    output.small = { sameFile: smallPrepared.file === small, compressed: smallPrepared.compressed, ...await imageInfo(smallPrepared.file) };

    // A 2000x1000 PNG with random colors and transparent rows ensures compression
    // adopts JPEG and lets us inspect pixels that were originally transparent.
    const transparentCanvas = canvas(2000, 1000), transparentContext = transparentCanvas.getContext("2d");
    const transparentPixels = transparentContext.createImageData(2000, 1000);
    for (let i = 0; i < transparentPixels.data.length; i += 4) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      transparentPixels.data[i] = seed & 255; transparentPixels.data[i + 1] = (seed >>> 8) & 255; transparentPixels.data[i + 2] = (seed >>> 16) & 255;
      transparentPixels.data[i + 3] = i < 2000 * 200 * 4 ? 0 : 255;
    }
    transparentContext.putImageData(transparentPixels, 0, 0);
    const transparent = new File([await blob(transparentCanvas, "image/png")], "transparent.png", { type: "image/png" });
    const transparentPrepared = await preparePhoto(transparent);
    const transparentBitmap = await createImageBitmap(transparentPrepared.file);
    const checkCanvas = canvas(transparentBitmap.width, transparentBitmap.height), checkContext = checkCanvas.getContext("2d");
    checkContext.drawImage(transparentBitmap, 0, 0);
    output.transparent = { compressed: transparentPrepared.compressed, corner: Array.from(checkContext.getImageData(10, 10, 1, 1).data), ...await imageInfo(transparentPrepared.file) };
    transparentBitmap.close();

    // Inject the EXIF Orientation=6 (90° clockwise) into a valid browser JPEG.
    const orientationCanvas = canvas(2000, 1000), orientationContext = orientationCanvas.getContext("2d");
    orientationContext.fillStyle = "#ff0000"; orientationContext.fillRect(0, 0, 1000, 1000);
    orientationContext.fillStyle = "#0000ff"; orientationContext.fillRect(1000, 0, 1000, 1000);
    const rawJpeg = new Uint8Array(await (await blob(orientationCanvas, "image/jpeg", .98)).arrayBuffer());
    const exif = new Uint8Array([255,225,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,6,0,0,0,0,0,0,0]);
    // Harmless COM segments keep the original above 400 KiB so its oriented JPEG
    // output will be smaller even for this deliberately simple color fixture.
    const comment = new Uint8Array(60004); comment.set([255,254,234,98]);
    const orientedFile = new File([rawJpeg.slice(0, 2), exif, ...Array(8).fill(comment), rawJpeg.slice(2)], "orientation6.jpg", { type: "image/jpeg" });
    const oriented = await preparePhoto(orientedFile);
    const orientedBitmap = await createImageBitmap(oriented.file);
    checkCanvas.width = orientedBitmap.width; checkCanvas.height = orientedBitmap.height;
    checkContext.drawImage(orientedBitmap, 0, 0);
    output.orientation6 = { compressed: oriented.compressed, width: orientedBitmap.width, height: orientedBitmap.height,
      top: Array.from(checkContext.getImageData(100, 100, 1, 1).data), bottom: Array.from(checkContext.getImageData(100, orientedBitmap.height - 100, 1, 1).data) };
    orientedBitmap.close();

    const originalDecode = window.createImageBitmap;
    window.createImageBitmap = undefined;
    try {
      const fallback = await preparePhoto(orientedFile);
      const decoded = await originalDecode(fallback.file);
      output.imageFallback = { compressed: fallback.compressed, width: decoded.width, height: decoded.height };
      decoded.close();
    } finally { window.createImageBitmap = originalDecode; }

    try { await preparePhoto(new File(["not an image"], "fake.jpg", { type: "image/jpeg" })); }
    catch (error) { output.invalid = error.message; }
    const excessiveCanvas = canvas(5001, 4000);
    const excessive = new File([await blob(excessiveCanvas, "image/png")], "over20mp.png", { type: "image/png" });
    try { await preparePhoto(excessive); }
    catch (error) { output.over20mp = error.message; }
    excessiveCanvas.width = 0; excessiveCanvas.height = 0;
    return output;
  });
  assert.ok(results.large.originalBytes > 6 * 1024 * 1024 && results.large.originalBytes <= 8 * 1024 * 1024);
  assert.deepEqual([results.large.width, results.large.height], [1600, 1200]);
  assert.ok(results.large.compressed && results.large.size < results.large.originalBytes / 4);
  assert.ok(results.largeLocalInput.originalBytes > 8 * 1024 * 1024 && results.largeLocalInput.originalBytes < 25 * 1024 * 1024);
  assert.ok(results.largeLocalInput.compressed && results.largeLocalInput.size < 8 * 1024 * 1024);
  assert.ok(results.small.sameFile && !results.small.compressed);
  assert.ok(results.transparent.compressed && results.transparent.corner.slice(0, 3).every(value => value >= 250));
  assert.deepEqual([results.orientation6.width, results.orientation6.height], [800, 1600]);
  assert.ok(results.orientation6.compressed && results.orientation6.top[0] > 240 && results.orientation6.bottom[2] > 240);
  assert.deepEqual([results.imageFallback.width, results.imageFallback.height], [800, 1600]);
  assert.ok(results.imageFallback.compressed);
  assert.match(results.invalid, /JPEG/); assert.match(results.over20mp, /2000 万/);
  const outDir = path.join(testRoot, "e2e/shots/prepare-photo"); await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  console.log("PASS synthetic large JPEG, unchanged small PNG, white transparency, EXIF 6 bitmap and Image fallback, invalid and over-20MP rejection");
} finally { await browser.close(); }
