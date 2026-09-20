#!/usr/bin/env node
// Package portable HTML studios. Art/Music use their own source-project builders.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { buildArt } from "../agents/generative-art/template/tools/build.mjs";
import { buildMusic } from "../agents/music-studio/template/tools/build.mjs";
const source = new URL("./experiences/", import.meta.url);
export const experiences = [
  {
    id: "generative-art",
    path: "sketch",
    title: "FIELDWORK — Generative Art",
    name: "FIELDWORK",
  },
  {
    id: "creative-direction",
    path: "board",
    title: "FORME — Creative Direction",
    name: "FORME",
  },
  {
    id: "lab-bench",
    path: "bench",
    title: "SIGNAL — Lab Bench",
    name: "SIGNAL / LAB",
  },
  {
    id: "music-studio",
    path: "piece",
    title: "AFTERHOURS — Music Studio",
    name: "AFTERHOURS",
  },
  {
    id: "game-master",
    path: "game",
    title: "RELAY — Game Master",
    name: "RELAY / ARENA",
  },
  {
    id: "drone-pilot",
    path: "flight",
    title: "VECTOR — Drone Pilot",
    name: "VECTOR / FLIGHT",
  },
  {
    id: "voxel-worlds",
    path: "world",
    title: "TIDELANDS — Voxel Worlds",
    name: "TIDELANDS",
  },
];
export async function build({ check = false } = {}) {
  const read = (name) => readFile(new URL(name, source), "utf8");
  const [core, css, common, checker] = await Promise.all([
    read("core.mjs"),
    read("common.css"),
    read("common.js"),
    read("check-template.mjs"),
  ]);
  let drift = false;
  for (const exp of experiences) {
    if (exp.id === "generative-art" || exp.id === "music-studio") {
      try {
        const packageRoot = new URL(`../agents/${exp.id}/`, import.meta.url);
        const icon = await readFile(new URL('brand/icon.svg', packageRoot), 'utf8');
        const studioIcon = new URL('template/studio/icon.svg', packageRoot);
        if (check) {
          if (await readFile(studioIcon, 'utf8') !== icon) throw new Error(`${exp.id}: packaged studio icon is out of date.`);
        } else await writeFile(studioIcon, icon);
        const builder = exp.id === 'generative-art' ? buildArt : buildMusic;
        await builder(fileURLToPath(new URL(`../agents/${exp.id}/template/`, import.meta.url)), { check });
      } catch (error) {
        if (!check) throw error;
        console.error(error.message);
        drift = true;
      }
      continue;
    }
    const [model, style, body, app] = await Promise.all(
      ["mjs", "css", "html", "js"].map((ext) => read(`${exp.id}.${ext}`)),
    );
    const modelJS = [core, model]
      .join("\n")
      .replace(/^import .*?;\n/gm, "")
      .replace(/^export /gm, "");
    const appJS = [common, app].join("\n");
    const icon = (
      await readFile(
        new URL(`../agents/${exp.id}/brand/icon.svg`, import.meta.url),
        "utf8",
      )
    ).trim();
    const favicon = `data:image/svg+xml,${encodeURIComponent(icon)}`;
    if (/<\/script/i.test(modelJS + appJS))
      throw new Error(`${exp.id}: inline script closing tag in source`);
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light"><title>${exp.title}</title>
<link rel="icon" type="image/svg+xml" href="${favicon}">
<!-- Built by store/tools/build-experiences.mjs. Edit this file freely in your workspace. -->
<style>${css}\n${style}</style></head><body>
<header class="masthead"><div class="identity"><span class="mark" aria-hidden="true">${icon}</span>${exp.name}</div>
<form class="seed-form" id="seed-form"><label for="seed">Seed</label><input id="seed" aria-label="Seed" maxlength="128" autocomplete="off" spellcheck="false"><button type="submit">Apply</button><button id="next-seed" type="button" title="Next seed">↗ Next</button></form></header>
${body}<div class="toast" id="toast" role="status"></div>
<script id="harness-model">\n'use strict';\n${modelJS}\n</script>
<script>\n'use strict';\n${appJS}\n</script></body></html>\n`;
    const out = new URL(
      `../agents/${exp.id}/template/${exp.path}/index.html`,
      import.meta.url,
    );
    if (check) {
      if ((await readFile(out, "utf8")) !== html) {
        console.error(`Out of date: ${fileURLToPath(out)}`);
        drift = true;
      }
    } else await writeFile(out, html);
    const checkDir = new URL(
      `../agents/${exp.id}/template/tools/`,
      import.meta.url,
    );
    const checkFile = new URL("check.mjs", checkDir);
    const checkSource = `const CONFIG = ${JSON.stringify({ id: exp.id, artifact: `${exp.path}/index.html` })};\n${checker}`;
    if (check) {
      if ((await readFile(checkFile, "utf8")) !== checkSource) {
        console.error(`Out of date: ${fileURLToPath(checkFile)}`);
        drift = true;
      }
    } else {
      await mkdir(checkDir, { recursive: true });
      await writeFile(checkFile, checkSource);
    }
  }
  if (drift) process.exitCode = 1;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await build({ check: process.argv.includes("--check") });
