import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyPorts, type Asker, type CoreApi, type CorePorts, type ServiceRequests } from '../core/api.js'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { browserAssetsHash } from './agentBrowser/assets.js'
import { fakePodman, type FakePodman } from './agentBrowser/fakePodman.js'
import { imageTag } from './agentBrowser/image.js'
import { createPodman } from './agentBrowser/podman.js'
import { defaultSettings, type BrowserSettings } from './agentBrowser/settings.js'
import { AGENT_BROWSER_REQUESTS, daemonIdOf, startAgentBrowser, type AgentBrowserOptions } from './agentBrowser.js'

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
const started: CorePorts[] = []
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
afterEach(() => {
  for (const ports of started.splice(0)) ports.agentBrowser?.stop()
  for (const server of servers.splice(0)) server.close()
  fake.remove()
  rmSync(dataDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function start(core: CoreApi = fakeCore({ dataDir }), options: AgentBrowserOptions = {}) {
  const ports = emptyPorts()
  started.push(ports)
  const requests = startAgentBrowser(core, ports, {
    podman: createPodman({ resolve: async () => fake.path, platform: 'linux' }),
    platform: 'linux',
    host: HOST,
    now: () => NOW,
    ...options,
  }) as ServiceRequests
  return { port: ports.agentBrowser!, requests, core }
}

/** What podman was asked, as argv lines, without the event stream's reconnects. */
const asked = () => fake.calls().map(call => call.args.join(' ')).filter(line => !line.startsWith('events '))

/** Each fake podman call starts a Node process: a few of them in a row take longer than waitFor's default second. */
const eventually = (check: () => void) => vi.waitFor(check, { timeout: 15_000 })

async function ready(port: CorePorts['agentBrowser'], agentId: string) {
  await eventually(() => expect(port!.frameContext(agentId)).toEqual({ state: 'ready' }))
}

/** The fake podman, with its event stream watched: that child reads stdin to its end, so the fake never logs it. */
function podmanHere() {
  const podman = createPodman({ resolve: async () => fake.path, platform: 'linux' })
  return { podman, spawn: vi.spyOn(podman, 'spawn') }
}

function saveState(browsers: Record<string, BrowserSettings>) {
  writeFileSync(join(dataDir, 'agent-browser.json'), JSON.stringify({ browsers, deleting: [], setup: null }), { mode: 0o600 })
}

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
    port.attached(session('a1'))
    port.attached(session('a1'))
    port.attached(session('a2', { browser: undefined }))
    await ready(port, 'a1')
    expect(port.frameContext('a2')).toBeUndefined()
    expect(asked().filter(line => line.includes('harness-browser-a2'))).toEqual([])
    expect(asked().filter(line => line.startsWith('create '))).toHaveLength(1)
    expect(count.mock.calls.filter(([name]) => name === 'agent_browser_enabled')).toEqual([['agent_browser_enabled']])
    expect(count).toHaveBeenCalledWith('agent_browser_start_ok')
    // The next daemon finds it in the state file: the same agent is not counted again.
    port.stop()
    const again = start(fakeCore({ dataDir, count }))
    again.port.attached(session('a1'))
    await ready(again.port, 'a1')
    expect(count.mock.calls.filter(([name]) => name === 'agent_browser_enabled')).toHaveLength(1)
  })

  it('labels its containers with a stable hash of its data folder', async () => {
    const { podman, spawn } = podmanHere()
    const { port } = start(undefined, { podman })
    port.attached(session('a1'))
    await ready(port, 'a1')
    expect(asked().find(line => line.startsWith('create '))).toContain(`--label harness.daemon=${daemonIdOf(dataDir)}`)
    // One event stream, for this daemon's exits alone.
    expect(spawn.mock.calls).toEqual([[['events', '--format', 'json', '--filter', 'event=died', '--filter', `label=harness.daemon=${daemonIdOf(dataDir)}`]]])
  })

  it('stopped stops, deleted deletes', async () => {
    const { port } = start()
    port.attached(session('a1'))
    await ready(port, 'a1')
    port.stopped('a1')
    await eventually(() => expect(asked()).toContain('network rm harness-browser-a1'))
    expect(asked()).toContain('rm --force --time 10 harness-browser-a1')
    expect(asked()).not.toContain('volume rm harness-browser-a1')
    expect(port.frameContext('a1')).toBeUndefined()
    // A stopped agent is still listed: its purge deletes its browser and its profile.
    port.deleted('a1')
    await eventually(() => expect(asked()).toContain('volume rm harness-browser-a1'))
    await eventually(() => expect(asked().filter(line => line === 'secret rm harness-proxy-a1')).toHaveLength(2))
    // An agent without a browser costs Podman nothing.
    const before = asked().length
    port.stopped('plain')
    port.deleted('plain')
    await new Promise(done => setTimeout(done, 50))
    expect(asked()).toHaveLength(before)
  })

  // The core pipes a viewer to the container's VNC through this command (core/browserStreams.ts).
  it('streamCommand is NO_BROWSER, NOT_READY, then the exec into the ready browser', async () => {
    const { port } = start()
    expect(port.streamCommand('a1')).toEqual({ error: 'NO_BROWSER' })
    port.attached(session('a1'))
    await ready(port, 'a1')
    expect(port.streamCommand('a1')).toEqual({ argv: [fake.path, 'exec', '-i', 'harness-browser-a1', 'socat', 'STDIO', 'TCP:127.0.0.1:5900'] })
    fake.reply('info --format json', { stdout: JSON.stringify({ version: { Version: '4.3.0' }, host: { memTotal: 8 * GiB } }) })
    const old = start(fakeCore({ dataDir: mkdtempSync(join(dataDir, 'old-')) }))
    old.port.attached(session('a2'))
    await eventually(() => expect(old.port.frameContext('a2')).toEqual({ state: 'failed', error: 'podman_old' }))
    expect(old.port.streamCommand('a2')).toEqual({ error: 'NOT_READY' })
  })

  it('a stop and a delete close the browser\'s viewers', async () => {
    const { port } = start()
    const closed: string[] = []
    port.onCloseViewers(agentId => closed.push(agentId))
    port.attached(session('a1'))
    await ready(port, 'a1')
    port.stopped('a1')
    port.deleted('a1')
    expect(closed).toEqual(['a1', 'a1'])
  })

  it('frameContext follows state and calls core.agents.sync on change', async () => {
    const row = session('a1')
    const sync = vi.fn()
    const { port } = start(fakeCore({ dataDir, agents: { sync, byAgent: (agentId: string) => (agentId === 'a1' ? row : undefined) } }))
    port.attached(row)
    await ready(port, 'a1')
    expect(sync).toHaveBeenCalledWith(row)
    expect(sync.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('out of its process it tells the core instead', async () => {
    const told = vi.fn()
    const sync = vi.fn()
    const { port } = start(fakeCore({ dataDir, agents: { sync } }), { told })
    port.attached(session('a1'))
    await ready(port, 'a1')
    expect(told).toHaveBeenCalledWith('a1', { state: 'starting' })
    expect(told).toHaveBeenLastCalledWith('a1', { state: 'ready' })
    port.stopped('a1')
    await eventually(() => expect(told).toHaveBeenLastCalledWith('a1', undefined))
    expect(sync).not.toHaveBeenCalled()
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

  it('on win32 availability is unsupported and no process starts', async () => {
    // A state file starts the service's look at Podman at once anywhere else.
    saveState({ a1: defaultSettings(HOST) })
    const run = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }))
    const { podman, spawn } = podmanHere()
    const { port, requests } = start(undefined, { platform: 'win32', podman, setup: { run } })
    expect(await requests.agent_browser_available!({}, PLAIN_OWNER)).toEqual({ state: 'unsupported' })
    port.attached(session('a1'))
    port.stopped('a1')
    port.deleted('a1')
    expect(port.frameContext('a1')).toBeUndefined()
    expect(port.streamCommand('a1')).toEqual({ error: 'NO_BROWSER' })
    expect(fake.calls()).toEqual([])
    expect(spawn).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('on win32 every other request answers UNSUPPORTED', async () => {
    const { requests } = start(undefined, { platform: 'win32' })
    expect(Object.keys(requests).sort()).toEqual([...AGENT_BROWSER_REQUESTS].sort())
    for (const type of AGENT_BROWSER_REQUESTS.filter(type => type !== 'agent_browser_available')) {
      expect(await requests[type]!({ agentId: 'a1', pane: '%1' }, LOCAL), type).toEqual({ error: 'UNSUPPORTED' })
    }
    expect(fake.calls()).toEqual([])
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
    const { port, requests } = start()
    port.attached(session('a1'))
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
    port.attached(session('a1'))
    await ready(port, 'a1')
    const read = await requests.agent_browser_settings!({ agentId: 'a1' }, LOCAL)
    expect(read).toEqual({ ...defaultSettings(HOST), proxy: { scheme: 'socks5', host: 'proxy.example', port: 1080, username: 'kim', passwordSet: true } })
    expect(JSON.stringify(read)).not.toContain('pw-secret')
    expect(JSON.stringify(port.frameContext('a1'))).not.toContain('proxy')
    // The password goes to Podman on stdin only, never in an argument.
    expect(fake.calls().find(call => call.args[0] === 'secret' && call.args[1] === 'create')!.stdin).toContain('pw-secret')
    expect(fake.calls().some(call => call.args.join(' ').includes('pw-secret'))).toBe(false)
  })

  it('settings_save stores what it was given, keeps a password it was not sent, and answers it as read', async () => {
    const { port, requests } = start()
    port.attached(session('a1'))
    await ready(port, 'a1')
    const proxy = { scheme: 'http', host: 'proxy.example', port: 3128, username: 'kim', password: 'pw-secret' }
    const settings = { ...defaultSettings(HOST), languages: 'vi-VN, en-US', proxy }
    expect(await requests.agent_browser_settings_save!({ agentId: 'a1', settings }, OTHER_DESKTOP)).toMatchObject({
      languages: 'vi-VN, en-US', proxy: { host: 'proxy.example', passwordSet: true },
    })
    const { password: _password, ...withoutPassword } = proxy
    expect(await requests.agent_browser_settings_save!({ agentId: 'a1', settings: { ...settings, proxy: withoutPassword } }, OTHER_DESKTOP))
      .toMatchObject({ proxy: { passwordSet: true } })
    expect(await requests.agent_browser_settings_save!({ agentId: 'a1', settings: { ...settings, screen: '800x600' } }, OTHER_DESKTOP))
      .toEqual({ error: 'INVALID_SETTINGS', detail: 'invalid browser setting: screen' })
  })

  it('saving or removing a proxy, and a proxy test, count agent_browser_proxy_set, _removed, _test_ok or _test_failed', async () => {
    const count = vi.fn()
    const { port, requests } = start(fakeCore({ dataDir, count }))
    port.attached(session('a1'))
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
    port.attached(session('a1'))
    await eventually(() => expect(port.frameContext('a1')).toBeDefined())
    const { password: _password, ...sent } = proxy
    expect(await requests.agent_browser_proxy_test!({ agentId: 'a1', proxy: sent }, LOCAL)).toMatchObject({ ok: true })
    expect(heard.at(-1)).toContain(`Basic ${Buffer.from('kim:stored').toString('base64')}`)
  })

  it('state finds the agent by pane and carries the human mode', async () => {
    const ofPane = vi.fn(async (pane: string) => (pane === '%7' ? 'a1' : pane === '%8' ? 'plain' : null))
    const { port, requests } = start(fakeCore({ dataDir, agents: { ofPane } }))
    port.attached(session('a1'))
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

  it('a failed browser\'s state names its failure', async () => {
    fake.reply('info --format json', { stdout: JSON.stringify({ version: { Version: '4.3.0' }, host: { memTotal: 8 * GiB } }) })
    const { port, requests } = start(fakeCore({ dataDir, agents: { ofPane: async () => 'a1' } }))
    port.attached(session('a1'))
    await eventually(() => expect(port.frameContext('a1')).toEqual({ state: 'failed', error: 'podman_old' }))
    expect(await requests.agent_browser_state!({ pane: '%7' }, LOCAL)).toMatchObject({ agentId: 'a1', state: 'failed', error: 'podman_old' })
  })

  it('an unreadable state file is named to the settings, and nothing is removed', async () => {
    writeFileSync(join(dataDir, 'agent-browser.json'), '{ not json')
    const { port, requests } = start(fakeCore({ dataDir, agents: { ids: async () => ({ live: [], stopped: [] }) } }))
    port.attached(session('a1'))
    await eventually(() => expect(port.frameContext('a1')).toEqual({ state: 'failed', error: 'state_unreadable' }))
    expect(await requests.agent_browser_settings!({ agentId: 'a1' }, LOCAL)).toEqual({ error: 'STATE_UNREADABLE' })
    port.deleted('a1')
    await new Promise(done => setTimeout(done, 50))
    expect(asked().filter(line => / rm |^rm /.test(line))).toEqual([])
  })

  it('service start resumes with the core\'s live and stopped agent ids, and with null when the core does not answer', async () => {
    const listed = { a1: defaultSettings(HOST), a2: defaultSettings(HOST), a3: defaultSettings(HOST) }
    saveState(listed)
    start(fakeCore({ dataDir, agents: { ids: async () => ({ live: ['a1'], stopped: ['a2'] }) } }))
    await eventually(() => expect(asked()).toContain('volume rm harness-browser-a3'))
    expect(asked().filter(line => line.includes('harness-browser-a1') || line.includes('harness-browser-a2'))).toEqual([])

    // No answer, a failed one, or a core that has no such call: nothing is deleted.
    for (const ids of [async () => { throw new Error('timed out') }, undefined]) {
      fake.remove()
      fake = fakePodman()
      fake.reply('ps', { stdout: '[]' })
      saveState(listed)
      const agents = ids ? { ids } : {}
      const { podman, spawn } = podmanHere()
      start(fakeCore({ dataDir, agents }), { podman })
      await eventually(() => expect(spawn).toHaveBeenCalled())
      await new Promise(done => setTimeout(done, 300))
      expect(asked()).toEqual([])
    }
  })

  it('a failure that is not Podman\'s is the service\'s own, and counts against it', async () => {
    const podman = createPodman({ resolve: async () => fake.path, platform: 'linux' })
    const broken = { ...podman, available: async () => { throw new Error('a bug') }, path: async () => { throw new Error('a bug') } }
    const { port, requests } = start(fakeCore({ dataDir, agents: { ofPane: async () => 'a1' } }), { podman: broken })
    await expect(requests.agent_browser_available!({}, LOCAL)).rejects.toThrow('a bug')
    port.attached(session('a1'))
    await eventually(() => expect(port.frameContext('a1')).toEqual({ state: 'failed', error: 'podman_down' }))
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
    port.attached(session('a1'))
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
    const ids = vi.fn(async () => ({ live: [], stopped: [] }))
    const { requests } = start(fakeCore({ dataDir, agents: { ids } }))
    await new Promise(done => setTimeout(done, 100))
    expect(fake.calls()).toEqual([])
    expect(ids).not.toHaveBeenCalled()
    await requests.agent_browser_available!({}, LOCAL)
    await eventually(() => expect(ids).toHaveBeenCalledTimes(1))
  })

  it('a browser with no Podman here waits for setup, and its tools are told no path', async () => {
    const missing = createPodman({ resolve: async () => null, exists: () => false, platform: 'linux' })
    const { port, requests } = start(fakeCore({ dataDir, agents: { ofPane: async () => 'a1' } }), { podman: missing })
    port.attached(session('a1'))
    await eventually(() => expect(port.frameContext('a1')).toEqual({ state: 'failed', error: 'needs_setup' }))
    expect(await requests.agent_browser_state!({ pane: '%7' }, LOCAL)).toEqual({ agentId: 'a1', state: 'failed', error: 'needs_setup', podman: '', human: 'normal' })
  })

  it('stopped before Podman was looked for, it starts no event stream', async () => {
    saveState({})
    const { podman, spawn } = podmanHere()
    start(undefined, { podman }).port.stop()
    await new Promise(done => setTimeout(done, 200))
    expect(spawn).not.toHaveBeenCalled()
  })

  it('with no clock handed in, runs the image of this week', async () => {
    fake.reply('images --format json --filter reference=localhost/harness-browser', {
      stdout: JSON.stringify([{ Names: [`localhost/${imageTag(browserAssetsHash(), new Date())}`], Created: 1, Containers: 0 }]),
    })
    const { port } = start(undefined, { now: undefined })
    port.attached(session('a1'))
    await ready(port, 'a1')
    expect(asked().some(line => line.startsWith('build '))).toBe(false)
  })

  it('with nothing handed in, reads the machine\'s zone and language and runs the real Podman finder', () => {
    const { requests } = start(fakeCore({ dataDir }), { podman: undefined, platform: undefined, host: undefined, now: undefined })
    expect(Object.keys(requests)).toHaveLength(AGENT_BROWSER_REQUESTS.length)
  })
})
