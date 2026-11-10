import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFilesViewer, kindOf } from '../viewer.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let ws, outside, viewer, base;
const TOKEN = 'test-token';

before(async () => {
  ws = mkdtempSync(join(tmpdir(), 'files-ws-'));
  outside = mkdtempSync(join(tmpdir(), 'files-out-'));
  mkdirSync(join(ws, 'notes'));
  mkdirSync(join(ws, '.secret'));
  mkdirSync(join(ws, 'node_modules'));
  writeFileSync(join(ws, 'notes', 'a.md'), '# Hello\n');
  writeFileSync(join(ws, 'todo.txt'), 'milk\n');
  writeFileSync(join(ws, '.env'), 'KEY=1\n');
  writeFileSync(join(ws, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(ws, 'page.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  writeFileSync(join(ws, 'doc.pdf'), '%PDF-1.4\n');
  writeFileSync(join(outside, 'private.txt'), 'not yours\n');
  symlinkSync(join(outside, 'private.txt'), join(ws, 'link.txt'));
  viewer = await createFilesViewer(ws, { token: TOKEN });
  await new Promise((resolve) => viewer.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${viewer.server.address().port}`;
});
after(async () => {
  await viewer.close();
  rmSync(ws, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const call = (path, init = {}, token = TOKEN) =>
  fetch(base + path, { ...init, headers: { ...(token ? { 'x-files-token': token } : {}), ...(init.headers ?? {}) } });
const save = (path, body, token = TOKEN) =>
  call(`/api/text?path=${encodeURIComponent(path)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, token);

test('the page carries its token, and nothing else answers without it', async () => {
  const page = await (await fetch(base + '/')).text();
  assert.match(page, /const TOKEN = 'test-token'/);
  assert.equal((await call('/api/list', {}, null)).status, 403);
  assert.equal((await call('/api/list', {}, 'wrong')).status, 403);
  assert.equal((await fetch(`${base}/raw?path=todo.txt`)).status, 403);
  assert.equal((await save('todo.txt', { text: 'x', version: null }, null)).status, 403);
});

test('lists a folder, folders first, without dot-files or node_modules', async () => {
  const body = await (await call('/api/list')).json();
  assert.deepEqual(body.entries.map((e) => `${e.name}:${e.kind}`),
    ['notes:folder', 'doc.pdf:pdf', 'link.txt:text', 'page.svg:image', 'pic.png:image', 'todo.txt:text']);
  const notes = await (await call('/api/list?path=notes')).json();
  assert.deepEqual(notes.entries.map((e) => e.path), ['notes/a.md']);
  for (const path of ['.secret', 'node_modules', '..', '../..', '/etc']) {
    assert.equal((await call(`/api/list?path=${encodeURIComponent(path)}`)).status, 404, path);
  }
});

test('reads and saves a text file, refusing a save over a change it has not seen', async () => {
  const opened = await (await call('/api/text?path=notes/a.md')).json();
  assert.equal(opened.text, '# Hello\n');
  const saved = await save('notes/a.md', { text: '# Xin chào\n', version: opened.version });
  assert.equal(saved.status, 200);
  assert.equal(readFileSync(join(ws, 'notes', 'a.md'), 'utf8'), '# Xin chào\n');
  // The same old version again: the file has moved on since.
  const stale = await save('notes/a.md', { text: 'overwrite', version: opened.version });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).version, statSync(join(ws, 'notes', 'a.md')).mtimeMs);
  assert.equal(readFileSync(join(ws, 'notes', 'a.md'), 'utf8'), '# Xin chào\n');
});

test('makes a new text file, never over an existing one', async () => {
  assert.equal((await save('notes/new.txt', { text: 'hi', version: null })).status, 200);
  assert.equal(readFileSync(join(ws, 'notes', 'new.txt'), 'utf8'), 'hi');
  assert.equal((await save('todo.txt', { text: 'gone', version: null })).status, 409);
  assert.equal(readFileSync(join(ws, 'todo.txt'), 'utf8'), 'milk\n');
});

test('writes nothing outside the folder, hidden, or not text', async () => {
  for (const path of ['../escape.txt', '/tmp/escape.txt', '.env', '.secret/a.txt', 'node_modules/a.txt', 'nowhere/a.txt']) {
    const res = await save(path, { text: 'x', version: null });
    assert.notEqual(res.status, 200, path);
  }
  assert.equal(existsSync(join(dirname(ws), 'escape.txt')), false);
  assert.equal((await save('pic.png', { text: 'x', version: statSync(join(ws, 'pic.png')).mtimeMs })).status, 415);
  // A link out of the folder is neither read nor written.
  assert.equal((await call('/api/text?path=link.txt')).status, 404);
  assert.equal((await save('link.txt', { text: 'x', version: null })).status, 404);
  assert.equal(readFileSync(join(outside, 'private.txt'), 'utf8'), 'not yours\n');
});

test('serves pictures and PDFs inline, and a file on its own never runs as a page', async () => {
  const png = await call('/raw?path=pic.png');
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.match(png.headers.get('content-security-policy'), /sandbox/);
  const svg = await fetch(`${base}/raw?path=page.svg&t=${TOKEN}`);
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get('content-security-policy'), /sandbox/);
  const pdf = await call('/raw?path=doc.pdf');
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(pdf.headers.get('content-security-policy'), null);
  assert.equal((await call('/raw?path=.env')).status, 404);
});

test('tells the page when a file changes', async () => {
  const controller = new AbortController();
  const res = await fetch(`${base}/events?t=${TOKEN}`, { signal: controller.signal });
  const reader = res.body.getReader();
  await reader.read(); // ready
  writeFileSync(join(ws, 'todo.txt'), 'eggs\n');
  let seen = '';
  while (!seen.includes('event: change')) seen += new TextDecoder().decode((await reader.read()).value);
  assert.match(seen, /todo\.txt/);
  controller.abort();
});

test('names what the pane does with each file', () => {
  assert.equal(kindOf('a.MD'), 'markdown');
  assert.equal(kindOf('b.json'), 'text');
  assert.equal(kindOf('c.jpeg'), 'image');
  assert.equal(kindOf('d.pdf'), 'pdf');
  assert.equal(kindOf('e.zip'), 'other');
});

test('init seeds a first verdict once and copies nothing into the folder', () => {
  const folder = mkdtempSync(join(tmpdir(), 'files-init-'));
  try {
    execFileSync('sh', [join(here, '..', 'toolchain', 'init-workspace.sh')], { cwd: folder });
    const verdict = JSON.parse(readFileSync(join(folder, '.harness', 'verdict.json'), 'utf8'));
    assert.equal(verdict.spec, 1);
    writeFileSync(join(folder, '.harness', 'verdict.json'), '{"spec":1,"ready":false}');
    execFileSync('sh', [join(here, '..', 'toolchain', 'init-workspace.sh')], { cwd: folder });
    assert.equal(readFileSync(join(folder, '.harness', 'verdict.json'), 'utf8'), '{"spec":1,"ready":false}');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
