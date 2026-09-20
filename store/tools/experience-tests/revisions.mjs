// Reproducible revision scenarios, including the real saved-project -> source bridge.
// These are authored acceptance fixtures, not testimonials or autonomous-agent evals.
// node revisions.mjs /absolute/output [--export]
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArt } from '../../agents/generative-art/template/tools/build.mjs';
import { buildMusic } from '../../agents/music-studio/template/tools/build.mjs';
import { renderProject } from '../../agents/generative-art/template/studio/project.mjs';
const repo = fileURLToPath(new URL('../../../', import.meta.url));
if (!process.argv[2]) throw new Error('Pass an output folder for the six revision workspaces.');
const output = resolve(process.argv[2]), report = [];
const artCases = [
  ['night-garden', 'template/sketch', 'details', 'OCTOBER 9—11 · RIVERSIDE GARDENS', 'Change the date and venue; preserve the approved identity.'],
  ['canopy', 'examples/coffee', 'lot', 'LOT 044 / HONEY CATURRA', 'Update the product lot; preserve our logo, origin, colors and illustration.'],
  ['rain-atlas', 'examples/data-atlas', 'csv', null, 'Correct January from 42 to 84 mm; preserve every other observation and the layout.'],
];
for (const [id, source, key, value, request] of artCases) {
  const root = join(repo, 'store/agents/generative-art'), ws = join(output, id);
  await cp(join(root, 'template'), ws, { recursive: true }); await cp(join(root, source), join(ws, 'sketch'), { recursive: true });
  await buildArt(ws);
  const html = await readFile(join(ws, 'sketch/index.html'), 'utf8');
  const before = JSON.parse(html.match(/<script id="fieldwork-data" type="application\/json">([\s\S]*?)<\/script>/)[1]), after = structuredClone(before);
  const control = after.controls.find(c => c.key === key); control.value = value ?? control.value.replace('Jan,42', 'Jan,84');
  assert.deepEqual(after.assets, before.assets); assert.equal(after.code, before.code); assert.equal(after.seed, before.seed);
  assert.deepEqual(after.controls.filter(c => c.key !== key), before.controls.filter(c => c.key !== key));
  await mkdir(join(ws, 'before'), { recursive: true }); await mkdir(join(ws, 'after'), { recursive: true });
  for (let i = 0; i < before.formats.length; i++) {
    const a = renderProject(before, { format: i }), b = renderProject(after, { format: i }); assert.notEqual(a, b);
    if (key !== 'csv') assert.deepEqual(a.match(/<path\b[^>]*>/g), b.match(/<path\b[^>]*>/g));
    else assert.match(b, /1430 MM/);
    await writeFile(join(ws, 'before', `${i + 1}.svg`), a); await writeFile(join(ws, 'after', `${i + 1}.svg`), b);
  }
  await writeFile(join(ws, 'before/project.fieldwork.json'), JSON.stringify(before, null, 2));
  const file = join(ws, 'revision.fieldwork.json'); await writeFile(file, JSON.stringify(after));
  execFileSync(process.execPath, [join(ws, 'tools/import-project.mjs'), file]);
  assert.ok((await readdir(join(ws, '.harness/history'))).length > 0); await buildArt(ws, { check: true });
  if (process.argv.includes('--export')) execFileSync(process.execPath, [join(ws, 'tools/export.mjs'), '--seeds', '1', '--out', 'after'], { env: { ...process.env, GENART_DSH_DIR: root }, stdio: 'inherit' });
  report.push({ id, request, preserved: ['drawing program', 'seed', 'assets', 'unrelated controls', 'source backup'], formats: before.formats.length });
}
for (const [id, source, target, request] of [
  ['blue-hour', 'template/piece', 'motif', 'Add one quiet final echo of the motif; leave the accompaniment intact.'],
  ['orbit-runner', 'examples/orbit-runner', 'kit', 'Remove the hi-hats from the first two launch bars; preserve the hook, bass, kicks and snare.'],
  ['keepsake', 'examples/keepsake', 'answer', 'Add a small bell response before the slower section; preserve the supplied melody and tempo map.'],
]) {
  const root = join(repo, 'store/agents/music-studio'), ws = join(output, id);
  await cp(join(root, 'template'), ws, { recursive: true }); await cp(join(root, source), join(ws, 'piece'), { recursive: true });
  await buildMusic(ws);
  const html = await readFile(join(ws, 'piece/index.html'), 'utf8'), before = JSON.parse(html.match(/<script id="afterhours-data" type="application\/json">([\s\S]*?)<\/script>/)[1]), after = structuredClone(before), track = after.tracks.find(t => t.id === target);
  if (id === 'blue-hour') track.notes.push({ beat: 78.95, midi: 74, duration: .2, velocity: .2 });
  else if (id === 'orbit-runner') track.notes = track.notes.filter(n => !(n.midi === 42 && n.beat >= 8 && n.beat < 16));
  else track.notes.push({ beat: 15, midi: 79, duration: .5, velocity: .28 }, { beat: 15.75, midi: 76, duration: .6, velocity: .28 });
  assert.deepEqual(after.tracks.filter(t => t.id !== target), before.tracks.filter(t => t.id !== target));
  assert.deepEqual(after.tempos, before.tempos); assert.equal(after.beats, before.beats); assert.deepEqual(after.assets, before.assets);
  await mkdir(join(ws, 'before'), { recursive: true }); await writeFile(join(ws, 'before/project.afterhours.json'), JSON.stringify(before, null, 2));
  const file = join(ws, 'revision.afterhours.json'); await writeFile(file, JSON.stringify(after));
  execFileSync(process.execPath, [join(ws, 'tools/import-project.mjs'), file]);
  assert.ok((await readdir(join(ws, '.harness/history'))).length > 0); await buildMusic(ws, { check: true });
  if (process.argv.includes('--export')) execFileSync(process.execPath, [join(ws, 'tools/export.mjs'), '--out', 'after'], { env: { ...process.env, MUSIC_DSH_DIR: root }, stdio: 'inherit' });
  report.push({ id, request, preserved: ['unrelated tracks and notes', 'tempo map', 'duration', 'assets', 'source backup'], notesBefore: before.tracks.reduce((n, t) => n + t.notes.length, 0), notesAfter: after.tracks.reduce((n, t) => n + t.notes.length, 0) });
}
await writeFile(join(output, 'revisions.json'), JSON.stringify(report, null, 2));
console.log('PASS: six targeted revisions preserve approved material and source history.');
