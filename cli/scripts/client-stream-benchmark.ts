/** Relay attribution only: no daemon, process sampling, terminal, socket, Podman, or real session data.
 * Both revisions run this exact source. The builder records every bundled input and allows only Node built-ins
 * outside the bundle. The coordinator owns isolated roots, deadlines, ABBA order and final child cleanup.
 */
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

type Payload = Record<string, any>
type Modules = { variant: 'baseline' | 'shared'; encodeTerminalLocal: (frame: Payload) => Uint8Array | null;
  createClientStreams?: (deps: Payload) => any; createBrowserStreams?: (deps: Payload) => any;
  createViewerStreams?: (...args: any[]) => any; createViewersLink?: (...args: any[]) => any; createClientStreamQueue?: () => any }
type Slot = { connection: string; agentId: string; requestId: string; id: string; grant: string }
const OWNER = { local: true, owner: true }
const CHUNK = 32 * 1024, WARMUP = 128, ITERATIONS = 8192
const uuid = (index: number): string => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
const memory = () => { global.gc!(); return process.memoryUsage() }
const difference = (after: NodeJS.MemoryUsage, before: NodeJS.MemoryUsage) => ({
  heapUsed: after.heapUsed - before.heapUsed, rss: after.rss - before.rss,
  external: after.external - before.external, arrayBuffers: after.arrayBuffers - before.arrayBuffers,
})

function fixture(modules: Modules, agents: number, slots: Slot[], pending = false, firstStart = false) {
  const rows = new Map(Array.from({ length: agents }, (_, index) => [`a${index}`, { browser: { state: 'ready' } }]))
  const byRequest = new Map(slots.map(slot => [slot.requestId, slot]))
  const byStream = new Map(slots.map(slot => [slot.id, slot]))
  const viewerData = Buffer.alloc(CHUNK).toString('base64')
  const tally = { opened: 0, refused: 0, down: 0, up: 0, binary: 0, binaryBytes: 0, wakes: 0 }
  let expectedBytes: Uint8Array | null = null
  const send = (_connection: string, type: string, payload: Payload) => {
    tally.up++
    if (type === 'agent_browser_open_result') {
      if (payload.error) tally.refused++
      else { assert.equal(payload.streamId, byRequest.get(payload.requestId)!.id); tally.opened++ }
    } else if (type === 'viewer_close' && payload.error) tally.refused++
    else if (type === 'viewer_data') {
      assert.equal(byStream.get(payload.streamId)?.connection, _connection)
      assert.equal(payload.data, viewerData)
    }
    return true
  }
  const binary = (_connection: string, bytes: Uint8Array) => {
    // Identity proves no byte can be copied, changed, reframed or substituted on this output path.
    assert.equal(bytes, expectedBytes)
    tally.binary++; tally.binaryBytes += bytes.length
    return true
  }
  // Exclude the identical synthetic rows and lookup tables from retained relay state.
  const beforeRelay = memory()
  let client: (slot: Slot, type: string, payload: Payload) => void
  let upstream: (slot: Slot, type: string, payload: Payload) => void
  let screen: (bytes: Uint8Array) => void
  let ready: () => void
  let close: () => void
  if (modules.variant === 'shared') {
    let browserSink: any, viewerSink: any
    const endpoint = (service: string) => ({
      frame: (event: Payload) => {
        tally.down++
        if (event.type === 'agent_browser_open') {
          const slot = slots.find(each => each.connection === event.connection && each.agentId === event.payload.agentId && !each.grant)!
          slot.grant = event.grant
          if (!pending) browserSink.frame(event.grant, 'agent_browser_open_result', { requestId: event.grant, streamId: slot.id })
        } else if (event.type === 'viewer_request') {
          const slot = slots.find(each => each.connection === event.connection && each.agentId === event.payload.agentId && !each.grant)!
          slot.grant = event.grant
          viewerSink.frame(event.grant, 'viewer_response', { streamId: event.grant, status: 200 })
        }
        return true
      }, binary: () => true, closed: () => {}, control: () => {}, refused: () => {},
    })
    const endpoints = new Map(['agentBrowser', 'viewers'].map(service => [service, endpoint(service)]))
    const relay = modules.createClientStreams!({ endpoint: (service: string) => endpoints.get(service) ?? null, disabled: () => false, send: (_service: string, ...args: any[]) => send(args[0], args[1], args[2]),
      sendBinary: (_service: string, connection: string, bytes: Uint8Array) => binary(connection, bytes), wake: () => tally.wakes++, log: () => {} })
    browserSink = relay.connected('agentBrowser'); relay.serving('agentBrowser')
    if (!firstStart) { viewerSink = relay.connected('viewers'); relay.serving('viewers') }
    client = (slot, type, payload) => { relay.frame(slot.connection, type, payload, OWNER) }
    upstream = (slot, type, payload) => { assert.equal(viewerSink.frame(slot.grant, type, { ...payload, streamId: slot.grant }), true) }
    screen = bytes => { expectedBytes = bytes; assert.equal(browserSink.binary(bytes), true) }
    ready = () => { viewerSink = relay.connected('viewers'); relay.serving('viewers') }
    close = () => relay.closed()
  } else {
    let browser: any
    const browserPort = { stream: (connection: string, type: string, payload: Payload) => {
        tally.down++
        if (type === 'agent_browser_open') {
          const slot = byRequest.get(payload.requestId)!; slot.grant = slot.id
          if (!pending) browser.frame(connection, 'agent_browser_open_result', { requestId: payload.requestId, streamId: slot.id })
        }
        return true
      }, streamInput: () => true, streamClosed: () => {}, streamRoute: () => {}, streamTransportError: () => {}, streamRefused: () => {} }
    browser = modules.createBrowserStreams!({ frame: (id: string) => rows.get(id) ?? {}, asker: () => OWNER, send, sendBinary: binary, log: () => {}, port: () => browserPort })
    let viewer: any
    viewer = modules.createViewersLink!({ agents: {}, clients: { viewerFrame: send } }, (event: Payload) => {
      if (event.payload.kind === 'stream') {
        tally.down++
        if (event.payload.type === 'viewer_request') viewer.notice({ kind: 'viewer', connId: event.payload.connId,
          type: 'viewer_response', payload: { streamId: event.payload.frame.streamId, status: 200 } })
      }
      return true
    }, { buffered: () => 0, call: async () => ({}) }, firstStart ? { wake: () => tally.wakes++ } : undefined)
    const streams = modules.createViewerStreams!(() => viewer.port, send)
    client = (slot, type, payload) => {
      if (type === 'agent_browser_open') browser.open(slot.connection, payload)
      else if (type === 'agent_browser_ack') browser.ack(slot.connection, payload)
      else if (type === 'agent_browser_close') browser.close(slot.connection, payload)
      else streams.frame(slot.connection, type, payload)
    }
    upstream = (slot, type, payload) => viewer.notice({ kind: 'viewer', connId: slot.connection, type, payload: { ...payload, streamId: slot.id } })
    screen = bytes => { expectedBytes = bytes; assert.equal(browser.bytes(bytes), true) }
    ready = () => viewer.connected()
    close = () => {
      for (const connection of new Set(slots.map(slot => slot.connection))) { browser.closeConnection(connection); streams.closed(connection) }
      viewer.connected()
    }
  }
  return { tally, client, upstream, screen, ready, close: () => { close(); for (const slot of slots) slot.grant = '' }, beforeRelay, viewerData }
}

function slots(count: number, agents: number, perConnection = 2): Slot[] {
  return Array.from({ length: count }, (_, index) => ({ connection: `c${Math.floor(index / perConnection)}`,
    agentId: `a${index % agents}`, requestId: `request-${index}`, id: uuid(index), grant: '' }))
}

export function run(modules: Modules): void {
  assert.equal(typeof global.gc, 'function', '--expose-gc is required')
  assert.equal(process.env.HARNESS_TEST_ISOLATED, '1', 'isolation must be set before loading the bundle')
  const output = process.argv[2]
  assert.ok(output && isAbsolute(output), 'a new private absolute output path is required')
  const results: Payload[] = []
  for (const agents of [1, 16, 160]) for (const streams of [1, 4]) for (const consumer of ['browser', 'viewer']) {
    const list = slots(streams, agents, Math.ceil(streams / 2))
    const test = fixture(modules, agents, list), before = test.beforeRelay
    for (const slot of list) test.client(slot, consumer === 'browser' ? 'agent_browser_open' : 'viewer_request',
      consumer === 'browser' ? { requestId: slot.requestId, agentId: slot.agentId } : { streamId: slot.id, agentId: slot.agentId, path: '/' })
    const live = memory()
    const raw = list.map(slot => modules.encodeTerminalLocal({ kind: 8, streamId: slot.id, seq: 1, compressed: false, bytes: new Uint8Array(CHUNK) })!)
    const data = test.viewerData
    const publicPayloads = list.map(slot => ({ streamId: slot.id, data }))
    const cycle = (index: number) => {
      const at = index % streams, slot = list[at]!
      if (consumer === 'browser') {
        test.screen(raw[at]!)
        test.client(slot, 'agent_browser_ack', { streamId: slot.id, bytes: CHUNK })
      } else {
        test.client(slot, 'viewer_data', publicPayloads[at]!)
        test.upstream(slot, 'viewer_data', publicPayloads[at]!)
        test.client(slot, 'viewer_ack', { streamId: slot.id, bytes: CHUNK })
      }
    }
    const samplesMs = new Float64Array(ITERATIONS)
    for (let index = 0; index < WARMUP; index++) cycle(index)
    global.gc!()
    const cpu = process.cpuUsage(), started = performance.now()
    for (let index = 0; index < ITERATIONS; index++) {
      const began = performance.now()
      cycle(index)
      samplesMs[index] = performance.now() - began
    }
    const elapsedMs = performance.now() - started, cost = process.cpuUsage(cpu)
    const active = memory()
    const cycles = WARMUP + ITERATIONS
    assert.deepEqual(test.tally, {
      opened: consumer === 'browser' ? streams : 0, refused: 0,
      down: streams + cycles * (consumer === 'browser' ? 1 : 2),
      up: streams + (consumer === 'browser' ? 0 : cycles),
      binary: consumer === 'browser' ? cycles : 0,
      binaryBytes: consumer === 'browser' ? cycles * (CHUNK + 36) : 0, wakes: 0,
    }, `${agents} agents / ${streams} streams / ${consumer}: exact opens, data, ACKs and output bytes`)
    test.close()
    const closed = memory()
    const ordered = [...samplesMs].sort((a, b) => a - b)
    results.push({ kind: 'steady', agents, streams, consumer, warmup: WARMUP, iterations: ITERATIONS,
      payloadBytes: CHUNK, oneWayMiB: ITERATIONS * CHUNK / 1024 ** 2, elapsedMs, cpuUs: cost.user + cost.system,
      samplesMs: Array.from(samplesMs), p50Ms: ordered[Math.ceil(ITERATIONS * .50) - 1], p95Ms: ordered[Math.ceil(ITERATIONS * .95) - 1],
      memoryScope: 'retained is relay state after open; afterTraffic/afterClose also retain fixture payloads and the identical 8192 Float64 timing samples',
      retained: difference(live, before), afterTraffic: difference(active, before), afterClose: difference(closed, before), tally: test.tally })
  }
  for (const kind of ['live', 'viewer-live', 'pending', 'ids', 'first-start-frames', 'first-start-bytes']) {
    const count = kind === 'live' ? 4097 : kind === 'viewer-live' ? 257 : kind === 'pending' ? 513 : kind === 'ids' ? 24 : 1
    const list = slots(count, kind === 'live' ? 1025 : 160, kind === 'live' || kind === 'viewer-live' ? 64 : 8)
    if (kind === 'ids') for (const slot of list) slot.requestId += 'x'.repeat(524_000 - slot.requestId.length)
    const firstStart = kind.startsWith('first-start')
    const test = fixture(modules, kind === 'live' ? 1025 : 160, list, kind === 'pending' || kind === 'ids', firstStart)
    const before = test.beforeRelay
    let attempted = count, beforeOverflow: Payload | null = null
    if (firstStart) {
      const slot = list[0]!
      test.client(slot, 'viewer_request', { streamId: slot.id, agentId: slot.agentId, path: '/' })
      const attempts = kind === 'first-start-frames' ? 4097 : 257
      attempted = attempts + 1
      for (let index = 0; index < attempts; index++) {
        if (index === (kind === 'first-start-frames' ? 4095 : 127)) beforeOverflow = {
          attempted: index + 1, tally: { ...test.tally }, retained: difference(memory(), before),
        }
        // Each held payload owns its own string, as separately parsed inbound frames do.
        const data = kind === 'first-start-frames' ? '' : Buffer.alloc(16 * 1024, 0xe9).toString('latin1')
        test.client(slot, 'viewer_data', { streamId: slot.id, data })
      }
    } else for (const slot of list) test.client(slot, kind === 'viewer-live' ? 'viewer_request' : 'agent_browser_open', kind === 'viewer-live'
      ? { streamId: slot.id, agentId: slot.agentId, path: '/' } : { requestId: slot.requestId, agentId: slot.agentId })
    const retained = memory(), beforeReady = { ...test.tally }
    if (!firstStart) {
      const accepted = modules.variant === 'baseline' ? count : kind === 'live' ? 2048 : kind === 'viewer-live' ? 256 : kind === 'pending' ? 512 : 16
      assert.equal(test.tally.down, accepted)
      assert.equal(test.tally.refused, count - accepted)
    }
    if (firstStart) test.ready()
    const afterReady = { ...test.tally }
    test.close()
    const afterClose = difference(memory(), before)
    if (!firstStart) {
      const recovered = list[0]!, previous = test.tally.down
      recovered.grant = ''
      test.client(recovered, kind === 'viewer-live' ? 'viewer_request' : 'agent_browser_open', kind === 'viewer-live'
        ? { streamId: recovered.id, agentId: recovered.agentId, path: '/' } : { requestId: recovered.requestId, agentId: recovered.agentId })
      assert.equal(test.tally.down, previous + 1, 'a released reservation must admit a subsequent valid open')
      test.close()
    }
    results.push({ kind, attempts: attempted, beforeOverflow, beforeReady, afterReady, retained: difference(retained, before), afterClose,
      scope: kind === 'viewer-live' ? 'direct core relay probe; baseline service stub omits the real ViewerForwarder 256 global / 64 connection admission limits'
        : kind === 'ids' ? 'direct core retained-ID probe; bypasses public JSON ingress and does not claim these IDs represent supported clients' : 'direct relay metadata or first-start queue probe' })
  }
  if (modules.createClientStreamQueue) for (const [kind, bytes, attempts, accepted] of [
    ['transport-count', 36, 4097, 4096], ['transport-bytes', CHUNK + 36, 129, 127],
  ] as const) {
    const before = memory(), queue = modules.createClientStreamQueue(), owner = queue.connection()
    const tag = { service: 'agentBrowser', direction: 'client' }, callbacks: Array<() => void> = []
    for (let index = 0; index < attempts; index++) {
      const release = owner.reserve(tag, bytes)
      if (release) callbacks.push(release)
    }
    assert.equal(callbacks.length, accepted)
    const retained = difference(memory(), before)
    owner.close()
    const replacement = queue.connection()
    for (let index = 0; index < accepted; index++) assert.equal(typeof replacement.reserve(tag, bytes), 'function')
    for (const callback of callbacks) { callback(); callback() }
    assert.equal(replacement.reserve(tag, bytes), null)
    replacement.close(); callbacks.length = 0
    results.push({ kind, bytes, attempts, accepted, queuedBytes: bytes * accepted, retained, afterClose: difference(memory(), before),
      scope: 'accounting release closures only; payload and WebSocket callback memory belong to the separate native transport fixture' })
  }
  const report = JSON.stringify({ variant: modules.variant, node: process.version,
    gc: 'before fixture, after open, after 128 warmup iterations, after measured traffic, after close', results }) + '\n'
  const bytes = Buffer.byteLength(report)
  assert.ok(bytes <= 8 * 1024 * 1024, 'bounded result file')
  writeFileSync(output, report, { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ variant: modules.variant, bytes, sha256: createHash('sha256').update(report).digest('hex') }))
}
