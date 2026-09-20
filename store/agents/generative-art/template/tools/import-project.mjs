#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProject } from '../studio/project.mjs';
import { buildArt } from './build.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
if (!process.argv[2]) throw new Error('Usage: node tools/import-project.mjs path/to/project.fieldwork.json');
const bytes = await readFile(resolve(process.argv[2]), 'utf8');
if (bytes.length > 64000000) throw new Error('Project exceeds 64 MB.');
const project = validateProject(JSON.parse(bytes));
const backup = join(root, '.harness/history', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(backup, { recursive: true });
for (const name of ['project.json', 'artwork.js']) await writeFile(join(backup, name), await readFile(join(root, 'sketch', name)));
const manifest = structuredClone(project); delete manifest.code; delete manifest.revision; delete manifest.view;
await writeFile(join(root, 'sketch/project.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(join(root, 'sketch/artwork.js'), project.code);
console.log(JSON.stringify({ ...await buildArt(root), backup }));
