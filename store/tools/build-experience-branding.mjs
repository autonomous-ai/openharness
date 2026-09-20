#!/usr/bin/env node
// Original vector marks are the source. Render only when those marks change.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { experiences } from "./build-experiences.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const xml = (s) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const dataURL = (svg) =>
  `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

function lockup(icon, name, subtitle, dark) {
  const shapes = icon
    .replace(/^[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "")
    .replace(/<title>[\s\S]*?<\/title>/, "")
    .trim();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="112" viewBox="0 0 480 112">
  <title>${xml(name)} logo</title>
  <rect width="480" height="112" rx="24" fill="${dark ? "#18252b" : "#f5f2e9"}"/>
  <g transform="translate(8 8)">${shapes}</g>
  <text x="120" y="53" fill="${dark ? "#f4f0e4" : "#243732"}" font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="600" letter-spacing="-.8">${xml(name)}</text>
  <text x="121" y="76" fill="${dark ? "#a7bbb7" : "#63746b"}" font-family="Arial, Helvetica, sans-serif" font-size="10" font-weight="600" letter-spacing="2.1">${xml(subtitle)} · AUTONOMOUS</text>
</svg>\n`;
}

export async function buildBranding({ check = false } = {}) {
  let browser;
  const rows = [];
  if (!check) {
    const { chromium } = await import(
      process.env.PLAYWRIGHT_MODULE ||
        "./experience-tests/node_modules/playwright-core/index.mjs"
    );
    browser = await chromium.launch({
      executablePath: process.env.BROWSER_EXECUTABLE || undefined,
      channel: process.env.BROWSER_EXECUTABLE ? undefined : "chrome",
      headless: true,
    });
  }
  try {
    for (const exp of experiences) {
      const dir = join(repo, "store/agents", exp.id, "brand");
      const icon = await readFile(join(dir, "icon.svg"), "utf8");
      const manifest = JSON.parse(
        await readFile(join(dir, "../harness.json"), "utf8"),
      );
      const subtitle = exp.name.split(" / ")[0];
      const assets = { "icon.svg": hash(icon) };
      for (const dark of [false, true]) {
        const name = dark ? "logo-dark.svg" : "logo.svg";
        const svg = lockup(icon, manifest.name, subtitle, dark);
        if (check)
          assert.equal(
            await readFile(join(dir, name), "utf8"),
            svg,
            `${exp.id} ${name} drift`,
          );
        else await writeFile(join(dir, name), svg);
        assets[name] = hash(svg);
      }
      const native = join(repo, "desktop/assets/engine-icons", exp.id + ".png");
      if (!check) {
        const page = await browser.newPage({
          viewport: { width: 256, height: 256 },
          deviceScaleFactor: 1,
        });
        await page.setContent(
          `<style>html,body{margin:0;background:transparent}img{display:block;width:256px;height:256px}</style><img alt="" src="${dataURL(icon)}">`,
        );
        await page.locator("img").evaluate((img) => img.decode());
        const png = await page.screenshot({ omitBackground: true });
        await writeFile(join(dir, "icon.png"), png);
        await writeFile(native, png);
        await page.close();
      }
      const png = await readFile(join(dir, "icon.png"));
      assert.equal(png.readUInt32BE(16), 256);
      assert.equal(png.readUInt32BE(20), 256);
      assets["icon.png"] = hash(png);
      assert.equal(
        hash(await readFile(native)),
        assets["icon.png"],
        `${exp.id} desktop asset drift`,
      );
      const record =
        JSON.stringify(
          { source: "icon.svg", license: "MIT", sha256: assets },
          null,
          2,
        ) + "\n";
      if (check)
        assert.equal(
          await readFile(join(dir, "assets.json"), "utf8"),
          record,
          `${exp.id} rerender branding`,
        );
      else await writeFile(join(dir, "assets.json"), record);
      rows.push({ name: manifest.name, icon });
      console.log(`${check ? "CHECK" : "BUILD"} ${exp.id} identity`);
    }
    if (!check) {
      const output = resolve(
        process.env.EXPERIENCE_OUTPUT || join(repo, "work/experience-evidence"),
      );
      await mkdir(output, { recursive: true });
      const page = await browser.newPage({
        viewport: { width: 1180, height: 1060 },
        deviceScaleFactor: 1,
      });
      await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:0;background:#f5f2e9;color:#243732;font:15px Arial,sans-serif;padding:42px 48px}
      h1{font-size:37px;letter-spacing:-1.6px;margin:8px 0 10px}p{color:#63746b;margin:0 0 26px}.over{font-size:11px;letter-spacing:3px}
      .row{display:grid;grid-template-columns:84px 285px 1fr 1fr;align-items:center;gap:20px;border-top:1px solid #24373220;padding:15px 0}
      .main{width:76px;height:76px}strong{font-size:22px;font-weight:500;letter-spacing:-.6px}.sizes{display:flex;align-items:center;justify-content:space-around;height:76px;border-radius:16px;padding:8px 18px;background:#fffdf7}.dark{background:#18252b}.sample{display:flex;flex-direction:column;align-items:center;gap:4px;font-size:9px;color:#72847c}.dark .sample{color:#afc0ba}img{display:block}.sample img{object-fit:contain}
      </style></head><body><div class="over">OPENHARNESS / ORIGINAL IDENTITIES</div><h1>Seven ways to make something yours.</h1><p>One family. Distinct marks. Legible from a browser tab to a workspace.</p>${rows.map((row) => `<div class="row"><img class="main" src="${dataURL(row.icon)}"><strong>${row.name}</strong>${[false, true].map((dark) => `<div class="sizes ${dark ? "dark" : ""}">${[16, 24, 48].map((size) => `<span class="sample"><img width="${size}" height="${size}" src="${dataURL(row.icon)}">${size}px</span>`).join("")}</div>`).join("")}</div>`).join("")}</body></html>`);
      await page
        .locator("img")
        .evaluateAll((imgs) => Promise.all(imgs.map((img) => img.decode())));
      await page.screenshot({
        path: join(output, "harness-identities.png"),
        fullPage: true,
      });
      await page.close();
    }
  } finally {
    await browser?.close();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await buildBranding({ check: process.argv.includes("--check") });
