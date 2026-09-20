#!/usr/bin/env node
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validateSession } from '../studio/session.mjs';
export async function buildMusic(workspace, { check = false } = {}) {
  const root = resolve(workspace), read = name => readFile(resolve(root, name), 'utf8');
  if (!check) {
    await mkdir(resolve(root, '.harness'), { recursive: true });
    await writeFile(resolve(root, '.harness/verdict.json'), JSON.stringify({ spec: 1, ready: false, artifact: 'piece/index.html', summary: 'Building the composition · verification pending' }));
  }
  const source = JSON.parse(await read('piece/session.json'));
  for (const asset of source.assets || []) {
    if (!asset.file) continue;
    const dir = await realpath(resolve(root, 'piece')), path = await realpath(resolve(dir, asset.file));
    if (!path.startsWith(dir + sep)) throw new Error('Recordings must live inside piece/.');
    const mime = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg' }[extname(path).toLowerCase()];
    if (!mime) throw new Error('Use WAV, MP3, M4A or OGG audio.');
    const bytes = await readFile(path); if (bytes.length > 18000000) throw new Error('Use audio files under 18 MB.');
    asset.data = `data:${mime};base64,${bytes.toString('base64')}`; delete asset.file;
  }
  const project = validateSession(source), revision = createHash('sha256').update(JSON.stringify(project)).digest('hex');
  const [shell, css, model, engine, files, app, midi, icon] = await Promise.all(['studio/shell.html', 'studio/style.css', 'studio/session.mjs', 'studio/audio.mjs', 'studio/files.mjs', 'studio/app.js', 'studio/vendor/midi.cjs', 'studio/icon.svg'].map(read));
  const inline = source => source.replace(/^import .*?;\n/gm, '').replace(/^export /gm, '').replace(/<\/script/gi, '<\\/script');
  const replacements = { '/* STUDIO_CSS */': css, '/* SESSION_MODEL */': inline(model), '/* AUDIO_ENGINE */': inline(engine), '/* FILE_TOOLS */': inline(files), '/* STUDIO_APP */': inline(app), '/* MIDI_LIBRARY */': midi, '"PROJECT_DATA"': JSON.stringify({ ...project, revision }).replace(/</g, '\\u003c'), '<!-- PROJECT_ICON -->': icon, '<!-- FAVICON -->': `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(icon)}">` };
  let html = shell; for (const [key, value] of Object.entries(replacements)) html = html.replace(key, () => value);
  if (check) { if (await read('piece/index.html') !== html) throw new Error('Preview is out of date. Run node tools/build.mjs.'); }
  else await writeFile(resolve(root, 'piece/index.html'), html);
  return { title: project.title, revision, tracks: project.tracks.length, notes: project.tracks.reduce((sum, t) => sum + t.notes.length, 0), htmlBytes: Buffer.byteLength(html) };
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try { console.log(JSON.stringify(await buildMusic(root, { check: process.argv.includes('--check') }))); }
  catch (error) {
    console.error(error.message); process.exitCode = 1;
    await mkdir(resolve(root, '.harness'), { recursive: true });
    await writeFile(resolve(root, '.harness/verdict.json'), JSON.stringify({ spec: 1, ready: false, artifact: 'piece/index.html', summary: 'Build failed: ' + error.message }));
  }
}
