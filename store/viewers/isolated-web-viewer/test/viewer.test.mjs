import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { createHtmlViewer } from '../viewer.mjs';

let root, workspace, server, base;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'openharness-html-'));
  workspace = join(root, 'workspace');
  await cp(fileURLToPath(new URL('../../../examples/hello-world/template', import.meta.url)), workspace, { recursive: true });
  await mkdir(join(workspace, 'pages'));
  await writeFile(join(workspace, 'pages', 'demo.html'), '<h1>A nested page</h1>');
  await writeFile(join(workspace, 'pages', 'style.css'), 'h1 { color: green; }');
  await writeFile(join(workspace, '.env'), 'PRIVATE=do-not-serve');
  await writeFile(join(root, 'outside.txt'), 'outside the workspace');
  await symlink(join(root, 'outside.txt'), join(workspace, 'outside.txt'));
  await symlink(join(workspace, '.env'), join(workspace, 'hidden.txt'));
  server = await createHtmlViewer(workspace);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  if (root) await rm(root, { recursive: true, force: true });
});

test('serves the actual Hello World page and a sandboxed preview shell', async () => {
  const shell = await fetch(base);
  assert.equal(shell.status, 200);
  const html = await shell.text();
  assert.match(html, /sandbox="allow-scripts allow-downloads allow-pointer-lock"/);
  assert.doesNotMatch(html, /allow-same-origin/);
  const page = await fetch(base + '/files/index.html');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(await page.text(), /Hello, world!/);
  const css = await fetch(base + '/files/pages/style.css');
  assert.match(css.headers.get('content-type'), /text\/css/);
  assert.match(await css.text(), /green/);
  assert.match(await (await fetch(base + '/files/pages/demo.html')).text(), /nested page/);
});

test('only the unguessable preview path grants an opaque sandbox access to public assets', async () => {
  const html = await (await fetch(base)).text();
  const prefix = html.match(/const prefix = '(\/preview\/[a-f0-9]{48}\/)'/)[1];
  const response = await fetch(base + prefix + 'pages/style.css', { headers: { Origin: 'null' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'null');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  assert.equal((await fetch(base + '/files/pages/style.css')).headers.get('access-control-allow-origin'), null);
  assert.equal((await fetch(base)).headers.get('access-control-allow-origin'), null);
  assert.equal((await fetch(base + '/preview/wrong/pages/style.css')).status, 404);
  for (const file of ['.env', 'outside.txt', 'hidden.txt', '%2e%2e%2foutside.txt']) {
    assert.equal((await fetch(base + prefix + file)).status, 404, file);
  }
  await writeFile(join(workspace, 'engine.wasm'), Buffer.from([0,97,115,109,1,0,0,0]));
  assert.equal((await fetch(base + prefix + 'engine.wasm')).headers.get('content-type'), 'application/wasm');
});

test('WASM engines and PCK assets have a bounded 128 MiB allowance for real Godot exports', async () => {
  for (const name of ['large.wasm', 'large.pck']) {
    await writeFile(join(workspace,name),'');
    await truncate(join(workspace,name),44*1024*1024);
    assert.equal((await fetch(base+'/files/'+name,{method:'HEAD'})).status,200);
    await truncate(join(workspace,name),128*1024*1024+1);
    assert.equal((await fetch(base+'/files/'+name,{method:'HEAD'})).status,413);
  }
});

test('a workspace edit notifies the live preview and serves the new content', { timeout: 5000 }, async () => {
  const stop = new AbortController();
  try {
    const response = await fetch(base + '/events', { signal: stop.signal });
    const reader = response.body.getReader();
    await reader.read(); // Connected; the subscription exists before the write.
    await writeFile(join(workspace, 'index.html'), '<h1>Hello, Ada!</h1>');
    let events = '';
    while (!events.includes('event: change')) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      events += new TextDecoder().decode(value);
    }
    assert.match(await (await fetch(base + '/files/index.html')).text(), /Hello, Ada!/);
  } finally { stop.abort(); }
});

test('rejects traversal, private files, and symlinks that escape or expose hidden files', async () => {
  for (const path of ['/files/%2e%2e%2foutside.txt', '/files/.env', '/files/outside.txt', '/files/hidden.txt', '/files/pages', '/files/%00']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  assert.equal((await fetch(base + '/files/%ZZ')).status, 400);
});

test('is read-only and refuses a non-loopback Host header', async () => {
  assert.equal((await fetch(base + '/files/index.html', { method: 'POST', body: 'replace' })).status, 405);
  assert.equal((await fetch(base + '/files/index.html', { method: 'HEAD' })).status, 200);
  const status = await new Promise((resolve, reject) => {
    const req = request(base, { headers: { host: 'untrusted.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('shows a recoverable empty state before a page exists', async () => {
  const missing = await fetch(base + '/files/later.html');
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /No preview yet/);
  await writeFile(join(workspace, 'later.html'), '<p>Now ready</p>');
  assert.match(await (await fetch(base + '/files/later.html')).text(), /Now ready/);
});

test('Web Studio declares this viewer and the URL follows its actual artifact', async () => {
  const example = JSON.parse(await readFile(new URL('../../../agents/web-studio/harness.json', import.meta.url), 'utf8'));
  const viewer = JSON.parse(await readFile(new URL('../harness.json', import.meta.url), 'utf8'));
  assert.equal(example.viewer.use, viewer.id);
  assert.equal(new URL(viewer.viewer.url.replace('${port}', '4310').replace('${artifact}', example.workspace.marker)).searchParams.get('file'), example.workspace.marker);
  assert.equal(new URL(viewer.viewer.url.replace('${port}', '4310').replace('${artifact}', 'build-status.html')).searchParams.get('file'), 'build-status.html');
});
