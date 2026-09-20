#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { validateSession, readSessionMidi } from '../studio/session.mjs';
import { buildMusic } from './build.mjs';
if (!process.argv[2]) throw new Error('Usage: node tools/import-project.mjs project.afterhours.json OR composition.mid');
const root = fileURLToPath(new URL('..', import.meta.url)), path = resolve(process.argv[2]), bytes = await readFile(path);
if (bytes.length > 28000000) throw new Error('Project exceeds 28 MB.');
let project;
if (['.mid', '.midi'].includes(extname(path).toLowerCase())) {
  const { Midi } = createRequire(import.meta.url)(fileURLToPath(new URL('../studio/vendor/midi.js', import.meta.url)));
  project = readSessionMidi(bytes, Midi);
} else project = validateSession(JSON.parse(bytes.toString('utf8')));
const backup = join(root, '.harness/history', new Date().toISOString().replace(/[:.]/g, '-') + '.json');
await mkdir(join(root, '.harness/history'), { recursive: true });
await writeFile(backup, await readFile(join(root, 'piece/session.json')));
delete project.revision;
await writeFile(join(root, 'piece/session.json'), JSON.stringify(project, null, 2) + '\n');
console.log(JSON.stringify({ ...await buildMusic(root), backup, warnings: project.importWarnings || [] }));
