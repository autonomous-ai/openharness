import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { Frame, LocalClientSink } from './backendSocket.js'
import { attachLocalWsServer, type LocalWsBackend, type LocalWsServer, type LocalWsServerOptions } from './localWsServer.js'
import { encodeTerminalLocal, TerminalBinaryKind, type TerminalBinaryClear } from './lib/terminalBinary.js'
import { listenLocalSocket } from './lib/localSocket.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { WindowForm } from './cable/windowForm.js'

const machineId = 'machine-123'
const streamId = '00112233-4455-6677-8899-aabbccddeeff'

class FakeBackend implements LocalWsBackend {
  sink: LocalClientSink | null = null
  connId: string | null = null
  frames: Frame[] = []
  binaries: TerminalBinaryClear[] = []
  unregisters: string[] = []
  focuses: Array<[string, string | null]> = []
  tools: string[] = []

  registerLocalClient(connId: string, sink: LocalClientSink, opts: { tool?: boolean } = {}): boolean {
    this.connId = connId
    this.sink = sink
    if (opts.tool) this.tools.push(connId)
    return true
  }
  async unregisterLocalClient(connId: string): Promise<void> {
    this.unregisters.push(connId)
  }
  handleLocalFrame(_connId: string, frame: Frame): void {
    this.frames.push(frame)
  }
  async handleLocalBinary(_connId: string, frame: TerminalBinaryClear): Promise<void> {
    this.binaries.push(frame)
  }
  setLocalTerminalFocus(connId: string, agentId: string | null): void {
    this.focuses.push([connId, agentId])
  }
}

function onceOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
}

function onceMessage(ws: WebSocket): Promise<Frame> {
  return new Promise((resolve, reject) => {
    ws.once('message', (raw) => {
      try { resolve(JSON.parse(raw.toString()) as Frame) } catch (error) { reject(error) }
    })
    ws.once('error', reject)
  })
}

function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('local CLI WebSocket', () => {
  let server: http.Server | null = null
  let local: LocalWsServer | null = null

  afterEach(async () => {
    await local?.close()
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve())
    local = null
    server = null
  })

  async function start(backend: FakeBackend, extra: Partial<LocalWsServerOptions> = {}): Promise<string> {
    server = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
    local = attachLocalWsServer(server, { machineId, backend, ...extra })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    return `ws://127.0.0.1:${port}/api/local-ws`
  }

  it('keeps notification identities on the local read and snapshot paths', async () => {
    const backend = new FakeBackend(), seen = vi.fn(), unread = vi.fn()
    const ws = new WebSocket(await start(backend, { onAgentSeen: seen, onAppUnread: unread }))
    await onceOpen(ws)
    const connected = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }))
    await connected
    const item = { agentId: 'a', machineId: 'remote', question: true, text: 'Publish?', readToken: 'question-1' }
    ws.send(JSON.stringify({ type: 'app_unread', payload: { items: [item] } }))
    ws.send(JSON.stringify({ type: 'agent_seen', payload: { agentId: 'a', readToken: item.readToken } }))
    for (const readToken of ['', 42, 'x'.repeat(64)]) ws.send(JSON.stringify({ type: 'agent_seen', payload: { agentId: 'a', readToken } }))
    await vi.waitFor(() => expect(seen).toHaveBeenCalledExactlyOnceWith('a', 'question-1'))
    expect(unread).toHaveBeenCalledExactlyOnceWith([item])
    expect(backend.frames).toEqual([])
    ws.close()
  })

  it('serves the same endpoint over the daemon socket, with no Host to name and no Origin allowed', async () => {
    const dir = mkdtempSync('/tmp/hsock-')
    const socketPath = join(dir, 'daemon.sock')
    const backend = new FakeBackend()
    const unix = await listenLocalSocket((_req, res) => { res.statusCode = 404; res.end() }, socketPath)
    await start(backend, { localSocketServer: unix.server })
    const url = `ws+unix://${socketPath}:/api/local-ws`
    try {
      // No port, no loopback Host — refused on TCP, served here.
      const ws = new WebSocket(url, { headers: { host: 'rebind.evil.example' } })
      await onceOpen(ws)
      const connected = onceMessage(ws)
      ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }))
      expect(await connected).toMatchObject({ type: 'connected', payload: { machineId, transport: 'local' } })
      expect(backend.connId).toMatch(/^local:/)
      ws.close()

      // A browser still has no business here, whichever way it arrived.
      const browser = new WebSocket(url, { headers: { origin: 'http://localhost' } })
      const status = await new Promise<number>((resolve) => browser.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)))
      expect(status).toBe(403)
    } finally {
      await local?.close()
      local = null
      await unix.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses an upgrade whose Host is not a loopback name for this port', async () => {
    const url = await start(new FakeBackend())
    const ws = new WebSocket(url, { headers: { host: 'rebind.evil.example:' + new URL(url).port } })
    const status = await new Promise<number>((resolve) => ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)))
    expect(status).toBe(403)
  })

  it('hands a window that connects late the questions still open', async () => {
    const asked = { type: 'commander_question', agentId: 'a1', dbSessionId: 's1', payload: { requestId: 'q_1', questions: [] } }
    const ws = new WebSocket(await start(new FakeBackend(), { openQuestions: () => [asked] }))
    await onceOpen(ws)
    const frames: Frame[] = []
    const got = new Promise<void>((resolve) => ws.on('message', (raw) => {
      frames.push(JSON.parse(raw.toString()) as Frame)
      if (frames.length === 3) resolve()
    }))
    ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }))
    await got
    expect(frames.map((f) => f.type)).toEqual(['connected', 'commander_question', 'commander_questions_open'])
    expect(frames[1]).toEqual(asked)
    expect(frames[2]).toEqual({ type: 'commander_questions_open', payload: { requestIds: ['q_1'] } })
    ws.close()
  })

  it('consumes validated preparation UI acknowledgements locally', async () => {
    const backend = new FakeBackend(), opened = vi.fn()
    const ws = new WebSocket(await start(backend, { onDevicePrepareOpened: opened }))
    await onceOpen(ws)
    const connected = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }))
    await connected
    ws.send(JSON.stringify({ type: 'device_prepare_opened', payload: { operationId: 'invalid', agentId: 'a' } }))
    ws.send(JSON.stringify({ type: 'device_prepare_opened', payload: { operationId: 'a'.repeat(64), agentId: 'agent1' } }))
    await vi.waitFor(() => expect(opened).toHaveBeenCalledExactlyOnceWith('a'.repeat(64), 'agent1'))
    expect(backend.frames).toEqual([])
    ws.close()
  })

  it.each(['selection', 'visit', 'form'])('addresses one window for %s and consumes its result locally', async kind => {
    const backend = new FakeBackend(), reply = vi.fn()
    const ws = new WebSocket(await start(backend, { [kind === 'form' ? 'onFormReply' : kind === 'visit' ? 'onVisitReply' : 'onSelectionReply']: reply }))
    await onceOpen(ws)
    const connected = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }))
    await connected
    expect(local!.sendToWindow('unknown', { type: `dial_${kind}`, payload: {} })).toBe(false)
    const request = onceMessage(ws)
    expect(local!.sendToWindow(backend.connId!, { type: `dial_${kind}`, payload: { requestId: 'selection' } })).toBe(true)
    expect(await request).toEqual({ type: `dial_${kind}`, payload: { requestId: 'selection' } })
    ws.send(JSON.stringify({ type: `app_${kind}_result`, payload: { text: 'private selected text' } }))
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith(backend.connId, machineId, { text: 'private selected text' }))
    expect(backend.frames).toEqual([])
    const id = backend.connId!
    ws.close()
    await vi.waitFor(() => expect(local!.sendToWindow(id, { type: `dial_${kind}`, payload: {} })).toBe(false))
  })

  it.each(['selection', 'visit', 'form'])('keeps %s on this desk and ignores upstream gestures', async kind => {
    const backend = new FakeBackend(), reply = vi.fn(), focus = vi.fn()
    const relayed: Frame[] = [], received: Frame[] = []
    let upstream: LocalClientSink | undefined
    const relayPool = {
      acquire: async (_id: string, _env: string, _select: Frame, sink: LocalClientSink) => {
        upstream = sink
        sink.sendFrame({ type: 'connected', payload: { machineId: 'remote', e2ee: false } })
        return { send: async (frame: Frame) => { relayed.push(frame) }, sendBinary: async () => {}, detach: () => {} }
      },
      acquireIsolated: async () => { throw new Error('unused') }, invalidate: () => {},
    }
    const ws = new WebSocket(await start(backend, {
      autonomousEnv: 'test', [kind === 'form' ? 'onFormReply' : kind === 'visit' ? 'onVisitReply' : 'onSelectionReply']: reply, onAppFocusState: focus,
      relayPool: relayPool as unknown as NonNullable<LocalWsServerOptions['relayPool']>,
    }))
    await onceOpen(ws)
    const connected = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId: 'remote', localProtocolVersion: 1 } }))
    await connected
    ws.on('message', raw => received.push(JSON.parse(raw.toString())))
    ws.send(JSON.stringify({ type: 'app_focus', payload: { agentId: 'remote-agent' } }))
    await vi.waitFor(() => expect(focus).toHaveBeenCalled())
    const connId = focus.mock.calls[0][2] as string
    upstream!.sendFrame({ type: `dial_${kind}`, payload: { requestId: 'upstream' } })
    const selection = onceMessage(ws)
    expect(local!.sendToWindow(connId, { type: `dial_${kind}`, payload: { requestId: 'from-device' } })).toBe(true)
    expect((await selection).payload).toEqual({ requestId: 'from-device' })
    ws.send(JSON.stringify({ type: `app_${kind}_result`, payload: { text: 'quoted remote output' } }))
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith(connId, 'remote', { text: 'quoted remote output' }))
    expect(relayed.some(frame => frame.type === `app_${kind}_result`)).toBe(false)
    expect(received.filter(frame => frame.type === `dial_${kind}`)).toHaveLength(1)
    expect(backend.frames).toEqual([])
    ws.close()
  })
  it('relays addressed device commands without sending legacy writes to the local cable', async () => {
    const backend = new FakeBackend(), localSettings = vi.fn(), relayed: Frame[] = []
    const relayPool = {
      acquire: async (_id: string, _env: string, _select: Frame, sink: LocalClientSink) => {
        sink.sendFrame({ type: 'connected', payload: { machineId: 'remote', e2ee: false } })
        return { send: async (frame: Frame) => { relayed.push(frame) }, sendBinary: async () => {}, detach: () => {} }
      },
    }
    const ws = new WebSocket(await start(backend, {
      autonomousEnv: 'test', onDialSettings: localSettings,
      relayPool: relayPool as unknown as NonNullable<LocalWsServerOptions['relayPool']>,
    }))
    await onceOpen(ws)
    const connected = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId: 'remote', localProtocolVersion: 1 } }))
    await connected
    ws.send(JSON.stringify({ type: 'dial_settings', payload: { id: 'same-usb', brightness: 90 } }))
    const addressed = { type: 'harness_device_settings', payload: { id: 'same-usb', patch: { brightness: 35 }, requestId: 'one' } }
    ws.send(JSON.stringify(addressed))
    await vi.waitFor(() => expect(relayed).toContainEqual(addressed))
    expect(localSettings).not.toHaveBeenCalled()
    expect(backend.frames).toEqual([])
    expect(relayed).toHaveLength(1)
    ws.close()
  })

  it('accepts loopback, selects the exact machine, and routes JSON plus HTRL binary', async () => {
    const backend = new FakeBackend()
    const url = await start(backend)
    const ws = new WebSocket(url)
    await onceOpen(ws)
    const connected = onceMessage(ws)
    ws.send(JSON.stringify({
      type: 'machine_select',
      payload: { machineId, localProtocolVersion: 1 },
    }))
    await expect(connected).resolves.toMatchObject({
      type: 'connected',
      payload: { machineId, transport: 'local', e2ee: false },
    })

    ws.send(JSON.stringify({ type: 'agents_list', payload: { requestId: 'r1' } }))
    const binary = encodeTerminalLocal({
      kind: TerminalBinaryKind.input,
      streamId,
      seq: 1,
      bytes: new TextEncoder().encode('hello'),
      compressed: false,
    })!
    ws.send(binary)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(backend.frames).toEqual([{ type: 'agents_list', payload: { requestId: 'r1' } }])
    expect(backend.binaries[0]).toMatchObject({
      kind: TerminalBinaryKind.input,
      streamId,
      seq: 1,
    })

    const reply = onceMessage(ws)
    expect(backend.sink?.sendFrame({ type: 'agents_list_result', payload: { requestId: 'r1', agents: [] } })).toBe(true)
    await expect(reply).resolves.toMatchObject({ type: 'agents_list_result' })
    ws.close()
  })

  it.each(['local binary', 'remote JSON', 'remote binary', 'route task'] as const)(
    'keeps later messages behind an unfinished %s operation', async (kind) => {
      const backend = new FakeBackend(), pending = gate(), entered = gate()
      const trace: string[] = []
      const first = async () => {
        trace.push('first started')
        entered.resolve()
        await pending.promise
        trace.push('first finished')
      }
      backend.handleLocalFrame = () => { trace.push('second') }
      backend.handleLocalBinary = first
      const remote = kind.startsWith('remote')
      const relay = {
        send: async (frame: Frame) => {
          if ((frame.payload as { requestId?: string })?.requestId === 'first') await first()
          else trace.push('second')
        },
        sendBinary: first,
        detach: () => {},
      }
      const ws = new WebSocket(await start(backend, {
        autonomousEnv: 'test',
        relayPool: {
          acquire: async (_id: string, _env: string, _select: Frame, sink: LocalClientSink) => {
            sink.sendFrame({ type: 'connected', payload: {} })
            return relay
          },
        } as unknown as LocalWsServerOptions['relayPool'],
        async onRouteTask(this: LocalWsServerOptions) {
          expect(this.machineId).toBe(machineId)
          await first()
          return { agentId: '', machineId: '', name: '', confidence: 0, reason: '', candidates: [], weighed: 0, machines: 0, via: '' }
        },
      }))
      await onceOpen(ws)
      const connected = onceMessage(ws)
      ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId: remote ? 'remote' : machineId, localProtocolVersion: 1 } }))
      await connected
      if (kind.endsWith('binary')) {
        ws.send(encodeTerminalLocal({ kind: TerminalBinaryKind.input, streamId, seq: 1, bytes: new Uint8Array([97]), compressed: false })!)
      } else {
        ws.send(JSON.stringify({ type: kind === 'route task' ? 'route_task' : 'agents_list', payload: { requestId: 'first', text: 'route me' } }))
      }
      ws.send(JSON.stringify({ type: 'agents_list', payload: { requestId: 'second' } }))
      await entered.promise
      // Let the real socket deliver the queued frame while the first operation is held open.
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(trace).toEqual(['first started'])
      pending.resolve()
      await vi.waitFor(() => expect(trace).toEqual(['first started', 'first finished', 'second']))
      ws.close()
    },
  )

  it.each(['local JSON', 'local binary', 'remote JSON', 'remote binary'] as const)(
    'closes the socket when %s dispatch fails', async (kind) => {
      const backend = new FakeBackend()
      backend.handleLocalFrame = () => { throw new Error('dispatch failed') }
      backend.handleLocalBinary = async () => { throw new Error('dispatch failed') }
      const relay = { send: async () => { throw new Error('dispatch failed') }, sendBinary: async () => { throw new Error('dispatch failed') }, detach: () => {} }
      const ws = new WebSocket(await start(backend, {
        autonomousEnv: 'test',
        relayPool: {
          acquire: async (_id: string, _env: string, _select: Frame, sink: LocalClientSink) => {
            sink.sendFrame({ type: 'connected', payload: {} })
            return relay
          },
        } as unknown as LocalWsServerOptions['relayPool'],
      }))
      await onceOpen(ws)
      const connected = onceMessage(ws)
      ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId: kind.startsWith('remote') ? 'remote' : machineId, localProtocolVersion: 1 } }))
      await connected
      const closed = new Promise<[number, string]>((resolve) => ws.once('close', (code, reason) => resolve([code, reason.toString()])))
      if (kind.endsWith('binary')) {
        ws.send(encodeTerminalLocal({ kind: TerminalBinaryKind.input, streamId, seq: 1, bytes: new Uint8Array([97]), compressed: false })!)
      } else {
        ws.send(JSON.stringify({ type: 'agents_list', payload: { requestId: 'first' } }))
      }
      await expect(closed).resolves.toEqual([1011, 'local dispatch failed'])
    },
  )

  it.each(['owned', 'isolated', 'shared'] as const)(
    'queues frames during a pending %s relay handshake', async (kind) => {
      const backend = new FakeBackend(), pending = gate(), entered = gate()
      const frames: Frame[] = []
      const acquire = vi.fn(async () => {
        entered.resolve()
        await pending.promise
        return { send: async (frame: Frame) => { frames.push(frame) }, sendBinary: async () => {}, detach: () => {} }
      })
      const ws = new WebSocket(await start(backend, {
        autonomousEnv: 'test',
        relayPool: { acquire, acquireIsolated: acquire } as unknown as LocalWsServerOptions['relayPool'],
        shareRelay: { acquire } as unknown as LocalWsServerOptions['shareRelay'],
      }))
      await onceOpen(ws)
      ws.send(JSON.stringify({ type: 'machine_select', payload: {
        machineId: 'remote', localProtocolVersion: 1,
        ...(kind === 'shared' ? { shareId: 'share' } : {}), relayIsolation: kind === 'isolated',
      } }))
      ws.send(JSON.stringify({ type: 'agents_list', payload: { requestId: 'queued' } }))
      await entered.promise
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(acquire).toHaveBeenCalledTimes(1)
      expect(frames).toEqual([])
      pending.resolve()
      await vi.waitFor(() => expect(frames).toEqual([{ type: 'agents_list', payload: { requestId: 'queued' } }]))
      expect(backend.frames).toEqual([])
      ws.close()
    },
  )

  it.each(['owned', 'shared'] as const)('detaches a late %s relay after its window disconnects', async (kind) => {
    const backend = new FakeBackend(), pending = gate(), entered = gate(), disconnected = gate(), detach = vi.fn()
    const acquire = async () => {
      entered.resolve()
      await pending.promise
      return { send: async () => {}, sendBinary: async () => {}, detach }
    }
    const ws = new WebSocket(await start(backend, {
      autonomousEnv: 'test',
      relayPool: { acquire } as unknown as LocalWsServerOptions['relayPool'],
      shareRelay: { acquire } as unknown as LocalWsServerOptions['shareRelay'],
    }))
    server!.once('connection', (socket) => socket.once('close', disconnected.resolve))
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'machine_select', payload: {
      machineId: 'remote', localProtocolVersion: 1, ...(kind === 'shared' ? { shareId: 'share' } : {}),
    } }))
    await entered.promise
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()))
    ws.close()
    await closed
    await disconnected.promise
    pending.resolve()
    await vi.waitFor(() => expect(detach).toHaveBeenCalledTimes(1))
    expect(backend.unregisters).toEqual([])
  })

  // A window from before it introduced itself on `terminal_open` still gets named on the far
  // machine's "took control" banner: this daemon knows the window is its own desktop.
  it('introduces a silent window on a relayed terminal_open, and believes one that speaks', async () => {
    const backend = new FakeBackend()
    const relayed: Frame[] = []
    const relayPool = {
      acquire: async (_machineId: string, _env: string, _select: Frame, sink: LocalClientSink) => {
        sink.sendFrame({ type: 'connected', payload: { machineId: 'other-machine', e2ee: false } })
        return { send: async (frame: Frame) => { relayed.push(frame) }, sendBinary: async () => {}, detach: () => {} }
      },
      acquireIsolated: async () => { throw new Error('unused') },
      invalidate: () => {},
    }
    server = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
    local = attachLocalWsServer(server, {
      machineId, backend, autonomousEnv: 'test',
      relayPool: relayPool as unknown as NonNullable<Parameters<typeof attachLocalWsServer>[1]['relayPool']>,
      localClient: () => ({ kind: 'desktop', name: 'This Mac', machineId }),
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-ws`)
    await onceOpen(ws)
    const connected = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId: 'other-machine', localProtocolVersion: 1 } }))
    await expect(connected).resolves.toMatchObject({ type: 'connected' })

    ws.send(JSON.stringify({ type: 'terminal_open', payload: { requestId: 'o1', agentId: 'a', cols: 80, rows: 24, protocolVersion: 3 } }))
    ws.send(JSON.stringify({ type: 'terminal_open', payload: { requestId: 'o2', agentId: 'a', cols: 80, rows: 24, protocolVersion: 3, client: { kind: 'desktop', name: 'Named by the window' } } }))
    ws.send(JSON.stringify({ type: 'agents_list', payload: { requestId: 'r1' } }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(relayed).toEqual([
      { type: 'terminal_open', payload: { requestId: 'o1', agentId: 'a', cols: 80, rows: 24, protocolVersion: 3, client: { kind: 'desktop', name: 'This Mac', machineId } } },
      { type: 'terminal_open', payload: { requestId: 'o2', agentId: 'a', cols: 80, rows: 24, protocolVersion: 3, client: { kind: 'desktop', name: 'Named by the window' } } },
      { type: 'agents_list', payload: { requestId: 'r1' } },
    ])
    ws.close()
  })

  it('takes the window\'s tile roster, keeps it off the wire, and forgets it on close', async () => {
    const backend = new FakeBackend()
    const rosters: string[][] = []
    server = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
    local = attachLocalWsServer(server, {
      machineId,
      backend,
      onAppPanes: (ids) => rosters.push(ids),
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-ws`

    const ws = new WebSocket(url)
    await onceOpen(ws)
    const connected = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }))
    await connected

    ws.send(JSON.stringify({ type: 'app_panes', payload: { agentIds: ['a1', 'a2', '', 7, null] } }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Anything that is not a usable id is dropped rather than trusted.
    expect(rosters).toEqual([['a1', 'a2']])
    // Like app_focus: it describes a screen at this desk, so the machine never sees it.
    expect(backend.frames.map((frame) => frame.type)).toEqual([])

    ws.close()
    // A window that went away has no tiles open. Left standing, the roster would go on silencing the
    // dial for agents nobody can see any more — backwards, and permanently.
    await vi.waitFor(() => expect(rosters).toEqual([['a1', 'a2'], []]))
  })

  it('says whether the window those tiles belong to is actually in front', async () => {
    // The roster alone cannot answer it: every pane keeps its place on the tab
    // while the window sits behind a browser. Without this the dial stayed quiet
    // about work nobody could see, which is the one case it exists for.
    const backend = new FakeBackend()
    const seen: Array<{ ids: string[]; foreground: boolean }> = []
    server = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
    local = attachLocalWsServer(server, {
      machineId,
      backend,
      onAppPanes: (ids, foreground) => seen.push({ ids, foreground }),
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-ws`

    const ws = new WebSocket(url)
    await onceOpen(ws)
    const connected = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }))
    await connected

    ws.send(JSON.stringify({ type: 'app_panes', payload: { agentIds: ['a1'], foreground: true } }))
    ws.send(JSON.stringify({ type: 'app_panes', payload: { agentIds: ['a1'], foreground: false } }))
    // A window that predates the field only ever sent this list while it was up,
    // so absence reads as in front — the behaviour it has today.
    ws.send(JSON.stringify({ type: 'app_panes', payload: { agentIds: ['a1'] } }))
    await vi.waitFor(() => expect(seen).toHaveLength(3))
    expect(seen.map((row) => row.foreground)).toEqual([true, false, true])

    ws.close()
    // No window at all is not a window in front.
    await vi.waitFor(() => expect(seen[3]).toEqual({ ids: [], foreground: false }))
  })

  it('takes the window\'s swarms, drops what is not a swarm, and forgets them on close', async () => {
    const backend = new FakeBackend()
    const seen: unknown[] = []
    const tabs = vi.fn()
    server = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
    local = attachLocalWsServer(server, {
      machineId,
      backend,
      onAppSwarms: (swarms) => seen.push(swarms),
      onAppTabAgents: tabs,
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-ws`

    const ws = new WebSocket(url)
    await onceOpen(ws)
    const connected = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }))
    await connected

    ws.send(JSON.stringify({ type: 'app_swarms', payload: {
      active: 's2',
      swarms: [
        { id: 's1', name: 'Workshop', agentIds: ['a1', '', 7, 'a2'], panes: 3 },
        { id: '', name: 'no id' },
        'junk',
        { id: 's2', name: 'Launch' },
      ],
    } }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(seen).toEqual([{ active: 's2', swarms: [
      // Three tiles, two of them agents: the third is a shell or a viewer, and saying so is the
      // point — see the terminal-only tab below.
      { id: 's1', name: 'Workshop', agentIds: ['a1', 'a2'], panes: 3 },
      // No count at all, from a window too old to send one: as many tiles as agents, which is what
      // this row meant before the field existed.
      { id: 's2', name: 'Launch', agentIds: [], panes: 0 },
    // This window sent no `tiles`, which is how every window behaved until it had a device with a
    // face big enough to draw one. Empty is the honest reading, and the device falls back to
    // deriving the shape from the count exactly as it does today.
    ], tiles: [] }])
    // Like app_panes: a fact about this desk, so the machine never sees it.
    expect(backend.frames.map((frame) => frame.type)).toEqual([])

    expect(tabs).toHaveBeenCalledExactlyOnceWith(backend.connId, ['a1', 'a2'])

    ws.close()
    // The window is gone, and so are its tabs.
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    expect(seen[1]).toBeNull()
    expect(tabs).toHaveBeenLastCalledWith(backend.connId, null)
  })

  it('follows an explicit app_focus, and keeps it off the wire', async () => {
    const backend = new FakeBackend()
    const moves: Array<{ machineId: string; agentId: string }> = []
    server = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
    local = attachLocalWsServer(server, {
      machineId,
      backend,
      onAppFocus: (m, a) => moves.push({ machineId: m, agentId: a }),
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-ws`

    const ws = new WebSocket(url)
    await onceOpen(ws)
    const connected = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }))
    await connected

    // Opening a terminal still counts: that is all an older app build sends.
    ws.send(JSON.stringify({ type: 'terminal_open', payload: { agentId: 'agent-opened' } }))
    // And a window that MOVED without opening anything now says so — which is every click on a pane
    // that already holds a live session, the case the dial used to miss entirely.
    ws.send(JSON.stringify({ type: 'app_focus', payload: { agentId: 'agent-focused' } }))
    ws.send(JSON.stringify({ type: 'terminal_open', payload: { agentId: 'background-restored' } }))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(moves).toEqual([
      { machineId, agentId: 'agent-opened' },
      { machineId, agentId: 'agent-focused' },
    ])
    // Consumed locally: it describes a hand at this desk, and the machine has no use for an unknown
    // frame type arriving on every pane click.
    expect(backend.frames.map((frame) => frame.type)).toEqual(['terminal_open', 'terminal_open'])
    ws.close()
  })

  it('reports only explicit voice focus and clears by originating connection', async () => {
    const backend = new FakeBackend()
    const states: Array<{ machine: string; agent: string | null; conn: string }> = []
    const disconnected = vi.fn()
    server = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
    local = attachLocalWsServer(server, {
      machineId, backend,
      onAppFocusState: (machine, agent, conn) => states.push({ machine, agent, conn }),
      onAppDisconnect: disconnected,
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-ws`)
    await onceOpen(ws)
    const connected = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }))
    await connected
    ws.send(JSON.stringify({ type: 'terminal_open', payload: { agentId: 'background' } }))
    ws.send(JSON.stringify({ type: 'app_focus', payload: { agentId: 'focused' } }))
    ws.send(JSON.stringify({ type: 'terminal_open', payload: { agentId: 'another-background' } }))
    await vi.waitFor(() => expect(states).toHaveLength(1))
    expect(states[0]).toMatchObject({ machine: machineId, agent: 'focused' })
    ws.send(JSON.stringify({ type: 'app_focus', payload: { agentId: null } }))
    await vi.waitFor(() => expect(states).toHaveLength(2))
    expect(states[1]).toEqual({ ...states[0], agent: null })
    expect(backend.frames.map(frame => frame.type)).toEqual(['terminal_open', 'terminal_open'])
    ws.close()
    await vi.waitFor(() => expect(disconnected).toHaveBeenCalledExactlyOnceWith(machineId, states[0].conn))
    expect(states).toHaveLength(2)
  })

  it('keeps Find on the live desktop when a background or replaced socket closes', async () => {
    const backend = new FakeBackend(), disconnected = vi.fn()
    let focused: { machineId: string; connId: string } | undefined
    const form = new WindowForm({ focus: () => focused,
      send: (conn, payload) => local!.sendToWindow(conn, { type: 'dial_form', payload }) })
    const url = await start(backend, {
      onAppFocusState: (machineId, _agent, connId) => { focused = { machineId, connId } },
      onAppDisconnect: (machine, conn) => {
        disconnected(machine, conn)
        if (focused?.connId === conn) focused = undefined
        form.disconnected(conn)
      },
      onFormReply: (conn, machine, payload) => form.reply(conn, machine, payload),
    })
    const connect = async () => {
      const ws = new WebSocket(url)
      await onceOpen(ws)
      const connected = onceMessage(ws)
      ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }))
      await connected
      return { ws, connId: backend.connId! }
    }
    const select = async (client: Awaited<ReturnType<typeof connect>>, agentId: string | null) => {
      client.ws.send(JSON.stringify({ type: 'app_focus', payload: { agentId } }))
      await vi.waitFor(() => expect(focused?.connId).toBe(client.connId))
    }
    const close = async (client: Awaited<ReturnType<typeof connect>>) => {
      client.ws.close()
      await vi.waitFor(() => expect(backend.unregisters).toContain(client.connId))
    }
    const ready = async (client: Awaited<ReturnType<typeof connect>>, id: string) => {
      const received = onceMessage(client.ws)
      const result = form.command({ op: 'open', surface: 'find', formId: id })
      const frame = await received
      expect(frame.type).toBe('dial_form')
      client.ws.send(JSON.stringify({ type: 'app_form_result', payload: {
        ...(frame.payload as Record<string, unknown>), ok: true, active: true, revision: 1, position: 0, total: 0,
        busy: false, enabled: false, canQuery: true, title: 'Find Harness', label: 'Say a name',
      } }))
      expect(await result).toMatchObject({ ok: true, active: true, canQuery: true })
    }
    const desktop = await connect()
    await select(desktop, null) // An empty workspace can still open Find.
    const background = await connect()
    await close(background)
    expect(focused?.connId).toBe(desktop.connId)
    await ready(desktop, 'find-after-background-close')

    const replacement = await connect()
    await select(replacement, 'selected-pane')
    await close(desktop) // The old connection closes after the new one reports focus.
    expect(focused?.connId).toBe(replacement.connId)
    await ready(replacement, 'find-after-reconnect')
    await close(replacement)
    expect(focused).toBeUndefined()
    expect(disconnected).toHaveBeenCalledTimes(3)
    expect(await form.command({ op: 'open', surface: 'find', formId: 'find-offline' }))
      .toMatchObject({ ok: false, active: false })
    expect(backend.frames).toEqual([])
    expect(backend.binaries).toEqual([])
  })

  it('keeps background connections from stealing selection and releases compatibility mode on disconnect', async () => {
    const backend = new FakeBackend(), dial = vi.fn()
    const url = await start(backend, { onAppFocus: dial })
    const select = async () => {
      const ws = new WebSocket(url)
      await onceOpen(ws)
      const connected = onceMessage(ws)
      ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }))
      await connected
      return ws
    }
    const selected = await select()
    selected.send(JSON.stringify({ type: 'app_focus', payload: { agentId: 'hn' } }))
    await vi.waitFor(() => expect(dial).toHaveBeenCalledExactlyOnceWith(machineId, 'hn'))

    const background = await select()
    background.send(JSON.stringify({ type: 'terminal_open', payload: { agentId: 'firmware' } }))
    await vi.waitFor(() => expect(backend.frames).toHaveLength(1))
    expect(dial).toHaveBeenCalledTimes(1)
    selected.send(JSON.stringify({ type: 'app_focus', payload: { agentId: null } }))
    selected.send(JSON.stringify({ type: 'terminal_open', payload: { agentId: 'another-background' } }))
    await vi.waitFor(() => expect(backend.frames).toHaveLength(2))
    expect(dial).toHaveBeenCalledTimes(1) // a cleared selection must also stay clear

    selected.close()
    await vi.waitFor(() => expect(backend.unregisters).toHaveLength(1))
    background.send(JSON.stringify({ type: 'terminal_open', payload: { agentId: 'legacy-window' } }))
    await vi.waitFor(() => expect(dial).toHaveBeenLastCalledWith(machineId, 'legacy-window'))
    background.close()
  })

  it('keeps stale automatic focus off the dial and forwards its revision for validation', async () => {
    const backend = new FakeBackend()
    const focus = vi.fn(() => false), dial = vi.fn()
    server = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
    local = attachLocalWsServer(server, { machineId, backend, onAppFocusState: focus, onAppFocus: dial })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-ws`)
    await onceOpen(ws)
    const connected = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }))
    await connected
    ws.send(JSON.stringify({ type: 'app_focus', payload: { agentId: 'first', focusRevision: 'old:0' } }))
    ws.send(JSON.stringify({ type: 'terminal_open', payload: { agentId: 'background' } }))
    await vi.waitFor(() => expect(focus).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(backend.frames).toHaveLength(1))
    expect(focus).toHaveBeenCalledWith(machineId, 'first', expect.any(String), 'old:0')
    expect(dial).not.toHaveBeenCalled()
    expect(backend.frames.map((frame) => frame.type)).toEqual(['terminal_open'])
    ws.close()
  })

  it('tells this daemon\'s terminals which one is focused, even when the dial refuses the move', async () => {
    const backend = new FakeBackend()
    server = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
    // A stale revision keeps the dial where it is; it says nothing about the terminal in front of the person.
    local = attachLocalWsServer(server, { machineId, backend, onAppFocusState: () => false })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-ws`)
    await onceOpen(ws)
    const connected = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }))
    await connected
    ws.send(JSON.stringify({ type: 'app_focus', payload: { agentId: 'focused', focusRevision: 'old:0' } }))
    ws.send(JSON.stringify({ type: 'app_focus', payload: { agentId: '' } }))   // malformed: ignored
    ws.send(JSON.stringify({ type: 'app_focus', payload: { agentId: null } }))
    await vi.waitFor(() => expect(backend.focuses).toHaveLength(2))
    expect(backend.focuses).toEqual([[backend.connId, 'focused'], [backend.connId, null]])
    ws.close()
  })

  it('never hands a relayed machine\'s focus to this daemon\'s terminals', async () => {
    const backend = new FakeBackend()
    const relayPool = {
      acquire: async (_machineId: string, _env: string, _select: Frame, sink: LocalClientSink) => {
        sink.sendFrame({ type: 'connected', payload: { machineId: 'other-machine', e2ee: false } })
        return { send: async () => {}, sendBinary: async () => {}, detach: () => {} }
      },
      acquireIsolated: async () => { throw new Error('unused') },
      invalidate: () => {},
    }
    const states: Array<string | null> = []
    server = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
    local = attachLocalWsServer(server, {
      machineId, backend, autonomousEnv: 'test',
      relayPool: relayPool as unknown as NonNullable<Parameters<typeof attachLocalWsServer>[1]['relayPool']>,
      onAppFocusState: (_machine, agent) => { states.push(agent) },
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-ws`)
    await onceOpen(ws)
    const connected = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId: 'other-machine', localProtocolVersion: 1 } }))
    await connected
    ws.send(JSON.stringify({ type: 'app_focus', payload: { agentId: 'remote-agent' } }))
    await vi.waitFor(() => expect(states).toEqual(['remote-agent']))
    expect(backend.focuses).toEqual([])
    ws.close()
  })

  /** The daemon's Unix socket beside the TCP port: the pair brain's frames are taken only over the socket. */
  async function unixWorld(backend: FakeBackend, extra: Partial<LocalWsServerOptions> = {}) {
    const dir = mkdtempSync('/tmp/hsock-')
    const socketPath = join(dir, 'daemon.sock')
    const unix = await listenLocalSocket((_req, res) => { res.statusCode = 404; res.end() }, socketPath)
    const tcp = await start(backend, { localSocketServer: unix.server, ...extra })
    const open = async (url: string, select: Record<string, unknown>): Promise<WebSocket> => {
      const ws = new WebSocket(url)
      await onceOpen(ws)
      const connected = onceMessage(ws)
      ws.send(JSON.stringify({ type: 'machine_select', payload: { localProtocolVersion: 1, ...select } }))
      await connected
      return ws
    }
    const cleanup = async (): Promise<void> => {
      await local?.close()
      local = null
      await unix.close()
      rmSync(dir, { recursive: true, force: true })
    }
    return { unix: `ws+unix://${socketPath}:/api/local-ws`, tcp, open, cleanup }
  }

  it('answers daemon_act UNSUPPORTED when there is no pair brain, rather than passing it on', async () => {
    const backend = new FakeBackend()
    const w = await unixWorld(backend)
    try {
      const ws = await w.open(w.unix, { machineId })
      const result = onceMessage(ws)
      ws.send(JSON.stringify({ type: 'daemon_act', payload: { requestId: 'r1', id: 'need:x', choice: 'y' } }))
      expect(await result).toEqual({ type: 'daemon_act_result', payload: { requestId: 'r1', id: 'need:x', ok: false, error: 'UNSUPPORTED' } })
      expect(backend.frames).toEqual([])
      ws.close()
    } finally {
      await w.cleanup()
    }
  })

  it('carries the window\'s answer about a spoken task, and keeps it off the wire', async () => {
    const backend = new FakeBackend()
    const replies: Array<{ voiceId: string; reply: unknown }> = []
    server = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
    local = attachLocalWsServer(server, {
      machineId,
      backend,
      onVoiceRouteReply: (voiceId, reply) => replies.push({ voiceId, reply }),
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-ws`

    const ws = new WebSocket(url)
    await onceOpen(ws)
    const connected = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }))
    await connected

    ws.send(JSON.stringify({ type: 'voice_route_reply', payload: { voiceId: 'v1', state: 'taken' } }))
    ws.send(JSON.stringify({ type: 'voice_route_reply', payload: { voiceId: 'v1', state: 'sent', agentId: 'a7' } }))
    ws.send(JSON.stringify({ type: 'voice_route_reply', payload: { voiceId: 'v2', state: 'cancelled' } }))
    // Neither of these is an answer: one names no request, the other a state this side cannot read.
    // Guessing at either would settle a spoken turn on something nobody said.
    ws.send(JSON.stringify({ type: 'voice_route_reply', payload: { state: 'sent', agentId: 'a9' } }))
    ws.send(JSON.stringify({ type: 'voice_route_reply', payload: { voiceId: 'v3', state: 'maybe' } }))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(replies).toEqual([
      { voiceId: 'v1', reply: { t: 'taken' } },
      { voiceId: 'v1', reply: { t: 'sent', agentId: 'a7' } },
      { voiceId: 'v2', reply: { t: 'cancelled' } },
    ])
    // It describes a hand at this desk. The machine has no use for it.
    expect(backend.frames).toEqual([])
    ws.close()
  })

  it('answers a routed task on the id it was asked with, and sends nothing', async () => {
    const backend = new FakeBackend()
    const asked: string[] = []
    server = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
    local = attachLocalWsServer(server, {
      machineId,
      backend,
      onRouteTask: async (text) => {
        asked.push(text)
        return {
          agentId: 'a1', machineId: 'm-local', name: 'auth-api', confidence: 0.86, reason: 'name matches',
          weighed: 4, machines: 2, via: 'model',
          candidates: [{ agentId: 'a1', machineId: 'm-local', name: 'auth-api', machine: 'this computer', engine: 'claude', recent: 'token rotation', confidence: 0.86 }],
        }
      },
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-ws`

    const ws = new WebSocket(url)
    await onceOpen(ws)
    const connected = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }))
    await connected

    const answered = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'route_task', payload: { requestId: 'q-7', text: '  fix the retry  ' } }))
    const reply = await answered   // onceMessage already parses
    // The requestId comes back UNTOUCHED — it is the window's own rpc id, and the only thing tying this
    // answer to the spinner it is holding open.
    expect(reply.type).toBe('route_result')
    expect(reply.payload).toMatchObject({ requestId: 'q-7', agentId: 'a1', machineId: 'm-local', name: 'auth-api', confidence: 0.86 })
    expect(asked).toEqual(['fix the retry'])
    // Asking is not sending. Nothing reached the machine.
    expect(backend.frames.map((frame) => frame.type)).toEqual([])
    ws.close()
  })

  it('still answers when there is nothing to answer with', async () => {
    // The window holds a spinner on the id it asked with, so silence is the one reply it cannot recover
    // from — an empty task and a router that throws must both come back as frames.
    const backend = new FakeBackend()
    server = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
    local = attachLocalWsServer(server, {
      machineId,
      backend,
      onRouteTask: async () => { throw new Error('router unavailable') },
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-ws`

    const ws = new WebSocket(url)
    await onceOpen(ws)
    const connected = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }))
    await connected

    const blank = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'route_task', payload: { requestId: 'q-empty', text: '   ' } }))
    expect((await blank).payload).toMatchObject({ requestId: 'q-empty', agentId: '', reason: 'empty task' })

    const failed = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'route_task', payload: { requestId: 'q-throw', text: 'anything' } }))
    expect((await failed).payload).toMatchObject({ requestId: 'q-throw', agentId: '', reason: 'router unavailable' })
    ws.close()
  })

  it('delivers a committed route, and keeps the frame off the wire', async () => {
    const backend = new FakeBackend()
    const sent: Array<{ agentId: string; text: string }> = []
    server = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
    local = attachLocalWsServer(server, {
      machineId,
      backend,
      onRouteSend: (agentId, text) => {
        sent.push({ agentId, text })
        return { ok: true as const }
      },
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-ws`

    const ws = new WebSocket(url)
    await onceOpen(ws)
    const connected = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }))
    await connected

    const delivered = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'route_send', payload: { requestId: 's-1', agentId: 'a2', text: 'do the thing' } }))
    expect((await delivered).payload).toMatchObject({ requestId: 's-1', ok: true })

    // The half-formed one is dropped rather than delivered to whoever sorts first — and it is REFUSED
    // out loud, because the window is waiting on this id either way.
    const refused = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'route_send', payload: { requestId: 's-2', agentId: '', text: 'nobody' } }))
    expect((await refused).payload).toMatchObject({ requestId: 's-2', ok: false })

    expect(sent).toEqual([{ agentId: 'a2', text: 'do the thing' }])
    expect(backend.frames.map((frame) => frame.type)).toEqual([])
    ws.close()
  })

  it('says so when the agent could not be delivered to', async () => {
    // The remote leg carries no ack of its own: a machine that has gone deaf takes the turn and nothing
    // comes back. With the palette closing silently on a confident route, that is a task that vanishes
    // without a mark anywhere — so the refusal has to travel.
    const backend = new FakeBackend()
    server = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
    local = attachLocalWsServer(server, {
      machineId,
      backend,
      onRouteSend: () => ({ ok: false as const, machine: 'mac-mini', reason: 'the last request to it did not come back' }),
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-ws`

    const ws = new WebSocket(url)
    await onceOpen(ws)
    const connected = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }))
    await connected

    const answered = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'route_send', payload: { requestId: 's-3', agentId: 'a9', text: 'work' } }))
    expect((await answered).payload).toMatchObject({
      requestId: 's-3', ok: false, machine: 'mac-mini', reason: 'the last request to it did not come back',
    })
    ws.close()
  })

  it('does not require a credential on the loopback transport', async () => {
    const url = await start(new FakeBackend())
    const ws = new WebSocket(url, ['legacy-client-label'])
    await onceOpen(ws)
    ws.close()
  })

  it('rejects browser origins and machine-id mismatches', async () => {
    const url = await start(new FakeBackend())
    const browser = new WebSocket(url, { origin: 'https://example.com' })
    const error = await new Promise<Error>((resolve) => browser.once('error', resolve))
    expect(error.message).toContain('403')

    const ws = new WebSocket(url)
    await onceOpen(ws)
    const closed = new Promise<number>((resolve) => ws.once('close', resolve))
    ws.send(JSON.stringify({
      type: 'machine_select',
      payload: { machineId: 'other-machine', localProtocolVersion: 1 },
    }))
    await expect(closed).resolves.toBe(4403)
  })
})
