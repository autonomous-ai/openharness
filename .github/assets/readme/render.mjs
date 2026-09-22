#!/usr/bin/env node
// Render the README feature GIFs from scenes/index.html.
//
//   node .github/assets/readme/render.mjs                 all scenes
//   node .github/assets/readme/render.mjs keyboard        one scene
//   node .github/assets/readme/render.mjs --stills 2,6    PNG stills at those seconds, for review
//
// Needs Google Chrome, FFmpeg, and playwright-core from store/tools/experience-tests
// (run `npm ci` there once).
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const { chromium } = await import(pathToFileURL(join(root, 'store/tools/experience-tests/node_modules/playwright-core/index.mjs')).href);

const args = process.argv.slice(2);
const stillsAt = args.includes('--stills') ? args[args.indexOf('--stills') + 1].split(',').map(Number) : null;
const names = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--stills');
const FPS = 15, OUT_W = 1280, FADE = 0.4;
const work = process.env.README_RENDER_TMP || join(here, '.cache', 'frames');

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 2 });
await page.goto(pathToFileURL(join(here, 'scenes', 'index.html')).href);
const scenes = names.length ? names : await page.evaluate(() => Object.keys(window.SCENES));

async function frame(name, t, path) {
  await page.evaluate(([n, s]) => window.draw(n, s), [name, t]);
  await page.evaluate(() => Promise.all([...document.images].map(i => i.decode().catch(() => {}))));
  await page.screenshot({ path });
}

for (const name of scenes) {
  const dur = await page.evaluate(n => window.SCENES[n].dur, name);
  if (stillsAt) {
    mkdirSync(join(work, 'stills'), { recursive: true });
    for (const t of stillsAt) await frame(name, t, join(work, 'stills', `${name}-${t}.png`));
    continue;
  }
  const dir = join(work, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const n = Math.round(dur * FPS);
  for (let i = 0; i < n; i++) await frame(name, i / FPS, join(dir, `${String(i).padStart(5, '0')}.png`));
  // Loop cleanly: the last FADE seconds dissolve back into the first frame.
  const gif = join(here, `${name}.gif`);
  const off = (dur - FADE).toFixed(3);
  execFileSync('ffmpeg', ['-v', 'error', '-y',
    '-framerate', String(FPS), '-i', join(dir, '%05d.png'),
    '-loop', '1', '-framerate', String(FPS), '-t', String(FADE), '-i', join(dir, '00000.png'),
    '-filter_complex',
    `[0][1]xfade=transition=fade:duration=${FADE}:offset=${off},scale=${OUT_W}:-2:flags=lanczos,split[a][b];` +
    `[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none`,
    '-loop', '0', gif]);
  console.log(`${name}.gif  ${n} frames  ${dur}s  ${(statSync(gif).size / 1048576).toFixed(2)} MiB`);
}
await browser.close();
