import type { BrowserRuntime, BrowserRuntimeSlot } from './agentBrowserRuntime.js'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgentLife } from '../core/agentLife.js'
import { emptyPorts, type Asker, type CoreApi, type CorePorts, type ServiceRequests, type TurnDelivery } from '../core/api.js'
import type { AgentBrowserFrame } from '../lib/agentFrame.js'
import type { RegisteredSession } from '../lib/registry.js'
import { decodeTerminalLocal } from '../lib/terminalBinary.js'
import { fakeCore } from '../testing/fakeCore.js'
import { browserAssetsHash } from './agentBrowser/assets.js'
import { fakePodman, type FakePodman } from './agentBrowser/fakePodman.js'
import { imageTag } from './agentBrowser/image.js'
import { READY_LINE, STOPPED_LINE } from './agentBrowser/notices.js'
import { createPodman } from './agentBrowser/podman.js'
import { runAgentBrowserService } from './agentBrowserProcess.js'
import type { ServiceProcessOptions } from './process.js'
import { defaultSettings, settingsHash, type BrowserSettings } from './agentBrowser/settings.js'
import { StateFile } from './agentBrowser/stateFile.js'
import { resetAgentTmpSweep } from '../lib/agentTmp.js'
import { Browsers } from './agentBrowser/browsers.js'
import { Containers } from './agentBrowser/containers.js'
import { AGENT_BROWSER_REQUESTS, daemonIdOf, startAgentBrowser, type AgentBrowserOptions } from './agentBrowser.js'

vi.mock('node:child_process', async (importOriginal) =>
  (await import('./agentBrowser/fakePodman.js')).trackingFakes(await importOriginal<typeof import('node:child_process')>()))

const GiB = 1024 ** 3
const NOW = new Date('2026-11-10T12:00:00Z')
const HOST = { timeZone: 'Asia/Ho_Chi_Minh', languages: 'vi-VN' }
const LOCAL: Asker = { local: true, owner: true }
const OTHER_DESKTOP: Asker = { local: false, owner: true, accountOwner: true }
const SHARE_GUEST: Asker = { local: false, owner: true, accountOwner: true, guest: 'kim@acme.io' }
const PLAIN_OWNER: Asker = { local: false, owner: true }

const session = (agentId: string, over: Partial<RegisteredSession> = {}) => ({ agentId, sessionId: `s-${agentId}`, browser: true, ...over }) as RegisteredSession

let fake: FakePodman
let dataDir: string
const started: BrowserRuntimeSlot[] = []
const servers: Server[] = []

beforeEach(() => {
  fake = fakePodman()
  dataDir = mkdtempSync(join(tmpdir(), 'agent-browser-'))
  fake.reply('info --format json', { stdout: JSON.stringify({ version: { Version: '5.8.1' }, host: { memTotal: 8 * GiB } }) })
  fake.reply('ps', { stdout: '[]' })
  fake.reply('images --format json --filter reference=localhost/harness-browser', {
    stdout: JSON.stringify([{ Names: [`localhost/${imageTag(browserAssetsHash(), NOW)}`], Created: 1, Containers: 0 }]),
  })
})
afterEach(async () => {
  vi.useRealTimers()
  await stopAll()
  for (const server of servers.splice(0)) server.close()
  rmSync(dataDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** Every service stopped and the fake removed once its calls have ended: a save's restart goes on after the request. */
async function stopAll() {
  for (const ports of started.splice(0)) ports.agentBrowser?.stop()
  await fake.remove()
}

/** The port, and what the core tells the service of agents as it follows them (core/agentLife.ts): a look at a live
 *  agent, its end, its purge and a new agent in the pane one ended in. */
type Port = BrowserRuntime & {
  published(agentId: string): AgentBrowserFrame | undefined
  running(session: RegisteredSession): void
  ended(agentId: string): void
  purged(agentId: string): void
  taken(from: string, to: RegisteredSession): void
}

function start(core: CoreApi = fakeCore({ dataDir }), options: AgentBrowserOptions = {}, hub = createAgentLife({ live: () => [], notify: () => true, hears: {} })) {
  const published = new Map<string, AgentBrowserFrame>()
  core.agents.publishFrame = vi.fn((session, fields) => {
    if (fields.browser) published.set(session.agentId, fields.browser as AgentBrowserFrame)
    else published.delete(session.agentId)
  })
  hub.follow(event => { if (event.kind === 'ended' || event.kind === 'purged') published.delete(event.agentId) })
  // A core the spec lends no following follows through [hub].
  core.agents.follow ??= hub.follow
  const ports: BrowserRuntimeSlot = { agentBrowser: null }
  started.push(ports)
  const requests = startAgentBrowser(core, ports, {
    podman: createPodman({ resolve: async () => fake.path, platform: 'linux' }),
    platform: 'linux',
    host: HOST,
    now: () => NOW,
    // Which agents are here, unless the spec says: no answer, which deletes no browser.
    everyAgent: async () => null,
    ...options,
  }) as ServiceRequests
  const port: Port = { ...ports.agentBrowser!, published: id => published.get(id), running: hub.running, ended: id => { published.delete(id); hub.ended(id) }, purged: id => { published.delete(id); hub.purged(id, []) }, taken: hub.taken }
  return { port, requests, core, hub }
}

/** What podman was asked, as argv lines, without the event stream's reconnects. */
const asked = () => fake.calls().map(call => call.args.join(' ')).filter(line => !line.startsWith('events '))

/** Each fake podman call starts a Node process: a few of them in a row take longer than waitFor's default second. */
const eventually = (check: () => void) => vi.waitFor(check, { timeout: 15_000 })

async function ready(port: Port, agentId: string) {
  await eventually(() => expect(port!.published(agentId)).toEqual({ state: 'ready' }))
}

/** The fake podman, with its event stream watched: that child reads stdin to its end, so the fake never logs it. */
function podmanHere() {
  const podman = createPodman({ resolve: async () => fake.path, platform: 'linux' })
  return { podman, spawn: vi.spyOn(podman, 'spawn') }
}

/**
 * A browser's viewers, as the core stands for them (core/browserStreams.ts): what a stream answers and the screen's
 * bytes it sends, and each exec the service started to pipe a screen, which the spec drives in place of `socat`.
 */
function viewing(clients = true) {
  const podman = createPodman({ resolve: async () => fake.path, platform: 'linux' })
  const real = podman.spawn
  const pipes: Array<EventEmitter & { args: string[]; stdin: PassThrough; stdout: PassThrough; kill: ReturnType<typeof vi.fn> }> = []
  vi.spyOn(podman, 'spawn').mockImplementation((args) => {
    if (args[0] !== 'exec') return real(args)
    // Running, as a child Node started: no exit code and no signal yet.
    const pipe = Object.assign(new EventEmitter(), { args, stdin: new PassThrough(), stdout: new PassThrough(), stderr: null, exitCode: null, signalCode: null, kill: vi.fn(() => true) })
    pipes.push(pipe)
    return pipe as unknown as ChildProcess
  })
  const frames: Array<[connId: string, type: string, payload: Record<string, unknown>]> = []
  const screen: Array<[streamId: string, seq: number, bytes: string]> = []
  const core = fakeCore({ dataDir, ...(clients ? { clients: {
    streamFrame: (connId, type, payload) => { frames.push([connId, type, payload]); return true },
    // The service frames them as a window is sent them, and the core sends that frame on as it is.
    streamBytes: (frame) => {
      const { streamId, seq, bytes } = decodeTerminalLocal(frame)!
      screen.push([streamId, seq, Buffer.from(bytes).toString()])
      return true
    },
  } } : {}) })
  let opens = 0
  /** A viewer's open through the port: the stream it was given, or why none. */
  const open = (port: BrowserRuntime, agentId: string, asker: Asker = LOCAL, connId = 'local:w'): string => {
    const requestId = `r-${++opens}`
    expect(port.stream(connId, 'agent_browser_open', { requestId, agentId }, asker)).toBe(true)
    const answer = frames.find(([, type, payload]) => type === 'agent_browser_open_result' && payload.requestId === requestId)![2]
    return (answer.streamId ?? answer.error) as string
  }
  const closes = () => frames.filter(([, type]) => type === 'agent_browser_close').map(([connId, , payload]) => [connId, payload.streamId, payload.reason])
  return { podman, pipes, core, frames, screen, open, closes }
}
const VNC_PIPE_ARGS = (profile: string) => ['exec', '-i', `harness-browser-${profile}`, 'socat', 'STDIO', 'TCP:127.0.0.1:5900']

function saveState(browsers: Record<string, BrowserSettings>, deleting: string[] = []) {
  writeFileSync(join(dataDir, 'agent-browser.json'), JSON.stringify({ browsers, deleting, setup: null }), { mode: 0o600 })
}

const savedState = () => JSON.parse(readFileSync(join(dataDir, 'agent-browser.json'), 'utf8')) as { browsers: Record<string, unknown>; deleting: string[]; told?: Record<string, true> }

/**
 * The service on a core whose agents it follows as every service does (core/agentLife.ts): [rows] are the agents that run
 * here, told to it as it starts, then each run (`attach`), end (`end`), purge (`purge`) and pane taken (`move`). Whose
 * Browser is on is the service's own, in its state file. The lines it types are recorded, and the spec says what became
 * of them.
 */
function startSwitching(rows: RegisteredSession[] = [session('a1', { browser: undefined })], over: {
  count?: (name: string) => void
  options?: AgentBrowserOptions
  agents?: Partial<CoreApi['agents']>
  core?: Parameters<typeof fakeCore>[0]
} = {}) {
  const byId = new Map(rows.map(row => [row.agentId, { ...row }]))
  const live = new Set(byId.keys())
  const typed: Array<{ agentId: string; text: string; deliveryId: string }> = []
  const listeners = new Set<(event: TurnDelivery) => void>()
  const hub = createAgentLife({ live: () => [...byId.values()].filter(row => live.has(row.agentId)), notify: () => true, hears: {} })
  const core = fakeCore({
    dataDir,
    ...over.core,
    ...(over.count ? { count: over.count } : {}),
    agents: { byAgent: (agentId: string) => byId.get(agentId), follow: hub.follow, ...over.agents },
    turns: {
      // Only what a line is: its agent, its text and its id. A delivery's options are the core's to read.
      deliver: vi.fn((agentId: string, text: string, deliveryId: string) => { typed.push({ agentId, text, deliveryId }) }),
      cancelDelivery: vi.fn(() => false),
      onDelivery: vi.fn((listener: (event: TurnDelivery) => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }),
    },
  })
  const started = start(core, over.options, hub)
  return {
    ...started,
    rows: byId,
    typed,
    /** The agent runs again (a resume, a restart): the core looks at it. */
    attach: (agentId: string) => {
      live.add(agentId)
      hub.running(byId.get(agentId)!)
    },
    /** The agent's own end, or any stop of it. */
    end: (agentId: string) => {
      live.delete(agentId)
      hub.ended(agentId)
    },
    /** Deleted for good. */
    purge: (agentId: string) => {
      live.delete(agentId)
      hub.purged(agentId, [`s-${agentId}`])
    },
    /** [to] took the pane [from] ended in (core/agents/discovery.ts). */
    move: (from: string, to: string) => hub.taken(from, byId.get(to)!),
    hear: (deliveryId: string, state: TurnDelivery['state']) => {
      for (const listener of [...listeners]) listener({ deliveryId, sessionId: deliveryId.split(':')[1]!, state })
    },
  }
}

/** Whose Browser is on, as the service keeps it. */
const turnedOn = () => (savedState() as { on?: Record<string, true> }).on ?? {}

/** A line typed into [agentId]: its text and its id's prefix, never the whole delivery. */
const lineTo = (agentId: string, text: string, kind: 'ready' | 'stopped') =>
  ({ agentId, text, deliveryId: expect.stringMatching(new RegExp(`^agent-browser:${agentId}:${kind}:`)) })

/** The stop's removal has finished: the proxy secret is removed once at each start and once at each stop. */
const secretsRemoved = (agentId: string) => asked().filter(call => call === `secret rm harness-proxy-${agentId}`).length

/** An HTTP proxy on loopback that answers the exit lookup. */
async function lookupProxy(answer: Record<string, unknown> = { status: 'success', timezone: 'Europe/Paris', query: '203.0.113.7' }): Promise<number> {
  const server = createServer(socket => socket.once('data', () => socket.end(`HTTP/1.1 200 OK\r\n\r\n${JSON.stringify(answer)}`)))
  servers.push(server)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  return (server.address() as AddressInfo).port
}

describe('the agent browser service', () => {
  it('declares its requests and answers each', () => {
    const { requests } = start()
    expect(Object.keys(requests).sort()).toEqual([...AGENT_BROWSER_REQUESTS].sort())
    expect(daemonIdOf('/data')).toMatch(/^[0-9a-f]{16}$/)
    expect(daemonIdOf('/data')).toBe(daemonIdOf('/data/'))
    expect(daemonIdOf('/data')).not.toBe(daemonIdOf('/other'))
  })

  it('attached starts a browser only for browser:true sessions, and counts agent_browser_enabled once per agent', async () => {
    const count = vi.fn()
    const { port } = start(fakeCore({ dataDir, count }))
    port.running(session('a1'))
    port.running(session('a1'))
    port.running(session('a2', { browser: undefined }))
    await ready(port, 'a1')
    expect(port.published('a2')).toBeUndefined()
    expect(asked().filter(line => line.includes('harness-browser-a2'))).toEqual([])
    expect(asked().filter(line => line.startsWith('create '))).toHaveLength(1)
    expect(count.mock.calls.filter(([name]) => name === 'agent_browser_enabled')).toEqual([['agent_browser_enabled']])
    expect(count).toHaveBeenCalledWith('agent_browser_start_ok')
    // The next daemon finds it in the state file: the same agent is not counted again.
    port.stop()
    const again = start(fakeCore({ dataDir, count }))
    again.port.running(session('a1'))
    await ready(again.port, 'a1')
    expect(count.mock.calls.filter(([name]) => name === 'agent_browser_enabled')).toHaveLength(1)
  })

  it('labels its containers with a stable hash of its data folder', async () => {
    const { podman, spawn } = podmanHere()
    const { port } = start(undefined, { podman })
    port.running(session('a1'))
    await ready(port, 'a1')
    expect(asked().find(line => line.startsWith('create '))).toContain(`--label harness.daemon=${daemonIdOf(dataDir)}`)
    // One event stream, for this daemon's exits alone.
    expect(spawn.mock.calls).toEqual([[['events', '--format', 'json', '--filter', 'event=died', '--filter', `label=harness.daemon=${daemonIdOf(dataDir)}`]]])
  })

  it('stopped stops, deleted deletes', async () => {
    const { port } = start()
    port.running(session('a1'))
    await ready(port, 'a1')
    port.ended('a1')
    await eventually(() => expect(asked()).toContain('network rm harness-browser-a1'))
    expect(asked()).toContain('rm --force --time 10 harness-browser-a1')
    expect(asked()).not.toContain('volume rm harness-browser-a1')
    expect(port.published('a1')).toBeUndefined()
    // The proxy secret lives only while its container does.
    const secretRemoves = () => asked().filter(line => line === 'secret rm harness-proxy-a1').length
    await eventually(() => expect(secretRemoves()).toBe(2))
    // A stopped agent is still listed: its purge deletes its browser and its profile.
    port.purged('a1')
    await eventually(() => expect(asked()).toContain('volume rm harness-browser-a1'))
    await eventually(() => expect(secretRemoves()).toBe(3))
    // An agent without a browser costs Podman nothing: none is asked for its stop or its delete.
    const before = asked().length
    port.ended('plain')
    port.purged('plain')
    expect(asked()).toHaveLength(before)
  })

  // A viewer's stream is this service's own exec into the browser's container (agentBrowser/streams.ts). Until the audit
  // of 2026-11-12 the core was handed the command line and started it, in the process that types into every terminal.
  it('a viewer\'s open is NO_BROWSER, NOT_READY, then a stream piped from the ready browser\'s screen', async () => {
    const v = viewing()
    const { port } = start(v.core, { podman: v.podman })
    expect(v.open(port, 'a1')).toBe('NO_BROWSER')
    port.running(session('a1'))
    await ready(port, 'a1')
    const stream = v.open(port, 'a1')
    expect(stream).toMatch(/^[0-9a-f-]{36}$/)
    expect(v.pipes.map(pipe => pipe.args)).toEqual([VNC_PIPE_ARGS('a1')])
    // The screen's bytes go to the core under their stream, and its viewer's to the pipe.
    v.pipes[0]!.stdout.write('RFB 003.008\n')
    await eventually(() => expect(v.screen).toEqual([[stream, 0, 'RFB 003.008\n']]))
    port.streamInput(stream, new TextEncoder().encode('RFB 003.008\n'))
    expect(v.pipes[0]!.stdin.read()?.toString()).toBe('RFB 003.008\n')
    // An ack is the stream's; a frame of no stream's kind is nobody's.
    expect(port.stream('local:w', 'agent_browser_ack', { streamId: stream, bytes: 12 }, LOCAL)).toBe(true)
    expect(port.stream('local:w', 'viewer_data', { streamId: stream }, LOCAL)).toBe(false)
    expect(v.closes()).toEqual([])
    expect(port.stream('local:w', 'agent_browser_close', { streamId: stream }, LOCAL)).toBe(true)
    expect(v.closes()).toEqual([['local:w', stream, 'closed']])

    // Who may open is `mayOpenBrowser`, here as in the core: never a share's guest or a plain owner.
    expect(v.open(port, 'a1', SHARE_GUEST, 'share')).toBe('NOT_OWNER')
    expect(v.open(port, 'a1', PLAIN_OWNER, 'web')).toBe('NOT_OWNER')
    expect(v.pipes).toHaveLength(1)

    fake.reply('info --format json', { stdout: JSON.stringify({ version: { Version: '4.3.0' }, host: { memTotal: 8 * GiB } }) })
    const old = start(fakeCore({ dataDir: mkdtempSync(join(dataDir, 'old-')), clients: v.core.clients }))
    old.port.running(session('a2'))
    await eventually(() => expect(old.port.published('a2')).toEqual({ state: 'failed', error: 'podman_old' }))
    expect(v.open(old.port, 'a2')).toBe('NOT_READY')
  })

  it('a stream ends with its connection, its route, a relay that refused a frame, and a viewer whose transport refused one', async () => {
    const v = viewing()
    const { port } = start(v.core, { podman: v.podman })
    port.running(session('a1'))
    await ready(port, 'a1')
    const gone = v.open(port, 'a1', OTHER_DESKTOP, 'mac-2')
    port.streamClosed('mac-2')
    const moved = v.open(port, 'a1', OTHER_DESKTOP, 'mac-3')
    // The gateway's word on its route, which it keeps; then that the route went away.
    port.streamRoute(moved, 'direct')
    expect(v.closes()).toEqual([['mac-2', gone, 'closed']])
    port.streamRoute(moved, null)
    const relayed = v.open(port, 'a1', OTHER_DESKTOP, 'mac-4')
    port.streamTransportError()
    const refused = v.open(port, 'a1')
    port.streamRefused(refused)
    expect(v.closes()).toEqual([['mac-2', gone, 'closed'], ['mac-3', moved, 'route'], ['mac-4', relayed, 'rate'], ['local:w', refused, 'backlog']])
  })

  it('a stop and a delete close the browser\'s viewers at once', async () => {
    const v = viewing()
    const { port } = start(v.core, { podman: v.podman })
    port.running(session('a1'))
    port.running(session('a2'))
    await ready(port, 'a1')
    await ready(port, 'a2')
    const first = v.open(port, 'a1')
    const second = v.open(port, 'a2', OTHER_DESKTOP, 'mac-2')
    port.ended('a1')
    port.purged('a2')
    // In the same turn, before any Podman call has ended.
    expect(v.closes()).toEqual([['local:w', first, 'agent'], ['mac-2', second, 'agent']])
  })

  // Switched off in the core's process, nothing else would end a viewer's exec: it went on piping a screen nobody
  // could use (review, 2026-11-13).
  it('every viewer\'s stream ends as the service stops, and an open with nobody asking is no open', async () => {
    const v = viewing()
    const { port } = start(v.core, { podman: v.podman })
    port.running(session('a1'))
    await ready(port, 'a1')
    expect(port.stream('local:w', 'agent_browser_open', { requestId: 'r-0', agentId: 'a1' })).toBe(false)
    expect(v.pipes).toEqual([])
    const stream = v.open(port, 'a1')
    expect(port.streamInput(stream, Uint8Array.of(1))).toBe(true)
    port.stop()
    expect(v.closes()).toEqual([['local:w', stream, 'agent']])
    expect(v.pipes[0]!.kill).toHaveBeenCalled()
  })

  it('a stream whose exec does not start is NOT_READY', async () => {
    const v = viewing()
    const { port } = start(v.core, { podman: v.podman })
    port.running(session('a1'))
    await ready(port, 'a1')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      vi.mocked(v.podman.spawn).mockImplementationOnce(() => { throw new Error('Podman is not installed') })
      expect(v.open(port, 'a1')).toBe('NOT_READY')
    } finally {
      warn.mockRestore()
    }
  })

  // A core that offers a service no browser streams (one from before 2026-11-13, were it to run this service): the
  // stream has nowhere to send, and ends at its first byte instead of piping a screen to nobody.
  it('a stream on a core that takes none of its answers or bytes ends at its first byte', async () => {
    const v = viewing(false)
    const { port } = start(v.core, { podman: v.podman })
    port.running(session('a1'))
    await ready(port, 'a1')
    expect(port.stream('local:w', 'agent_browser_open', { requestId: 'r-1', agentId: 'a1' }, LOCAL)).toBe(true)
    expect(v.pipes).toHaveLength(1)
    v.pipes[0]!.stdout.write('RFB 003.008\n')
    await eventually(() => expect(v.pipes[0]!.stdin.writableEnded).toBe(true))
  })

  it('publishes Browser state through the shared service API', async () => {
    const row = session('a1')
    const { port, core } = start(fakeCore({ dataDir }))
    port.running(row)
    await ready(port, 'a1')
    expect(core.agents.publishFrame).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a1', frameEpoch: expect.any(String) }), { browser: { state: 'starting' } })
    expect(core.agents.publishFrame).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: 'a1' }), { browser: { state: 'ready' } })
    expect(core.agents.sync).not.toHaveBeenCalled()
  })

  it('setup refuses a non-local asker', async () => {
    const count = vi.fn()
    const { requests } = start(fakeCore({ dataDir, count }))
    for (const asker of [OTHER_DESKTOP, PLAIN_OWNER]) {
      expect(await requests.agent_browser_setup!({}, asker)).toEqual({ error: 'LOCAL_ONLY' })
      expect(await requests.agent_browser_state!({ pane: '%1' }, asker)).toEqual({ error: 'LOCAL_ONLY' })
    }
    // Podman is here already, and Linux runs it in no machine: setup has nothing to install, and says it is done.
    expect(await requests.agent_browser_setup!({}, LOCAL)).toEqual({ ok: true })
    await eventually(() => expect(count).toHaveBeenCalledWith('agent_browser_setup_ok'))
  })

  // Retry after a failed install runs the install again: the password dialog shows on that computer, so only it may ask.
  it('retry that would run setup again refuses a non-local asker', async () => {
    const missing = createPodman({ resolve: async () => null, exists: () => false, platform: 'linux' })
    const which = async (cmd: string) => (cmd === 'pkexec' || cmd === 'apt-get' ? `/usr/bin/${cmd}` : null)
    for (const [interactive, error] of [[true, 'podman_install_failed'], [false, 'podman_manual']] as const) {
      const run = vi.fn(async () => ({ code: 126, stdout: '', stderr: 'cancelled' }))
      const { port, requests } = start(fakeCore({ dataDir: mkdtempSync(join(dataDir, 'setup-')) }), {
        podman: missing, setup: { which, run, interactive: () => interactive },
      })
      port.running(session('a1'))
      await eventually(() => expect(port.published('a1')).toEqual({ state: 'failed', error: 'needs_setup' }))
      expect(await requests.agent_browser_setup!({}, LOCAL)).toEqual({ ok: true })
      await eventually(() => expect(port.published('a1')).toEqual({ state: 'failed', error }))
      const installs = run.mock.calls.length
      // Start of a failed browser is its Retry, with the same rule.
      for (const type of ['agent_browser_retry', 'agent_browser_start']) {
        for (const asker of [OTHER_DESKTOP, SHARE_GUEST]) {
          expect(await requests[type]!({ agentId: 'a1' }, asker), type).toEqual(asker === OTHER_DESKTOP ? { error: 'LOCAL_ONLY' } : { error: 'NOT_OWNER' })
        }
      }
      // The refusal is decided before anything runs: setup was not asked again.
      expect(port.published('a1')).toEqual({ state: 'failed', error })
      expect(run).toHaveBeenCalledTimes(installs)
      expect(await requests.agent_browser_retry!({ agentId: 'a1' }, LOCAL)).toEqual({ ok: true })
      if (interactive) await eventually(() => expect(run).toHaveBeenCalledTimes(installs + 1))
    }
  })

  it('on win32 availability is unsupported and no process starts', async () => {
    // A state file starts the service's look at Podman at once anywhere else.
    saveState({ a1: defaultSettings(HOST) })
    const run = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }))
    const { podman, spawn } = podmanHere()
    const streamFrame = vi.fn(() => true)
    const { port, requests } = start(fakeCore({ dataDir, clients: { streamFrame } }), { platform: 'win32', podman, setup: { run } })
    expect(await requests.agent_browser_available!({}, PLAIN_OWNER)).toEqual({ state: 'unsupported' })
    port.running(session('a1'))
    port.ended('a1')
    port.purged('a1')
    expect(port.published('a1')).toBeUndefined()
    expect(port.stream('local:w', 'agent_browser_open', { requestId: 'r-1', agentId: 'a1' }, LOCAL)).toBe(true)
    expect(streamFrame).toHaveBeenCalledExactlyOnceWith('local:w', 'agent_browser_open_result', { requestId: 'r-1', error: 'NO_BROWSER' })
    expect(port.stream('local:w', 'agent_browser_open', {}, LOCAL)).toBe(false)
    expect(port.stream('local:w', 'agent_browser_close', { streamId: 's' }, LOCAL)).toBe(false)
    port.streamInput('s', Uint8Array.of(1))
    port.streamClosed('local:w')
    port.streamRoute('s', 'direct')
    port.streamTransportError()
    port.streamRefused('s')
    expect(fake.calls()).toEqual([])
    expect(spawn).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('on win32 every other request answers UNSUPPORTED', async () => {
    const { requests } = start(undefined, { platform: 'win32' })
    expect(Object.keys(requests).sort()).toEqual([...AGENT_BROWSER_REQUESTS].sort())
    const named = ['agent_browser_available', 'agent_browser_start', 'agent_browser_stop', 'agent_browser_run', 'agent_browser_window']
    for (const type of AGENT_BROWSER_REQUESTS.filter(type => !named.includes(type))) {
      expect(await requests[type]!({ agentId: 'a1', pane: '%1' }, LOCAL), type).toEqual({ error: 'UNSUPPORTED' })
    }
    expect(fake.calls()).toEqual([])
  })

  // Desktop says Windows, not "update Harness", for the person's Start and Stop (spec § Desktop); `harness browser`
  // exits before it asks, and an older one is told the same.
  it('on win32 run and window answer NOT_ON_WINDOWS', async () => {
    const { podman, spawn } = podmanHere()
    const ofPane = vi.fn(async () => ({ agentId: 'a1', guest: false }))
    const { requests } = start(fakeCore({ dataDir, agents: { ofPane } }), { platform: 'win32', podman })
    expect(await requests.agent_browser_run!({ pane: '%7', ancestors: [4242], command: 'snapshot', args: {} }, LOCAL)).toEqual({ error: 'NOT_ON_WINDOWS' })
    expect(await requests.agent_browser_window!({ agentId: 'a1', width: 1200, height: 800 }, LOCAL)).toEqual({ error: 'NOT_ON_WINDOWS' })
    expect(ofPane).not.toHaveBeenCalled()
    expect(fake.calls()).toEqual([])
    expect(spawn).not.toHaveBeenCalled()
  })

  it('on win32 start and stop answer NOT_ON_WINDOWS and no process starts', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }))
    const { podman, spawn } = podmanHere()
    const { requests } = start(fakeCore({ dataDir }), { platform: 'win32', podman, setup: { run } })
    for (const type of ['agent_browser_start', 'agent_browser_stop']) {
      expect(await requests[type]!({ agentId: 'a1' }, LOCAL), type).toEqual({ error: 'NOT_ON_WINDOWS' })
    }
    expect(existsSync(join(dataDir, 'agent-browser.json'))).toBe(false)
    expect(fake.calls()).toEqual([])
    expect(spawn).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('available answers what Podman is, to any asker', async () => {
    const { requests } = start()
    expect(await requests.agent_browser_available!({}, PLAIN_OWNER)).toEqual({ state: 'ready' })
    // Podman that will not answer is named, never a failed request.
    fake.reply('info --format json', { code: 125, stderr: 'cannot connect' })
    const down = start(undefined, { podman: createPodman({ resolve: async () => fake.path, platform: 'linux' }) })
    expect(await down.requests.agent_browser_available!({}, PLAIN_OWNER)).toEqual({ state: 'podman_down' })
  })

  it('retry, settings, settings_save and proxy_test refuse a share guest and a plain owner without accountOwner', async () => {
    const { port, requests } = start(undefined, { everyAgent: async () => [] })
    port.running(session('a1'))
    await ready(port, 'a1')
    for (const type of ['agent_browser_retry', 'agent_browser_settings', 'agent_browser_settings_save', 'agent_browser_proxy_test']) {
      for (const asker of [SHARE_GUEST, PLAIN_OWNER, { ...LOCAL, guest: 'kim@acme.io' }]) {
        expect(await requests[type]!({ agentId: 'a1', settings: {}, proxy: null }, asker), type).toEqual({ error: 'NOT_OWNER' })
      }
      // An agent with no browser here has none to retry or change.
      expect(await requests[type]!({ agentId: 'nobody' }, OTHER_DESKTOP), type).toEqual({ error: 'NO_BROWSER' })
      expect(await requests[type]!({}, LOCAL), type).toEqual({ error: 'NO_BROWSER' })
    }
    expect(await requests.agent_browser_retry!({ agentId: 'a1' }, OTHER_DESKTOP)).toEqual({ ok: true })
  })

  it('settings never returns the password, and the agent frame never carries settings', async () => {
    const proxy = { scheme: 'socks5' as const, host: 'proxy.example', port: 1080, username: 'kim', password: 'pw-secret' }
    saveState({ a1: { ...defaultSettings(HOST), proxy } })
    // Its exit zone cannot be looked up here: the machine's zone is used.
    const { port, requests } = start()
    port.running(session('a1'))
    await ready(port, 'a1')
    const read = await requests.agent_browser_settings!({ agentId: 'a1' }, LOCAL)
    expect(read).toEqual({ ...defaultSettings(HOST), proxy: { scheme: 'socks5', host: 'proxy.example', port: 1080, username: 'kim', passwordSet: true } })
    expect(JSON.stringify(read)).not.toContain('pw-secret')
    expect(JSON.stringify(port.published('a1'))).not.toContain('proxy')
    // The password goes to Podman on stdin only, never in an argument.
    expect(fake.calls().find(call => call.args[0] === 'secret' && call.args[1] === 'create')!.stdin).toContain('pw-secret')
    expect(fake.calls().some(call => call.args.join(' ').includes('pw-secret'))).toBe(false)
  })

  it('settings_save stores what it was given, keeps a password it was not sent, and answers it as read', async () => {
    const { port, requests } = start()
    port.running(session('a1'))
    await ready(port, 'a1')
    const proxy = { scheme: 'http', host: 'proxy.example', port: 3128, username: 'kim', password: 'pw-secret' }
    const settings = { ...defaultSettings(HOST), languages: 'vi-VN, en-US', proxy }
    expect(await requests.agent_browser_settings_save!({ agentId: 'a1', settings }, OTHER_DESKTOP)).toMatchObject({
      languages: 'vi-VN, en-US', proxy: { host: 'proxy.example', passwordSet: true },
    })
    const { password: _password, ...withoutPassword } = proxy
    expect(await requests.agent_browser_settings_save!({ agentId: 'a1', settings: { ...settings, proxy: withoutPassword } }, OTHER_DESKTOP))
      .toMatchObject({ proxy: { passwordSet: true } })
    // Desktop reads this detail to tell the person to update Harness for a screen the machine does not know.
    expect(await requests.agent_browser_settings_save!({ agentId: 'a1', settings: { ...settings, screen: '800x600' } }, OTHER_DESKTOP))
      .toEqual({ error: 'INVALID_SETTINGS', detail: 'invalid browser setting: screen' })
  })

  it('saving or removing a proxy, and a proxy test, count agent_browser_proxy_set, _removed, _test_ok or _test_failed', async () => {
    const count = vi.fn()
    const { port, requests } = start(fakeCore({ dataDir, count }))
    port.running(session('a1'))
    await ready(port, 'a1')
    const counted = () => count.mock.calls.map(([name]) => name as string).filter(name => name.startsWith('agent_browser_proxy'))
    const proxyPort = await lookupProxy()
    const proxy = { scheme: 'http', host: '127.0.0.1', port: proxyPort, username: 'kim', password: 'pw-secret' }
    const settings = { ...defaultSettings(HOST), proxy }
    await requests.agent_browser_settings_save!({ agentId: 'a1', settings }, LOCAL)
    // The same proxy saved again is no new one.
    await requests.agent_browser_settings_save!({ agentId: 'a1', settings }, LOCAL)
    await requests.agent_browser_settings_save!({ agentId: 'a1', settings: { ...settings, proxy: null } }, LOCAL)
    await requests.agent_browser_settings_save!({ agentId: 'a1', settings: { ...settings, proxy: null } }, LOCAL)
    expect(counted()).toEqual(['agent_browser_proxy_set', 'agent_browser_proxy_removed'])
    expect(await requests.agent_browser_proxy_test!({ agentId: 'a1', proxy }, LOCAL)).toEqual({ ok: true, address: '203.0.113.7', timeZone: 'Europe/Paris' })
    const closed = await lookupProxy()
    servers.pop()!.close()
    expect(await requests.agent_browser_proxy_test!({ agentId: 'a1', proxy: { ...proxy, port: closed } }, LOCAL)).toEqual({ ok: false })
    expect(counted().slice(2)).toEqual(['agent_browser_proxy_test_ok', 'agent_browser_proxy_test_failed'])
    expect(await requests.agent_browser_proxy_test!({ agentId: 'a1', proxy: null }, LOCAL)).toEqual({ error: 'INVALID_SETTINGS', detail: 'invalid browser setting: proxy' })
  })

  it('a proxy test without a password uses the stored one', async () => {
    const heard: string[] = []
    const server = createServer(socket => socket.once('data', (chunk) => {
      heard.push(chunk.toString())
      socket.end(`HTTP/1.1 200 OK\r\n\r\n${JSON.stringify({ status: 'success', timezone: 'Europe/Paris', query: '203.0.113.7' })}`)
    }))
    servers.push(server)
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const proxy = { scheme: 'http' as const, host: '127.0.0.1', port: (server.address() as AddressInfo).port, username: 'kim', password: 'stored' }
    saveState({ a1: { ...defaultSettings(HOST), proxy } })
    const { port, requests } = start()
    port.running(session('a1'))
    await eventually(() => expect(port.published('a1')).toBeDefined())
    const { password: _password, ...sent } = proxy
    expect(await requests.agent_browser_proxy_test!({ agentId: 'a1', proxy: sent }, LOCAL)).toMatchObject({ ok: true })
    expect(heard.at(-1)).toContain(`Basic ${Buffer.from('kim:stored').toString('base64')}`)
  })

  it('a proxy test or a save to another proxy never carries the stored password', async () => {
    const heard: string[] = []
    const server = createServer(socket => socket.once('data', (chunk) => {
      heard.push(chunk.toString())
      socket.end(`HTTP/1.1 200 OK\r\n\r\n${JSON.stringify({ status: 'success', timezone: 'Europe/Paris', query: '203.0.113.7' })}`)
    }))
    servers.push(server)
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const stored = { scheme: 'http' as const, host: 'proxy.example', port: 3128, username: 'kim', password: 'stored' }
    saveState({ a1: { ...defaultSettings(HOST), proxy: stored } })
    const { port, requests } = start()
    port.running(session('a1'))
    await eventually(() => expect(port.published('a1')).toBeDefined())
    const other = { scheme: 'http', host: '127.0.0.1', port: (server.address() as AddressInfo).port, username: 'kim' }
    expect(await requests.agent_browser_proxy_test!({ agentId: 'a1', proxy: other }, LOCAL)).toMatchObject({ ok: true })
    expect(heard).toHaveLength(1)
    expect(heard[0]).not.toContain(Buffer.from('kim:stored').toString('base64'))
    expect(await requests.agent_browser_settings_save!({ agentId: 'a1', settings: { ...defaultSettings(HOST), proxy: other } }, LOCAL))
      .toMatchObject({ proxy: { host: '127.0.0.1', passwordSet: false } })
  })

  it('state finds the agent by pane and carries the human mode', async () => {
    const ofPane = vi.fn(async (pane: string) => (pane === '%7' ? { agentId: 'a1', guest: false } : pane === '%8' ? { agentId: 'plain', guest: false } : null))
    const { port, requests } = start(fakeCore({ dataDir, agents: { ofPane } }))
    port.running(session('a1'))
    await ready(port, 'a1')
    expect(await requests.agent_browser_state!({ pane: '%7' }, LOCAL)).toEqual({ agentId: 'a1', state: 'ready', podman: fake.path, human: 'normal' })
    await requests.agent_browser_settings_save!({ agentId: 'a1', settings: { ...defaultSettings(HOST), humanSpeed: 'fast' } }, LOCAL)
    expect(await requests.agent_browser_state!({ pane: '%7' }, LOCAL)).toMatchObject({ human: 'fast' })
    await requests.agent_browser_settings_save!({ agentId: 'a1', settings: { ...defaultSettings(HOST), humanInput: false } }, LOCAL)
    expect(await requests.agent_browser_state!({ pane: '%7' }, LOCAL)).toMatchObject({ human: 'off' })
    // Outside a pane, in an agent without a browser, or with a core that cannot say: none.
    for (const pane of ['%8', '%9', undefined]) expect(await requests.agent_browser_state!({ pane }, LOCAL)).toEqual({ error: 'NO_BROWSER' })
    ofPane.mockRejectedValueOnce(new Error('no core'))
    expect(await requests.agent_browser_state!({ pane: '%7' }, LOCAL)).toEqual({ error: 'NO_BROWSER' })
    const bare = start(fakeCore({ dataDir }))
    expect(await bare.requests.agent_browser_state!({ pane: '%7' }, LOCAL)).toEqual({ error: 'NO_BROWSER' })
  })

  it('state carries Harness\'s own connection, so the relay\'s exec reaches the machine the browser runs on', async () => {
    writeFileSync(join(dataDir, 'agent-browser.json'), JSON.stringify({ browsers: {}, deleting: [], setup: null, connection: 'harness' }))
    fake.reply('--connection harness info --format json', { stdout: JSON.stringify({ version: { Version: '5.8.1' }, host: { memTotal: 8 * GiB } }) })
    fake.reply('--connection harness ps', { stdout: '[]' })
    fake.reply('--connection harness images --format json --filter reference=localhost/harness-browser', {
      stdout: JSON.stringify([{ Names: [`localhost/${imageTag(browserAssetsHash(), NOW)}`], Created: 1, Containers: 0 }]),
    })
    const { port, requests } = start(fakeCore({ dataDir, agents: { ofPane: async () => ({ agentId: 'a1', guest: false }) } }))
    port.running(session('a1'))
    await ready(port, 'a1')
    expect(await requests.agent_browser_state!({ pane: '%7' }, LOCAL)).toEqual({ agentId: 'a1', state: 'ready', podman: fake.path, connection: 'harness', human: 'normal' })
  })

  it('a failed browser\'s state names its failure', async () => {
    fake.reply('info --format json', { stdout: JSON.stringify({ version: { Version: '4.3.0' }, host: { memTotal: 8 * GiB } }) })
    const { port, requests } = start(fakeCore({ dataDir, agents: { ofPane: async () => ({ agentId: 'a1', guest: false }) } }))
    port.running(session('a1'))
    await eventually(() => expect(port.published('a1')).toEqual({ state: 'failed', error: 'podman_old' }))
    expect(await requests.agent_browser_state!({ pane: '%7' }, LOCAL)).toMatchObject({ agentId: 'a1', state: 'failed', error: 'podman_old' })
  })

  // Whose Browser is on is in that file: none is, and no browser starts, until the person's Start says why.
  it('an unreadable state file is named to the person\'s Start and to the settings, starts nothing, and nothing is removed', async () => {
    writeFileSync(join(dataDir, 'agent-browser.json'), '{ not json')
    const { port, requests } = start(fakeCore({ dataDir }), { everyAgent: async () => [session('a1')] })
    port.running(session('a1'))
    expect(await requests.agent_browser_start!({ agentId: 'a1' }, LOCAL)).toEqual({ error: 'STATE_UNREADABLE' })
    expect(port.published('a1')).toBeUndefined()
    expect(await requests.agent_browser_settings!({ agentId: 'a1' }, LOCAL)).toEqual({ error: 'STATE_UNREADABLE' })
    const log = vi.spyOn(console, 'log')
    port.purged('a1')
    // The delete ends at the state file it cannot record in, and says so.
    await eventually(() => expect(log).toHaveBeenCalledWith(expect.stringMatching(/^agent browser a1: not deleted: /)))
    expect(asked().filter(line => / rm |^rm /.test(line))).toEqual([])
  })

  it('service start finishes recorded purges without treating the readable agent list as complete', async () => {
    const listed = { a1: defaultSettings(HOST), a2: defaultSettings(HOST), a3: defaultSettings(HOST) }
    for (const everyAgent of [async () => [session('a1')], async () => { throw new Error('timed out') }, async () => null]) {
      await stopAll()
      fake = fakePodman()
      fake.reply('ps', { stdout: '[]' })
      saveState(listed, ['a9'])
      start(fakeCore({ dataDir }), { everyAgent })
      await eventually(() => expect(savedState().deleting).toEqual([]))
      expect(Object.keys(savedState().browsers).sort()).toEqual(['a1', 'a2', 'a3'])
      expect(asked()).toContain('volume rm harness-browser-a9')
      const listing = `ps --filter label=harness.daemon=${daemonIdOf(dataDir)} --format json`
      const sweeping = `ps -a --filter label=harness.daemon=${daemonIdOf(dataDir)} --format json`
      await eventually(() => expect(asked()).toContain(listing))
      expect(asked().filter(line => line !== listing && line !== sweeping && !line.includes('harness-browser-a9') && !line.includes('harness-proxy-a9'))).toEqual([])
    }
  })

  // `harness browser`'s screenshots and long output where nothing sets a TMPDIR (agentClient/browserOutput.ts): the core
  // swept them at each launch until 2026-11-15.
  it('keeps a profile omitted by an unreadable saved-agent record while finishing a recorded purge', async () => {
    saveState({ archived: defaultSettings(HOST) }, ['purged'])
    start(fakeCore({ dataDir }), { everyAgent: async () => [] })
    await eventually(() => expect(savedState().deleting).toEqual([]))
    const listing = `ps --filter label=harness.daemon=${daemonIdOf(dataDir)} --format json`
    await eventually(() => expect(asked()).toContain(listing))
    expect(asked().filter(line => line.startsWith('volume rm '))).toEqual(['volume rm harness-browser-purged'])
    expect(Object.keys(savedState().browsers)).toEqual(['archived'])
  })

  it('sweeps the agents\' folder of what nothing changed in for a week, as it begins', async () => {
    resetAgentTmpSweep()
    const shot = join(dataDir, 'agent-tmp', 'browser', 'shot.png')
    mkdirSync(join(dataDir, 'agent-tmp', 'browser'), { recursive: true })
    writeFileSync(shot, 'png')
    saveState({})
    const log = vi.spyOn(console, 'log')
    // A clock past the file's own change time by more than a week: what it holds is a week old.
    start(fakeCore({ dataDir }), { now: () => new Date(Date.now() + 8 * 24 * 60 * 60_000) })
    await eventually(() => expect(log).toHaveBeenCalledWith('[agent-tmp] removed 1 entries nothing had changed in for 7 days'))
    expect(existsSync(shot)).toBe(false)
  })

  it('inline migration reads the legacy flag from the core list without using omissions to delete profiles', async () => {
    saveState({ a1: defaultSettings(HOST), unreadable: defaultSettings(HOST) })
    const all = vi.fn(() => [session('a1')])
    const sw = startSwitching([session('b1', { browser: undefined })], { agents: { all }, options: { everyAgent: undefined } })
    sw.move('a1', 'b1')
    await ready(sw.port, 'b1')
    expect(all).toHaveBeenCalledOnce()
    expect(Object.keys(savedState().browsers).sort()).toEqual(['b1', 'unreadable'])
    expect(asked().filter(call => call.startsWith('volume rm'))).toEqual([])
  })

  // In its own process, before the core has answered what it follows: it cannot tell an agent that ended from one it
  // has not heard of yet, and stops nothing on a guess.
  it('stops no browser as it starts until it has caught up with the core\'s agents', async () => {
    saveState({ a1: defaultSettings(HOST) })
    fake.reply('ps', { stdout: JSON.stringify([{ Names: ['harness-browser-a1'], Labels: { 'harness.agent': 'a1', 'harness.daemon': daemonIdOf(dataDir) }, State: 'running' }]) })
    const followed = vi.fn(async () => false)
    start(fakeCore({ dataDir }), { followed, everyAgent: async () => [session('a1')] })
    await eventually(() => expect(followed).toHaveBeenCalled())
    await new Promise(done => setImmediate(done))
    expect(asked()).not.toContain('rm --force --time 10 harness-browser-a1')
  })

  // A stop of an agent's harness is the agent cleanup's to hear (core/agentLife.ts): an ended agent's browser stops on
  // its end, never on its stop.
  it('hears nothing in a stop of an agent: its end stops the browser', async () => {
    const { port, hub } = start()
    port.running(session('a1'))
    await ready(port, 'a1')
    hub.stopped('a1')
    expect(port.published('a1')).toEqual({ state: 'ready' })
  })

  it('a Stop when nothing was ever turned on answers ok', async () => {
    saveState({ a1: defaultSettings(HOST) })
    const { requests } = start()
    expect(await requests.agent_browser_stop!({ agentId: 'a1' }, LOCAL)).toEqual({ ok: true })
    expect(turnedOn()).toEqual({})
  })

  it('a failure that is not Podman\'s is the service\'s own, and counts against it', async () => {
    const podman = createPodman({ resolve: async () => fake.path, platform: 'linux' })
    const broken = { ...podman, available: async () => { throw new Error('a bug') }, path: async () => { throw new Error('a bug') } }
    const { port, requests } = start(fakeCore({ dataDir, agents: { ofPane: async () => ({ agentId: 'a1', guest: false }) } }), { podman: broken })
    await expect(requests.agent_browser_available!({}, LOCAL)).rejects.toThrow('a bug')
    port.running(session('a1'))
    await eventually(() => expect(port.published('a1')).toEqual({ state: 'failed', error: 'podman_down' }))
    await expect(requests.agent_browser_state!({ pane: '%7' }, LOCAL)).rejects.toThrow('a bug')
  })

  it('an exit on the event stream is looked at, and a stream that reconnects looks once at what runs', async () => {
    const children: Array<{ stdout: PassThrough; emit(event: string): void }> = []
    const podman = createPodman({ resolve: async () => fake.path, platform: 'linux' })
    vi.spyOn(podman, 'spawn').mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: null, kill: vi.fn() })
      children.push(child)
      return child as unknown as ChildProcess
    })
    const { port } = start(undefined, { podman })
    port.running(session('a1'))
    await ready(port, 'a1')
    await eventually(() => expect(children).toHaveLength(1))
    const exitLookups = () => asked().filter(line => line === `ps -a --filter label=harness.agent=a1 --filter label=harness.daemon=${daemonIdOf(dataDir)} --format json`).length
    const before = exitLookups()
    children[0]!.stdout.write(`${JSON.stringify({ Status: 'died', Type: 'container', Attributes: { 'harness.daemon': daemonIdOf(dataDir), 'harness.agent': 'a1' } })}\n`)
    await eventually(() => expect(exitLookups()).toBe(before + 1))
    const listings = () => asked().filter(line => line === `ps --filter label=harness.daemon=${daemonIdOf(dataDir)} --format json`).length
    const listed = listings()
    children[0]!.emit('close')
    await eventually(() => expect(children).toHaveLength(2))
    await eventually(() => expect(listings()).toBe(listed + 1))
  })

  it('without a state file it waits for its first use to look at Podman', async () => {
    const everyAgent = vi.fn(async () => [])
    const { podman } = podmanHere()
    const path = vi.spyOn(podman, 'path')
    // The first use asks for Podman's path and the core's agents at once, before any await: none of them yet.
    const { requests } = start(fakeCore({ dataDir }), { podman, everyAgent })
    expect(path).not.toHaveBeenCalled()
    expect(everyAgent).not.toHaveBeenCalled()
    expect(fake.calls()).toEqual([])
    await requests.agent_browser_available!({}, LOCAL)
    expect(everyAgent).not.toHaveBeenCalled()
    expect(asked()).toContain('info --format json')
  })

  it('a browser with no Podman here waits for setup, and its tools are told no path', async () => {
    const missing = createPodman({ resolve: async () => null, exists: () => false, platform: 'linux' })
    const { port, requests } = start(fakeCore({ dataDir, agents: { ofPane: async () => ({ agentId: 'a1', guest: false }) } }), { podman: missing })
    port.running(session('a1'))
    await eventually(() => expect(port.published('a1')).toEqual({ state: 'failed', error: 'needs_setup' }))
    expect(await requests.agent_browser_state!({ pane: '%7' }, LOCAL)).toEqual({ agentId: 'a1', state: 'failed', error: 'needs_setup', podman: '', human: 'normal' })
  })

  it('stopped before Podman was looked for, it starts no event stream', async () => {
    saveState({})
    const { podman, spawn } = podmanHere()
    const path = vi.spyOn(podman, 'path')
    start(undefined, { podman }).port.stop()
    // The stream starts, or not, in the callbacks on that first look; setImmediate runs after every one of them.
    await path.mock.results[0]!.value
    await new Promise(done => setImmediate(done))
    expect(spawn).not.toHaveBeenCalled()
  })

  it('with no clock handed in, runs the image of this week', async () => {
    fake.reply('images --format json --filter reference=localhost/harness-browser', {
      stdout: JSON.stringify([{ Names: [`localhost/${imageTag(browserAssetsHash(), new Date())}`], Created: 1, Containers: 0 }]),
    })
    const { port } = start(undefined, { now: undefined })
    port.running(session('a1'))
    await ready(port, 'a1')
    expect(asked().some(line => line.startsWith('build '))).toBe(false)
  })

  it('with nothing handed in, reads the machine\'s zone and language and runs the real Podman finder', () => {
    const { requests } = start(fakeCore({ dataDir }), { podman: undefined, platform: undefined, host: undefined, now: undefined })
    expect(Object.keys(requests)).toHaveLength(AGENT_BROWSER_REQUESTS.length)
  })
})

describe('the person\'s Start and Stop', () => {
  it('start and stop are refused NOT_OWNER for a guest and a machine share, and allowed for the person\'s other Desktop', async () => {
    const sw = startSwitching()
    for (const type of ['agent_browser_start', 'agent_browser_stop']) {
      for (const asker of [SHARE_GUEST, PLAIN_OWNER, { ...LOCAL, guest: 'kim@acme.io' }]) {
        expect(await sw.requests[type]!({ agentId: 'a1' }, asker), type).toEqual({ error: 'NOT_OWNER' })
      }
    }
    expect(existsSync(join(dataDir, 'agent-browser.json'))).toBe(false)
    expect(await sw.requests.agent_browser_start!({ agentId: 'a1' }, OTHER_DESKTOP)).toEqual({ ok: true })
    expect(turnedOn()).toEqual({ a1: true })
    await ready(sw.port, 'a1')
    expect(await sw.requests.agent_browser_stop!({ agentId: 'a1' }, OTHER_DESKTOP)).toEqual({ ok: true })
    expect(turnedOn()).toEqual({})
    expect(sw.port.published('a1')).toBeUndefined()
  })

  it('a Stop supersedes a Start waiting for catch-up, and a later Start can still turn it on', async () => {
    let caughtUp!: (ready: boolean) => void
    const pending = new Promise<boolean>(resolve => { caughtUp = resolve })
    const sw = startSwitching(undefined, { options: { followed: () => pending } })
    const first = sw.requests.agent_browser_start!({ agentId: 'a1' }, LOCAL)
    await sw.requests.agent_browser_stop!({ agentId: 'a1' }, LOCAL)
    caughtUp(true)
    await first
    expect(turnedOn()).toEqual({})
    expect(sw.port.published('a1')).toBeUndefined()
    expect(asked().some(call => call.startsWith('create '))).toBe(false)
    await sw.requests.agent_browser_start!({ agentId: 'a1' }, LOCAL)
    await ready(sw.port, 'a1')
  })

  it('two Starts awaiting catch-up keep the newer intent until its own answer arrives', async () => {
    const replies: Array<(ready: boolean) => void> = []
    const sw = startSwitching(undefined, { options: { followed: () => new Promise(resolve => { replies.push(resolve) }) } })
    const first = sw.requests.agent_browser_start!({ agentId: 'a1' }, LOCAL)
    const second = sw.requests.agent_browser_start!({ agentId: 'a1' }, LOCAL)
    replies[0]!(true)
    await first
    expect(existsSync(join(dataDir, 'agent-browser.json'))).toBe(false)
    replies[1]!(true)
    await second
    await ready(sw.port, 'a1')
  })

  it.each(['ended', 'purged', 'taken', 'service stopped'] as const)('a Start waiting for catch-up is cancelled when %s', async kind => {
    let answer!: (ready: boolean) => void
    const pending = new Promise<boolean>(resolve => { answer = resolve })
    const sw = startSwitching(undefined, { options: { followed: () => pending } })
    const started = sw.requests.agent_browser_start!({ agentId: 'a1' }, LOCAL)
    if (kind === 'ended') sw.end('a1')
    else if (kind === 'purged') sw.purge('a1')
    else if (kind === 'taken') sw.port.taken('a1', session('b1', { browser: undefined }))
    else sw.port.stop()
    answer(true)
    await started
    expect(sw.port.published('a1')).toBeUndefined()
    expect(asked().some(call => call.startsWith('create '))).toBe(false)
  })

  it('a Stop before the legacy row arrives is not undone by its Browser flag', async () => {
    const sw = startSwitching([])
    await sw.requests.agent_browser_stop!({ agentId: 'a1' }, LOCAL)
    sw.rows.set('a1', session('a1'))
    sw.attach('a1')
    expect(turnedOn()).toEqual({})
    expect(sw.port.published('a1')).toBeUndefined()
    expect(savedState()).toMatchObject({ adopted: { a1: true } })
  })

  it('start turns it on in the service\'s own state file, starts the browser and counts agent_browser_started; a second start does nothing', async () => {
    const count = vi.fn()
    const sw = startSwitching(undefined, { count })
    expect(await sw.requests.agent_browser_start!({ agentId: 'a1' }, LOCAL)).toEqual({ ok: true })
    expect(turnedOn()).toEqual({ a1: true })
    // The core keeps no flag of it.
    expect(sw.rows.get('a1')?.browser).toBeUndefined()
    await ready(sw.port, 'a1')
    expect(await sw.requests.agent_browser_start!({ agentId: 'a1' }, LOCAL)).toEqual({ ok: true })
    expect(asked().filter(call => call.startsWith('create '))).toHaveLength(1)
    const counted = (name: string) => count.mock.calls.filter(([metric]) => metric === name).length
    expect(counted('agent_browser_started')).toBe(1)
    expect(counted('agent_browser_enabled')).toBe(1)
  })

  // The service's process started after the core attached the agent, and has not heard it again yet.
  it('start of a browser that is on and not yet heard of starts it and counts no Start', async () => {
    const count = vi.fn()
    const sw = startSwitching([session('a1')], { count })
    expect(await sw.requests.agent_browser_start!({ agentId: 'a1' }, LOCAL)).toEqual({ ok: true })
    await ready(sw.port, 'a1')
    expect(count).not.toHaveBeenCalledWith('agent_browser_started')
  })

  it('start of a failed browser tries again as Retry does', async () => {
    // Another browser of this daemon runs, on a machine with room for one.
    fake.reply('info --format json', { stdout: JSON.stringify({ version: { Version: '5.8.1' }, host: { memTotal: 3 * GiB } }) })
    fake.reply('ps', { stdout: JSON.stringify([{ Names: ['harness-browser-other'], Labels: { 'harness.agent': 'other', 'harness.daemon': daemonIdOf(dataDir) }, State: 'running' }]) })
    const sw = startSwitching()
    await sw.requests.agent_browser_start!({ agentId: 'a1' }, LOCAL)
    await eventually(() => expect(sw.port.published('a1')).toEqual({ state: 'failed', error: 'browser_limit' }))
    fake.reply('ps', { stdout: '[]' })
    expect(await sw.requests.agent_browser_start!({ agentId: 'a1' }, OTHER_DESKTOP)).toEqual({ ok: true })
    await ready(sw.port, 'a1')
    expect(turnedOn()).toEqual({ a1: true })
  })

  it('start for an agent that does not run is NOT_RUNNING, and for a guest\'s agent NOT_ALLOWED', async () => {
    const count = vi.fn()
    const sw = startSwitching([session('kim', { browser: undefined, guest: 'kim@acme.io' })], { count })
    expect(await sw.requests.agent_browser_start!({ agentId: 'gone' }, LOCAL)).toEqual({ error: 'NOT_RUNNING' })
    expect(await sw.requests.agent_browser_start!({}, LOCAL)).toEqual({ error: 'NOT_RUNNING' })
    expect(await sw.requests.agent_browser_start!({ agentId: 'kim' }, LOCAL)).toEqual({ error: 'NOT_ALLOWED' })
    expect(existsSync(join(dataDir, 'agent-browser.json'))).toBe(false)
    expect(sw.port.published('kim')).toBeUndefined()
    expect(count).not.toHaveBeenCalled()
    expect(fake.calls()).toEqual([])
  })

  it('stop clears the flag, removes the container, its network and its proxy secret, keeps the volume and the settings, and counts agent_browser_stopped; a stop of one that is off answers ok and does nothing', async () => {
    const count = vi.fn()
    const sw = startSwitching(undefined, { count })
    await sw.requests.agent_browser_start!({ agentId: 'a1' }, LOCAL)
    await ready(sw.port, 'a1')
    expect(await sw.requests.agent_browser_stop!({ agentId: 'a1' }, LOCAL)).toEqual({ ok: true })
    expect(turnedOn()).toEqual({})
    expect(sw.port.published('a1')).toBeUndefined()
    await eventually(() => expect(secretsRemoved('a1')).toBe(2))
    expect(asked()).toContain('rm --force --time 10 harness-browser-a1')
    expect(asked()).toContain('network rm harness-browser-a1')
    expect(asked()).not.toContain('volume rm harness-browser-a1')
    expect(Object.keys(savedState().browsers)).toEqual(['a1'])
    const before = asked().length
    for (const agentId of ['a1', 'nobody']) expect(await sw.requests.agent_browser_stop!({ agentId }, LOCAL)).toEqual({ ok: true })
    expect(asked()).toHaveLength(before)
    expect(count.mock.calls.filter(([metric]) => metric === 'agent_browser_stopped')).toHaveLength(1)
  })

  it('a fresh lease for an agent with Browser off starts no browser work', () => {
    let heard!: (event: import('../core/api.js').AgentLife) => void
    const row = { ...session('a1', { browser: undefined }), frameEpoch: 'first:1' }
    const core = fakeCore({ dataDir, agents: { follow: listener => { heard = listener; listener({ kind: 'running', session: row }); return () => {} } } })
    start(core)
    heard({ kind: 'running', session: { ...row, frameEpoch: 'second:1' } })
    expect(core.agents.publishFrame).toHaveBeenLastCalledWith({ ...row, frameEpoch: 'second:1' }, {})
    expect(asked()).toEqual([])
  })

  it('a core restart regenerates a pending Browser result without lending it the new lease', async () => {
    let heard!: (event: import('../core/api.js').AgentLife) => void
    const old = { ...session('a1'), frameEpoch: 'old-core:1' }
    const next = { ...old, frameEpoch: 'new-core:1' }
    let oldReady!: (ready: boolean) => void, nextReady!: (ready: boolean) => void
    const checked = vi.spyOn(Containers.prototype, 'ready')
      .mockImplementationOnce(() => new Promise(resolve => { oldReady = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { nextReady = resolve }))
    const core = fakeCore({ dataDir, agents: { follow: listener => { heard = listener; listener({ kind: 'running', session: old }); return () => {} } } })
    const sw = start(core)
    await eventually(() => expect(oldReady).toEqual(expect.any(Function)))
    heard({ kind: 'running', session: next })
    vi.mocked(core.agents.publishFrame!).mockClear()
    oldReady(true)
    await eventually(() => expect(checked).toHaveBeenCalledTimes(2))
    expect(core.agents.publishFrame).not.toHaveBeenCalledWith(next, { browser: { state: 'ready' } })
    nextReady(true)
    await ready(sw.port, 'a1')
    expect(core.agents.publishFrame).toHaveBeenLastCalledWith(next, { browser: { state: 'ready' } })
    heard({ kind: 'running', session: next })
    expect(core.agents.publishFrame).toHaveBeenLastCalledWith(next, { browser: { state: 'ready' } })
  })

  it('stop while it starts ends the start without a container; start right after stop waits for it', async () => {
    const sw = startSwitching()
    await sw.requests.agent_browser_start!({ agentId: 'a1' }, LOCAL)
    await sw.requests.agent_browser_stop!({ agentId: 'a1' }, LOCAL)
    // The stop runs after the start in the agent's queue: once it has, the start has ended.
    await eventually(() => expect(asked()).toContain('network rm harness-browser-a1'))
    expect(asked().filter(call => call.startsWith('create '))).toEqual([])
    expect(sw.port.published('a1')).toBeUndefined()
    await sw.requests.agent_browser_start!({ agentId: 'a1' }, LOCAL)
    await sw.requests.agent_browser_stop!({ agentId: 'a1' }, LOCAL)
    await sw.requests.agent_browser_start!({ agentId: 'a1' }, LOCAL)
    await ready(sw.port, 'a1')
    const calls = asked()
    expect(calls.filter(call => call.startsWith('create '))).toHaveLength(1)
    expect(calls.lastIndexOf('rm --force --time 10 harness-browser-a1')).toBeLessThan(calls.findIndex(call => call.startsWith('create ')))
    // Only the start that became ready told the agent.
    expect(sw.typed).toEqual([lineTo('a1', READY_LINE, 'ready')])
  })

  it('the ready line is typed once when the person\'s Start is ready, and the stop line at the person\'s Stop', async () => {
    const sw = startSwitching()
    await sw.requests.agent_browser_start!({ agentId: 'a1' }, LOCAL)
    expect(sw.typed).toEqual([])
    await ready(sw.port, 'a1')
    expect(sw.typed).toEqual([lineTo('a1', READY_LINE, 'ready')])
    sw.hear(sw.typed[0]!.deliveryId, 'delivered')
    expect(savedState().told).toEqual({ a1: true })
    await sw.requests.agent_browser_start!({ agentId: 'a1' }, LOCAL)
    expect(sw.typed).toHaveLength(1)
    await sw.requests.agent_browser_stop!({ agentId: 'a1' }, LOCAL)
    expect(sw.typed).toEqual([lineTo('a1', READY_LINE, 'ready'), lineTo('a1', STOPPED_LINE, 'stopped')])
    expect(savedState().told).toEqual({})
    // Started again, it is told again.
    await sw.requests.agent_browser_start!({ agentId: 'a1' }, LOCAL)
    await ready(sw.port, 'a1')
    expect(sw.typed.slice(2)).toEqual([lineTo('a1', READY_LINE, 'ready')])
  })

  it('a Start right after a Stop starts it again once the stop is done', async () => {
    const sw = startSwitching()
    await sw.requests.agent_browser_start!({ agentId: 'a1' }, LOCAL)
    await ready(sw.port, 'a1')
    const [stopping, starting] = [sw.requests.agent_browser_stop!({ agentId: 'a1' }, LOCAL), sw.requests.agent_browser_start!({ agentId: 'a1' }, LOCAL)]
    expect(await stopping).toEqual({ ok: true })
    expect(await starting).toEqual({ ok: true })
    expect(turnedOn()).toEqual({ a1: true })
    await ready(sw.port, 'a1')
    expect(asked().filter(call => call.startsWith('create '))).toHaveLength(2)
  })

  // In its own process, a Start before the core has answered what it follows does not know whether its agent runs.
  it('start before the service has caught up with the core\'s agents asks to be asked again, and turns nothing on', async () => {
    const followed = vi.fn(async () => false)
    const sw = startSwitching(undefined, { options: { followed } })
    expect(await sw.requests.agent_browser_start!({ agentId: 'a1' }, LOCAL)).toEqual({ error: 'SERVICE_UNAVAILABLE', service: 'agentBrowser', retryable: true })
    expect(existsSync(join(dataDir, 'agent-browser.json'))).toBe(false)
    followed.mockResolvedValue(true)
    expect(await sw.requests.agent_browser_start!({ agentId: 'a1' }, LOCAL)).toEqual({ ok: true })
  })

  // As a settings save that cannot be written: the service's own failure, which counts against it.
  it('a Start whose state file cannot be written fails, and starts nothing', async () => {
    const sw = startSwitching()
    mkdirSync(join(dataDir, `agent-browser.json.${process.pid}.tmp`), { recursive: true })
    await expect(sw.requests.agent_browser_start!({ agentId: 'a1' }, LOCAL)).rejects.toThrow('EISDIR')
    expect(sw.port.published('a1')).toBeUndefined()
    expect(asked().filter(call => call.startsWith('create '))).toEqual([])
  })

  // The file is written beside itself and renamed over it (agentBrowser/stateFile.ts): a folder there refuses it.
  it('a Stop whose state file cannot be written still stops the browser, and says so', async () => {
    const sw = startSwitching()
    await sw.requests.agent_browser_start!({ agentId: 'a1' }, LOCAL)
    await ready(sw.port, 'a1')
    const log = vi.spyOn(console, 'log')
    mkdirSync(join(dataDir, `agent-browser.json.${process.pid}.tmp`))
    expect(await sw.requests.agent_browser_stop!({ agentId: 'a1' }, LOCAL)).toEqual({ ok: true })
    expect(sw.port.published('a1')).toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^agent browser a1: its Stop was not kept: /))
    await eventually(() => expect(secretsRemoved('a1')).toBe(2))
  })

  it('the agent\'s own stop types nothing and keeps the mark; its resume types nothing', async () => {
    const sw = startSwitching()
    await sw.requests.agent_browser_start!({ agentId: 'a1' }, LOCAL)
    await ready(sw.port, 'a1')
    sw.hear(sw.typed[0]!.deliveryId, 'started')
    sw.end('a1')
    expect(sw.port.published('a1')).toBeUndefined()
    await eventually(() => expect(secretsRemoved('a1')).toBe(2))
    expect(turnedOn()).toEqual({ a1: true })
    expect(savedState().told).toEqual({ a1: true })
    sw.attach('a1')
    await ready(sw.port, 'a1')
    expect(sw.typed).toEqual([lineTo('a1', READY_LINE, 'ready')])
  })

  it('the agent\'s end and its purge take back the line that waits for it, and its next ready is told', async () => {
    const sw = startSwitching()
    await sw.requests.agent_browser_start!({ agentId: 'a1' }, LOCAL)
    await ready(sw.port, 'a1')
    sw.end('a1')
    expect(sw.core.turns.cancelDelivery).toHaveBeenLastCalledWith(sw.typed[0]!.deliveryId)
    sw.attach('a1')
    await ready(sw.port, 'a1')
    expect(sw.typed).toEqual([lineTo('a1', READY_LINE, 'ready'), lineTo('a1', READY_LINE, 'ready')])
    sw.purge('a1')
    expect(sw.core.turns.cancelDelivery).toHaveBeenLastCalledWith(sw.typed[1]!.deliveryId)
  })

  it('the agent\'s own end after its person\'s Stop takes back the stop line that waits for it', async () => {
    const sw = startSwitching()
    await sw.requests.agent_browser_start!({ agentId: 'a1' }, LOCAL)
    await ready(sw.port, 'a1')
    sw.hear(sw.typed[0]!.deliveryId, 'delivered')
    expect(await sw.requests.agent_browser_stop!({ agentId: 'a1' }, LOCAL)).toEqual({ ok: true })
    expect(sw.typed.at(-1)).toEqual(lineTo('a1', STOPPED_LINE, 'stopped'))
    sw.end('a1')
    expect(sw.core.turns.cancelDelivery).toHaveBeenLastCalledWith(sw.typed.at(-1)!.deliveryId)
  })

  it('an agent created with browser:true by an older Desktop is started when it runs and told once', async () => {
    const sw = startSwitching([session('a1')])
    sw.attach('a1')
    await ready(sw.port, 'a1')
    expect(sw.typed).toEqual([lineTo('a1', READY_LINE, 'ready')])
    sw.hear(sw.typed[0]!.deliveryId, 'delivered')
    // The daemon restarts: the same state file, and the agent attached again.
    sw.port.stop()
    const again = startSwitching([session('a1')])
    again.attach('a1')
    await ready(again.port, 'a1')
    expect(again.typed).toEqual([])
    expect(sw.typed).toHaveLength(1)
  })

  // The core kept whose Browser was on until 2026-11-15, as a flag on each agent's row: each is taken in once, and the
  // row keeps its flag for a rollback. Delete on or after 2026-12-18, with the row's field.
  it('a row\'s flag from before is taken in once: a Stop after it is not undone by the flag the row still carries', async () => {
    const sw = startSwitching([session('a1')])
    await ready(sw.port, 'a1')
    expect(savedState()).toMatchObject({ on: { a1: true }, adopted: { a1: true } })
    await sw.requests.agent_browser_stop!({ agentId: 'a1' }, LOCAL)
    sw.end('a1')
    sw.attach('a1')
    expect(turnedOn()).toEqual({})
    expect(sw.port.published('a1')).toBeUndefined()
    // A purge takes it out of the file, browser or not.
    sw.purge('a1')
    await eventually(() => expect(savedState()).toMatchObject({ adopted: {} }))
  })

  it('a flag that cannot be taken in is said, and taken in when its agent next runs', async () => {
    writeFileSync(join(dataDir, 'agent-browser.json'), '{ not json')
    const log = vi.spyOn(console, 'log')
    const sw = startSwitching([session('a1')])
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^agent browser a1: its Browser flag was not taken in: /))
    rmSync(join(dataDir, 'agent-browser.json'))
    sw.end('a1')
    sw.attach('a1')
    await ready(sw.port, 'a1')
    expect(turnedOn()).toEqual({ a1: true })
  })

  // An agent whose Browser is on that ended while the service could not hear it (its process and the core both
  // restarted): its browser is stopped as the service starts, once what it follows is caught up.
  it('stops a browser left running for an agent that is not here, or whose Browser is off, as it starts', async () => {
    saveState({ gone: defaultSettings(HOST), off: defaultSettings(HOST), kept: defaultSettings(HOST) })
    new StateFile(join(dataDir, 'agent-browser.json')).update(state => { state.on = { kept: true, gone: true } })
    // Each as this daemon started it, on this week's image with its settings now: kept's own start finds its browser
    // running and replaces nothing, so an `rm` of it is only ever the sweep's.
    const applied = settingsHash({ ...defaultSettings(HOST), timeZone: HOST.timeZone })
    const label = (agentId: string) => ({
      Names: [`harness-browser-${agentId}`], Image: `localhost/${imageTag(browserAssetsHash(), NOW)}`, State: 'running',
      Labels: { 'harness.agent': agentId, 'harness.daemon': daemonIdOf(dataDir), 'harness.settings': applied },
    })
    // Listed first: the look at what runs has judged it before it stops the others, so a stop of it would be asked by then.
    fake.reply('ps', { stdout: JSON.stringify([label('kept'), label('gone'), label('off')]) })
    const { port } = startSwitching([session('kept', { browser: undefined }), session('off', { browser: undefined })], { options: { everyAgent: async () => [session('kept'), session('off'), session('gone')] } })
    await eventually(() => expect(asked()).toContain('rm --force --time 10 harness-browser-off'))
    await eventually(() => expect(asked()).toContain('rm --force --time 10 harness-browser-gone'))
    // Its own start, which runs beside that look, is done too: whatever it removed is asked by then (CI, 2026-11-17).
    await ready(port, 'kept')
    expect(asked()).not.toContain('rm --force --time 10 harness-browser-kept')
  })

  it('settings are read and saved for an agent whose browser is off, a save starts nothing, and an id of no agent here is NO_BROWSER', async () => {
    const everyAgent = vi.fn(async (): Promise<RegisteredSession[] | null> => [session('a1'), session('a2')])
    const { requests } = start(fakeCore({ dataDir }), { everyAgent })
    expect(await requests.agent_browser_settings!({ agentId: 'a1' }, LOCAL)).toEqual(defaultSettings(HOST))
    const settings = { ...defaultSettings(HOST), languages: 'vi-VN, en-US' }
    expect(await requests.agent_browser_settings_save!({ agentId: 'a2', settings }, OTHER_DESKTOP)).toMatchObject({ languages: 'vi-VN, en-US' })
    expect(savedState().browsers.a2).toMatchObject({ languages: 'vi-VN, en-US' })
    expect(await requests.agent_browser_settings!({ agentId: 'a2' }, OTHER_DESKTOP)).toMatchObject({ languages: 'vi-VN, en-US' })
    const proxy = { scheme: 'http', host: '127.0.0.1', port: await lookupProxy(), username: 'kim', password: 'pw-secret' }
    expect(await requests.agent_browser_proxy_test!({ agentId: 'a1', proxy }, LOCAL)).toEqual({ ok: true, address: '203.0.113.7', timeZone: 'Europe/Paris' })
    for (const type of ['agent_browser_settings', 'agent_browser_settings_save', 'agent_browser_proxy_test']) {
      expect(await requests[type]!({ agentId: 'nobody', settings, proxy }, LOCAL), type).toEqual({ error: 'NO_BROWSER' })
    }
    // Retry has no browser to try again.
    expect(await requests.agent_browser_retry!({ agentId: 'a1' }, LOCAL)).toEqual({ error: 'NO_BROWSER' })
    // A core that cannot say which agents are here has not proved absence.
    everyAgent.mockRejectedValueOnce(new Error('no core'))
    expect(await requests.agent_browser_settings!({ agentId: 'a1' }, LOCAL)).toEqual({ error: 'SERVICE_UNAVAILABLE', service: 'agentBrowser', retryable: true })
    expect(asked().filter(call => call.startsWith('create ') || call.startsWith('network create'))).toEqual([])
  })

  it('a settings entry made while off goes with its agent', async () => {
    const { port, requests } = start(fakeCore({ dataDir }), { everyAgent: async () => [session('a1')] })
    await requests.agent_browser_settings_save!({ agentId: 'a1', settings: defaultSettings(HOST) }, LOCAL)
    expect(Object.keys(savedState().browsers)).toEqual(['a1'])
    port.purged('a1')
    await eventually(() => expect(savedState().browsers).toEqual({}))
    expect(asked()).toContain('volume rm harness-browser-a1')
  })

  it.each(['unknown', 'rejected'] as const)('%s presence leaves all settings requests unavailable without changing saved data', async failure => {
    saveState({ a1: defaultSettings(HOST) })
    const hasAgent = async () => { if (failure === 'rejected') throw new Error('lost'); return null }
    const { requests } = start(undefined, { hasAgent })
    const before = readFileSync(join(dataDir, 'agent-browser.json'), 'utf8')
    for (const type of ['agent_browser_settings', 'agent_browser_settings_save', 'agent_browser_proxy_test']) {
      expect(await requests[type]!({ agentId: 'a1', settings: { ...defaultSettings(HOST), languages: 'vi-VN' }, proxy: null }, LOCAL), type)
        .toEqual({ error: 'SERVICE_UNAVAILABLE', service: 'agentBrowser', retryable: true })
    }
    expect(readFileSync(join(dataDir, 'agent-browser.json'), 'utf8')).toBe(before)
  })

  it('an older core keeps settings and proxy tests available for off and stopped agents', async () => {
    vi.useFakeTimers()
    let processOptions!: ServiceProcessOptions
    let requests!: ServiceRequests
    const service = runAgentBrowserService({
      dataDir, socketPath: '/unused', machineId: 'test', token: 'test',
      run: options => { processOptions = options; return { stop: () => {} } },
      start: (core, ports, options) => {
        const started = start(core, options)
        ports.agentBrowser = started.port
        return requests = started.requests
      },
    })
    const query = vi.fn(async (name: string) => name === 'agent_ids'
      ? { live: ['off'], stopped: ['stopped'] }
      : { error: 'UNKNOWN_QUERY' })
    processOptions.onConnected!({ query })
    const read = requests.agent_browser_settings!({ agentId: 'off' }, LOCAL)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await read).toEqual(defaultSettings(HOST))
    // Membership does not supply the lifecycle catch-up required by a new Start.
    const unavailableStart = requests.agent_browser_start!({ agentId: 'off' }, LOCAL)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await unavailableStart).toEqual({ error: 'SERVICE_UNAVAILABLE', service: 'agentBrowser', retryable: true })
    vi.useRealTimers()
    const proxy = { scheme: 'http', host: '127.0.0.1', port: await lookupProxy(), username: 'kim', password: 'fixture' }
    for (const agentId of ['off', 'stopped']) {
      const settings = { ...defaultSettings(HOST), languages: 'vi-VN, en-US' }
      expect(await requests.agent_browser_settings_save!({ agentId, settings }, LOCAL)).toMatchObject({ languages: settings.languages })
      expect(await requests.agent_browser_settings!({ agentId }, LOCAL)).toMatchObject({ languages: settings.languages })
      expect(await requests.agent_browser_proxy_test!({ agentId, proxy }, LOCAL)).toMatchObject({ ok: true })
    }
    expect(await requests.agent_browser_settings!({ agentId: 'absent' }, LOCAL)).toEqual({ error: 'NO_BROWSER' })
    expect(query).toHaveBeenCalledWith('agent_ids', {})
    expect(asked().filter(call => call.startsWith('create ') || call.startsWith('network create'))).toEqual([])
    expect(turnedOn()).toEqual({})
    service.stop()
  })
})

/** One line the service wrote to a tool server. */
type ToolLine = { jsonrpc: string; id: number; method: string; params: Record<string, unknown> }

/** A tool server (`podman exec -i … browser-tools.mjs`) the spec drives: it hears each line the service writes, and
 *  answers when the spec says. */
function toolServer(args: string[]) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const heard: ToolLine[] = []
  createInterface({ input: stdin }).on('line', line => heard.push(JSON.parse(line) as ToolLine))
  return Object.assign(new EventEmitter(), {
    args, stdin, stdout, stderr: null, heard,
    kill: vi.fn(() => true),
    /** Answers the line it heard last, or the line [id]. */
    answer(result: unknown, id = heard.at(-1)!.id) { stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`) },
  })
}
type ToolServer = ReturnType<typeof toolServer>

/** The fake podman, whose tool servers the spec drives; its event stream is the fake's own. */
function podmanWithTools() {
  const podman = createPodman({ resolve: async () => fake.path, platform: 'linux' })
  const real = podman.spawn
  const tools: ToolServer[] = []
  const spawn = vi.spyOn(podman, 'spawn').mockImplementation((args) => {
    if (args[0] !== 'exec') return real(args)
    const tool = toolServer(args)
    tools.push(tool)
    return tool as unknown as ChildProcess
  })
  return { podman, spawn, tools }
}

const TOOL_SERVER_ARGS = (agentId: string) => ['exec', '-i', `harness-browser-${agentId}`, 'node', '/opt/harness-browser/browser-tools.mjs']
/** The command's parents, as `harness browser` sends them (lib/callerPane.ts `runningPane`). */
const ANCESTORS = [9001, 4242, 1]
/** Which pane is whose, as the core proves a pane (core/api.ts `ofPane`, held to the parents it is given). */
const PANES: Record<string, { agentId: string; guest: boolean }> = {
  '%7': { agentId: 'a1', guest: false }, '%8': { agentId: 'a2', guest: false }, '%9': { agentId: 'kim', guest: true },
}
const page = (text: string) => ({ content: [{ type: 'text', text }] })

/** Resolves once [check] holds, looked at on each turn of the event loop. Not vi.waitFor: under fake timers that moves
 *  the clock on each look, and a limit the spec counts to would pass early. */
async function until(check: () => boolean) {
  for (let turns = 0; !check(); turns++) {
    if (turns > 100_000) throw new Error('what the spec waits for never happened')
    await new Promise(done => setImmediate(done))
  }
}

/**
 * The person's agent a1 in pane %7, whose browser its person started and is ready; a2 in %8, whose browser is off; and
 * a guest's agent, kim, in %9. `run` is `harness browser <command>` from a pane.
 */
async function commands(over: { count?: (name: string) => void; core?: Parameters<typeof fakeCore>[0] } = {}) {
  const tools = podmanWithTools()
  const ofPane = vi.fn(async (pane: string, _ancestors?: number[]) => PANES[pane] ?? null)
  const sw = startSwitching([session('a1', { browser: undefined }), session('a2', { browser: undefined }), session('kim', { browser: undefined, guest: 'kim@acme.io' })],
    { ...over, agents: { ofPane }, options: { podman: tools.podman } })
  await sw.requests.agent_browser_start!({ agentId: 'a1' }, LOCAL)
  await ready(sw.port, 'a1')
  const run = (command: string, args: Record<string, unknown> = {}, more: { pane?: string; asker?: Asker; closed?: AbortSignal } = {}) =>
    sw.requests.agent_browser_run!({ pane: more.pane ?? '%7', ancestors: ANCESTORS, command, args }, more.asker ?? LOCAL, more.closed)
  /** The [n]th line (from 1) the [tool]th tool server started heard, once it has. */
  const line = async (n: number, tool = 0) => {
    await until(() => (tools.tools[tool]?.heard.length ?? 0) >= n)
    return tools.tools[tool]!.heard[n - 1]!
  }
  return { ...sw, ...tools, ofPane, run, line }
}

describe('the agent\'s commands', () => {
  it('run is refused to a remote asker', async () => {
    const c = await commands()
    for (const asker of [OTHER_DESKTOP, PLAIN_OWNER, SHARE_GUEST]) expect(await c.run('snapshot', {}, { asker })).toEqual({ error: 'LOCAL_ONLY' })
    expect(c.ofPane).not.toHaveBeenCalled()
    expect(c.tools).toEqual([])
  })

  it('the pane gives the agent: held to the command\'s parents, and NO_AGENT for a pane the core does not prove', async () => {
    const c = await commands()
    const answer = c.run('snapshot')
    const heard = await c.line(1)
    expect(c.ofPane).toHaveBeenCalledWith('%7', ANCESTORS)
    expect(c.tools[0]!.args).toEqual(TOOL_SERVER_ARGS('a1'))
    expect(heard).toEqual({ jsonrpc: '2.0', id: heard.id, method: 'tools/call', params: { name: 'browser_snapshot', arguments: {}, _harness: { human: 'normal' } } })
    c.tools[0]!.answer(page('https://example.com · Example Domain'))
    expect(await answer).toEqual({ ok: true, text: 'https://example.com · Example Domain' })
    // Another pane is another agent: a2's browser is off.
    expect(await c.run('snapshot', {}, { pane: '%8' })).toEqual({ error: 'OFF' })
    // A pane of no agent, no pane, no parents, and a core that cannot say.
    expect(await c.run('snapshot', {}, { pane: '%5' })).toEqual({ error: 'NO_AGENT' })
    for (const payload of [{ ancestors: ANCESTORS }, { pane: '%7' }, { pane: '%7', ancestors: '4242' }]) {
      expect(await c.requests.agent_browser_run!({ ...payload, command: 'snapshot', args: {} }, LOCAL), JSON.stringify(payload)).toEqual({ error: 'NO_AGENT' })
    }
    c.ofPane.mockRejectedValueOnce(new Error('no core'))
    expect(await c.run('snapshot')).toEqual({ error: 'NO_AGENT' })
    const bare = start(fakeCore({ dataDir: mkdtempSync(join(dataDir, 'bare-')) }))
    expect(await bare.requests.agent_browser_run!({ pane: '%7', ancestors: ANCESTORS, command: 'snapshot', args: {} }, LOCAL)).toEqual({ error: 'NO_AGENT' })
    // Parents that are not pids are not held up as any.
    await c.requests.agent_browser_run!({ pane: '%8', ancestors: [4242, 'x', null], command: 'snapshot', args: {} }, LOCAL)
    expect(c.ofPane).toHaveBeenLastCalledWith('%8', [4242])
    expect(c.tools).toHaveLength(1)
  })

  it('a guest\'s agent is NOT_ALLOWED', async () => {
    const c = await commands()
    expect(await c.run('navigate', { url: 'https://example.com' }, { pane: '%9' })).toEqual({ error: 'NOT_ALLOWED' })
    expect(c.tools).toEqual([])
  })

  it('answers with the backend unreachable', async () => {
    const unreachable = () => { throw new Error('unreachable') }
    const c = await commands({ core: { account: { backend: unreachable, machines: unreachable } } })
    const answer = c.run('snapshot')
    await c.line(1)
    c.tools[0]!.answer(page('Example Domain'))
    expect(await answer).toEqual({ ok: true, text: 'Example Domain' })
  })

  it('an unknown command, or arguments that are no object, are INVALID_REQUEST', async () => {
    const c = await commands()
    for (const [command, args] of [['start', {}], ['stop', {}], ['', {}], ['toString', {}], ['snapshot', null], ['snapshot', ['e1']], ['snapshot', 'e1']] as const) {
      expect(await c.requests.agent_browser_run!({ pane: '%7', ancestors: ANCESTORS, command, args }, LOCAL), `${command} ${JSON.stringify(args)}`).toEqual({ error: 'INVALID_REQUEST' })
    }
    expect(await c.requests.agent_browser_run!({ pane: '%7', ancestors: ANCESTORS, args: {} }, LOCAL)).toEqual({ error: 'INVALID_REQUEST' })
    expect(c.tools).toEqual([])
  })

  it('off, starting, setting up and each failed state answer by name, and start nothing', async () => {
    const c = await commands()
    expect(await c.run('snapshot', {}, { pane: '%8' })).toEqual({ error: 'OFF' })
    await c.requests.agent_browser_start!({ agentId: 'a2' }, LOCAL)
    await eventually(() => expect(c.port.published('a2')).toEqual({ state: 'starting' }))
    expect(await c.run('snapshot', {}, { pane: '%8' })).toEqual({ error: 'NOT_READY', state: 'starting' })
    expect(c.tools).toEqual([])

    // No Podman here: the browser waits for setup, then shows its step while setup runs.
    const missing = createPodman({ resolve: async () => null, exists: () => false, platform: 'linux' })
    const spawn = vi.spyOn(missing, 'spawn')
    const which = async (cmd: string) => (cmd === 'pkexec' || cmd === 'apt-get' ? `/usr/bin/${cmd}` : null)
    const ofPane = async () => ({ agentId: 'a1', guest: false })
    const unset = start(fakeCore({ dataDir: mkdtempSync(join(dataDir, 'setup-')), agents: { ofPane } }), {
      podman: missing, setup: { which, run: () => new Promise(() => {}), interactive: () => true },
    })
    const runThere = (requests: ServiceRequests) => requests.agent_browser_run!({ pane: '%7', ancestors: ANCESTORS, command: 'snapshot', args: {} }, LOCAL)
    unset.port.running(session('a1'))
    await eventually(() => expect(unset.port.published('a1')).toEqual({ state: 'failed', error: 'needs_setup' }))
    expect(await runThere(unset.requests)).toEqual({ error: 'NOT_READY', state: 'needs_setup' })
    await unset.requests.agent_browser_setup!({}, LOCAL)
    await eventually(() => expect(unset.port.published('a1')).toEqual({ state: 'setup', step: 'installing' }))
    expect(await runThere(unset.requests)).toEqual({ error: 'NOT_READY', state: 'setup' })
    expect(spawn.mock.calls.filter(([args]) => args[0] === 'exec')).toEqual([])

    // A Podman too old.
    fake.reply('info --format json', { stdout: JSON.stringify({ version: { Version: '4.3.0' }, host: { memTotal: 8 * GiB } }) })
    const old = podmanWithTools()
    const failed = start(fakeCore({ dataDir: mkdtempSync(join(dataDir, 'old-')), agents: { ofPane } }), { podman: old.podman })
    failed.port.running(session('a1'))
    await eventually(() => expect(failed.port.published('a1')).toEqual({ state: 'failed', error: 'podman_old' }))
    expect(await runThere(failed.requests)).toEqual({ error: 'NOT_READY', state: 'podman_old' })
    expect(old.tools).toEqual([])
    expect(asked().filter(call => call.includes('browser-tools.mjs'))).toEqual([])
  })

  it('the first command starts the tool server once; it starts again after it exits; a state that leaves ready ends it', async () => {
    const c = await commands()
    const first = c.run('snapshot')
    await c.line(1)
    c.tools[0]!.answer(page('one'))
    expect(await first).toMatchObject({ ok: true, text: 'one' })
    const second = c.run('click', { ref: 'e3' })
    expect((await c.line(2)).params).toMatchObject({ name: 'browser_click', arguments: { ref: 'e3' } })
    c.tools[0]!.answer(page('Clicked'))
    expect(await second).toMatchObject({ ok: true, text: 'Clicked' })
    expect(c.tools).toHaveLength(1)
    // It dies with its container while a command runs, before Podman's event says so: the browser is starting.
    const third = c.run('snapshot')
    await c.line(3)
    c.tools[0]!.emit('exit')
    expect(await third).toEqual({ error: 'NOT_READY', state: 'starting' })
    const fourth = c.run('snapshot')
    await c.line(1, 1)
    expect(c.tools.map(tool => tool.args)).toEqual([TOOL_SERVER_ARGS('a1'), TOOL_SERVER_ARGS('a1')])
    c.tools[1]!.answer(page('four'))
    expect(await fourth).toMatchObject({ ok: true, text: 'four' })
    // A change that starts the browser again takes its tool server with it.
    expect(c.tools[1]!.stdin.writableEnded).toBe(false)
    await c.requests.agent_browser_settings_save!({ agentId: 'a1', settings: { ...defaultSettings(HOST), screen: '1366x768' } }, LOCAL)
    await eventually(() => expect(c.tools[1]!.stdin.writableEnded).toBe(true))
    await ready(c.port, 'a1')
    const fifth = c.run('snapshot')
    await c.line(1, 2)
    c.tools[2]!.answer(page('five'))
    expect(await fifth).toMatchObject({ ok: true, text: 'five' })
  })

  it('a screenshot comes back as its image, and a tool\'s own failure is failed with its words', async () => {
    const c = await commands()
    const shot = c.run('screenshot')
    await c.line(1)
    c.tools[0]!.answer({ content: [{ type: 'image', data: 'AAEC', mimeType: 'image/jpeg' }] })
    expect(await shot).toEqual({ ok: true, text: '', image: 'AAEC' })
    const click = c.run('click', { ref: 'e99' })
    await c.line(2)
    c.tools[0]!.answer({ content: [{ type: 'text', text: 'Element not found;' }, { type: 'text', text: 'take a new snapshot' }], isError: true })
    expect(await click).toEqual({ ok: true, text: 'Element not found;\ntake a new snapshot', failed: true })
  })

  it('the person\'s Stop answers the running command and every waiting one STOPPED, and then types no stop line', async () => {
    const c = await commands()
    c.hear(c.typed[0]!.deliveryId, 'delivered')
    const running = c.run('wait', { text: 'Inbox' })
    await c.line(1)
    const waiting = [c.run('snapshot'), c.run('click', { ref: 'e1' })]
    // Both are past their pane's proof and wait for the tool server.
    for (let turn = 0; turn < 5; turn++) await new Promise(done => setImmediate(done))
    const stopping = c.requests.agent_browser_stop!({ agentId: 'a1' }, LOCAL)
    expect(await running).toEqual({ error: 'STOPPED' })
    expect(await Promise.all(waiting)).toEqual([{ error: 'STOPPED' }, { error: 'STOPPED' }])
    expect(await stopping).toEqual({ ok: true })
    expect(c.tools[0]!.stdin.writableEnded).toBe(true)
    expect(c.typed).toEqual([lineTo('a1', READY_LINE, 'ready')])
    // Off now: the next command asks for its person.
    expect(await c.run('snapshot')).toEqual({ error: 'OFF' })
  })

  it('a Stop with no command running types the stop line', async () => {
    const c = await commands()
    c.hear(c.typed[0]!.deliveryId, 'delivered')
    const done = c.run('snapshot')
    await c.line(1)
    c.tools[0]!.answer(page('Example Domain'))
    await done
    expect(await c.requests.agent_browser_stop!({ agentId: 'a1' }, LOCAL)).toEqual({ ok: true })
    expect(c.typed).toEqual([lineTo('a1', READY_LINE, 'ready'), lineTo('a1', STOPPED_LINE, 'stopped')])
  })

  it('a settings change while a command runs answers NOT_READY starting, and the next after ready works', async () => {
    const c = await commands()
    const running = c.run('navigate', { url: 'https://example.com' })
    await c.line(1)
    await c.requests.agent_browser_settings_save!({ agentId: 'a1', settings: { ...defaultSettings(HOST), languages: 'vi-VN, en-US' } }, LOCAL)
    expect(await running).toEqual({ error: 'NOT_READY', state: 'starting' })
    await ready(c.port, 'a1')
    const next = c.run('snapshot')
    await c.line(1, 1)
    c.tools[1]!.answer(page('Example Domain'))
    expect(await next).toEqual({ ok: true, text: 'Example Domain' })
  })

  it('the agent\'s own end while a command runs answers it as a browser that starts again with it', async () => {
    const c = await commands()
    const running = c.run('snapshot')
    await c.line(1)
    c.end('a1')
    expect(await running).toEqual({ error: 'NOT_READY', state: 'starting' })
  })

  it('a call past its limit is TOOL_TIMEOUT, and the next starts another tool server', async () => {
    const c = await commands()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const navigate = c.run('navigate', { url: 'https://example.com' })
    await c.line(1)
    await vi.advanceTimersByTimeAsync(69_999)
    expect(c.tools[0]!.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await navigate).toEqual({ error: 'TOOL_TIMEOUT' })
    expect(c.tools[0]!.kill).toHaveBeenCalled()
    const snapshot = c.run('snapshot')
    await c.line(1, 1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await snapshot).toEqual({ error: 'TOOL_TIMEOUT' })
    expect(c.tools).toHaveLength(2)
  })

  it('the ninth waiting is BUSY, and a command whose asker went never runs', async () => {
    const c = await commands()
    const running = c.run('wait', { text: 'Inbox' })
    await c.line(1)
    const gone = new AbortController()
    const left = c.run('snapshot', {}, { closed: gone.signal })
    const waiting = Array.from({ length: 7 }, () => c.run('snapshot'))
    expect(await c.run('snapshot')).toEqual({ error: 'BUSY' })
    gone.abort()
    await left
    c.tools[0]!.answer(page('Done'))
    expect(await running).toEqual({ ok: true, text: 'Done' })
    for (let n = 2; n <= 8; n++) {
      await c.line(n)
      c.tools[0]!.answer(page(`page ${n}`))
    }
    expect(await Promise.all(waiting)).toEqual(Array.from({ length: 7 }, (_, i) => ({ ok: true, text: `page ${i + 2}` })))
    expect(c.tools[0]!.heard).toHaveLength(8)
  })

  it('each call carries the human mode of the settings now', async () => {
    const c = await commands()
    const human = async () => {
      const answer = c.run('snapshot')
      const heard = await c.line(c.tools[0] ? c.tools[0].heard.length + 1 : 1)
      c.tools[0]!.answer(page('Example Domain'))
      await answer
      return (heard.params._harness as { human: string }).human
    }
    expect(await human()).toBe('normal')
    // Human input applies to the next call: the browser is not started again.
    await c.requests.agent_browser_settings_save!({ agentId: 'a1', settings: { ...defaultSettings(HOST), humanSpeed: 'fast' } }, LOCAL)
    expect(await human()).toBe('fast')
    await c.requests.agent_browser_settings_save!({ agentId: 'a1', settings: { ...defaultSettings(HOST), humanInput: false } }, LOCAL)
    expect(await human()).toBe('off')
    expect(c.tools).toHaveLength(1)
  })

  it('a command counts ok or failed, and its log line holds its name and outcome and none of its arguments or the page\'s text', async () => {
    const count = vi.fn()
    const c = await commands({ count })
    const log = vi.spyOn(console, 'log')
    const navigate = c.run('navigate', { url: 'https://secret.example/inbox?token=hunter2' })
    await c.line(1)
    c.tools[0]!.answer(page('https://secret.example/inbox · Private inbox of Kim'))
    await navigate
    const typing = c.run('type', { ref: 'e7', text: 'my secret words' })
    await c.line(2)
    c.tools[0]!.answer({ ...page('Element e7 is gone: secret.example'), isError: true })
    await typing
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const hung = c.run('snapshot')
    await c.line(3)
    await vi.advanceTimersByTimeAsync(30_000)
    await hung
    const counted = count.mock.calls.map(([name]) => name as string).filter(name => name.startsWith('agent_browser_command'))
    expect(counted).toEqual(['agent_browser_command_ok', 'agent_browser_command_failed', 'agent_browser_command_failed'])
    const lines = log.mock.calls.map(([line]) => String(line)).filter(line => line.startsWith('agent browser a1: ') && !line.includes('tool server'))
    expect(lines).toEqual(['agent browser a1: navigate ok', 'agent browser a1: type failed', 'agent browser a1: snapshot tool_timeout'])
    expect(log.mock.calls.flat().join('\n')).not.toMatch(/secret|hunter2|Kim/)
  })
})

describe('the window', () => {
  it('the window is refused NOT_OWNER for a guest and a machine share, NO_BROWSER when off and NOT_READY while it starts', async () => {
    const c = await commands()
    for (const asker of [SHARE_GUEST, PLAIN_OWNER, { ...LOCAL, guest: 'kim@acme.io' }]) {
      expect(await c.requests.agent_browser_window!({ agentId: 'a1', width: 1200, height: 800 }, asker)).toEqual({ error: 'NOT_OWNER' })
    }
    expect(await c.requests.agent_browser_window!({ agentId: 'a2', width: 1200, height: 800 }, LOCAL)).toEqual({ error: 'NO_BROWSER' })
    expect(await c.requests.agent_browser_window!({ width: 1200, height: 800 }, LOCAL)).toEqual({ error: 'NO_BROWSER' })
    await c.requests.agent_browser_start!({ agentId: 'a2' }, LOCAL)
    await eventually(() => expect(c.port.published('a2')).toEqual({ state: 'starting' }))
    expect(await c.requests.agent_browser_window!({ agentId: 'a2', width: 1200, height: 800 }, LOCAL)).toEqual({ error: 'NOT_READY' })
    expect(c.tools).toEqual([])
  })

  it('the size is the panel\'s, clamped to the screen setting, and what Chrome set is the answer', async () => {
    const c = await commands()
    const window = (width: unknown, height: unknown, asker: Asker = LOCAL) => c.requests.agent_browser_window!({ agentId: 'a1', width, height }, asker)
    // The Browser panel beside a chat: the window is asked at exactly its size.
    const panel = window(780, 935)
    expect((await c.line(1)).params).toEqual({ width: 780, height: 935 })
    expect(c.tools[0]!.heard[0]!.method).toBe('window')
    c.tools[0]!.answer({ width: 780, height: 935 })
    expect(await panel).toEqual({ width: 780, height: 935 })
    // Narrower than Chrome allows: Chrome keeps its own minimum, and that is the answer the viewer scales.
    const narrow = window(400, 900)
    expect((await c.line(2)).params).toEqual({ width: 400, height: 900 })
    c.tools[0]!.answer({ width: 500, height: 900 })
    expect(await narrow).toEqual({ width: 500, height: 900 })
    // The person's other Desktop sizes it too: the last request wins.
    const tall = window(1400, 2400, OTHER_DESKTOP)
    expect((await c.line(3)).params).toEqual({ width: 1080, height: 1920 })
    // Chrome keeps the window inside the screen: its answer is the size.
    c.tools[0]!.answer({ width: 1080, height: 1893 })
    expect(await tall).toEqual({ width: 1080, height: 1893 })
    for (const [width, height] of [['1200', 800], [0, 800], [1200, undefined]]) {
      expect(await window(width, height), `${String(width)}x${String(height)}`).toEqual({ error: 'INVALID_REQUEST' })
    }
    await c.requests.agent_browser_settings_save!({ agentId: 'a1', settings: { ...defaultSettings(HOST), screen: '1366x768' } }, LOCAL)
    await ready(c.port, 'a1')
    const held = window(1500, 900)
    expect((await c.line(1, 1)).params).toEqual({ width: 1366, height: 768 })
    c.tools[1]!.answer({ width: 1366, height: 768 })
    expect(await held).toEqual({ width: 1366, height: 768 })
  })

  it('a tool server that does not answer in 5 s is WINDOW_FAILED and logged window_failed', async () => {
    const c = await commands()
    const log = vi.spyOn(console, 'log')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const window = c.requests.agent_browser_window!({ agentId: 'a1', width: 1200, height: 800 }, LOCAL)
    await c.line(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await window).toEqual({ error: 'WINDOW_FAILED' })
    expect(log).toHaveBeenCalledWith('agent browser a1: window_failed')
    // Nothing is killed: a command may be running beside it.
    expect(c.tools[0]!.kill).not.toHaveBeenCalled()
  })

  it('nothing is written to the state file', async () => {
    const c = await commands()
    const before = readFileSync(join(dataDir, 'agent-browser.json'), 'utf8')
    const window = c.requests.agent_browser_window!({ agentId: 'a1', width: 1200, height: 800 }, LOCAL)
    await c.line(1)
    c.tools[0]!.answer({ width: 1200, height: 800 })
    expect(await window).toEqual({ width: 1200, height: 800 })
    expect(readFileSync(join(dataDir, 'agent-browser.json'), 'utf8')).toBe(before)
  })

  it('the service\'s stop ends every tool server', async () => {
    const c = await commands()
    const running = c.run('snapshot')
    await c.line(1)
    c.port.stop()
    expect(await running).toEqual({ error: 'NOT_READY', state: 'starting' })
    expect(c.tools[0]!.stdin.writableEnded).toBe(true)
  })
})

// Decision 19: an engine typed into the pane its agent ended in is a new agent, and the browser moves with the pane.
describe('the browser moves with its pane', () => {
  /** a1 ran with its browser on, told, and ended in its pane; b1 is the agent typed there, with no browser of its own. */
  async function ended(over: Parameters<typeof startSwitching>[1] = {}) {
    const sw = startSwitching([session('a1', { browser: undefined }), session('b1', { browser: undefined }), session('c1', { browser: undefined })], over)
    await sw.requests.agent_browser_start!({ agentId: 'a1' }, LOCAL)
    await ready(sw.port, 'a1')
    sw.hear(sw.typed[0]!.deliveryId, 'delivered')
    sw.end('a1')
    await eventually(() => expect(secretsRemoved('a1')).toBe(2))
    return sw
  }
  const created = () => asked().filter(call => call.startsWith('create '))
  const moveFailed = (log: { mock: { calls: unknown[][] } }) => log.mock.calls.filter(([line]) => String(line).includes('browser_move_failed'))

  it('the browser moves with its pane: the previous agent\'s container is removed, the entry, its profile and its being on are the new agent\'s, the container is created again under the new agent\'s label on the same volume, and the new agent is typed the ready line once', async () => {
    const sw = await ended()
    sw.move('a1', 'b1')
    await ready(sw.port, 'b1')
    expect(turnedOn()).toEqual({ b1: true })
    // The previous agent's row flag from before, if it had one, is never taken in after this.
    expect(savedState()).toMatchObject({ adopted: { a1: true } })
    expect(Object.keys(savedState().browsers)).toEqual(['b1'])
    expect(savedState().browsers.b1).toMatchObject({ profile: 'a1' })
    // The names stay the profile's; the label is the new agent's.
    const [first, again] = created() as [string, string]
    expect(created()).toHaveLength(2)
    expect(first).toContain('--name harness-browser-a1 --label harness.agent=a1 ')
    expect(again).toContain('--name harness-browser-a1 --label harness.agent=b1 ')
    expect(again).toContain('-v harness-browser-a1:/var/lib/harness-browser-profile ')
    const calls = asked()
    expect(calls.lastIndexOf('rm --force --time 10 harness-browser-a1')).toBeLessThan(calls.lastIndexOf(again))
    expect(calls.filter(call => call.startsWith('volume rm'))).toEqual([])
    // A new conversation, never told: typed once. The previous agent's mark went with its entry.
    expect(sw.typed).toEqual([lineTo('a1', READY_LINE, 'ready'), lineTo('b1', READY_LINE, 'ready')])
    sw.hear(sw.typed[1]!.deliveryId, 'delivered')
    expect(savedState().told).toEqual({ b1: true })
  })

  it('a move of a browser that is off moves the entry and starts nothing; the new agent\'s Start then mounts the same volume', async () => {
    const sw = startSwitching([session('a1', { browser: undefined }), session('b1', { browser: undefined })])
    await sw.requests.agent_browser_start!({ agentId: 'a1' }, LOCAL)
    await ready(sw.port, 'a1')
    await sw.requests.agent_browser_stop!({ agentId: 'a1' }, LOCAL)
    await eventually(() => expect(secretsRemoved('a1')).toBe(2))
    sw.move('a1', 'b1')
    await eventually(() => expect(Object.keys(savedState().browsers)).toEqual(['b1']))
    expect(turnedOn()).toEqual({})
    expect(sw.port.published('b1')).toBeUndefined()
    expect(created()).toHaveLength(1)
    expect(await sw.requests.agent_browser_start!({ agentId: 'b1' }, LOCAL)).toEqual({ ok: true })
    await ready(sw.port, 'b1')
    expect(created().at(-1)).toContain('--name harness-browser-a1 --label harness.agent=b1 ')
    expect(created().at(-1)).toContain('-v harness-browser-a1:/var/lib/harness-browser-profile ')
  })

  it('the stream and the tool server of a moved browser exec into its profile\'s container', async () => {
    const c = await commands()
    c.end('a1')
    await eventually(() => expect(secretsRemoved('a1')).toBe(2))
    c.move('a1', 'a2')
    await ready(c.port, 'a2')
    const snapshot = c.run('snapshot', {}, { pane: '%8' })
    await c.line(1)
    expect(c.tools.map(tool => tool.args)).toEqual([TOOL_SERVER_ARGS('a1')])
    c.tools[0]!.answer(page('moved'))
    expect(await snapshot).toMatchObject({ ok: true, text: 'moved' })
    // A viewer's stream is an exec too, which this spec's Podman hands back beside the tool servers.
    expect(c.port.stream('local:w', 'agent_browser_open', { requestId: 'r-1', agentId: 'a2' }, LOCAL)).toBe(true)
    expect(c.tools.map(tool => tool.args)).toEqual([TOOL_SERVER_ARGS('a1'), VNC_PIPE_ARGS('a1')])
  })

  it('a ready browser whose state file cannot be read has no stream to open', async () => {
    const v = viewing()
    const { port } = start(v.core, { podman: v.podman })
    port.running(session('a1'))
    await ready(port, 'a1')
    writeFileSync(join(dataDir, 'agent-browser.json'), '{')
    expect(v.open(port, 'a1')).toBe('NOT_READY')
    expect(v.pipes).toEqual([])
  })

  // Review Focus 12.
  it('a state file that cannot be written leaves both agents as they were, types nothing, and logs browser_move_failed', async () => {
    const sw = await ended()
    const log = vi.spyOn(console, 'log')
    const before = readFileSync(join(dataDir, 'agent-browser.json'), 'utf8')
    // The file is written beside itself and renamed over it (agentBrowser/stateFile.ts): a folder there refuses it.
    mkdirSync(join(dataDir, `agent-browser.json.${process.pid}.tmp`))
    sw.move('a1', 'b1')
    await eventually(() => expect(log).toHaveBeenCalledWith('agent browser b1: browser_move_failed (state_unwritable)'))
    expect(readFileSync(join(dataDir, 'agent-browser.json'), 'utf8')).toBe(before)
    expect(turnedOn()).toEqual({ a1: true })
    expect(sw.port.published('b1')).toBeUndefined()
    expect(sw.typed).toEqual([lineTo('a1', READY_LINE, 'ready')])
    expect(created()).toHaveLength(1)
    // One that cannot be read is named so.
    writeFileSync(join(dataDir, 'agent-browser.json'), '{')
    sw.move('a1', 'b1')
    await eventually(() => expect(log).toHaveBeenCalledWith('agent browser b1: browser_move_failed (state_unreadable)'))
    expect(moveFailed(log)).toHaveLength(2)
  })

  it('a guest\'s agent takes nothing of the owner\'s, and an agent whose Browser is on keeps its own', async () => {
    const sw = startSwitching([session('a1', { browser: undefined }), session('kim', { browser: undefined, guest: 'kim@acme.io' }), session('b1', { browser: undefined })])
    await sw.requests.agent_browser_start!({ agentId: 'a1' }, LOCAL)
    await sw.requests.agent_browser_start!({ agentId: 'b1' }, LOCAL)
    await ready(sw.port, 'a1')
    await ready(sw.port, 'b1')
    sw.end('a1')
    await eventually(() => expect(secretsRemoved('a1')).toBe(2))
    sw.move('a1', 'kim')
    sw.move('a1', 'b1')
    await new Promise(done => setImmediate(done))
    expect(Object.keys(savedState().browsers).sort()).toEqual(['a1', 'b1'])
    expect(turnedOn()).toEqual({ a1: true, b1: true })
    expect(sw.port.published('kim')).toBeUndefined()
  })

  it('a destination purge during a pending move cannot recreate its saved profile', async () => {
    saveState({ a1: defaultSettings(HOST) })
    let looking!: () => void
    const looked = new Promise<void>(resolve => { looking = resolve })
    let answer!: (rows: RegisteredSession[]) => void
    const pending = new Promise<RegisteredSession[]>(resolve => { answer = resolve })
    let hold = false
    const everyAgent = async () => {
      if (!hold) return [session('a1')]
      looking()
      return pending
    }
    const move = vi.spyOn(Browsers.prototype, 'move')
    const deleted = vi.spyOn(Browsers.prototype, 'delete')
    const sw = startSwitching([session('b1', { browser: undefined })], { options: { everyAgent } })
    const listing = `ps --filter label=harness.daemon=${daemonIdOf(dataDir)} --format json`
    await eventually(() => expect(asked()).toContain(listing))
    hold = true
    sw.move('a1', 'b1')
    await looked
    sw.purge('b1')
    answer([session('a1')])
    await move.mock.results[0]!.value
    await Promise.all(deleted.mock.results.map(result => result.value))
    expect(savedState().browsers.b1).toBeUndefined()
    expect(turnedOn()).toEqual({})
    expect(sw.port.published('b1')).toBeUndefined()
    expect(created()).toHaveLength(0)
  })

  it('a destination purge while the source container stops removes the arriving profile', async () => {
    const sw = startSwitching([session('a1'), session('b1', { browser: undefined })])
    await ready(sw.port, 'a1')
    let entered!: () => void, release!: () => void
    const stopping = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(Containers.prototype, 'stop').mockImplementationOnce(async () => { entered(); await held })
    const move = vi.spyOn(Browsers.prototype, 'move')
    const deleted = vi.spyOn(Browsers.prototype, 'delete')
    sw.move('a1', 'b1')
    await stopping
    sw.purge('b1')
    release()
    await move.mock.results[0]!.value
    await Promise.all(deleted.mock.results.map(result => result.value))
    expect(savedState().browsers.b1).toBeUndefined()
    expect(turnedOn()).toEqual({})
    expect(sw.port.published('b1')).toBeUndefined()
    expect(created()).toHaveLength(1)
  })

  // Its agent ran with its Browser on before the update, ended, and has not run since: its saved row still carries the
  // flag the core kept. Delete on or after 2026-12-18, with `adopt`.
  it('a destination Stop while a move reads its legacy flag remains off after the profile arrives', async () => {
    saveState({ a1: defaultSettings(HOST) })
    let looking!: () => void
    const looked = new Promise<void>(resolve => { looking = resolve })
    let answer!: (rows: RegisteredSession[]) => void
    const pending = new Promise<RegisteredSession[]>(resolve => { answer = resolve })
    let hold = false
    const everyAgent = async () => {
      if (!hold) return [session('a1')]
      looking()
      return pending
    }
    const sw = startSwitching([session('b1', { browser: undefined })], { options: { everyAgent } })
    const listing = `ps --filter label=harness.daemon=${daemonIdOf(dataDir)} --format json`
    await eventually(() => expect(asked()).toContain(listing))
    // Already adopted: comparing only the migration mark cannot detect the later Stop.
    await sw.requests.agent_browser_stop!({ agentId: 'b1' }, LOCAL)
    hold = true
    sw.move('a1', 'b1')
    await looked
    expect(await sw.requests.agent_browser_stop!({ agentId: 'b1' }, LOCAL)).toEqual({ ok: true })
    answer([session('a1')])
    await eventually(() => expect(Object.keys(savedState().browsers)).toEqual(['b1']))
    expect(savedState().browsers.b1).toMatchObject({ profile: 'a1' })
    expect(turnedOn()).toEqual({})
    expect(sw.port.published('b1')).toBeUndefined()
    expect(created()).toHaveLength(0)
  })

  it.each([true, false])('consecutive pane moves reserve their queues before the legacy flag lookup and keep on=%s', async on => {
    saveState({ a1: defaultSettings(HOST) })
    let looking!: () => void
    const looked = new Promise<void>(resolve => { looking = resolve })
    let answer!: (rows: RegisteredSession[]) => void
    const pending = new Promise<RegisteredSession[]>(resolve => { answer = resolve })
    let hold = false
    const everyAgent = vi.fn(async () => {
      if (!hold) return [session('a1')]
      looking()
      return pending
    })
    const sw = startSwitching([session('b1', { browser: undefined }), session('c1', { browser: undefined })], { options: { everyAgent } })
    const listing = `ps --filter label=harness.daemon=${daemonIdOf(dataDir)} --format json`
    await eventually(() => expect(asked()).toContain(listing))
    hold = true
    sw.move('a1', 'b1')
    await looked
    sw.move('b1', 'c1')
    answer([session('a1', { browser: on ? true : undefined })])
    await eventually(() => expect(Object.keys(savedState().browsers)).toEqual(['c1']))
    expect(savedState().browsers.c1).toMatchObject({ profile: 'a1' })
    expect(turnedOn()).toEqual(on ? { c1: true } : {})
    expect(everyAgent).toHaveBeenCalledOnce()
    if (on) await ready(sw.port, 'c1')
    else expect(sw.port.published('c1')).toBeUndefined()
  })

  it('an older core moves its Browser flag before the destination starts on the same profile', async () => {
    saveState({ a1: defaultSettings(HOST) })
    let processOptions!: ServiceProcessOptions
    let port!: Port
    const service = runAgentBrowserService({
      dataDir, socketPath: '/unused', machineId: 'test', token: 'test',
      run: options => { processOptions = options; return { stop: () => {} } },
      start: (core, ports, options) => {
        const started = start(core, options)
        ports.agentBrowser = port = started.port
        return started.requests
      },
    })
    const query = vi.fn(async (name: string) => name === 'move_browser' ? { ok: true } : { error: 'UNKNOWN_QUERY' })
    processOptions.onConnected!({ query })
    processOptions.onEvent!({ kind: 'moved', from: 'a1', session: session('b1', { browser: undefined }), on: true })
    await ready(port, 'b1')
    expect(query).toHaveBeenCalledWith('move_browser', { from: 'a1', to: 'b1' })
    expect(savedState().browsers.b1).toMatchObject({ profile: 'a1' })
    expect(turnedOn()).toEqual({ b1: true })
    expect(asked().filter(call => call.startsWith('create '))).toEqual([expect.stringContaining('--label harness.agent=b1')])
    service.stop()
  })

  it('the legacy adapter preserves an off profile and refuses a guest or a destination already on', async () => {
    saveState({ a1: defaultSettings(HOST) })
    let move!: (from: string, session: RegisteredSession, on: boolean) => Promise<boolean>
    const sw = startSwitching([session('b1', { browser: undefined })], { options: { legacyMoves: listener => { move = listener; return () => {} } } })
    expect(await move('a1', session('guest', { guest: 'another account' }), true)).toBe(false)
    await sw.requests.agent_browser_start!({ agentId: 'b1' }, LOCAL)
    await ready(sw.port, 'b1')
    expect(await move('a1', session('b1'), true)).toBe(false)
    expect(await move('a1', session('c1', { browser: undefined }), false)).toBe(true)
    expect(savedState().browsers.c1).toMatchObject({ profile: 'a1' })
    expect(turnedOn()).toEqual({ b1: true })
    expect(sw.port.published('c1')).toBeUndefined()
  })

  it('a stopped agent\'s flag from before goes with its pane', async () => {
    saveState({ a1: defaultSettings(HOST) })
    const sw = startSwitching([session('b1', { browser: undefined })], { options: { everyAgent: async () => [session('a1'), session('b1', { browser: undefined })] } })
    sw.move('a1', 'b1')
    await ready(sw.port, 'b1')
    expect(turnedOn()).toEqual({ b1: true })
    expect(savedState()).toMatchObject({ adopted: { a1: true } })
  })

  it.each(['rejected', 'unavailable', 'omitted'] as const)('%s legacy migration evidence preserves the source and a later move retries its flag', async failure => {
    saveState({ a1: defaultSettings(HOST) })
    const everyAgent = vi.fn(async (): Promise<RegisteredSession[] | null> => [session('a1'), session('b1', { browser: undefined })])
    const sw = startSwitching([session('b1', { browser: undefined })], { options: { everyAgent } })
    const log = vi.spyOn(console, 'log')
    const move = vi.spyOn(Browsers.prototype, 'move')
    const before = readFileSync(join(dataDir, 'agent-browser.json'), 'utf8')
    if (failure === 'rejected') everyAgent.mockRejectedValueOnce(new Error('no core'))
    else everyAgent.mockResolvedValueOnce(failure === 'omitted' ? [] : null)
    sw.move('a1', 'b1')
    await move.mock.results[0]!.value.catch(() => {})
    expect(readFileSync(join(dataDir, 'agent-browser.json'), 'utf8')).toBe(before)
    expect(log).toHaveBeenCalledWith('agent browser b1: browser_move_failed (migration_unavailable)')
    expect(turnedOn()).toEqual({})
    expect(sw.port.published('b1')).toBeUndefined()
    sw.move('a1', 'b1')
    await ready(sw.port, 'b1')
    expect(turnedOn()).toEqual({ b1: true })
    expect(savedState().browsers.b1).toMatchObject({ profile: 'a1' })
  })

  it('an explicitly off legacy row moves its profile without turning it on', async () => {
    saveState({ a1: defaultSettings(HOST) })
    const sw = startSwitching([session('b1', { browser: undefined })], { options: { everyAgent: async () => [session('a1', { browser: undefined })] } })
    const move = vi.spyOn(Browsers.prototype, 'move')
    sw.move('a1', 'b1')
    await move.mock.results[0]!.value
    expect(savedState().browsers.b1).toMatchObject({ profile: 'a1' })
    expect(turnedOn()).toEqual({})
    expect(sw.port.published('b1')).toBeUndefined()
  })

  it.each(['Stop', 'purge'] as const)('%s of the source during an unresolved migration prevents a stale flag from returning', async action => {
    saveState({ a1: defaultSettings(HOST) })
    let answer!: (rows: RegisteredSession[] | null) => void
    let entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const everyAgent = async () => { entered(); return new Promise<RegisteredSession[] | null>(resolve => { answer = resolve }) }
    const sw = startSwitching([session('b1', { browser: undefined })], { options: { everyAgent } })
    const move = vi.spyOn(Browsers.prototype, 'move')
    sw.move('a1', 'b1')
    await waiting
    if (action === 'Stop') await sw.requests.agent_browser_stop!({ agentId: 'a1' }, LOCAL)
    else sw.port.purged('a1')
    answer(null)
    await move.mock.results[0]!.value
    if (action === 'Stop') expect(savedState().browsers.b1).toMatchObject({ profile: 'a1' })
    else await eventually(() => expect(savedState().browsers).toEqual({}))
    expect(turnedOn()).toEqual({})
    expect(sw.port.published('b1')).toBeUndefined()
  })

  it('a move of an agent with no entry makes no Podman call', async () => {
    const read = vi.spyOn(StateFile.prototype, 'read')
    const sw = startSwitching([session('a1', { browser: undefined }), session('b1', { browser: undefined })])
    read.mockClear()
    sw.move('a1', 'b1')
    await until(() => read.mock.calls.length > 2)
    // What is left of the move after its reads is one turn of promises: whether [to]'s Browser is on, whether [from] has
    // an entry whose flag from before is to be taken in, and the entry.
    await new Promise(done => setImmediate(done))
    expect(read).toHaveBeenCalledTimes(3)
    expect(fake.calls()).toEqual([])
  })

  it('a move counts nothing', async () => {
    const count = vi.fn()
    const sw = await ended({ count })
    count.mockClear()
    sw.move('a1', 'b1')
    await ready(sw.port, 'b1')
    // The new agent's browser is measured as any start is, and nothing more: no Start, no first start.
    expect(count.mock.calls).toEqual([['agent_browser_start_ok']])
  })

  it('a line owed to the previous agent is taken back', async () => {
    const sw = startSwitching([session('a1', { browser: undefined }), session('b1', { browser: undefined })])
    await sw.requests.agent_browser_start!({ agentId: 'a1' }, LOCAL)
    await ready(sw.port, 'a1')
    // Its ready line is still on its way when its pane gets a new agent.
    sw.move('a1', 'b1')
    expect(sw.core.turns.cancelDelivery).toHaveBeenLastCalledWith(sw.typed[0]!.deliveryId)
    await ready(sw.port, 'b1')
    expect(sw.typed).toEqual([lineTo('a1', READY_LINE, 'ready'), lineTo('b1', READY_LINE, 'ready')])
  })

  it('a delete of the previous agent after the move removes no volume, and a delete of the new agent removes the moved one', async () => {
    const sw = await ended()
    sw.move('a1', 'b1')
    await ready(sw.port, 'b1')
    const before = asked().length
    sw.port.purged('a1')
    expect(asked()).toHaveLength(before)
    sw.port.purged('b1')
    await eventually(() => expect(savedState().browsers).toEqual({}))
    expect(asked().filter(call => call.startsWith('volume rm'))).toEqual(['volume rm harness-browser-a1'])
  })

  it('on win32 a move does nothing and no process starts', async () => {
    const { podman, spawn } = podmanHere()
    const { port } = start(undefined, { platform: 'win32', podman })
    port.taken('a1', session('b1'))
    expect(fake.calls()).toEqual([])
    expect(spawn).not.toHaveBeenCalled()
  })
})
