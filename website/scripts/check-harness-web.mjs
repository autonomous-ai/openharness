import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { releaseAssetBase } from './harness-web-assets.mjs';

const base = new URL(process.argv[2] || 'http://127.0.0.1:3000');
const release = JSON.parse(await readFile(new URL('../harness-web-release.json', import.meta.url), 'utf8'));
const assetBase = releaseAssetBase(release);
// The front door is the web app; its old address `/web` sends there, temporarily, query and all.
const old = await fetch(new URL('/web?machine=fixture-machine&agent=fixture-agent', base), { redirect: 'manual' });
assert.equal(old.status, 307, '/web must redirect to the web app at /');
assert.equal(new URL(old.headers.get('location'), base).href, new URL('/?machine=fixture-machine&agent=fixture-agent', base).href);
for (const route of ['/', '/?viewer=1&machine=fixture-machine&agent=fixture-agent', '/s/11111111-1111-4111-8111-111111111111', '/auth/callback?code=fixture-code&state=fixture-state', '/callback', '/harness-web']) {
  const response = await fetch(new URL(route, base));
  assert.equal(response.status, 200, route);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const html = await response.text();
  assert.match(html, /<base href="\/harness-web\/">/);
  assert.match(html, /_flutter\.loader\.load\(/);
  assert.ok(html.includes(`"entrypointBaseUrl":"${assetBase}"`), 'Entrypoint must bypass previous-release caches');
  assert.ok(html.includes(`"assetBase":"${assetBase}"`), 'Fonts and assets must belong to the same release');
  assert.ok(!html.includes('Opening Harness'), 'The page must not flash a corner loading label');
  assert.ok(!html.includes('fixture-code'), 'Callback codes must not be embedded in the page');
}
for (const [route, type] of [
  [`${assetBase}main.dart.js`, /javascript/],
  [`${assetBase}assets/FontManifest.json`, /json/],
  [`${assetBase}canvaskit/chromium/canvaskit.wasm`, /application\/wasm/],
]) {
  const response = await fetch(new URL(route, base), { method: 'HEAD' });
  assert.equal(response.status, 200, route);
  assert.match(response.headers.get('content-type'), type);
  assert.match(response.headers.get('cache-control'), /immutable/);
  assert.ok(!response.headers.get('cache-control').includes('no-store'), route);
  const etag = response.headers.get('etag');
  assert.ok(etag, `Missing asset ETag: ${route}`);
  // Explicit revalidation avoids Node fetch's default no-store behavior when
  // callers supply conditional headers; browsers validate their cached assets.
  const cached = await fetch(new URL(route, base), {
    cache: 'no-cache', headers: { 'If-None-Match': etag },
  });
  assert.equal(cached.status, 304, `Unchanged asset must reuse cached bytes: ${route}`);
  assert.equal((await cached.arrayBuffer()).byteLength, 0);
  const stale = await fetch(new URL(route, base), {
    method: 'HEAD', cache: 'no-cache', headers: { 'If-None-Match': '"previous-release"' },
  });
  assert.equal(stale.status, 200, `Changed asset must load the new release: ${route}`);
}
// The bytes as sent, which fetch would decode on its own.
const raw = (url, acceptEncoding) => new Promise((resolve, reject) => {
  request(url, { headers: { 'accept-encoding': acceptEncoding } }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => resolve({ headers: response.headers, body: Buffer.concat(chunks) }));
  }).on('error', reject).end();
});
// Pre-compressed at build time (scripts/precompress.mjs): brotli to a browser that takes it, gzip
// to one that takes only gzip, the file as is to one that takes neither; one cache entry per encoding.
for (const route of [`${assetBase}main.dart.js`, `${assetBase}canvaskit/chromium/canvaskit.wasm`]) {
  const plain = await raw(new URL(route, base), 'identity');
  assert.equal(plain.headers['content-encoding'], undefined, route);
  for (const [acceptEncoding, encoding, decode] of [
    ['gzip, deflate, br, zstd', 'br', brotliDecompressSync],
    ['gzip, deflate', 'gzip', gunzipSync],
  ]) {
    const sent = await raw(new URL(route, base), acceptEncoding);
    assert.equal(sent.headers['content-encoding'], encoding, `${route} for ${acceptEncoding}`);
    assert.equal(sent.headers['content-type'], plain.headers['content-type'], route);
    assert.match(sent.headers.vary ?? '', /accept-encoding/i, route);
    assert.match(sent.headers['cache-control'], /immutable/, route);
    assert.ok(sent.body.length < plain.body.length, `${route} must be smaller as ${encoding}`);
    assert.ok(decode(sent.body).equals(plain.body), `${route} as ${encoding} must decode to the file`);
  }
}
const published = await (await fetch(new URL('/harness-web/release.json', base))).json();
assert.equal(published.version, release.version);
assert.equal(published.sourceCommit, release.sourceCommit);
for (const route of ['/download', '/desktop', '/pair']) {
  const response = await fetch(new URL(route, base), { redirect: 'manual' });
  assert.equal(response.status, 200, route);
  assert.match(await response.text(), /Harness/);
}
for (const [route, destination] of [
  ['/install.sh', 'https://cdn.autonomous.ai/harness/cli/install.sh'],
  ['/cli/install.sh', 'https://cdn.autonomous.ai/harness/cli/install.sh'],
  ['/desktop/install.sh', 'https://cdn.autonomous.ai/harness/desktop/install.sh'],
]) {
  const response = await fetch(new URL(route, base), { redirect: 'manual' });
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), destination);
}
console.log(`Harness Web ${release.version}: entry, shared-agent links, callback, assets, download and phone setup pages, and installer redirects passed.`);
