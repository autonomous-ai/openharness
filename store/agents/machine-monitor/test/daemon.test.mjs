import assert from 'node:assert/strict';
import test from 'node:test';
import { bridgeUrl, daemonBase, listHarnesses } from '../lib/daemon.mjs';

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
