#!/usr/bin/env node
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validateProject } from '../studio/project.mjs';

export async function buildArt(workspace, { check = false } = {}) {
  const root = resolve(workspace), source = resolve(root, 'sketch');
  if (!check) {
    await mkdir(resolve(root, '.harness'), { recursive: true });
    await writeFile(resolve(root, '.harness/verdict.json'), JSON.stringify({ spec: 1, ready: false, artifact: 'sketch/index.html', summary: 'Building artwork · verification pending' }));
  }
  const read = name => readFile(resolve(root, name), 'utf8');
  const project = JSON.parse(await read('sketch/project.json'));
  project.code = await read('sketch/artwork.js');
  for (const asset of project.assets || []) {
    if (!asset.file) continue;
    const actual = await realpath(resolve(source, asset.file));
    const base = await realpath(source);
    if (!actual.startsWith(base + sep)) throw new Error(`Asset must live inside sketch/: ${asset.file}`);
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' }[extname(actual).toLowerCase()];
    if (!mime) throw new Error(`Unsupported asset: ${asset.file}`);
    const bytes = await readFile(actual);
    if (bytes.length > 12000000) throw new Error(`Asset is over 12 MB: ${asset.file}`);
    asset.data = `data:${mime};base64,${bytes.toString('base64')}`;
    delete asset.file;
  }
  validateProject(project);
  const revision = createHash('sha256').update(JSON.stringify(project)).digest('hex');
  const [shell, css, model, app, icon] = await Promise.all(['studio/shell.html', 'studio/style.css', 'studio/project.mjs', 'studio/app.js', 'studio/icon.svg'].map(read));
  const js = text => text.replace(/<\/script/gi, '<\\/script');
  const data = JSON.stringify({ ...project, revision }).replace(/</g, '\\u003c');
  const html = shell.replace('/* STUDIO_CSS */', () => css).replace('/* PROJECT_MODEL */', () => js(model.replace(/^export /gm, ''))).replace('/* STUDIO_APP */', () => js(app)).replace('"PROJECT_DATA"', () => data).replace('<!-- PROJECT_ICON -->', () => icon).replace('<!-- FAVICON -->', () => `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(icon)}">`);
  const out = resolve(source, 'index.html');
  if (check) {
    if (await readFile(out, 'utf8') !== html) throw new Error('Preview is out of date. Run node tools/build.mjs.');
  } else {
    await writeFile(out, html);
    await mkdir(resolve(root, '.harness'), { recursive: true });
    await writeFile(resolve(root, '.harness/verdict.json'), JSON.stringify({ spec: 1, ready: false, artifact: 'sketch/index.html', summary: `${project.title} built · export and visual review pending`, findings: [{ severity: 'info', kind: 'review_pending', message: 'A successful build does not establish visual quality or match to the brief.' }] }, null, 2) + '\n');
  }
  return { title: project.title, revision, formats: project.formats.length, htmlBytes: Buffer.byteLength(html) };
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await buildArt(resolve(dirname(fileURLToPath(import.meta.url)), '..'), { check: process.argv.includes('--check') }))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
