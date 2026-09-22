import assert from 'node:assert/strict'
import { test } from 'node:test'
import { closeBridges, listAgents, withBridge } from '../lib/bridge.mjs'

/** A scripted bridge socket class: selects on open, answers agents_list, counts its instances. */
function scripted({ answer = true, closeAfterAnswer = false, muteAfter = Infinity } = {}) {
  const made = []
  const sent = []
  let answered = 0
  const Impl = class {
    constructor() {
      made.push(this); this.listeners = {}
      queueMicrotask(() => {
        this.fire('open', {})
        this.fire('message', { data: JSON.stringify({ type: 'connected', payload: { machineId: 'm', relayIsolation: true } }) })
      })
    }
    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler) }
    fire(type, event) { for (const handler of this.listeners[type] ?? []) handler(event) }
    send(raw) {
      const frame = JSON.parse(raw)
      sent.push(frame)
      if (frame.type !== 'agents_list' || !answer || answered >= muteAfter) return
      answered += 1
      this.fire('message', { data: JSON.stringify({ type: 'agents_list_result', payload: { requestId: frame.payload.requestId, agents: [{ id: `from-${made.indexOf(this)}` }] } }) })
      if (closeAfterAnswer) this.fire('close', { code: 1000 })
    }
    close() {}
  }
  return { Impl, made, sent }
}

test('a second read on the same machine reuses the kept socket: one select, two asks', async () => {
  const { Impl, made, sent } = scripted()
  assert.deepEqual(await listAgents('m', { WebSocketImpl: Impl, timeoutMs: 500 }), [{ id: 'from-0' }])
  assert.deepEqual(await listAgents('m', { WebSocketImpl: Impl, timeoutMs: 500 }), [{ id: 'from-0' }])
  assert.equal(made.length, 1)
  assert.deepEqual(sent.map((f) => f.type), ['machine_select', 'agents_list', 'agents_list'])
  assert.equal(sent[1].payload.requestId === sent[2].payload.requestId, false)
  closeBridges()
})

test('a kept socket that closed is replaced on the next read', async () => {
  const { Impl, made, sent } = scripted({ closeAfterAnswer: true })
  await listAgents('m', { WebSocketImpl: Impl, timeoutMs: 500 })
  await listAgents('m', { WebSocketImpl: Impl, timeoutMs: 500 })
  assert.equal(made.length, 2)
  assert.deepEqual(sent.map((f) => f.type), ['machine_select', 'agents_list', 'machine_select', 'agents_list'])
  closeBridges()
})

test('a kept socket that goes quiet is dropped and the read retried once on a fresh one', async () => {
  const { Impl, made, sent } = scripted({ muteAfter: 1 })
  assert.deepEqual(await listAgents('m', { WebSocketImpl: Impl, timeoutMs: 80 }), [{ id: 'from-0' }])
  // The first socket answers nothing more; the retry lands on a new socket, which is fresh and answers.
  await assert.rejects(listAgents('m', { WebSocketImpl: Impl, timeoutMs: 80 }), /did not answer agents_list/)
  assert.equal(made.length, 2, 'one retry, on a fresh socket, before giving up')
  const selects = sent.filter((f) => f.type === 'machine_select').map((f) => f.payload.forceReconnect)
  assert.deepEqual(selects, [undefined, true], 'the retry tells Harness its kept session is dead')
  closeBridges()
})

test('an unlinked machine is named as such, and is not kept', async () => {
  const Impl = class {
    constructor() { this.listeners = {}; queueMicrotask(() => this.fire('close', { code: 4404 })) }
    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler) }
    fire(type, event) { for (const handler of this.listeners[type] ?? []) handler(event) }
    send() {} close() {}
  }
  await assert.rejects(listAgents('m', { WebSocketImpl: Impl, timeoutMs: 200 }), /Link this machine/)
  closeBridges()
})

test('withBridge is a one-off: its socket is closed after the call and never shared', async () => {
  const { Impl, made, sent } = scripted()
  const closedSockets = []
  Impl.prototype.close = function () { closedSockets.push(this) }
  const agents = await withBridge('m', async (rpc) => (await rpc('agents_list', {})).agents, { WebSocketImpl: Impl, timeoutMs: 500 })
  assert.deepEqual(agents, [{ id: 'from-0' }])
  assert.equal(closedSockets.length, 1)
  await listAgents('m', { WebSocketImpl: Impl, timeoutMs: 500 })
  assert.equal(made.length, 2, 'the kept read did not reuse the one-off socket')
  assert.deepEqual(sent.map((f) => f.type), ['machine_select', 'agents_list', 'machine_select', 'agents_list'])
  closeBridges()
})
