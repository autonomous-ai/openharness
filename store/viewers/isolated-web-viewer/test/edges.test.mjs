// The edges of the preview server, in process: requests a browser never sends, files it cannot
// serve, and the watcher and heartbeat the live reload depends on (driven directly, not waited for).
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import { chmod, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createHtmlViewer } from '../viewer.mjs';

let workspace, server, base, port, watcher, heartbeat;

// The server's fs.watch and setInterval, captured as it makes them, so a test can fire them.
before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'web-viewer-edges-'));
  await writeFile(join(workspace, 'index.html'), '<h1>Hello</h1>');
  const realWatch = fs.watch;
  const realSetInterval = globalThis.setInterval;
  fs.watch = (...args) => { watcher = realWatch(...args); return watcher; };
  syncBuiltinESMExports();
  globalThis.setInterval = (fn, ms) => { heartbeat = { fn, ms }; return realSetInterval(fn, ms); };
  try {
    server = await createHtmlViewer(workspace);
  } finally {
    fs.watch = realWatch;
    syncBuiltinESMExports();
    globalThis.setInterval = realSetInterval;
  }
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});
after(async () => {
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  await rm(workspace, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A raw request, for what fetch would refuse to send or would normalise first. */
function raw(text) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(text));
    let answer = '';
    socket.on('data', (chunk) => { answer += chunk; });
    socket.on('end', () => resolve(answer));
    socket.on('error', reject);
  });
}

/** An open event stream: everything it has said so far, and a way to wait for more. */
async function subscribe() {
  const stop = new AbortController();
  const response = await fetch(base + '/events', { signal: stop.signal });
  const reader = response.body.getReader();
  const stream = { text: '', ended: false };
  let pending = null; // one read at a time, kept across timeouts so no chunk is lost
  stream.read = async (ms) => {
    const deadline = Date.now() + ms;
    while (!stream.ended && Date.now() < deadline) {
      pending ??= reader.read().catch(() => ({ done: true }));
      const result = await Promise.race([pending, sleep(Math.max(1, deadline - Date.now())).then(() => null)]);
      if (!result) break;
      pending = null;
      if (result.done) stream.ended = true;
      else stream.text += new TextDecoder().decode(result.value);
      if (stream.stopWhen?.(stream.text)) break;
    }
    return stream.text;
  };
  stream.until = async (needle, ms = 5000) => {
    stream.stopWhen = (text) => text.includes(needle);
    await stream.read(ms);
    stream.stopWhen = null;
    return stream.text.includes(needle);
  };
  stream.stop = () => stop.abort();
  assert.ok(await stream.until(': connected'));
  return stream;
}

test('the watcher reloads on a visible change, ignores hidden paths, and reports its own failure', async () => {
  const events = await subscribe();
  const reloads = () => events.text.split('event: change').length - 1;
  try {
    await events.read(500); // FSEvents may still report the workspace being written just before the watch began
    const quiet = reloads();
    watcher.emit('change', 'change', '.git/index');
    watcher.emit('change', 'change', 'node_modules/x/index.js');
    await events.read(300); // a reload scheduled for those would arrive in here
    assert.equal(reloads(), quiet, 'hidden paths do not reload the preview');
    watcher.emit('change', 'rename', null); // FSEvents may not name the file: still a change
    const deadline = Date.now() + 5000;
    while (reloads() === quiet && Date.now() < deadline) await events.read(100);
    assert.equal(reloads(), quiet + 1);
    assert.match(events.text, /event: change\ndata: reload\n\n/);
    watcher.emit('error', new Error('watch stopped'));
    assert.ok(await events.until('event: watch-error\ndata: Use Reload to see changes.'));
  } finally { events.stop(); }
});

test('the heartbeat keeps an open stream alive every 15 s', async () => {
  assert.equal(heartbeat.ms, 15000);
  const events = await subscribe();
  try {
    heartbeat.fn();
    assert.ok(await events.until(': alive'));
  } finally { events.stop(); }
});

test('HEAD of the shell answers without a body', async () => {
  const head = await fetch(base + '/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.match(head.headers.get('content-type'), /text\/html/);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test('only GET subscribes to events, and paths outside /files/ or naming no file are not found', async () => {
  assert.equal((await fetch(base + '/events', { method: 'HEAD' })).status, 404);
  assert.equal((await fetch(base + '/elsewhere')).status, 404);
  assert.equal((await fetch(base + '/files/')).status, 404);
  assert.match(await raw('GET /files//etc/hosts HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 404/);
  assert.match(await raw('GET /files/x%2F.. HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 404/, 'the workspace folder itself is not a file');
});

test('a request with no Host header is refused, and an unparseable target is a 400, not a crash', async () => {
  assert.match(await raw('GET /files/index.html HTTP/1.0\r\n\r\n'), /^HTTP\/1\.1 403/);
  assert.match(await raw('GET http://a:99999/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 400/);
  assert.equal((await fetch(base + '/files/index.html')).status, 200, 'still serving');
});

test('a file of a type it does not know is served as bytes, and the browser is told not to guess', async () => {
  await writeFile(join(workspace, 'model.stl'), 'solid x\nendsolid x\n');
  const response = await fetch(base + '/files/model.stl');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await response.text(), /endsolid/);
});

test('a file over 32 MiB is refused with 413', async () => {
  await writeFile(join(workspace, 'huge.bin'), '');
  await truncate(join(workspace, 'huge.bin'), 32 * 1024 * 1024 + 1);
  const response = await fetch(base + '/files/huge.bin');
  assert.equal(response.status, 413);
  assert.match(await response.text(), /smaller than 32 MiB/);
});

test('a file that cannot be read ends its response instead of hanging or crashing', { skip: process.getuid?.() === 0 && 'root reads anything' }, async () => {
  await writeFile(join(workspace, 'locked.txt'), 'secret');
  await chmod(join(workspace, 'locked.txt'), 0o000);
  try {
    await assert.rejects(async () => { await (await fetch(base + '/files/locked.txt')).text(); });
  } finally {
    await chmod(join(workspace, 'locked.txt'), 0o644);
  }
  assert.equal((await fetch(base + '/files/index.html')).status, 200, 'still serving');
});

test('closing the server ends the streams still open and stops watching', async () => {
  const events = await subscribe();
  let watcherClosed = false;
  watcher.once('close', () => { watcherClosed = true; });
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await events.read(5000);
  assert.equal(events.ended, true, 'the stream ended');
  assert.equal(watcherClosed, true);
});
