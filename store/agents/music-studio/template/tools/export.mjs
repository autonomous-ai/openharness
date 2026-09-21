#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildMusic } from './build.mjs';
const root = fileURLToPath(new URL('..', import.meta.url)), args = process.argv.slice(2);
const output = resolve(root, args.includes('--out') ? args[args.indexOf('--out') + 1] : 'delivery');
await buildMusic(root); await mkdir(output, { recursive: true });
const toolchain = process.env.MUSIC_DSH_DIR ? pathToFileURL(join(process.env.MUSIC_DSH_DIR, 'toolchain/')).href : new URL('../../toolchain/', import.meta.url).href;
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || new URL('node_modules/playwright-core/index.mjs', toolchain).href);
const executablePath = process.env.BROWSER_EXECUTABLE || await (await import(new URL('browser.mjs', toolchain).href)).browserPath();
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1080 }, acceptDownloads: true }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(join(root, 'piece/index.html')).href);
  await page.locator('body[data-ready=true]').waitFor({ timeout: 30000 });
  await page.locator('#play').click(); await page.waitForFunction(() => afterhours.getState().playing && afterhours.getState().context === 'running');
  await page.locator('#stop').click();
  for (const [button, name] of [['export-wav', 'mix.wav'], ['export-midi', 'composition.mid'], ['save-project', 'project.afterhours.json'], ['export-stems', 'production.zip'], ['export-html', 'studio.html']]) {
    const event = page.waitForEvent('download', { timeout: 60000 }); await page.locator('#' + button).click(); const download = await event;
    if (await download.failure()) throw new Error('Export failed: ' + name); await download.saveAs(join(output, name));
  }
  const measured = await page.evaluate(() => afterhours.getState());
  const project = await page.evaluate(() => afterhours.getProject());
  const repeated = await page.evaluate(async () => {
    const a = await afterhours.render(), b = await afterhours.render(); let maxDifference = 0;
    for (let c = 0; c < 2; c++) for (let i = 0; i < a.channels[c].length; i++) maxDifference = Math.max(maxDifference, Math.abs(a.channels[c][i] - b.channels[c][i]));
    return { frames: a.buffer.length, sampleRate: a.sampleRate, maxDifference };
  });
  if (!Number.isFinite(measured.peak) || measured.peak > .951 || measured.rms <= .00001) throw new Error('The exported mix is silent, non-finite or lacks expected headroom.');
  if (repeated.maxDifference > .00001) throw new Error('Repeated render differs beyond the audio tolerance.');
  if (errors.length) throw new Error(errors.join('\n'));
  await page.evaluate(() => { scrollTo(0, 0); document.querySelector('aside').scrollTop = 0; });
  await page.screenshot({ path: join(output, 'studio.png'), fullPage: true });
  const report = { title: project.title, brief: project.brief, sourceRevision: project.revision, ready: false, tracks: project.tracks.length, notes: project.tracks.reduce((n, t) => n + t.notes.length, 0), ...measured, repeated, limitation: 'Playback, repeatability, duration and headroom are technical checks. Musical quality, fit to the brief and the complete listening pass remain a review task.' };
  await writeFile(join(output, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, title: project.title, duration: measured.duration, tracks: project.tracks.length, peak: measured.peak, repeatedMaximumDifference: repeated.maxDifference, ready: false }));
} finally { await browser.close(); }
