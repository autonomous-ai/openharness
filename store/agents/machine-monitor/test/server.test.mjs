import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createViewer } from '../viewer.mjs';

const SNAPSHOT = {
  spec: 1, status: 'live', observedAt: '2026-09-20T10:00:00.000Z', pollIntervalMs: 15_000,
  account: { email: 'someone@example.com', name: 'Someone' }, localMachineId: 'a'.repeat(32),
  thisComputer: { machineId: 'a'.repeat(32), version: '0.2.0', connected: true, remotePasswordSet: true },
  machines: [
    { id: 'a'.repeat(32), name: 'Studio', local: true, status: 'online', needsLink: false, harnesses: [], harnessCount: 0, openCount: 0, projectCount: 0 },
    { id: 'b'.repeat(32), name: 'Rack', local: false, status: 'online', needsLink: true, harnesses: [], harnessCount: 0, openCount: 0, projectCount: 0 },
  ],
  projects: [], summary: { machines: 2, online: 2, needsLink: 1, harnesses: 0, open: 0, projects: 0, engines: {} }, sources: {},
};

async function serve(collect = async () => SNAPSHOT) {
  const workspace = await mkdtemp(join(tmpdir(), 'machines-server-'));
  const viewer = createViewer({ workspace, port: 0, intervalMs: 60_000, collect });
  const port = await viewer.start();
  test.after(async () => { await viewer.close(); await rm(workspace, { recursive: true, force: true }); });
  return { base: `http://127.0.0.1:${port}`, workspace };
}

test('the pane serves its own observation and its three files', async () => {
  const { base } = await serve();
  const snapshot = await (await fetch(`${base}/api/snapshot`)).json();
  assert.equal(snapshot.summary.machines, 2);

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(await page.text(), /<title>Machine Monitor/);

  for (const path of ['/app.js', '/app.css']) assert.equal((await fetch(`${base}${path}`)).status, 200);
  assert.equal((await fetch(`${base}/../lib/daemon.mjs`)).status, 404);
});

/** The first poll runs as the server starts; wait for what it writes rather than racing it. */
async function eventually(read, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await read(); } catch { await new Promise(done => setTimeout(done, 25)); }
  }
  return read();
}

test('the observation is published to the workspace, with a verdict beside it', async () => {
  const { workspace } = await serve();
  const published = await eventually(async () => JSON.parse(await readFile(join(workspace, '.harness', 'snapshot.json'), 'utf8')));
  assert.equal(published.machines.length, 2);
  const verdict = await eventually(async () => JSON.parse(await readFile(join(workspace, '.harness', 'verdict.json'), 'utf8')));
  assert.equal(verdict.spec, 1);
  assert.equal(verdict.summary, '2 machines · 2 online · 0 harnesses');
});

test('a request that was not addressed to this loopback port is refused', async () => {
  const { base } = await serve();
  const port = Number(new URL(base).port);
  // `fetch` will not let a caller set Host, and that is exactly the header the guard reads — so this
  // one goes out over a plain socket, the way a page on another origin would reach the port.
  const status = await new Promise((done, fail) => {
    const call = request({ host: '127.0.0.1', port, path: '/api/snapshot', headers: { host: 'somewhere.example.com' } }, response => {
      response.resume();
      done(response.statusCode);
    });
    call.on('error', fail);
    call.end();
  });
  assert.equal(status, 403);
});

test('the pane takes no writes but the one', async () => {
  const { base } = await serve();
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const response = await fetch(`${base}/api/snapshot`, { method });
    assert.equal(response.status, 405);
    assert.match((await response.json()).error, /read-only/);
  }
  const post = await fetch(`${base}/api/rename`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(post.status, 405);
});

test('a link request is checked before anything is run', async () => {
  const { base } = await serve();
  const link = (body) => fetch(`${base}/api/link`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const unknown = await link({ machineId: 'z'.repeat(32), password: 'hunter2hunter2' });
  assert.equal(unknown.status, 404);

  const empty = await link({ machineId: 'b'.repeat(32), password: '  ' });
  assert.equal(empty.status, 400);
  assert.match((await empty.json()).error, /remote password/);

  const huge = await fetch(`${base}/api/link`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(5000) });
  assert.equal(huge.status, 413);
});

test('a reading that throws leaves the machines on screen, marked stale, and says what happened', async () => {
  let fail = false;
  const workspace = await mkdtemp(join(tmpdir(), 'machines-server-'));
  const viewer = createViewer({
    workspace, port: 0, intervalMs: 30,
    collect: async () => { if (fail) throw new Error('the daemon went away'); return SNAPSHOT; },
  });
  const port = await viewer.start();
  test.after(async () => { await viewer.close(); await rm(workspace, { recursive: true, force: true }); });

  const read = async () => (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json();
  assert.equal((await eventually(async () => {
    const snapshot = await read();
    if (snapshot.status !== 'live') throw new Error('not yet');
    return snapshot;
  })).machines.length, 2);

  fail = true;
  const broken = await eventually(async () => {
    const snapshot = await read();
    if (snapshot.status !== 'unavailable') throw new Error('not yet');
    return snapshot;
  });
  assert.equal(broken.machines.length, 2, 'the machines stay until a new reading replaces them');
  assert.ok(broken.machines.every(machine => machine.stale), 'and every one of them is marked stale');
  assert.match(broken.sources.collector.error, /went away/);
});

test('the event stream opens with the current observation', async () => {
  const { base } = await serve();
  const response = await fetch(`${base}/events`);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body.getReader();
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  assert.match(text, /^event: snapshot/);
  assert.match(text, /"status":"live"/);
  await reader.cancel();
});
