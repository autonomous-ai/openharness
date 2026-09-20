import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createServer } from '../src/server.mjs';
import { createViewerRelay } from '../src/viewer-relay.mjs';

test('loopback API enforces origin, host, token and action validation boundaries', async t => {
  const controller = new EventEmitter(); let mutations = 0;
  controller.snapshot = () => ({ runtime: { models: [] }, jobs: [] }); controller.refresh = async () => {};
  controller.command = async text => { mutations++; return { kind: 'reply', message: text }; };
  const server = createServer(controller);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeEvents(); server.closeAllConnections(); server.close(resolve); }));
  const port = server.address().port; const base = `http://127.0.0.1:${port}`;
  const { token } = await (await fetch(`${base}/api/state`)).json(); assert.equal(token.length, 64);
  const post = headers => fetch(`${base}/api/command`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{"text":"show my models"}' });
  assert.equal((await post({})).status, 403);
  assert.equal((await post({ 'X-Harness-Token': token, Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await post({ 'X-Harness-Token': token, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post({ 'X-Harness-Token': token, 'Content-Type': 'text/plain' })).status, 415);
  const hostileHost = await new Promise(resolve => { const req = http.get({ host: '127.0.0.1', port, path: '/api/state', headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', e => { throw e; }); });
  assert.equal(hostileHost, 403); assert.equal(mutations, 0);
  assert.equal((await post({ 'X-Harness-Token': token, Origin: base })).status, 200); assert.equal(mutations, 1);
  assert.equal((await fetch(`${base}/api/command`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Harness-Token': token }, body: '{broken' })).status, 400);
  assert.equal((await fetch(`${base}/api/command`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Harness-Token': token }, body: JSON.stringify({ text: 'a'.repeat(70000) }) })).status, 413);
  assert.equal((await fetch(`${base}/src/server.mjs`)).status, 404);
});

test('native viewer relay shares the controller and preserves mutation boundaries', async t => {
  const controller = new EventEmitter(); let count = 0;
  controller.snapshot = () => ({ runtime: { models: [{ id: 'fixture:latest' }] }, jobs: [] }); controller.refresh = async () => {};
  controller.command = async text => { count++; return { message: text }; };
  const primary = createServer(controller); await new Promise(resolve => primary.listen(0, '127.0.0.1', resolve));
  const relay = createViewerRelay(primary.address().port); await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
  t.after(async () => { relay.closeAllConnections(); await new Promise(resolve => relay.close(resolve)); primary.closeEvents(); primary.closeAllConnections(); await new Promise(resolve => primary.close(resolve)); });
  const base = `http://127.0.0.1:${relay.address().port}`;
  const inventory = await (await fetch(`${base}/api/state`)).json(); assert.equal(inventory.runtime.models[0].id, 'fixture:latest');
  const post = extra => fetch(`${base}/api/command`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Harness-Token': inventory.token, ...extra }, body: '{"text":"show models"}' });
  assert.equal((await post({ Origin: 'https://untrusted.example' })).status, 403); assert.equal(count, 0);
  assert.equal((await post({ 'X-Harness-Token': '' })).status, 403);
  assert.equal((await post({ Origin: base })).status, 200); assert.equal(count, 1);
});
