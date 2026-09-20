#!/usr/bin/env node
// Production export and repeatability checks on the user's actual program, not a preset model.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { buildArt } from './build.mjs';
import { filename } from '../studio/project.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2), arg = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const count = Number(arg('--seeds', 3)), scale = Number(arg('--scale', 1));
if (!Number.isInteger(count) || count < 1 || count > 100 || ![1, 2, 4].includes(scale)) throw new Error('Use --seeds 1–100 and --scale 1, 2 or 4.');
const output = resolve(root, arg('--out', 'delivery'));
await buildArt(root);
const toolchain = process.env.GENART_DSH_DIR ? pathToFileURL(join(process.env.GENART_DSH_DIR, 'toolchain/')).href : new URL('../../toolchain/', import.meta.url).href;
const modulePath = process.env.PLAYWRIGHT_MODULE || new URL('node_modules/playwright-core/index.mjs', toolchain).href;
let chromium;
try { ({ chromium } = await import(modulePath)); }
catch { throw new Error('Run the Generative Art toolchain setup first (Playwright is required for real exports).'); }
const executablePath = process.env.BROWSER_EXECUTABLE || await (await import(new URL('browser.mjs', toolchain).href)).browserPath();
const browser = await chromium.launch({ executablePath, headless: true });
try {
  await mkdir(output, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(pathToFileURL(join(root, 'sketch/index.html')).href);
  await page.locator('body[data-ready=true]').waitFor({ timeout: 15000 });
  const project = await page.evaluate(() => fieldwork.getProject());
  const hash = data => createHash('sha256').update(data).digest('hex');
  const results = [];
  for (let i = 0; i < count; i++) {
    const seed = i === 0 ? project.seed : /^\d{1,9}$/.test(project.seed) ? String(Number(project.seed) + i) : `${project.seed}.${i}`;
    for (let format = 0; format < project.formats.length; format++) {
      const first = await page.evaluate(({ options, scale }) => fieldwork.deliver(options, scale), { options: { seed, format }, scale });
      const repeated = await page.evaluate(options => fieldwork.render(options), { seed, format });
      if (first.svg !== repeated) throw new Error(`Non-deterministic vector: seed ${seed}, ${project.formats[format].name}.`);
      const prefix = `${String(format + 1).padStart(2, '0')}-${filename(project.formats[format].name)}-${filename(seed)}`;
      const png = Buffer.from(first.png.split(',')[1], 'base64');
      if (png.readUInt32BE(16) !== first.width || png.readUInt32BE(20) !== first.height) throw new Error('PNG dimensions do not match the requested output.');
      await writeFile(join(output, prefix + '.svg'), first.svg); await writeFile(join(output, prefix + '.png'), png);
      results.push({ seed, format: project.formats[format].name, width: first.width, height: first.height, svg: prefix + '.svg', png: prefix + '.png', sha256: hash(first.svg), pngSha256: hash(png), sameSeedVector: true });
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  await page.screenshot({ path: join(output, 'studio.png'), fullPage: true });
  await writeFile(join(output, 'project.fieldwork.json'), JSON.stringify(project, null, 2));
  await writeFile(join(output, 'studio.html'), await readFile(join(root, 'sketch/index.html')));
  const report = { title: project.title, brief: project.brief, sourceRevision: project.revision, ready: false, exports: results, limitation: 'Geometry repeated exactly in this browser. Visual match to the brief requires review. SVG text uses system fonts, which can differ on another machine.' };
  await writeFile(join(output, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, formats: project.formats.length, seeds: count, exports: results.length, ready: false, next: 'Inspect the real exported SVGs and PNGs against the brief before marking ready.' }));
} finally { await browser.close(); }
