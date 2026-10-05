import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const base = new URL(process.argv[2] || 'http://127.0.0.1:3000');
const root = new URL('../public/os/', import.meta.url);
const expected = await readFile(new URL('index.html', root), 'utf8');
const requests = { signal: AbortSignal.timeout(20_000) };
for (const route of ['/os', '/os/', '/os/index.html']) {
  const response = await fetch(new URL(route, base), requests);
  assert.equal(response.status, 200, route);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.match(response.headers.get('cache-control'), /no-transform/);
  const html = await response.text();
  assert.equal(html, expected, 'Serve the approved HTML unchanged');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1, 'Only the local product illustration needs JavaScript');
  assert.match(scripts[0][1], /\bsrc="demo\.js\?v=[a-f0-9]{12}"/);
  assert.match(scripts[0][1], /\bdefer\b/);
  assert.equal(scripts[0][2].trim(), '', 'No inline app runtime');
  assert.match(html, /class="install" href="https:\/\/harness\.autonomous\.ai\/os\/latest"/);
  assert.match(html, /<base href="\/os\/">/);
}

const names = await readdir(root, { recursive: true });
let verified = 0;
for (const name of names) {
  if (name === 'assets' || name === 'index.html' || name.endsWith('.md')) continue;
  const local = await readFile(new URL(name, root));
  const response = await fetch(new URL(`/os/${name}`, base), requests);
  assert.equal(response.status, 200, name);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), local, `${name} bytes differ`);
  const types = { css: /text\/css/, js: /(?:text|application)\/javascript/, svg: /image\/svg\+xml/, png: /image\/png/, woff: /font\/woff|application\/font-woff/ };
  const type = types[name.split('.').at(-1)];
  if (type) assert.match(response.headers.get('content-type'), type, name);
  verified++;
}
// All relative HTML URLs stay under /os/ even when the entry URL has no slash.
const documentBase = new URL('/os/', base);
for (const [, value] of expected.matchAll(/(?:href|src)="([^"]+)"/g)) {
  if (/^(?:https?:|#)/.test(value)) continue;
  const url = new URL(value, documentBase);
  assert.equal(url.origin, base.origin);
  assert.ok(url.pathname.startsWith('/os/'), value);
  if (value === '/os/') continue;
  const bytes = await readFile(fileURLToPath(new URL(value, root)));
  if (/\.(?:css|js)$/.test(url.pathname)) {
    assert.equal(url.searchParams.get('v'), createHash('sha256').update(bytes).digest('hex').slice(0, 12),
      'Styles and animation must carry their current content hash');
  }
}
const download = await fetch(new URL('/os/latest', base), { ...requests, redirect: 'manual' });
assert.equal(download.status, 302, 'The Install link must resolve to an already-published OS release');
assert.match(download.headers.get('location'), /^https:\/\/github\.com\/autonomous-ai\/openharness\/releases\/tag\/os-v\d+\.\d+\.\d+(?:-preview\.\d+)?$/);
assert.match(download.headers.get('cache-control'), /no-store/);
console.log(`Harness /os: three entry paths and ${verified} assets match the approved static source.`);
