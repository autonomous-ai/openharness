import { buildArt } from './build.mjs';
import { fileURLToPath } from 'node:url';
try {
  const result = await buildArt(fileURLToPath(new URL('..', import.meta.url)), { check: true });
  console.log(JSON.stringify({ ...result, ready: false, next: 'Run node tools/export.mjs, inspect the exported artwork, and compare it to the brief.' }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
