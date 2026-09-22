#!/usr/bin/env node
// GIFs made from autonomous.ai pages:
//   device.gif               the Harness device video on autonomous.ai/harness-device
//   connect/direct.gif       the three connection animations on autonomous.ai/harness-app
//   connect/cloudflare.gif
//   connect/relay.gif
//
//   node .github/assets/readme/site.mjs
//
// Needs Google Chrome, FFmpeg, curl, and playwright-core from store/tools/experience-tests.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const tmp = join(here, '.cache', 'site');
mkdirSync(join(here, 'connect'), { recursive: true });
mkdirSync(tmp, { recursive: true });
const ff = (...a) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...a]);
const gif = (src, out, vf, extra = []) => {
  ff(...extra, '-i', src, '-filter_complex',
    `${vf},split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
    '-loop', '0', out);
  console.log(`${out.slice(here.length + 1)}  ${(statSync(out).size / 1048576).toFixed(1)} MiB`);
};

// The device: tap, speak a task, watch it ship, read the summary.
const video = join(tmp, 'device.mp4');
execFileSync('curl', ['-fsSL', '-o', video, 'https://cdn.autonomous.ai/production/ecm/260918/gallery.mp4']);
gif(video, join(here, 'device.gif'), 'fps=10,scale=960:-2:flags=lanczos');

// The connection animations run in the page itself, so record them in Chrome.
const { chromium } = await import(pathToFileURL(join(root, 'store/tools/experience-tests/node_modules/playwright-core/index.mjs')).href);
const browser = await chromium.launch({ channel: 'chrome' });
const tabs = [['Machine to machine', 'direct'], ['Cloudflare', 'cloudflare'], ['Our relay', 'relay']];
for (const [tab, name] of tabs) {
  const dir = join(tmp, name);
  rmSync(dir, { recursive: true, force: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir, size: { width: 1440, height: 900 } } });
  const page = await ctx.newPage();
  await page.goto('https://www.autonomous.ai/harness-app', { waitUntil: 'networkidle' });
  const button = page.getByRole('button', { name: tab, exact: true }).first();
  await button.scrollIntoViewIfNeeded();
  await button.click();
  // Hide the site header and banners, then centre the animation beside the tab row.
  const box = await page.evaluate((tab) => {
    for (const el of document.querySelectorAll('body *')) {
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky') el.style.visibility = 'hidden';
    }
    const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === tab);
    const below = b.getBoundingClientRect().bottom;
    const el = [...document.querySelectorAll('div')].map(d => ({ d, r: d.getBoundingClientRect() }))
      .filter(x => x.r.top > below - 5 && x.r.top < below + 200 && x.r.left > 400 && x.r.width > 600 && x.r.height > 300)
      .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0].d;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }, tab);
  await page.waitForTimeout(17000);
  await ctx.close();
  const webm = join(dir, readdirSync(dir)[0]);
  // The loop is steady after the page settles; keep eight seconds of it.
  gif(webm, join(here, 'connect', `${name}.gif`),
    `crop=${box.w}:${box.h}:${box.x}:${box.y},fps=12,scale=800:-2:flags=lanczos`, ['-ss', '8', '-t', '8']);
}
await browser.close();
