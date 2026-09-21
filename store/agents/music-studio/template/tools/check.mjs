import { buildMusic } from './build.mjs';
import { fileURLToPath } from 'node:url';
try { console.log(JSON.stringify({ ...await buildMusic(fileURLToPath(new URL('..', import.meta.url)), { check: true }), ready: false, next: 'Export, inspect the MIDI and WAV files, then listen to the complete piece.' })); } catch (error) { console.error(error.message); process.exitCode = 1; }
