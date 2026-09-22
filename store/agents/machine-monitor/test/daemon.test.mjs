import assert from 'node:assert/strict';
import test from 'node:test';
import { bridgeUrl, closeSessions, daemonBase, listHarnesses } from '../lib/daemon.mjs';

test('the daemon address must be loopback http, and the bridge follows it', () => {
  assert.equal(daemonBase({}).href, 'http://127.0.0.1:18473/');
  assert.equal(bridgeUrl({}), 'ws://127.0.0.1:18473/api/local-ws');
  assert.equal(bridgeUrl({ HARNESS_MACHINES_DAEMON: 'http://localhost:9999/' }), 'ws://localhost:9999/api/local-ws');
  for (const bad of ['https://127.0.0.1:18473/', 'http://example.com/', 'http://user:pw@127.0.0.1/', 'http://127.0.0.1/?x=1']) {
    assert.throws(() => daemonBase({ HARNESS_MACHINES_DAEMON: bad }), /loopback/, bad);
  }
});

/** A WebSocket that plays one scripted exchange, so the roster read is testable without a daemon. */
function scripted({ frames = [], closeWith = null, onSend = () => {} }) {
  return class {
    constructor() {
      this.listeners = {};
      queueMicrotask(() => {
        this.fire('open', {});
        for (const frame of frames) this.fire('message', { data: JSON.stringify(frame) });
        if (closeWith) this.fire('close', closeWith);
      });
    }
    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler); }
    fire(type, event) { for (const handler of this.listeners[type] ?? []) handler(event); }
    send(raw) { onSend(JSON.parse(raw), this); }
    close() {}
  };
}

test('a roster read selects the machine, asks once, and returns what came back', async () => {
  const sent = [];
  const WebSocketImpl = scripted({
    frames: [{ type: 'connected', payload: { transport: 'local' } }],
    onSend: (frame, socket) => {
      sent.push(frame);
      if (frame.type === 'agents_list') {
        // The daemon reads the id from the payload and echoes it back there.
        socket.fire('message', { data: JSON.stringify({ type: 'agents_list_result', payload: { requestId: frame.payload.requestId, agents: [{ id: 'h1' }] } }) });
      }
    },
  });
  const result = await listHarnesses('a'.repeat(32), { WebSocketImpl, timeoutMs: 500 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.harnesses, [{ id: 'h1' }]);
  assert.equal(sent[0].type, 'machine_select');
  assert.equal(sent[0].payload.relayIsolation, true, 'a poll must not disturb the window the person is using');
  assert.equal(sent[1].type, 'agents_list');
  assert.equal(typeof sent[1].payload.requestId, 'string');
});

test('a reply for another request is ignored', async () => {
  const WebSocketImpl = scripted({
    frames: [
      { type: 'connected', payload: {} },
      { type: 'agents_list_result', payload: { requestId: 'someone-else', agents: [{ id: 'not mine' }] } },
    ],
  });
  const result = await listHarnesses('a'.repeat(32), { WebSocketImpl, timeoutMs: 120 });
  assert.equal(result.ok, false);
  assert.match(result.error, /did not answer in time/);
});

test('an unlinked machine is a state with a name, not a failure', async () => {
  const WebSocketImpl = scripted({ closeWith: { code: 4404, reason: 'NO_PEER_LINK' } });
  const result = await listHarnesses('a'.repeat(32), { WebSocketImpl, timeoutMs: 500 });
  assert.equal(result.ok, false);
  assert.equal(result.needsLink, true);
  assert.match(result.error, /not linked/);
});

test('a refused connection is reported without claiming the machine is empty', async () => {
  const WebSocketImpl = scripted({ closeWith: { code: 4403, reason: 'machine mismatch' } });
  const result = await listHarnesses('a'.repeat(32), { WebSocketImpl, timeoutMs: 500 });
  assert.equal(result.ok, false);
  assert.equal(result.needsLink, undefined);
  assert.equal(result.harnesses, undefined);
});

test('without a WebSocket there is an answer, not a crash', async () => {
  const result = await listHarnesses('a'.repeat(32), { WebSocketImpl: null });
  assert.equal(result.ok, false);
  assert.match(result.error, /Node 22/);
});

/** A scripted socket class that also counts its instances and can be closed from the test. */
function scriptedFactory({ answer = true, closeAfterAnswer = false } = {}) {
  const made = [];
  const sent = [];
  const Impl = class {
    constructor() {
      made.push(this);
      this.listeners = {};
      queueMicrotask(() => {
        this.fire('open', {});
        this.fire('message', { data: JSON.stringify({ type: 'connected', payload: { machineId: 'a'.repeat(32), relayIsolation: true } }) });
      });
    }
    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler); }
    fire(type, event) { for (const handler of this.listeners[type] ?? []) handler(event); }
    send(raw) {
      const frame = JSON.parse(raw);
      sent.push(frame);
      if (frame.type === 'agents_list' && answer) {
        this.fire('message', { data: JSON.stringify({ type: 'agents_list_result', payload: { requestId: frame.payload.requestId, agents: [{ id: 'h' + made.length }] } }) });
        if (closeAfterAnswer) this.fire('close', { code: 1000 });
      }
    }
    close() {}
  };
  return { Impl, made, sent };
}

test('a second read on the same machine reuses the bridge socket: one select, two asks', async () => {
  const { Impl, made, sent } = scriptedFactory();
  const first = await listHarnesses('a'.repeat(32), { WebSocketImpl: Impl, timeoutMs: 500 });
  const second = await listHarnesses('a'.repeat(32), { WebSocketImpl: Impl, timeoutMs: 500 });
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  assert.equal(made.length, 1, 'no second socket');
  assert.deepEqual(sent.map(f => f.type), ['machine_select', 'agents_list', 'agents_list']);
  assert.notEqual(sent[1].payload.requestId, sent[2].payload.requestId);
  closeSessions();
});

test('a socket that closed is replaced on the next read', async () => {
  const { Impl, made, sent } = scriptedFactory({ closeAfterAnswer: true });
  assert.equal((await listHarnesses('a'.repeat(32), { WebSocketImpl: Impl, timeoutMs: 500 })).ok, true);
  assert.equal((await listHarnesses('a'.repeat(32), { WebSocketImpl: Impl, timeoutMs: 500 })).ok, true);
  assert.equal(made.length, 2, 'the close was noticed and a fresh socket opened');
  assert.deepEqual(sent.map(f => f.type), ['machine_select', 'agents_list', 'machine_select', 'agents_list']);
  closeSessions();
});

test('a reused socket that stops answering is dropped and the read retried once on a fresh one', async () => {
  let answering = true;
  const made = [];
  const selects = [];
  const Impl = class {
    constructor() {
      made.push(this); this.listeners = {};
      queueMicrotask(() => { this.fire('open', {}); this.fire('message', { data: JSON.stringify({ type: 'connected', payload: {} }) }); });
    }
    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler); }
    fire(type, event) { for (const handler of this.listeners[type] ?? []) handler(event); }
    send(raw) {
      const frame = JSON.parse(raw);
      if (frame.type === 'machine_select') selects.push(frame.payload);
      if (frame.type !== 'agents_list') return;
      // The first socket answers once, then goes mute; every later socket answers.
      if (made.indexOf(this) === 0 && !answering) return;
      this.fire('message', { data: JSON.stringify({ type: 'agents_list_result', payload: { requestId: frame.payload.requestId, agents: [{ id: 'from-' + made.indexOf(this) }] } }) });
    }
    close() {}
  };
  assert.deepEqual((await listHarnesses('a'.repeat(32), { WebSocketImpl: Impl, timeoutMs: 100 })).harnesses, [{ id: 'from-0' }]);
  answering = false;
  const result = await listHarnesses('a'.repeat(32), { WebSocketImpl: Impl, timeoutMs: 100 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.harnesses, [{ id: 'from-1' }], 'answered by the replacement socket');
  assert.equal(made.length, 2);
  assert.equal(selects[0].forceReconnect, undefined);
  assert.equal(selects[1].forceReconnect, true, 'the retry tells Harness its kept session is dead');
  closeSessions();
});
