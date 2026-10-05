import assert from 'node:assert/strict';
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
  assert.doesNotMatch(html, /<script\b/i, 'The OS page must not load an app runtime');
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
  const types = { css: /text\/css/, svg: /image\/svg\+xml/, png: /image\/png/, woff: /font\/woff|application\/font-woff/ };
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
  await readFile(fileURLToPath(new URL(value, root)));
}
console.log(`Harness /os: three entry paths and ${verified} assets match the approved static source.`);
