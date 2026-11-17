// The dev-only TCP cable (HARNESS_CABLE_TCP): the variable, the backoff, and a real socket on this computer carrying the
// same frames as USB. The listener is the test's own on 127.0.0.1 port 0: never the developer's daemon or device.
import { mkdtempSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CableDecoder, CableType, encodeCableFrame } from './cableFrame.js'
import { CableSession, type CableHost, type CablePort } from './cableSession.js'
import { parseCableTcp, tcpOpener, tcpPortPath, type CableTcpAddress } from './cableTcp.js'
import { DialLog } from './dialLog.js'
import { SerialLink } from './serial.js'

describe('HARNESS_CABLE_TCP', () => {
  it('names nothing when unset or blank', () => {
    expect(parseCableTcp(undefined)).toEqual({ addresses: [], rejected: [] })
    expect(parseCableTcp('  ')).toEqual({ addresses: [], rejected: [] })
    expect(parseCableTcp(' , ')).toEqual({ addresses: [], rejected: [] })
  })

  it('reads host:port pairs, IPv6 in brackets, each once', () => {
    expect(parseCableTcp(' 127.0.0.1:7000 , orangepi.local:7001,[::1]:7002,127.0.0.1:7000 ').addresses).toEqual([
      { host: '127.0.0.1', port: 7000 }, { host: 'orangepi.local', port: 7001 }, { host: '::1', port: 7002 },
    ])
  })

  it('rejects what is not one, by its own words, and keeps the rest', () => {
    const bad = ['nohost', ':7000', 'host:0', 'host:65536', 'host:70a', 'a b:7000', '::1:7000', '[::1]', '[]:7000', 'host:']
    expect(parseCableTcp([...bad, 'box:65535'].join(','))).toEqual({ addresses: [{ host: 'box', port: 65535 }], rejected: bad })
  })

  it('is named as a port path the logs and the fleet read', () => {
    expect(tcpPortPath({ host: '127.0.0.1', port: 7000 })).toBe('tcp:127.0.0.1:7000')
    expect(tcpPortPath({ host: '::1', port: 7002 })).toBe('tcp:[::1]:7002')
  })
})

describe('the TCP opener', () => {
  const address: CableTcpAddress = { host: 'board.local', port: 7000 }
  const port = { path: 'tcp:board.local:7000', isOpen: true, write: async () => {}, close: async () => {} } satisfies CablePort

  it('backs off after a refused connect, doubling to the most, and says so once per streak', async () => {
    let now = 0
    const log = vi.fn()
    const connect = vi.fn(async (): Promise<CablePort> => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
    const open = tcpOpener(address, { connect, log, now: () => now, minMs: 100, maxMs: 350 })
    const noop = () => {}
    // Refused: no port, and no throw, so the session does not log "cannot open the dial" on every reopen.
    expect(await open(noop, noop)).toBeNull()
    expect(connect).toHaveBeenCalledTimes(1)
    expect(log.mock.calls).toEqual([['cable: tcp:board.local:7000 not reachable (ECONNREFUSED) — trying again, waiting up to 0.35 s']])
    // Inside the wait: not even tried.
    now = 99
    expect(await open(noop, noop)).toBeNull()
    expect(connect).toHaveBeenCalledTimes(1)
    // Each failure doubles the wait: 100, 200, then 350 at the most.
    for (const [at, waits] of [[100, 200], [300, 350], [650, 350]] as const) {
      now = at
      expect(await open(noop, noop)).toBeNull()
      now = at + waits - 1
      expect(await open(noop, noop)).toBeNull()
    }
    expect(connect).toHaveBeenCalledTimes(4)
    expect(log).toHaveBeenCalledTimes(1)
    // Answering again: the port, a line, and the wait starts over at its least.
    connect.mockResolvedValueOnce(port)
    now = 1000
    expect(await open(noop, noop)).toBe(port)
    expect(log).toHaveBeenLastCalledWith('cable: tcp:board.local:7000 is reachable again')
    now = 1001
    expect(await open(noop, noop)).toBeNull()
    now = 1101
    expect(await open(noop, noop)).toBeNull()
    expect(connect).toHaveBeenCalledTimes(7)
    expect(log).toHaveBeenCalledTimes(3)
  })
})

/** Frames the daemon wrote to one socket, decoded. */
function frames(socket: Socket): Array<Record<string, unknown>> {
  const decoder = new CableDecoder()
  const out: Array<Record<string, unknown>> = []
  socket.on('data', (chunk) => decoder.feed(chunk, (frame) => {
    if (frame.type === CableType.Json) out.push(JSON.parse(Buffer.from(frame.payload).toString('utf8')) as Record<string, unknown>)
  }))
  return out
}

const hello = (mac: string) => encodeCableFrame(CableType.Json, Buffer.from(JSON.stringify({ t: 'hello', product: 'harness', mac, fw: 'fixture', proto: 3, board: 'max' })))

function host(): CableHost {
  return {
    localMachine: () => ({ id: 'local', name: 'Fixture' }),
    listMachines: async () => ({ machines: [], source: 'backend' }),
    selectedMachine: () => 'local', selectMachine: async () => ({ ok: true }),
    listSwarms: () => ({ selected: '', swarms: [], tiles: [] }), listUnread: () => [],
    selectSwarm: vi.fn(), appName: () => 'harness', voiceLang: () => 'en',
    listAgents: async () => [{ id: 'a', name: 'A', engine: 'codex' }], agentTotal: () => 1,
    activeSwarm: () => '', describe: () => ({ name: 'A', engine: 'codex', machine: 'local' }),
    sendTurn: vi.fn(), stopTurn: vi.fn(), scrolled: vi.fn(), answer: vi.fn(), focus: vi.fn(),
    openAgent: vi.fn(), forkAgent: async () => ({ ok: true, agentId: 'fork' }), updateAgent: vi.fn(),
    listModels: async () => [], recentSummaries: async () => [],
    transcribe: vi.fn(async () => ''), route: async () => ({ agentId: 'a', confidence: 1, reason: 'fixture' }), log: vi.fn(),
  }
}

describe('a cable session over TCP', () => {
  let server: Server | undefined
  let session: CableSession | undefined
  afterEach(async () => {
    await session?.stop()
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve())
    session = server = undefined
  })

  it('greets the device that listens, and connects again when the device drops the socket', async () => {
    const sockets: Socket[] = []
    const heard: Array<Array<Record<string, unknown>>> = []
    server = createServer((socket) => {
      sockets.push(socket)
      heard.push(frames(socket))
      socket.write(hello(`aa:0${sockets.length}`))
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    const daemon = host()
    session = new CableSession(daemon, new DialLog(mkdtempSync(join(tmpdir(), 'cable-tcp-'))),
      tcpOpener({ host: '127.0.0.1', port }, { log: daemon.log, minMs: 50, maxMs: 200 }), { allowPermissions: false })
    session.start()
    await vi.waitFor(() => expect(heard[0]?.map((m) => m.t)).toContain('agents.end'), { timeout: 5_000 })
    expect(heard[0][0]).toMatchObject({ t: 'welcome', proto: 3, seq: 0 })
    expect(daemon.log).toHaveBeenCalledWith(`cable: open on tcp:127.0.0.1:${port}`)
    // The device restarts: its socket goes, and the daemon is back on a new one, greeted afresh.
    sockets[0].destroy()
    await vi.waitFor(() => expect(heard[1]?.map((m) => m.t)).toContain('agents.end'), { timeout: 8_000 })
    expect(heard[1][0]).toMatchObject({ t: 'welcome', seq: 0 })
    expect(session.isConnected).toBe(true)
  })

  it('is refused plainly when nothing listens', async () => {
    server = createServer()
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = undefined
    await expect(SerialLink.connect(`tcp:127.0.0.1:${port}`, '127.0.0.1', port, () => {}, () => {}))
      .rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })
})
