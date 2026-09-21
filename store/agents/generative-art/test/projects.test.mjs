import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, cp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { validateProject, renderProject } from '../template/studio/project.mjs';
import { buildArt } from '../template/tools/build.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
async function load(dir) {
  const p = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'));
  p.code = await readFile(join(dir, 'artwork.js'), 'utf8');
  for (const a of p.assets) if (a.file) { a.data = 'data:image/svg+xml;base64,' + (await readFile(join(dir, a.file))).toString('base64'); delete a.file; }
  return validateProject(p);
}
for (const dir of ['template/sketch', 'examples/coffee', 'examples/data-atlas']) test(`${dir}: a different original program, all formats repeat and escape user text`, async () => {
  const p = await load(join(root, dir));
  for (let i = 0; i < p.formats.length; i++) {
    const a = renderProject(p, { format: i });
    assert.equal(a, renderProject(p, { format: i }));
    assert.match(a, new RegExp(`width="${p.formats[i].width}" height="${p.formats[i].height}"`));
    assert.ok(a.length > 500);
  }
  const text = p.controls.find(c => c.type === 'text');
  const output = renderProject(p, { values: { [text.key]: 'A & B <new>' } });
  assert.match(output, /&amp;/); assert.match(output, /&lt;new&gt;/);
  if (p.variations !== false) assert.notEqual(renderProject(p, { seed: '1' }), renderProject(p, { seed: '2' }));
});
test('the renderer is not restricted to the shipped visual vocabulary', async () => {
  const p = await load(join(root, 'template/sketch'));
  p.code = 'return svg.el("path", {d: `M0 0 L${width} ${height} L0 ${height} Z`, fill: values.ink})';
  assert.match(renderProject(validateProject(p)), /M0 0 L1200 1600 L0 1600 Z/);
  assert.doesNotMatch(renderProject(p), /NIGHT GARDEN/);
});
test('rejects broken controls, invalid dimensions and missing drawing programs', async () => {
  const p = await load(join(root, 'template/sketch'));
  for (const mutate of [x => { x.code = ''; }, x => { x.code = 'return {'; }, x => { x.formats[0].width = 0; }, x => { x.controls[0].key = '__proto__'; }, x => { x.controls[0].value = 4; }, x => { x.assets[0].data = 'https://remote.example/image.png'; }]) {
    const broken = structuredClone(p); mutate(broken); assert.throws(() => validateProject(broken));
  }
});
test('a fresh project builds, embeds local material and detects stale preview/source drift', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'fieldwork-build-'));
  try {
    await cp(join(root, 'template'), ws, { recursive: true });
    await cp(join(root, 'examples/coffee'), join(ws, 'sketch'), { recursive: true });
    await buildArt(ws); await buildArt(ws, { check: true });
    const html = await readFile(join(ws, 'sketch/index.html'), 'utf8');
    assert.match(html, /data:image\/svg\+xml;base64/);
    const manifest = JSON.parse(await readFile(join(ws, 'sketch/project.json'), 'utf8'));
    manifest.controls[0].value = 'USER REVISION $& </script> & <tag>';
    await writeFile(join(ws, 'sketch/project.json'), JSON.stringify(manifest));
    await assert.rejects(buildArt(ws, { check: true }), /out of date/);
    await buildArt(ws);
    assert.match(await readFile(join(ws, 'sketch/index.html'), 'utf8'), /USER REVISION/);
    const rebuilt = await readFile(join(ws, 'sketch/index.html'), 'utf8');
    const data = JSON.parse(rebuilt.match(/<script id="fieldwork-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
    assert.equal(data.controls[0].value, manifest.controls[0].value);
    assert.equal(JSON.parse(await readFile(join(ws, '.harness/verdict.json'), 'utf8')).ready, false);
  } finally { await rm(ws, { recursive: true, force: true }); }
});
