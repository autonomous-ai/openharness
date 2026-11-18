// The devices (services/devices.ts): what the core tells them reaches the dial and the window bridges, what
// they say reaches the core through its API alone, and the fleet failing costs the dial nothing.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join, parse } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { CableHostWiring, DaemonCableHost } from '../cable/cableHost.js'
import { AppFilter, FRONT_SETTLE_MS } from '../cable/hosts/appFilter.js'
import type { CodexRunEnd } from '../cable/hosts/codexQueue.js'
import { CMUX_APP_BINARY, type CmuxClient, type CmuxInputState, type CmuxSession } from '../cable/hosts/cmuxCli.js'
import { hcClientDeps, type HcClient, type HcPrompt, type HcSubscriber, type HcTerminal } from '../cable/hosts/hcClient.js'
import { herdrClientDeps, type HerdrAnswer, type HerdrClient, type HerdrEntry, type HerdrPrompt, type HerdrSubscriber } from '../cable/hosts/herdrClient.js'
import { HerdrSource } from '../cable/hosts/herdrSource.js'
import { observedAgentId, ObservedSource } from '../cable/hosts/observed.js'
import { OPENCODE_MESSAGE, opencodeClientDeps, type OpencodeAnswer, type OpencodeClient, type OpencodeEvent, type OpencodeFault, type OpencodePrompt } from '../cable/hosts/opencodeClient.js'
import { OpencodeSource } from '../cable/hosts/opencodeSource.js'
import type { OrcaChild, OrcaReads, OrcaTabs, OrcaTerminal } from '../cable/hosts/orca.js'
import { AppRings } from '../cable/hosts/select.js'
import { env } from '../config/env.js'
import { routeVoiceTask } from '../lib/voiceRouter.js'
import { DEVICES_FALLBACKS, DEVICES_REQUESTS, emptyPorts, ServiceUnavailableError, type CoreApi, type CorePorts, type DevicesPort } from '../core/api.js'
import type { ObservedAsked, ObservedHookEvent } from '../core/observedHook.js'
import { createServiceHost } from '../core/serviceHost.js'
import * as claudePlugin from '../devices/claudePlugin.js'
import type { ClaudeRun } from '../devices/claudePlugin.js'
import { DIAL_SKILL } from '../devices/dialSkill.js'
import { readSetup, writeSetup } from '../devices/dialSkillFiles.js'
import type { OrcaHomes, OrcaHomesCache } from '../devices/orcaHomes.js'
import * as vscodeExtension from '../devices/vscodeExtension.js'
import type { VscodeExtensionDeps } from '../devices/vscodeExtension.js'
import { devicesListenerPath } from '../devices/listenerPath.js'
import { STOP_HOOK_GRACE_MS } from '../core/turns/turnHooks.js'
import type { FleetEvent } from '../cable/machineFleet.js'
import { claudeProjectsRoots, codexHomeRoots } from '../lib/engineHomes.js'
import type { ExternalProvider, ProcessView } from '../lib/sessionSearch/externals/types.js'
import type { TierInput } from '../lib/notifyTier.js'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCmux, touchStore } from '../testing/fakeCmux.js'
import { fakeCore } from '../testing/fakeCore.js'
import { herdrAppStatus } from '../testing/herdrAppStatus.js'
import type { Fleet, FleetDeps } from './fleet.js'
import type { DevicesDeps } from './devices.js'
import {
  ATTACH_MAX_BYTES, ATTACH_PER_SECOND, FRONT_MAX_BYTES, FRONT_PER_SECOND, NOTICE_MAX_BYTES, NOTICE_PER_SECOND, NOTIFY_MAX_BYTES, NOTIFY_PER_SECOND, REFUSED, TAB_MAX_BYTES, TAB_PER_SECOND, TABS_MAX_BYTES, TABS_PER_SECOND,
  type DevicesListener, type ListenerHandler, type ListenerStreamHandler,
} from './devicesListener.js'

const seen = vi.hoisted(() => ({
  host: null as unknown as CableHostWiring,
  dial: null as unknown as { onDialStatus(status: unknown): void },
  cable: null as unknown as { args: unknown[]; calls: Array<[string, unknown[]]>; setSettings: (id: string, patch: unknown) => Promise<{ ok: boolean; error?: string }> },
  bridges: {} as Record<string, { wiring: Record<string, (...args: unknown[]) => unknown>; calls: Array<[string, unknown[]]> }>,
  fleet: null as null | { deps: FleetDeps; events: ((event: FleetEvent) => void) | null; fail: boolean; calls: Array<[string, unknown[]]>; answers: Record<string, (...args: never[]) => unknown> },
  voice: { sessions: vi.fn(), connected: vi.fn(), shutdown: vi.fn() },
}))

// A copy of the module, so a spec can watch the daemon's own lookup of Claude Code run.
vi.mock('../devices/claudePlugin.js', async (real) => ({ ...await real<object>() }))
// A copy of the module, so a spec can watch the daemon's own VS Code deps be asked for, and answer with its fake.
vi.mock('../devices/vscodeExtension.js', async (real) => ({ ...await real<object>() }))
vi.mock('../cable/cableHost.js', async (real) => {
  const actual = await real<typeof import('../cable/cableHost.js')>()
  return {
    ...actual,
    DaemonCableHost: class extends actual.DaemonCableHost {
      constructor(wiring: CableHostWiring) { super(wiring); seen.host = wiring; seen.dial = this }
    },
  }
})
vi.mock('../cable/cableFleet.js', async (real) => {
  const actual = await real<typeof import('../cable/cableFleet.js')>()
  const recorder = (name: string) => function (this: { calls: Array<[string, unknown[]]> }, ...args: unknown[]) { this.calls.push([name, args]); return Promise.resolve() }
  class FakeCable {
    calls: Array<[string, unknown[]]> = []
    args: unknown[]
    constructor(...args: unknown[]) { this.args = args; seen.cable = this as never }
    start = recorder('start')
    stop = recorder('stop')
    syncAgents = recorder('syncAgents')
    syncSwarms = recorder('syncSwarms')
    syncMachines = recorder('syncMachines')
    followApp = recorder('followApp')
    followLocal = recorder('followLocal')
    replaceNotifications = recorder('replaceNotifications')
    agentSeen = recorder('agentSeen')
    question = recorder('question')
    questionClose = recorder('questionClose')
    turnStarted = recorder('turnStarted')
    turnStep = recorder('turnStep')
    turnReply = recorder('turnReply')
    turnDone = recorder('turnDone')
    turnStats = recorder('turnStats')
    summary = recorder('summary')
    turnError = recorder('turnError')
    petsChanged = recorder('petsChanged')
    viewChanged = recorder('viewChanged')
    wants = true
    connected = true
    get isConnected() { return this.connected }
    wantsStats() { return this.wants }
    apps = true
    wantsApps() { return this.apps }
    petDial = () => ({ supported: false, held: [] as string[], sending: null })
    setSettings = vi.fn(async (id: string, _patch: unknown) => (id === 'usb' ? { ok: true } : { ok: false, error: 'That device is not plugged into this computer.' }))
  }
  return { ...actual, CableFleet: FakeCable }
})
// The window bridges: their wiring is what the devices give them; their own behaviour has its own specs.
for (const [path, name] of [['../cable/windowSelection.js', 'WindowSelection'], ['../cable/windowVisit.js', 'WindowVisit'], ['../cable/windowForm.js', 'WindowForm']] as const) {
  vi.doMock(path, () => ({
    [name]: class {
      calls: Array<[string, unknown[]]> = []
      constructor(wiring: Record<string, (...args: unknown[]) => unknown>) { seen.bridges[name] = { wiring, calls: this.calls } }
      command(...args: unknown[]) { this.calls.push(['command', args]); return Promise.resolve({ ok: true }) }
      cancel(...args: unknown[]) { this.calls.push(['cancel', args]) }
      clear(...args: unknown[]) { this.calls.push(['clear', args]) }
      reply(...args: unknown[]) { this.calls.push(['reply', args]) }
      focusChanged(...args: unknown[]) { this.calls.push(['focusChanged', args]) }
      disconnected(...args: unknown[]) { this.calls.push(['disconnected', args]) }
    },
  }))
}
vi.mock('../cable/windowRoute.js', () => ({
  createWindowRouter: (wiring: Record<string, (...args: unknown[]) => unknown>) => {
    const calls: Array<[string, unknown[]]> = []
    seen.bridges.WindowRouter = { wiring, calls }
    return {
      ask: (...args: unknown[]) => { calls.push(['ask', args]); return Promise.resolve({ t: 'unavailable' }) },
      reply: (...args: unknown[]) => { calls.push(['reply', args]) },
    }
  },
}))
vi.mock('./fleet.js', async (real) => {
  const actual = await real<typeof import('./fleet.js')>()
  return {
    ...actual,
    startFleet: (_core: CoreApi, deps: FleetDeps) => {
      const state = { deps, events: null as ((event: FleetEvent) => void) | null, fail: false, calls: [] as Array<[string, unknown[]]>,
        answers: {} as Record<string, (...args: never[]) => unknown> }
      seen.fleet = state
      const member = (key: string | symbol): ((...args: never[]) => unknown) => {
        if (typeof key === 'string' && Object.hasOwn(state.answers, key)) return state.answers[key]
        if (key === 'onEvent') return (listener: (event: FleetEvent) => void) => { state.events = listener; return () => {} }
        if (key === 'routeTask') return async (text: string) => ({ agentId: 'a1', machineId: 'm1', name: 'api', confidence: 1, reason: text, candidates: [], weighed: 1, machines: 1, via: 'model' })
        if (key === 'routeSend') return (agentId: string) => agentId === 'far' ? { ok: false, machine: 'mac-mini', reason: 'the last request to it did not come back' }
          : agentId === 'nameless' ? { ok: false, machine: '', reason: 'no such agent' } : { ok: true }
        if (key === 'knows') return () => { if (state.fail) throw new Error('lost'); return true }
        if (key === 'stop') return vi.fn()
        // Any other routing member: unanswered here, and failing once the test says the fleet fails.
        return () => { if (state.fail) throw new Error('lost') }
      }
      // Every call the devices make on the fleet, recorded: what crosses to the owner's other machines is read by a spec.
      const fleet = new Proxy({} as Fleet, {
        get: (_t, key) => (...args: never[]) => { state.calls.push([String(key), args]); return member(key)(...args) },
      })
      return { fleet, router: null }
    },
  }
})
vi.mock('../lib/voiceRouter.js', () => ({
  setVoiceRouterSessions: seen.voice.sessions,
  setVoiceRouterDeviceConnected: seen.voice.connected,
  shutdownVoiceRouter: seen.voice.shutdown,
  routeVoiceTask: vi.fn(),
}))
// What the observed source reads of this machine: its processes, the engines' stores and transcripts. Stood in for, so
// no spec looks at the developer's running sessions.
const readers = vi.hoisted(() => ({
  open: null as null | Record<string, unknown>,
  external: null as null | Record<string, unknown>,
  known: new Map<string, string>(),
  // An owner's record path is its session id unless one is given.
  owners: new Map<string, { engine: string; pid: number; record?: string; tty?: string | null }>(),
  rows: new Map<string, { cwd: string; transcriptPath: string | null }>(),
  working: new Map<string, boolean>(),
  scans: 0,
  answer: vi.fn(async (..._args: unknown[]): Promise<string | undefined> => undefined),
  apps: vi.fn(async (_pids: readonly number[]) => new Map<number, string>()),
  name: vi.fn(async (..._args: unknown[]): Promise<string | undefined> => undefined),
  processes: vi.fn(async () => [] as Array<{ pid: number; ppid: number; executable: string }>),
}))
vi.mock('../lib/sessionSearch/external.js', async (real) => ({
  ...await real<typeof import('../lib/sessionSearch/external.js')>(),
  OpenSessions: class {
    constructor(options: Record<string, unknown>) { readers.open = options }
    async owners() {
      readers.scans++
      return new Map([...readers.known.keys()].flatMap((id) => readers.owners.has(id) ? [[id, { record: id, ...readers.owners.get(id)! }] as const] : []))
    }
    async busy(owner: { record: string }) { return readers.working.get(owner.record) !== false }
  },
  SessionRows: class {
    constructor(options: Record<string, unknown>) { readers.external = options }
    async find(wanted: ReadonlyMap<string, string>) {
      return new Map([...wanted.keys()].flatMap((id) => readers.rows.has(id) ? [[id, readers.rows.get(id)!] as const] : []))
    }
  },
}))
vi.mock('../lib/sessionSearch/externals/support.js', async (real) => ({
  ...await real<typeof import('../lib/sessionSearch/externals/support.js')>(),
  listProcesses: async () => [],
  processAlive: () => true,
  fileStamp: async () => null,
}))
// Which app each session found runs in, and the process table a tap on a tmux pane checks: made up, never this machine's
// processes.
vi.mock('../cable/hosts/scannedApp.js', async (real) => ({
  ...await real<typeof import('../cable/hosts/scannedApp.js')>(),
  learnApps: readers.apps,
  readProcessNames: readers.processes,
}))
// The name in a session's own process record: never this machine's ~/.claude.
vi.mock('../cable/hosts/recordName.js', () => ({ readRecordName: readers.name }))
vi.mock('../cable/hosts/lastAnswer.js', async (real) => ({
  ...await real<typeof import('../cable/hosts/lastAnswer.js')>(),
  readLastAnswer: readers.answer,
}))
// This computer's Orca, for the one spec that leaves the devices to build their own read of its account homes: a system
// with none, so no spec runs the developer's own `orca` or reads its accounts.
vi.mock('../devices/orcaHomes.js', async (real) => ({
  ...await real<typeof import('../devices/orcaHomes.js')>(),
  orcaHomesDeps: () => ({ run: async () => ({ code: null, stdout: '', timedOut: false }), onPath: () => null, exists: () => false, platform: 'linux', uid: 1 }),
}))
// The watch on the folder herdr's socket lives in: recorded, with its stops, so no spec watches this machine's folders.
const watched = vi.hoisted(() => ({ calls: [] as unknown[][], stopped: 0 }))
vi.mock('../cable/hosts/unixSocket.js', async (real) => ({
  ...await real<typeof import('../cable/hosts/unixSocket.js')>(),
  watchSocket: (deps: unknown, changed: () => void) => {
    watched.calls.push([deps, changed])
    return () => { watched.stopped++ }
  },
}))
// The watch on the folders opencode's service.json goes in: recorded, with its stops, so no spec watches this machine's
// folders, and herdr's `watched` is left alone.
const watchedFolders = vi.hoisted(() => ({ calls: [] as unknown[][], stopped: 0 }))
vi.mock('../cable/hosts/folderWatch.js', () => ({
  watchNearest: (folders: readonly string[], changed: () => void) => {
    watchedFolders.calls.push([folders, changed])
    return () => { watchedFolders.stopped++ }
  },
}))

const { startDevices } = await import('./devices.js')

/** What the devices ran (`orca`, and on macOS `open`): recorded, so no spec types into, switches or brings forward the
 *  developer's own apps. */
const orcaRuns: Array<[string, string[], number]> = []
const orca = {
  run: async (file: string, args: string[], timeoutMs: number) => { orcaRuns.push([file, args, timeoutMs]); return { code: 0, stdout: '' } },
  onPath: () => '/opt/orca/bin/orca',
  exists: () => false,
  platform: 'linux' as const,
  // For the type alone: no spec here runs Orca's watch or reads its stamp through these.
  spawn: (): OrcaChild => ({ onData: () => {}, exited: new Promise(() => {}), kill: () => {} }),
  mtime: () => null,
}
/** What the devices ran as `codex`: recorded, so no spec runs the developer's own. */
const codexRuns: Array<[string, string[], { cwd: string; env: Record<string, string>; timeoutMs: number }]> = []
const codex: NonNullable<DevicesDeps['codex']> = {
  run: async (file, args, options) => { codexRuns.push([file, args, options]); return 0 },
  binary: () => '/opt/codex/bin/codex',
  platform: 'linux',
}
/** What the devices asked of herdr's socket: recorded, so no spec reaches the developer's own herdr. It takes every
 *  prompt, and has no socket for anything else. */
const herdrCalls: unknown[][] = []
const herdr: HerdrClient = {
  request: async (method, params) => { herdrCalls.push(['request', method, params]); return { ok: false, fault: 'no_socket' } },
  subscribe: (entries, to) => {
    herdrCalls.push(['subscribe', entries])
    // As the client tells it with no socket: once the caller holds its close.
    queueMicrotask(() => to.closed('no_socket'))
    return { close: () => {} }
  },
  prompt: async (paneId, kind, text) => { herdrCalls.push(['prompt', paneId, kind, text]); return { outcome: 'sent' } },
  socketStamp: () => undefined,
}
/** What the devices asked of Herdr Core's socket: recorded, so no spec reaches the developer's own Herdr. It takes every
 *  prompt, and has no socket for anything else. */
const hcCalls: unknown[][] = []
const hc: HcClient = {
  request: async (method, params) => { hcCalls.push(['request', method, params]); return { ok: false, fault: 'no_socket' } },
  subscribe: (to) => {
    hcCalls.push(['subscribe'])
    // As the client tells it with no socket: once the caller holds its close.
    queueMicrotask(() => to.closed('no_socket'))
    return { close: () => {} }
  },
  prompt: async (address, kind, text) => { hcCalls.push(['prompt', address, kind, text]); return { outcome: 'sent' } },
  keys: async (address, keys) => { hcCalls.push(['keys', address, keys]); return false },
  socketStamp: () => undefined,
}
/** cmux as every spec but cmux's own has it: not installed, so no spec runs the developer's own cmux. */
const noCmux: CmuxClient = {
  binary: () => null,
  sessions: async () => ({ ok: false, fault: 'no-binary' }),
  mode: async () => undefined,
  inputState: async () => undefined,
  paste: async () => false,
}
/** What the devices asked of opencode's service: recorded, so no spec reaches the developer's own opencode. It has no
 *  service.json, and its prompt fails. */
const opencodeCalls: unknown[][] = []
const opencode: OpencodeClient = {
  registration: () => { opencodeCalls.push(['registration']); return { fault: 'no_service' } },
  find: async () => { opencodeCalls.push(['find']); return { fault: 'no_service' } },
  request: async (method, path) => { opencodeCalls.push(['request', method, path]); return { ok: false, fault: 'no_service' } },
  events: (_onEvent, onClose) => {
    opencodeCalls.push(['events'])
    // As the client tells it with no service: once the caller holds its close.
    queueMicrotask(() => onClose('no_service'))
    return { close: () => {} }
  },
  prompt: async (...args) => { opencodeCalls.push(['prompt', ...args]); return 'failed' },
}
/** Orca's reads for every spec but Orca's own: nothing lands, so no other spec hears of an order or a watch. */
const inertOrcaReads: OrcaReads = {
  orcaWatchesFocus: () => new Promise(() => {}),
  orcaTabs: () => new Promise(() => {}),
  watchOrcaFocus: () => { throw new Error('no watch outside Orca\'s own specs') },
}
/** Orca's reads, driven by the spec: the probe's answer (one the spec holds, when a promise) and how often it was asked,
 *  each order read held until the spec lands it, and each watch with its lines, its end and whether it was stopped. A
 *  stop ends it, as the child's exit does. */
function fakeOrcaReads(over: { watches?: boolean | Promise<boolean> } = {}) {
  const probes = { count: 0 }
  const orders: Array<(read: OrcaTabs | null) => void> = []
  const watches: Array<{ line(handle: string | null): void; end(): void; stopped: boolean }> = []
  const reads: OrcaReads = {
    orcaWatchesFocus: () => { probes.count++; return Promise.resolve(over.watches ?? false) },
    orcaTabs: () => new Promise((resolve) => { orders.push(resolve) }),
    watchOrcaFocus: (onHandle) => {
      let end = (): void => {}
      const ended = new Promise<void>((resolve) => { end = resolve })
      const watch = { line: onHandle, end: () => end(), stopped: false }
      watches.push(watch)
      return { stop: () => { watch.stopped = true; end() }, ended }
    },
  }
  return { reads, probes, orders, watches }
}

/** Orca's account homes as a spec gives them (devices/orcaHomes.ts): `homes` is the last read's list, `answered` whether
 *  that read gave Orca's answer, and each refresh says `changed` at once, or, while `held`, waits until the spec lands it. */
function fakeOrcaHomes(homes: OrcaHomes = { claude: [], codex: [] }) {
  const fake = {
    homes,
    answered: true,
    changed: false,
    held: false,
    /** The refreshes held, each landed with whether the list changed. */
    pending: [] as Array<(changed: boolean) => void>,
    refresh: vi.fn((): Promise<boolean> => fake.held ? new Promise((resolve) => { fake.pending.push(resolve) }) : Promise.resolve(fake.changed)),
    cache: (): OrcaHomesCache => ({ get: () => fake.homes, answered: () => fake.answered, refresh: fake.refresh }),
    /** The last refresh asked: what the devices do once it lands runs before a spec's own wait on it ends. */
    landed: () => fake.refresh.mock.results.at(-1)?.value,
  }
  return fake
}

/** The process table VS Code's windows match their agents by (services/devices.ts processParents): the spec's own, empty
 *  unless a spec sets it, and each read counted, so no spec reads this machine's processes. */
const processTable = { rows: [] as Array<{ pid: number; ppid: number }>, reads: 0 }

/** VS Code and Harness's extension as the devices see them (services/devices.ts vscodeExtension): the spec's own, absent
 *  unless the spec says its [app] is there or names the version [installed], each `code` run kept, so no spec runs the
 *  developer's VS Code or reads its ~/.vscode. A run installs this build's 9.9.9. */
function fakeVscode({ installed = null, app = installed !== null }: { installed?: string | null; app?: boolean } = {}) {
  const runs: string[][] = []
  let version = installed
  const deps: VscodeExtensionDeps = {
    platform: 'darwin',
    home: '/nowhere',
    pathVar: '',
    exists: () => app,
    executable: () => app,
    read: () => version === null ? null : JSON.stringify([{ identifier: { id: vscodeExtension.VSCODE_EXTENSION_ID }, version }]),
    run: async (file, args) => { runs.push([file, ...args]); version = '9.9.9'; return { code: 0, timedOut: false } },
    files: () => ({
      manifest: JSON.stringify({ name: 'harness-device', version: '9.9.9', publisher: 'autonomous-ai', displayName: 'Harness Device', description: 'The dial in VS Code', engines: { vscode: '^1.90.0' } }),
      main: '',
    }),
    tempDir: () => '/nowhere/vsix',
    write: () => {},
    remove: () => {},
  }
  return { deps, runs }
}

let dataDir: string
let logs: string[]
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'devices-'))
  logs = []
  orcaRuns.length = 0
  codexRuns.length = 0
  herdrCalls.length = 0
  hcCalls.length = 0
  opencodeCalls.length = 0
  watched.calls.length = 0
  watched.stopped = 0
  watchedFolders.calls.length = 0
  watchedFolders.stopped = 0
  seen.bridges = {}
  seen.fleet = null
  readers.open = readers.external = null
  readers.known.clear(); readers.owners.clear(); readers.rows.clear(); readers.working.clear()
  readers.scans = 0
  vi.clearAllMocks()
  readers.answer.mockResolvedValue(undefined)
  readers.name.mockResolvedValue(undefined)
  readers.processes.mockResolvedValue([])
  processTable.rows = []
  processTable.reads = 0
})
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

function start(over: { core?: CoreApi; faults?: string[]; cableDisabled?: boolean; testDialPort?: string; readUsage?: DevicesDeps['readUsage']; now?: () => number; decideTier?: DevicesDeps['decideTier'] | null; refresh?: DevicesDeps['refresh']; orca?: DevicesDeps['orca']; orcaReads?: DevicesDeps['orcaReads']; codex?: DevicesDeps['codex']; herdr?: DevicesDeps['herdr']; hc?: DevicesDeps['hc']; cmux?: DevicesDeps['cmux'] | null; opencode?: DevicesDeps['opencode']; listen?: DevicesDeps['listen']; tty?: DevicesDeps['tty']; claude?: DevicesDeps['claude'] | null; orcaHomes?: ReturnType<typeof fakeOrcaHomes> | null; vscodeExtension?: DevicesDeps['vscodeExtension'] | null } = {}) {
  const core = over.core ?? fakeCore({ dataDir })
  // None, and no read under way, unless the spec gives its own; null leaves the devices to read this computer's.
  const orcaHomes = over.orcaHomes ?? fakeOrcaHomes()
  const ports: CorePorts = emptyPorts()
  const onExit = vi.fn()
  const gone: Array<() => void> = []
  const requests = startDevices(core, ports, {
    logsDir: join(dataDir, 'logs'),
    petsDir: join(dataDir, 'pets'),
    dialSerials: ['E2E'],
    testDialPort: over.testDialPort,
    cableDisabled: over.cableDisabled,
    readUsage: over.readUsage,
    now: over.now,
    refresh: over.refresh,
    orca: over.orca ?? orca,
    orcaReads: over.orcaReads ?? inertOrcaReads,
    codex: over.codex ?? codex,
    herdr: over.herdr ?? herdr,
    hc: over.hc ?? hc,
    // Null: no client given, so the devices build their own.
    cmux: over.cmux === null ? undefined : over.cmux ?? noCmux,
    opencode: over.opencode ?? opencode,
    decideTier: over.decideTier === null ? undefined : over.decideTier ?? (async () => ({ tier: 'alert', by: 'test', detail: '', ms: 0 })),
    faults: new Set(over.faults ?? []),
    log: (line) => { logs.push(line) },
    onExit,
    onCoreGone: (run) => { gone.push(run) },
    listen: over.listen,
    tty: over.tty,
    // A `claude` that finds none unless the spec gives its own: no spec runs the developer's. null leaves it out.
    claude: over.claude === null ? undefined : over.claude ?? (async () => null),
    orcaHomes: over.orcaHomes === null ? undefined : orcaHomes.cache(),
    // A VS Code that is absent unless the spec gives its own: no spec runs the developer's. null leaves it out.
    vscodeExtension: over.vscodeExtension === null ? undefined : over.vscodeExtension ?? fakeVscode().deps,
    processParents: async () => {
      processTable.reads++
      return processTable.rows
    },
  })
  const port = ports.devices as DevicesPort
  // Stopped once the spec ends, as the process stops them: a dial left attached on real timers keeps its 60 s scan, which
  // would count in a later spec's scans.
  onTestFinished(() => port.stop())
  return { core, ports, port, requests, onExit, gone, orcaHomes }
}

const calls = (name: string) => seen.cable.calls.filter(([called]) => called === name).map(([, args]) => args)
/** A window on this computer, as the core names its asker, and a request it never takes back. */
const WINDOW = { local: true, owner: true, connection: 'local:w1' }
const never = new AbortController().signal
/** A core with one Harness agent, h1, on this computer. */
const harnessAgent = () => fakeCore({ dataDir, agents: { advertised: vi.fn(() => [{ agentId: 'h1', registeredAt: 1, engine: 'claude' }] as RegisteredSession[]) } })
/** A hand turning the dial to that agent, as its cable session tells the host (cableSession.ts 'focus'). The rest that
 *  follows 400 ms later, where the agent has a pane, is the spec's to run. */
const turnTo = (agentId: string): void => {
  const host = seen.dial as unknown as DaemonCableHost
  host.focus(agentId)
  host.turned()
}

/** The listener the devices process opens (devicesProcess.ts), stood in for: what it was handed, its close, a front
 *  through its handler as `harness hardware watch` sends one, an attach as the harness-device mod sends one, the
 *  Notifications setting as a watch sends it, an agent's notice as `harness device notify` sends it, the tabs stream a
 *  watch holds open, the dial stream Orca's Harness Device plugin holds open, and a VS Code window's stream and state as
 *  Harness's own extension sends them. */
function fakeListener() {
  type Handlers = Readonly<Record<string, ListenerHandler | ListenerStreamHandler>>
  const given: Array<{ handlers: Handlers; log: (line: string) => void }> = []
  const close = vi.fn(async () => {})
  const listen = vi.fn(async (handlers: Handlers, log: (line: string) => void): Promise<DevicesListener | null> => {
    given.push({ handlers, log })
    return { close }
  })
  const front = (app: unknown): unknown => (given[0].handlers.front as ListenerHandler).handle({ type: 'front', app }, new AbortController().signal)
  const attach = (sessionId: unknown): unknown => (given[0].handlers.attach as ListenerHandler).handle({ type: 'attach', sessionId }, new AbortController().signal)
  const notify = (mode: unknown): unknown => (given[0].handlers.notify as ListenerHandler).handle({ type: 'notify', mode }, new AbortController().signal)
  const notice = (ask: Record<string, unknown>): unknown => (given[0].handlers.notice as ListenerHandler).handle({ type: 'notice', ...ask }, new AbortController().signal)
  /** The lines the devices write on the stream, its end, and whether it takes a line: one not drained yet does not. */
  const tabs = () => {
    const lines: unknown[] = []
    const ended = new AbortController()
    const stream = { takes: true, lines, end: () => ended.abort() }
    expect((given[0].handlers.tabs as ListenerStreamHandler).open({ type: 'tabs' }, {
      write: (line) => {
        if (ended.signal.aborted || !stream.takes) return false
        lines.push(line)
        return true
      },
      onWritable: () => {},
      ended: ended.signal,
    })).toBeUndefined()
    return stream
  }
  /** The lines the devices write on the dial stream, the stream saying it can take one, its end, and its writes throwing
   *  from then on. */
  const dial = () => {
    const lines: unknown[] = []
    const ended = new AbortController()
    let writable = (): void => {}
    let broken = false
    expect((given[0].handlers.dial as ListenerStreamHandler).open({ type: 'dial', standby: true }, {
      write: (line) => {
        if (broken) throw new Error('write broken')
        if (ended.signal.aborted) return false
        lines.push(line)
        return true
      },
      onWritable: (run) => { writable = run },
      ended: ended.signal,
    })).toBeUndefined()
    return { lines, writable: () => writable(), end: (reason: string) => ended.abort(reason), break: () => { broken = true } }
  }
  /** A VS Code window's stream, as Harness's extension holds one open: the lines the devices write on it, its end, and its
   *  writes throwing from then on. */
  const vscode = (window: string) => {
    const lines: unknown[] = []
    const ended = new AbortController()
    let broken = false
    expect((given[0].handlers.vscode as ListenerStreamHandler).open({ type: 'vscode', window }, {
      write: (line) => {
        if (broken) throw new Error('write broken')
        if (ended.signal.aborted) return false
        lines.push(line)
        return true
      },
      onWritable: () => {},
      ended: ended.signal,
    })).toBeUndefined()
    return { lines, end: (reason: string) => ended.abort(reason), break: () => { broken = true } }
  }
  /** A window's shells, as its extension reports them, the first one active. */
  const vscodeState = (window: string, terminals: number[]): unknown => (given[0].handlers['vscode-state'] as ListenerHandler)
    .handle({ type: 'vscode-state', window, terminals, active: terminals[0] ?? null, focused: true }, new AbortController().signal)
  return { given, close, listen, front, attach, notify, notice, tabs, dial, vscode, vscodeState }
}

describe('the devices, as the core starts them', () => {
  it('fill the devices port, start the dial, and stop the voice router\'s worker with the process', () => {
    const { ports, onExit } = start()
    expect(ports.devices).not.toBeNull()
    expect(calls('start')).toHaveLength(1)
    expect(seen.cable.args[2]).toBe(join(dataDir, 'logs'))
    expect(seen.cable.args[4]).toMatchObject({ serials: ['E2E'] })
    onExit.mock.calls[0][0]()
    expect(seen.voice.shutdown).toHaveBeenCalled()
  })

  it('keep the custom pets where petsDir says, and under HARNESS_DEVICES_DIR/pets by default', () => {
    const dir = join(dataDir, 'pets')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pets.json'), JSON.stringify({ all: 'a'.repeat(16), engines: {} }))
    start()
    expect(seen.host.pets!()!.mapping()).toEqual({ all: 'a'.repeat(16), engines: {} })
    // Without the option the store sits under env.HARNESS_DEVICES_DIR (never a path hard-coded in the service).
    const was = env.HARNESS_DEVICES_DIR
    ;(env as { HARNESS_DEVICES_DIR: string }).HARNESS_DEVICES_DIR = join(dataDir, 'home-devices')
    try {
      mkdirSync(join(dataDir, 'home-devices', 'pets'), { recursive: true })
      writeFileSync(join(dataDir, 'home-devices', 'pets', 'pets.json'), JSON.stringify({ all: 'b'.repeat(16), engines: {} }))
      startDevices(fakeCore({ dataDir }), emptyPorts(), { logsDir: join(dataDir, 'logs'), cableDisabled: true, log: () => {}, onExit: vi.fn() })
      expect(seen.host.pets!()!.mapping().all).toBe('b'.repeat(16))
    } finally {
      ;(env as { HARNESS_DEVICES_DIR: string }).HARNESS_DEVICES_DIR = was
    }
  })

  it('leave the serial ports alone when told to, and find the end-to-end suite\'s dial where it says', async () => {
    start({ cableDisabled: true, testDialPort: '/dev/ttys042' })
    expect(calls('start')).toHaveLength(0)
    expect(logs).toContain('[cable] disabled (CABLE_DISABLE=true) — the serial port is left alone')
    const options = seen.cable.args[4] as { discover: () => Promise<unknown[]> }
    expect(await options.discover()).toEqual([expect.objectContaining({ path: '/dev/ttys042' })])
  })

  it('cut an old dial log down to a pointer, and carry on when it cannot be written', () => {
    writeFileSync(join(dataDir, 'dial.log'), 'years of lines')
    start()
    expect(readFileSync(join(dataDir, 'dial.log'), 'utf8')).toBe(`moved to ${join(dataDir, 'logs', 'dial-YYYYMMDD.log')}\n`)
    rmSync(join(dataDir, 'dial.log'))
    mkdirSync(join(dataDir, 'dial.log'))
    expect(() => start()).not.toThrow()
  })

  it('log to the console by default, and register the worker\'s stop on the process\'s exit', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const once = vi.spyOn(process, 'once').mockImplementation(() => process)
    startDevices(fakeCore({ dataDir }), emptyPorts(), { logsDir: dataDir, cableDisabled: true })
    expect(log).toHaveBeenCalledWith('[cable] disabled (CABLE_DISABLE=true) — the serial port is left alone')
    expect(once).toHaveBeenCalledWith('exit', expect.any(Function))
  })
})

describe('the devices\' own listener (services/devicesListener.ts)', () => {
  it('the devices open their listener once, with front, attach, the tab handler, the tabs stream, the dial stream, the Notifications setting, the notice and VS Code\'s windows', () => {
    const listener = fakeListener()
    start({ listen: listener.listen })
    expect(listener.listen).toHaveBeenCalledTimes(1)
    const [{ handlers, log }] = listener.given
    expect(Object.keys(handlers)).toEqual(['front', 'attach', 'tab', 'tabs', 'dial', 'notify', 'notice', 'vscode', 'vscode-state'])
    expect(handlers.notice).toMatchObject({ maxBytes: NOTICE_MAX_BYTES, perSecond: NOTICE_PER_SECOND })
    expect(handlers.front).toMatchObject({ maxBytes: FRONT_MAX_BYTES, perSecond: FRONT_PER_SECOND })
    expect([FRONT_MAX_BYTES, FRONT_PER_SECOND]).toEqual([64, 10])
    expect(handlers.attach).toMatchObject({ maxBytes: ATTACH_MAX_BYTES, perSecond: ATTACH_PER_SECOND })
    expect([ATTACH_MAX_BYTES, ATTACH_PER_SECOND]).toEqual([96, 10])
    expect(handlers.tab).toMatchObject({ maxBytes: TAB_MAX_BYTES, perSecond: TAB_PER_SECOND })
    expect(handlers.tabs).toMatchObject({ maxBytes: TABS_MAX_BYTES, perSecond: TABS_PER_SECOND })
    expect(handlers.dial).toMatchObject({ maxBytes: 64, perSecond: 1 })
    expect(handlers.notify).toMatchObject({ maxBytes: NOTIFY_MAX_BYTES, perSecond: NOTIFY_PER_SECOND })
    // The listener's own handlers: a name that is no app id, a session id that is no UUID, and an app with no tabs, are
    // refused there.
    expect(listener.front('Ghostty')).toBe(REFUSED)
    expect(listener.attach('local_8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b')).toBe(REFUSED)
    expect((handlers.tab as ListenerHandler).handle({ type: 'tab', app: 'orca', tty: '/dev/ttys023' }, new AbortController().signal)).toBe(REFUSED)
    // What the listener says goes to the devices' own log.
    log('[devices] listener open')
    expect(logs).toEqual(['[devices] listener open'])
  })

  it('the listener is given the vscode stream and its state report, with their bounds', () => {
    const listener = fakeListener()
    start({ listen: listener.listen })
    const [{ handlers }] = listener.given
    expect(handlers.vscode).toMatchObject({ maxBytes: 96, perSecond: 1, keyed: { limit: 8 } })
    expect(handlers['vscode-state']).toMatchObject({ maxBytes: 1024, perSecond: 8 })
  })

  it('the listener is closed when the devices stop, before the cable is', async () => {
    const listener = fakeListener()
    const { port } = start({ listen: listener.listen })
    let cableStopsAtClose: number | undefined
    listener.close.mockImplementation(async () => { cableStopsAtClose = calls('stop').length })
    await port.stop()
    expect(listener.close).toHaveBeenCalledTimes(1)
    expect(cableStopsAtClose).toBe(0)
    expect(calls('stop')).toHaveLength(1)
  })

  it('stopping while the listener is still opening closes it once it has opened, and the cable never starts', async () => {
    let opened!: (listener: DevicesListener) => void
    const close = vi.fn(async () => {})
    const { port } = start({ listen: () => new Promise((resolve) => { opened = resolve }) })
    const stopping = port.stop()
    await new Promise((resolve) => setImmediate(resolve))
    // The cable waits behind the listener: a front may still arrive until it is closed.
    expect(calls('stop')).toEqual([])
    opened({ close })
    await stopping
    expect(close).toHaveBeenCalledTimes(1)
    expect(calls('stop')).toHaveLength(1)
    expect(calls('start')).toEqual([])
  })

  it('the cable starts after the listener opened', async () => {
    let opened!: (listener: DevicesListener) => void
    start({ listen: () => new Promise((resolve) => { opened = resolve }) })
    await new Promise((resolve) => setImmediate(resolve))
    // A dial attached means a listener open: the watch tells it the app in front as the dial attaches.
    expect(calls('start')).toEqual([])
    opened({ close: async () => {} })
    await vi.waitFor(() => expect(calls('start')).toHaveLength(1))
  })

  it('a listener that has not opened in a second does not keep the cable off, and opening later starts it no second time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let opened!: (listener: DevicesListener) => void
    start({ listen: () => new Promise((resolve) => { opened = resolve }) })
    await vi.advanceTimersByTimeAsync(999)
    expect(calls('start')).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(calls('start')).toHaveLength(1)
    opened({ close: async () => {} })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls('start')).toHaveLength(1)
  })

  it('a listener that cannot open is one log line, and the devices run on', async () => {
    const { port } = start({ listen: async () => { throw new Error('listen EACCES /Users/someone/.harness/devices.sock') } })
    await vi.waitFor(() => expect(logs).toEqual(['[devices] listener not opened · failed']))
    expect(calls('start')).toHaveLength(1)
    await port.stop()
    expect(calls('stop')).toHaveLength(1)
    // Nothing opened (Windows, a folder not private): the listener said why, and the devices add no line of their own.
    logs.length = 0
    const nothing = start({ listen: async () => null })
    await nothing.port.stop()
    expect(logs).toEqual([])
  })
})

describe('the dial stream, for Orca\'s Harness Device plugin (docs/specs/2026-11-16-orca-device-plugin.md)', () => {
  const said = () => logs.filter((line) => line.startsWith('[devices] dial stream'))
  const API = { name: 'api', app: 'Orca' }

  it('the first line is {"attached":false}; a dial attaching, the agent it shows and the dial going are a line each', () => {
    const listener = fakeListener()
    start({ listen: listener.listen })
    const stream = listener.dial()
    stream.writable()
    seen.host.watching!(true)
    seen.host.dialShows!(API)
    seen.host.watching!(false)
    expect(stream.lines).toEqual([
      { attached: false },
      { attached: true, agent: null },
      { attached: true, agent: { name: 'api', app: 'Orca' } },
      { attached: false },
    ])
  })

  it('the stream\'s open, its end and its count go to the devices\' log', async () => {
    vi.useFakeTimers()
    const listener = fakeListener()
    start({ listen: listener.listen })
    const stream = listener.dial()
    stream.writable()
    seen.host.watching!(true)
    stream.end('gone')
    expect(said()).toEqual(['[devices] dial stream · open', '[devices] dial stream · ended · gone'])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(said()).toEqual([
      '[devices] dial stream · open',
      '[devices] dial stream · ended · gone',
      '[devices] dial stream · lines in the last minute: 2',
    ])
  })

  it('stopping the devices cancels the count\'s timer', async () => {
    vi.useFakeTimers()
    const listener = fakeListener()
    const { port } = start({ listen: listener.listen })
    listener.dial().writable()
    await port.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(said()).toEqual(['[devices] dial stream · open'])
  })

  it('a dial stream that throws costs the dial nothing: the throw is the stream\'s, and the core still hears the dial', async () => {
    vi.useFakeTimers()
    const listener = fakeListener()
    const { core } = start({ listen: listener.listen, faults: ['dialStream'] })
    const stream = listener.dial()
    stream.writable()
    expect(() => {
      seen.host.watching!(true)
      seen.host.dialShows!(API)
    }).not.toThrow()
    expect(core.clients.dialWatching).toHaveBeenCalledWith(true)
    expect(stream.lines).toEqual([{ attached: false }])
    expect(logs).toContain('[devices] dialStream failed · injected fault: dialStream')
    // Its minute count is the stream's too.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(said()).toEqual(['[devices] dial stream · open'])
  })

  it('a write on the dial stream that throws is the stream\'s: neither move of the dial throws', () => {
    const listener = fakeListener()
    const { core } = start({ listen: listener.listen })
    const stream = listener.dial()
    stream.writable()
    stream.break()
    expect(() => seen.host.watching!(true)).not.toThrow()
    expect(() => seen.host.dialShows!(API)).not.toThrow()
    expect(core.clients.dialWatching).toHaveBeenCalledWith(true)
    expect(logs).toContain('[devices] dialStream failed · write broken')
  })

  it('with no listen given the dial\'s moves reach no stream and nothing throws', () => {
    start()
    expect(() => {
      seen.host.watching!(true)
      seen.host.dialShows!(API)
      seen.host.dialShows!(null)
      seen.host.watching!(false)
    }).not.toThrow()
    expect(said()).toEqual([])
  })

  it('no devices log line holds the agent\'s name or its app', async () => {
    vi.useFakeTimers()
    const listener = fakeListener()
    start({ listen: listener.listen })
    const stream = listener.dial()
    stream.writable()
    seen.host.watching!(true)
    seen.host.dialShows!({ name: 'payroll-secrets', app: 'Ghostty' })
    stream.end('stalled')
    await vi.advanceTimersByTimeAsync(60_000)
    const devices = logs.filter((line) => line.startsWith('[devices]'))
    expect(devices).toHaveLength(3)
    for (const line of devices) expect(line).not.toMatch(/payroll-secrets|Ghostty/)
  })
})

describe('the dial\'s host, wired to the core', () => {
  it('reads the agents, this computer and the sign-in from the core, and reports a dial attached', async () => {
    const agent = { agentId: 'a1', engine: 'claude' } as RegisteredSession
    const core = fakeCore({ dataDir, agents: { advertised: vi.fn(() => [agent]), displayName: vi.fn(() => 'api'), activityText: vi.fn(async () => 'Reading'), runtimeProfile: vi.fn(() => 'p') } })
    start({ core })
    const w = seen.host
    expect(w.sessions()).toEqual([agent])
    expect(w.displayName(agent)).toBe('api')
    expect(await w.activityText!('a1')).toBe('Reading')
    expect(w.machineName()).toBe('This machine')
    expect(w.machineId()).toBe('machine-1')
    expect(w.computerId()).toBe('computer-1')
    expect(w.signedIn!()).toBe(true)
    expect(await w.accessToken!({ force: true })).toBe('token')
    expect(core.account.accessToken).toHaveBeenCalledWith({ force: true })
    expect(w.environment!()).toBe('prod')
    w.watching!(true)
    expect(core.clients.dialWatching).toHaveBeenCalledWith(true)
    expect(w.runtimeProfile!(agent)).toBe('p')
    w.log('cable: hello')
    expect(logs).toContain('[cable] cable: hello')
  })

  it('reaches an agent here through the core\'s own doors', async () => {
    const { core } = start()
    const w = seen.host
    w.sendTurn('a1', 'hello')
    w.stopTurn('a1')
    w.answer('a1', 'r1', { q: 'Coffee' })
    await w.answerReviewed!({ agentId: 'a1' } as never)
    w.recent('a1', 3)
    w.recentAsks('a1')
    w.updateAgent!('a1', 'opus', 'high')
    await w.listModels!('a1')
    await w.forkAgent!('a1')
    expect(core.turns.send).toHaveBeenCalledWith('a1', 'hello')
    expect(core.turns.stop).toHaveBeenCalledWith('a1')
    expect(core.questions.answer).toHaveBeenCalledWith('a1', 'r1', { q: 'Coffee' })
    expect(core.questions.answerReviewed).toHaveBeenCalledWith({ agentId: 'a1' })
    expect(core.turns.recent).toHaveBeenCalledWith('a1', 3)
    expect(core.turns.asks).toHaveBeenCalledWith('a1')
    expect(core.agents.setRuntime).toHaveBeenCalledWith('a1', 'opus', 'high')
    expect(core.agents.runtimeModels).toHaveBeenCalledWith('a1')
    expect(core.agents.fork).toHaveBeenCalledWith('a1')
  })

  it('tells the windows on this computer what a hand at this desk did, and the owner\'s apps the device status', () => {
    const { core } = start()
    const w = seen.host
    w.opened!('m1', 'a1')
    w.opened!('m1', 'a1', 'question')
    w.notificationRead!('m1', 'a1', 'tok')
    w.forked!('m1', 'a2', 'a1')
    w.focused!('m1', 'a1')
    w.swarmSelected!('t2')
    w.scrolled!('move', 4, 120)
    w.dialStatus!({ attached: true, fw: '1.2.3' })
    w.dialStatus!({ attached: false })
    expect(vi.mocked(core.clients.sendLocal).mock.calls.map(([frame]) => frame)).toEqual([
      { type: 'dial_open', payload: { machineId: 'm1', agentId: 'a1' } },
      { type: 'dial_open', payload: { machineId: 'm1', agentId: 'a1', reason: 'question' } },
      { type: 'dial_notification_read', payload: { machineId: 'm1', agentId: 'a1', readToken: 'tok' } },
      { type: 'dial_forked', payload: { machineId: 'm1', agentId: 'a2', sourceAgentId: 'a1' } },
      { type: 'dial_focus', payload: { machineId: 'm1', agentId: 'a1' } },
      { type: 'dial_swarm', payload: { swarmId: 't2' } },
      { type: 'dial_scroll', payload: { phase: 'move', dy: 4, velocity: 120 } },
      // With no listener of the devices, nothing could change the Notifications setting: the status does not offer it.
      { type: 'dial_status', payload: { attached: true, fw: '1.2.3' } },
      { type: 'dial_status', payload: { attached: false } },
    ])
    expect(vi.mocked(core.clients.devicesChanged).mock.calls).toEqual([
      [{ status: { attached: true, fw: '1.2.3' }, revision: 1 }],
      [{ status: { attached: false }, revision: 2 }],
    ])
  })

  it('speaks to the window through its bridges, and routes through the fleet', async () => {
    const { core } = start()
    const w = seen.host
    await w.routeInWindow!('fix it', 'review')
    await w.selectPassage!({ agentId: 'a1', op: 'begin' })
    w.clearSelection!()
    await w.visit!({ agentId: 'a1', op: 'open' } as never)
    w.clearVisit!()
    await w.form!({ op: 'open' } as never)
    w.clearForm!()
    expect(seen.bridges.WindowRouter.calls).toEqual([['ask', ['fix it', 'review']]])
    expect(seen.bridges.WindowSelection.calls.map(([name]) => name)).toEqual(['command', 'cancel'])
    expect(seen.bridges.WindowVisit.calls.map(([name]) => name)).toEqual(['command', 'cancel'])
    expect(seen.bridges.WindowForm.calls.map(([name]) => name)).toEqual(['command', 'clear'])
    expect(w.fleet!()).not.toBeNull()
    void core
  })
})

describe('the window bridges, wired to the core', () => {
  it('ask the window with the focus the core last gave, one window at a time', () => {
    const { core, port } = start()
    const { WindowSelection: selection, WindowVisit: visit, WindowForm: form, WindowRouter: router } = seen.bridges
    expect(selection.wiring.focus()).toBeUndefined()
    expect(visit.wiring.focus()).toBeUndefined()
    expect(form.wiring.focus()).toBeUndefined()
    expect(seen.host.appFocus!()).toBeUndefined()
    port.windowFocus({ voice: { machineId: 'm1', agentId: 'a1', connId: 'w1' }, form: { machineId: 'm1', connId: 'w1' } })
    expect(seen.host.appFocus!()).toMatchObject({ machineId: 'm1', agentId: 'a1' })
    expect(calls('followApp')).toEqual([['m1', 'a1']])
    expect(selection.wiring.focus()).toEqual({ machineId: 'm1', agentId: 'a1', connId: 'w1' })
    expect(visit.wiring.focus()).toEqual({ machineId: 'm1', agentId: 'a1', connId: 'w1' })
    expect(form.wiring.focus()).toEqual({ machineId: 'm1', connId: 'w1' })
    selection.wiring.send('w1', { op: 'begin' })
    visit.wiring.send('w1', { op: 'open' })
    form.wiring.send('w1', { op: 'open' })
    expect(vi.mocked(core.clients.sendToWindow).mock.calls).toEqual([
      ['w1', { type: 'dial_selection', payload: { op: 'begin' } }],
      ['w1', { type: 'dial_visit', payload: { op: 'open' } }],
      ['w1', { type: 'dial_form', payload: { op: 'open' } }],
    ])
    form.wiring.log('form: opened')
    router.wiring.log('route: asked')
    expect(logs).toEqual(expect.arrayContaining(['[cable] form: opened', '[cable] route: asked']))
    expect(router.wiring.hasWindow()).toBe(true)
    router.wiring.send('v1', 'fix it', undefined)
    router.wiring.send('v2', 'fix it', 'review')
    expect(vi.mocked(core.clients.sendLocal).mock.calls.map(([frame]) => frame)).toEqual([
      { type: 'voice_route_request', payload: { voiceId: 'v1', text: 'fix it' } },
      { type: 'voice_route_request', payload: { voiceId: 'v2', text: 'fix it', cmd: 'review' } },
    ])
    expect(logs).toContain('[route] voice → the window · 6 bytes · /review')
    port.windowFocus({ voice: null, form: null })
    expect(seen.host.appFocus!()).toBeUndefined()
    expect(calls('followApp')).toEqual([['m1', 'a1']])
  })

  it('hand each window\'s answer to its bridge, and tell them a window left', async () => {
    const { port, requests } = start()
    port.windowReply('selection', 'w1', 'm1', { a: 1 })
    port.windowReply('visit', 'w1', 'm1', { b: 2 })
    port.windowReply('form', 'w1', 'm1', { c: 3 })
    expect(await requests.devices_ws({ frame: 'voice_route_reply', payload: { voiceId: 'v1', state: 'taken' } }, WINDOW, never)).toEqual({})
    port.windowGone('w1')
    expect(seen.bridges.WindowSelection.calls).toEqual([['reply', ['w1', 'm1', { a: 1 }]], ['focusChanged', []]])
    expect(seen.bridges.WindowVisit.calls).toEqual([['reply', ['w1', 'm1', { b: 2 }]]])
    expect(seen.bridges.WindowForm.calls).toEqual([['reply', ['w1', 'm1', { c: 3 }]], ['disconnected', ['w1']]])
    expect(seen.bridges.WindowRouter.calls).toEqual([['reply', ['v1', { t: 'taken' }]]])
  })
})

describe('what the windows say, reaching the dial', () => {
  it('pushes a changed desk at once, and only a changed one, and says whether a tile is on screen', async () => {
    const { port } = start()
    port.desk(['a1', 'a2'], true)
    port.desk(['a1', 'a2'], true)
    port.desk(['a2', 'a1'], true)
    expect(calls('syncAgents')).toHaveLength(2)
    port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'summary', text: 'done', recap: 'fixed it' } })
    port.desk(['a2', 'a1'], false)
    port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'summary', text: 'done' } })
    port.card({ type: 'commander_event', agentId: 'a9', payload: { kind: 'summary', text: 'done', subagent: true } })
    await vi.waitFor(() => expect(calls('summary')).toHaveLength(3))
    // The one that asked the decider lands last: the other two never wait.
    expect(calls('summary')).toEqual([['a1', 'fixed it', 'done', 'silent', undefined, false], ['a9', 'done', 'done', 'silent', undefined, true], ['a1', 'done', 'done', 'alert', undefined, false]])
  })

  describe('a summary\'s tier', () => {
    it('decides a card without a tier by the fixed rules: a harness agent alerts, with no Jev call, and it is tallied', async () => {
      const backend = vi.fn()
      const { port } = start({ core: fakeCore({ dataDir, account: { backend } }), decideTier: null })
      port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'summary', text: 'done', recap: 'The requested build is ready.' } })
      await vi.waitFor(() => expect(calls('summary')).toEqual([
        ['a1', 'The requested build is ready.', 'done', 'alert', undefined, false],
      ]))
      expect(backend).not.toHaveBeenCalled()
      expect(logs).toContainEqual(expect.stringMatching(/^\[cable\] notify · alert · rule:turn · turn · \d+ms$/))
      expect(logs).toContainEqual(expect.stringMatching(/^\[cable\] notify · day \d{4}-\d\d-\d\d · alert 1 · list 0 · silent 0$/))
    })

    it('follows the tier another of the person\'s machines decided', async () => {
      const { port } = start({ decideTier: null })
      seen.fleet!.events!({ machineId: 'mac-mini', kind: 'summary', agentId: 'far-pm', text: 'done', recap: 'Planned.', tier: 'silent' })
      await vi.waitFor(() => expect(calls('summary')).toEqual([['far-pm', 'Planned.', 'done', 'silent', undefined, false]]))
      void port
    })

    it('still decides a remote card that came without a tier, and never throws', async () => {
      const { port } = start({ decideTier: null })
      expect(() => seen.fleet!.events!({ machineId: 'mac-mini', kind: 'summary', agentId: 'far', text: 'done', recap: '' })).not.toThrow()
      await vi.waitFor(() => expect(calls('summary')).toHaveLength(1))
      expect(calls('summary')[0][3]).toBe('alert') // a harness agent's, whatever machine it ran on
      void port
    })

    it('keeps a recap in the list when the decider rejects', async () => {
      const { port } = start({ decideTier: async () => { throw new Error('decision unavailable') } })
      port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'summary', text: 'done', recap: 'The requested build is ready.', fullText: 'The full build report.' } })
      await vi.waitFor(() => expect(calls('summary')).toEqual([
        ['a1', 'The requested build is ready.', 'done', 'list', 'The full build report.', false],
      ]))
    })

    it('keeps the next turn behind a recap still waiting on the decider', async () => {
      vi.useFakeTimers()
      try {
        const decideTier = vi.fn(() => new Promise<{ tier: 'alert'; by: string; detail: string; ms: number }>((r) => setTimeout(() => r({ tier: 'alert', by: 't', detail: '', ms: 0 }), 500)))
        const { port } = start({ decideTier })
        port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'done', text: 'done' } })
        port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'summary', text: 'done', recap: 'r' } })
        port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'processing', text: 'next' } })
        await vi.advanceTimersByTimeAsync(100)
        expect(seen.cable.calls.map(([n]) => n).filter((n) => n === 'summary' || n === 'turnStarted')).toEqual([])
        await vi.advanceTimersByTimeAsync(600)
        expect(seen.cable.calls.map(([n]) => n).filter((n) => n === 'summary' || n === 'turnStarted')).toEqual(['summary', 'turnStarted'])
      } finally { vi.useRealTimers() }
    })

    it('does not let a sub-agent\'s summary use up the main turn\'s numbers, and times a restarted turn afresh', async () => {
      const decideTier = vi.fn(async (_i: { durationS: number | null }) => ({ tier: 'alert' as const, by: 't', detail: '', ms: 0 }))
      const { port } = start({ decideTier })
      const card = (kind: string, extra = {}) => port.card({ type: 'commander_event', agentId: 'a1', payload: { kind, text: 'x', ...extra } })
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(0); card('processing')
        vi.setSystemTime(60_000); card('done')
        card('summary', { subagent: true })
        card('summary', { recap: 'first' })
        await vi.waitFor(() => expect(calls('summary')).toHaveLength(2))
        vi.setSystemTime(100_000); card('processing')
        await vi.waitFor(() => expect(calls('turnStarted')).toHaveLength(2))
        vi.setSystemTime(110_000); card('done')
        await vi.waitFor(() => expect(calls('turnDone')).toHaveLength(2))
        card('summary', { recap: 'second' })
        await vi.waitFor(() => expect(decideTier).toHaveBeenCalledTimes(2))
      } finally { vi.useRealTimers() }
      expect(decideTier.mock.calls.map(([i]) => i.durationS)).toEqual([60, 10])
    })

    it('follows a tier the recaps already decided, asking nobody again, and still silences the agent on screen', () => {
      const decideTier = vi.fn()
      const { port } = start({ decideTier })
      port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'summary', text: 'done', recap: 'Deployed', tier: 'list' } })
      expect(calls('summary')).toEqual([['a1', 'Deployed', 'done', 'list', undefined, false]])
      expect(decideTier).not.toHaveBeenCalled()
      expect(logs).toContain('[cable] notify · list · recaps · decided upstream · 0ms')
      port.desk(['a2'], true)
      port.card({ type: 'commander_event', agentId: 'a2', payload: { kind: 'summary', text: 'done', tier: 'alert' } })
      expect(calls('summary').at(-1)).toEqual(['a2', 'done', 'done', 'silent', undefined, false])
      expect(decideTier).not.toHaveBeenCalled()
    })

    const summaryCalls = () => calls('summary')
    it('is silent without asking Jev when the agent is on screen or the turn was a sub-agent\'s', () => {
      const decideTier = vi.fn()
      const { port } = start({ decideTier })
      port.desk(['a1'], true)
      port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'summary', text: 'done' } })
      port.card({ type: 'commander_event', agentId: 'a9', payload: { kind: 'summary', text: 'done', subagent: true } })
      expect(summaryCalls()).toEqual([['a1', 'done', 'done', 'silent', undefined, false], ['a9', 'done', 'done', 'silent', undefined, true]])
      expect(decideTier).not.toHaveBeenCalled()
    })

    it('never asks the decider while no device is connected, and still draws the tile', () => {
      const decideTier = vi.fn()
      const { port } = start({ decideTier })
      ;(seen.cable as unknown as { connected: boolean }).connected = false
      port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'summary', text: 'done', recap: 'fixed it' } })
      expect(decideTier).not.toHaveBeenCalled()
      expect(summaryCalls()).toEqual([['a1', 'fixed it', 'done', 'silent', undefined, false]])
    })

    it('tells the decider a failed cloud summary failed, and logs rule decisions with the day\'s count', async () => {
      const decideTier = vi.fn(async () => ({ tier: 'alert' as const, by: 't', detail: '', ms: 0 }))
      const { port } = start({ decideTier })
      port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'summary', text: 'x', recap: 'r', failed: true } })
      await vi.waitFor(() => expect(decideTier).toHaveBeenCalledWith(expect.objectContaining({ failed: true })))
      port.desk(['a2'], true)
      port.card({ type: 'commander_event', agentId: 'a2', payload: { kind: 'summary', text: 'x' } })
      port.card({ type: 'commander_event', agentId: 'a2', payload: { kind: 'error', text: 'boom' } })
      expect(logs).toContain('[cable] notify · silent · rule:onScreen · onScreen · 0ms')
      expect(logs).toContain('[cable] notify · alert · rule:failed · turn.error · 0ms')
      expect(logs.some((l) => /notify · day \d{4}-\d\d-\d\d · alert 1 · list 0 · silent 1/.test(l))).toBe(true)
    })

    it('is the decider\'s, asked with the duration and stats of the turn that just ended', async () => {
      const decideTier = vi.fn(async () => ({ tier: 'list' as const, by: 'test', detail: '', ms: 0 }))
      const { port } = start({ decideTier })
      vi.useFakeTimers()
      try {
        vi.setSystemTime(1_000_000)
        port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'processing', text: 'go' } })
        vi.setSystemTime(1_000_000 + 95_000)
        port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'done', text: 'done' } })
      } finally { vi.useRealTimers() }
      port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'summary', text: 'done', recap: 'fixed it' } })
      await vi.waitFor(() => expect(summaryCalls()).toHaveLength(1))
      expect(decideTier).toHaveBeenCalledWith(expect.objectContaining({ recap: 'fixed it', durationS: 95, onScreen: false, subagent: false }))
      expect(summaryCalls()[0].slice(0, 4)).toEqual(['a1', 'fixed it', 'done', 'list'])
    })
  })

  it('passes the tabs, the unread rows, the window\'s focus and what it saw', async () => {
    const { port } = start()
    port.swarms({ active: 't1', swarms: [], tiles: [] })
    // The view the window opens in is sent after the window's own pushes, once they are done.
    await Promise.resolve()
    port.unread([{ agentId: 'a1', machineId: 'm1', text: 'done', question: false }])
    port.appFocus('m1', 'a1')
    port.seen('a1', 'tok')
    expect(seen.cable.calls.map(([name]) => name)).toEqual(['start', 'syncSwarms', 'syncAgents', 'viewChanged', 'replaceNotifications', 'followApp', 'agentSeen'])
    expect(calls('followApp')).toEqual([['m1', 'a1']])
    expect(calls('agentSeen')).toEqual([['a1', 'tok']])
  })

  it('changes one device\'s settings, and logs a refusal', async () => {
    const { port } = start()
    port.settings('usb', { brightness: 3 })
    port.settings('', { brightness: 3 })
    port.settings('gone', { brightness: 3 })
    await vi.waitFor(() => expect(logs).toContain('[cable] settings for gone: That device is not plugged into this computer.'))
    expect(logs).toContain('[cable] settings for no device: That device is not plugged into this computer.')
  })

  it('translates every card for the devices into the dial\'s calls, and ignores the rest', () => {
    const { port } = start()
    const card = (kind: string) => port.card({ type: 'commander_event', agentId: 'a1', payload: { kind, text: kind } })
    card('processing'); card('done'); card('error'); card('tool')
    port.card({ type: 'commander_question', agentId: 'a1', payload: { requestId: 'r1', questions: [] } })
    port.card({ type: 'commander_question_close', agentId: 'a1', payload: { requestId: 'r1' } })
    port.card({ type: 'agent_deleted', payload: {} })
    expect(seen.cable.calls.map(([name]) => name)).toEqual(['start', 'turnStarted', 'turnDone', 'turnError', 'turnStep', 'question', 'questionClose'])
  })

  it('hands the dial a tool card as a step, and a processing card\'s latest sentence beside the status', () => {
    const { port } = start()
    port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'tool', text: 'Read', recap: '/work/cli/src/cable/cableSession.ts' } })
    port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'processing', text: 'Working', update: 'Reading the spec' } })
    expect(seen.cable.calls.slice(1)).toEqual([['turnStep', ['a1', 'Read · cableSession.ts']], ['turnStarted', ['a1', 'Working', 'Reading the spec']]])
  })

  describe('the reply streaming to the dial', () => {
    const reply = (port: DevicesPort, update: string, agentId = 'a1') =>
      port.card({ type: 'commander_event', agentId, payload: { kind: 'reply_text', update } })
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    it('sends at most once per 750 ms per agent, with a trailing send of the last text', async () => {
      const { port } = start()
      reply(port, 'one')                                   // t=0: sent at once
      await vi.advanceTimersByTimeAsync(100); reply(port, 'two')
      await vi.advanceTimersByTimeAsync(100); reply(port, 'three')
      expect(calls('turnReply')).toEqual([['a1', 'one']])
      await vi.advanceTimersByTimeAsync(550)               // t=750: the trailing send, with the 200 ms text
      expect(calls('turnReply')).toEqual([['a1', 'one'], ['a1', 'three']])
      await vi.advanceTimersByTimeAsync(150); reply(port, 'four')   // t=900
      await vi.advanceTimersByTimeAsync(599)
      expect(calls('turnReply')).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(1)                 // t=1500
      expect(calls('turnReply')).toEqual([['a1', 'one'], ['a1', 'three'], ['a1', 'four']])
      await vi.advanceTimersByTimeAsync(5000)              // nothing piles up
      expect(calls('turnReply')).toHaveLength(3)
    })

    it('throttles each agent on its own', async () => {
      const { port } = start()
      reply(port, 'a', 'a1'); reply(port, 'b', 'a2')
      expect(calls('turnReply')).toEqual([['a1', 'a'], ['a2', 'b']])
    })

    it('flushes the last unsent text before the turn ends, and sends nothing after', async () => {
      const { port } = start()
      reply(port, 'one')
      await vi.advanceTimersByTimeAsync(500); reply(port, 'two')
      await vi.advanceTimersByTimeAsync(500)               // t=1000: the trailing send went at 750
      reply(port, 'three')
      port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'done', text: 'done' } })
      await vi.advanceTimersByTimeAsync(5000)
      expect(seen.cable.calls.slice(1).map(([name, args]) => [name, ...(name === 'turnReply' ? [args[1]] : [])]))
        .toEqual([['turnReply', 'one'], ['turnReply', 'two'], ['turnReply', 'three'], ['turnDone']])
    })

    it('ignores an empty update, ends quietly with nothing waiting, and forgets a deleted agent\'s pending text', async () => {
      const { port } = start()
      reply(port, '')
      reply(port, 'one')
      port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'done', text: 'done' } })   // nothing pending
      reply(port, 'two'); reply(port, 'three')
      port.card({ type: 'agent_deleted', payload: { agentId: 'a1' } })
      await vi.advanceTimersByTimeAsync(2000)
      expect(calls('turnReply')).toEqual([['a1', 'one'], ['a1', 'two']])
    })

    it('sends nothing after stop(), even with a send pending', async () => {
      const { port } = start()
      reply(port, 'one'); reply(port, 'two')
      await port.stop()
      await vi.advanceTimersByTimeAsync(5000)
      expect(calls('turnReply')).toEqual([['a1', 'one']])
    })

    it('throttles on the injected monotonic clock, not the wall clock', async () => {
      let mono = 1000
      const { port } = start({ now: () => mono })
      reply(port, 'one')
      vi.setSystemTime(Date.now() + 10 * 60_000)   // the wall clock jumps; the monotonic one does not
      reply(port, 'two')
      expect(calls('turnReply')).toEqual([['a1', 'one']])
      mono += 750; vi.setSystemTime(Date.now() - 20 * 60_000); reply(port, 'three')
      expect(calls('turnReply')).toEqual([['a1', 'one'], ['a1', 'three']])
    })

    it('drops a pending send when a new turn starts', async () => {
      const { port } = start()
      reply(port, 'one'); reply(port, 'two')
      port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'turn_started' } })
      await vi.advanceTimersByTimeAsync(2000)
      expect(calls('turnReply')).toEqual([['a1', 'one']])
    })

    it('keeps the streamed text for the working screen\'s first activity read', async () => {
      const { port } = start()
      reply(port, 'streamed so far')
      expect(await seen.host.activitySnapshot!('a1')).toEqual(null)
    })
  })

  it('sums a turn\'s shell results and tells the dial before the turn ends', () => {
    const { port } = start()
    const ran = (id: string, command: string, outputTail: string) =>
      port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'tool_end', id, tool: 'Bash', command, isError: false, outputTail } })
    ran('t1', 'git commit -m x', '[main abc] x')
    ran('t2', 'npm test', 'Tests: 44 passed')
    port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'tool_end' } })
    port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'tool_end', id: 't3', command: 'ls', isError: true } })
    port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'done', text: 'done' } })
    port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'done', text: 'done' } })
    expect(seen.cable.calls.slice(1).map(([name]) => name)).toEqual(['turnStats', 'turnDone', 'turnDone'])
    expect(calls('turnStats')).toEqual([['a1', { testsPassed: 44, testsFailed: 0, commits: 1 }]])
  })

  describe('a turn\'s tokens', () => {
    const ev = (port: DevicesPort, payload: object) => port.card({ type: 'commander_event', agentId: 'a1', payload })
    const readings = (...values: Array<{ input?: number; cached?: number; output?: number } | null>) => {
      const queue = [...values]
      return vi.fn(async (_id: string) => queue.shift() ?? null)
    }
    const turn = async (readUsage: DevicesDeps['readUsage'], tool = false) => {
      const { port } = start({ readUsage })
      ev(port, { kind: 'turn_started' })
      if (tool) {
        ev(port, { kind: 'tool_end', id: 't1', tool: 'Bash', command: 'git commit -m x', isError: false, outputTail: '[main abc] x' })
        ev(port, { kind: 'tool_end', id: 't2', tool: 'Bash', command: 'npm test', isError: false, outputTail: 'Tests: 44 passed' })
      }
      ev(port, { kind: 'done', text: 'done' })
      return port
    }
    const stats = () => calls('turnStats').map(([, f]) => f)

    it('sends the difference of the two readings before the turn ends, merged with tests and commits', async () => {
      const read = readings({ input: 1000, cached: 0, output: 200 }, { input: 43900, cached: 0, output: 18700 })
      await turn(read, true)
      await vi.waitFor(() => expect(calls('turnDone')).toHaveLength(1))
      expect(stats()).toEqual([{ testsPassed: 44, testsFailed: 0, commits: 1, tokensIn: 42900, tokensOut: 18500 }])
      expect(seen.cable.calls.slice(1).map(([name]) => name)).toEqual(['turnStats', 'turnDone'])
      expect(read).toHaveBeenCalledWith('a1')
    })

    it('counts input without cache reads: (input - cached) difference', async () => {
      await turn(readings({ input: 1_200_000, cached: 1_150_000, output: 1000 }, { input: 2_500_000, cached: 2_410_000, output: 6000 }))
      await vi.waitFor(() => expect(calls('turnDone')).toHaveLength(1))
      expect(stats()).toEqual([{ tokensIn: 40_000, tokensOut: 5000 }])
    })

    it('omits tokensIn, keeping tokensOut, when cached is unknown', async () => {
      await turn(readings({ input: 1_200_000, output: 10 }, { input: 2_500_000, cached: 2_410_000, output: 30 }))
      await vi.waitFor(() => expect(calls('turnDone')).toHaveLength(1))
      expect(stats()).toEqual([{ tokensOut: 20 }])
    })

    it.each([
      ['the start reading is missing', [null, { input: 5, cached: 0, output: 5 }]],
      ['the done reading is missing', [{ input: 5, cached: 0, output: 5 }, null]],
      ['a difference is negative', [{ input: 100, cached: 0, output: 100 }, { input: 50, cached: 0, output: 50 }]],
      ['a difference is over 50 000 000', [{ input: 0, cached: 0, output: 0 }, { input: 50_000_001, cached: 0, output: 50_000_001 }]],
    ] as const)('omits the fields when %s', async (_name, values) => {
      await turn(readings(...values))
      await vi.waitFor(() => expect(calls('turnDone')).toHaveLength(1))
      expect(stats()).toEqual([])
    })

    it('omits only the field whose difference is out of range', async () => {
      await turn(readings({ input: 0, cached: 0, output: 100 }, { input: 7, cached: 0, output: 50 }))
      await vi.waitFor(() => expect(calls('turnDone')).toHaveLength(1))
      expect(stats()).toEqual([{ tokensIn: 7 }])
    })

    it('reads the core\'s fresh usage by default, and none when the core has none', async () => {
      const usageFresh = vi.fn()
        .mockResolvedValueOnce({ inputTokens: 10, cachedTokens: 0, outputTokens: 1 })
        .mockResolvedValueOnce({ inputTokens: 30, cachedTokens: 0, outputTokens: 5 })
      const { port } = start({ core: { ...fakeCore({ dataDir }), usageFresh } })
      ev(port, { kind: 'turn_started' })
      ev(port, { kind: 'done', text: 'done' })
      await vi.waitFor(() => expect(calls('turnDone')).toHaveLength(1))
      expect(stats()).toEqual([{ tokensIn: 20, tokensOut: 4 }])
      const bare = start()
      ev(bare.port, { kind: 'turn_started' })
      ev(bare.port, { kind: 'done', text: 'done' })
      await vi.waitFor(() => expect(calls('turnDone')).toHaveLength(1))
      expect(stats()).toEqual([])  // a new dial session: its own calls
    })

    it('omits the fields when a reading throws, and still ends the turn', async () => {
      await turn(vi.fn(async () => { throw new Error('transcript gone') }))
      await vi.waitFor(() => expect(calls('turnDone')).toHaveLength(1))
      expect(stats()).toEqual([])
    })

    it('omits the fields for an agent whose usage is unknown or remote (null)', async () => {
      await turn(readings(null, null))
      await vi.waitFor(() => expect(calls('turnDone')).toHaveLength(1))
      expect(stats()).toEqual([])
    })

    it('does not hold the turn\'s end past 2 s for a slow done reading', async () => {
      vi.useFakeTimers()
      try {
        let n = 0
        const slow = vi.fn((_id: string) => (++n === 1 ? Promise.resolve({ input: 1, cached: 0, output: 1 }) : new Promise<{ input: number; cached: number; output: number }>((resolve) => setTimeout(() => resolve({ input: 9, cached: 0, output: 9 }), 2500))))
        await turn(slow, true)
        await vi.advanceTimersByTimeAsync(1999)
        expect(calls('turnDone')).toHaveLength(0)
        await vi.advanceTimersByTimeAsync(2)
        expect(calls('turnDone')).toHaveLength(1)
        expect(stats()).toEqual([{ testsPassed: 44, testsFailed: 0, commits: 1 }])
        await vi.advanceTimersByTimeAsync(1000)
        expect(calls('turnStats')).toHaveLength(1)
      } finally { vi.useRealTimers() }
    })

    it('drops the start reading when the turn errors, so the next turn starts clean', async () => {
      const read = readings({ input: 1, cached: 0, output: 1 }, { input: 9, cached: 0, output: 9 })
      const { port } = start({ readUsage: read })
      ev(port, { kind: 'turn_started' })
      ev(port, { kind: 'error', text: 'boom' })
      ev(port, { kind: 'done', text: 'done' })
      await vi.waitFor(() => expect(calls('turnDone')).toHaveLength(1))
      expect(stats()).toEqual([])
      expect(read).toHaveBeenCalledTimes(1)
    })

    it('keeps a card that follows a delayed done behind it', async () => {
      const { port } = start({ readUsage: readings({ input: 1, cached: 0, output: 1 }, { input: 2, cached: 0, output: 2 }) })
      ev(port, { kind: 'turn_started' })
      ev(port, { kind: 'done', text: 'done' })
      ev(port, { kind: 'processing', text: 'Working' })
      await vi.waitFor(() => expect(calls('turnStarted')).toHaveLength(1))
      expect(seen.cable.calls.slice(1).map(([name]) => name)).toEqual(['turnStats', 'turnDone', 'turnStarted'])
    })

    it('keeps a question, its close and a step behind a delayed done, in order', async () => {
      let finish!: (r: { input: number; cached: number; output: number }) => void
      let n = 0
      const slow = vi.fn((_id: string) => (++n === 1 ? Promise.resolve({ input: 1, cached: 0, output: 1 })
        : new Promise<{ input: number; cached: number; output: number }>((resolve) => { finish = resolve })))
      const { port } = start({ readUsage: slow })
      ev(port, { kind: 'turn_started' })
      ev(port, { kind: 'done', text: 'done' })
      port.card({ type: 'commander_question', agentId: 'a1', payload: { requestId: 'r1', questions: [] } })
      port.card({ type: 'commander_question_close', agentId: 'a1', payload: { requestId: 'r1' } })
      ev(port, { kind: 'tool', text: 'Read', recap: '/work/a.ts' })
      seen.fleet!.events!({ kind: 'question', agentId: 'a1', requestId: 'r2', questions: [] } as never)
      seen.fleet!.events!({ kind: 'questionClosed', agentId: 'a1', requestId: 'r2' } as never)
      port.card({ type: 'commander_question', agentId: 'other', payload: { requestId: 'r9', questions: [] } })
      expect(seen.cable.calls.slice(1).map(([name]) => name)).toEqual(['question'])  // another agent is not held
      finish({ input: 2, cached: 0, output: 2 })
      await vi.waitFor(() => expect(calls('questionClose')).toHaveLength(2))
      expect(seen.cable.calls.slice(1).map(([name]) => name)).toEqual(['question', 'turnStats', 'turnDone', 'question', 'questionClose', 'turnStep', 'question', 'questionClose'])
    })

    it('keeps the queue alive when a queued dispatch throws', async () => {
      const { port } = start({ readUsage: readings({ input: 1, cached: 0, output: 1 }, { input: 2, cached: 0, output: 2 }) })
      ev(port, { kind: 'turn_started' })
      ev(port, { kind: 'done', text: 'done' })
      const fake = seen.cable as unknown as Record<string, unknown>
      fake.turnStarted = () => { throw new Error('port gone') }
      ev(port, { kind: 'processing', text: 'Working' })
      await new Promise((resolve) => setTimeout(resolve, 20))
      fake.turnStarted = (...args: unknown[]) => { seen.cable.calls.push(['turnStarted', args]); return Promise.resolve() }
      ev(port, { kind: 'turn_started' })
      ev(port, { kind: 'done', text: 'again' })
      port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'processing', text: 'Next' } })
      await vi.waitFor(() => expect(calls('turnStarted')).toHaveLength(1))
    })

    it('reads no tokens, and sends done at once, when no connected dial asks for turn stats', () => {
      const read = readings({ input: 1, cached: 0, output: 1 }, { input: 2, cached: 0, output: 2 })
      const { port } = start({ readUsage: read })
      ;(seen.cable as unknown as { wants: boolean }).wants = false
      ev(port, { kind: 'turn_started' })
      ev(port, { kind: 'done', text: 'done' })
      expect(calls('turnDone')).toHaveLength(1)
      expect(read).not.toHaveBeenCalled()
    })
  })

  it('drops a turn\'s stats when it ends in an error, so the next turn starts clean', () => {
    const { port } = start()
    const ev = (payload: object) => port.card({ type: 'commander_event', agentId: 'a1', payload })
    ev({ kind: 'tool_end', id: 't1', tool: 'Bash', command: 'git commit -m x', isError: false, outputTail: '[main abc] x' })
    ev({ kind: 'error', text: 'boom' })
    ev({ kind: 'processing', text: 'Working' })
    ev({ kind: 'done', text: 'done' })
    expect(calls('turnStats')).toEqual([])
  })

  it('drops the stats a turn left behind when the next turn starts', async () => {
    const { port } = start()
    const ev = (payload: object) => port.card({ type: 'commander_event', agentId: 'a1', payload })
    ev({ kind: 'tool_end', id: 't1', tool: 'Bash', command: 'git commit -m x', isError: false, outputTail: '[main abc] x' })
    ev({ kind: 'turn_started' })
    ev({ kind: 'done', text: 'done' })
    await vi.waitFor(() => expect(calls('turnDone')).toHaveLength(1))
    expect(calls('turnStats')).toEqual([])
  })

  it('hands the dial the whole answer a summary card carries', async () => {
    const { port } = start()
    port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'summary', text: 'b', recap: 'r', fullText: 'the whole answer' } })
    await vi.waitFor(() => expect(calls('summary')).toHaveLength(1))
    expect(seen.cable.calls.slice(1)).toEqual([['summary', ['a1', 'r', 'b', 'alert', 'the whole answer', false]]])
  })

  it('forgets an agent\'s latest sentence when its processing card has none, and when the agent goes', async () => {
    const { port, core } = start()
    vi.mocked(core.agents.activityText).mockResolvedValue('Working')
    const wired = () => seen.host.activitySnapshot!('a1')
    port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'processing', text: 'Working', update: 'First' } })
    expect(await wired()).toMatchObject({ action: 'First' })
    port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'processing', text: 'Working' } })
    expect(await wired()).not.toHaveProperty('action')
    port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'processing', text: 'Working', update: 'Second' } })
    port.card({ type: 'agent_deleted', payload: { agentId: 'a1' } })
    expect(await wired()).not.toHaveProperty('action')
  })

  it('prefers the core\'s activity snapshot, and has none when the core has nothing to say', async () => {
    const { core } = start()
    const wired = () => seen.host.activitySnapshot!('a1')
    vi.mocked(core.agents.activityText).mockResolvedValue(null as never)
    expect(await wired()).toBeNull()
    ;(core.agents as { activitySnapshot?: unknown }).activitySnapshot = vi.fn(async () => ({ text: 'Core', since: 5 }))
    expect(await wired()).toEqual({ text: 'Core', since: 5 })
  })

  it('says, with frame logging on, whether each card was teed to the dial', () => {
    const was = env.LOG_FRAMES
    ;(env as { LOG_FRAMES: boolean }).LOG_FRAMES = true
    try {
      const { port } = start()
      port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'done' } })
      port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'tool' } })
      port.card({ type: 'commander_event', agentId: 'a1' })
      expect(logs).toEqual(expect.arrayContaining(['[cable] tee done → sent', '[cable] tee tool → ignored', '[cable] tee ? → ignored']))
    } finally {
      ;(env as { LOG_FRAMES: boolean }).LOG_FRAMES = was
    }
  })

  it('logs a dial that throws on a card, and goes on', () => {
    const { port } = start({ faults: ['dial'] })
    port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'done' } })
    port.desk(['a1'], true)
    expect(logs).toContain('[devices] dial failed · injected fault: dial')
    expect(calls('turnDone')).toEqual([])
  })
})

describe('the other machines\' cards', () => {
  it('reach the dial through the same calls as this computer\'s', async () => {
    start()
    const tell = seen.fleet!.events!
    tell({ machineId: 'm2', kind: 'state', state: 'ready' })
    tell({ machineId: 'm2', kind: 'questionClosed', agentId: 'b1', requestId: 'r1' })
    tell({ machineId: 'm2', kind: 'question', agentId: 'b1', requestId: 'r2', questions: [] })
    tell({ machineId: 'm2', kind: 'processing', agentId: 'b1', text: 'go', recap: '' })
    tell({ machineId: 'm2', kind: 'summary', agentId: 'b1', text: 'done', recap: 'fixed', subagent: true })
    tell({ machineId: 'm2', kind: 'summary', agentId: 'b1', text: 'done', recap: '' })
    await vi.waitFor(() => expect(calls('summary')).toHaveLength(2))
    expect(seen.cable.calls.map(([name]) => name)).toEqual(['start', 'syncMachines', 'questionClose', 'question', 'turnStarted', 'summary', 'summary'])
    expect(calls('summary')).toEqual([['b1', 'fixed', 'done', 'silent', undefined, true], ['b1', 'done', 'done', 'alert', undefined, false]])
  })
})

describe('⌘K, the Wi-Fi device\'s borrowed walk, the voice router and stopping', () => {
  it('route a typed task and its send through the fleet, saying why a send was refused', async () => {
    const { port } = start()
    expect(await port.routeTask('fix the parser')).toMatchObject({ agentId: 'a1', reason: 'fix the parser' })
    expect(await port.routeSend('a1', 'go')).toEqual({ ok: true })
    expect(await port.routeSend('far', 'go')).toMatchObject({ ok: false, machine: 'mac-mini' })
    expect(await port.routeSend('nameless', 'go')).toMatchObject({ ok: false, machine: '' })
    expect(logs).toEqual(expect.arrayContaining([
      '[route] ⌘K → a1 · bytes=2',
      '[route] ⌘K → far · bytes=2 · REFUSED: the last request to it did not come back (mac-mini)',
      '[route] ⌘K → nameless · bytes=2 · REFUSED: no such agent',
    ]))
  })

  it('answer a window\'s ⌘K frames as the local WebSocket did: an empty task picks no agent, and nothing is sent without both', async () => {
    const { requests } = start()
    const frame = (name: string, payload: unknown) => requests.devices_ws({ frame: name, payload }, WINDOW, never)
    expect(await frame('route_task', { text: '  fix the parser  ' })).toMatchObject({ agentId: 'a1', reason: 'fix the parser' })
    expect(await frame('route_task', { text: '   ' })).toEqual({ agentId: '', machineId: '', name: '', confidence: 0, reason: 'empty task', candidates: [], weighed: 0, machines: 0, via: '' })
    expect(await frame('route_task', 'not a payload')).toMatchObject({ agentId: '', reason: 'empty task' })
    expect(await frame('route_send', { agentId: 'a1', text: 'go' })).toEqual({ ok: true })
    expect(await frame('route_send', { agentId: 'far', text: 'go' })).toEqual({ ok: false, machine: 'mac-mini', reason: 'the last request to it did not come back' })
    for (const payload of [{ agentId: 'a1' }, { text: 'go' }, { agentId: 5, text: 'go' }]) {
      expect(await frame('route_send', payload), JSON.stringify(payload)).toEqual({ ok: false, machine: '', reason: 'nothing to send' })
    }
    // A spoken task's answer: the three states a window says, each to the router; one it cannot read, or one with no id, is dropped.
    for (const state of ['sent', 'cancelled', 'guessed']) expect(await frame('voice_route_reply', { voiceId: 'v2', state, agentId: 'a1' })).toEqual({})
    expect(await frame('voice_route_reply', { state: 'taken' })).toEqual({})
    expect(seen.bridges.WindowRouter.calls).toEqual([['reply', ['v2', { t: 'sent', agentId: 'a1' }]], ['reply', ['v2', { t: 'cancelled' }]]])
    expect(await frame('dial_settings', {})).toEqual({ error: 'UNKNOWN_FRAME' })
    // A window's only: never a remote client's, whatever it sends.
    for (const asker of [{ local: false, owner: true }, { local: true, owner: false }]) {
      expect(await requests.devices_ws({ frame: 'route_task', payload: { text: 'x' } }, asker, never), JSON.stringify(asker)).toEqual({ error: 'LOCAL_ONLY' })
    }
  })

  it('answer ⌘K with no agent list when the fleet did not start, and the dial routes this computer itself', async () => {
    const { port } = start({ faults: ['fleet'] })
    expect(await port.routeTask('anything')).toMatchObject({ agentId: '', reason: 'no agent list yet', candidates: [] })
    expect(await port.routeSend('a1', 'go')).toEqual({ ok: false, machine: '', reason: 'no agent list yet' })
    expect(logs).toContain('[devices] fleet did not start · injected fault: fleet · the devices run without it')
    expect(seen.host.fleet!()).toBeNull()
    await port.stop()
    expect(calls('stop')).toHaveLength(1)
  })

  it('answer the dial\'s routing as unavailable once the fleet fails, so the dial routes by itself', () => {
    start()
    seen.fleet!.fail = true
    expect(() => seen.host.fleet!()!.knows('a1')).toThrow(ServiceUnavailableError)
  })

  it('lend the Wi-Fi device the dial\'s walk and stroke', async () => {
    const { core, port } = start()
    port.desk(['a1', 'a2'], true)
    port.swarms({ active: 't1', swarms: [{ id: 't1', name: 'Tab', agentIds: ['a1', 'a2'], panes: 2 }], tiles: [] })
    vi.mocked(core.agents.advertised).mockReturnValue([{ agentId: 'a1', registeredAt: 1, engine: 'claude' }, { agentId: 'a2', registeredAt: 2, engine: 'claude' }] as RegisteredSession[])
    // The fleet's router is a stand-in here, so the walk is the host's own over the core's agents.
    seen.fleet!.fail = true
    expect(await port.stepFocus('next', 'a1')).toEqual(expect.objectContaining({ agentId: 'a2' }))
    port.scroll('down', 0, 0)
    expect(vi.mocked(core.clients.sendLocal).mock.calls.map(([frame]) => frame.type)).toEqual(['dial_focus', 'dial_scroll'])
  })

  it('walk the cloud harnesses on the desk too, where the core offers them', async () => {
    const { core, port } = start()
    port.desk(['a1', 'cloud_1'], true)
    port.swarms({ active: 't1', swarms: [{ id: 't1', name: 'Tab', agentIds: ['a1', 'cloud_1'], panes: 2 }], tiles: [] })
    vi.mocked(core.agents.advertised).mockReturnValue([{ agentId: 'a1', registeredAt: 1, engine: 'claude' }] as RegisteredSession[])
    core.agents.cloud = () => [{ agentId: 'cloud_1', registeredAt: 2, engine: 'fo' }] as unknown as RegisteredSession[]
    seen.fleet!.fail = true
    expect(await port.stepFocus('next', 'a1')).toEqual(expect.objectContaining({ agentId: 'cloud_1' }))
  })

  it('tell the voice router the engines here and whether a device watches, and stop everything', async () => {
    const { port } = start()
    port.engines(['claude', 'codex'])
    port.commanders(true)
    expect(seen.voice.sessions).toHaveBeenCalledWith([{ engine: 'claude' }, { engine: 'codex' }])
    expect(seen.voice.connected).toHaveBeenCalledWith(true)
    await port.stop()
    expect(calls('stop')).toHaveLength(1)
    expect(seen.voice.shutdown).toHaveBeenCalled()
  })
})

describe('the devices\' own copy of the machine list', () => {
  it('is read through the core, and writes no file of its own', async () => {
    const machines = vi.fn(async (): Promise<{ status: number; body: Record<string, unknown> }> => ({ status: 200, body: { success: true, data: { machines: [{ machineId: 'm1', computerId: 'computer-1', name: 'Mine', status: 'running' }] } } }))
    start({ core: fakeCore({ dataDir, account: { machines } }) })
    const list = seen.fleet!.deps.machines
    await list.refresh()
    expect(list.list()).toEqual({ source: 'backend', machines: [expect.objectContaining({ machineId: 'm1', local: true })] })
    expect(existsSync(join(dataDir, 'machines.json'))).toBe(false)
    machines.mockResolvedValueOnce({ status: 500, body: {} })
    await list.refresh()
    expect(logs).toContain('[cable] machines: HTTP 500 — showing the last known list')
    expect(seen.fleet!.deps.desk()).toEqual([])
  })
})

describe('the Devices tab', () => {
  it('answers the owner alone: the devices here, and one device\'s settings', async () => {
    const { requests } = start()
    // The dial's own status, as its session reports it to the host, which tells the windows (revision 1).
    seen.dial.onDialStatus({ attached: true, devices: [{ id: 'usb', attached: true, settings: { brightness: 80 } }] })
    const owner = { local: true, owner: true }
    expect(await requests.harness_devices_list({}, { local: false, owner: false })).toEqual({ error: 'OWNER_REQUIRED' })
    expect(await requests.harness_devices_list({}, owner)).toMatchObject({ protocol: 1, revision: 1, status: { attached: true } })
    expect(await requests.harness_device_settings({ id: 'usb', patch: { brightness: 35 } }, owner)).toMatchObject({ ok: true, revision: 1 })
    expect(seen.cable.setSettings).toHaveBeenCalledWith('usb', { brightness: 35 })
  })
  it('answers the pet requests to the owner on this computer only', async () => {
    const { requests } = start()
    for (const type of ['pet_preview', 'pet_apply', 'pet_reset', 'pet_status'] as const) {
      expect(await requests[type]({}, { local: false, owner: false })).toEqual({ error: 'OWNER_REQUIRED' })
      expect(await requests[type]({}, { local: true, owner: false })).toEqual({ error: 'OWNER_REQUIRED' })
      expect(await requests[type]({}, { local: false, owner: true })).toEqual({ error: 'LOCAL_ONLY' })
    }
    expect(await requests.pet_status({}, { local: true, owner: true })).toEqual({
      mapping: { all: null, engines: {} }, dial: { supported: false, held: [], sending: null }, pets: {},
    })
    expect(await requests.pet_apply({ target: 'all', id: '0123456789abcdef' }, { local: true, owner: true })).toMatchObject({ error: 'UNKNOWN_PET' })
    expect(calls('petsChanged')).toEqual([])
    // A changed mapping reaches every live dial.
    expect(await requests.pet_reset({ target: 'all' }, { local: true, owner: true })).toMatchObject({ ok: true })
    expect(calls('petsChanged')).toEqual([[]])
  })
})

describe('agents outside a pane, from their hooks and the open sessions (cable/hosts/observed.ts)', () => {
  const ID = observedAgentId('claude', 'sess-1')
  const hook = (event: ObservedHookEvent['event'], over: Partial<ObservedHookEvent> = {}): ObservedHookEvent => ({
    engine: 'claude', sessionId: 'sess-1', event, cwd: '/work/api', callerPid: 4242, transcriptPath: '/t/sess-1.jsonl',
    hostHints: { ORCA_AGENT_SESSION_ID: 'orca-1' }, ...over,
  })
  /** A permission prompt that waits, as the plugin's hook client posts it (deviceClaude/asked.ts). */
  const asked = (over: Partial<ObservedAsked> = {}): ObservedAsked => ({
    engine: 'claude', sessionId: 'sess-1', event: 'asked', tool: 'Bash', summary: 'npm test', cwd: '/work/api', ...over,
  })
  const host = () => seen.dial as unknown as DaemonCableHost
  /** The dial's list with no window, as its session reads it every second. */
  const machineList = async (port: DevicesPort) => { port.swarms(null); return host().listAgentSnapshot() }

  it('an observed event from the core reaches ObservedSource and the dial\'s list', async () => {
    const { port } = start({ faults: ['fleet'] })
    port.observed(hook('session-start'))
    expect(await machineList(port)).toMatchObject({ view: 'machine', tab: '', total: 1,
      agents: [{ id: ID, name: 'api', engine: 'claude', host: 'orca', caps: 's' }] })
    // This machine's own readers, every engine's, with Harness's data folder left out as search leaves it.
    expect(readers.external).toMatchObject({ providers: expect.any(Array), excluded: [dataDir] })
    expect(readers.open).toMatchObject({ providers: readers.external!.providers })
  })

  it('HARNESS_DEVICE_OBSERVED=off ignores observed events and lists only harness agents with no window', async () => {
    // Read once with the rest of the environment (config/env.ts), as the cable's own switches are.
    const switched = env as { HARNESS_DEVICE_OBSERVED: boolean }
    switched.HARNESS_DEVICE_OBSERVED = false
    onTestFinished(() => { switched.HARNESS_DEVICE_OBSERVED = true })
    const { port } = start({ core: harnessAgent(), faults: ['fleet'] })
    port.observed(hook('needs-input'))
    // A window closing reminds of no agent outside a pane: there is none.
    port.swarms({ active: 't1', swarms: [], tiles: [] })
    expect(await machineList(port)).toMatchObject({ view: 'machine', total: 1, agents: [{ id: 'h1', host: 'harness', caps: 'sva' }] })
    expect(calls('turnStarted')).toEqual([])
    // No source at all: nothing reads this machine's sessions.
    expect(readers.open).toBeNull()
    expect(readers.external).toBeNull()
  })

  it('scan runs on dial attach and every 60 s only while a dial is attached', async () => {
    vi.useFakeTimers()
    const { port } = start({ faults: ['fleet'] })
    readers.known.set('sess-9', 'terminal')
    readers.owners.set('sess-9', { engine: 'codex', pid: 77 })
    readers.rows.set('sess-9', { cwd: '/work/web', transcriptPath: null })
    // Between turns: a turn found running would be read every 3 s until it ends, which is not this scan.
    readers.working.set('sess-9', false)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(readers.scans).toBe(0)
    seen.host.watching!(true)
    // Once Orca's homes are read, where the last read is old.
    await vi.waitFor(() => expect(readers.scans).toBe(1))
    // Running before the dial came, it is listed now.
    await vi.waitFor(async () => expect((await machineList(port)).agents).toEqual([expect.objectContaining({ id: observedAgentId('codex', 'sess-9'), engine: 'codex' })]))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readers.scans).toBe(2)
    seen.host.watching!(false)
    await vi.advanceTimersByTimeAsync(180_000)
    expect(readers.scans).toBe(2)
  })

  it('the scan asks which app each session it found runs in, by pid', async () => {
    vi.useFakeTimers()
    const { port } = start({ faults: ['fleet'] })
    readers.known.set('sess-9', 'terminal')
    readers.owners.set('sess-9', { engine: 'codex', pid: 77 })
    readers.rows.set('sess-9', { cwd: '/work/web', transcriptPath: null })
    readers.working.set('sess-9', false)
    seen.host.watching!(true)
    await vi.waitFor(async () => expect((await machineList(port)).agents).toHaveLength(1))
    expect(readers.apps.mock.calls).toEqual([[[77]]])
  })

  it('a session\'s name is read with the records folders: Claude Code\'s own and each Orca account home\'s', async () => {
    vi.useFakeTimers()
    const orca = mkdtempSync(join(tmpdir(), 'orca-home-'))
    onTestFinished(() => rmSync(orca, { recursive: true, force: true }))
    const { port } = start({ faults: ['fleet'], orcaHomes: fakeOrcaHomes({ claude: [orca], codex: [] }) })
    readers.known.set('sess-7', 'terminal')
    readers.owners.set('sess-7', { engine: 'claude', pid: 78, record: '/s/78.json' })
    readers.rows.set('sess-7', { cwd: '/work/scratch-2016', transcriptPath: null })
    readers.working.set('/s/78.json', false)
    readers.name.mockResolvedValue('Tho')
    seen.host.watching!(true)
    await vi.waitFor(async () => expect((await machineList(port)).agents)
      .toEqual([expect.objectContaining({ id: observedAgentId('claude', 'sess-7'), name: 'Tho' })]))
    expect(readers.name.mock.calls).toEqual([[{ pid: 78, record: '/s/78.json', sessionId: 'sess-7' },
      { records: [join(dirname(env.CLAUDE_PROJECTS_DIR), 'sessions'), join(orca, 'sessions')] }]])
  })

  describe('Orca\'s account homes (docs/plans/2026-11-17-new-user-onboarding-design.md, "C. Orca homes")', () => {
    let root: string
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'orca-homes-')) })
    afterEach(() => rmSync(root, { recursive: true, force: true }))
    /** An Orca account's config folder, as `orca account list` names one, with these folders in it. */
    const orcaHome = (name: string, ...folders: string[]): string => {
      const home = join(root, name)
      mkdirSync(home)
      for (const folder of folders) mkdirSync(join(home, folder))
      return home
    }

    it('the open scan\'s providers look in Orca\'s homes', async () => {
      // A Claude Code session's process record in the account's own sessions folder, and its process, as
      // engines/transcriptReads.golden.spec.ts makes them.
      const home = orcaHome('claude-1', 'sessions')
      const sessionId = 'aaaaaaaa-0002-4000-8000-000000000002'
      writeFileSync(join(home, 'sessions', '102.json'), JSON.stringify({ pid: 102, sessionId, status: 'idle' }))
      const view: ProcessView = {
        list: async () => [{ pid: 102, ppid: 1, executable: 'claude', args: 'claude' }],
        openFiles: async () => new Map(), openFilesOf: async () => new Map(), cwds: async () => new Map(), alive: (pid) => pid === 102,
      }
      const orca = fakeOrcaHomes({ claude: [home], codex: [] })
      start({ faults: ['fleet'], orcaHomes: orca })
      const claude = (readers.open!.providers as ExternalProvider[]).find((provider) => provider.engine === 'claude')!
      expect(await claude.owners!(view)).toEqual([{ sessionId, pid: 102, record: join(home, 'sessions', '102.json') }])
      // The places follow the last read: with the home gone from Orca's list, nothing claims it.
      orca.homes = { claude: [], codex: [] }
      expect(await claude.owners!(view)).toEqual([])
    })

    it('a last answer is read with Orca\'s roots, for Claude Code and for Codex in an Orca Codex home', async () => {
      vi.useFakeTimers()
      readers.answer.mockResolvedValue('Shipped.')
      const claudeHome = orcaHome('claude-1', 'projects')
      const codexHome = orcaHome('codex-1')
      const { port } = start({ faults: ['fleet'], orcaHomes: fakeOrcaHomes({ claude: [claudeHome], codex: [codexHome] }) })
      const transcript = join(claudeHome, 'projects', '-work-api', 'sess-1.jsonl')
      port.observed(hook('turn-start', { transcriptPath: transcript }))
      port.observed(hook('turn-stop', { transcriptPath: transcript }))
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
      expect(readers.answer).toHaveBeenLastCalledWith('claude', transcript,
        { roots: [env.CLAUDE_PROJECTS_DIR, join(claudeHome, 'projects')], maxBytes: 262_144, deadlineMs: 1000 })
      const rollout = join(codexHome, 'sessions', '2026', '11', '17', 'rollout-a.jsonl')
      port.observed(hook('turn-stop', { engine: 'codex', sessionId: 'cx-1', transcriptPath: rollout }))
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
      expect(readers.answer).toHaveBeenLastCalledWith('codex', rollout,
        { roots: [join(env.CODEX_HOME, 'sessions'), join(codexHome, 'sessions')], maxBytes: 262_144, deadlineMs: 1000 })
    })

    it('a scan reads Orca\'s homes again when the list is old, and waits for it', async () => {
      vi.useFakeTimers()
      const orca = fakeOrcaHomes()
      start({ faults: ['fleet'], orcaHomes: orca })
      // The first read, as the devices start.
      expect(orca.refresh).toHaveBeenCalledTimes(1)
      orca.held = true
      seen.host.watching!(true)
      expect(orca.refresh).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(4_000)
      expect(readers.scans).toBe(0)
      orca.pending[0](false)
      await vi.waitFor(() => expect(readers.scans).toBe(1))
      // Each scan asks: the cache reads only once its last read is 5 minutes old.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(orca.refresh).toHaveBeenCalledTimes(3)
    })

    // The read can take its 5 s: a scan that lands after the dial went, or once the devices stop, lists and says nothing.
    it('a scan whose Orca read lands once the dial has gone or the devices are stopping reads no session', async () => {
      vi.useFakeTimers()
      const orca = fakeOrcaHomes()
      const listener = fakeListener()
      const { port } = start({ faults: ['fleet'], orcaHomes: orca, listen: listener.listen })
      orca.held = true
      // Landed with the dial still here, it scans.
      seen.host.watching!(true)
      orca.pending[0](false)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(readers.scans).toBe(1)

      await vi.advanceTimersByTimeAsync(59_000)
      expect(orca.pending).toHaveLength(2)
      seen.host.watching!(false)
      orca.pending[1](false)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(readers.scans).toBe(1)

      // Stopping, the listener closes first: the dial is still attached until it has.
      let closed!: () => void
      listener.close.mockImplementationOnce(() => new Promise<void>((resolve) => { closed = resolve }))
      seen.host.watching!(true)
      const stopping = port.stop()
      orca.pending[2](false)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(readers.scans).toBe(1)
      closed()
      await stopping
    })

    it('with no observed source and no skill writer Orca is not asked', () => {
      const switched = env as { HARNESS_DEVICE_OBSERVED: boolean }
      switched.HARNESS_DEVICE_OBSERVED = false
      onTestFinished(() => { switched.HARNESS_DEVICE_OBSERVED = true })
      expect(start({ faults: ['fleet'] }).orcaHomes.refresh).not.toHaveBeenCalled()
      // The dial skill's writer alone asks, for its start pass.
      expect(start({ faults: ['fleet'], listen: fakeListener().listen }).orcaHomes.refresh).toHaveBeenCalledTimes(1)
    })

    it('unset, the cache is built on this computer\'s orca', async () => {
      start({ faults: ['fleet'], orcaHomes: null })
      await vi.waitFor(() => expect(logs).toContain('[observed] orca homes · not read · no orca'))
    })
  })

  it('removes an ended session within 11 s, and ends a Codex turn within 3 s of its process going quiet', async () => {
    vi.useFakeTimers()
    const { port } = start({ faults: ['fleet'] })
    const codex = observedAgentId('codex', 'cx-1')
    port.observed(hook('turn-start', { engine: 'codex', sessionId: 'cx-1' }))
    readers.known.set('cx-1', 'terminal')
    readers.owners.set('cx-1', { engine: 'codex', pid: 4242 })
    readers.working.set('cx-1', false)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(calls('turnDone')).toEqual([[codex]])
    // The end of a session never listed is looked at by nobody.
    const timers = vi.getTimerCount()
    port.observed(hook('session-end', { sessionId: 'never-listed' }))
    expect(vi.getTimerCount()).toBe(timers)
    port.observed(hook('session-start'))
    port.observed(hook('session-end'))
    // 10 s after its end (observed.ts), not at the next 30 s look at the processes.
    await vi.advanceTimersByTimeAsync(11_000)
    expect((await machineList(port)).agents.map((a) => a.id)).toEqual([codex])
  })

  it('timers stop when the service stops', async () => {
    vi.useFakeTimers()
    const { port } = start()
    seen.host.watching!(true)
    // An ended session's look at the processes, still to come.
    port.observed(hook('session-start'))
    port.observed(hook('session-end'))
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    await port.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('inline (HARNESSD_SERVICES=none) wiring gets the same port', async () => {
    // As core/main.ts starts the devices in the core's own process: through the service host, which guards the port.
    const ports = emptyPorts()
    createServiceHost(ports, { log: () => {} }).start('devices', (core, started) => startDevices(core, started, {
      logsDir: join(dataDir, 'logs'), cableDisabled: true, faults: new Set(['fleet']), log: () => {}, onExit: vi.fn(), orca, orcaReads: inertOrcaReads, codex,
    }), fakeCore({ dataDir }), DEVICES_FALLBACKS, DEVICES_REQUESTS)
    ports.devices!.observed(hook('session-start'))
    expect(await machineList(ports.devices!)).toMatchObject({ view: 'machine', agents: [{ id: ID, host: 'orca', caps: 's' }] })
    // The mod's poll too, past the guard's fallbacks: held until its client goes.
    const poll = ports.devices!.inboxPoll({ pollId: 'p1', sessionId: 'sess-1' })
    ports.devices!.inboxGone('p1')
    expect(await poll).toEqual({})
  })

  it('observed turn-stop reaches the dial as turn.done and summary with the last answer', async () => {
    vi.useFakeTimers()
    readers.answer.mockResolvedValue('All 12 tests pass.')
    const { port } = start()
    port.observed(hook('turn-start'))
    port.observed(hook('turn-stop'))
    // The answer is read once the core's Stop grace is over (observed.ts).
    await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
    expect(calls('summary')).toHaveLength(1)
    expect(seen.cable.calls.map(([name]) => name)).toEqual(['start', 'turnStarted', 'turnDone', 'summary'])
    expect(calls('turnStarted')).toEqual([[ID, '', undefined]])
    expect(calls('turnDone')).toEqual([[ID]])
    expect(calls('summary')).toEqual([[ID, 'All 12 tests pass.', 'All 12 tests pass.', 'alert', 'All 12 tests pass.', false]])
    // Read only inside Claude Code's own folders, bounded in bytes and time.
    expect(readers.answer).toHaveBeenCalledWith('claude', '/t/sess-1.jsonl', { roots: claudeProjectsRoots(env.CLAUDE_PROJECTS_DIR), maxBytes: 262_144, deadlineMs: 1000 })

    // The next turn's answer is not read: the last one is not said again as if it were this turn's.
    readers.answer.mockResolvedValue(undefined)
    port.observed(hook('turn-start'))
    port.observed(hook('turn-stop'))
    await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
    expect(readers.answer).toHaveBeenCalledTimes(2)
    expect(calls('turnDone')).toHaveLength(2)
    expect(calls('summary')).toHaveLength(1)

    // Codex's transcripts are read under its home's sessions folder.
    readers.answer.mockResolvedValue('Renamed the flag.')
    port.observed(hook('turn-stop', { engine: 'codex', sessionId: 'cx-1', transcriptPath: '/t/rollout.jsonl' }))
    await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
    expect(calls('summary')).toHaveLength(2)
    expect(calls('summary')[1]).toEqual([observedAgentId('codex', 'cx-1'), 'Renamed the flag.', 'Renamed the flag.', 'alert', 'Renamed the flag.', false])
    expect(readers.answer).toHaveBeenLastCalledWith('codex', '/t/rollout.jsonl',
      expect.objectContaining({ roots: codexHomeRoots(env.CODEX_HOME).map((home) => join(home, 'sessions')) }))
  })

  it('observed needs-input reaches the dial as turn.activity Waiting for you · Orca', async () => {
    const { core, port } = start({ faults: ['fleet'] })
    // A turn waits on the person (observed.ts takes needs-input only mid-turn).
    port.observed(hook('turn-start'))
    port.observed(hook('needs-input'))
    // turn.started carries the line, and the activity the session reads right after it (its turn.activity) is the same.
    expect(calls('turnStarted')).toEqual([[ID, '', undefined], [ID, 'Waiting for you · Orca', undefined]])
    expect(await host().activityText(ID)).toBe('Waiting for you · Orca')
    expect(await host().activitySnapshot(ID)).toEqual({ text: 'Waiting for you · Orca' })
    port.observed(hook('turn-start'))
    expect(await host().activityText(ID)).toBeNull()
    expect(await host().activitySnapshot(ID)).toBeNull()
    port.observed(hook('turn-error'))
    expect(calls('turnError')).toEqual([[ID, '']])
    expect(core.agents.activityText).not.toHaveBeenCalled()
  })

  // The dial only shows the prompt (docs/specs/2026-11-13-device-claude-orca.md): the line names it and the app to answer in.
  it('asked reaches the dial as the agent waiting with "<summary> · answer in Orca", in place of Waiting for you · Orca', async () => {
    const { core, port } = start({ faults: ['fleet'] })
    port.observed(hook('turn-start'))
    port.observed(hook('needs-input'))
    port.observed(asked())
    // The Notification after it is the same prompt's: nothing more is told.
    port.observed(hook('needs-input'))
    expect(calls('turnStarted')).toEqual([[ID, '', undefined], [ID, 'Waiting for you · Orca', undefined], [ID, 'npm test · answer in Orca', undefined]])
    expect(await host().activityText(ID)).toBe('npm test · answer in Orca')
    expect(await host().activitySnapshot(ID)).toEqual({ text: 'npm test · answer in Orca' })
    // Nothing to answer with.
    expect(await machineList(port)).toMatchObject({ agents: [{ id: ID, caps: 's' }] })
    expect(core.agents.activityText).not.toHaveBeenCalled()
  })

  // The round dial draws an activity line on the working face: the prompt is also the question its asking face draws, for
  // display only (docs/specs/2026-11-13-device-claude-orca.md, "Waiting for permission").
  const shownAs = (q: string) => [{ key: 'prompt', q, options: ['In Orca'] }]
  it('asked also reaches the dial as a question it only shows, ahead of the line, and its wait clearing closes it', async () => {
    vi.useFakeTimers()
    const { core, port } = start({ faults: ['fleet'] })
    port.observed(hook('turn-start'))
    // A Notification alone names no prompt: its line, and no question.
    port.observed(hook('needs-input'))
    expect(calls('question')).toEqual([])
    port.observed(asked())
    port.observed(hook('needs-input'))
    expect(calls('question')).toEqual([[ID, expect.stringMatching(/^shown:[0-9a-f-]{36}$/), shownAs('npm test · answer in Orca')]])
    const [[, first]] = calls('question') as [[string, string]]
    // Asked before its line is told: the round dial goes from the working face straight to the asking one.
    expect(seen.cable.calls.map(([name]) => name)).toEqual(['start', 'turnStarted', 'turnStarted', 'question', 'turnStarted'])
    // A new prompt is a new question, under an id of its own.
    port.observed(asked({ summary: 'npm run build' }))
    expect(calls('questionClose')).toEqual([[ID, first]])
    const [, [, second, questions]] = calls('question') as [unknown, [string, string, unknown]]
    expect(second).not.toBe(first)
    expect(questions).toEqual(shownAs('npm run build · answer in Orca'))
    // The session's next event clears the wait, and the question with it.
    port.observed(hook('turn-stop'))
    await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
    expect(calls('questionClose')).toEqual([[ID, first], [ID, second]])
    // Its session ending clears it too.
    port.observed(hook('turn-start'))
    port.observed(asked())
    const [, , [, third]] = calls('question') as [unknown, unknown, [string, string]]
    port.observed(hook('session-end'))
    expect(calls('questionClose')).toEqual([[ID, first], [ID, second], [ID, third]])
    expect(calls('question')).toHaveLength(3)
    expect(core.questions.answer).not.toHaveBeenCalled()
  })

  it('a dial that attaches again is asked again what still waits, under the same id', async () => {
    vi.useFakeTimers()
    const { port } = start({ faults: ['fleet'] })
    port.observed(hook('turn-start'))
    port.observed(hook('turn-start', { sessionId: 'sess-2' }))
    port.observed(asked())
    port.observed(asked({ sessionId: 'sess-2', summary: 'ls' }))
    port.observed(hook('turn-stop', { sessionId: 'sess-2' }))
    await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
    expect(calls('question')).toHaveLength(2)
    const [[, id]] = calls('question') as [[string, string]]
    // Its drawer and questions live in its RAM: a dial that comes back has neither.
    seen.host.watching!(true)
    expect(calls('question').slice(2)).toEqual([[ID, id, shownAs('npm test · answer in Orca')]])
    seen.host.watching!(false)
    seen.host.watching!(true)
    expect(calls('question').slice(3)).toEqual([[ID, id, shownAs('npm test · answer in Orca')]])
  })

  it('a window opening closes the question; closing, it asks what still waits again', async () => {
    const { port } = start({ faults: ['fleet'] })
    port.observed(hook('turn-start'))
    port.observed(asked())
    expect(calls('question')).toHaveLength(1)
    const [[, id]] = calls('question') as [[string, string]]
    port.swarms({ active: 't1', swarms: [{ id: 't1', name: 'Tab', agentIds: [], panes: 0 }], tiles: [] })
    expect(calls('questionClose')).toEqual([[ID, id]])
    // The window's tab is what the dial shows meanwhile.
    port.observed(asked({ summary: 'ls' }))
    expect(calls('question')).toHaveLength(1)
    port.swarms(null)
    expect(calls('question').slice(1)).toEqual([[ID, expect.stringMatching(/^shown:/), shownAs('ls · answer in Orca')]])
    expect(calls('question')[1][1]).not.toBe(id)
  })

  it('a prompt asked mid-turn, then its Notification: one line, told once', async () => {
    const { port } = start({ faults: ['fleet'] })
    port.observed(hook('turn-start'))
    port.observed(asked())
    port.observed(hook('needs-input'))
    expect(calls('turnStarted')).toEqual([[ID, '', undefined], [ID, 'npm test · answer in Orca', undefined]])
  })

  it('the session\'s next event clears the line; another session\'s does not', async () => {
    vi.useFakeTimers()
    const { port } = start({ faults: ['fleet'] })
    const other = observedAgentId('claude', 'sess-2')
    port.observed(hook('turn-start'))
    port.observed(hook('turn-start', { sessionId: 'sess-2' }))
    port.observed(asked())
    port.observed(hook('turn-stop', { sessionId: 'sess-2' }))
    await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
    expect(await host().activityText(ID)).toBe('npm test · answer in Orca')
    port.observed(hook('turn-stop'))
    await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
    expect(await host().activityText(ID)).toBeNull()
    expect(calls('turnDone')).toEqual([[other], [ID]])
  })

  it('a session no hook listed shows nothing: the plugin\'s hook runs in a Harness pane too', async () => {
    const { port } = start({ core: harnessAgent(), faults: ['fleet'] })
    port.observed(asked({ sessionId: 'in-a-pane' }))
    expect(calls('turnStarted')).toEqual([])
    expect(calls('question')).toEqual([])
    expect((await machineList(port)).agents.map((a) => a.id)).toEqual(['h1'])
  })

  it('what the round dial cannot draw is ?, and a long summary is cut to the dial\'s line with the app kept', async () => {
    const { port } = start({ faults: ['fleet'] })
    port.observed(hook('turn-start', { hostHints: { TERM_PROGRAM: 'ghostty' } }))
    port.observed(asked({ summary: 'echo 你好 🙂' }))
    expect(await host().activityText(ID)).toBe('echo ?? ? · answer in Ghostty')
    port.observed(asked({ summary: 'x'.repeat(200) }))
    const line = (await host().activityText(ID))!
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(99)
    expect(line).toMatch(/^x+… · answer in Ghostty$/)
  })

  it('tells the dial again every 20 s, while one is attached, of an observed agent that waits or works', async () => {
    vi.useFakeTimers()
    // The machine list the reminders are for is this computer's alone.
    const { port } = start({ faults: ['fleet'] })
    const other = observedAgentId('claude', 'sess-2')
    port.observed(hook('turn-start'))
    port.observed(hook('needs-input'))
    port.observed(hook('turn-start', { sessionId: 'sess-2', hostHints: {} }))
    port.observed(hook('session-start', { sessionId: 'sess-3' }))
    expect(calls('turnStarted').slice(1)).toEqual([[ID, 'Waiting for you · Orca', undefined], [other, '', undefined]])
    // No dial: nobody to remind.
    await vi.advanceTimersByTimeAsync(40_000)
    expect(calls('turnStarted')).toHaveLength(3)
    // The dial forgets a turn it hears nothing of for 25 s (firmware ui_prune_stale_busy), and a person can take minutes.
    // Told at once as it attaches, then every 20 s.
    seen.host.watching!(true)
    await vi.waitFor(() => expect(calls('turnStarted').slice(3)).toEqual([[ID, 'Waiting for you · Orca', undefined], [other, '', undefined]]))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(calls('turnStarted').slice(5)).toEqual([[ID, 'Waiting for you · Orca', undefined], [other, '', undefined]])
    port.observed(hook('turn-stop', { sessionId: 'sess-2' }))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(calls('turnStarted').slice(7)).toEqual([[ID, 'Waiting for you · Orca', undefined]])
    seen.host.watching!(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls('turnStarted')).toHaveLength(8)
  })

  it('a dial attaching while an observed agent waits hears turn.started + Waiting for you · Orca before any 20 s tick', async () => {
    const { port } = start({ faults: ['fleet'] })
    port.observed(hook('turn-start'))
    port.observed(hook('needs-input'))
    expect(calls('turnStarted')).toHaveLength(2)
    seen.host.watching!(true)
    await vi.waitFor(() => expect(calls('turnStarted').slice(2)).toEqual([[ID, 'Waiting for you · Orca', undefined]]))
    // The same as a window closes: the machine list it brings back shows the line at once.
    port.swarms({ active: 't1', swarms: [{ id: 't1', name: 'Tab', agentIds: [], panes: 0 }], tiles: [] })
    port.swarms(null)
    await vi.waitFor(() => expect(calls('turnStarted').slice(3)).toEqual([[ID, 'Waiting for you · Orca', undefined]]))
  })

  it('reminds only the observed agents the dial lists, never all fifty', async () => {
    const { port } = start({ faults: ['fleet'] })
    for (let i = 0; i < 18; i++) port.observed(hook('turn-start', { sessionId: `many-${i}` }))
    expect(calls('turnStarted')).toHaveLength(18)
    seen.host.watching!(true)
    const listed = (await machineList(port)).agents.map((a) => a.id)
    expect(listed).toHaveLength(16)
    await vi.waitFor(() => expect(calls('turnStarted').slice(18).map(([id]) => id).sort()).toEqual([...listed].sort()))
  })

  it('with a window open, an observed agent tells the dial nothing: no turn, answer or reminder', async () => {
    vi.useFakeTimers()
    readers.answer.mockResolvedValue('Shipped the fix.')
    const { port } = start({ faults: ['fleet'] })
    // The window's tab is what the dial shows, as before there were agents outside a pane.
    port.swarms({ active: 't1', swarms: [{ id: 't1', name: 'Tab', agentIds: [], panes: 0 }], tiles: [] })
    seen.host.watching!(true)
    port.observed(hook('turn-start'))
    port.observed(hook('needs-input'))
    port.observed(asked())
    await vi.advanceTimersByTimeAsync(40_000)
    port.observed(hook('turn-stop'))
    await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
    port.observed(hook('turn-start'))
    port.observed(hook('turn-error'))
    const told = () => seen.cable.calls.filter(([name]) => ['turnStarted', 'turnDone', 'summary', 'turnError'].includes(name))
    expect(told()).toEqual([])
    // The window closed, the machine list is back and so is what it is told.
    port.swarms(null)
    port.observed(hook('turn-start'))
    expect(told()).toEqual([['turnStarted', [ID, '', undefined]]])
  })

  it('moves a harness agent on the machine list with the cards it is sent, a sub-agent\'s aside', async () => {
    const { port } = start({ core: harnessAgent(), faults: ['fleet'] })
    const states = () => host().harness.list().map((a) => a.state)
    // The harness source learns its rows as the list is read.
    await machineList(port)
    port.card({ type: 'commander_event', agentId: 'h1', payload: { kind: 'processing', text: 'Working' } })
    expect(states()).toEqual(['working'])
    port.card({ type: 'commander_question', agentId: 'h1', payload: { requestId: 'q1', questions: [] } })
    expect(states()).toEqual(['needs-you'])
    port.card({ type: 'commander_question_close', agentId: 'h1', payload: { requestId: 'q1' } })
    expect(states()).toEqual(['working'])
    port.card({ type: 'commander_event', agentId: 'h1', payload: { kind: 'done', subagent: true } })
    expect(states()).toEqual(['working'])
    port.card({ type: 'commander_event', agentId: 'h1', payload: { kind: 'done' } })
    expect(states()).toEqual(['done'])
  })

  it('an observed agent is never sent to the core, a window or the gateway', async () => {
    vi.useFakeTimers()
    readers.answer.mockResolvedValue('Shipped the fix.')
    const core = fakeCore({ dataDir })
    const { port } = start({ core, faults: ['fleet'] })
    seen.host.watching!(true)
    const fetched = vi.spyOn(globalThis, 'fetch')
    const printed = vi.spyOn(console, 'log')
    for (const event of ['session-start', 'turn-start', 'needs-input'] as const) port.observed(hook(event))
    port.observed(asked({ summary: 'rm -rf /srv/secret-target' }))
    expect(await host().activityText(ID)).toBe('rm -rf /srv/secret-target · answer in Orca')
    // A word that names no agent is weighed among Harness's agents alone: the router never hears of this one.
    vi.mocked(routeVoiceTask).mockResolvedValueOnce({ agentId: '', confidence: 0, reason: 'no agents in machine' } as Awaited<ReturnType<typeof routeVoiceTask>>)
    await host().route('clean up the build', (await host().listAgentSnapshot()).agents)
    expect(vi.mocked(routeVoiceTask).mock.calls.map(([, candidates]) => candidates)).toEqual([[]])
    port.observed(hook('turn-stop'))
    await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
    expect(calls('summary')).toHaveLength(1)
    port.observed(hook('turn-error'))
    expect((await machineList(port)).agents.map((a) => a.id)).toEqual([ID])
    // What the dial's session asks of its host about an agent it holds: for a harness agent, each is a door to the core.
    const w = seen.host
    expect(await w.activityText!(ID)).toBeNull()
    expect(await w.activitySnapshot!(ID)).toBeNull()
    expect(await host().recentSummaries(ID)).toEqual([{ recap: 'Shipped the fix.', text: 'Shipped the fix.', ask: '', fullText: 'Shipped the fix.' }])
    expect(await host().recentAsks(ID)).toEqual([])
    expect(await host().listModels(ID)).toEqual([])
    expect(await host().answerReviewed({ agentId: ID, requestId: 'q1', questions: [], answers: {}, selections: {} })).toMatchObject({ ok: false })
    expect(await host().sendTurn(ID, 'run the tests')).toMatchObject({ ok: false })
    host().stopTurn(ID)
    host().answer(ID, 'q1', { a: 'yes' })
    host().updateAgent(ID, 'opus', 'high')
    expect(host().canSpeakQuestion(ID)).toBe(false)
    // A turn of the dial onto it, a tap on its card or a fork: the router has no machine for it, and asks nobody.
    host().focus(ID)
    host().openAgent(ID)
    expect(await host().forkAgent(ID)).toMatchObject({ ok: false, error: 'AGENT_NOT_FOUND' })
    port.observed(hook('session-end'))

    const carried = (value: unknown): boolean => ['sess-1', ID, '/work/api', 'Shipped the fix.', 'secret-target'].some((s) => JSON.stringify(value).includes(s))
    const leaks: string[] = []
    const walk = (value: unknown, path: string): void => {
      // A lookup in the agents this process holds a copy of (devicesProcess.ts `view`): no message, nothing leaves.
      if (path === 'core.agents.byAgent') return
      if (vi.isMockFunction(value)) { if (carried(value.mock.calls)) leaks.push(path); return }
      if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) walk(inner, `${path}.${key}`)
    }
    walk(core, 'core')
    for (const [name, bridge] of Object.entries(seen.bridges)) if (carried(bridge.calls)) leaks.push(name)
    if (carried(fetched.mock.calls)) leaks.push('fetch')
    if (carried(printed.mock.calls)) leaks.push('console.log')
    if (logs.some((line) => line.includes('secret-target'))) leaks.push('log')
    expect(leaks).toEqual([])
  })

  /** A Harness agent that holds `sess-1`, the session the hooks below are of: its row takes the outside copy's. */
  const holdsSession = () => fakeCore({ dataDir, agents: {
    advertised: vi.fn(() => [{ agentId: 'h1', registeredAt: 1, engine: 'claude', sessionId: 'sess-1' }] as RegisteredSession[]),
    activitySnapshot: vi.fn(async () => null),
  } })

  it('a session a Harness agent holds gets no card, question or reminder as an outside agent', async () => {
    vi.useFakeTimers()
    readers.answer.mockResolvedValue('Shipped the fix.')
    const { port } = start({ core: holdsSession(), faults: ['fleet'] })
    seen.host.watching!(true)
    // The list read binds h1 to its session: the merged list is h1 alone.
    expect((await machineList(port)).agents.map((a) => a.id)).toEqual(['h1'])
    port.observed(hook('turn-start'))
    port.observed(asked())
    // A 20 s reminder of what is mid-turn, then the answer's read once the turn ends.
    await vi.advanceTimersByTimeAsync(20_000)
    port.observed(hook('turn-stop'))
    await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
    const named = seen.cable.calls.filter(([name, [agentId]]) => ['turnStarted', 'question', 'turnDone', 'summary'].includes(name) && agentId === ID)
    expect(named).toEqual([])
  })

  it('the activity of an outside id the merged list hides is not asked of the core', async () => {
    const core = holdsSession()
    const { port } = start({ core, faults: ['fleet'] })
    await machineList(port)
    port.observed(hook('turn-start'))
    expect(await host().activityText(ID)).toBeNull()
    expect(await host().activitySnapshot(ID)).toBeNull()
    expect(core.agents.activityText).not.toHaveBeenCalledWith(ID)
    expect(core.agents.activitySnapshot).not.toHaveBeenCalledWith(ID)
  })

  describe('the app a dial that says appFilter shows (cable/hosts/appFilter.ts)', () => {
    /** A Claude Code session in an app, its hook naming the app as the terminal's own variable does. */
    const inApp = (port: DevicesPort, sessionId: string, app: string, event: ObservedHookEvent['event'] = 'session-start') =>
      port.observed(hook(event, { sessionId, hostHints: { TERM_PROGRAM: app } }))
    /** Ghostty 2, VS Code 1: Ghostty is shown. */
    const twoApps = async (port: DevicesPort) => {
      inApp(port, 'g-1', 'ghostty')
      inApp(port, 'g-2', 'ghostty')
      inApp(port, 'v-1', 'vscode')
      expect((await appList(port))?.shown).toBe('ghostty')
    }
    /** The list a dial that says appFilter reads with no window. */
    const appList = async (port: DevicesPort) => { port.swarms(null); return (await host().listAgentSnapshot({ apps: true })).apps }
    const switches = () => logs.filter((line) => line.includes('app filter: switched'))

    it('a switch logs "[device] app filter: switched · pick" and no app id or name', async () => {
      const { port } = start({ faults: ['fleet'] })
      await twoApps(port)
      expect(host().pickApp('vscode')).toBe('switched')
      await vi.waitFor(() => expect(switches()).toEqual(['[device] app filter: switched · pick']))
      // The whole log: which app is shown is never written down.
      expect(logs.filter((line) => /vscode|VS Code|ghostty|Ghostty/.test(line))).toEqual([])
    })

    it('a switch pushes the list to the dials at once', async () => {
      const { port } = start({ faults: ['fleet'] })
      await twoApps(port)
      const pushed = calls('syncAgents').length
      host().pickApp('vscode')
      // Every dial here, not the picking one alone: a pick on one turns every dial that says appFilter.
      await vi.waitFor(() => expect(calls('syncAgents').slice(pushed)).toEqual([[]]))
    })

    it('after a switch each mid-turn agent of the new ring is told again', async () => {
      const { port } = start({ faults: ['fleet'] })
      // Sixteen in Orca fill the one ring an older dial holds; the two in Ghostty, come later, are only in Ghostty's.
      const orca = Array.from({ length: 16 }, (_, i) => { port.observed(hook('turn-start', { sessionId: `o-${i}` })); return observedAgentId('claude', `o-${i}`) })
      await machineList(port)
      inApp(port, 'g-1', 'ghostty', 'turn-start')
      inApp(port, 'g-2', 'ghostty', 'turn-start')
      const ghostty = [observedAgentId('claude', 'g-1'), observedAgentId('claude', 'g-2')]
      expect((await machineList(port)).agents.map((a) => a.id)).toEqual(orca)
      expect((await appList(port))?.shown).toBe('orca')
      const told = calls('turnStarted').length
      host().pickApp('ghostty')
      // The dial was just turned to a ring whose agents it has heard nothing of: each is told its turn, as are the others.
      await vi.waitFor(() => expect(calls('turnStarted').slice(told).map(([id]) => id).sort()).toEqual([...orca, ...ghostty].sort()))
    })

    it('the picker\'s use is one log line with no app in it', async () => {
      const { port } = start({ faults: ['fleet'] })
      await twoApps(port)
      // Done on the app shown, a tap on another, one whose agents ended under the finger: each a use of the picker.
      expect([host().pickApp('ghostty'), host().pickApp('vscode'), host().pickApp('cursor')]).toEqual(['same', 'switched', 'ignored'])
      // A tapped notice turning the dial is no use of the picker.
      host().pickApp('ghostty', 'notice')
      expect(logs.filter((line) => line.includes('app filter: picker'))).toEqual(Array(3).fill('[device] app filter: picker'))
    })

    it('the settle timer is guarded: a filter that throws is logged and the devices keep running', async () => {
      vi.useFakeTimers()
      const { port } = start({ faults: ['fleet'] })
      await twoApps(port)
      vi.spyOn(AppRings.prototype, 'counts').mockImplementationOnce(() => { throw new Error('rings unreadable') })
      host().front('vscode')
      await vi.advanceTimersByTimeAsync(FRONT_SETTLE_MS)
      expect(logs).toContain('[devices] dial failed · rings unreadable')
      // The next app in front settles as before.
      host().front('ghostty')
      host().front('vscode')
      await vi.advanceTimersByTimeAsync(FRONT_SETTLE_MS)
      expect(switches()).toEqual(['[device] app filter: switched · front'])
    })

    it('the timer is cancelled when the service stops', async () => {
      vi.useFakeTimers()
      const { port } = start({ faults: ['fleet'] })
      await twoApps(port)
      const timers = vi.getTimerCount()
      host().front('vscode')
      expect(vi.getTimerCount()).toBe(timers + 1)
      await port.stop()
      expect(vi.getTimerCount()).toBe(0)
    })

    it('with no listen given (the devices inside the core\'s process) nothing is opened, and a pick still turns the dial', async () => {
      // As core/main.ts starts the devices in the core's own process (HARNESSD_SERVICES=none, Harness OS): no listen.
      const ports = emptyPorts()
      createServiceHost(ports, { log: () => {} }).start('devices', (core, started) => startDevices(core, started, {
        logsDir: join(dataDir, 'logs'), cableDisabled: true, faults: new Set(['fleet']), log: (line) => { logs.push(line) }, onExit: vi.fn(), orca, orcaReads: inertOrcaReads, codex,
      }), fakeCore({ dataDir }), DEVICES_FALLBACKS, DEVICES_REQUESTS)
      const port = ports.devices!
      await twoApps(port)
      expect(host().pickApp('vscode')).toBe('switched')
      expect((await appList(port))?.shown).toBe('vscode')
      const socket = devicesListenerPath(dataDir)
      expect(socket !== null && existsSync(socket)).toBe(false)
      expect(logs.filter((line) => line.includes('listener'))).toEqual([])
      await port.stop()
    })

    it('a front through the listener\'s handler becomes the shown app 1 s later, and the dial is pushed apps', async () => {
      vi.useFakeTimers()
      const listener = fakeListener()
      const { port } = start({ faults: ['fleet'], listen: listener.listen })
      await twoApps(port)
      const pushed = calls('syncAgents').length
      // Taken: the listener answers 204.
      expect(listener.front('vscode')).toBeUndefined()
      await vi.advanceTimersByTimeAsync(FRONT_SETTLE_MS - 1)
      expect(calls('syncAgents')).toHaveLength(pushed)
      expect((await host().listAgentSnapshot({ apps: true })).apps?.shown).toBe('ghostty')
      await vi.advanceTimersByTimeAsync(1)
      // Every dial is pushed the list, and a dial that says appFilter its apps with it.
      expect(calls('syncAgents')).toHaveLength(pushed + 1)
      expect((await host().listAgentSnapshot({ apps: true })).apps?.shown).toBe('vscode')
      expect(switches()).toEqual(['[device] app filter: switched · front'])
    })

    it('a front through the handler with a window open turns a dial that says appFilter to the app, and leaves an older dial its tab', async () => {
      vi.useFakeTimers()
      const listener = fakeListener()
      const { port } = start({ faults: ['fleet'], listen: listener.listen })
      await twoApps(port)
      port.swarms({ active: 't1', swarms: [], tiles: [] })
      const tab = await host().listAgentSnapshot()
      listener.front('vscode')
      await vi.advanceTimersByTimeAsync(FRONT_SETTLE_MS)
      expect(await host().listAgentSnapshot({ apps: true })).toMatchObject({ view: 'machine', apps: { shown: 'vscode' } })
      expect(await host().listAgentSnapshot()).toEqual(tab)
    })

    it('across a run with fronts through the handler, nothing but the dial\'s own frames holds the app in front', async () => {
      vi.useFakeTimers()
      const core = fakeCore({ dataDir })
      const listener = fakeListener()
      // The fleet running: what goes to the owner's other machines is read too.
      const { port } = start({ core, listen: listener.listen })
      // A fleet of this computer alone, with no Harness agent on it.
      seen.fleet!.answers = { listAgentsFlat: async () => [], activityTimes: async () => new Map(), agentTotal: () => 0 }
      seen.host.watching!(true)
      const fetched = vi.spyOn(globalThis, 'fetch')
      const printed = vi.spyOn(console, 'log')
      await twoApps(port)
      for (const app of ['ghostty', 'none', 'vscode']) {
        expect(listener.front(app)).toBeUndefined()
        await vi.advanceTimersByTimeAsync(FRONT_SETTLE_MS)
      }
      // The dial's own frame: the list it picks from names the app shown.
      expect((await host().listAgentSnapshot({ apps: true })).apps).toMatchObject({ shown: 'vscode', apps: expect.arrayContaining([expect.objectContaining({ id: 'vscode', name: 'VS Code' })]) })

      // Every call the devices made on the core's API (the windows and the gateway's lane among them), the window bridges,
      // the fleet, the backend and the console.
      const made: unknown[][] = []
      const walk = (value: unknown): void => {
        if (vi.isMockFunction(value)) { made.push(...value.mock.calls); return }
        if (value && typeof value === 'object') for (const inner of Object.values(value)) walk(inner)
      }
      walk(core)
      for (const bridge of Object.values(seen.bridges)) made.push(...bridge.calls.map(([, args]) => args))
      made.push(...seen.fleet!.calls.map(([, args]) => args), ...fetched.mock.calls, ...printed.mock.calls)
      expect(made.length).toBeGreaterThan(0)
      const front = /ghostty|vscode|VS Code/i
      expect(made.filter((args) => front.test(JSON.stringify(args)))).toEqual([])
      expect(made.filter((args) => args.includes('none'))).toEqual([])
      expect(logs.filter((line) => front.test(line))).toEqual([])
    })

    it('a cable host that throws on a front is logged as the dial\'s failure, and the handler returns as taken', async () => {
      const listener = fakeListener()
      start({ faults: ['fleet'], listen: listener.listen })
      vi.spyOn(host(), 'front').mockImplementation(() => { throw new Error('rings unreadable') })
      expect(listener.front('vscode')).toBeUndefined()
      expect(logs).toContain('[devices] dial failed · rings unreadable')
    })

    it('an app that empties as a dial reads the list is pushed after that read, never from inside it', async () => {
      const { port } = start({ faults: ['fleet'] })
      await twoApps(port)
      host().pickApp('vscode')
      // VS Code's one session resumed in Ghostty: the next read finds the app shown empty, and shows another.
      inApp(port, 'v-1', 'ghostty')
      await vi.waitFor(() => expect(switches()).toHaveLength(1))
      const pushed = calls('syncAgents').length
      const shown = AppFilter.prototype.shown
      const insideRead: number[] = []
      vi.spyOn(AppFilter.prototype, 'shown').mockImplementation(function (this: AppFilter) {
        const app = shown.call(this)
        insideRead.push(calls('syncAgents').length - pushed)
        return app
      })
      expect((await host().listAgentSnapshot({ apps: true })).apps?.shown).toBe('ghostty')
      expect(insideRead).toEqual([0])
      await vi.waitFor(() => expect(switches()).toEqual(['[device] app filter: switched · pick', '[device] app filter: switched · empty']))
      await vi.waitFor(() => expect(calls('syncAgents').length - pushed).toBe(1))
    })

    it('with only an older dial attached, the reminder reads the one ring: an app that empties switches nothing', async () => {
      vi.useFakeTimers()
      const { port } = start({ faults: ['fleet'] })
      await twoApps(port)
      expect(host().pickApp('vscode')).toBe('switched')
      // A dial that never said appFilter shows no app: nobody reads the shown app's list.
      ;(seen.cable as unknown as { apps: boolean }).apps = false
      seen.host.watching!(true)
      // VS Code's one session resumes in Ghostty, mid-turn: the app shown is empty, and the reminders come.
      inApp(port, 'v-1', 'ghostty', 'turn-start')
      await vi.advanceTimersByTimeAsync(0)
      const pushed = calls('syncAgents').length
      await vi.advanceTimersByTimeAsync(20_000)
      expect(switches()).toEqual(['[device] app filter: switched · pick'])
      expect(calls('syncAgents')).toHaveLength(pushed)
    })

    describe('a pick brings its app (docs/plans/2026-11-16-dial-pick-brings-app-design.md)', () => {
      const mac = { ...orca, platform: 'darwin' as const }
      const brings = () => logs.filter((line) => line.includes('app filter: bring'))
      /** A turn of the event loop: what a pick ran, and logged, is done by then. */
      const settled = () => new Promise((done) => setImmediate(done))

      it('on macOS a pick that switches runs open -b with the picked app\'s bundle once and logs bring · ok, with no app in the log', async () => {
        const { port } = start({ faults: ['fleet'], orca: mac })
        await twoApps(port)
        expect(host().pickApp('vscode')).toBe('switched')
        await vi.waitFor(() => expect(brings()).toEqual(['[device] app filter: bring · ok']))
        expect(orcaRuns).toEqual([['/usr/bin/open', ['-b', 'com.microsoft.VSCode'], 10_000]])
        expect(logs.filter((line) => /vscode|VS Code|ghostty|Ghostty|com\.microsoft/.test(line))).toEqual([])
      })

      it('an open that fails logs bring · failed once and is not run again', async () => {
        const failing = { ...mac, run: async (file: string, args: string[], timeoutMs: number) => { orcaRuns.push([file, args, timeoutMs]); return { code: 1, stdout: '' } } }
        const { port } = start({ faults: ['fleet'], orca: failing })
        await twoApps(port)
        host().pickApp('vscode')
        await vi.waitFor(() => expect(brings()).toEqual(['[device] app filter: bring · failed']))
        await settled()
        expect(orcaRuns).toHaveLength(1)
      })

      it('a pick of the app shown, of an app with no agents, of Other and a notice\'s pick run no open', async () => {
        const { port } = start({ faults: ['fleet'], orca: mac })
        await twoApps(port)
        // A terminal Harness does not know: its agent is on Other's ring, which has no app to bring.
        inApp(port, 'o-1', 'SomeTerm')
        expect(host().pickApp('ghostty')).toBe('same')
        expect(host().pickApp('cursor')).toBe('ignored')
        expect(host().pickApp('terminal')).toBe('switched')
        expect(host().pickApp('vscode', 'notice')).toBe('switched')
        await settled()
        expect(orcaRuns.filter(([, args]) => args[0] === '-b')).toEqual([])
        expect(brings()).toEqual([])
      })

      it.each([
        ['/tmp/e2e/fake-open', '/tmp/e2e/fake-open'],
        ['', '/usr/bin/open'],
        ['fake-open', '/usr/bin/open'],
      ])('HARNESS_OPEN_BIN %j: an absolute path is the file a pick runs; empty and relative run /usr/bin/open', async (bin, file) => {
        vi.stubEnv('HARNESS_OPEN_BIN', bin)
        const { port } = start({ faults: ['fleet'], orca: mac })
        await twoApps(port)
        host().pickApp('vscode')
        await vi.waitFor(() => expect(orcaRuns).toEqual([[file, ['-b', 'com.microsoft.VSCode'], 10_000]]))
      })

      it('off macOS a pick runs nothing', async () => {
        const { port } = start({ faults: ['fleet'] })
        await twoApps(port)
        expect(host().pickApp('vscode')).toBe('switched')
        await settled()
        expect(orcaRuns).toEqual([])
        expect(brings()).toEqual([])
      })
    })

    describe('with a window open (docs/specs/2026-11-15-dial-follow-front-with-window.md)', () => {
      const G1 = observedAgentId('claude', 'g-1')
      const TAB = { active: 't1', swarms: [{ id: 't1', name: 'Tab', agentIds: [], panes: 0 }], tiles: [] }
      const WAITS = 'npm test · answer in Ghostty'
      /** Whether the connected dials say appFilter. */
      const appsSaid = (on: boolean) => { (seen.cable as unknown as { apps: boolean }).apps = on }
      /** Ghostty 2, VS Code 1, a window open on one tab, and `app` settled in front when one is named; `deps` runs what the
       *  devices run. */
      const windowed = async (app?: string, apps = true, deps: DevicesDeps['orca'] = orca) => {
        vi.useFakeTimers()
        const started = start({ faults: ['fleet'], orca: deps })
        appsSaid(apps)
        await twoApps(started.port)
        started.port.swarms(TAB)
        if (app) host().front(app)
        await vi.advanceTimersByTimeAsync(FRONT_SETTLE_MS)
        return started
      }
      const settle = async (app: string) => {
        host().front(app)
        await vi.advanceTimersByTimeAsync(FRONT_SETTLE_MS)
      }
      const views = () => logs.filter((line) => line.includes('app filter: view'))
      /** Ghostty's first session mid-turn, then waiting on its permission prompt. */
      const waits = (port: DevicesPort) => {
        inApp(port, 'g-1', 'ghostty', 'turn-start')
        port.observed(asked({ sessionId: 'g-1' }))
      }

      it('the window opening, an app settling in front and a pick of Harness each log the view with its cause, and no app', async () => {
        await windowed('ghostty')
        expect(host().pickApp('harness')).toBe('tabs')
        expect(views()).toEqual([
          '[device] app filter: view tabs · window',
          '[device] app filter: view apps · front',
          '[device] app filter: view tabs · pick',
        ])
      })

      it('a view change sends the dials their lists once', async () => {
        await windowed()
        expect(calls('viewChanged')).toHaveLength(1)
        await settle('ghostty')
        expect(calls('viewChanged')).toHaveLength(2)
        host().pickApp('harness')
        await vi.advanceTimersByTimeAsync(0)
        expect(calls('viewChanged')).toHaveLength(3)
        // A burst back to Ghostty: the pick of Harness holds through it, and nothing is sent.
        host().front('vscode')
        await settle('ghostty')
        expect(calls('viewChanged')).toHaveLength(3)
      })

      it('on an app\'s ring an outside agent\'s turn, wait and reminder reach the dial, and on the tab none does', async () => {
        const { port } = await windowed('ghostty')
        seen.host.watching!(true)
        await vi.advanceTimersByTimeAsync(0)
        waits(port)
        await vi.advanceTimersByTimeAsync(20_000)
        expect(calls('turnStarted')).toEqual([[G1, '', undefined], [G1, WAITS, undefined], [G1, WAITS, undefined]])
        expect(calls('question')).toEqual([[G1, expect.stringMatching(/^shown:/), [{ key: 'prompt', q: WAITS, options: ['In Ghostty'] }]]])
        await settle('harness')
        const told = { started: calls('turnStarted').length, asked: calls('question').length }
        inApp(port, 'g-2', 'ghostty', 'turn-start')
        port.observed(asked({ sessionId: 'g-2' }))
        await vi.advanceTimersByTimeAsync(20_000)
        expect(calls('turnStarted')).toHaveLength(told.started)
        expect(calls('question')).toHaveLength(told.asked)
      })

      it('turning to an app\'s ring asks what waits and tells each agent mid-turn; turning back closes its question', async () => {
        const { port } = await windowed()
        waits(port)
        expect(calls('question')).toEqual([])
        expect(calls('turnStarted')).toEqual([])
        await settle('ghostty')
        expect(calls('question')).toEqual([[G1, expect.stringMatching(/^shown:/), [{ key: 'prompt', q: WAITS, options: ['In Ghostty'] }]]])
        expect(calls('turnStarted')).toEqual([[G1, WAITS, undefined]])
        const [[, id]] = calls('question') as [[string, string]]
        await settle('harness')
        expect(calls('questionClose')).toEqual([[G1, id]])
      })

      it('with a window and an app\'s ring, a prompt in the app in front asks the dials to follow, and the list a dial that says appFilter reads holds its agent', async () => {
        const { port } = await windowed('ghostty')
        inApp(port, 'g-1', 'ghostty', 'turn-start')
        expect(calls('followLocal')).toEqual([[G1, 'prompt']])
        expect((await host().listAgentSnapshot({ apps: true })).agents.map((a) => a.id)).toContain(G1)
      })

      it('the window closing from the tab reminds, and from an app\'s ring does not again', async () => {
        const { port } = await windowed()
        inApp(port, 'g-1', 'ghostty', 'turn-start')
        expect(calls('turnStarted')).toEqual([])
        port.swarms(null)
        await vi.advanceTimersByTimeAsync(0)
        expect(calls('turnStarted')).toEqual([[G1, '', undefined]])
        port.swarms(TAB)
        // Ghostty's ring: its agent mid-turn is told as the view turns to it, and not again as the window closes.
        await settle('ghostty')
        expect(calls('turnStarted')).toHaveLength(2)
        port.swarms(null)
        await vi.advanceTimersByTimeAsync(0)
        expect(calls('turnStarted')).toHaveLength(2)
      })

      it('with a window open and no dial that says appFilter, an app\'s ring opens nothing', async () => {
        const { port } = await windowed('ghostty', false)
        seen.host.watching!(true)
        waits(port)
        await vi.advanceTimersByTimeAsync(20_000)
        expect(calls('turnStarted')).toEqual([])
        expect(calls('question')).toEqual([])
        port.swarms(null)
        await vi.advanceTimersByTimeAsync(0)
        expect(calls('turnStarted')).toEqual([[G1, WAITS, undefined]])
      })

      it('a dial that says appFilter coming while the view is apps is asked what waits and told each agent mid-turn, and its going closes the question an older dial coming next would be asked', async () => {
        const { port } = await windowed('ghostty', false)
        waits(port)
        await vi.advanceTimersByTimeAsync(0)
        expect(calls('question')).toEqual([])
        expect(calls('turnStarted')).toEqual([])
        appsSaid(true)
        seen.host.watching!(true)
        await vi.advanceTimersByTimeAsync(0)
        expect(calls('question')).toEqual([[G1, expect.stringMatching(/^shown:/), [{ key: 'prompt', q: WAITS, options: ['In Ghostty'] }]]])
        expect(calls('turnStarted')).toEqual([[G1, WAITS, undefined]])
        const [[, id]] = calls('question') as [[string, string]]
        // It goes, the last dial (the fleet tells `watching` for the first dial and the last alone): the gate shuts again.
        appsSaid(false)
        seen.host.watching!(false)
        expect(calls('questionClose')).toEqual([[G1, id]])
        // An older dial comes next: the question is not asked of it again.
        seen.host.watching!(true)
        await vi.advanceTimersByTimeAsync(0)
        expect(calls('question')).toHaveLength(1)
      })

      it('the shown app left as Harness logs "view tabs · empty", sends the dials their lists and closes the outside agents\' questions', async () => {
        const { port } = await windowed('ghostty')
        waits(port)
        const [[, id]] = calls('question') as [[string, string]]
        const changed = calls('viewChanged').length
        vi.spyOn(AppFilter.prototype, 'shown').mockReturnValue('harness')
        await host().listAgentSnapshot({ apps: true })
        await vi.advanceTimersByTimeAsync(0)
        expect(views().at(-1)).toBe('[device] app filter: view tabs · empty')
        expect(calls('viewChanged')).toHaveLength(changed + 1)
        expect(calls('questionClose')).toEqual([[G1, id]])
      })

      it('a Codex session in Harness\'s Codex home takes words through codex queue on Ghostty\'s ring, and after Harness settles its turn is held back while its words still go', async () => {
        const THREAD = '01a1de76-a3b7-7270-b39e-1245893274c1'
        const CODEX = observedAgentId('codex', THREAD)
        const transcriptPath = join(env.CODEX_HOME, 'sessions', '2026', '11', '15', `rollout-2026-11-15T16-07-59-${THREAD}.jsonl`)
        const codexHook = (event: ObservedHookEvent['event']) =>
          hook(event, { engine: 'codex', sessionId: THREAD, transcriptPath, hostHints: { TERM_PROGRAM: 'ghostty' } })
        const { port } = await windowed('ghostty')
        seen.host.watching!(true)
        port.observed(codexHook('session-start'))
        expect(await host().sendTurn(CODEX, 'run the tests')).toEqual({ ok: true })
        expect(codexRuns.map(([, args]) => args)).toEqual([['queue', '--thread', THREAD, '--message=run the tests']])
        await settle('harness')
        port.observed(codexHook('turn-start'))
        await vi.advanceTimersByTimeAsync(20_000)
        expect(calls('turnStarted').filter(([id]) => id === CODEX)).toEqual([])
        // Words spoken on Ghostty's ring, delivered once Harness is in front.
        expect(await host().sendTurn(CODEX, 'and lint')).toEqual({ ok: true })
        expect(codexRuns.map(([, args]) => args).at(-1)).toEqual(['queue', '--thread', THREAD, '--message=and lint'])
      })

      it('with a window open, a pick of Harness on an app\'s ring runs open -b ai.autonomous.harness', async () => {
        await windowed('ghostty', true, { ...orca, platform: 'darwin' })
        expect(host().pickApp('harness')).toBe('tabs')
        await vi.advanceTimersByTimeAsync(0)
        expect(orcaRuns).toEqual([['/usr/bin/open', ['-b', 'ai.autonomous.harness'], 10_000]])
        expect(logs).toContain('[device] app filter: bring · ok')
      })

      it('the window\'s focus is handed to the dials as before', async () => {
        const { port } = await windowed('ghostty')
        port.appFocus('m1', 'a1')
        expect(calls('followApp')).toEqual([['m1', 'a1']])
      })
    })
  })
})

describe('the mod\'s voice and Orca, for agents outside a pane (docs/specs/2026-11-13-device-claude-orca.md)', () => {
  const ID = observedAgentId('claude', 'sess-1')
  const CODEX = observedAgentId('codex', 'cx-1')
  const HANDLE = 'term_0123abcd-0000-4000-8000-0123456789ab'
  const hook = (event: ObservedHookEvent['event'], over: Partial<ObservedHookEvent> = {}): ObservedHookEvent => ({
    engine: 'claude', sessionId: 'sess-1', event, cwd: '/work/api', callerPid: 4242, transcriptPath: '/t/sess-1.jsonl',
    hostHints: { ORCA_AGENT_SESSION_ID: 'orca-1' }, ...over,
  })
  /** The machine list is this computer's alone: no fleet's router stands in for it. */
  const startHere = (over: Parameters<typeof start>[0] = {}) => start({ ...over, faults: ['fleet', ...over.faults ?? []] })
  const host = () => seen.dial as unknown as DaemonCableHost
  /** A dial on the cable, on this computer's agents: no window. */
  const attach = (port: DevicesPort) => { seen.host.watching!(true); port.swarms(null) }
  const listed = async () => (await host().listAgentSnapshot()).agents.map(({ id, name, caps }) => ({ id, name, caps }))
  const said = () => logs.filter((line) => line.startsWith('[device] '))

  // The dial only shows a waiting prompt: the devices take no approval, and no answer from the dial reaches a hook.
  it('the devices take no approval call, and no answer from the dial approves anything for an agent outside a pane', async () => {
    const { core, port } = startHere()
    attach(port)
    port.observed(hook('turn-start'))
    port.observed(hook('needs-input'))
    expect(Object.keys(port).filter((member) => /approval/i.test(member))).toEqual([])
    expect(host().answer(ID, 'approval:r1', { approval: 'Allow' })).toBeUndefined()
    expect(await host().answerReviewed({ agentId: ID, requestId: 'approval:r1', questions: [], answers: { approval: 'Allow' }, selections: {} }))
      .toEqual({ ok: false, error: 'Use the terminal to answer this question.' })
    expect(core.questions.answer).not.toHaveBeenCalled()
    expect(core.questions.answerReviewed).not.toHaveBeenCalled()
    expect(calls('question')).toEqual([])
    expect(await listed()).toEqual([{ id: ID, name: 'api', caps: 's' }])
  })

  it('a core that goes ends its poll with {}', async () => {
    const { port, gone } = startHere()
    attach(port)
    const poll = port.inboxPoll({ pollId: 'p1', sessionId: 'sess-2' })
    // Its calls have already failed to none.
    expect(gone).toHaveLength(1)
    gone.forEach((run) => run())
    expect(await poll).toEqual({})
  })

  it('a held poll takes the transcript for its idle agent, and the agent lists v', async () => {
    vi.useFakeTimers()
    const { port } = startHere()
    port.observed(hook('session-start'))
    attach(port)
    expect(await listed()).toEqual([{ id: ID, name: 'api', caps: 's' }])
    const held = port.inboxPoll({ pollId: 'p1', sessionId: 'sess-1' })
    expect(await listed()).toEqual([{ id: ID, name: 'api', caps: 'sv' }])
    // Held 25 s, then empty: the mod asks again at once.
    await vi.advanceTimersByTimeAsync(25_000)
    expect(await held).toEqual({})
    const next = port.inboxPoll({ pollId: 'p2', sessionId: 'sess-1' })
    expect(await host().sendTurn(ID, 'run the tests')).toEqual({ ok: true })
    expect(await next).toEqual({ text: 'run the tests' })
    expect(said()).toEqual(['[device] voice · mod'])
    expect(orcaRuns).toEqual([])
  })

  it('an agent with an Orca handle lists v and f; its transcript runs orca terminal send, its tap orca terminal switch', async () => {
    const { port } = startHere()
    port.observed(hook('session-start', { engine: 'codex', sessionId: 'cx-1', hostHints: { ORCA_TERMINAL_HANDLE: HANDLE } }))
    attach(port)
    expect(await listed()).toEqual([{ id: CODEX, name: 'api', caps: 'svf' }])
    expect(await host().sendTurn(CODEX, 'run the tests')).toEqual({ ok: true })
    expect(await host().openAgent(CODEX)).toBeUndefined()
    expect(orcaRuns).toEqual([
      ['/opt/orca/bin/orca', ['terminal', 'send', '--terminal', HANDLE, '--text=run the tests', '--enter', '--wait-submit', '5', '--json'], 10_000],
      ['/opt/orca/bin/orca', ['terminal', 'switch', '--terminal', HANDLE, '--json'], 10_000],
    ])
    expect(said()).toEqual(['[device] voice · orca'])
  })

  // On macOS a tap brings the agent's app forward by its bundle id (cable/hosts/open.ts); every run here is recorded.
  const mac = { ...orca, platform: 'darwin' as const }

  it('on macOS an agent in an app with a bundle id lists f, and a tap brings that app forward; a question screen opens nothing', async () => {
    const { port } = startHere({ orca: mac })
    port.observed(hook('session-start', { hostHints: { TERM_PROGRAM: 'WarpTerminal' } }))
    attach(port)
    expect(await listed()).toEqual([{ id: ID, name: 'api', caps: 'sf' }])
    expect(await host().openAgent(ID)).toBeUndefined()
    expect(orcaRuns).toEqual([['/usr/bin/open', ['-b', 'dev.warp.Warp-Stable'], 10_000]])
    expect(await host().openAgent(ID, 'question')).toBeUndefined()
    expect(orcaRuns).toHaveLength(1)
  })

  const caps = async () => (await listed()).map(({ id, caps }) => ({ id, caps }))

  it('on macOS a Harness agent with no window lists f, and its tap starts Harness Desktop', async () => {
    vi.useFakeTimers()
    const core = harnessAgent()
    const { port } = startHere({ core, orca: mac })
    attach(port)
    expect(await caps()).toEqual([{ id: 'h1', caps: 'svfa' }])
    expect(await host().openAgent('h1')).toBeUndefined()
    expect(orcaRuns).toEqual([['/usr/bin/open', ['-b', 'ai.autonomous.harness'], 10_000]])
    const opens = () => vi.mocked(core.clients.sendLocal).mock.calls.map(([frame]) => frame).filter((frame) => frame.type === 'dial_open')
    expect(opens()).toEqual([])
    port.swarms({ active: 't1', swarms: [{ id: 't1', name: 'Tab', agentIds: [], panes: 0 }], tiles: [] })
    expect(opens()).toEqual([{ type: 'dial_open', payload: { machineId: host().localMachine().id, agentId: 'h1' } }])
    // The next tap finds no window in 30 s.
    port.swarms(null)
    await host().openAgent('h1')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(said().filter((line) => line === '[device] open · harness · no window')).toHaveLength(1)
    port.swarms({ active: 't1', swarms: [], tiles: [] })
    expect(opens()).toHaveLength(1)
  })

  it('Harness Desktop that is not installed answers the dial', async () => {
    const { port } = startHere({ core: harnessAgent(), orca: { ...mac, run: async (file, args, timeoutMs) => { orcaRuns.push([file, args, timeoutMs]); return { code: 1, stdout: '' } } } })
    attach(port)
    expect(await caps()).toEqual([{ id: 'h1', caps: 'svfa' }])
    expect(await host().openAgent('h1')).toEqual({ ok: false, error: 'Harness did not open it.' })
  })

  it('off macOS a Harness agent lists no f, and a tap starts nothing', async () => {
    const { port } = startHere({ core: harnessAgent() })
    attach(port)
    expect(await caps()).toEqual([{ id: 'h1', caps: 'sva' }])
    host().openAgent('h1')
    expect(orcaRuns).toEqual([])
  })

  it('a Claude Code in the Claude app opens on its session; a link that fails still brings the app forward, said in one line with no id', async () => {
    const SESSION = 'local_8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'
    const codes = [1]
    const { port } = startHere({ orca: { ...mac, run: async (file, args, timeoutMs) => {
      orcaRuns.push([file, args, timeoutMs])
      return { code: codes.shift() ?? 0, stdout: '' }
    } } })
    port.observed(hook('session-start', { hostHints: { __CFBundleIdentifier: 'com.anthropic.claudefordesktop', CLAUDE_CODE_HOST_SESSION_ID: SESSION } }))
    attach(port)
    expect(await listed()).toEqual([{ id: ID, name: 'api', caps: 'sf' }])
    expect(await host().openAgent(ID)).toBeUndefined()
    const link: [string, string[], number] = ['/usr/bin/open', ['-b', 'com.anthropic.claudefordesktop', `claude://code/continue?session=${SESSION}`], 10_000]
    expect(orcaRuns).toEqual([link, ['/usr/bin/open', ['-b', 'com.anthropic.claudefordesktop'], 10_000]])
    expect(said()).toEqual(['[device] open · claude · fallback'])
    // The link that works brings the app forward itself.
    expect(await host().openAgent(ID)).toBeUndefined()
    expect(orcaRuns.slice(2)).toEqual([link])
    expect(logs.filter((line) => line.includes(SESSION) || line.includes('sess-1'))).toEqual([])
  })

  // A Codex session in the Codex app opens on its thread (docs/plans/2026-11-16-dial-codex-app-design.md).
  const THREAD = '01a1de76-a3b7-7270-b39e-1245893274c1'
  const CX = observedAgentId('codex', THREAD)
  const inApp = { engine: 'codex' as const, sessionId: THREAD, hostHints: { __CFBundleIdentifier: 'com.openai.codex' } }
  const threadLink: [string, string[], number] = ['/usr/bin/open', ['-b', 'com.openai.codex', `codex://threads/${THREAD}`], 10_000]
  const codexForward: [string, string[], number] = ['/usr/bin/open', ['-b', 'com.openai.codex'], 10_000]
  /** macOS, every run recorded, each answering the next of these exit codes, then 0. */
  const exiting = (...codes: number[]) => ({ ...mac, run: async (file: string, args: string[], timeoutMs: number) => {
    orcaRuns.push([file, args, timeoutMs])
    return { code: codes.shift() ?? 0, stdout: '' }
  } })

  it('a Codex session in the Codex app opens on its thread; a link that fails brings the app forward once, in one line with no id', async () => {
    const { port } = startHere({ orca: exiting(1) })
    port.observed(hook('session-start', inApp))
    attach(port)
    expect(await listed()).toEqual([{ id: CX, name: 'api', caps: 'sf' }])
    expect(await host().openAgent(CX)).toBeUndefined()
    expect(orcaRuns).toEqual([threadLink, codexForward])
    expect(said()).toEqual(['[device] open · codex · fallback'])
    // The link that works brings the app forward itself.
    expect(await host().openAgent(CX)).toBeUndefined()
    expect(orcaRuns.slice(2)).toEqual([threadLink])
    expect(logs.filter((line) => line.includes(THREAD))).toEqual([])
  })

  // open.ts is unchanged: a session a hook told of has its bundle, so the opener's own fallback runs open -b once more.
  it('the link and the app both fail: the dial is told so', async () => {
    const { port } = startHere({ orca: exiting(1, 1, 1) })
    port.observed(hook('session-start', inApp))
    attach(port)
    expect(await host().openAgent(CX)).toEqual({ ok: false, error: 'ChatGPT did not open it.' })
    expect(orcaRuns).toEqual([threadLink, codexForward, codexForward])
    expect(said().filter((line) => line === '[device] open · codex · fallback')).toHaveLength(2)
  })

  // A Claude Code session in the VS Code extension's tab opens by the extension's link, sent to VS Code alone
  // (docs/plans/2026-11-17-dial-vscode-follow-design.md).
  const VSCODE = 'com.microsoft.VSCode'
  const UUID = '8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'
  const UUID2 = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f'
  const vscodeLink = (id: string) => `vscode://anthropic.claude-code/open?session=${id}`
  const tabLink = (id: string): [string, string[], number] => ['/usr/bin/open', ['-b', VSCODE, vscodeLink(id)], 10_000]

  it('a session in the VS Code extension\'s tab opens by its link, sent to VS Code alone', async () => {
    const { port } = startHere({ orca: mac })
    port.observed(hook('session-start', { sessionId: UUID, hostHints: { __CFBundleIdentifier: VSCODE, CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' } }))
    attach(port)
    expect(await host().openAgent(observedAgentId('claude', UUID))).toBeUndefined()
    expect(orcaRuns).toEqual([tabLink(UUID)])
  })

  // The end-to-end harness points HARNESS_OPEN_BIN at a fake that opens nothing (e2e/harness/daemon.ts): a link opened by
  // the real `open` would drive the developer's own app.
  it('the Claude app\'s, the Codex app\'s and VS Code\'s links run HARNESS_OPEN_BIN as their open', async () => {
    vi.stubEnv('HARNESS_OPEN_BIN', '/tmp/e2e/fake-open')
    const CLAUDE = 'local_8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'
    const VSCODE_ID = '8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'
    const { port } = startHere({ orca: mac })
    port.observed(hook('session-start', { hostHints: { __CFBundleIdentifier: 'com.anthropic.claudefordesktop', CLAUDE_CODE_HOST_SESSION_ID: CLAUDE } }))
    port.observed(hook('session-start', { sessionId: VSCODE_ID, hostHints: { __CFBundleIdentifier: VSCODE, CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' } }))
    port.observed(hook('session-start', inApp))
    attach(port)
    expect(await host().openAgent(ID)).toBeUndefined()
    expect(await host().openAgent(CX)).toBeUndefined()
    expect(await host().openAgent(observedAgentId('claude', VSCODE_ID))).toBeUndefined()
    expect(orcaRuns).toEqual([
      ['/tmp/e2e/fake-open', ['-b', 'com.anthropic.claudefordesktop', `claude://code/continue?session=${CLAUDE}`], 10_000],
      ['/tmp/e2e/fake-open', ['-b', 'com.openai.codex', `codex://threads/${THREAD}`], 10_000],
      ['/tmp/e2e/fake-open', ['-b', VSCODE, vscodeLink(VSCODE_ID)], 10_000],
    ])
  })

  it('an agent in the person\'s own tmux lists f, and its tap checks the pane\'s process, then switches the person\'s client', async () => {
    readers.processes.mockResolvedValue([{ pid: 4242, ppid: 4000, executable: 'claude' }, { pid: 4000, ppid: 1, executable: 'zsh' }])
    const says = ['4000|work|\n', '9999|work|\n']
    // A Harness terminal used last, and the person's own client.
    const clients = '1794700100|client-501|abcdef0123456789|harness-claude-1790000000000-x\n1794700050|/dev/ttys004||work\n'
    const { port } = startHere({ orca: { ...mac, run: async (file, args, timeoutMs) => {
      orcaRuns.push([file, args, timeoutMs])
      return { code: 0, stdout: args[0] === 'display-message' ? says.shift()! : args[0] === 'list-clients' ? clients : '' }
    } } })
    // Warp is no tab app: no tty is read.
    port.observed(hook('session-start', { hostHints: { TMUX_PANE: '%3', TERM_PROGRAM: 'tmux', __CFBundleIdentifier: 'dev.warp.Warp-Stable' } }))
    attach(port)
    expect(await listed()).toEqual([{ id: ID, name: 'api', caps: 'sf' }])
    expect(await host().openAgent(ID)).toBeUndefined()
    const asked: [string, string[], number] = ['tmux', ['display-message', '-p', '-t', '%3', '#{pane_pid}|#{session_name}|#{@harness_daemon}#{?#{m:/usr/bin/env HARNESS_DAEMON=*,#{pane_start_command}},#{=44:pane_start_command},#{?#{m:harness-*,#{session_name}},#{@harness_daemon},}}'], 10_000]
    const clientsAsked: [string, string[], number] = ['tmux', ['list-clients', '-F', '#{client_activity}|#{client_name}|#{@harness_daemon}|#{session_name}'], 10_000]
    const warp: [string, string[], number] = ['/usr/bin/open', ['-b', 'dev.warp.Warp-Stable'], 10_000]
    expect(orcaRuns).toEqual([asked, clientsAsked, ['tmux', ['switch-client', '-c', '/dev/ttys004', '-t', '%3'], 10_000], warp])
    expect(said()).toEqual([])
    // The pane holds another process now: nothing is listed or switched.
    expect(await host().openAgent(ID)).toBeUndefined()
    expect(orcaRuns.slice(4)).toEqual([asked, warp])
    expect(said()).toEqual(['[device] open · tmux · not its pane'])
  })

  // The order the panes are asked in: a tmux server keeps the environment it started in, so in its pane WezTerm's and
  // Orca's values name the terminal the server began in.
  it('a tap takes herdr\'s pane before tmux\'s, and tmux\'s before WezTerm\'s and Orca\'s', async () => {
    readers.processes.mockResolvedValue([{ pid: 4242, ppid: 4000, executable: 'claude' }, { pid: 4000, ppid: 1, executable: 'zsh' }])
    const { port } = startHere({ orca: { ...mac, run: async (file, args, timeoutMs) => {
      orcaRuns.push([file, args, timeoutMs])
      return { code: 0, stdout: args[0] === 'display-message' ? '4000|work|\n' : args[0] === 'list-clients' ? '1794700050|/dev/ttys004||work\n' : '' }
    } } })
    const around = { WEZTERM_PANE: '7', ORCA_TERMINAL_HANDLE: HANDLE, __CFBundleIdentifier: 'dev.warp.Warp-Stable' }
    port.observed(hook('session-start', { hostHints: { TMUX_PANE: '%3', ...around } }))
    attach(port)
    expect(await host().openAgent(ID)).toBeUndefined()
    expect(orcaRuns.map(([, args]) => args[0])).toEqual(['display-message', 'list-clients', 'switch-client', '-b'])
    orcaRuns.length = 0
    port.observed(hook('session-start', { hostHints: { HERDR_PANE_ID: 'w1:p2', TMUX_PANE: '%3', ...around } }))
    expect(await host().openAgent(ID)).toBeUndefined()
    expect(orcaRuns.map(([, args]) => args.slice(0, 2))).toEqual([['agent', 'focus'], ['-b', 'dev.warp.Warp-Stable']])
  })

  // A swipe that rests on an agent in an Orca terminal shows its pane, and Orca stays where it is.
  const switched: [string, string[], number] = ['/opt/orca/bin/orca', ['terminal', 'switch', '--terminal', HANDLE, '--json'], 10_000]
  /** The Codex agent in an Orca terminal, its dial on the cable. */
  const inOrca = (over: Parameters<typeof start>[0] = {}) => {
    const started = startHere(over)
    started.port.observed(hook('session-start', { engine: 'codex', sessionId: 'cx-1',
      hostHints: { ORCA_AGENT_SESSION_ID: 'orca-1', ORCA_TERMINAL_HANDLE: HANDLE } }))
    attach(started.port)
    return started
  }
  const swiped = (outcome: string) => vi.waitFor(() => expect(said()).toContain(`[device] swipe · ${outcome}`))

  it('a rest on an Orca agent runs orca terminal switch once and no open -b, on macOS too', async () => {
    inOrca({ orca: mac })
    expect(host().swipeSwitches(CODEX)).toBe(true)
    host().swipeEnded(CODEX, 'rest')
    await swiped('ok')
    expect(orcaRuns).toEqual([switched])
    expect(said()).toEqual(['[device] swipe · ok'])
  })

  it('a switch that fails is one line with no handle, and the dial is sent nothing', async () => {
    inOrca({ orca: { ...orca, run: async (file, args, timeoutMs) => { orcaRuns.push([file, args, timeoutMs]); return { code: 1, stdout: '' } } } })
    const sent = seen.cable.calls.length
    host().swipeEnded(CODEX, 'rest')
    await swiped('failed')
    expect(orcaRuns).toEqual([switched])
    expect(said()).toEqual(['[device] swipe · failed'])
    expect(seen.cable.calls).toHaveLength(sent)
  })

  it('a rest while a command runs on that terminal is dropped: busy', async () => {
    let typed = () => {}
    inOrca({ orca: { ...orca, run: (file, args, timeoutMs) => {
      orcaRuns.push([file, args, timeoutMs])
      return new Promise((done) => { typed = () => done({ code: 0, stdout: '' }) })
    } } })
    const words = host().sendTurn(CODEX, 'run the tests')
    await vi.waitFor(() => expect(orcaRuns).toHaveLength(1))
    host().swipeEnded(CODEX, 'rest')
    await swiped('busy')
    expect(orcaRuns).toHaveLength(1)
    typed()
    expect(await words).toEqual({ ok: true })
  })

  // The rest's switch still runs when the tap comes, 0.4 to 1 s after it: the tap is that switch's, not a refusal.
  it('a tap right after a rest opens with the rest\'s switch, on Linux too: no "did not open"', async () => {
    let shown = () => {}
    inOrca({ orca: { ...orca, run: (file, args, timeoutMs) => {
      orcaRuns.push([file, args, timeoutMs])
      return new Promise((done) => { shown = () => done({ code: 0, stdout: '' }) })
    } } })
    host().swipeEnded(CODEX, 'rest')
    await vi.waitFor(() => expect(orcaRuns).toHaveLength(1))
    const tap = host().openAgent(CODEX)
    shown()
    expect(await tap).toBeUndefined()
    await swiped('ok')
    expect(orcaRuns).toEqual([switched])
  })

  it('a superseded rest is counted and runs nothing', () => {
    inOrca()
    host().swipeEnded(CODEX, 'superseded')
    expect(said()).toEqual(['[device] swipe · superseded'])
    expect(orcaRuns).toEqual([])
  })

  it('an agent in the Claude app or WezTerm: a rest runs nothing', async () => {
    const { port } = startHere({ orca: mac })
    port.observed(hook('session-start', { hostHints: { __CFBundleIdentifier: 'com.anthropic.claudefordesktop', CLAUDE_CODE_HOST_SESSION_ID: 'local_1' } }))
    port.observed(hook('session-start', { engine: 'codex', sessionId: 'cx-1', hostHints: { TERM_PROGRAM: 'WezTerm', WEZTERM_PANE: '3' } }))
    attach(port)
    expect(host().swipeSwitches(ID)).toBe(false)
    expect(host().swipeSwitches(CODEX)).toBe(false)
    // The dial asks for no rest on them; one asked all the same shows nothing.
    host().swipeEnded(ID, 'rest')
    host().swipeEnded(CODEX, 'rest')
    await vi.waitFor(() => expect(said()).toEqual(['[device] swipe · failed', '[device] swipe · failed']))
    expect(orcaRuns).toEqual([])
  })

  it('a tap still switches and, on macOS, brings Orca forward', async () => {
    inOrca({ orca: mac })
    expect(await host().openAgent(CODEX)).toBeUndefined()
    expect(orcaRuns).toEqual([switched, ['/usr/bin/open', ['-b', 'com.stablyai.orca'], 10_000]])
  })

  // A swipe that rests on a Claude app agent shows its session there, while that app is in front
  // (docs/specs/2026-11-15-dial-claude-app-follow.md).
  const SESSION = 'local_8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'
  const continued: [string, string[], number] = ['/usr/bin/open', ['-b', 'com.anthropic.claudefordesktop', `claude://code/continue?session=${SESSION}`], 10_000]
  /** Claude Code in the Claude app on macOS, its dial on the cable once the listener opened; `front` tells the devices'
   *  own listener the app in front, as `harness hardware watch` does. */
  const inClaudeApp = async (over: Parameters<typeof start>[0] = {}) => {
    vi.useFakeTimers()
    const listener = fakeListener()
    const started = startHere({ orca: mac, listen: listener.listen, ...over })
    started.port.observed(hook('session-start', { hostHints: { __CFBundleIdentifier: 'com.anthropic.claudefordesktop', CLAUDE_CODE_HOST_SESSION_ID: SESSION } }))
    attach(started.port)
    await vi.waitFor(() => expect(calls('start')).toHaveLength(1))
    const front = (app: string) => { expect(listener.front(app)).toBeUndefined() }
    return { ...started, front }
  }
  it('with the Claude app in front, a rest on a Claude app agent runs one continue link, and no open -b', async () => {
    const { front } = await inClaudeApp()
    front('claude')
    expect(host().swipeSwitches(ID)).toBe(true)
    host().swipeEnded(ID, 'rest')
    await swiped('ok')
    expect(orcaRuns).toEqual([continued])
    expect(said()).toEqual(['[device] swipe · ok'])
  })

  it('the front that counts is the one last reported, not the settled one', async () => {
    const { front } = await inClaudeApp()
    front('orca')
    await vi.advanceTimersByTimeAsync(FRONT_SETTLE_MS)
    front('claude')
    expect(host().settledApp()).toBe('orca')
    expect(host().swipeSwitches(ID)).toBe(true)
    await vi.advanceTimersByTimeAsync(FRONT_SETTLE_MS)
    front('orca')
    expect(host().settledApp()).toBe('claude')
    expect(host().swipeSwitches(ID)).toBe(false)
  })

  it('another app in front, none, or no front known: no rest is asked for', async () => {
    const { front } = await inClaudeApp()
    expect(host().swipeSwitches(ID)).toBe(false)
    for (const app of ['orca', 'none']) {
      front(app)
      expect(host().swipeSwitches(ID)).toBe(false)
    }
  })

  it('a front that changes during the rest runs none', async () => {
    const { front } = await inClaudeApp()
    front('claude')
    expect(host().swipeSwitches(ID)).toBe(true)
    front('orca')
    const sent = seen.cable.calls.length
    host().swipeEnded(ID, 'rest')
    await swiped('failed')
    expect(orcaRuns).toEqual([])
    expect(seen.cable.calls).toHaveLength(sent)
  })

  it('a link still running drops the next for that agent: busy', async () => {
    let shown = () => {}
    const { front } = await inClaudeApp({ orca: { ...mac, run: (file, args, timeoutMs) => {
      orcaRuns.push([file, args, timeoutMs])
      return new Promise((done) => { shown = () => done({ code: 0, stdout: '' }) })
    } } })
    front('claude')
    host().swipeEnded(ID, 'rest')
    await vi.waitFor(() => expect(orcaRuns).toHaveLength(1))
    host().swipeEnded(ID, 'rest')
    await swiped('busy')
    expect(orcaRuns).toEqual([continued])
    shown()
    await swiped('ok')
    expect(said()).toEqual(['[device] swipe · busy', '[device] swipe · ok'])
  })

  it('a link that fails is one line and the dial is sent nothing', async () => {
    const { front } = await inClaudeApp({ orca: { ...mac, run: async (file, args, timeoutMs) => { orcaRuns.push([file, args, timeoutMs]); return { code: 1, stdout: '' } } } })
    front('claude')
    const sent = seen.cable.calls.length
    host().swipeEnded(ID, 'rest')
    await swiped('failed')
    expect(orcaRuns).toEqual([continued])
    expect(said()).toEqual(['[device] swipe · failed'])
    expect(seen.cable.calls).toHaveLength(sent)
  })

  it('on Linux a Claude app agent has no pane', async () => {
    const { front } = await inClaudeApp({ orca })
    front('claude')
    expect(host().swipeSwitches(ID)).toBe(false)
    host().swipeEnded(ID, 'rest')
    await swiped('failed')
    expect(orcaRuns).toEqual([])
  })

  it('no swipe line carries the session', async () => {
    const codes = [0, 1]
    const { front } = await inClaudeApp({ orca: { ...mac, run: async (file, args, timeoutMs) => {
      orcaRuns.push([file, args, timeoutMs])
      return { code: codes.shift() ?? 0, stdout: '' }
    } } })
    front('claude')
    host().swipeEnded(ID, 'rest')
    await swiped('ok')
    host().swipeEnded(ID, 'rest')
    await swiped('failed')
    expect(said()).toEqual(['[device] swipe · ok', '[device] swipe · failed'])
    expect(logs.filter((line) => [SESSION, 'sess-1', ID].some((secret) => line.includes(secret)))).toEqual([])
  })

  /** A Codex session in the Codex app on macOS, as `inClaudeApp` is for the Claude app. */
  const inCodexApp = async (over: Parameters<typeof start>[0] = {}) => {
    vi.useFakeTimers()
    const listener = fakeListener()
    const started = startHere({ orca: mac, listen: listener.listen, ...over })
    started.port.observed(hook('session-start', inApp))
    attach(started.port)
    await vi.waitFor(() => expect(calls('start')).toHaveLength(1))
    const front = (app: string) => { expect(listener.front(app)).toBeUndefined() }
    return { ...started, front }
  }
  it('with the Codex app in front, a rest on a Codex app agent runs one thread link, and no open -b', async () => {
    const { front } = await inCodexApp()
    front('codex')
    expect(host().swipeSwitches(CX)).toBe(true)
    host().swipeEnded(CX, 'rest')
    await swiped('ok')
    expect(orcaRuns).toEqual([threadLink])
    expect(said()).toEqual(['[device] swipe · ok'])
  })

  it('another app in front, none, or no front known: no rest is asked for on a Codex app agent', async () => {
    const { front } = await inCodexApp()
    expect(host().swipeSwitches(CX)).toBe(false)
    for (const app of ['claude', 'orca', 'none']) {
      front(app)
      expect(host().swipeSwitches(CX)).toBe(false)
    }
  })

  it('a rest whose Codex thread link fails stays failed, and brings nothing forward', async () => {
    const { front } = await inCodexApp({ orca: exiting(1) })
    front('codex')
    host().swipeEnded(CX, 'rest')
    await swiped('failed')
    expect(orcaRuns).toEqual([threadLink])
  })

  // A swipe that rests on a Claude Code session in the VS Code extension's tab shows that tab, while VS Code is in front
  // (docs/plans/2026-11-17-dial-vscode-follow-design.md).
  const V1 = observedAgentId('claude', UUID)
  const V2 = observedAgentId('claude', UUID2)
  const extension = { __CFBundleIdentifier: VSCODE, CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }
  /** Two Claude Code sessions in VS Code's extension tabs on macOS, as `inClaudeApp` is for the Claude app. */
  const inVscode = async (over: Parameters<typeof start>[0] = {}) => {
    vi.useFakeTimers()
    const listener = fakeListener()
    const started = startHere({ orca: mac, listen: listener.listen, ...over })
    started.port.observed(hook('session-start', { sessionId: UUID, hostHints: extension }))
    started.port.observed(hook('session-start', { sessionId: UUID2, hostHints: extension }))
    attach(started.port)
    await vi.waitFor(() => expect(calls('start')).toHaveLength(1))
    const front = (app: string) => { expect(listener.front(app)).toBeUndefined() }
    return { ...started, front }
  }
  it('with VS Code in front, a rest on a VS Code extension agent runs one link, sent to VS Code alone', async () => {
    const { front } = await inVscode()
    front('vscode')
    expect(host().swipeSwitches(V1)).toBe(true)
    host().swipeEnded(V1, 'rest')
    await swiped('ok')
    expect(orcaRuns).toEqual([tabLink(UUID)])
    expect(said()).toEqual(['[device] swipe · ok'])
  })

  it('two VS Code extension agents: a rest on each runs its own session\'s link exactly once, never the other\'s', async () => {
    const { front } = await inVscode()
    front('vscode')
    host().swipeEnded(V1, 'rest')
    await swiped('ok')
    host().swipeEnded(V2, 'rest')
    await vi.waitFor(() => expect(said()).toEqual(['[device] swipe · ok', '[device] swipe · ok']))
    expect(orcaRuns).toEqual([tabLink(UUID), tabLink(UUID2)])
  })

  it('another app in front, none, or no front known: no rest is asked for on a VS Code extension agent', async () => {
    const { front } = await inVscode()
    expect(host().swipeSwitches(V1)).toBe(false)
    // Cursor runs the same extension, which says the same word: its front is not VS Code's.
    for (const app of ['claude', 'orca', 'cursor', 'none']) {
      front(app)
      expect(host().swipeSwitches(V1), app).toBe(false)
    }
    // A rest asked all the same shows nothing.
    host().swipeEnded(V1, 'rest')
    await swiped('failed')
    expect(orcaRuns).toEqual([])
  })

  it('a front that changes during the rest runs none on a VS Code extension agent', async () => {
    const { front } = await inVscode()
    front('vscode')
    expect(host().swipeSwitches(V1)).toBe(true)
    front('orca')
    const sent = seen.cable.calls.length
    host().swipeEnded(V1, 'rest')
    await swiped('failed')
    expect(orcaRuns).toEqual([])
    expect(seen.cable.calls).toHaveLength(sent)
  })

  it('a VS Code link still running drops the next rest for that agent: busy', async () => {
    let shown = () => {}
    const { front } = await inVscode({ orca: { ...mac, run: (file, args, timeoutMs) => {
      orcaRuns.push([file, args, timeoutMs])
      return new Promise((done) => { shown = () => done({ code: 0, stdout: '' }) })
    } } })
    front('vscode')
    host().swipeEnded(V1, 'rest')
    await vi.waitFor(() => expect(orcaRuns).toHaveLength(1))
    host().swipeEnded(V1, 'rest')
    await swiped('busy')
    expect(orcaRuns).toEqual([tabLink(UUID)])
    shown()
    await swiped('ok')
    expect(said()).toEqual(['[device] swipe · busy', '[device] swipe · ok'])
  })

  it('a rest whose VS Code link fails stays failed, and brings nothing forward', async () => {
    const { front } = await inVscode({ orca: exiting(1) })
    front('vscode')
    const sent = seen.cable.calls.length
    host().swipeEnded(V1, 'rest')
    await swiped('failed')
    expect(orcaRuns).toEqual([tabLink(UUID)])
    expect(seen.cable.calls).toHaveLength(sent)
  })

  it('a session in VS Code\'s integrated terminal has no rest, with VS Code in front', async () => {
    const TERMINAL = '7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b'
    const { port, front } = await inVscode()
    port.observed(hook('session-start', { sessionId: TERMINAL, hostHints: { TERM_PROGRAM: 'vscode', __CFBundleIdentifier: VSCODE } }))
    front('vscode')
    expect(host().swipeSwitches(observedAgentId('claude', TERMINAL))).toBe(false)
    host().swipeEnded(observedAgentId('claude', TERMINAL), 'rest')
    await swiped('failed')
    expect(orcaRuns).toEqual([])
  })

  it('on Linux a VS Code extension agent has no rest', async () => {
    const { front } = await inVscode({ orca })
    front('vscode')
    expect(host().swipeSwitches(V1)).toBe(false)
    host().swipeEnded(V1, 'rest')
    await swiped('failed')
    expect(orcaRuns).toEqual([])
  })

  it('no swipe line carries the VS Code session, the link or the bundle', async () => {
    const { front } = await inVscode({ orca: exiting(0, 1) })
    front('vscode')
    host().swipeEnded(V1, 'rest')
    await swiped('ok')
    host().swipeEnded(V1, 'rest')
    await swiped('failed')
    expect(said()).toEqual(['[device] swipe · ok', '[device] swipe · failed'])
    expect(logs.filter((line) => [UUID, V1, 'vscode://', VSCODE].some((secret) => line.includes(secret)))).toEqual([])
  })

  // An agent in VS Code's integrated terminal is shown by Harness's own extension, in the window that reports its shell,
  // matched by the process tree (docs/plans/2026-11-17-dial-vscode-extension-design.md, §2 and §3).
  const WINDOW_ID = 'window-1'
  /** The shell VS Code started for the terminal: the hook's caller, 4242, runs under it. */
  const SHELL = 4000
  const TERMINAL_TREE = [{ pid: 4242, ppid: SHELL }, { pid: SHELL, ppid: 1 }]
  /** Claude Code in a VS Code terminal, its dial on the cable once the listener opened; on macOS its hook carries VS Code's
   *  bundle id too. */
  const inVscodeTerminal = async (over: Parameters<typeof start>[0] = {}) => {
    vi.useFakeTimers()
    processTable.rows = TERMINAL_TREE
    const listener = fakeListener()
    const started = startHere({ listen: listener.listen, ...over })
    const bundle: Record<string, string> = over.orca?.platform === 'darwin' ? { __CFBundleIdentifier: VSCODE } : {}
    started.port.observed(hook('session-start', { hostHints: { TERM_PROGRAM: 'vscode', ...bundle } }))
    attach(started.port)
    await vi.waitFor(() => expect(calls('start')).toHaveLength(1))
    const front = (app: string) => { expect(listener.front(app)).toBeUndefined() }
    /** The window opens and reports the agent's shell: once the table is read, the dials are told to look. */
    const reported = async () => {
      const window = listener.vscode(WINDOW_ID)
      const looks = calls('syncAgents').length
      expect(listener.vscodeState(WINDOW_ID, [SHELL])).toBeUndefined()
      await vi.waitFor(() => expect(calls('syncAgents')).toHaveLength(looks + 1))
      return window
    }
    return { ...started, front, reported }
  }

  it('an agent in VS Code\'s terminal gets its terminal once its window reports the shell, and the dials are told to look', async () => {
    const { reported } = await inVscodeTerminal()
    expect(await caps()).toEqual([{ id: ID, caps: 's' }])
    await reported()
    expect(processTable.reads).toBe(1)
    expect(await caps()).toEqual([{ id: ID, caps: 'sf' }])
  })

  it('a tap writes the show to its window, asking it to raise that window, then brings VS Code forward', async () => {
    const { reported } = await inVscodeTerminal({ orca: mac })
    const window = await reported()
    expect(await host().openAgent(ID)).toBeUndefined()
    expect(window.lines).toEqual([{ show: SHELL, raise: true }])
    // The adapter's own `open -b`, after the show: the opener runs none of its own, and falls back to none.
    expect(orcaRuns).toEqual([['/usr/bin/open', ['-b', VSCODE], 10_000]])
    expect(said()).toEqual([])
  })

  it('a rest shows the terminal only while VS Code is in front', async () => {
    const { reported, front } = await inVscodeTerminal({ orca: mac })
    const window = await reported()
    front('vscode')
    expect(host().swipeSwitches(ID)).toBe(true)
    host().swipeEnded(ID, 'rest')
    await swiped('ok')
    expect(window.lines).toEqual([{ show: SHELL }])
    expect(orcaRuns).toEqual([])
    front('ghostty')
    expect(host().swipeSwitches(ID)).toBe(false)
  })

  it('an agent that left has its chain dropped', async () => {
    const { port, reported } = await inVscodeTerminal()
    await reported()
    expect(processTable.reads).toBe(1)
    port.observed(hook('session-end', { hostHints: { TERM_PROGRAM: 'vscode' } }))
    // Listed again under the same pid, which may be another process by now: its chain is read anew.
    port.observed(hook('session-start', { hostHints: { TERM_PROGRAM: 'vscode' } }))
    await vi.waitFor(() => expect(processTable.reads).toBe(2))
  })

  it('with no listener (the services inside the core) no process table is read', async () => {
    processTable.rows = TERMINAL_TREE
    const { port } = startHere()
    port.observed(hook('session-start', { hostHints: { TERM_PROGRAM: 'vscode' } }))
    attach(port)
    expect(await caps()).toEqual([{ id: ID, caps: 's' }])
    expect(processTable.reads).toBe(0)
  })

  it('a throw on the VS Code path costs the dial nothing', async () => {
    const { port } = startHere({ faults: ['vscode'] })
    port.observed(hook('session-start', { hostHints: { TERM_PROGRAM: 'vscode' } }))
    attach(port)
    expect(await listed()).toEqual([{ id: ID, name: 'api', caps: 's' }])
    expect(logs).toContain('[devices] vscode failed · injected fault: vscode')
  })

  // The dial's scroll scrolls that terminal, line by line, while VS Code is in front and the dial shows its agent
  // (docs/plans/2026-11-17-dial-vscode-extension-design.md, §4).
  const DIAL = {}
  /** The agent the dial shows, as its cable session tells the host; null for none. */
  const shows = (agentId: string | null) => host().dialShows(DIAL, agentId ? { name: 'api', app: 'VS Code' } : null, agentId)
  /** A finger on the glass: a down, its moves, and an up that leaves at that velocity. */
  const stroke = (moves: number[], velocity = 0) => {
    host().scrolled('down', 0, 0)
    for (const dy of moves) host().scrolled('move', dy, 0)
    host().scrolled('up', 0, velocity)
  }
  const dialScrolls = (core: CoreApi) => vi.mocked(core.clients.sendLocal).mock.calls.map(([frame]) => frame)
    .filter(({ type }) => type === 'dial_scroll')
  const toWindows = (phase: string, dy: number, velocity: number) => ({ type: 'dial_scroll', payload: { phase, dy, velocity } })

  it('with VS Code in front and the dial on an agent whose terminal a window holds, a stroke\'s lines go to that window and the windows hear no dial_scroll', async () => {
    const { core, reported, front } = await inVscodeTerminal()
    const window = await reported()
    front('vscode')
    shows(ID)
    // 20 px toward older lines twice (one line each, 8 px kept), then 60 px toward newer: 52 px, three lines.
    stroke([8, 8, -24])
    expect(window.lines).toEqual([{ scroll: -1, pid: SHELL }, { scroll: -1, pid: SHELL }, { scroll: 3, pid: SHELL }])
    expect(dialScrolls(core)).toEqual([])
  })

  it.each<[string, (started: Awaited<ReturnType<typeof inVscodeTerminal>>) => Promise<{ lines: unknown[] } | undefined>]>([
    ['another app in front', async ({ reported, front }) => { const window = await reported(); front('ghostty'); shows(ID); return window }],
    // Its window never reported the shell.
    ['an agent with no terminal', async ({ front }) => { front('vscode'); shows(ID); return undefined }],
    ['a Harness agent', async ({ reported, front }) => { const window = await reported(); front('vscode'); shows('h1'); return window }],
    ['no agent shown', async ({ reported, front }) => { const window = await reported(); front('vscode'); shows(ID); shows(null); return window }],
  ])('with %s the stroke goes to the windows as before, velocity and all', async (_, situation) => {
    const started = await inVscodeTerminal({ core: harnessAgent() })
    const window = await situation(started)
    stroke([8], 300)
    expect(dialScrolls(started.core)).toEqual([toWindows('down', 0, 0), toWindows('move', 8, 0), toWindows('up', 0, 300)])
    expect(window?.lines ?? []).toEqual([])
  })

  it('a stroke keeps the route its down chose: the front changing in its middle moves neither its moves nor its up', async () => {
    const { core, reported, front } = await inVscodeTerminal()
    const window = await reported()
    shows(ID)
    front('vscode')
    host().scrolled('down', 0, 0)
    front('ghostty')
    host().scrolled('move', 8, 0)
    host().scrolled('up', 8, 0)
    expect(window.lines).toEqual([{ scroll: -1, pid: SHELL }, { scroll: -1, pid: SHELL }])
    expect(dialScrolls(core)).toEqual([])
    host().scrolled('down', 0, 0)
    front('vscode')
    host().scrolled('move', 8, 0)
    host().scrolled('up', 0, 120)
    expect(dialScrolls(core)).toEqual([toWindows('down', 0, 0), toWindows('move', 8, 0), toWindows('up', 0, 120)])
    expect(window.lines).toHaveLength(2)
    // The up ended that stroke: a move with no down before it chooses by the front it finds.
    host().scrolled('move', 8, 0)
    expect(window.lines).toEqual([{ scroll: -1, pid: SHELL }, { scroll: -1, pid: SHELL }, { scroll: -1, pid: SHELL }])
  })

  it('a fling is not played: an up with a velocity writes its own travel and no more', async () => {
    const { core, reported, front } = await inVscodeTerminal()
    const window = await reported()
    front('vscode')
    shows(ID)
    host().scrolled('down', 0, 0)
    host().scrolled('up', 8, 900)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(window.lines).toEqual([{ scroll: -1, pid: SHELL }])
    expect(dialScrolls(core)).toEqual([])
  })

  it('a stroke whose window went writes nothing and never turns to the windows mid-stroke', async () => {
    const { core, reported, front } = await inVscodeTerminal()
    const window = await reported()
    front('vscode')
    shows(ID)
    host().scrolled('down', 0, 0)
    host().scrolled('move', 8, 0)
    window.end('gone')
    host().scrolled('move', 8, 0)
    host().scrolled('up', 8, 300)
    expect(window.lines).toEqual([{ scroll: -1, pid: SHELL }])
    expect(dialScrolls(core)).toEqual([])
  })

  it('a throw on the scroll path is the part\'s, not the dial\'s', async () => {
    const { reported, front } = await inVscodeTerminal()
    const window = await reported()
    front('vscode')
    shows(ID)
    window.break()
    expect(() => host().scrolled('move', 8, 0)).not.toThrow()
    expect(logs).toContain('[devices] dial failed · write broken')
  })

  it('no swipe line carries a handle, a session or an agent', async () => {
    const codes = [0, 1]
    inOrca({ orca: { ...orca, run: async (file, args, timeoutMs) => { orcaRuns.push([file, args, timeoutMs]); return { code: codes.shift() ?? 0, stdout: '' } } } })
    host().swipeEnded(CODEX, 'rest')
    await swiped('ok')
    host().swipeEnded(CODEX, 'rest')
    await swiped('failed')
    host().swipeEnded(CODEX, 'superseded')
    expect(said()).toEqual(['[device] swipe · ok', '[device] swipe · failed', '[device] swipe · superseded'])
    expect(logs.filter((line) => [HANDLE, 'orca-1', 'cx-1', CODEX].some((secret) => line.includes(secret)))).toEqual([])
  })

  // A swipe that rests on an agent in Terminal, iTerm2 or Ghostty selects its tab, on the stream a watch holds open
  // (docs/specs/2026-11-15-dial-terminal-follow.md, "1. A swipe selects the agent's tab").
  const TTY = '/dev/ttys023'
  /** The Claude Code agent in a Terminal tab, on macOS, its dial on the cable and its tty read. */
  const inTab = async (over: Parameters<typeof start>[0] = {}, hostHints: Record<string, string> = {}) => {
    const listener = fakeListener()
    const tty = vi.fn(async (_pid: number): Promise<string | undefined> => TTY)
    const started = startHere({ orca: mac, listen: listener.listen, tty, ...over })
    started.port.observed(hook('session-start', { hostHints: { __CFBundleIdentifier: 'com.apple.Terminal', ...hostHints } }))
    attach(started.port)
    // The source took each answer before this await resumes: its own was waiting on the same promise first.
    await Promise.all(tty.mock.results.map(({ value }) => value))
    return { ...started, listener, tty }
  }

  it('a rest on an agent in Terminal writes one select on the stream, and runs no orca and no open', async () => {
    const { listener, tty } = await inTab()
    const stream = listener.tabs()
    expect(host().swipeSwitches(ID)).toBe(true)
    host().swipeEnded(ID, 'rest')
    await swiped('ok')
    expect(stream.lines).toStrictEqual([{ app: 'terminal-app', tty: TTY }])
    expect(tty.mock.calls).toEqual([[4242]])
    expect(orcaRuns).toEqual([])
    expect(said()).toEqual(['[device] swipe · ok'])
  })

  it('with no stream open a turn starts no rest', async () => {
    const { listener } = await inTab()
    expect(host().swipeSwitches(ID)).toBe(false)
    listener.tabs()
    expect(host().swipeSwitches(ID)).toBe(true)
  })

  it('a stream that ended since the turn is failed, and so is a line it does not take', async () => {
    const { listener } = await inTab()
    const ended = listener.tabs()
    expect(host().swipeSwitches(ID)).toBe(true)
    ended.end()
    host().swipeEnded(ID, 'rest')
    await swiped('failed')
    // A newer watch's stream, its last line not drained yet.
    const draining = listener.tabs()
    draining.takes = false
    host().swipeEnded(ID, 'rest')
    await vi.waitFor(() => expect(said()).toEqual(['[device] swipe · failed', '[device] swipe · failed']))
    expect([...ended.lines, ...draining.lines]).toEqual([])
  })

  it('off macOS no agent has a tab, and its tty is never read', async () => {
    const { listener, tty } = await inTab({ orca })
    listener.tabs()
    expect(host().swipeSwitches(ID)).toBe(false)
    expect(tty).not.toHaveBeenCalled()
  })

  it('with no listen given no agent has a tab', async () => {
    const { tty } = await inTab({ listen: undefined })
    expect(tty.mock.calls).toEqual([[4242]])
    expect(host().swipeSwitches(ID)).toBe(false)
  })

  it('a tap runs open -b, then writes the select with raise:true', async () => {
    let exited = (_code: number) => {}
    const { listener } = await inTab({ orca: { ...mac, run: (file, args, timeoutMs) => {
      orcaRuns.push([file, args, timeoutMs])
      return new Promise((done) => { exited = (code) => done({ code, stdout: '' }) })
    } } })
    const stream = listener.tabs()
    const tap = host().openAgent(ID)
    await vi.waitFor(() => expect(orcaRuns).toEqual([['/usr/bin/open', ['-b', 'com.apple.Terminal'], 10_000]]))
    expect(stream.lines).toEqual([])
    exited(0)
    expect(await tap).toBeUndefined()
    expect(stream.lines).toStrictEqual([{ app: 'terminal-app', tty: TTY, raise: true }])
    expect(said()).toEqual([])
  })

  it('a tap whose open -b fails writes no select', async () => {
    const { listener } = await inTab({ orca: { ...mac, run: async (file, args, timeoutMs) => { orcaRuns.push([file, args, timeoutMs]); return { code: 1, stdout: '' } } } })
    const stream = listener.tabs()
    expect(await host().openAgent(ID)).toEqual({ ok: false, error: 'Terminal did not open it.' })
    expect(orcaRuns).toEqual([['/usr/bin/open', ['-b', 'com.apple.Terminal'], 10_000]])
    expect(stream.lines).toEqual([])
  })

  it('no swipe line carries a tty', async () => {
    const { listener } = await inTab()
    const stream = listener.tabs()
    host().swipeEnded(ID, 'rest')
    await swiped('ok')
    stream.end()
    host().swipeEnded(ID, 'rest')
    await swiped('failed')
    await host().openAgent(ID)
    expect(said()).toEqual(['[device] swipe · ok', '[device] swipe · failed'])
    expect(logs.filter((line) => /ttys|4242/.test(line))).toEqual([])
  })

  // An agent may have a pane in more than one app: each verb takes the first in the devices' fixed order (herdr, WezTerm,
  // Orca, the Claude app, tabs), wired here as in production.
  it('a tap on an agent with a WezTerm pane and an Orca handle activates the WezTerm pane, then brings WezTerm forward', async () => {
    const { port } = startHere({ orca: { ...mac, onPath: (name: string) => `/opt/${name}/bin/${name}` } })
    port.observed(hook('session-start', { engine: 'codex', sessionId: 'cx-1',
      hostHints: { TERM_PROGRAM: 'WezTerm', WEZTERM_PANE: '7', ORCA_TERMINAL_HANDLE: HANDLE } }))
    attach(port)
    expect(await host().openAgent(CODEX)).toBeUndefined()
    expect(orcaRuns).toEqual([
      ['/opt/wezterm/bin/wezterm', ['cli', 'activate-pane', '--pane-id', '7'], 10_000],
      ['/usr/bin/open', ['-b', 'com.github.wez.wezterm'], 10_000],
    ])
  })

  // A tap stays the command on every platform: herdr's socket carries words, never a focus.
  it('a tap on a hooked agent in a herdr pane runs herdr agent focus, then brings its app forward', async () => {
    const { port } = startHere({ orca: { ...mac, onPath: (name: string) => `/opt/${name}/bin/${name}` } })
    port.observed(hook('session-start', { hostHints: { HERDR_PANE_ID: 'w1:p2' } }))
    attach(port)
    expect(await host().openAgent(ID)).toBeUndefined()
    expect(orcaRuns).toEqual([
      ['/opt/herdr/bin/herdr', ['agent', 'focus', 'w1:p2'], 10_000],
      ['/usr/bin/open', ['-b', 'dev.herdr.app'], 10_000],
    ])
    expect(herdrCalls).toEqual([])
  })

  // Orca types into whichever pane herdr has in front, so a multiplexer's agent has no Orca pane (orca.ts): herdr's socket
  // types into the agent's own, while the daemon finds it (one started by launchd or systemd may not have the shell's
  // XDG_CONFIG_HOME), and with none the agent takes no words.
  it('a hooked agent in a herdr pane inside Orca takes the dial\'s words through herdr\'s socket, and none through Orca with no socket', async () => {
    let stamp: string | undefined
    const { port } = startHere({ orca: mac, herdr: { ...herdr, socketStamp: () => stamp } })
    port.observed(hook('turn-stop', { hostHints: { HERDR_PANE_ID: 'w1:p2', ORCA_TERMINAL_HANDLE: HANDLE } }))
    attach(port)
    expect(await listed()).toEqual([{ id: ID, name: 'api', caps: 'sf' }])
    expect(await host().sendTurn(ID, 'run the tests')).toMatchObject({ ok: false, message: 'api did not answer.' })
    expect(said().at(-1)).toBe('[device] voice · no-answer')
    stamp = '1:1'
    expect(await listed()).toEqual([{ id: ID, name: 'api', caps: 'svf' }])
    expect(await host().sendTurn(ID, 'run the tests')).toEqual({ ok: true })
    expect(herdrCalls).toEqual([['prompt', 'w1:p2', 'claude', 'run the tests']])
    expect(orcaRuns).toEqual([])
    expect(said().at(-1)).toBe('[device] voice · herdr')
  })

  it('a rest on an agent with an Orca handle inside Terminal runs the Orca switch, and writes no select', async () => {
    const { listener } = await inTab({}, { ORCA_TERMINAL_HANDLE: HANDLE })
    const stream = listener.tabs()
    expect(host().swipeSwitches(ID)).toBe(true)
    host().swipeEnded(ID, 'rest')
    await swiped('ok')
    expect(orcaRuns).toEqual([switched])
    expect(stream.lines).toEqual([])
  })

  it('no log line or backend request carries the command, a prompt\'s summary, a path, the transcript, a session id or a handle', async () => {
    const { core, port } = startHere()
    port.observed(hook('session-start', { engine: 'codex', sessionId: 'cx-1', hostHints: { ORCA_TERMINAL_HANDLE: HANDLE } }))
    attach(port)
    await host().sendTurn(CODEX, 'run the tests')
    await host().openAgent(CODEX)
    // Working, Codex may show an approval no hook tells of: the words are not typed there, nor while it waits on a prompt.
    port.observed(hook('turn-start', { engine: 'codex', sessionId: 'cx-1', hostHints: { ORCA_TERMINAL_HANDLE: HANDLE } }))
    expect(await host().sendTurn(CODEX, 'run the tests')).toMatchObject({ ok: false, message: 'api is busy. Say it when it is done.' })
    port.observed(hook('needs-input', { engine: 'codex', sessionId: 'cx-1', hostHints: { ORCA_TERMINAL_HANDLE: HANDLE } }))
    expect(await host().sendTurn(CODEX, 'run the tests')).toMatchObject({ ok: false, message: 'api is waiting for your answer in Terminal.' })
    // A Claude Code prompt's summary shows on the dial alone.
    port.observed(hook('turn-start'))
    port.observed({ engine: 'claude', sessionId: 'sess-1', event: 'asked', tool: 'Bash', summary: 'deploy --secret-flag' })
    expect(await host().activityText(observedAgentId('claude', 'sess-1'))).toMatch(/^deploy --secret-flag · answer in /)
    // Each turn's start is counted too (dial-pane-follow): the dial's own, then a person's with no app in front.
    expect(said()).toEqual(['[device] voice · orca', '[device] prompt · skipped · dial prompt', '[device] voice · busy',
      '[device] voice · waiting', '[device] prompt · skipped · not in front'])
    const secrets = ['/work', '/t/', 'run the tests', 'deploy --secret-flag', 'sess-1', 'cx-1', HANDLE]
    expect(logs.filter((line) => secrets.some((secret) => line.includes(secret)))).toEqual([])
    expect(JSON.stringify(vi.mocked(core.account.backend).mock.calls)).not.toMatch(/secret-flag|sess-1|cx-1/)
  })

  it('an inbox part that throws answers { off: true }', async () => {
    const { port } = startHere({ faults: ['inbox.inboxPoll'] })
    attach(port)
    expect(await port.inboxPoll({ pollId: 'p1', sessionId: 'sess-1' })).toEqual({ off: true })
    expect(logs).toEqual(expect.arrayContaining(['[devices] inbox.inboxPoll failed · injected fault: inbox.inboxPoll']))
    // A part that did not start answers the same, and hears nothing.
    const off = startHere({ faults: ['inbox'] })
    attach(off.port)
    expect(await off.port.inboxPoll({ pollId: 'p1', sessionId: 'sess-1' })).toEqual({ off: true })
    off.port.inboxGone('p1')
    expect(logs).toEqual(expect.arrayContaining(['[devices] inbox did not start · injected fault: inbox · the devices run without it']))
  })

  it('an inbox part the guard switches off ends its open poll', async () => {
    const { port } = startHere({ faults: ['inbox.inboxGone'] })
    attach(port)
    const poll = port.inboxPoll({ pollId: 'p1', sessionId: 'sess-2' })
    // Five failures in a minute switch a part off: the gone it swallows would have ended the poll.
    for (let i = 0; i < 5; i++) port.inboxGone('p1')
    expect(logs).toEqual(expect.arrayContaining([expect.stringMatching(/^\[devices\] inbox switched off/)]))
    expect(await poll).toEqual({})
  })

  it('stop ends every poll and timer', async () => {
    vi.useFakeTimers()
    const { port } = startHere()
    const waiting = observedAgentId('claude', 'sess-2')
    port.observed(hook('session-start', { sessionId: 'sess-2' }))
    attach(port)
    const poll = port.inboxPoll({ pollId: 'p1', sessionId: 'sess-1' })
    // A transcript waiting for the mod's next poll, its last one just closed.
    const closed = port.inboxPoll({ pollId: 'p2', sessionId: 'sess-2' })
    port.inboxGone('p2')
    await closed
    const words = host().sendTurn(waiting, 'run the tests')
    await port.stop()
    expect(await poll).toEqual({})
    expect(await words).toMatchObject({ ok: false, message: 'api did not answer.' })
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('codex queue, for Codex outside a pane (docs/specs/2026-11-15-device-codex.md)', () => {
  const THREAD = '01a1de76-a3b7-7270-b39e-1245893274c1'
  const ID = observedAgentId('codex', THREAD)
  const HANDLE = 'term_0123abcd-0000-4000-8000-0123456789ab'
  /** Its rollout, in Harness's own Codex home. */
  const transcriptPath = join(env.CODEX_HOME, 'sessions', '2026', '11', '15', `rollout-2026-11-15T16-07-59-${THREAD}.jsonl`)
  const hook = (event: ObservedHookEvent['event'], over: Partial<ObservedHookEvent> = {}): ObservedHookEvent => ({
    engine: 'codex', sessionId: THREAD, event, cwd: '/work/api', callerPid: 4242, transcriptPath, hostHints: { TERM_PROGRAM: 'ghostty' }, ...over,
  })
  const host = () => seen.dial as unknown as DaemonCableHost
  const listed = async () => (await host().listAgentSnapshot()).agents.map(({ id, name, caps }) => ({ id, name, caps }))
  const said = () => logs.filter((line) => line.startsWith('[device] '))
  /** A codex that ends each run as told, recorded. */
  const ending = (...ends: CodexRunEnd[]): NonNullable<DevicesDeps['codex']> => ({
    ...codex,
    run: async (file, args, options) => { codexRuns.push([file, args, options]); return ends.shift() ?? 0 },
  })
  /** The Codex session, told by its start, and a dial on this computer's agents: no fleet, no window. */
  const started = (over: Parameters<typeof start>[0] = {}, session: Partial<ObservedHookEvent> = {}) => {
    const { port } = start({ ...over, faults: ['fleet'] })
    port.observed(hook('session-start', session))
    seen.host.watching!(true)
    port.swarms(null)
  }

  it('the queue is wired with env.CODEX_HOME and the home directory', async () => {
    started()
    expect(await listed()).toEqual([{ id: ID, name: 'api', caps: 'sv' }])
    expect(await host().sendTurn(ID, 'run the tests')).toEqual({ ok: true })
    expect(codexRuns).toEqual([['/opt/codex/bin/codex', ['queue', '--thread', THREAD, '--message=run the tests'],
      { cwd: homedir(), env: { CODEX_HOME: env.CODEX_HOME }, timeoutMs: 10_000 }]])
    expect(said()).toEqual(['[device] voice · codex'])
    expect(orcaRuns).toEqual([])
  })

  it('a Codex app session\'s words still go through codex queue, and nothing is opened', async () => {
    started({ orca: { ...orca, platform: 'darwin' } }, { hostHints: { __CFBundleIdentifier: 'com.openai.codex' } })
    expect(await host().sendTurn(ID, 'run the tests')).toEqual({ ok: true })
    expect(codexRuns.map(([, args]) => args)).toEqual([['queue', '--thread', THREAD, '--message=run the tests']])
    expect(orcaRuns).toEqual([])
    expect(said()).toEqual(['[device] voice · codex'])
  })

  it('a Codex session whose transcript is in another home lists s and runs nothing', async () => {
    started({}, { transcriptPath: `/elsewhere/.codex/sessions/2026/11/15/rollout-2026-11-15T16-07-59-${THREAD}.jsonl` })
    expect(await listed()).toEqual([{ id: ID, name: 'api', caps: 's' }])
    expect(await host().sendTurn(ID, 'run the tests')).toMatchObject({ ok: false, message: 'api did not answer.' })
    expect(codexRuns).toEqual([])
    expect(orcaRuns).toEqual([])
  })

  it('a failed queue is said in one line with its exit code, then today\'s route answers', async () => {
    started({ codex: ending(1) })
    expect(await host().sendTurn(ID, 'run the tests')).toMatchObject({ ok: false, message: 'api did not answer.' })
    expect(codexRuns).toHaveLength(1)
    expect(said()).toEqual(['[device] voice · codex-failed (exit 1)', '[device] voice · no-answer'])
  })

  it('a codex that could not start is said with no binary', async () => {
    started({ codex: ending('not-started') })
    expect(await host().sendTurn(ID, 'run the tests')).toMatchObject({ ok: false, message: 'api did not answer.' })
    expect(said()).toEqual(['[device] voice · codex-failed (no binary)', '[device] voice · no-answer'])
  })

  // The spec's first failure case: voice only where Orca can type, as today.
  it('with no codex binary the session lists s, and nothing runs or is said of the queue', async () => {
    started({ codex: { ...codex, binary: () => null } })
    expect(await listed()).toEqual([{ id: ID, name: 'api', caps: 's' }])
    expect(said()).toEqual([])
    expect(await host().sendTurn(ID, 'run the tests')).toMatchObject({ ok: false, message: 'api did not answer.' })
    expect(codexRuns).toEqual([])
    expect(said()).toEqual(['[device] voice · no-answer'])
  })

  // It may have queued: typed too, the words would run twice.
  it('a queue that times out is said once, and nothing is typed', async () => {
    started({ codex: ending('unknown') }, { hostHints: { ORCA_TERMINAL_HANDLE: HANDLE } })
    expect(await host().sendTurn(ID, 'run the tests')).toMatchObject({ ok: false, message: 'api did not answer.' })
    expect(said()).toEqual(['[device] voice · codex-timeout'])
    expect(orcaRuns).toEqual([])
  })

  it('no log line carries the thread id, the words, the transcript\'s path or the Codex home', async () => {
    started({ codex: ending(0, 1, 'not-started', 'unknown') }, { hostHints: { ORCA_TERMINAL_HANDLE: HANDLE } })
    for (let i = 0; i < 4; i++) await host().sendTurn(ID, 'run the tests')
    expect(said()).toEqual(['[device] voice · codex', '[device] voice · codex-failed (exit 1)', '[device] voice · orca',
      '[device] voice · codex-failed (no binary)', '[device] voice · orca', '[device] voice · codex-timeout'])
    expect(logs.filter((line) => [THREAD, 'run the tests', transcriptPath, env.CODEX_HOME].some((secret) => line.includes(secret)))).toEqual([])
  })
})

describe('a person\'s prompt in the app in front turns the dial (docs/specs/2026-11-14-dial-pane-follow.md)', () => {
  const ID = observedAgentId('claude', 'sess-1')
  const CODEX = observedAgentId('codex', 'cx-1')
  const HANDLE = 'term_0123abcd-0000-4000-8000-0123456789ab'
  /** Claude Code in an Orca terminal, as its hook says. */
  const hook = (event: ObservedHookEvent['event'], over: Partial<ObservedHookEvent> = {}): ObservedHookEvent => ({
    engine: 'claude', sessionId: 'sess-1', event, cwd: '/work/api', callerPid: 4242, transcriptPath: '/t/sess-1.jsonl',
    hostHints: { ORCA_AGENT_SESSION_ID: 'orca-1', ORCA_TERMINAL_HANDLE: HANDLE }, ...over,
  })
  const host = () => seen.dial as unknown as DaemonCableHost
  /** A dial on the cable with no window, the agent in Orca listed, and `app` settled in front when one is named. `front`
   *  tells the devices' own listener the app in front, as `harness hardware watch` does. */
  const dialWith = async (app?: string) => {
    vi.useFakeTimers()
    const listener = fakeListener()
    const started = start({ faults: ['fleet'], listen: listener.listen })
    const front = (app: string) => { expect(listener.front(app)).toBeUndefined() }
    started.port.observed(hook('session-start'))
    seen.host.watching!(true)
    started.port.swarms(null)
    if (app) {
      front(app)
      await vi.advanceTimersByTimeAsync(FRONT_SETTLE_MS)
    }
    return { ...started, front }
  }
  /** The dial's words taken by the mod's held poll: the session's next turn is theirs. */
  const spokenByMod = async (port: DevicesPort) => {
    const poll = port.inboxPoll({ pollId: 'p1', sessionId: 'sess-1' })
    expect(await host().sendTurn(ID, 'run the tests')).toEqual({ ok: true })
    expect(await poll).toEqual({ text: 'run the tests' })
  }
  const asked = () => calls('followLocal')
  const prompts = () => logs.filter((line) => line.startsWith('[device] prompt'))
  const unlinked = (off: boolean) => { (seen.cable as unknown as { connected: boolean }).connected = !off }

  it('a person\'s prompt with its app in front asks the dials to follow it', async () => {
    const { port } = await dialWith('orca')
    port.observed(hook('turn-start'))
    expect(seen.cable.calls).toContainEqual(['followLocal', [ID, 'prompt']])
    expect(asked()).toEqual([[ID, 'prompt']])
    // What the dials make of it is theirs to count.
    expect(prompts()).toEqual([])
  })

  it('a relayed prompt asks nothing and is counted', async () => {
    const { port } = await dialWith('orca')
    port.observed(hook('turn-start', { relayed: true }))
    expect(asked()).toEqual([])
    expect(prompts()).toEqual(['[device] prompt · skipped · relayed'])
  })

  it('the turn of a prompt the dial delivered asks nothing, by the mod and by Orca, and the next prompt asks again', async () => {
    const { port } = await dialWith('orca')
    await spokenByMod(port)
    port.observed(hook('turn-start'))
    expect(asked()).toEqual([])
    port.observed(hook('turn-stop'))
    port.observed(hook('turn-start'))
    expect(asked()).toEqual([[ID, 'prompt']])
    // Codex has no mod: the dial's words are typed into its Orca terminal.
    const codex = { engine: 'codex' as const, sessionId: 'cx-1' }
    port.observed(hook('session-start', codex))
    expect(await host().sendTurn(CODEX, 'run the tests')).toEqual({ ok: true })
    expect(orcaRuns.map(([, args]) => args.slice(0, 2))).toEqual([['terminal', 'send']])
    port.observed(hook('turn-start', codex))
    expect(asked()).toEqual([[ID, 'prompt']])
    port.observed(hook('turn-stop', codex))
    port.observed(hook('turn-start', codex))
    expect(asked()).toEqual([[ID, 'prompt'], [CODEX, 'prompt']])
    expect(prompts()).toEqual(Array(2).fill('[device] prompt · skipped · dial prompt'))
  })

  it('another app in front, none in front, and no front known ask nothing: not in front', async () => {
    const { port, front } = await dialWith()
    port.observed(hook('turn-start'))
    for (const app of ['ghostty', 'none']) {
      front(app)
      await vi.advanceTimersByTimeAsync(FRONT_SETTLE_MS)
      port.observed(hook('turn-start'))
    }
    expect(asked()).toEqual([])
    expect(prompts()).toEqual(Array(3).fill('[device] prompt · skipped · not in front'))
  })

  it('a front that has not stayed 1 s is not yet in front', async () => {
    const { port, front } = await dialWith()
    front('orca')
    await vi.advanceTimersByTimeAsync(FRONT_SETTLE_MS - 1)
    port.observed(hook('turn-start'))
    expect(asked()).toEqual([])
    expect(prompts()).toEqual(['[device] prompt · skipped · not in front'])
    await vi.advanceTimersByTimeAsync(1)
    port.observed(hook('turn-start'))
    expect(asked()).toEqual([[ID, 'prompt']])
  })

  it('a pick on the dial does not change which app is in front', async () => {
    const { port, front } = await dialWith()
    port.observed(hook('session-start', { sessionId: 'g-1', hostHints: { TERM_PROGRAM: 'ghostty' } }))
    // The dial's list of apps, read: Orca and Ghostty each hold one agent.
    await host().listAgentSnapshot({ apps: true })
    front('orca')
    await vi.advanceTimersByTimeAsync(FRONT_SETTLE_MS)
    expect(host().pickApp('ghostty')).toBe('switched')
    expect((await host().listAgentSnapshot({ apps: true })).apps?.shown).toBe('ghostty')
    port.observed(hook('turn-start'))
    expect(asked()).toEqual([[ID, 'prompt']])
  })

  it('a prompt in the Claude app, with the Claude app in front, asks the dials to follow it', async () => {
    const { port } = await dialWith('claude')
    port.observed(hook('turn-start', { sessionId: 'desk-1', hostHints: { __CFBundleIdentifier: 'com.anthropic.claudefordesktop' } }))
    expect(asked()).toEqual([[observedAgentId('claude', 'desk-1'), 'prompt']])
    // Orca is not in front.
    port.observed(hook('turn-start'))
    expect(asked()).toHaveLength(1)
    expect(prompts()).toEqual(['[device] prompt · skipped · not in front'])
  })

  it('the dial\'s answer is counted: moved, and no tile', () => {
    start({ faults: ['fleet'] })
    seen.host.localFollowed!('prompt', 'moved')
    seen.host.localFollowed!('prompt', 'no-tile')
    expect(prompts()).toEqual(['[device] prompt · moved', '[device] prompt · skipped · no tile'])
  })

  it('with no dial linked nothing is asked or counted, and the dial\'s prompt is still used up', async () => {
    const { port } = await dialWith('orca')
    await spokenByMod(port)
    unlinked(true)
    port.observed(hook('turn-start'))
    port.observed(hook('turn-start', { relayed: true }))
    unlinked(false)
    // The dial's prompt went with the turn it started while no dial was linked: this one is a person's.
    port.observed(hook('turn-start'))
    expect(asked()).toEqual([[ID, 'prompt']])
    unlinked(true)
    port.observed(hook('turn-start'))
    expect(asked()).toEqual([[ID, 'prompt']])
    expect(prompts()).toEqual([])
  })

  it('with the observed source switched off nothing is asked', async () => {
    const switched = env as { HARNESS_DEVICE_OBSERVED: boolean }
    switched.HARNESS_DEVICE_OBSERVED = false
    onTestFinished(() => { switched.HARNESS_DEVICE_OBSERVED = true })
    const { port } = await dialWith('orca')
    port.observed(hook('turn-start'))
    expect(asked()).toEqual([])
    expect(prompts()).toEqual([])
  })

  it('no prompt line names an app, an agent or a session', async () => {
    const { port, front } = await dialWith('orca')
    port.observed(hook('turn-start', { relayed: true }))
    await spokenByMod(port)
    port.observed(hook('turn-start'))
    port.observed(hook('turn-start'))
    seen.host.localFollowed!('prompt', 'moved')
    seen.host.localFollowed!('prompt', 'no-tile')
    front('ghostty')
    await vi.advanceTimersByTimeAsync(FRONT_SETTLE_MS)
    port.observed(hook('turn-start'))
    const reasons = ['relayed', 'dial prompt', 'not in front', 'no tile'].map((why) => `[device] prompt · skipped · ${why}`)
    expect([...prompts()].sort()).toEqual(['[device] prompt · moved', ...reasons].sort())
    expect(logs.filter((line) => [ID, 'sess-1', 'orca-1', HANDLE].some((secret) => line.includes(secret)))).toEqual([])
  })

  it('a follow that throws is logged and the devices keep running', async () => {
    const { port } = await dialWith('orca')
    vi.spyOn(seen.cable as unknown as { followLocal: (agentId: string, cause: string) => Promise<void> }, 'followLocal')
      .mockRejectedValueOnce(new Error('dial unplugged'))
    port.observed(hook('turn-start'))
    await vi.waitFor(() => expect(logs).toContain('[devices] dial failed · dial unplugged'))
    port.observed(hook('turn-start'))
    expect(asked()).toEqual([[ID, 'prompt']])
  })
})

describe('the session the Claude app shows turns the dial (docs/specs/2026-11-15-dial-claude-app-follow.md)', () => {
  /** Claude Code's own session ids, as the mod posts them, and the Claude app's ids for the same two sessions. */
  const SESSION = '0b7c2f4e-8a1d-4c3b-9e5f-6a7b8c9d0e1f'
  const SECOND = '5d6e7f80-1a2b-4c3d-8e9f-0a1b2c3d4e5f'
  const LOCAL = 'local_8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'
  const LOCAL_SECOND = 'local_2e3f4a5b-6c7d-4e8f-9a0b-1c2d3e4f5a6b'
  const BUNDLE = 'com.anthropic.claudefordesktop'
  const A = observedAgentId('claude', SESSION)
  const B = observedAgentId('claude', SECOND)
  /** A session no hook listed, and one listed in Orca. */
  const UNLISTED = '11111111-2222-4333-8444-555555555555'
  const IN_ORCA = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
  /** Claude Code in the Claude app, as its hook says. */
  const hook = (event: ObservedHookEvent['event'], over: Partial<ObservedHookEvent> = {}): ObservedHookEvent => ({
    engine: 'claude', sessionId: SESSION, event, cwd: '/work/api', callerPid: 4242, transcriptPath: `/t/${SESSION}.jsonl`,
    hostHints: { __CFBundleIdentifier: BUNDLE, CLAUDE_CODE_HOST_SESSION_ID: LOCAL }, ...over,
  })
  const second = { sessionId: SECOND, hostHints: { __CFBundleIdentifier: BUNDLE, CLAUDE_CODE_HOST_SESSION_ID: LOCAL_SECOND } }
  /** The Orca terminal of the agent listed in Orca, and its switch. */
  const HANDLE = 'term_0123abcd-0000-4000-8000-0123456789ab'
  const switched: [string, string[], number] = ['/opt/orca/bin/orca', ['terminal', 'switch', '--terminal', HANDLE, '--json'], 10_000]
  const host = () => seen.dial as unknown as DaemonCableHost
  /** The fake timers' clock is the devices' too: the settle and the 2 s move together. */
  const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms)
  /** A dial on the cable with no window, on macOS, the Claude app's two sessions listed, and `app` settled in front when
   *  one is named. `front` is `harness hardware watch`'s, `attach` the harness-device mod's, each through the devices'
   *  own listener. An agent in a Terminal tab reads /dev/ttys023. */
  const dialWith = async (app?: string) => {
    vi.useFakeTimers()
    const listener = fakeListener()
    const started = start({ faults: ['fleet'], listen: listener.listen, orca: { ...orca, platform: 'darwin' }, now: () => Date.now(),
      tty: async () => '/dev/ttys023' })
    const front = (to: string) => { expect(listener.front(to)).toBeUndefined() }
    const attach = (sessionId: string) => { expect(listener.attach(sessionId)).toBeUndefined() }
    started.port.observed(hook('session-start'))
    started.port.observed(hook('session-start', second))
    seen.host.watching!(true)
    started.port.swarms(null)
    if (app) {
      front(app)
      await wait(FRONT_SETTLE_MS)
    }
    return { ...started, listener, front, attach }
  }
  /** A swipe that rests on a Claude app agent, with the app in front: its continue link runs. */
  const rest = async (agentId: string) => {
    host().swipeEnded(agentId, 'rest')
    await wait(0)
  }
  /** A look away and back inside a second: the app settles in front again, 1 s later. */
  const backInFront = async (front: (to: string) => void) => {
    front('orca')
    front('claude')
    await wait(FRONT_SETTLE_MS)
  }
  const continued = (local: string): [string, string[], number] => ['/usr/bin/open', ['-b', 'com.anthropic.claudefordesktop', `claude://code/continue?session=${local}`], 10_000]
  const asked = () => calls('followLocal')
  /** The attach lines, and the settle's. */
  const attaches = () => logs.filter((line) => line.startsWith('[device] attach') || line.startsWith('[device] settle'))
  const unlinked = (off: boolean) => { (seen.cable as unknown as { connected: boolean }).connected = !off }

  it('an attach of a listed Claude app agent, with the app settled in front, asks the dials to follow it', async () => {
    const { attach } = await dialWith('claude')
    attach(SESSION)
    expect(asked()).toEqual([[A, 'attach']])
    // What the dials make of it is theirs to count.
    expect(attaches()).toEqual([])
  })

  it('the dial\'s answer to an attach is counted: moved, and no tile', () => {
    start({ faults: ['fleet'] })
    seen.host.localFollowed!('attach', 'moved')
    seen.host.localFollowed!('attach', 'no-tile')
    expect(attaches()).toEqual(['[device] attach · moved', '[device] attach · skipped · no tile'])
  })

  it('the dial\'s answer to a settle is the settle\'s, and to an attach asked after it the attach\'s', async () => {
    const { front, attach } = await dialWith('orca')
    attach(SESSION)
    front('claude')
    await wait(FRONT_SETTLE_MS)
    expect(asked()).toEqual([[A, 'attach']])
    // A dial answers only for its latest ask (cableSession.ts followLocal).
    seen.host.localFollowed!('attach', 'moved')
    seen.host.localFollowed!('attach', 'no-tile')
    attach(SECOND)
    seen.host.localFollowed!('attach', 'moved')
    expect(asked()).toEqual([[A, 'attach'], [B, 'attach']])
    expect(attaches()).toEqual(['[device] attach · skipped · not in front', '[device] settle · moved',
      '[device] settle · skipped · no tile', '[device] attach · moved'])
  })

  it('another app in front, none, a front not yet settled and no front known: not in front', async () => {
    const { front, attach } = await dialWith()
    attach(SESSION)
    for (const app of ['orca', 'none']) {
      front(app)
      await wait(FRONT_SETTLE_MS)
      attach(SESSION)
    }
    front('claude')
    await wait(FRONT_SETTLE_MS - 1)
    attach(SESSION)
    expect(asked()).toEqual([])
    expect(attaches()).toEqual(Array(4).fill('[device] attach · skipped · not in front'))
  })

  it('a session the devices do not list, and one listed in another app: unknown agent, and the kept agent stays', async () => {
    const { port, front, attach } = await dialWith('claude')
    attach(SESSION)
    port.observed(hook('session-start', { sessionId: IN_ORCA, hostHints: { ORCA_AGENT_SESSION_ID: 'orca-1' } }))
    attach(UNLISTED)
    attach(IN_ORCA)
    expect(attaches()).toEqual(Array(2).fill('[device] attach · skipped · unknown agent'))
    // The next settle asks for the agent the app showed before.
    await backInFront(front)
    expect(asked()).toEqual([[A, 'attach'], [A, 'attach']])
  })

  it('within 2 s of the dial\'s own link an attach of that agent is its echo, and after 2 s it is followed', async () => {
    const { attach } = await dialWith('claude')
    await rest(A)
    expect(orcaRuns).toEqual([continued(LOCAL)])
    await wait(1_999)
    attach(SESSION)
    expect(attaches()).toEqual(['[device] attach · skipped · echo'])
    expect(asked()).toEqual([])
    await wait(1)
    attach(SESSION)
    expect(asked()).toEqual([[A, 'attach']])
  })

  it('the echo is that agent\'s alone', async () => {
    const { attach } = await dialWith('claude')
    await rest(A)
    attach(SECOND)
    expect(asked()).toEqual([[B, 'attach']])
    // A link 2 s later is the one that counts now.
    await wait(2_000)
    await rest(B)
    attach(SESSION)
    attach(SECOND)
    expect(orcaRuns).toEqual([continued(LOCAL), continued(LOCAL_SECOND)])
    expect(asked()).toEqual([[B, 'attach'], [A, 'attach']])
    expect(attaches()).toEqual(['[device] attach · skipped · echo'])
  })

  it('an attach within 2 s of the dial showing an Orca terminal is followed', async () => {
    const { port, attach } = await dialWith('claude')
    port.observed(hook('session-start', { sessionId: IN_ORCA, hostHints: { ORCA_AGENT_SESSION_ID: 'orca-1', ORCA_TERMINAL_HANDLE: HANDLE } }))
    await rest(observedAgentId('claude', IN_ORCA))
    expect(orcaRuns).toEqual([switched])
    attach(SESSION)
    // An attach's echo is its own agent's link, never another pane's move.
    expect(asked()).toEqual([[A, 'attach']])
    expect(attaches()).toEqual([])
  })

  // A tap on a Claude app agent runs the rest's continue link: its attach is the dial's own as well.
  it('an attach within 2 s of a tap\'s link is its echo', async () => {
    const { attach } = await dialWith('claude')
    expect(await host().openAgent(A)).toBeUndefined()
    expect(orcaRuns).toEqual([continued(LOCAL)])
    await wait(1_999)
    attach(SESSION)
    expect(attaches()).toEqual(['[device] attach · skipped · echo'])
    expect(asked()).toEqual([])
    await wait(1)
    attach(SESSION)
    expect(asked()).toEqual([[A, 'attach']])
  })

  it('the app settling in front moves the dial to the last attached agent', async () => {
    const { front, attach } = await dialWith('orca')
    attach(SESSION)
    attach(SECOND)
    expect(attaches()).toEqual(Array(2).fill('[device] attach · skipped · not in front'))
    front('claude')
    await wait(FRONT_SETTLE_MS)
    expect(asked()).toEqual([[B, 'attach']])
    // Its line is the dial's answer.
    expect(attaches()).toEqual(Array(2).fill('[device] attach · skipped · not in front'))
  })

  it('an attach skipped as the echo is still the session the app shows', async () => {
    const { front, attach } = await dialWith('claude')
    attach(SESSION)
    await rest(B)
    attach(SECOND)
    expect(attaches()).toEqual(['[device] attach · skipped · echo'])
    await wait(2_000)
    front('orca')
    await wait(FRONT_SETTLE_MS)
    front('claude')
    await wait(FRONT_SETTLE_MS)
    expect(asked()).toEqual([[A, 'attach'], [B, 'attach']])
  })

  it.each([['another agent', B, LOCAL_SECOND], ['the kept agent', A, LOCAL]])('a settle within 2 s of the dial\'s link to %s moves nothing', async (_, linked, local) => {
    // The app showed A while Orca was in front; then it comes in front, and a swipe rests on `linked`.
    const { front, attach } = await dialWith('orca')
    attach(SESSION)
    front('claude')
    await rest(linked)
    expect(orcaRuns).toEqual([continued(local)])
    // A look away puts the settle off: back 999 ms after the link, it settles 1 999 ms after it.
    front('orca')
    await wait(999)
    front('claude')
    await wait(FRONT_SETTLE_MS)
    expect(asked()).toEqual([])
    expect(attaches()).toEqual(['[device] attach · skipped · not in front', '[device] settle · skipped · echo'])
    // The kept agent is still A: the next settle asks for it.
    await backInFront(front)
    expect(asked()).toEqual([[A, 'attach']])
  })

  it('a settle within 2 s of a tap\'s link moves nothing', async () => {
    // The app showed A while Orca was in front; a tap on B brings the app forward on B's session.
    const { front, attach } = await dialWith('orca')
    attach(SESSION)
    expect(await host().openAgent(B)).toBeUndefined()
    expect(orcaRuns).toEqual([continued(LOCAL_SECOND)])
    front('claude')
    await wait(FRONT_SETTLE_MS)
    expect(asked()).toEqual([])
    expect(attaches()).toEqual(['[device] attach · skipped · not in front', '[device] settle · skipped · echo'])
  })

  // The app comes in front, and inside its settle a swipe rests on an agent in another kind of pane: the dial shows that
  // one, and the settle must not turn it back.
  type Dial = Awaited<ReturnType<typeof dialWith>>
  const elsewhere: ReadonlyArray<[string, (dial: Dial) => Promise<{ id: string; ran(): void }>]> = [
    ['an Orca terminal', async ({ port }) => {
      port.observed(hook('session-start', { sessionId: IN_ORCA, hostHints: { ORCA_AGENT_SESSION_ID: 'orca-1', ORCA_TERMINAL_HANDLE: HANDLE } }))
      return { id: observedAgentId('claude', IN_ORCA), ran: () => expect(orcaRuns).toEqual([switched]) }
    }],
    ['a Terminal tab', async ({ port, listener }) => {
      port.observed(hook('session-start', { sessionId: 'sess-tab', hostHints: { __CFBundleIdentifier: 'com.apple.Terminal' } }))
      // Its tty read, and a watch's stream open.
      await wait(0)
      const stream = listener.tabs()
      return {
        id: observedAgentId('claude', 'sess-tab'),
        ran: () => {
          expect(stream.lines).toStrictEqual([{ app: 'terminal-app', tty: '/dev/ttys023' }])
          expect(orcaRuns).toEqual([])
        },
      }
    }],
  ]
  for (const [way, listed] of elsewhere) {
    it(`a settle moves nothing when the dial showed another kind of pane inside it (${way})`, async () => {
      const dial = await dialWith('orca')
      dial.attach(SESSION)
      const other = await listed(dial)
      dial.front('claude')
      await wait(500)
      host().swipeEnded(other.id, 'rest')
      await wait(0)
      other.ran()
      await wait(FRONT_SETTLE_MS - 500)
      expect(asked()).toEqual([])
      expect(attaches()).toEqual(['[device] attach · skipped · not in front', '[device] settle · skipped · echo'])
      // The kept agent is still A: the next settle, once the dial's move is 2 s old, asks for it.
      await wait(2_000)
      await backInFront(dial.front)
      expect(asked()).toEqual([[A, 'attach']])
    })
  }

  // The hand's turn is the move, before any rest shows a pane, and where none can.
  for (const [way, listed, pane] of [
    ['an Orca terminal, before its rest', { sessionId: IN_ORCA, hostHints: { ORCA_AGENT_SESSION_ID: 'orca-1', ORCA_TERMINAL_HANDLE: HANDLE } }, true],
    ['a WezTerm pane, which no rest shows', { sessionId: 'sess-wezterm', hostHints: { TERM_PROGRAM: 'WezTerm', WEZTERM_PANE: '3' } }, false],
  ] as const) {
    it(`a settle moves nothing when a hand turned the dial inside it (${way})`, async () => {
      const dial = await dialWith('orca')
      dial.attach(SESSION)
      dial.port.observed(hook('session-start', listed))
      const id = observedAgentId('claude', listed.sessionId)
      dial.front('claude')
      await wait(700)
      turnTo(id)
      await wait(FRONT_SETTLE_MS - 700)
      expect(asked()).toEqual([])
      expect(attaches()).toEqual(['[device] attach · skipped · not in front', '[device] settle · skipped · echo'])
      // 400 ms after the turn its rest, where it has a pane, still switches it.
      await wait(100)
      expect(host().swipeSwitches(id)).toBe(pane)
      if (pane) await rest(id)
      expect(orcaRuns).toEqual(pane ? [switched] : [])
    })
  }

  it('a settle moves nothing when a tap inside it brought another app forward with no pane of its own', async () => {
    const dial = await dialWith('orca')
    dial.attach(SESSION)
    // In Terminal, with no watch open: the tap brings Terminal forward, and selects no tab.
    dial.port.observed(hook('session-start', { sessionId: 'sess-tab', hostHints: { __CFBundleIdentifier: 'com.apple.Terminal' } }))
    dial.front('claude')
    await wait(500)
    expect(await host().openAgent(observedAgentId('claude', 'sess-tab'))).toBeUndefined()
    expect(orcaRuns).toEqual([['/usr/bin/open', ['-b', 'com.apple.Terminal'], 10_000]])
    await wait(FRONT_SETTLE_MS - 500)
    expect(asked()).toEqual([])
    expect(attaches()).toEqual(['[device] attach · skipped · not in front', '[device] settle · skipped · echo'])
  })

  it('a settle 2 s after the dial\'s last link moves the dial; of two links the younger counts', async () => {
    const { front, attach } = await dialWith('orca')
    attach(SESSION)
    front('claude')
    await rest(B)
    front('orca')
    await wait(1_000)
    front('claude')
    // 2 000 ms after the link.
    await wait(FRONT_SETTLE_MS)
    expect(asked()).toEqual([[A, 'attach']])
    expect(attaches()).toEqual(['[device] attach · skipped · not in front'])
    // Two links, 2 500 ms and 1 000 ms old when the app settles.
    await rest(B)
    await wait(1_500)
    await rest(A)
    await backInFront(front)
    expect(asked()).toEqual([[A, 'attach']])
    expect(attaches().slice(1)).toEqual(['[device] settle · skipped · echo'])
  })

  it('the app shows what the swipe chose', async () => {
    const { front, attach } = await dialWith('orca')
    attach(SESSION)
    front('claude')
    await rest(B)
    // The app settles 1 000 ms after the link, and the link's attach comes 500 ms later.
    await wait(FRONT_SETTLE_MS)
    await wait(500)
    attach(SECOND)
    expect(asked()).toEqual([])
    expect(attaches()).toEqual(['[device] attach · skipped · not in front', '[device] settle · skipped · echo', '[device] attach · skipped · echo'])
    await wait(2_000)
    await backInFront(front)
    expect(asked()).toEqual([[B, 'attach']])
  })

  it('a session\'s end clears it, and another session\'s end does not', async () => {
    const { port, front, attach } = await dialWith('orca')
    attach(SECOND)
    port.observed(hook('session-end'))
    front('claude')
    await wait(FRONT_SETTLE_MS)
    expect(asked()).toEqual([[B, 'attach']])
    // Still listed for 10 s once ended, but no longer shown in the app.
    port.observed(hook('session-end', second))
    await backInFront(front)
    expect(asked()).toEqual([[B, 'attach']])
  })

  it('a kept agent resumed in another app is forgotten at the settle: nothing asked, nothing counted', async () => {
    const { port, front, attach } = await dialWith('orca')
    attach(SESSION)
    port.observed(hook('session-start', { hostHints: { ORCA_AGENT_SESSION_ID: 'orca-1' } }))
    front('claude')
    await wait(FRONT_SETTLE_MS)
    expect(asked()).toEqual([])
    // Forgotten, not only passed over: back in the Claude app, the next settle asks for nothing either.
    port.observed(hook('session-start'))
    await backInFront(front)
    expect(asked()).toEqual([])
    expect(attaches()).toEqual(['[device] attach · skipped · not in front'])
  })

  it('a Cmd-Tab across the app moves nothing', async () => {
    const { front, attach } = await dialWith('orca')
    attach(SESSION)
    front('claude')
    await wait(FRONT_SETTLE_MS / 2)
    front('orca')
    await wait(FRONT_SETTLE_MS)
    expect(asked()).toEqual([])
    expect(attaches()).toEqual(['[device] attach · skipped · not in front'])
  })

  it('with no dial linked nothing is asked or counted, and the attach is still kept', async () => {
    const { front, attach } = await dialWith('claude')
    unlinked(true)
    attach(SESSION)
    attach(UNLISTED)
    await backInFront(front)
    expect(asked()).toEqual([])
    expect(attaches()).toEqual([])
    unlinked(false)
    await backInFront(front)
    expect(asked()).toEqual([[A, 'attach']])
  })

  it.each([['an attach', 'claude'], ['a settle', 'orca']])('%s whose follow throws is logged and the devices keep running', async (_, settled) => {
    const { front, attach } = await dialWith(settled)
    vi.spyOn(seen.cable as unknown as { followLocal: (agentId: string, cause: string) => Promise<void> }, 'followLocal')
      .mockRejectedValueOnce(new Error('dial unplugged'))
    attach(SESSION)
    if (settled !== 'claude') {
      front('claude')
      await wait(FRONT_SETTLE_MS)
    }
    await wait(0)
    expect(logs).toContain('[devices] dial failed · dial unplugged')
    attach(SESSION)
    expect(asked()).toEqual([[A, 'attach']])
  })

  it('no attach or settle line names a session, an agent or an app', async () => {
    const { front, attach } = await dialWith('orca')
    attach(SESSION)
    attach(UNLISTED)
    front('claude')
    await wait(FRONT_SETTLE_MS)
    seen.host.localFollowed!('attach', 'moved')
    seen.host.localFollowed!('attach', 'no-tile')
    await rest(B)
    attach(SECOND)
    await backInFront(front)
    await wait(2_000)
    attach(SESSION)
    seen.host.localFollowed!('attach', 'moved')
    seen.host.localFollowed!('attach', 'no-tile')
    const skipped = (...why: string[]) => why.map((reason) => `skipped · ${reason}`)
    const lines = [...['moved', ...skipped('echo', 'not in front', 'unknown agent', 'no tile')].map((line) => `[device] attach · ${line}`),
      ...['moved', ...skipped('echo', 'no tile')].map((line) => `[device] settle · ${line}`)]
    expect([...attaches()].sort()).toEqual(lines.sort())
    const secrets = [SESSION, SECOND, UNLISTED, A, B, LOCAL, LOCAL_SECOND, BUNDLE]
    expect(logs.filter((line) => secrets.some((secret) => line.includes(secret)))).toEqual([])
  })
})

describe('selecting a tab moves the dial (docs/specs/2026-11-15-dial-terminal-follow.md)', () => {
  const agent = (n: number) => observedAgentId('claude', `sess-${n}`)
  const ID = agent(1)
  /** Each agent's tty: /dev/ttys023 for the first. */
  const ttyOf = (n: number) => `/dev/ttys${String(22 + n).padStart(3, '0')}`
  const TTY = ttyOf(1)
  /** Claude Code in a Terminal tab of its own, as its hook says. */
  const hook = (n: number): ObservedHookEvent => ({
    engine: 'claude', sessionId: `sess-${n}`, event: 'session-start', cwd: '/work/api', callerPid: 4241 + n,
    transcriptPath: `/t/sess-${n}.jsonl`, hostHints: { __CFBundleIdentifier: 'com.apple.Terminal' },
  })
  const host = () => seen.dial as unknown as DaemonCableHost
  /** An agent in an Orca terminal, and one in the Claude app: other kinds of pane the dial shows. */
  const HANDLE = 'term_0123abcd-0000-4000-8000-0123456789ab'
  const switched: [string, string[], number] = ['/opt/orca/bin/orca', ['terminal', 'switch', '--terminal', HANDLE, '--json'], 10_000]
  const ORCA_AGENT = observedAgentId('claude', 'sess-orca')
  const inOrca: ObservedHookEvent = { ...hook(9), sessionId: 'sess-orca', hostHints: { ORCA_AGENT_SESSION_ID: 'orca-1', ORCA_TERMINAL_HANDLE: HANDLE } }
  const LOCAL = 'local_8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'
  const CLAUDE_AGENT = observedAgentId('claude', 'sess-claude')
  const inClaude: ObservedHookEvent = { ...hook(8), sessionId: 'sess-claude',
    hostHints: { __CFBundleIdentifier: 'com.anthropic.claudefordesktop', CLAUDE_CODE_HOST_SESSION_ID: LOCAL } }
  /** An agent in a WezTerm pane, which a tap brings forward and no rest shows. */
  const inWezterm: ObservedHookEvent = { ...hook(7), sessionId: 'sess-wezterm', hostHints: { TERM_PROGRAM: 'WezTerm', WEZTERM_PANE: '3' } }
  let clock = 0
  /** A dial on the cable with no window, on macOS, `agents` agents in Terminal tabs with their ttys read, a watch's stream
   *  open, no app settled in front, and the devices' monotonic clock at 0. `report` is a tab line through the listener's
   *  handler, as `harness hardware watch` tells one; `settle` keeps an app in front for the settle. `run`, when given, runs
   *  the devices' commands. */
  const dialWith = async (agents = 1, run?: typeof orca.run) => {
    vi.useFakeTimers()
    clock = 0
    const listener = fakeListener()
    const tty = vi.fn(async (pid: number): Promise<string | undefined> => ttyOf(pid - 4241))
    const started = start({ faults: ['fleet'], orca: { ...orca, platform: 'darwin', run: run ?? orca.run }, listen: listener.listen, tty, now: () => clock })
    for (let n = 1; n <= agents; n++) started.port.observed(hook(n))
    seen.host.watching!(true)
    started.port.swarms(null)
    await Promise.all(tty.mock.results.map(({ value }) => value))
    const stream = listener.tabs()
    const report = (app: string, tty: string): unknown =>
      (listener.given[0].handlers.tab as ListenerHandler).handle({ type: 'tab', app, tty }, new AbortController().signal)
    const settle = async (app: string) => {
      expect(listener.front(app)).toBeUndefined()
      await vi.advanceTimersByTimeAsync(FRONT_SETTLE_MS)
    }
    return { ...started, listener, stream, report, settle }
  }
  const asked = () => calls('followLocal')
  const tabLines = () => logs.filter((line) => line.startsWith('[device] tab'))
  const unlinked = (off: boolean) => { (seen.cable as unknown as { connected: boolean }).connected = !off }

  it('a tab report whose app has settled in front asks the dials to follow its agent, as a tab\'s follow', async () => {
    const { report, settle } = await dialWith()
    await settle('terminal-app')
    expect(report('terminal-app', TTY)).toBeUndefined()
    expect(asked()).toEqual([[ID, 'tab']])
    // What the dials make of it is theirs to count.
    expect(tabLines()).toEqual([])
  })

  it('with a window open, a tab report whose app has settled in front asks the dials to follow, and the list holds its agent', async () => {
    const { port, report, settle } = await dialWith()
    port.swarms({ active: 't1', swarms: [{ id: 't1', name: 'Tab', agentIds: [], panes: 0 }], tiles: [] })
    await settle('terminal-app')
    expect(report('terminal-app', TTY)).toBeUndefined()
    expect(asked()).toEqual([[ID, 'tab']])
    expect((await host().listAgentSnapshot({ apps: true })).agents.map((a) => a.id)).toContain(ID)
  })

  it('a report before its app settles waits for the settle, then asks', async () => {
    const { listener, report } = await dialWith()
    expect(listener.front('terminal-app')).toBeUndefined()
    await vi.advanceTimersByTimeAsync(FRONT_SETTLE_MS - 1)
    report('terminal-app', TTY)
    expect(asked()).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(asked()).toEqual([[ID, 'tab']])
  })

  it('a report is dropped when another app settles, counted not in front, and is not acted on when its app settles later', async () => {
    const { report, settle } = await dialWith()
    report('terminal-app', TTY)
    await settle('vscode')
    expect(tabLines()).toEqual(['[device] tab · skipped · not in front'])
    await settle('terminal-app')
    expect(asked()).toEqual([])
    expect(tabLines()).toEqual(['[device] tab · skipped · not in front'])
  })

  it('the newest report is the one acted on', async () => {
    const { report, settle } = await dialWith(2)
    report('terminal-app', ttyOf(1))
    report('terminal-app', ttyOf(2))
    await settle('terminal-app')
    expect(asked()).toEqual([[agent(2), 'tab']])
  })

  it('the dial\'s own select for that tty in the last 2 s is its echo', async () => {
    const { report, settle, stream } = await dialWith()
    await settle('terminal-app')
    host().swipeEnded(ID, 'rest')
    expect(stream.lines).toStrictEqual([{ app: 'terminal-app', tty: TTY }])
    clock = 1_999
    report('terminal-app', TTY)
    expect(tabLines()).toEqual(['[device] tab · skipped · echo'])
    expect(asked()).toEqual([])
    clock = 2_000
    report('terminal-app', TTY)
    expect(asked()).toEqual([[ID, 'tab']])
  })

  it('a report for a tty the dial selected before its latest select is still an echo', async () => {
    const { report, settle, stream } = await dialWith(2)
    await settle('terminal-app')
    host().swipeEnded(agent(1), 'rest')
    clock = 500
    host().swipeEnded(agent(2), 'rest')
    expect(stream.lines).toStrictEqual([{ app: 'terminal-app', tty: ttyOf(1) }, { app: 'terminal-app', tty: ttyOf(2) }])
    // Terminal's report of the tab the swipe passed comes late: the dial is not pulled back to it.
    clock = 900
    report('terminal-app', ttyOf(1))
    expect(tabLines()).toEqual(['[device] tab · skipped · echo'])
    expect(asked()).toEqual([])
  })

  it('nine selects inside 2 s keep the newest eight', async () => {
    const { report, settle, stream } = await dialWith(9)
    await settle('terminal-app')
    // A tap writes its select with no rest before it.
    for (let n = 1; n <= 9; n++) {
      clock = (n - 1) * 100
      expect(await host().openAgent(agent(n))).toBeUndefined()
    }
    expect(stream.lines).toHaveLength(9)
    report('terminal-app', ttyOf(1))
    expect(asked()).toEqual([[agent(1), 'tab']])
    report('terminal-app', ttyOf(2))
    expect(tabLines()).toEqual(['[device] tab · skipped · echo'])
    expect(asked()).toHaveLength(1)
  })

  it('a report held for the settle is judged by when it arrived', async () => {
    const { listener, report, stream } = await dialWith()
    host().swipeEnded(ID, 'rest')
    expect(stream.lines).toHaveLength(1)
    clock = 1_500
    report('terminal-app', TTY)
    expect(listener.front('terminal-app')).toBeUndefined()
    clock = 2_500
    await vi.advanceTimersByTimeAsync(FRONT_SETTLE_MS)
    expect(tabLines()).toEqual(['[device] tab · skipped · echo'])
    expect(asked()).toEqual([])
  })

  // Terminal reports the tab it shows as it comes forward; the dial selecting another inside the settle moved on from it.
  for (const way of ['rest', 'tap'] as const) {
    it(`a report waiting for the settle is set aside by a select the dial wrote since it came (a ${way})`, async () => {
      const { listener, report, stream } = await dialWith(2)
      expect(listener.front('terminal-app')).toBeUndefined()
      report('terminal-app', ttyOf(1))
      clock = 800
      if (way === 'rest') host().swipeEnded(agent(2), 'rest')
      else expect(await host().openAgent(agent(2))).toBeUndefined()
      expect(stream.lines).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(FRONT_SETTLE_MS)
      expect(asked()).toEqual([])
      expect(tabLines()).toEqual(['[device] tab · skipped · echo'])
    })
  }

  it('a report that came after the dial showed an Orca terminal moves the dial', async () => {
    const { port, report, settle } = await dialWith()
    port.observed(inOrca)
    await settle('terminal-app')
    host().swipeEnded(ORCA_AGENT, 'rest')
    clock = 300
    report('terminal-app', TTY)
    expect(asked()).toEqual([[ID, 'tab']])
    // The record sets aside a report that waited, never one that came later.
    expect(tabLines()).toEqual([])
  })

  it('a tap\'s raise sets aside the report its app made as it came forward', async () => {
    let began = () => {}
    const opening = new Promise<void>((resolve) => { began = resolve })
    let opened = () => {}
    const { listener, report, stream } = await dialWith(2, (file, args, timeoutMs) => {
      orcaRuns.push([file, args, timeoutMs])
      began()
      return new Promise((done) => { opened = () => done({ code: 0, stdout: '' }) })
    })
    const tapped = host().openAgent(agent(2))
    await opening
    expect(orcaRuns).toEqual([['/usr/bin/open', ['-b', 'com.apple.Terminal'], 10_000]])
    // Terminal comes forward on the tab it had, and says so before the dial's raise.
    expect(listener.front('terminal-app')).toBeUndefined()
    report('terminal-app', ttyOf(1))
    opened()
    expect(await tapped).toBeUndefined()
    expect(stream.lines).toStrictEqual([{ app: 'terminal-app', tty: ttyOf(2), raise: true }])
    await vi.advanceTimersByTimeAsync(FRONT_SETTLE_MS)
    expect(asked()).toEqual([])
    expect(tabLines()).toEqual(['[device] tab · skipped · echo'])
  })

  // Terminal's report waits for the settle; the dial showing an agent in another app inside it moved on from that tab.
  for (const [way, move, ran] of [
    ['a rest on an Orca terminal', () => { host().swipeEnded(ORCA_AGENT, 'rest') }, [switched]],
    ['a tap on an Orca terminal', async () => { expect(await host().openAgent(ORCA_AGENT)).toBeUndefined() },
      [switched, ['/usr/bin/open', ['-b', 'com.stablyai.orca'], 10_000]]],
    ['a tap on a Claude app session', async () => { expect(await host().openAgent(CLAUDE_AGENT)).toBeUndefined() },
      [['/usr/bin/open', ['-b', 'com.anthropic.claudefordesktop', `claude://code/continue?session=${LOCAL}`], 10_000]]],
  ] as const) {
    it(`a report waiting for the settle is set aside by another kind of pane the dial showed since it came (${way})`, async () => {
      const { port, listener, report, stream } = await dialWith()
      port.observed(inOrca)
      port.observed(inClaude)
      expect(listener.front('terminal-app')).toBeUndefined()
      report('terminal-app', TTY)
      clock = 800
      await move()
      expect(orcaRuns).toEqual(ran)
      expect(stream.lines).toEqual([])
      await vi.advanceTimersByTimeAsync(FRONT_SETTLE_MS)
      expect(asked()).toEqual([])
      expect(tabLines()).toEqual(['[device] tab · skipped · echo'])
    })
  }

  it('a switch that failed sets the report aside all the same', async () => {
    const { port, listener, report, stream } = await dialWith(1, async (file, args, timeoutMs) => {
      orcaRuns.push([file, args, timeoutMs])
      return { code: 1, stdout: '' }
    })
    port.observed(inOrca)
    expect(listener.front('terminal-app')).toBeUndefined()
    report('terminal-app', TTY)
    clock = 800
    host().swipeEnded(ORCA_AGENT, 'rest')
    expect(orcaRuns).toEqual([switched])
    expect(stream.lines).toEqual([])
    await vi.advanceTimersByTimeAsync(FRONT_SETTLE_MS)
    expect(logs).toContain('[device] swipe · failed')
    expect(asked()).toEqual([])
    expect(tabLines()).toEqual(['[device] tab · skipped · echo'])
  })

  // The hand's turn is the move, before any rest shows a pane, and where none can: an app with no rest, or the Claude app
  // behind.
  for (const [way, listed, pane] of [
    ['an Orca terminal, before its rest', inOrca, true],
    ['a WezTerm pane, which no rest shows', inWezterm, false],
    ['a Claude app session, its app behind', inClaude, false],
  ] as const) {
    it(`a report waiting for the settle is set aside by a hand's turn inside it (${way})`, async () => {
      const { port, listener, report } = await dialWith()
      port.observed(listed)
      const id = observedAgentId('claude', listed.sessionId)
      expect(listener.front('terminal-app')).toBeUndefined()
      report('terminal-app', TTY)
      clock = 700
      await vi.advanceTimersByTimeAsync(700)
      turnTo(id)
      clock = 1_000
      await vi.advanceTimersByTimeAsync(FRONT_SETTLE_MS - 700)
      expect(asked()).toEqual([])
      expect(tabLines()).toEqual(['[device] tab · skipped · echo'])
      // 400 ms after the turn its rest, where it has a pane, still switches it.
      clock = 1_100
      expect(host().swipeSwitches(id)).toBe(pane)
      if (pane) host().swipeEnded(id, 'rest')
      expect(orcaRuns).toEqual(pane ? [switched] : [])
    })
  }

  it('a tap is noted as it starts: a settle while its open -b runs sets the waiting report aside', async () => {
    let began = () => {}
    const opening = new Promise<void>((resolve) => { began = resolve })
    let opened = () => {}
    const { listener, report, stream } = await dialWith(2, (file, args, timeoutMs) => {
      orcaRuns.push([file, args, timeoutMs])
      began()
      return new Promise((done) => { opened = () => done({ code: 0, stdout: '' }) })
    })
    expect(listener.front('terminal-app')).toBeUndefined()
    report('terminal-app', ttyOf(1))
    clock = 700
    await vi.advanceTimersByTimeAsync(700)
    const tapped = host().openAgent(agent(2))
    await opening
    // Terminal settles before `open -b` exits, and so before the tap's raise.
    clock = 1_000
    await vi.advanceTimersByTimeAsync(FRONT_SETTLE_MS - 700)
    expect(asked()).toEqual([])
    expect(tabLines()).toEqual(['[device] tab · skipped · echo'])
    opened()
    expect(await tapped).toBeUndefined()
    expect(stream.lines).toStrictEqual([{ app: 'terminal-app', tty: ttyOf(2), raise: true }])
  })

  it('each select excuses one report: the person selecting that tab again within 2 s moves the dial', async () => {
    const { report, settle } = await dialWith(2)
    await settle('terminal-app')
    host().swipeEnded(agent(1), 'rest')
    clock = 300
    report('terminal-app', ttyOf(1))
    clock = 500
    host().swipeEnded(agent(2), 'rest')
    clock = 700
    report('terminal-app', ttyOf(2))
    expect(tabLines()).toEqual(['[device] tab · skipped · echo', '[device] tab · skipped · echo'])
    expect(asked()).toEqual([])
    // Back to the first tab in Terminal: its select was already used up by its own echo.
    clock = 1_000
    report('terminal-app', ttyOf(1))
    expect(asked()).toEqual([[agent(1), 'tab']])
  })

  it('an echo forgets the selects before it: one that never ran (replaced while it waited) excuses no later report', async () => {
    const { report, settle } = await dialWith(2)
    await settle('terminal-app')
    host().swipeEnded(agent(1), 'rest')
    clock = 300
    host().swipeEnded(agent(2), 'rest')
    // Harness Device ran only the newest: Terminal reports the second tab alone.
    clock = 600
    report('terminal-app', ttyOf(2))
    expect(tabLines()).toEqual(['[device] tab · skipped · echo'])
    // The person selects the first tab in Terminal: the app has shown the second since that select, so it moves the dial.
    clock = 1_000
    report('terminal-app', ttyOf(1))
    expect(asked()).toEqual([[agent(1), 'tab']])
  })

  it('no agent with that tty, or one in another app: unknown agent', async () => {
    const { report, settle } = await dialWith()
    await settle('terminal-app')
    report('terminal-app', '/dev/ttys099')
    await settle('iterm')
    report('iterm', TTY)
    expect(tabLines()).toEqual(['[device] tab · skipped · unknown agent', '[device] tab · skipped · unknown agent'])
    expect(asked()).toEqual([])
  })

  it('the dial\'s answer is counted: tab · moved, and tab · skipped · no tile', () => {
    start({ faults: ['fleet'] })
    seen.host.localFollowed!('tab', 'moved')
    seen.host.localFollowed!('tab', 'no-tile')
    expect(tabLines()).toEqual(['[device] tab · moved', '[device] tab · skipped · no tile'])
  })

  it('with no dial linked nothing is asked or counted', async () => {
    const { report, settle } = await dialWith()
    await settle('terminal-app')
    unlinked(true)
    report('terminal-app', TTY)
    await settle('vscode')
    report('terminal-app', TTY)
    await settle('ghostty')
    unlinked(false)
    // Neither report waits on: the one acted on was used up, the other dropped.
    await settle('terminal-app')
    expect(asked()).toEqual([])
    report('terminal-app', TTY)
    expect(asked()).toEqual([[ID, 'tab']])
    expect(tabLines()).toEqual([])
  })

  it('no tab line names a tty, an app, an agent or a session', async () => {
    const { report, settle } = await dialWith()
    await settle('terminal-app')
    report('terminal-app', TTY)
    seen.host.localFollowed!('tab', 'moved')
    seen.host.localFollowed!('tab', 'no-tile')
    report('terminal-app', '/dev/ttys099')
    host().swipeEnded(ID, 'rest')
    report('terminal-app', TTY)
    report('iterm', TTY)
    await settle('vscode')
    const five = [
      '[device] tab · moved',
      '[device] tab · skipped · no tile',
      '[device] tab · skipped · not in front',
      '[device] tab · skipped · unknown agent',
      '[device] tab · skipped · echo',
    ]
    expect([...tabLines()].sort()).toEqual([...five].sort())
    expect(logs.filter((line) => [TTY, 'ttys', 'terminal-app', 'iterm', 'vscode', ID, 'sess-1'].some((secret) => line.includes(secret)))).toEqual([])
  })

  it('a follow that throws is logged and the devices keep running', async () => {
    const { report, settle } = await dialWith()
    vi.spyOn(seen.cable as unknown as { followLocal: (agentId: string, cause: string) => Promise<void> }, 'followLocal')
      .mockRejectedValueOnce(new Error('dial unplugged'))
    // Acted on at the settle, inside the filter's timer.
    report('terminal-app', TTY)
    await settle('terminal-app')
    await vi.waitFor(() => expect(logs).toContain('[devices] dial failed · dial unplugged'))
    report('terminal-app', TTY)
    expect(asked()).toEqual([[ID, 'tab']])
  })

  it('stop forgets the waiting report: a settle after it asks nothing', async () => {
    const { port, report } = await dialWith()
    report('terminal-app', TTY)
    await port.stop()
    seen.host.appSettled!('terminal-app')
    expect(asked()).toEqual([])
    expect(tabLines()).toEqual([])
  })

  it('one settle is one hook, and both the Claude app\'s follow and a waiting tab report act on it, each guarded on its own', async () => {
    const { port, listener, report } = await dialWith()
    expect(Object.keys(seen.host).filter((key) => /settled/i.test(key))).toEqual(['appSettled'])
    report('terminal-app', TTY)
    seen.host.appSettled!('terminal-app')
    expect(asked()).toEqual([[ID, 'tab']])
    // The session the Claude app shows, attached while it was not in front: kept for the app's settle.
    const SESSION = '0b7c2f4e-8a1d-4c3b-9e5f-6a7b8c9d0e1f'
    port.observed({
      engine: 'claude', sessionId: SESSION, event: 'session-start', cwd: '/work/api', callerPid: 4300, transcriptPath: `/t/${SESSION}.jsonl`,
      hostHints: { __CFBundleIdentifier: 'com.anthropic.claudefordesktop', CLAUDE_CODE_HOST_SESSION_ID: 'local_8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b' },
    })
    expect(listener.attach(SESSION)).toBeUndefined()
    // A tab report waiting as the Claude app settles is judged too: not its app, so dropped.
    report('terminal-app', TTY)
    seen.host.appSettled!('claude')
    expect(asked()).toEqual([[ID, 'tab'], [observedAgentId('claude', SESSION), 'attach']])
    expect(tabLines()).toEqual(['[device] tab · skipped · not in front'])
    // The Claude app's follow throwing does not cost the tab report its settle.
    vi.spyOn(seen.cable as unknown as { followLocal: (agentId: string, cause: string) => Promise<void> }, 'followLocal')
      .mockImplementationOnce(() => { throw new Error('dial unplugged') })
    report('terminal-app', TTY)
    seen.host.appSettled!('claude')
    expect(logs).toContain('[devices] dial failed · dial unplugged')
    expect(tabLines()).toEqual(['[device] tab · skipped · not in front', '[device] tab · skipped · not in front'])
  })
})

describe('herdr\'s agents, over its socket (docs/specs/2026-11-16-device-herdr.md)', () => {
  const PANE = 'w1:p1'
  const ID = observedAgentId('claude', 'sess-1')
  /** An agent as herdr's `agent.list` reads it: Claude Code at its prompt in /work/api. */
  const listing = (over: Record<string, unknown> = {}) => ({ pane_id: PANE, agent: 'claude', agent_status: 'idle', cwd: '/work/api', ...over })
  /** Claude Code's hook from inside that herdr pane. */
  const hook = (event: ObservedHookEvent['event']): ObservedHookEvent => ({
    engine: 'claude', sessionId: 'sess-1', event, cwd: '/work/api', callerPid: 4242, transcriptPath: '/t/sess-1.jsonl',
    hostHints: { HERDR_PANE_ID: PANE },
  })
  /** On macOS, each app's command on the path but `herdr-app`, so Herdr Core's source (the describe below) does not start:
   *  what a tap runs is read in `orcaRuns`. */
  const onMac = { ...orca, platform: 'darwin' as const, onPath: (name: string) => (name === 'herdr-app' ? null : `/opt/${name}/bin/${name}`) }
  const host = () => seen.dial as unknown as DaemonCableHost
  /** A dial on the cable, on this computer's agents: no window. */
  const attach = (port: DevicesPort) => { seen.host.watching!(true); port.swarms(null) }
  const listed = async () => (await host().listAgentSnapshot()).agents.map(({ id, name, caps }) => ({ id, name, caps }))
  const said = () => logs.filter((line) => line.startsWith('[device] '))
  beforeEach(() => { vi.useFakeTimers() })

  /**
   * The devices with a herdr the test drives, the dial not attached yet. Its socket is there (`stamp`). Each subscription
   * keeps its entries, its callbacks and whether it was closed; `agent.list` answers `agents`; a prompt is recorded and
   * answers the next of `prompts`, else sent. `live` attaches the dial, starts the first subscription and awaits the list
   * that follows it; `status` is herdr telling the pane's status on it.
   */
  const withHerdr = (over: Parameters<typeof start>[0] = {}) => {
    const subs: Array<{ entries: readonly HerdrEntry[]; to: HerdrSubscriber; closed: boolean }> = []
    const lists: Array<Promise<HerdrAnswer>> = []
    const herdr = { agents: [listing()] as unknown[], stamp: '1:1' as string | undefined, subs, asked: [] as unknown[][], prompts: [] as HerdrPrompt[] }
    const client: HerdrClient = {
      request: (method, params) => {
        herdr.asked.push(['request', method, params])
        const answer = Promise.resolve<HerdrAnswer>({ ok: true, result: { type: 'agent_list', agents: herdr.agents } })
        lists.push(answer)
        return answer
      },
      subscribe: (entries, to) => {
        const sub = { entries, to, closed: false }
        subs.push(sub)
        return { close: () => { sub.closed = true } }
      },
      prompt: async (...args) => {
        herdr.asked.push(['prompt', ...args])
        return herdr.prompts.shift() ?? { outcome: 'sent' }
      },
      socketStamp: () => herdr.stamp,
    }
    const started = start({ orca: onMac, tty: async () => undefined, herdr: client, ...over, faults: ['fleet', ...over.faults ?? []] })
    const live = async (agents: unknown[] = [listing()]): Promise<void> => {
      herdr.agents = agents
      attach(started.port)
      subs[0].to.started()
      // The source took the answer before this await resumes: its own was waiting on the same promise first.
      await lists.at(-1)
    }
    const status = (agentStatus: string) =>
      subs[0].to.event('pane.agent_status_changed', { agent: 'claude', agent_status: agentStatus, pane_id: PANE, workspace_id: 'w1' })
    return { ...started, herdr, live, status }
  }

  it('with a dial attached herdr\'s agents are listed svf, with host herdr; detached, the source stops', async () => {
    const { herdr, live } = withHerdr()
    // No dial: herdr is not asked.
    expect(herdr.subs).toEqual([])
    await live()
    expect(herdr.subs.map(({ entries }) => entries)).toEqual([[{ type: 'pane.agent_detected' }, { type: 'pane.closed' }, { type: 'pane.exited' }]])
    expect(await listed()).toEqual([{ id: expect.any(String), name: 'api', caps: 'svf' }])
    expect((await host().listAgentSnapshot()).agents).toEqual([expect.objectContaining({ engine: 'claude', host: 'herdr' })])
    expect(logs).toContain('[herdr] listed · 1 agents')
    seen.host.watching!(false)
    expect(herdr.subs.map(({ closed }) => closed)).toEqual([true])
    expect(await listed()).toEqual([])
  })

  it('a status change is a card', async () => {
    const { live, status } = withHerdr()
    await live()
    const [{ id }] = await listed()
    status('working')
    expect(calls('turnStarted')).toEqual([[id, '', undefined]])
    status('blocked')
    expect(calls('turnStarted')).toEqual([[id, '', undefined], [id, 'Waiting for you · herdr', undefined]])
    expect(await host().activityText(id)).toBe('Waiting for you · herdr')
    status('done')
    expect(calls('turnDone')).toEqual([[id]])
    // No last answer to say, and nothing for the dial to show as a question: it is answered in herdr.
    expect(calls('summary')).toEqual([])
    expect(calls('question')).toEqual([])
  })

  // herdr's done is any finished turn in a pane it has not focused: each plug-in, reconnect and unfold lists it again.
  it('a herdr agent first listed done is no card, its next turn\'s done is; an observed agent first heard done is one', async () => {
    vi.useFakeTimers()
    const { port, live, status } = withHerdr()
    await live([listing({ agent_status: 'done' })])
    const [{ id }] = await listed()
    expect(calls('turnDone')).toEqual([])
    status('working')
    status('done')
    expect(calls('turnDone')).toEqual([[id]])
    const other = observedAgentId('claude', 'sess-2')
    port.observed({ ...hook('turn-stop'), sessionId: 'sess-2', hostHints: {} })
    await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
    expect(calls('turnDone')).toEqual([[id], [other]])
  })

  it('a herdr agent mid-turn is reminded', async () => {
    const { live, status } = withHerdr()
    await live()
    const [{ id }] = await listed()
    status('working')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(calls('turnStarted')).toEqual([[id, '', undefined], [id, '', undefined]])
  })

  // herdr says idle, never done, when a turn ends in the pane it has focused (Q10).
  it('a turn that ends idle, its pane focused in herdr, is a done card', async () => {
    const { live, status } = withHerdr()
    await live()
    const [{ id }] = await listed()
    // First listed idle: nothing ended.
    expect(calls('turnDone')).toEqual([])
    status('working')
    status('idle')
    expect(calls('turnDone')).toEqual([[id]])
    await vi.advanceTimersByTimeAsync(20_000)
    expect(calls('turnStarted')).toEqual([[id, '', undefined]])
    status('blocked')
    status('idle')
    expect(calls('turnDone')).toEqual([[id], [id]])
    // herdr's own done is the card; the idle after it ends no turn.
    status('working')
    status('done')
    status('idle')
    expect(calls('turnDone')).toEqual([[id], [id], [id]])
  })

  it('a hooked agent in a herdr pane is one row, its hook\'s, and gets each card once', async () => {
    const { port, live, status } = withHerdr()
    port.observed(hook('session-start'))
    await live()
    expect(await listed()).toEqual([{ id: ID, name: 'api', caps: 'svf' }])
    port.observed(hook('turn-start'))
    status('working')
    expect(calls('turnStarted')).toEqual([[ID, '', undefined]])
    await vi.advanceTimersByTimeAsync(20_000)
    expect(calls('turnStarted')).toEqual([[ID, '', undefined], [ID, '', undefined]])
  })

  // Q7: the id the dial still holds is refused or ignored, as on main, until its next list.
  it('the herdr row first, then its hook: the row becomes the hook\'s, and the old id never reaches the core', async () => {
    const { core, port, live, status } = withHerdr()
    await live()
    const [{ id: was }] = await listed()
    status('working')
    expect(calls('turnStarted')).toEqual([[was, '', undefined]])
    port.observed(hook('session-start'))
    expect(await listed()).toEqual([{ id: ID, name: 'api', caps: 'svf' }])
    expect(await host().activityText(was)).toBeNull()
    expect(await host().sendTurn(was, 'hi')).toEqual({ ok: false, machine: expect.any(String), reason: 'it runs outside Harness' })
    expect(await host().openAgent(was)).toBeUndefined()
    expect(orcaRuns).toEqual([])
    expect(core.agents.activityText).not.toHaveBeenCalledWith(was)
    expect(core.turns.send).not.toHaveBeenCalled()
  })

  it('the dial\'s words reach an idle herdr agent, and each refusal is said once', async () => {
    const { herdr, live, status } = withHerdr()
    await live()
    const [{ id }] = await listed()
    expect(await host().sendTurn(id, 'run the tests')).toEqual({ ok: true })
    expect(herdr.asked.filter(([what]) => what === 'prompt')).toEqual([['prompt', PANE, 'claude', 'run the tests']])
    expect(said()).toEqual(['[device] voice · herdr'])
    status('working')
    expect(await host().sendTurn(id, 'run the tests')).toMatchObject({ ok: false, message: 'api is busy. Say it when it is done.' })
    status('blocked')
    expect(await host().sendTurn(id, 'run the tests')).toMatchObject({ ok: false, message: 'api is waiting for your answer in herdr.' })
    status('idle')
    expect(await host().sendTurn(id, 'x'.repeat(2001))).toMatchObject({ ok: false, message: 'Too long. Say it shorter.' })
    herdr.prompts.push({ outcome: 'failed', fault: 'rejected', code: 'agent_not_ready' })
    expect(await host().sendTurn(id, 'run the tests')).toMatchObject({ ok: false, message: 'api did not answer.' })
    expect(said()).toEqual(['[device] voice · herdr', '[device] voice · busy', '[device] voice · waiting', '[device] voice · too-long',
      '[device] voice · no-answer'])
    // Refused by its state, nothing was typed.
    expect(herdr.asked.filter(([what]) => what === 'prompt')).toHaveLength(2)
  })

  it('a tap runs herdr agent focus for the pane, brings no app forward, and is the dial\'s own move', async () => {
    const listener = fakeListener()
    const { herdr, live } = withHerdr({ listen: listener.listen })
    await live()
    const [{ id }] = await listed()
    const asked = herdr.asked.length
    // Terminal came forward and reported its tab, which waits on its settle.
    expect(listener.front('terminal-app')).toBeUndefined()
    ;(listener.given[0].handlers.tab as ListenerHandler).handle({ type: 'tab', app: 'terminal-app', tty: '/dev/ttys023' }, never)
    expect(await host().openAgent(id)).toBeUndefined()
    expect(orcaRuns).toEqual([['/opt/herdr/bin/herdr', ['agent', 'focus', PANE], 10_000]])
    expect(herdr.asked).toHaveLength(asked)
    // The tap moved the dial since that report: the settle does not pull it back.
    await vi.advanceTimersByTimeAsync(FRONT_SETTLE_MS)
    expect(logs.filter((line) => line.startsWith('[device] tab'))).toEqual(['[device] tab · skipped · echo'])
  })

  it('turning the dial to a done agent marks it seen here, and asks herdr nothing', async () => {
    const begun = vi.spyOn(HerdrSource.prototype, 'start')
    const { herdr, live, status } = withHerdr()
    await live()
    const source = begun.mock.contexts[0] as HerdrSource
    const [{ id }] = await listed()
    status('working')
    status('done')
    expect(source.list()).toEqual([expect.objectContaining({ id, state: 'done', unseenDone: true })])
    const asked = herdr.asked.length
    turnTo(id)
    expect(source.list()).toEqual([expect.objectContaining({ id, state: 'done', unseenDone: false })])
    expect(herdr.asked).toHaveLength(asked)
    expect(herdr.subs).toHaveLength(1)
  })

  /** A dial attached with herdr's socket there, then again with none: nothing subscribed, nothing watched. */
  const nothingAsked = ({ port, herdr }: ReturnType<typeof withHerdr>) => {
    attach(port)
    seen.host.watching!(false)
    herdr.stamp = undefined
    attach(port)
    expect(herdr.subs).toEqual([])
    expect(watched.calls).toEqual([])
  }

  it('HARNESS_DEVICE_OBSERVED=off: nothing is subscribed or watched', () => {
    const switched = env as { HARNESS_DEVICE_OBSERVED: boolean }
    switched.HARNESS_DEVICE_OBSERVED = false
    onTestFinished(() => { switched.HARNESS_DEVICE_OBSERVED = true })
    nothingAsked(withHerdr())
  })

  it('on Windows nothing is subscribed or watched', () => {
    nothingAsked(withHerdr({ orca: { ...onMac, platform: 'win32' } }))
  })

  // With no herdr installed, no folder is watched (~/.config, or the home folder, recursive on macOS) for a socket that
  // never comes. Installed later, the next dial attached finds it.
  it('with no herdr on PATH nothing is subscribed or watched, and the next attach looks again', () => {
    let installed = false
    const started = withHerdr({ orca: { ...onMac, onPath: (name: string) => name !== 'herdr' || installed ? onMac.onPath(name) : null } })
    nothingAsked(started)
    seen.host.watching!(false)
    installed = true
    attach(started.port)
    expect(watched.calls).toEqual([[herdrClientDeps(), expect.any(Function)]])
  })

  it('with no socket, the folder herdr\'s socket goes in is watched, where the daemon\'s own environment puts it, while a dial is attached', () => {
    const { port, herdr } = withHerdr()
    herdr.stamp = undefined
    attach(port)
    expect(watched.calls).toEqual([[herdrClientDeps(), expect.any(Function)]])
    seen.host.watching!(false)
    expect(watched.stopped).toBe(1)
  })

  it('the devices stopping stops the source', async () => {
    const { port, herdr, live } = withHerdr()
    await live()
    // A second after the first, the subscription that names the listed pane opens.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(herdr.subs).toHaveLength(2)
    await port.stop()
    expect(herdr.subs.map(({ closed }) => closed)).toEqual([true, true])
    expect(vi.getTimerCount()).toBe(0)
    // With no socket, it waits on the watch: the devices stopping stops that too.
    const away = withHerdr()
    away.herdr.stamp = undefined
    attach(away.port)
    expect(watched.calls).toHaveLength(1)
    await away.port.stop()
    expect(watched.stopped).toBe(1)
  })

  it('a herdr part that throws costs the dial nothing', async () => {
    const { port, herdr } = withHerdr({ faults: ['herdr'] })
    port.observed(hook('session-start'))
    attach(port)
    expect(herdr.subs).toEqual([])
    expect(logs).toContain('[devices] herdr failed · injected fault: herdr')
    expect(await listed()).toEqual([{ id: ID, name: 'api', caps: 'svf' }])
  })

  it('no log line holds a pane id, a name, a folder or the words', async () => {
    const { herdr, live, status } = withHerdr()
    await live([listing({ name: 'Nebula', cwd: '/work/secret-folder' })])
    const [{ id }] = await listed()
    status('working')
    status('blocked')
    await host().sendTurn(id, 'run the secret tests')
    status('idle')
    await host().sendTurn(id, 'run the secret tests')
    await host().openAgent(id)
    herdr.subs[0].to.closed('ended')
    expect(logs).toEqual(expect.arrayContaining(['[herdr] listed · 1 agents', '[device] voice · waiting', '[device] voice · herdr',
      '[herdr] closed · ended', '[herdr] retry · 1']))
    const secrets = [PANE, 'Nebula', 'secret-folder', 'secret tests']
    expect(logs.filter((line) => secrets.some((secret) => line.includes(secret)))).toEqual([])
  })
})

describe('the Notifications setting (docs/plans/2026-11-16-dial-agent-notify-design.md)', () => {
  const ID = observedAgentId('claude', 'sess-1')
  const hook = (event: ObservedHookEvent['event']): ObservedHookEvent => ({
    engine: 'claude', sessionId: 'sess-1', event, cwd: '/work/api', callerPid: 4242, transcriptPath: '/t/sess-1.jsonl',
    hostHints: { ORCA_AGENT_SESSION_ID: 'orca-1' },
  })
  const sentLocal = (core: CoreApi) => vi.mocked(core.clients.sendLocal).mock.calls.map(([frame]) => frame)
  const statuses = (core: CoreApi) => sentLocal(core).filter((frame) => frame.type === 'dial_status')
  const summary = (port: DevicesPort, agentId: string, payload: Record<string, unknown>) =>
    port.card({ type: 'commander_event', agentId, payload: { kind: 'summary', text: 'done', ...payload } })
  /** Devices whose listener has opened: the cable starts once it has. */
  const listening = async (over: Parameters<typeof start>[0] = {}) => {
    const listener = fakeListener()
    const started = start({ ...over, listen: listener.listen })
    await vi.waitFor(() => expect(calls('start')).toHaveLength(1))
    return { ...started, listener }
  }
  /** Devices in Needs you, with the fixed rules deciding. */
  const needsYou = (over: Parameters<typeof start>[0] = {}) => {
    const listener = fakeListener()
    const started = start({ decideTier: null, ...over, listen: listener.listen })
    expect(listener.notify('you')).toEqual({ mode: 'you' })
    return started
  }

  it('every dial status the windows and the watch hear says the mode, and the owner\'s other machines hear none', async () => {
    const { core, requests } = await listening()
    seen.dial.onDialStatus({ attached: true, id: 'usb-1' })
    expect(statuses(core)).toEqual([{ type: 'dial_status', payload: { attached: true, id: 'usb-1', notify: 'full' } }])
    expect(vi.mocked(core.clients.devicesChanged).mock.calls).toEqual([[{ status: { attached: true, id: 'usb-1' }, revision: 1 }]])
    expect(await requests.harness_devices_list({}, { local: true, owner: true })).toMatchObject({ status: { attached: true, id: 'usb-1' } })
    expect(await requests.harness_devices_list({}, { local: true, owner: true })).not.toHaveProperty('status.notify')
  })

  it('the listener\'s notify stores the mode, says the status again and answers it', async () => {
    const { core, listener } = await listening()
    seen.dial.onDialStatus({ attached: true, id: 'usb-1' })
    expect(listener.notify('you')).toEqual({ mode: 'you' })
    expect(readFileSync(join(dataDir, 'dial-notify.json'), 'utf8')).toBe('{"mode":"you"}\n')
    expect(sentLocal(core).at(-1)).toEqual({ type: 'dial_status', payload: { attached: true, id: 'usb-1', notify: 'you' } })
    expect(core.clients.devicesChanged).toHaveBeenCalledTimes(1)
    expect(logs).toContain('[device] notifications · you')
    // A value that is no mode is refused by the listener's own handler.
    expect(listener.notify('loud')).toBe(REFUSED)

    const again = await listening()
    seen.dial.onDialStatus({ attached: true, id: 'usb-1' })
    expect(statuses(again.core)).toEqual([{ type: 'dial_status', payload: { attached: true, id: 'usb-1', notify: 'you' } }])
  })

  // The menu offers Notifications when the status says a mode: where no listener of the devices opened (services inside
  // the core, one that failed to open, Windows), every click would end NO_ANSWER.
  it('a dial status says no mode where the devices\' own listener did not open', async () => {
    const opens: Array<DevicesDeps['listen']> = [undefined, async () => null, async () => { throw new Error('EACCES') }]
    for (const listen of opens) {
      const { core } = start({ listen })
      await vi.waitFor(() => expect(calls('start')).toHaveLength(1))
      seen.dial.onDialStatus({ attached: true, id: 'usb-1' })
      expect(statuses(core)).toEqual([{ type: 'dial_status', payload: { attached: true, id: 'usb-1' } }])
    }
  })

  // The dial is not kept waiting for a listener slow to open (LISTENER_WAIT_MS): its status, said meanwhile, is said
  // again with the mode once one opens, or the menu would offer no Notifications until the dial's next status.
  it('a listener that opens after the dial\'s status says it again with the mode', async () => {
    let open!: (listener: DevicesListener) => void
    const { core } = start({ listen: () => new Promise((resolve) => { open = resolve }) })
    seen.dial.onDialStatus({ attached: true, id: 'usb-1' })
    expect(statuses(core)).toEqual([{ type: 'dial_status', payload: { attached: true, id: 'usb-1' } }])
    open({ close: async () => {} })
    await vi.waitFor(() => expect(statuses(core)).toEqual([
      { type: 'dial_status', payload: { attached: true, id: 'usb-1' } },
      { type: 'dial_status', payload: { attached: true, id: 'usb-1', notify: 'full' } },
    ]))
    // A status is said only once a dial has said one.
    const quiet = start({ listen: async () => ({ close: async () => {} }) })
    await vi.waitFor(() => expect(calls('start')).toHaveLength(1))
    expect(statuses(quiet.core)).toEqual([])
  })

  it('a mode that cannot be saved answers WRITE_FAILED and changes nothing', async () => {
    mkdirSync(join(dataDir, 'dial-notify.json'))
    const listener = fakeListener()
    const { core, port } = start({ decideTier: null, listen: listener.listen })
    expect(listener.notify('you')).toEqual({ error: 'WRITE_FAILED' })
    expect(logs).toContain('[device] notifications · not saved · EISDIR')
    expect(statuses(core)).toEqual([])
    summary(port, 'a1', { recap: 'The requested build is ready.' })
    await vi.waitFor(() => expect(calls('summary')).toEqual([['a1', 'The requested build is ready.', 'done', 'alert', undefined, false]]))
  })

  it('Needs you: a finished turn decided here is a drawer row', async () => {
    const { port } = needsYou()
    summary(port, 'a1', { recap: 'The requested build is ready.' })
    await vi.waitFor(() => expect(calls('summary')).toEqual([['a1', 'The requested build is ready.', 'done', 'list', undefined, false]]))
    expect(logs).toContainEqual(expect.stringMatching(/^\[cable\] notify · list · rule:needs-you · needs-you · \d+ms$/))
    expect(logs.some((line) => line.includes('rule:turn'))).toBe(false)
  })

  it('Needs you: a tier the recaps decided is lowered when it is an alert, and only then', () => {
    const { port } = needsYou()
    summary(port, 'a1', { recap: 'Deployed', tier: 'alert' })
    summary(port, 'a2', { recap: 'Deployed', tier: 'list' })
    summary(port, 'a3', { recap: 'Deployed', tier: 'silent' })
    summary(port, 'a4', { recap: 'Deployed', tier: 'alert', failed: true })
    expect(calls('summary').map(([agentId, , , tier]) => [agentId, tier])).toEqual([['a1', 'list'], ['a2', 'list'], ['a3', 'silent'], ['a4', 'alert']])
    expect(logs.filter((line) => line.includes(' · rule:needs-you · '))).toEqual([expect.stringMatching(/^\[cable\] notify · list · rule:needs-you · needs-you · 0ms$/)])
    expect(logs.filter((line) => line.includes(' · recaps · decided upstream'))).toEqual([
      expect.stringMatching(/ · list · recaps · /), expect.stringMatching(/ · silent · recaps · /), expect.stringMatching(/ · alert · recaps · /),
    ])
  })

  it('Needs you: another machine\'s card is lowered here', async () => {
    needsYou()
    const tell = seen.fleet!.events!
    tell({ machineId: 'mac-mini', kind: 'summary', agentId: 'far-1', text: 'done', recap: 'Planned.', tier: 'alert' })
    tell({ machineId: 'mac-mini', kind: 'summary', agentId: 'far-2', text: 'done', recap: 'Planned.' })
    tell({ machineId: 'mac-mini', kind: 'summary', agentId: 'far-3', text: 'done', recap: 'Planned.', tier: 'silent' })
    await vi.waitFor(() => expect(calls('summary')).toHaveLength(3))
    expect(calls('summary').map(([agentId, , , tier]) => [agentId, tier])).toEqual([['far-1', 'list'], ['far-3', 'silent'], ['far-2', 'list']])
  })

  it('Needs you: another machine\'s failed card rings', async () => {
    needsYou()
    seen.fleet!.events!({ machineId: 'cloud', kind: 'summary', agentId: 'far-1', text: 'done', recap: 'The build broke.', failed: true })
    await vi.waitFor(() => expect(calls('summary')).toEqual([['far-1', 'The build broke.', 'done', 'alert', undefined, false]]))
  })

  it('Needs you: an agent outside a pane ends as a drawer row', async () => {
    vi.useFakeTimers()
    readers.answer.mockResolvedValue('All 12 tests pass.')
    const { port } = needsYou()
    port.observed(hook('turn-start'))
    port.observed(hook('turn-stop'))
    await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
    expect(calls('summary')).toEqual([[ID, 'All 12 tests pass.', 'All 12 tests pass.', 'list', 'All 12 tests pass.', false]])
  })

  it('Needs you: a failed turn, a question and a waiting prompt ring as in All', async () => {
    const { port } = needsYou({ faults: ['fleet'] })
    summary(port, 'a1', { recap: 'The build broke.', failed: true })
    await vi.waitFor(() => expect(calls('summary')).toEqual([['a1', 'The build broke.', 'done', 'alert', undefined, false]]))
    port.card({ type: 'commander_event', agentId: 'a2', payload: { kind: 'error', text: 'boom' } })
    expect(calls('turnError')).toEqual([['a2', 'boom']])
    port.card({ type: 'commander_question', agentId: 'a3', payload: { requestId: 'r1', questions: [] } })
    expect(calls('question').map(([agentId]) => agentId)).toEqual(['a3'])
    port.observed(hook('turn-start'))
    port.observed({ engine: 'claude', sessionId: 'sess-1', event: 'asked', tool: 'Bash', summary: 'npm test', cwd: '/work/api' })
    expect(calls('question').map(([agentId]) => agentId)).toEqual(['a3', ID])
  })

  it('the decider is told the mode', async () => {
    const decideTier = vi.fn(async (_input: TierInput) => ({ tier: 'alert' as const, by: 't', detail: '', ms: 0 }))
    const listener = fakeListener()
    const { port } = start({ decideTier, listen: listener.listen })
    summary(port, 'a1', { recap: 'first' })
    await vi.waitFor(() => expect(decideTier).toHaveBeenCalledWith(expect.objectContaining({ recap: 'first', needsYou: false })))
    listener.notify('you')
    summary(port, 'a1', { recap: 'second' })
    await vi.waitFor(() => expect(decideTier).toHaveBeenLastCalledWith(expect.objectContaining({ recap: 'second', needsYou: true })))
  })

  it('a notify the dial\'s part cannot take answers FAILED', () => {
    const listener = fakeListener()
    start({ listen: listener.listen, faults: ['dial'] })
    expect(listener.notify('you')).toEqual({ error: 'FAILED' })
    expect(existsSync(join(dataDir, 'dial-notify.json'))).toBe(false)
  })
})

describe('an agent\'s notice (docs/plans/2026-11-16-dial-agent-notify-design.md)', () => {
  const LINE = 'Connect the VPN so I can run the staging tests'
  const ID = observedAgentId('claude', 'sess-1')
  const hook = (event: ObservedHookEvent['event']): ObservedHookEvent => ({
    engine: 'claude', sessionId: 'sess-1', event, cwd: '/work/api', callerPid: 4242, transcriptPath: '/t/sess-1.jsonl',
    hostHints: { ORCA_AGENT_SESSION_ID: 'orca-1' },
  })
  const card = (app: string) => [{ key: 'notice', q: LINE, options: [`In ${app}`] }]
  const host = () => seen.dial as unknown as DaemonCableHost
  /** A core with one Harness agent, h1, whose engine session the core bound as `s-h1`. */
  const bound = () => fakeCore({ dataDir, agents: { advertised: vi.fn(() => [{ agentId: 'h1', registeredAt: 1, engine: 'claude', sessionId: 's-h1' }] as RegisteredSession[]) } })
  /** The devices with their listener, and no fleet: the router has no agent of these. */
  const devices = (over: Parameters<typeof start>[0] = {}) => {
    const listener = fakeListener()
    return { ...start({ faults: ['fleet'], ...over, listen: listener.listen }), listener }
  }
  const ids = () => (calls('question') as Array<[string, string]>).map(([, id]) => id)

  it('an outside session\'s notice is a question on its own agent, answered in its app', () => {
    const { port, listener } = devices()
    port.observed(hook('turn-start'))
    expect(listener.notice({ text: LINE, engine: 'claude', sessionId: 'sess-1' })).toEqual({ result: 'shown' })
    expect(calls('question')).toEqual([[ID, expect.stringMatching(/^shown:[0-9a-f-]{36}$/), card('Orca')]])
    expect(logs).toContain('[device] notify · claude · shown')
  })

  it('a Harness agent\'s notice is tied to the agent, by the session the core bound to it', () => {
    const { listener } = devices({ core: bound() })
    expect(listener.notice({ text: LINE, engine: 'claude', sessionId: 's-h1' })).toEqual({ result: 'shown' })
    // Another engine's session of the same id is not that agent.
    expect(listener.notice({ text: LINE, engine: 'codex', sessionId: 's-h1' })).toEqual({ result: 'shown' })
    expect(calls('question')).toEqual([
      ['h1', expect.stringMatching(/^shown:/), card('Harness')],
      [observedAgentId('codex', 's-h1'), expect.stringMatching(/^shown:/), card('Terminal')],
    ])
  })

  it('an agent herdr alone lists is tied by its session, and its card goes as it is busy again', async () => {
    vi.useFakeTimers()
    const subs: HerdrSubscriber[] = []
    let list: Promise<HerdrAnswer> | undefined
    const agent = { pane_id: 'w1:p1', agent: 'claude', agent_status: 'working', cwd: '/work/api', agent_session: { kind: 'id', agent: 'claude', value: 'sess-h' } }
    const client: HerdrClient = {
      request: () => (list = Promise.resolve<HerdrAnswer>({ ok: true, result: { type: 'agent_list', agents: [agent] } })),
      subscribe: (_entries, to) => { subs.push(to); return { close: () => {} } },
      prompt: async () => ({ outcome: 'sent' }),
      socketStamp: () => '1:1',
    }
    const onMac = { ...orca, platform: 'darwin' as const, onPath: (name: string) => `/opt/${name}/bin/${name}` }
    const { port, listener } = devices({ herdr: client, orca: onMac, tty: async () => undefined })
    seen.host.watching!(true)
    port.swarms(null)
    subs[0].started()
    await list
    const [{ id }] = (await host().listAgentSnapshot()).agents
    expect(listener.notice({ text: LINE, engine: 'claude', sessionId: 'sess-h' })).toEqual({ result: 'shown' })
    expect(calls('question')).toEqual([[id, expect.stringMatching(/^shown:/), card('herdr')]])
    const status = (agentStatus: string) =>
      subs[0].event('pane.agent_status_changed', { agent: 'claude', agent_status: agentStatus, pane_id: 'w1:p1', workspace_id: 'w1' })
    // Busy all along, then its turn ending: no next turn yet.
    status('blocked')
    status('idle')
    expect(calls('questionClose')).toEqual([])
    status('working')
    expect(calls('questionClose')).toEqual([[id, ids()[0]]])
  })

  it('a caller no list holds still rings, under its folder or An agent', () => {
    const { listener } = devices()
    const machine = 'This machine'
    const from = (agentId: string) => [seen.host.noticeFrom!(agentId), host().describe(agentId)]
    expect(listener.notice({ text: LINE, engine: 'codex', sessionId: 't-9', folder: 'api' })).toEqual({ result: 'shown' })
    const caller = observedAgentId('codex', 't-9')
    expect(calls('question')).toEqual([[caller, expect.stringMatching(/^shown:/), card('Terminal')]])
    // The dial names the card's sender by what the notice said.
    expect(from(caller)).toEqual([{ name: 'api', engine: 'codex', machine }, { name: 'api', engine: 'codex', machine }])
    listener.notice({ text: LINE, engine: 'claude', sessionId: 's-2' })
    expect(from(observedAgentId('claude', 's-2'))[0]).toEqual({ name: 'An agent', engine: 'claude', machine })
    // With no session nothing ties it to an agent: one card a folder.
    listener.notice({ text: LINE })
    expect(from(observedAgentId('notify', ''))[0]).toEqual({ name: 'An agent', engine: '', machine })
    listener.notice({ text: LINE, engine: 'claude', folder: 'web' })
    expect(from(observedAgentId('notify', 'web'))[0]).toEqual({ name: 'web', engine: '', machine })
    expect((calls('question') as Array<[string]>).map(([agentId]) => agentId)).toEqual([
      caller, observedAgentId('claude', 's-2'), observedAgentId('notify', ''), observedAgentId('notify', 'web'),
    ])
  })

  it('it rings with a window open on its tab', () => {
    const { port, listener } = devices()
    port.swarms({ active: 't1', swarms: [], tiles: [] })
    port.observed(hook('turn-start'))
    // The window's tab holds what the dial is told of an outside agent's turn.
    expect(calls('turnStarted')).toEqual([])
    expect(listener.notice({ text: LINE, engine: 'claude', sessionId: 'sess-1' })).toEqual({ result: 'shown' })
    expect(calls('question')).toEqual([[ID, expect.stringMatching(/^shown:/), card('Orca')]])
  })

  it('its card goes when that agent\'s next turn starts, and with nothing before it', async () => {
    vi.useFakeTimers()
    const { port, listener } = devices({ core: bound() })
    port.observed(hook('turn-start'))
    listener.notice({ text: LINE, engine: 'claude', sessionId: 'sess-1' })
    listener.notice({ text: LINE, engine: 'claude', sessionId: 's-h1' })
    const [outside, own] = ids()
    const closed = () => calls('questionClose').filter(([, id]) => id === outside || id === own)
    port.observed(hook('needs-input'))
    // A prompt it waits on is a question of its own, which comes and goes.
    port.observed({ engine: 'claude', sessionId: 'sess-1', event: 'asked', tool: 'Bash', summary: 'npm test', cwd: '/work/api' })
    port.observed(hook('turn-stop'))
    await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
    port.card({ type: 'commander_event', agentId: 'h1', payload: { kind: 'processing', text: 'Working' } })
    port.card({ type: 'commander_event', agentId: 'h1', payload: { kind: 'summary', text: 'done', recap: 'Built.' } })
    await vi.waitFor(() => expect(calls('summary')).toHaveLength(1))
    // The wait took the notice's place on the dial: it is asked again as the wait goes.
    expect(calls('question')).toHaveLength(4)
    expect(calls('questionClose')).toHaveLength(1)
    expect(closed()).toEqual([])
    port.observed(hook('turn-start'))
    port.card({ type: 'commander_event', agentId: 'h1', payload: { kind: 'turn_started' } })
    expect(closed()).toEqual([[ID, outside], ['h1', own]])
  })

  it('its card goes when the person taps "In <app>" on the dial, never as the alert opens to be read', async () => {
    const { port, listener } = devices()
    port.observed(hook('turn-start'))
    listener.notice({ text: LINE, engine: 'claude', sessionId: 'sess-1' })
    // The question screen that came up by itself.
    await host().openAgent(ID, 'question')
    expect(calls('questionClose')).toEqual([])
    await host().openAgent(ID)
    expect(calls('questionClose')).toEqual([[ID, ids()[0]]])
  })

  it('its card goes with its agent', async () => {
    vi.useFakeTimers()
    const { port, listener } = devices({ core: bound() })
    port.observed(hook('turn-start'))
    listener.notice({ text: LINE, engine: 'claude', sessionId: 'sess-1' })
    listener.notice({ text: LINE, engine: 'claude', sessionId: 's-h1' })
    const [outside, own] = ids()
    port.card({ type: 'agent_deleted', payload: { agentId: 'h1' } })
    expect(calls('questionClose')).toEqual([['h1', own]])
    // Listed for 10 s once its session ended (observed.ts), then dropped.
    port.observed(hook('session-end'))
    expect(calls('questionClose')).toEqual([['h1', own]])
    await vi.advanceTimersByTimeAsync(11_000)
    expect(calls('questionClose')).toEqual([['h1', own], [ID, outside]])
  })

  it('a card for a session the observed source is switched off for is asked again, and goes at its next turn', () => {
    const switched = env as { HARNESS_DEVICE_OBSERVED: boolean }
    switched.HARNESS_DEVICE_OBSERVED = false
    onTestFinished(() => { switched.HARNESS_DEVICE_OBSERVED = true })
    const { port, listener } = devices()
    expect(listener.notice({ text: LINE, engine: 'claude', sessionId: 'sess-1' })).toEqual({ result: 'shown' })
    seen.host.watching!(true)
    expect(calls('question')).toEqual([[ID, ids()[0], card('Terminal')], [ID, ids()[0], card('Terminal')]])
    port.observed(hook('turn-start'))
    expect(calls('questionClose')).toEqual([[ID, ids()[0]]])
  })

  it('a dial that attaches is asked the pending notices again', () => {
    const { port, listener } = devices()
    port.observed(hook('turn-start'))
    listener.notice({ text: LINE, engine: 'claude', sessionId: 'sess-1' })
    const [first] = calls('question')
    seen.host.watching!(true)
    expect(calls('question')).toEqual([first, first])
  })

  // The dial and its cable session hold one question an agent: one asked over another takes its place.
  describe('another question of its agent', () => {
    const QUESTIONS = [{ key: 'go', q: 'Deploy now?', options: ['Yes', 'No'] }]
    const asked = (sessionId: string): ObservedAsked => ({ engine: 'claude', sessionId, event: 'asked', tool: 'Bash', summary: 'npm test', cwd: '/work/api' })
    const asks = () => (calls('question') as Array<[string, string]>).map(([agentId, id]) => [agentId, id])

    it('asked after the notice covers it, and the notice is asked again as that one closes', async () => {
      vi.useFakeTimers()
      const { port, listener } = devices({ core: bound() })
      port.observed(hook('turn-start'))
      listener.notice({ text: LINE, engine: 'claude', sessionId: 's-h1' })
      listener.notice({ text: LINE, engine: 'claude', sessionId: 'sess-1' })
      const [own, outside] = ids()
      port.card({ type: 'commander_question', agentId: 'h1', payload: { requestId: 'r1', questions: QUESTIONS } })
      port.card({ type: 'commander_question_close', agentId: 'h1', payload: { requestId: 'r1' } })
      port.observed(asked('sess-1'))
      const wait = ids()[4]
      port.observed(hook('turn-stop'))
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
      expect(asks()).toEqual([['h1', own], [ID, outside], ['h1', 'r1'], ['h1', own], [ID, wait], [ID, outside]])
      expect(calls('questionClose')).toEqual([['h1', 'r1'], [ID, wait]])
    })

    it('open as the notice comes holds it back until it closes', async () => {
      vi.useFakeTimers()
      const { port, listener } = devices({ core: bound() })
      port.card({ type: 'commander_question', agentId: 'h1', payload: { requestId: 'r1', questions: QUESTIONS } })
      expect(listener.notice({ text: LINE, engine: 'claude', sessionId: 's-h1' })).toEqual({ result: 'shown' })
      port.observed(hook('turn-start'))
      port.observed(asked('sess-1'))
      const wait = ids()[1]
      expect(listener.notice({ text: LINE, engine: 'claude', sessionId: 'sess-1' })).toEqual({ result: 'shown' })
      expect(asks()).toEqual([['h1', 'r1'], [ID, wait]])
      // A drawer replaced whole keeps the question the dial shows, not the notice behind it.
      port.unread([])
      expect(calls('replaceNotifications')).toEqual([[[expect.objectContaining({ agentId: ID, text: expect.not.stringContaining('VPN') })]]])
      port.card({ type: 'commander_question_close', agentId: 'h1', payload: { requestId: 'r1' } })
      port.observed(hook('turn-stop'))
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
      expect(asks()).toEqual([['h1', 'r1'], [ID, wait], ['h1', expect.stringMatching(/^shown:/)], [ID, expect.stringMatching(/^shown:/)]])
      expect(calls('question').slice(2).map(([, , questions]) => questions)).toEqual([card('Harness'), card('Orca')])
    })

    it('the close of an older question leaves the newer one holding the notice back', () => {
      const { port, listener } = devices({ core: bound() })
      port.card({ type: 'commander_question', agentId: 'h1', payload: { requestId: 'r1', questions: QUESTIONS } })
      port.card({ type: 'commander_question', agentId: 'h1', payload: { requestId: 'r2', questions: QUESTIONS } })
      listener.notice({ text: LINE, engine: 'claude', sessionId: 's-h1' })
      port.card({ type: 'commander_question_close', agentId: 'h1', payload: { requestId: 'r1' } })
      expect(asks()).toEqual([['h1', 'r1'], ['h1', 'r2']])
      port.card({ type: 'commander_question_close', agentId: 'h1', payload: { requestId: 'r2' } })
      expect(asks()).toEqual([['h1', 'r1'], ['h1', 'r2'], ['h1', expect.stringMatching(/^shown:/)]])
    })

    // A notice asked again rings the dial again: only the close of the question that held it back lets it out.
    it('a close heard again, or of a question never held open, asks the notice no more', () => {
      const { port, listener } = devices({ core: bound() })
      port.card({ type: 'commander_question', agentId: 'h1', payload: { requestId: 'r1', questions: QUESTIONS } })
      listener.notice({ text: LINE, engine: 'claude', sessionId: 's-h1' })
      port.card({ type: 'commander_question_close', agentId: 'h1', payload: { requestId: 'r1' } })
      port.card({ type: 'commander_question_close', agentId: 'h1', payload: { requestId: 'r1' } })
      port.card({ type: 'commander_question_close', agentId: 'h1', payload: { requestId: 'r9' } })
      expect(asks()).toEqual([['h1', 'r1'], ['h1', expect.stringMatching(/^shown:/)]])
    })

    it('a question left open by its turn holds back no notice of the next', () => {
      const { port, listener } = devices({ core: bound() })
      port.card({ type: 'commander_question', agentId: 'h1', payload: { requestId: 'r1', questions: QUESTIONS } })
      port.card({ type: 'commander_event', agentId: 'h1', payload: { kind: 'turn_started' } })
      listener.notice({ text: LINE, engine: 'claude', sessionId: 's-h1' })
      expect(asks()).toEqual([['h1', 'r1'], ['h1', expect.stringMatching(/^shown:/)]])
    })

    it('or one left by a deleted agent', () => {
      const { port, listener } = devices({ core: bound() })
      port.card({ type: 'commander_question', agentId: 'h1', payload: { requestId: 'r1', questions: QUESTIONS } })
      port.card({ type: 'agent_deleted', payload: { agentId: 'h1' } })
      listener.notice({ text: LINE, engine: 'claude', sessionId: 's-h1' })
      expect(asks()).toEqual([['h1', 'r1'], ['h1', expect.stringMatching(/^shown:/)]])
    })
  })

  // One ring a turn: the notice rang already, and the dial keeps one drawer row an agent, so a summary that rings or
  // lists would take the notice's row.
  describe('its agent\'s turn end (docs/plans/2026-11-17-dial-one-ring-per-turn-design.md)', () => {
    const summary = (port: DevicesPort, agentId: string, payload: Record<string, unknown> = {}) =>
      port.card({ type: 'commander_event', agentId, payload: { kind: 'summary', text: 'done', recap: 'Built.', ...payload } })
    const tiers = () => calls('summary').map(([agentId, , , tier]) => [agentId, tier])

    it.each(['full', 'you'])('is silent while the card is pending, decided upstream or here (Notifications %s)', async (mode) => {
      const { port, listener } = devices({ core: bound(), decideTier: null })
      if (mode === 'you') expect(listener.notify('you')).toEqual({ mode: 'you' })
      listener.notice({ text: LINE, engine: 'claude', sessionId: 's-h1' })
      summary(port, 'h1', { tier: 'alert' })
      summary(port, 'h1')
      await vi.waitFor(() => expect(tiers()).toEqual([['h1', 'silent'], ['h1', 'silent']]))
      expect(logs.filter((line) => line.includes('rule:notice'))).toEqual(Array(2).fill('[cable] notify · silent · rule:notice · notice · 0ms'))
      expect(calls('questionClose')).toEqual([])
    })

    it('a failed turn still rings', async () => {
      const { port, listener } = devices({ core: bound(), decideTier: null })
      listener.notice({ text: LINE, engine: 'claude', sessionId: 's-h1' })
      summary(port, 'h1', { tier: 'alert', failed: true })
      summary(port, 'h1', { failed: true })
      await vi.waitFor(() => expect(tiers()).toEqual([['h1', 'alert'], ['h1', 'alert']]))
    })

    // A message sent while the agent worked starts its next turn the moment this one ends, while the summary still waits
    // behind the done, whose tokens are being read: the card is gone by the time the summary's turn comes.
    it('is silent when its next turn starts while it waits behind its turn\'s done', async () => {
      let finish!: (reading: { input: number; cached: number; output: number }) => void
      let n = 0
      const readUsage = vi.fn((_id: string) => (++n === 2
        ? new Promise<{ input: number; cached: number; output: number }>((resolve) => { finish = resolve })
        : Promise.resolve({ input: 1, cached: 0, output: 1 })))
      const { port, listener } = devices({ core: bound(), decideTier: null, readUsage })
      const card = (payload: Record<string, unknown>) => port.card({ type: 'commander_event', agentId: 'h1', payload })
      card({ kind: 'turn_started' })
      listener.notice({ text: LINE, engine: 'claude', sessionId: 's-h1' })
      card({ kind: 'done', text: 'done' })
      summary(port, 'h1', { tier: 'alert' })
      card({ kind: 'turn_started' })
      finish({ input: 2, cached: 0, output: 2 })
      await vi.waitFor(() => expect(calls('questionClose')).toHaveLength(1))
      expect(tiers()).toEqual([['h1', 'silent']])
      expect(seen.cable.calls.map(([name]) => name).filter((name) => name === 'summary' || name === 'questionClose'))
        .toEqual(['summary', 'questionClose'])
    })

    it('another agent\'s turn end rings as before', async () => {
      const { port, listener } = devices({ core: bound(), decideTier: null })
      listener.notice({ text: LINE, engine: 'claude', sessionId: 's-h1' })
      summary(port, 'a2')
      await vi.waitFor(() => expect(tiers()).toEqual([['a2', 'alert']]))
    })

    it('rings again once the card went, at its next turn or a tap', async () => {
      const { port, listener } = devices({ core: bound(), decideTier: null })
      port.observed(hook('turn-start'))
      listener.notice({ text: LINE, engine: 'claude', sessionId: 's-h1' })
      listener.notice({ text: LINE, engine: 'claude', sessionId: 'sess-1' })
      port.card({ type: 'commander_event', agentId: 'h1', payload: { kind: 'turn_started' } })
      await host().openAgent(ID)
      summary(port, 'h1')
      summary(port, ID)
      await vi.waitFor(() => expect(tiers()).toEqual([['h1', 'alert'], [ID, 'alert']]))
    })
  })

  // A Harness agent's turn_started is sent only while a dial is attached (services/recaps.ts): a turn during the unplug
  // would leave its card to ring again on the next plug-in.
  it('a Harness agent\'s card goes with the last dial, an outside agent\'s stays', () => {
    const { port, listener } = devices({ core: bound() })
    port.observed(hook('turn-start'))
    listener.notice({ text: LINE, engine: 'claude', sessionId: 's-h1' })
    listener.notice({ text: LINE, engine: 'claude', sessionId: 'sess-1' })
    const [own, outside] = ids()
    seen.host.watching!(false)
    expect(calls('questionClose')).toEqual([['h1', own]])
    seen.host.watching!(true)
    expect(ids()).toEqual([own, outside, outside])
  })

  // The window's unread list replaces the dial's whole drawer, and a question the dial pins is a row of that drawer.
  it('a window that changes what it has unread leaves the notices and the waits on the dial', () => {
    const { port, listener } = devices()
    port.observed(hook('turn-start'))
    listener.notice({ text: LINE, engine: 'claude', sessionId: 'sess-1' })
    const other = { ...hook('turn-start'), sessionId: 'sess-2', callerPid: 4343, transcriptPath: '/t/sess-2.jsonl' }
    port.observed(other)
    port.observed({ engine: 'claude', sessionId: 'sess-2', event: 'asked', tool: 'Bash', summary: 'npm test', cwd: '/work/api' })
    const [, , [{ q: wait }]] = calls('question').at(-1) as [string, string, Array<{ q: string }>]
    const done = { agentId: 'h9', machineId: 'machine-2', question: false, text: 'Built.' }
    port.unread([done])
    expect(calls('replaceNotifications')).toEqual([[[
      { agentId: ID, machineId: 'machine-1', question: true, text: LINE },
      { agentId: observedAgentId('claude', 'sess-2'), machineId: 'machine-1', question: true, text: wait },
      done,
    ]]])
  })

  it('with no dial it answers no dial and asks nothing', () => {
    const { listener } = devices()
    ;(seen.cable as unknown as { connected: boolean }).connected = false
    expect(listener.notice({ text: LINE, engine: 'claude', sessionId: 'sess-1' })).toEqual({ result: 'no dial' })
    expect(calls('question')).toEqual([])
    expect(logs).toContain('[device] notify · claude · no dial')
  })

  it('the limits hold across callers of one agent', () => {
    const { port, listener } = devices()
    port.observed(hook('turn-start'))
    expect(listener.notice({ text: LINE, engine: 'claude', sessionId: 'sess-1', folder: 'api' })).toEqual({ result: 'shown' })
    expect(listener.notice({ text: 'Sign in to the registry', engine: 'claude', sessionId: 'sess-1' })).toEqual({ result: 'limited' })
    expect(calls('question')).toHaveLength(1)
    expect(calls('questionClose')).toEqual([])
    expect(logs).toContain('[device] notify · claude · limited')
  })

  it('a notices part that throws answers no dial, and costs the dial nothing', () => {
    const { port, listener } = devices({ faults: ['fleet', 'notices'] })
    expect(listener.notice({ text: LINE, engine: 'claude', sessionId: 'sess-1' })).toEqual({ result: 'no dial' })
    expect(calls('question')).toEqual([])
    expect(logs).toContain('[devices] notices failed · injected fault: notices')
    port.observed(hook('turn-start'))
    expect(calls('turnStarted')).toEqual([[ID, '', undefined]])
  })

  it('no line of the log holds the line, a session id or a folder', () => {
    const { port, listener } = devices()
    port.observed(hook('turn-start'))
    listener.notice({ text: LINE, engine: 'claude', sessionId: 'sess-1', folder: 'secret-folder' })
    listener.notice({ text: LINE, engine: 'claude', sessionId: 'sess-1', folder: 'secret-folder' })
    ;(seen.cable as unknown as { connected: boolean }).connected = false
    listener.notice({ text: LINE, engine: 'codex', sessionId: 'sess-2', folder: 'secret-folder' })
    expect(logs.filter((line) => line.startsWith('[device] notify') && !line.includes(' · day '))).toEqual([
      '[device] notify · claude · shown', '[device] notify · claude · limited', '[device] notify · codex · no dial',
    ])
    expect(logs.filter((line) => ['VPN', 'sess-1', 'sess-2', 'secret-folder'].some((secret) => line.includes(secret)))).toEqual([])
  })

  it('a notice is counted in the day\'s tally, by engine', () => {
    const { listener } = devices()
    ;(seen.cable as unknown as { connected: boolean }).connected = false
    expect(listener.notice({ text: LINE })).toEqual({ result: 'no dial' })
    expect(logs).toContain('[device] notify · agent · no dial')
    expect(logs).toContainEqual(expect.stringMatching(/^\[device\] notify · day \d{4}-\d\d-\d\d · claude shown 0 no dial 0 limited 0 · codex shown 0 no dial 0 limited 0 · agent shown 0 no dial 1 limited 0$/))
  })
})

describe('Herdr\'s agents, through Herdr Core (docs/plans/2026-11-16-herdr-app-design.md)', () => {
  const ID = observedAgentId('claude', 'sess-1')
  /** A terminal Herdr's window shows, as the hc client tells it: Claude Code at its prompt in /work/api, in tab tbaaaa. */
  const terminal = (address: string, over: Partial<HcTerminal> = {}): HcTerminal =>
    ({ address, live: true, space: true, tab: 'tbaaaa', status: 'idle', kind: 'claude', cwd: '/work/api', ...over })
  /** Claude Code's hook from inside an hc terminal: hc gives its programs TERM_PROGRAM=ghostty. */
  const hook = (event: ObservedHookEvent['event'], address = 't7'): ObservedHookEvent => ({
    engine: 'claude', sessionId: 'sess-1', event, cwd: '/work/api', callerPid: 4242, transcriptPath: '/t/sess-1.jsonl',
    hostHints: { HC_TERMINAL_ID: address, TERM_PROGRAM: 'ghostty' },
  })
  /** On macOS, each app's command on the path: what a tap runs is read in `orcaRuns`. */
  const onMac = { ...orca, platform: 'darwin' as const, onPath: (name: string) => `/opt/${name}/bin/${name}` }
  const openHerdr: [string, string[], number] = ['/usr/bin/open', ['-b', 'dev.herdr.app'], 10_000]
  const switchTo = (address: string): [string, string[], number] =>
    ['/opt/herdr-app/bin/herdr-app', ['do', 'agent.focus', '--terminal', address], 10_000]
  const host = () => seen.dial as unknown as DaemonCableHost
  /** A dial on the cable, on this computer's agents: no window. */
  const attach = (port: DevicesPort) => { seen.host.watching!(true); port.swarms(null) }
  const listed = async () => (await host().listAgentSnapshot()).agents.map(({ id, name, caps }) => ({ id, name, caps }))
  const said = () => logs.filter((line) => line.startsWith('[device] '))
  /** Claude Code in another app, as its hook names it by TERM_PROGRAM: a page the dial can pick. */
  const elsewhere = (port: DevicesPort, sessionId: string, program: string) => port.observed({
    engine: 'claude', sessionId, event: 'session-start', cwd: '/work/web', callerPid: 4243, transcriptPath: `/t/${sessionId}.jsonl`,
    hostHints: { TERM_PROGRAM: program },
  })
  const brings = () => logs.filter((line) => line.includes('app filter: bring'))
  /** The watch on the folder hc's socket goes in: herdr's has a folder of its own. Read in the test, after its env. */
  const hcWatch = () => [hcClientDeps(), expect.any(Function)]
  beforeEach(() => {
    vi.useFakeTimers()
    // The devices follow the default hc session, whatever session the tests run in: a hook's address is taken.
    vi.stubEnv('HC_SESSION', undefined)
    vi.stubEnv('HC_SOCKET', undefined)
  })

  /**
   * The devices with a Herdr Core the test drives, the dial not attached yet. Its socket is there (`stamp`). Each
   * subscription keeps its subscriber and whether it was closed; a prompt is recorded and answers the next of `prompts`,
   * else sent; keys are recorded in `pressed` and pressed. `live` attaches the dial and tells the first subscription's
   * snapshot; `changed` tells one change of t7.
   */
  const withHc = (over: Parameters<typeof start>[0] = {}) => {
    const subs: Array<{ to: HcSubscriber; closed: boolean }> = []
    const hc = { stamp: '1:1' as string | undefined, subs, prompted: [] as unknown[][], prompts: [] as HcPrompt[], pressed: [] as unknown[][] }
    const client: HcClient = {
      request: async () => ({ ok: false, fault: 'no_socket' }),
      subscribe: (to) => {
        const sub = { to, closed: false }
        subs.push(sub)
        return { close: () => { sub.closed = true } }
      },
      prompt: async (...args) => {
        hc.prompted.push(args)
        return hc.prompts.shift() ?? { outcome: 'sent' }
      },
      keys: async (...args) => {
        hc.pressed.push(args)
        return true
      },
      socketStamp: () => hc.stamp,
    }
    const started = start({ orca: onMac, tty: async () => undefined, hc: client, ...over, faults: ['fleet', ...over.faults ?? []] })
    const live = (terminals: HcTerminal[] = [terminal('t7')]): void => {
      attach(started.port)
      subs[0].to.snapshot(terminals)
    }
    const changed = (over: Partial<HcTerminal>) => subs[0].to.changed(terminal('t7', over))
    return { ...started, hc, live, changed }
  }

  it('with a dial attached Herdr\'s agents are listed svf, on herdr\'s page; detached, the source stops', async () => {
    const { hc, live } = withHc()
    // No dial: hc is not asked.
    expect(hc.subs).toEqual([])
    live()
    expect(await listed()).toEqual([{ id: expect.any(String), name: 'api', caps: 'svf' }])
    const [{ id }] = await listed()
    expect(host().hostOf(id)).toBe('herdr')
    expect(host().appOf(id)).toBe('herdr')
    expect(logs).toContain('[herdr-app] listed · 1 agents')
    seen.host.watching!(false)
    expect(hc.subs.map(({ closed }) => closed)).toEqual([true])
    expect(await listed()).toEqual([])
  })

  it('a status change is a card', async () => {
    const { live, changed } = withHc()
    live()
    const [{ id }] = await listed()
    changed({ status: 'working' })
    expect(calls('turnStarted')).toEqual([[id, '', undefined]])
    changed({ status: 'blocked' })
    expect(calls('turnStarted')).toEqual([[id, '', undefined], [id, 'Waiting for you · herdr', undefined]])
    changed({ status: 'done' })
    expect(calls('turnDone')).toEqual([[id]])
    changed({ status: 'error' })
    expect(calls('turnError').map(([agentId]) => agentId)).toEqual([id])
    // Nothing for the dial to show as a question: it is answered in Herdr.
    expect(calls('question')).toEqual([])
  })

  it('a turn that ends idle is a done card; an agent first listed done is none', async () => {
    const { live, changed } = withHc()
    live([terminal('t7', { status: 'done' })])
    const [{ id }] = await listed()
    expect(calls('turnDone')).toEqual([])
    changed({ status: 'working' })
    changed({ status: 'idle' })
    expect(calls('turnDone')).toEqual([[id]])
  })

  it('a Herdr agent mid-turn is reminded', async () => {
    const { live, changed } = withHc()
    live()
    const [{ id }] = await listed()
    changed({ status: 'working' })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(calls('turnStarted')).toEqual([[id, '', undefined], [id, '', undefined]])
  })

  it('a hooked agent in a Herdr terminal is one row, its hook\'s, on herdr\'s page, and gets each card once', async () => {
    const { port, live, changed } = withHc()
    port.observed(hook('session-start'))
    live()
    expect(await listed()).toEqual([{ id: ID, name: 'api', caps: 'svf' }])
    expect(host().hostOf(ID)).toBe('herdr')
    expect(host().appOf(ID)).toBe('herdr')
    port.observed(hook('turn-start'))
    changed({ status: 'working' })
    expect(calls('turnStarted')).toEqual([[ID, '', undefined]])
  })

  it('the dial\'s words reach an idle Herdr agent, and each refusal is said once', async () => {
    const { hc, live, changed } = withHc()
    live()
    const [{ id }] = await listed()
    expect(await host().sendTurn(id, 'run the tests')).toEqual({ ok: true })
    expect(hc.prompted).toEqual([['t7', 'claude', 'run the tests']])
    expect(said()).toEqual(['[device] voice · herdr-app'])
    changed({ status: 'working' })
    expect(await host().sendTurn(id, 'run the tests')).toMatchObject({ ok: false, message: 'api is busy. Say it when it is done.' })
    changed({ status: 'blocked' })
    expect(await host().sendTurn(id, 'run the tests')).toMatchObject({ ok: false, message: 'api is waiting for your answer in herdr.' })
    changed({ status: 'idle' })
    expect(await host().sendTurn(id, 'x'.repeat(2001))).toMatchObject({ ok: false, message: 'Too long. Say it shorter.' })
    changed({ status: 'error' })
    expect(await host().sendTurn(id, 'run the tests')).toMatchObject({ ok: false, message: 'api did not answer.' })
    changed({ status: 'idle' })
    hc.prompts.push({ outcome: 'failed', fault: 'timeout' })
    expect(await host().sendTurn(id, 'run the tests')).toMatchObject({ ok: false, message: 'api did not answer.' })
    expect(said()).toEqual(['[device] voice · herdr-app', '[device] voice · busy', '[device] voice · waiting', '[device] voice · too-long',
      '[device] voice · no-answer', '[device] voice · no-answer'])
    // Refused by its state, nothing was typed.
    expect(hc.prompted).toHaveLength(2)
  })

  // hc types into any terminal by its address: only one whose program reports an agent's status is at an agent's prompt.
  it('a hooked agent in a terminal hc reports no status for gets no words', async () => {
    const { port, live } = withHc()
    port.observed(hook('session-start'))
    live([terminal('t7', { status: undefined, kind: undefined })])
    expect(await listed()).toEqual([{ id: ID, name: 'api', caps: 'sf' }])
  })

  it('a hooked agent\'s words go through Herdr Core, counted herdr-app', async () => {
    const { port, hc, live } = withHc()
    port.observed(hook('turn-stop'))
    live()
    expect(await host().sendTurn(ID, 'run the tests')).toEqual({ ok: true })
    expect(hc.prompted).toEqual([['t7', 'claude', 'run the tests']])
    expect(orcaRuns).toEqual([])
    expect(said().at(-1)).toBe('[device] voice · herdr-app')
  })

  it('a tap opens Herdr, then switches its window to the terminal, and is the dial\'s own move', async () => {
    const listener = fakeListener()
    const { live } = withHc({ listen: listener.listen })
    live()
    const [{ id }] = await listed()
    // Terminal came forward and reported its tab, which waits on its settle.
    expect(listener.front('terminal-app')).toBeUndefined()
    ;(listener.given[0].handlers.tab as ListenerHandler).handle({ type: 'tab', app: 'terminal-app', tty: '/dev/ttys023' }, never)
    expect(await host().openAgent(id)).toBeUndefined()
    expect(orcaRuns).toEqual([openHerdr, switchTo('t7')])
    // The tap moved the dial since that report: the settle does not pull it back.
    await vi.advanceTimersByTimeAsync(FRONT_SETTLE_MS)
    expect(logs.filter((line) => line.startsWith('[device] tab'))).toEqual(['[device] tab · skipped · echo'])
  })

  // The end-to-end harness points HARNESS_OPEN_BIN at a fake that opens nothing (e2e/harness/daemon.ts).
  it('a tap runs HARNESS_OPEN_BIN as its open', async () => {
    vi.stubEnv('HARNESS_OPEN_BIN', '/tmp/e2e/fake-open')
    const { live } = withHc()
    live()
    const [{ id }] = await listed()
    expect(await host().openAgent(id)).toBeUndefined()
    expect(orcaRuns).toEqual([['/tmp/e2e/fake-open', ['-b', 'dev.herdr.app'], 10_000], switchTo('t7')])
  })

  // One bring at a time, and the last pick wins (docs/plans/2026-11-16-dial-pick-brings-app-design.md, decision 4): a tap
  // turns the dial to its own agent, and a pick waiting would turn it away again.
  it('a tap on a Herdr agent drops the pick waiting: it answers nothing and its open never runs', async () => {
    let release!: () => void
    const held = new Promise<void>((done) => { release = done })
    const { port, live } = withHc({ orca: { ...onMac, run: async (file: string, args: string[], timeoutMs: number) => {
      orcaRuns.push([file, args, timeoutMs])
      if (args[1] === 'com.microsoft.VSCode') await held
      return { code: 0, stdout: '' }
    } } })
    live()
    for (const [sessionId, program] of [['g-1', 'ghostty'], ['g-2', 'ghostty'], ['v-1', 'vscode']]) elsewhere(port, sessionId, program)
    expect((await host().listAgentSnapshot({ apps: true })).apps?.shown).toBe('ghostty')
    const { id } = (await listed()).find(({ name }) => name === 'api')!
    // VS Code's open runs and holds; Ghostty's waits behind it.
    expect(host().pickApp('vscode')).toBe('switched')
    expect(host().pickApp('ghostty')).toBe('switched')
    expect(await host().openAgent(id)).toBeUndefined()
    release()
    await vi.waitFor(() => expect(brings()).toEqual(['[device] app filter: bring · ok']))
    expect(orcaRuns).toEqual([['/usr/bin/open', ['-b', 'com.microsoft.VSCode'], 10_000], openHerdr, switchTo('t7')])
  })

  it('a tap on a hooked agent in a Herdr terminal runs the same two commands, and no second open', async () => {
    const { port, live } = withHc()
    port.observed(hook('session-start'))
    live()
    expect(await host().openAgent(ID)).toBeUndefined()
    expect(orcaRuns).toEqual([openHerdr, switchTo('t7')])
  })

  // The hook sends the default session's addresses alone (notify.mjs), and another session counts its terminals from t1
  // again: a daemon that follows another session takes no hook's address, whose terminal there is another agent's.
  it.each([
    [{}, true],
    [{ HC_SESSION: 'default' }, true],
    [{ HC_SESSION: 'other' }, false],
    [{ HC_SOCKET: '/tmp/hc-other/c.sock' }, false],
  ])('the devices with %j take a hook\'s HC_TERMINAL_ID: %s', async (vars, taken) => {
    for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value)
    const { port, live } = withHc()
    port.observed(hook('session-start'))
    live()
    expect(await host().openAgent(ID)).toBeUndefined()
    expect(orcaRuns).toEqual(taken ? [openHerdr, switchTo('t7')] : [openHerdr])
  })

  /** Claude Code at its prompt in /work/api, found by the scan with no hook heard: its process is pid 4242. */
  const scanFinds = () => {
    readers.known.set('sess-1', 'terminal')
    readers.owners.set('sess-1', { engine: 'claude', pid: 4242 })
    readers.rows.set('sess-1', { cwd: '/work/api', transcriptPath: '/t/sess-1.jsonl' })
    readers.working.set('sess-1', false)
  }
  /** Herdr's own row for t7, beside the observed copy until the two are paired. */
  const twoRows = [{ id: ID, name: 'api', caps: expect.any(String) }, { id: expect.not.stringMatching(ID), name: 'api', caps: 'svf' }]

  // hc's foreground pid of a terminal is the scan's pid of the session (the addendum of
  // docs/plans/2026-11-17-dial-recap-after-restart-design.md).
  it('a session the scan found in an hc terminal is listed once, by its own copy, and takes words and a tap there', async () => {
    scanFinds()
    const { hc, live } = withHc()
    live([terminal('t7', { foregroundPid: 4242 })])
    await vi.waitFor(async () => expect(await listed()).toEqual([{ id: ID, name: 'api', caps: 'svf' }]))
    expect(await host().sendTurn(ID, 'run the tests')).toEqual({ ok: true })
    expect(hc.prompted).toEqual([['t7', 'claude', 'run the tests']])
    expect(await host().openAgent(ID)).toBeUndefined()
    expect(orcaRuns).toEqual([openHerdr, switchTo('t7')])
    expect(logs).toContain('[observed] herdr · 1 paired')
    expect(logs.filter((line) => /\bt7\b|4242/.test(line))).toEqual([])
  })

  it('Herdr\'s list after the scan pairs it; a foreground that moves away takes it back', async () => {
    scanFinds()
    const { live, changed } = withHc()
    live([terminal('t7')])
    await vi.waitFor(async () => expect(await listed()).toEqual(expect.arrayContaining(twoRows)))
    expect(await listed()).toHaveLength(2)
    changed({ foregroundPid: 4242 })
    await vi.waitFor(async () => expect(await listed()).toEqual([{ id: ID, name: 'api', caps: 'svf' }]))
    changed({ foregroundPid: 999 })
    await vi.waitFor(async () => expect(await listed()).toHaveLength(2))
    expect(host().hostOf(ID)).toBe('terminal')
  })

  // As a hook's address (above): another session's t7 is another agent's terminal.
  it.each([
    [{}, true],
    [{ HC_SESSION: 'other' }, false],
  ])('with %j the devices pair a session the scan found: %s', async (vars, paired) => {
    for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value)
    scanFinds()
    const { live } = withHc()
    live([terminal('t7', { foregroundPid: 4242 })])
    await vi.waitFor(() => expect(readers.answer).toHaveBeenCalled())
    await vi.waitFor(async () => expect(await listed()).toHaveLength(paired ? 1 : 2))
    expect(host().hostOf(ID)).toBe(paired ? 'herdr' : 'terminal')
  })

  // A stale pane would take the session's words in a terminal hc no longer tells of.
  it('detached, the pairing is taken back', async () => {
    scanFinds()
    const { hc, live } = withHc()
    live([terminal('t7', { foregroundPid: 4242 })])
    await vi.waitFor(() => expect(host().hostOf(ID)).toBe('herdr'))
    seen.host.watching!(false)
    await vi.waitFor(() => expect(host().hostOf(ID)).toBe('terminal'))
    await host().sendTurn(ID, 'run the tests')
    expect(hc.prompted).toEqual([])
  })

  // Every hc terminal has HC_TERMINAL_ID, hidden `hc run` workers too, and the window shows those not.
  it('a hooked agent in a terminal Herdr\'s window does not show takes words, and a tap brings Herdr forward only', async () => {
    const { port, hc, live } = withHc()
    port.observed(hook('turn-stop', 't8'))
    live([terminal('t7'), terminal('t8', { space: false })])
    expect(await host().sendTurn(ID, 'run the tests')).toEqual({ ok: true })
    expect(hc.prompted).toEqual([['t8', 'claude', 'run the tests']])
    expect(await host().openAgent(ID)).toBeUndefined()
    expect(orcaRuns).toEqual([openHerdr])
    expect(said().filter((line) => line.includes('fallback'))).toEqual([])
  })

  it('a rest with Herdr in front switches its window and brings nothing forward; with another app in front it has no pane', async () => {
    const { live } = withHc()
    live()
    const [{ id }] = await listed()
    host().front('herdr')
    expect(host().swipeSwitches(id)).toBe(true)
    host().swipeEnded(id, 'rest')
    await vi.waitFor(() => expect(said()).toContain('[device] swipe · ok'))
    expect(orcaRuns).toEqual([switchTo('t7')])
    host().front('ghostty')
    expect(host().swipeSwitches(id)).toBe(false)
  })

  it('herdr 0.8.0\'s agents and Herdr\'s are both listed, and neither folds the other', async () => {
    const herdrSubs: HerdrSubscriber[] = []
    const herdrListing: HerdrClient = {
      request: async () => ({ ok: true, result: { type: 'agent_list', agents: [{ pane_id: 'w1:p1', agent: 'claude', agent_status: 'idle', cwd: '/work/web' }] } }),
      subscribe: (_entries, to) => { herdrSubs.push(to); return { close: () => {} } },
      prompt: async () => ({ outcome: 'sent' }),
      socketStamp: () => '1:1',
    }
    const { live } = withHc({ herdr: herdrListing })
    live()
    herdrSubs[0].started()
    await vi.waitFor(async () => expect(await listed()).toHaveLength(2))
    expect((await listed()).map(({ name, caps }) => ({ name, caps }))).toEqual(expect.arrayContaining([
      { name: 'web', caps: 'svf' }, { name: 'api', caps: 'svf' },
    ]))
  })

  // The PM (2026-11-16): a pick of herdr brings Herdr while herdr's ring holds an agent in Herdr's window. herdr 0.8.0's
  // agents have none of their own (#4366).
  describe('a pick of herdr', () => {
    /** Ghostty's two agents keep herdr's ring from being the one shown: the pick switches to it. */
    const pickHerdr = async (port: DevicesPort) => {
      elsewhere(port, 'g-1', 'ghostty')
      elsewhere(port, 'g-2', 'ghostty')
      expect((await host().listAgentSnapshot({ apps: true })).apps?.shown).toBe('ghostty')
      expect(host().pickApp('herdr')).toBe('switched')
    }

    it('brings Herdr while hc lists an agent', async () => {
      const { port, live } = withHc()
      live()
      await pickHerdr(port)
      await vi.waitFor(() => expect(brings()).toEqual(['[device] app filter: bring · ok']))
      expect(orcaRuns).toEqual([openHerdr])
    })

    it('brings Herdr while a hooked agent in an hc terminal is on herdr\'s ring', async () => {
      const { port, live } = withHc()
      port.observed(hook('session-start'))
      live([])
      await pickHerdr(port)
      await vi.waitFor(() => expect(brings()).toEqual(['[device] app filter: bring · ok']))
      expect(orcaRuns).toEqual([openHerdr])
    })

    it('brings nothing with herdr 0.8.0\'s agents alone on herdr\'s ring', async () => {
      const herdrSubs: HerdrSubscriber[] = []
      const herdrListing: HerdrClient = {
        request: async () => ({ ok: true, result: { type: 'agent_list', agents: [{ pane_id: 'w1:p1', agent: 'claude', agent_status: 'idle', cwd: '/work/old' }] } }),
        subscribe: (_entries, to) => { herdrSubs.push(to); return { close: () => {} } },
        prompt: async () => ({ outcome: 'sent' }),
        socketStamp: () => '1:1',
      }
      const { port, live } = withHc({ herdr: herdrListing })
      live([])
      herdrSubs[0].started()
      await vi.waitFor(async () => expect(await listed()).toHaveLength(1))
      await pickHerdr(port)
      await vi.advanceTimersByTimeAsync(0)
      expect(orcaRuns).toEqual([])
      expect(brings()).toEqual([])
    })
  })

  /** A dial attached with hc's socket there, then again with none: nothing subscribed, and hc's folder not watched. */
  const nothingAsked = ({ port, hc }: ReturnType<typeof withHc>) => {
    attach(port)
    seen.host.watching!(false)
    hc.stamp = undefined
    attach(port)
    expect(hc.subs).toEqual([])
    expect(watched.calls).not.toContainEqual(hcWatch())
  }

  it('HARNESS_DEVICE_OBSERVED=off: nothing is subscribed or watched', () => {
    const switched = env as { HARNESS_DEVICE_OBSERVED: boolean }
    switched.HARNESS_DEVICE_OBSERVED = false
    onTestFinished(() => { switched.HARNESS_DEVICE_OBSERVED = true })
    nothingAsked(withHc())
  })

  it.each(['linux', 'win32'] as const)('off macOS (%s) nothing is subscribed or watched', (platform) => {
    nothingAsked(withHc({ orca: { ...onMac, platform } }))
  })

  // With Herdr not installed, no folder is watched for a socket that never comes. Installed later, the next dial attached
  // finds it.
  it('with Herdr not installed nothing is subscribed or watched, and the next attach looks again', () => {
    let installed = false
    const started = withHc({ orca: { ...onMac, onPath: (name: string) => name !== 'herdr-app' || installed ? onMac.onPath(name) : null } })
    nothingAsked(started)
    seen.host.watching!(false)
    installed = true
    attach(started.port)
    expect(watched.calls).toContainEqual(hcWatch())
  })

  it('with no socket, the folder hc\'s socket goes in is watched while a dial is attached', () => {
    const { port, hc } = withHc()
    hc.stamp = undefined
    attach(port)
    expect(watched.calls).toContainEqual(hcWatch())
    seen.host.watching!(false)
    expect(watched.stopped).toBe(watched.calls.length)
  })

  it('the devices stopping stops the source', async () => {
    const { port, hc, live } = withHc()
    live()
    await port.stop()
    expect(hc.subs.map(({ closed }) => closed)).toEqual([true])
    expect(vi.getTimerCount()).toBe(0)
    // With no socket, it waits on the watch: the devices stopping stops that too.
    const away = withHc()
    away.hc.stamp = undefined
    attach(away.port)
    expect(watched.calls).toContainEqual(hcWatch())
    await away.port.stop()
    expect(watched.stopped).toBe(watched.calls.length)
  })

  // With nothing heard of hc, a hooked agent's terminal is not known to run it now: it gets no words, and a tap still
  // brings Herdr.
  it('a herdr-app part that throws costs the dial nothing', async () => {
    const { port, hc } = withHc({ faults: ['herdr-app'] })
    port.observed(hook('session-start'))
    attach(port)
    expect(hc.subs).toEqual([])
    expect(logs).toContain('[devices] herdr-app failed · injected fault: herdr-app')
    expect(await listed()).toEqual([{ id: ID, name: 'api', caps: 'sf' }])
  })

  it('no log line holds an address, a name, a folder or the words', async () => {
    const { hc, live, changed } = withHc()
    const secret = { address: 't7q4', name: 'Nebula', cwd: '/work/secret-folder' }
    live([terminal('t7q4', secret)])
    const [{ id }] = await listed()
    changed({ ...secret, status: 'working' })
    changed({ ...secret, status: 'blocked' })
    await host().sendTurn(id, 'run the secret tests')
    changed({ ...secret, status: 'idle' })
    await host().sendTurn(id, 'run the secret tests')
    await host().openAgent(id)
    host().front('herdr')
    host().swipeEnded(id, 'rest')
    await vi.waitFor(() => expect(said()).toContain('[device] swipe · ok'))
    hc.subs[0].to.closed('ended')
    expect(logs).toEqual(expect.arrayContaining(['[herdr-app] listed · 1 agents', '[device] voice · waiting', '[device] voice · herdr-app',
      '[herdr-app] closed · ended', '[herdr-app] retry · 1']))
    const secrets = ['t7q4', 'Nebula', 'secret-folder', 'secret tests']
    expect(logs.filter((line) => secrets.some((word) => line.includes(word)))).toEqual([])
  })

  // A stroke scrolls Herdr's view of the shown agent's terminal while Herdr is in front and its window shows that terminal
  // on screen; any other stroke goes to Harness's windows as before.
  describe('a stroke on the dial scrolls Herdr (docs/plans/2026-11-17-dial-herdr-scroll-design.md)', () => {
    const DIAL = {}
    /** The agent the dial shows, as its cable session tells the host; null for none. */
    const shows = (agentId: string | null) => host().dialShows(DIAL, agentId ? { name: 'api', app: 'herdr' } : null, agentId)
    /** A finger on the glass: a down, its moves, and an up that leaves at that velocity. */
    const stroke = (moves: number[], velocity = 0) => {
      host().scrolled('down', 0, 0)
      for (const dy of moves) host().scrolled('move', dy, 0)
      host().scrolled('up', 0, velocity)
    }
    const dialScrolls = (core: CoreApi) => vi.mocked(core.clients.sendLocal).mock.calls.map(([frame]) => frame)
      .filter(({ type }) => type === 'dial_scroll')
    const toWindows = (phase: string, dy: number, velocity: number) => ({ type: 'dial_scroll', payload: { phase, dy, velocity } })
    const STATUS: [string, string[], number] = ['/opt/herdr-app/bin/herdr-app', ['status'], 2_000]
    const scrolled = (address: string, lines: number): [string, string[], number] =>
      ['/opt/herdr-app/bin/herdr-app', ['do', 'terminal.scroll', '--terminal', address, '--lines', String(lines)], 2_000]
    const NOT_ON_SCREEN = '[device] scroll · herdr-app · not on screen'
    /** What the devices said of a scroll. */
    const scrollSaid = () => logs.filter((line) => line.startsWith('[device] scroll'))
    /** herdr-app's scroll queues that drained, a line each (herdrApp.ts). */
    const drained = () => logs.filter((line) => /^\[herdr-app\] scroll · \d+ lines/.test(line))
    /** The id the dial holds for the one agent hc lists. */
    const listedId = async () => (await listed())[0].id

    /** Codex draws on the main screen, whose history Herdr's view scrolls; Claude Code's own keys move it. */
    const CODEX: Partial<HcTerminal> = { kind: 'codex' }

    /**
     * The devices with Herdr Core listing `terminals` (Codex in t7 alone by default), the hook `hooked` heard first,
     * the dial attached and Herdr in front. Every herdr-app run is recorded in `orcaRuns`: its `status` exits
     * `screen.code` and prints `screen.tab` as the tab on screen (t7's own by default), held while `screen.held` until
     * `answer` names the tab. Its `agent` names t7 whatever the tab, as Herdr's did on Diego's first check (2026-11-18).
     */
    const inHerdr = (over: Parameters<typeof start>[0] & { hooked?: ObservedHookEvent; terminals?: HcTerminal[] } = {}) => {
      const screen = { tab: 'tbaaaa', code: 0 as number | null, held: false }
      const waiting: Array<() => void> = []
      const run = async (file: string, args: string[], timeoutMs: number) => {
        orcaRuns.push([file, args, timeoutMs])
        if (args[0] !== 'status') return { code: 0, stdout: '' }
        if (screen.held) await new Promise<void>((resolve) => { waiting.push(resolve) })
        return { code: screen.code, stdout: herdrAppStatus(screen.tab, 't7') }
      }
      const started = withHc({ ...over, orca: { ...onMac, ...over.orca, run } })
      if (over.hooked) started.port.observed(over.hooked)
      attach(started.port)
      // None off macOS or with the observed agents off: hc is not followed there.
      started.hc.subs[0]?.to.snapshot(over.terminals ?? [terminal('t7', CODEX)])
      host().front('herdr')
      const answer = (tab: string) => {
        screen.tab = tab
        screen.held = false
        for (const release of waiting.splice(0)) release()
      }
      return { ...started, screen, answer }
    }

    /** A stroke on t7, each move's lines a run of their own: `status` at the down, then the lines. */
    const strokeOnT7 = async (core: CoreApi) => {
      host().scrolled('down', 0, 0)
      await vi.waitFor(() => expect(orcaRuns).toEqual([STATUS]))
      // 20 px toward older lines twice (one line each, 8 px kept), then 60 px toward newer: 52 px, three lines.
      // Each move 50 ms after the last, the gap between two runs of a terminal: each move's lines run on their own.
      for (const dy of [8, 8, -24]) {
        host().scrolled('move', dy, 0)
        await vi.advanceTimersByTimeAsync(50)
      }
      host().scrolled('up', 0, 0)
      expect(orcaRuns).toEqual([STATUS, scrolled('t7', -1), scrolled('t7', -1), scrolled('t7', 3)])
      expect(dialScrolls(core)).toEqual([])
      // One tally for the stroke, once its terminal has been quiet for 1 s.
      await vi.advanceTimersByTimeAsync(1_000)
      expect(drained()).toEqual(['[herdr-app] scroll · 5 lines · 3 runs · 0 failed'])
    }

    it('with Herdr in front, the dial on an agent hc lists and its terminal on screen, a stroke\'s lines go to herdr-app and the windows hear no dial_scroll', async () => {
      const { core } = inHerdr()
      shows(await listedId())
      await strokeOnT7(core)
    })

    it('a hooked agent in a Herdr terminal scrolls by its hook\'s address', async () => {
      const { core } = inHerdr({ hooked: hook('session-start') })
      shows(ID)
      await strokeOnT7(core)
    })

    it.each<[string, () => Promise<CoreApi>]>([
      ['another app in front', async () => {
        const { core } = inHerdr()
        host().front('ghostty')
        shows(await listedId())
        return core
      }],
      ['a Harness agent shown', async () => {
        const { core } = inHerdr({ core: harnessAgent() })
        shows('h1')
        return core
      }],
      ['no agent shown', async () => {
        const { core } = inHerdr()
        shows(await listedId())
        shows(null)
        return core
      }],
      ['a hooked agent whose terminal Herdr\'s window does not show', async () => {
        const { core } = inHerdr({ hooked: hook('session-start', 't8'), terminals: [terminal('t7'), terminal('t8', { space: false })] })
        shows(ID)
        return core
      }],
      ['a hooked agent while the devices follow another hc session', async () => {
        vi.stubEnv('HC_SESSION', 'other')
        const { core } = inHerdr({ hooked: hook('session-start') })
        shows(ID)
        return core
      }],
      ['a hooked agent in Ghostty', async () => {
        const { core } = inHerdr({ hooked: { ...hook('session-start'), hostHints: { TERM_PROGRAM: 'ghostty' } } })
        shows(ID)
        return core
      }],
      ['HARNESS_DEVICE_OBSERVED off', async () => {
        const switched = env as { HARNESS_DEVICE_OBSERVED: boolean }
        switched.HARNESS_DEVICE_OBSERVED = false
        onTestFinished(() => { switched.HARNESS_DEVICE_OBSERVED = true })
        const { core } = inHerdr({ hooked: hook('session-start') })
        shows(ID)
        return core
      }],
      ['Linux', async () => {
        const { core } = inHerdr({ orca: { ...onMac, platform: 'linux' }, hooked: hook('session-start') })
        shows(ID)
        return core
      }],
    ])('with %s the stroke goes to the windows as before, velocity and all, and herdr-app is not asked', async (_, situation) => {
      const core = await situation()
      stroke([8], 300)
      expect(dialScrolls(core)).toEqual([toWindows('down', 0, 0), toWindows('move', 8, 0), toWindows('up', 0, 300)])
      expect(orcaRuns.filter(([, args]) => args[0] === 'status' || args[1] === 'terminal.scroll')).toEqual([])
    })

    it('the route holds from down to up', async () => {
      const { core } = inHerdr()
      const id = await listedId()
      shows(id)
      // Herdr leaves the front after the down, and the dial moves to another agent: the stroke still scrolls t7.
      host().scrolled('down', 0, 0)
      host().front('ghostty')
      shows('h1')
      host().scrolled('move', 8, 0)
      await vi.advanceTimersByTimeAsync(32)
      host().scrolled('move', 8, 0)
      await vi.advanceTimersByTimeAsync(32)
      host().scrolled('up', 0, 0)
      expect(orcaRuns).toEqual([STATUS, scrolled('t7', -1), scrolled('t7', -1)])
      expect(dialScrolls(core)).toEqual([])
      // A stroke that began on the windows stays there when Herdr comes in front.
      shows(id)
      host().scrolled('down', 0, 0)
      host().front('herdr')
      host().scrolled('move', 8, 0)
      host().scrolled('up', 0, 120)
      expect(dialScrolls(core)).toEqual([toWindows('down', 0, 0), toWindows('move', 8, 0), toWindows('up', 0, 120)])
      // The up ended that stroke: a move with no down before it chooses by what it finds.
      host().scrolled('move', 8, 0)
      await vi.waitFor(() => expect(orcaRuns).toEqual([STATUS, scrolled('t7', -1), scrolled('t7', -1), STATUS, scrolled('t7', -1)]))
      expect(dialScrolls(core)).toHaveLength(3)
    })

    // The PM's third condition (2026-11-17): a terminal in Herdr's window but not the one on screen is not scrolled. It is
    // matched by tab (2026-11-18): status's agent still named t7 on Diego's first check with another tab shown.
    it('status names another tab than the terminal\'s: the whole stroke goes to the windows as a down, one summed move and the up, no terminal.scroll runs, and the line is said once', async () => {
      const { core, screen } = inHerdr()
      screen.tab = 'tbzzzz'
      shows(await listedId())
      stroke([8, 8, -24], 300)
      await vi.waitFor(() => expect(dialScrolls(core)).toEqual([toWindows('down', 0, 0), toWindows('move', -8, 0), toWindows('up', 0, 300)]))
      expect(orcaRuns).toEqual([STATUS])
      expect(scrollSaid()).toEqual([NOT_ON_SCREEN])
    })

    // The terminal's tab is the one hc's herdr.tab label names now.
    it.each<[string, Partial<HcTerminal>]>([
      ['moved to another tab', { tab: 'tbbbbb' }],
      ['with no herdr.tab label', { tab: undefined }],
    ])('a terminal hc tells %s is not on screen', async (_, change) => {
      const { core, changed } = inHerdr()
      shows(await listedId())
      changed({ ...CODEX, ...change })
      stroke([8], 300)
      await vi.waitFor(() => expect(dialScrolls(core)).toEqual([toWindows('down', 0, 0), toWindows('move', 8, 0), toWindows('up', 0, 300)]))
      expect(orcaRuns).toEqual([STATUS])
      expect(scrollSaid()).toEqual([NOT_ON_SCREEN])
    })

    it('a status that fails is not on screen', async () => {
      const { core, screen } = inHerdr()
      screen.code = 1
      shows(await listedId())
      stroke([8, 8, -24], 300)
      await vi.waitFor(() => expect(dialScrolls(core)).toEqual([toWindows('down', 0, 0), toWindows('move', -8, 0), toWindows('up', 0, 300)]))
      expect(orcaRuns).toEqual([STATUS])
      expect(scrollSaid()).toEqual([NOT_ON_SCREEN])
      expect(logs).toContain('[herdr-app] status · failed')
    })

    it('frames that come before the answer are taken as lines at once; those after go line by line', async () => {
      const { screen, answer } = inHerdr()
      screen.held = true
      shows(await listedId())
      host().scrolled('down', 0, 0)
      host().scrolled('move', 8, 0)
      host().scrolled('move', 8, 0)
      answer('tbaaaa')
      await vi.advanceTimersByTimeAsync(32)
      expect(orcaRuns).toEqual([STATUS, scrolled('t7', -2)])
      host().scrolled('move', 8, 0)
      await vi.advanceTimersByTimeAsync(32)
      expect(orcaRuns).toEqual([STATUS, scrolled('t7', -2), scrolled('t7', -1)])
      await vi.advanceTimersByTimeAsync(1_000)
      expect(drained()).toEqual(['[herdr-app] scroll · 3 lines · 2 runs · 0 failed'])
    })

    it.each([
      ['on screen', 'tbaaaa', [scrolled('t7', 1)], []],
      ['not on screen', 'tbzzzz', [], [toWindows('down', 0, 0), toWindows('move', -8, 0), toWindows('up', 0, 0)]],
    ])('an answer after the up decides the whole stroke: %s', async (_, tab, runs, frames) => {
      const { core, screen, answer } = inHerdr()
      screen.held = true
      shows(await listedId())
      stroke([8, 8, -24])
      answer(tab)
      await vi.waitFor(() => {
        expect(orcaRuns).toEqual([STATUS, ...runs])
        expect(dialScrolls(core)).toEqual(frames)
      })
      // The up ended the stroke: the next move asks again.
      host().scrolled('move', 8, 0)
      await vi.waitFor(() => expect(orcaRuns.filter(([, args]) => args[0] === 'status')).toHaveLength(2))
    })

    // A dial may send down after down faster than status answers: one read, and nothing of the stroke left behind sent.
    it.each([
      ['on screen', 'tbaaaa', [STATUS, scrolled('t7', 1)], [], []],
      ['not on screen', 'tbzzzz', [STATUS], [toWindows('down', 0, 0), toWindows('move', -8, 0), toWindows('up', 0, 0)], [NOT_ON_SCREEN]],
    ])('a newer down before the answer drops the stale one: %s', async (_, tab, runs, frames, lines) => {
      const { core, screen, answer } = inHerdr()
      screen.held = true
      shows(await listedId())
      host().scrolled('down', 0, 0)
      host().scrolled('move', 8, 0)
      stroke([-8])
      answer(tab)
      await vi.waitFor(() => {
        expect(orcaRuns).toEqual(runs)
        expect(dialScrolls(core)).toEqual(frames)
      })
      expect(scrollSaid()).toEqual(lines)
    })

    it('a frame after a held up begins a stroke of its own, and the older answer is dropped', async () => {
      const { core, screen, answer } = inHerdr()
      screen.held = true
      shows(await listedId())
      stroke([-8])
      host().scrolled('move', 8, 0)
      answer('tbaaaa')
      await vi.waitFor(() => expect(orcaRuns).toEqual([STATUS, scrolled('t7', -1)]))
      expect(dialScrolls(core)).toEqual([])
    })

    it.each<[string, Array<['down' | 'move' | 'up', number, number]>, unknown[]]>([
      ['a stroke with no travel replays its down and its up alone', [['down', 0, 0], ['up', 0, 0]], [toWindows('down', 0, 0), toWindows('up', 0, 0)]],
      ['a stroke that begins with a move replays no down', [['move', 8, 0], ['up', 0, 0]], [toWindows('move', 8, 0), toWindows('up', 0, 0)]],
    ])('%s', async (_, frames, replayed) => {
      const { core, screen } = inHerdr()
      screen.tab = 'tbzzzz'
      shows(await listedId())
      for (const [phase, dy, velocity] of frames) host().scrolled(phase, dy, velocity)
      await vi.waitFor(() => expect(dialScrolls(core)).toEqual(replayed))
      expect(orcaRuns).toEqual([STATUS])
    })

    it('the held move carries the last move\'s velocity, and a frame after the answer goes as it came', async () => {
      const { core, screen } = inHerdr()
      screen.tab = 'tbzzzz'
      shows(await listedId())
      host().scrolled('down', 0, 0)
      host().scrolled('move', 4, 50)
      host().scrolled('move', 4, 120)
      await vi.waitFor(() => expect(dialScrolls(core)).toEqual([toWindows('down', 0, 0), toWindows('move', 8, 120)]))
      host().scrolled('up', 0, 300)
      expect(dialScrolls(core)).toEqual([toWindows('down', 0, 0), toWindows('move', 8, 120), toWindows('up', 0, 300)])
    })

    it('a fling is not played', async () => {
      const { core } = inHerdr()
      shows(await listedId())
      host().scrolled('down', 0, 0)
      await vi.waitFor(() => expect(orcaRuns).toEqual([STATUS]))
      host().scrolled('up', 8, 900)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(orcaRuns).toEqual([STATUS, scrolled('t7', -1)])
      expect(dialScrolls(core)).toEqual([])
      expect(drained()).toEqual(['[herdr-app] scroll · 1 lines · 1 runs · 0 failed'])
    })

    // Claude Code draws on the alternate screen, where Herdr's view has no history (design §3).
    it('a Claude Code terminal\'s stroke presses its page keys through hc, and herdr-app scrolls nothing', async () => {
      const { core, hc } = inHerdr({ terminals: [terminal('t7')] })
      shows(await listedId())
      // 128 px toward older lines: 320 px of travel, twenty lines, a page.
      stroke([64, 64])
      await vi.waitFor(() => expect(hc.pressed).toEqual([['t7', ['pageup'], 5_000]]))
      expect(orcaRuns).toEqual([STATUS])
      expect(dialScrolls(core)).toEqual([])
      await vi.advanceTimersByTimeAsync(1_000)
      expect(drained()).toEqual(['[herdr-app] scroll · 20 lines · 1 runs · 0 failed'])
    })

    // A key could move the highlighted choice of its question, and the person's Enter would pick it.
    it('a Claude Code terminal that asks takes no key: the stroke goes to the windows, and herdr-app is not asked', async () => {
      const { core, hc } = inHerdr({ terminals: [terminal('t7', { status: 'blocked' })] })
      shows(await listedId())
      stroke([64, 64], 300)
      expect(dialScrolls(core)).toEqual([toWindows('down', 0, 0), toWindows('move', 64, 0), toWindows('move', 64, 0), toWindows('up', 0, 300)])
      expect(orcaRuns).toEqual([])
      expect(hc.pressed).toEqual([])
    })

    // The route is chosen at the down; hc's word that it asks, heard mid-stroke, still stops its keys.
    it('a Claude Code terminal that begins to ask mid-stroke takes no key from then on, and the stroke keeps its route', async () => {
      const { core, hc, changed } = inHerdr({ terminals: [terminal('t7', { status: 'working' })] })
      shows(await listedId())
      host().scrolled('down', 0, 0)
      await vi.waitFor(() => expect(orcaRuns).toEqual([STATUS]))
      host().scrolled('move', 64, 0)
      host().scrolled('move', 64, 0)
      await vi.waitFor(() => expect(hc.pressed).toEqual([['t7', ['pageup'], 5_000]]))
      changed({ status: 'blocked' })
      for (const dy of [64, 64, 64, 64]) {
        await vi.advanceTimersByTimeAsync(50)
        host().scrolled('move', dy, 0)
      }
      host().scrolled('up', 0, 0)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(hc.pressed).toEqual([['t7', ['pageup'], 5_000]])
      expect(dialScrolls(core)).toEqual([])
      expect(drained()).toEqual(['[herdr-app] scroll · 20 lines · 1 runs · 40 failed'])
    })

    it('the Wi-Fi device\'s stroke takes the same route', async () => {
      const { core, port } = inHerdr()
      shows(await listedId())
      port.scroll('down', 0, 0)
      port.scroll('move', 8, 0)
      port.scroll('up', 0, 0)
      await vi.waitFor(() => expect(orcaRuns).toEqual([STATUS, scrolled('t7', -1)]))
      expect(dialScrolls(core)).toEqual([])
    })

    it('a throw on the scroll path is the part\'s, not the dial\'s', () => {
      const { core } = inHerdr()
      vi.mocked(core.clients.sendLocal).mockImplementation(() => { throw new Error('send broken') })
      expect(() => host().scrolled('move', 8, 0)).not.toThrow()
      expect(logs).toContain('[devices] dial failed · send broken')
    })

    it('a throw after the answer is the part\'s', async () => {
      const { core, screen } = inHerdr()
      screen.tab = 'tbzzzz'
      shows(await listedId())
      vi.mocked(core.clients.sendLocal).mockImplementation(() => { throw new Error('send broken') })
      stroke([8])
      await vi.waitFor(() => expect(logs).toContain('[devices] dial failed · send broken'))
      expect(scrollSaid()).toEqual([NOT_ON_SCREEN])
    })

    it.each(['tbaaaa', 'tbzzzz'])('the devices stopping drops a stroke still being decided: answered %s', async (tab) => {
      const { core, port, screen, answer } = inHerdr()
      screen.held = true
      shows(await listedId())
      host().scrolled('down', 0, 0)
      host().scrolled('move', 8, 0)
      await port.stop()
      answer(tab)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(orcaRuns).toEqual([STATUS])
      expect(dialScrolls(core)).toEqual([])
      expect(scrollSaid()).toEqual([])
    })

    // The stop awaits its listener's close before the cable stops, and the dial still sends frames meanwhile.
    it('a stroke begun while the devices stop goes to the windows, and herdr-app is not asked', async () => {
      const { core, port } = inHerdr()
      shows(await listedId())
      const stopping = port.stop()
      host().scrolled('down', 0, 0)
      host().scrolled('move', 8, 0)
      await stopping
      await vi.advanceTimersByTimeAsync(5_000)
      expect(orcaRuns).toEqual([])
      expect(dialScrolls(core)).toEqual([toWindows('down', 0, 0), toWindows('move', 8, 0)])
      expect(scrollSaid()).toEqual([])
    })

    it('a stroke Herdr took before the stop runs nothing more once the stop began', async () => {
      const { core, port } = inHerdr()
      shows(await listedId())
      host().scrolled('down', 0, 0)
      host().scrolled('move', 8, 0)
      await vi.advanceTimersByTimeAsync(32)
      expect(orcaRuns).toEqual([STATUS, scrolled('t7', -1)])
      const stopping = port.stop()
      host().scrolled('move', 24, 0)
      host().scrolled('up', 0, 0)
      await stopping
      await vi.advanceTimersByTimeAsync(5_000)
      expect(orcaRuns).toEqual([STATUS, scrolled('t7', -1)])
      expect(dialScrolls(core)).toEqual([])
    })

    // The lines of a run's 50 ms gap wait in the adapter's queue, past the routing's own check.
    it('the lines Herdr holds for a run\'s gap at the stop never run', async () => {
      const { core, port } = inHerdr()
      shows(await listedId())
      host().scrolled('down', 0, 0)
      host().scrolled('move', 8, 0)
      await vi.advanceTimersByTimeAsync(10)
      host().scrolled('move', 16, 0)
      expect(orcaRuns).toEqual([STATUS, scrolled('t7', -1)])
      await port.stop()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(orcaRuns).toEqual([STATUS, scrolled('t7', -1)])
      expect(dialScrolls(core)).toEqual([])
    })

    // A window that heard the down before the stop hears the up during it: it never holds a drag.
    it('a stroke the windows took before the stop keeps its route to its up', async () => {
      const { core, port } = inHerdr()
      const id = await listedId()
      // No agent shown at the down: the stroke is the windows'. The dial then moves to Herdr's agent.
      host().scrolled('down', 0, 0)
      shows(id)
      const stopping = port.stop()
      host().scrolled('up', 0, 0)
      await stopping
      await vi.advanceTimersByTimeAsync(5_000)
      expect(dialScrolls(core)).toEqual([toWindows('down', 0, 0), toWindows('up', 0, 0)])
      expect(orcaRuns).toEqual([])
    })

    it('no line about a scroll holds the terminal\'s address', async () => {
      const { screen } = inHerdr()
      shows(await listedId())
      stroke([8, 8])
      await vi.advanceTimersByTimeAsync(1_000)
      expect(drained()).toEqual(['[herdr-app] scroll · 2 lines · 1 runs · 0 failed'])
      screen.tab = 'tbzzzz'
      stroke([8])
      await vi.waitFor(() => expect(scrollSaid()).toEqual([NOT_ON_SCREEN]))
      screen.code = 1
      stroke([8])
      await vi.waitFor(() => expect(logs).toContain('[herdr-app] status · failed'))
      expect(logs.filter((line) => /scroll|status/.test(line) && line.includes('t7'))).toEqual([])
    })
  })
})

describe('cmux\'s agents, from cmux\'s own stores (docs/plans/2026-11-17-dial-cmux-design.md)', () => {
  // cmux prints its ids in upper case; a store or a link may hold lower.
  const W = '5A1B2C3D-0000-4000-8000-00000000000A'
  const S = '9F8E7D6C-0000-4000-8000-00000000000B'
  const w = W.toLowerCase()
  const s = S.toLowerCase()
  const ID = observedAgentId('claude', 'sess-1')
  /** An agent cmux lists: Claude Code idle at its prompt in /work/api, alive as this process is. */
  const record = (over: Partial<CmuxSession> = {}): CmuxSession =>
    ({ word: 'claude', kind: 'claude', surface: S, workspace: W, pid: process.pid, lifecycle: 'idle', updatedAt: 1, cwd: '/work/api', ...over })
  const IDLE: CmuxInputState = { terminal: true, agent: true, lifecycle: 'idle', state: 'empty', blocksTyping: false }
  /** cmux's own terminal: it gives its programs TERM_PROGRAM=ghostty, and its two ids. */
  const IN_CMUX = { TERM_PROGRAM: 'ghostty', CMUX_SURFACE_ID: S, CMUX_WORKSPACE_ID: W }
  /** Claude Code's hook, from cmux's own terminal unless other hints are given. */
  const hook = (event: ObservedHookEvent['event'], hostHints: Record<string, string> = IN_CMUX): ObservedHookEvent => ({
    engine: 'claude', sessionId: 'sess-1', event, cwd: '/work/api', callerPid: 4242, transcriptPath: '/t/sess-1.jsonl', hostHints,
  })
  /** On macOS, each app's command on the path: what a tap runs is read in `orcaRuns`. */
  const onMac = { ...orca, platform: 'darwin' as const, onPath: (name: string) => `/opt/${name}/bin/${name}` }
  /** The one run of a tap or a rest: cmux's link, sent to cmux alone. */
  const link = (workspace = W, surface = S): [string, string[], number] =>
    ['/usr/bin/open', ['-b', 'com.cmuxterm.app', `cmux://workspace/${workspace}/surface/${surface}`], 10_000]
  const host = () => seen.dial as unknown as DaemonCableHost
  /** A dial on the cable, on this computer's agents: no window. */
  const attach = (port: DevicesPort) => { seen.host.watching!(true); port.swarms(null) }
  const listed = async () => (await host().listAgentSnapshot()).agents.map(({ id, name, caps }) => ({ id, name, caps }))
  const said = () => logs.filter((line) => line.startsWith('[device] '))
  const brings = () => logs.filter((line) => line.includes('app filter: bring'))
  /** The watches on the folder cmux's stores live in, in the suite's throwaway home: herdr and hc have folders of their own. */
  const storesWatched = () => watched.calls.filter(([where]) => (where as { socketPath: string }).socketPath === join(homedir(), '.cmuxterm', 'stores'))
  /** Lets the runs and reads under way answer. */
  const flush = () => vi.advanceTimersByTimeAsync(0)
  beforeEach(() => { vi.useFakeTimers() })

  /**
   * The devices with a cmux the test drives, installed, with its stores' folder there, the dial not attached yet. Each call
   * of its client is recorded; `sessions` answers the records of that word (all, with none) unless it is one that fails,
   * `mode` the mode, and the prompt is idle and empty. `live` attaches the dial and lets the first list land; `changed` is the latest watch telling
   * a change of that file, and its run landing: one agent's runs start at least 250 ms apart.
   */
  const withCmux = (over: Parameters<typeof start>[0] = {}) => {
    const fake = { found: true, records: [record()], mode: 'cmuxOnly' as string | undefined, calls: [] as unknown[][],
      failing: [] as Array<string | undefined> }
    const client: CmuxClient = {
      binary: () => fake.found ? CMUX_APP_BINARY : null,
      sessions: async (word) => {
        fake.calls.push(['sessions', word])
        if (fake.failing.includes(word)) return { ok: false, fault: 'failed' }
        return { ok: true, sessions: fake.records.filter((one) => word === undefined || one.word === word) }
      },
      mode: async () => { fake.calls.push(['mode']); return fake.mode },
      inputState: async (surface) => { fake.calls.push(['inputState', surface]); return IDLE },
      paste: async (...args) => { fake.calls.push(['paste', ...args]); return true },
    }
    const folder = join(homedir(), '.cmuxterm')
    mkdirSync(folder, { recursive: true })
    onTestFinished(() => rmSync(folder, { recursive: true, force: true }))
    const started = start({ orca: onMac, tty: async () => undefined, cmux: client, ...over, faults: ['fleet', ...over.faults ?? []] })
    const live = async () => {
      attach(started.port)
      await flush()
    }
    const changed = async (file?: string) => {
      ;(storesWatched().at(-1)![1] as (file?: string) => void)(file)
      await vi.advanceTimersByTimeAsync(250)
    }
    return { ...started, fake, live, changed }
  }
  /** Claude Code's session `sess-1`, running in cmux before the dial came, as its parent processes say, idle since: the
   *  open scan lists it, and no hook gave it a pane. */
  const scanned = () => {
    readers.known.set('sess-1', 'terminal')
    readers.owners.set('sess-1', { engine: 'claude', pid: 4241 })
    readers.rows.set('sess-1', { cwd: '/work/api', transcriptPath: null })
    readers.working.set('sess-1', false)
    readers.apps.mockResolvedValueOnce(new Map([[4241, 'cmux']]))
  }

  it('with a dial attached and cmux found its agents are listed svf, on cmux\'s page; detached, the source stops and its watch is closed', async () => {
    const { fake, live } = withCmux()
    // No dial: cmux is not asked.
    expect(fake.calls).toEqual([])
    await live()
    expect(await listed()).toEqual([{ id: expect.any(String), name: 'api', caps: 'svf' }])
    const [{ id }] = await listed()
    expect(host().hostOf(id)).toBe('cmux')
    expect(host().appOf(id)).toBe('cmux')
    expect(fake.calls).toEqual([['sessions', undefined]])
    expect(storesWatched()).toEqual([[{ socketPath: join(homedir(), '.cmuxterm', 'stores'), home: homedir() }, expect.any(Function)]])
    expect(logs).toContain('[cmux] listed · 1 agents')
    seen.host.watching!(false)
    expect(await listed()).toEqual([])
    expect(watched.stopped).toBe(watched.calls.length)
  })

  it('a failed start reads each store\'s agent alone, so one bad store hides only its own agent', async () => {
    const { fake, live } = withCmux()
    touchStore(homedir(), 'claude')
    touchStore(homedir(), 'codex')
    fake.records = [record(), record({ word: 'codex', kind: 'codex', surface: '9F8E7D6C-0000-4000-8000-00000000000C', cwd: '/work/web' })]
    fake.failing = [undefined, 'codex']
    await live()
    expect(fake.calls.map(([, word]) => word ?? 'all').sort()).toEqual(['all', 'claude', 'codex'])
    expect((await listed()).map(({ name }) => name)).toEqual(['api'])
  })

  it('cmux not installed: nothing is asked and no folder is watched; the next attach looks again', async () => {
    const { port, fake, live } = withCmux()
    fake.found = false
    attach(port)
    expect(fake.calls).toEqual([])
    expect(storesWatched()).toEqual([])
    seen.host.watching!(false)
    fake.found = true
    await live()
    expect(fake.calls).toEqual([['sessions', undefined]])
    expect(storesWatched()).toHaveLength(1)
  })

  /** A dial attached: cmux is not asked, and its stores' folder is not watched. */
  const nothingAsked = ({ port, fake }: ReturnType<typeof withCmux>) => {
    attach(port)
    expect(fake.calls).toEqual([])
    expect(storesWatched()).toEqual([])
  }

  it.each(['linux', 'win32'] as const)('off macOS (%s) there is no cmux source', (platform) => {
    nothingAsked(withCmux({ orca: { ...onMac, platform } }))
  })

  it('with HARNESS_DEVICE_OBSERVED off there is no cmux source', () => {
    const switched = env as { HARNESS_DEVICE_OBSERVED: boolean }
    switched.HARNESS_DEVICE_OBSERVED = false
    onTestFinished(() => { switched.HARNESS_DEVICE_OBSERVED = true })
    nothingAsked(withCmux())
  })

  it('a store\'s change reaches the dial as a card', async () => {
    const { fake, live, changed } = withCmux()
    await live()
    const [{ id }] = await listed()
    fake.records = [record({ lifecycle: 'running' })]
    await changed('claude-hook-sessions.json')
    expect(calls('turnStarted')).toEqual([[id, '', undefined]])
    fake.records = [record({ lifecycle: 'needsInput' })]
    await changed('claude-hook-sessions.json')
    expect(calls('turnStarted')).toEqual([[id, '', undefined], [id, 'Waiting for you · cmux', undefined]])
    fake.records = [record({ lifecycle: 'idle' })]
    await changed('claude-hook-sessions.json')
    expect(calls('turnDone')).toEqual([[id]])
    expect(fake.calls).toEqual([['sessions', undefined], ['sessions', 'claude'], ['sessions', 'claude'], ['sessions', 'claude']])
  })

  it('a tap on a listed agent is one open of cmux\'s link, and is the dial\'s own move', async () => {
    const listener = fakeListener()
    const { live } = withCmux({ listen: listener.listen })
    await live()
    const [{ id }] = await listed()
    // Terminal came forward and reported its tab, which waits on its settle.
    expect(listener.front('terminal-app')).toBeUndefined()
    ;(listener.given[0].handlers.tab as ListenerHandler).handle({ type: 'tab', app: 'terminal-app', tty: '/dev/ttys023' }, never)
    expect(await host().openAgent(id)).toBeUndefined()
    expect(orcaRuns).toEqual([link()])
    // The tap moved the dial since that report: the settle does not pull it back.
    await vi.advanceTimersByTimeAsync(FRONT_SETTLE_MS)
    expect(logs.filter((line) => line.startsWith('[device] tab'))).toEqual(['[device] tab · skipped · echo'])
  })

  it('a rest with cmux in front shows its tab; with another app in front it has no pane', async () => {
    const { live } = withCmux()
    await live()
    const [{ id }] = await listed()
    host().front('cmux')
    expect(host().swipeSwitches(id)).toBe(true)
    host().swipeEnded(id, 'rest')
    await vi.waitFor(() => expect(said()).toContain('[device] swipe · ok'))
    expect(orcaRuns).toEqual([link()])
    host().front('ghostty')
    expect(host().swipeSwitches(id)).toBe(false)
  })

  it('the dial\'s words reach a listed agent through cmux, and are counted cmux', async () => {
    const { fake, live } = withCmux()
    fake.mode = 'automation'
    await live()
    const [{ id }] = await listed()
    expect(await host().sendTurn(id, 'run the tests')).toEqual({ ok: true })
    expect(fake.calls.slice(1)).toEqual([['mode'], ['inputState', S], ['paste', W, S, 'run the tests']])
    expect(said()).toEqual(['[device] voice · cmux'])
  })

  it('with the default mode the dial hears the Automation sentence, counted refused (cmux), and nothing is pasted', async () => {
    const { fake, live } = withCmux()
    await live()
    const [{ id }] = await listed()
    expect(await host().sendTurn(id, 'run the tests')).toMatchObject({ ok: false, message: 'Turn on Automation mode in cmux.' })
    expect(fake.calls.slice(1)).toEqual([['mode']])
    expect(said()).toEqual(['[device] voice · refused (cmux)'])
  })

  it('a hooked agent in cmux is on cmux\'s page with cmux\'s pane, never a tab\'s, and its tap is the link', async () => {
    const { port, fake, live } = withCmux()
    fake.records = []
    port.observed(hook('session-start'))
    await live()
    expect(host().hostOf(ID)).toBe('cmux')
    expect(host().appOf(ID)).toBe('cmux')
    expect(await host().openAgent(ID)).toBeUndefined()
    expect(orcaRuns).toEqual([link()])
  })

  it('a hooked agent cmux also lists is one row, the hook\'s', async () => {
    const { port, fake, live } = withCmux()
    // The hook's ids in upper case, the store's in lower.
    fake.records = [record({ surface: s, workspace: w, sessionId: 'sess-1' })]
    port.observed(hook('session-start'))
    await live()
    expect(logs).toContain('[cmux] listed · 1 agents')
    expect(await listed()).toEqual([{ id: ID, name: 'api', caps: 'svf' }])
  })

  it('a hooked agent with no mod takes the dial\'s words through cmux, and the Automation sentence reaches the dial', async () => {
    const { port, fake, live } = withCmux()
    fake.records = []
    port.observed(hook('turn-stop'))
    await live()
    expect(await host().sendTurn(ID, 'run the tests')).toMatchObject({ ok: false, message: 'Turn on Automation mode in cmux.' })
    expect(fake.calls.slice(1)).toEqual([['mode']])
    expect(said()).toContain('[device] voice · refused (cmux)')
  })

  // The open scan lists Claude Code's session before any hook of it (each restart, for every agent sitting idle), and its
  // copy wins the fold over cmux's row by its session id (the design's decided 7).
  it('a session the open scan found and cmux lists is one row, the scan\'s, placed at cmux\'s tab: a tap is one open of cmux\'s link from the first list', async () => {
    const { fake, live } = withCmux()
    fake.records = [record({ surface: s, workspace: w, sessionId: 'sess-1' })]
    scanned()
    await live()
    expect((await listed()).map(({ id }) => id)).toEqual([ID])
    expect(await host().openAgent(ID)).toBeUndefined()
    expect(orcaRuns).toEqual([link(w, s)])
  })

  it('a rest with cmux in front shows the placed session\'s tab, and the dial\'s words for it never reach cmux', async () => {
    const { fake, live } = withCmux()
    fake.mode = 'automation'
    fake.records = [record({ surface: s, workspace: w, sessionId: 'sess-1' })]
    scanned()
    await live()
    host().front('cmux')
    expect(host().swipeSwitches(ID)).toBe(true)
    host().swipeEnded(ID, 'rest')
    await vi.waitFor(() => expect(said()).toContain('[device] swipe · ok'))
    expect(orcaRuns).toEqual([link(w, s)])
    expect(await host().sendTurn(ID, 'run the tests')).toMatchObject({ ok: false })
    expect(fake.calls).toEqual([['sessions', undefined]])
  })

  it('the place goes when cmux no longer lists that session, and a hook from its cmux terminal gives it a pane of its own', async () => {
    const { port, fake, live, changed } = withCmux()
    fake.records = [record({ surface: s, workspace: w, sessionId: 'sess-1' })]
    scanned()
    await live()
    fake.records = []
    await changed('claude-hook-sessions.json')
    // No pane and no app a hook named: nothing to open.
    expect(await host().openAgent(ID)).toMatchObject({ ok: false })
    expect(orcaRuns).toEqual([])
    port.observed(hook('turn-stop'))
    expect(await host().openAgent(ID)).toBeUndefined()
    expect(orcaRuns).toEqual([link()])
    expect(await host().sendTurn(ID, 'run the tests')).toMatchObject({ ok: false, message: 'Turn on Automation mode in cmux.' })
    expect(fake.calls).toContainEqual(['mode'])
  })

  it('the last dial gone, a scanned session\'s tap opens no cmux link: every place goes with cmux\'s rows', async () => {
    const { fake, live } = withCmux()
    fake.records = [record({ surface: s, workspace: w, sessionId: 'sess-1' })]
    scanned()
    await live()
    seen.host.watching!(false)
    await flush()
    await host().openAgent(ID)
    expect(orcaRuns.filter(([, args]) => args.some((arg) => arg.startsWith('cmux://')))).toEqual([])
  })

  it('with cmux stopped, an observed agent\'s changes place nothing in cmux', () => {
    const places = vi.spyOn(ObservedSource.prototype, 'setPaneNames')
    onTestFinished(() => places.mockRestore())
    const { port } = withCmux()
    port.observed(hook('session-start', { TERM_PROGRAM: 'ghostty' }))
    port.observed(hook('turn-stop', { TERM_PROGRAM: 'ghostty' }))
    expect(places.mock.calls.filter(([adapter]) => adapter === 'cmux')).toEqual([])
  })

  // tmux comes before cmux: its pane is the nearer, and cmux's place of the same agent is its surface, which holds tmux.
  it('tmux inside a cmux terminal keeps tmux\'s pane, on cmux\'s page', async () => {
    const { port, fake, live } = withCmux()
    fake.records = [record({ sessionId: 'sess-1' })]
    port.observed(hook('session-start', { ...IN_CMUX, TMUX_PANE: '%3', TERM_PROGRAM: 'tmux', __CFBundleIdentifier: 'com.cmuxterm.app' }))
    await live()
    expect(logs).toContain('[cmux] listed · 1 agents')
    expect(host().hostOf(ID)).toBe('tmux')
    expect(host().appOf(ID)).toBe('cmux')
    expect(await host().openAgent(ID)).toBeUndefined()
    expect(orcaRuns[0][0]).toBe('tmux')
    expect(orcaRuns.filter(([, args]) => args.some((arg) => arg.startsWith('cmux://')))).toEqual([])
  })

  it('a pick of cmux brings cmux forward', async () => {
    const { port, live } = withCmux()
    await live()
    // Ghostty's two agents keep cmux's ring from being the one shown: the pick switches to it.
    for (const sessionId of ['g-1', 'g-2']) {
      port.observed({ engine: 'claude', sessionId, event: 'session-start', cwd: '/work/web', callerPid: 4243,
        transcriptPath: `/t/${sessionId}.jsonl`, hostHints: { TERM_PROGRAM: 'ghostty' } })
    }
    expect((await host().listAgentSnapshot({ apps: true })).apps?.shown).toBe('ghostty')
    expect(host().pickApp('cmux')).toBe('switched')
    await vi.waitFor(() => expect(brings()).toEqual(['[device] app filter: bring · ok']))
    expect(orcaRuns).toEqual([['/usr/bin/open', ['-b', 'com.cmuxterm.app'], 10_000]])
  })

  // A daemon started from a cmux terminal carries its CMUX_* variables: a mode override, another stores' folder.
  describe.skipIf(process.platform === 'win32')('with no client given', () => {
    it('the devices run the cmux on PATH, with no CMUX_* variable', async () => {
      vi.useRealTimers()
      const cmux = fakeCmux()
      onTestFinished(() => cmux.remove())
      cmux.set({ sessions: [{ agent: 'claude', surface_id: S, workspace_id: W, pid: process.pid }] })
      vi.stubEnv('PATH', `${cmux.dir}${delimiter}${process.env.PATH ?? ''}`)
      vi.stubEnv('CMUX_SOCKET_MODE', 'allowAll')
      vi.stubEnv('CMUX_AGENT_HOOK_STATE_DIR', join(dataDir, 'other-stores'))
      const { port } = withCmux({ cmux: null })
      attach(port)
      await vi.waitFor(() => expect(logs).toContain('[cmux] listed · 1 agents'), { timeout: 10_000 })
      expect(cmux.calls()).toEqual([{ args: ['sessions', 'list', '--json', '--all'], stdin: '', env: [] }])
    })
  })
})

describe("opencode's sessions, over its local server (docs/plans/2026-11-17-dial-opencode-design.md)", () => {
  const SES = 'ses_a1'
  /** On macOS, each app's command on the path but `herdr-app`, so Herdr Core's source does not start: what a tap runs is
   *  read in `orcaRuns`. */
  const onMac = { ...orca, platform: 'darwin' as const, onPath: (name: string) => (name === 'herdr-app' ? null : `/opt/${name}/bin/${name}`) }
  const host = () => seen.dial as unknown as DaemonCableHost
  /** A dial on the cable, on this computer's agents: no window. */
  const attach = (port: DevicesPort) => { seen.host.watching!(true); port.swarms(null) }
  const listed = async () => (await host().listAgentSnapshot()).agents.map(({ id, name, caps }) => ({ id, name, caps }))
  const said = () => logs.filter((line) => line.startsWith('[device] '))
  /** A session as opencode's list reads it (Session.Info): at rest in /work/api, viewed since its last turn ended. */
  const session = (over: Record<string, unknown> = {}, time: Record<string, number> = {}) => {
    const now = Date.now()
    return { id: SES, projectID: 'prj_1', cost: 0, title: 'Fix the login test', location: { directory: '/work/api' },
      time: { created: now - 120_000, updated: now - 60_000, idle: now - 60_000, viewed: now - 30_000, ...time }, ...over }
  }
  beforeEach(() => { vi.useFakeTimers() })

  /**
   * The devices with an opencode the test drives, the dial not attached yet. Its service.json is there (`stamp`). Each
   * stream keeps its callbacks and whether it was closed; the list, the running sessions, the permissions and the last
   * answers are the test's own values, in the shapes of opencode v2.3.0; a prompt is recorded and answers the next of
   * `prompts`, else sent. `live` attaches the dial, says the stream is connected and waits for the list it asks; `tell` is
   * an event on the first stream; `reads` counts the last answers read.
   */
  const withOpencode = (over: Parameters<typeof start>[0] = {}) => {
    const streams: Array<{ onEvent: (event: OpencodeEvent) => void; onClose: (reason: OpencodeFault | 'ended') => void; closed: boolean }> = []
    const oc = {
      sessions: [session()] as unknown[], active: {} as Record<string, unknown>, permissions: {} as Record<string, unknown[]>,
      answers: { [SES]: 'All 12 tests pass.' } as Record<string, string>, asked: [] as unknown[][], prompts: [] as OpencodePrompt[], streams,
    }
    const ok = (data: unknown): OpencodeAnswer => ({ ok: true, json: { data, cursor: {} } })
    const client: OpencodeClient = {
      registration: () => { oc.asked.push(['registration']); return { stamp: 's1' } },
      find: async () => { oc.asked.push(['find']); return { stamp: 's1' } },
      request: async (method, path) => {
        oc.asked.push(['request', method, path])
        if (path.startsWith('/api/session?')) return ok(oc.sessions)
        if (path === '/api/session/active') return ok(oc.active)
        const [, id, what] = /^\/api\/session\/([^/]+)\/(permission|message)/.exec(path)!
        if (what === 'permission') return ok(oc.permissions[id] ?? [])
        const text = oc.answers[id]
        return ok(text === undefined ? [] : [{ id: 'msg_1', type: 'assistant', time: { created: 1 }, agent: 'build',
          model: { id: 'm', providerID: 'p' }, content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text }] }])
      },
      events: (onEvent, onClose) => {
        const stream = { onEvent, onClose, closed: false }
        streams.push(stream)
        return { close: () => { stream.closed = true } }
      },
      prompt: async (...args) => {
        oc.asked.push(['prompt', ...args])
        return oc.prompts.shift() ?? 'sent'
      },
    }
    const started = start({ orca: onMac, tty: async () => undefined, opencode: client, ...over, faults: ['fleet', ...over.faults ?? []] })
    const tell = (type: string, data: Record<string, unknown> = {}): void => streams[0].onEvent({ type, data })
    const live = async (sessions: unknown[] = [session()]): Promise<void> => {
      oc.sessions = sessions
      const from = logs.length
      attach(started.port)
      await vi.waitFor(() => expect(streams).toHaveLength(1))
      tell('server.connected')
      await vi.waitFor(() => expect(logs.slice(from)).toContainEqual(expect.stringMatching(/^\[opencode\] listed · /)))
    }
    const reads = () => oc.asked.filter(([what, , path]) => what === 'request' && String(path).includes('/message')).length
    return { ...started, oc, live, tell, reads }
  }

  it('with a dial attached opencode\'s sessions are listed sv, on the opencode page; detached, the source stops', async () => {
    const { oc, live } = withOpencode()
    // No dial: opencode is not asked.
    expect(oc.asked).toEqual([])
    await live()
    expect(await listed()).toEqual([{ id: expect.any(String), name: 'Fix the login test', caps: 'sv' }])
    expect((await host().listAgentSnapshot()).agents).toEqual([expect.objectContaining({ engine: 'opencode', host: 'opencode' })])
    expect((await host().listAgentSnapshot({ apps: true })).apps?.apps).toContainEqual({ id: 'opencode', name: 'opencode', count: 1, waiting: 0 })
    expect(logs).toContain('[opencode] listed · 1 sessions')
    seen.host.watching!(false)
    expect(oc.streams.map(({ closed }) => closed)).toEqual([true])
    expect(await listed()).toEqual([])
    expect(watchedFolders.stopped).toBe(1)
  })

  it('a turn is its cards', async () => {
    const { oc, live, tell } = withOpencode()
    await live()
    const [{ id }] = await listed()
    tell('session.execution.started', { sessionID: SES })
    expect(calls('turnStarted')).toEqual([[id, '', undefined]])
    tell('permission.asked', { sessionID: SES, id: 'per_1', action: 'bash' })
    expect(calls('turnStarted')).toEqual([[id, '', undefined], [id, 'Waiting for you · opencode', undefined]])
    expect(await host().activityText(id)).toBe('Waiting for you · opencode')
    tell('permission.replied', { sessionID: SES, requestID: 'per_1', reply: 'once' })
    oc.answers[SES] = 'Fixed the flaky test.'
    tell('session.execution.succeeded', { sessionID: SES })
    expect(calls('turnDone')).toEqual([[id]])
    await vi.waitFor(() => expect(calls('summary')).toEqual([[id, 'Fixed the flaky test.', 'Fixed the flaky test.', 'alert', 'Fixed the flaky test.', false]]))
  })

  it('a session first listed done, with its last answer, gets no card, and the tile\'s history has the answer', async () => {
    const { live } = withOpencode()
    await live([session({}, { viewed: Date.now() - 90_000 })])
    const [{ id }] = await listed()
    expect(calls('turnDone')).toEqual([])
    expect(calls('summary')).toEqual([])
    expect(await host().recentSummaries(id)).toEqual([{ recap: 'All 12 tests pass.', text: 'All 12 tests pass.', ask: '', fullText: 'All 12 tests pass.' }])
  })

  // opencode's last assistant message is then the turn before's: kept, it tells the dial nothing new.
  it('a turn interrupted before any answer is a done card and no summary', async () => {
    const { live, tell, reads } = withOpencode()
    await live()
    const [{ id }] = await listed()
    tell('session.execution.started', { sessionID: SES })
    tell('session.execution.interrupted', { sessionID: SES })
    expect(calls('turnDone')).toEqual([[id]])
    await vi.waitFor(() => expect(reads()).toBe(2))
    // The read's answer lands within a real tick, which this one lets pass.
    await vi.advanceTimersByTimeAsync(0)
    expect(calls('summary')).toEqual([])
  })

  it('an opencode session mid-turn is reminded', async () => {
    const { live, tell } = withOpencode()
    await live()
    const [{ id }] = await listed()
    tell('session.execution.started', { sessionID: SES })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(calls('turnStarted')).toEqual([[id, '', undefined], [id, '', undefined]])
  })

  it('a session Harness started is one row, Harness\'s, and gets no card as opencode\'s', async () => {
    const core = fakeCore({ dataDir, agents: { advertised: vi.fn(() => [{ agentId: 'h1', registeredAt: 1, engine: 'opencode', sessionId: SES }] as RegisteredSession[]) } })
    const { port, live, tell } = withOpencode({ core })
    port.swarms(null)
    await host().listAgentSnapshot()
    await live()
    expect((await listed()).map(({ id }) => id)).toEqual(['h1'])
    tell('session.execution.started', { sessionID: SES })
    expect(calls('turnStarted').filter(([agentId]) => agentId !== 'h1')).toEqual([])
  })

  it('a session first listed mid-turn gets its card once the dial\'s list holds it', async () => {
    const { oc, live } = withOpencode()
    oc.active = { [SES]: { type: 'busy' } }
    await live()
    const [{ id }] = await listed()
    await vi.waitFor(() => expect(calls('turnStarted')).toEqual([[id, '', undefined]]))
  })

  // A build that fails says nothing of the session: its first cards go, and nothing of it is held after.
  it('a session first listed while the dial\'s list fails to build has its next cards told', async () => {
    const { oc, live, tell } = withOpencode()
    oc.active = { [SES]: { type: 'busy' } }
    const build = vi.spyOn(host(), 'listAgentSnapshot').mockRejectedValue(new Error('the fleet is gone'))
    await live()
    await vi.advanceTimersByTimeAsync(0)
    build.mockRestore()
    const [{ id }] = await listed()
    oc.active = {}
    tell('session.execution.succeeded', { sessionID: SES })
    expect(calls('turnDone')).toEqual([[id]])
  })

  // The devices' copy of the core's agents is read again only at a list build: opencode lists a new session's first turn
  // before the copy holds the session Harness bound to it.
  it('a session Harness started gets no card as opencode\'s before the dial\'s list binds it', async () => {
    const h1 = { agentId: 'h1', registeredAt: 1, engine: 'opencode' }
    let view = [h1] as RegisteredSession[]
    const core = fakeCore({ dataDir, agents: { advertised: vi.fn(() => view) } })
    const refresh = async () => { view = [{ ...h1, sessionId: SES }] as RegisteredSession[] }
    const { oc, live, tell } = withOpencode({ core, refresh })
    oc.active = { [SES]: { type: 'busy' } }
    await live()
    oc.active = {}
    oc.answers[SES] = 'Fixed the flaky test.'
    tell('session.execution.succeeded', { sessionID: SES })
    expect((await listed()).map(({ id }) => id)).toEqual(['h1'])
    await vi.advanceTimersByTimeAsync(0)
    const others = (kind: string) => calls(kind).filter(([agentId]) => agentId !== 'h1')
    expect([others('turnStarted'), others('turnDone'), others('summary')]).toEqual([[], [], []])
  })

  it('the dial\'s words reach a session at rest, and each refusal is said once', async () => {
    const { oc, live, tell } = withOpencode()
    await live()
    const [{ id }] = await listed()
    expect(await host().sendTurn(id, 'run the tests')).toEqual({ ok: true })
    expect(oc.asked.filter(([what]) => what === 'prompt')).toEqual([['prompt', SES, 'run the tests', expect.stringMatching(OPENCODE_MESSAGE)]])
    expect(said()).toEqual(['[device] voice · opencode'])
    tell('session.execution.started', { sessionID: SES })
    expect(await host().sendTurn(id, 'run the tests')).toMatchObject({ ok: false, message: 'Fix the login test is busy. Say it when it is done.' })
    tell('permission.asked', { sessionID: SES, id: 'per_1' })
    expect(await host().sendTurn(id, 'run the tests')).toMatchObject({ ok: false, message: 'Fix the login test is waiting for your answer in opencode.' })
    tell('session.execution.succeeded', { sessionID: SES })
    expect(await host().sendTurn(id, 'x'.repeat(2001))).toMatchObject({ ok: false, message: 'Too long. Say it shorter.' })
    oc.prompts.push('failed')
    expect(await host().sendTurn(id, 'run the tests')).toMatchObject({ ok: false, message: 'Fix the login test did not answer.' })
    expect(said()).toEqual(['[device] voice · opencode', '[device] voice · busy', '[device] voice · waiting', '[device] voice · too-long',
      '[device] voice · no-answer'])
    // Refused by its state, nothing was posted.
    expect(oc.asked.filter(([what]) => what === 'prompt')).toHaveLength(2)
  })

  it('a tap opens nothing', async () => {
    const { live } = withOpencode()
    await live()
    const [{ id }] = await listed()
    expect(await host().openAgent(id)).toEqual({ ok: false, error: 'opencode did not open it.' })
    expect(orcaRuns).toEqual([])
  })

  it('turning the dial to a done session marks it seen here, and asks opencode nothing', async () => {
    const begun = vi.spyOn(OpencodeSource.prototype, 'start')
    const { oc, live } = withOpencode()
    await live([session({}, { viewed: Date.now() - 90_000 })])
    const source = begun.mock.contexts[0] as OpencodeSource
    const [{ id }] = await listed()
    expect(source.list()).toEqual([expect.objectContaining({ id, state: 'done', unseenDone: true })])
    const asked = oc.asked.length
    turnTo(id)
    expect(source.list()).toEqual([expect.objectContaining({ id, state: 'done', unseenDone: false })])
    expect(oc.asked).toHaveLength(asked)
    expect(oc.streams).toHaveLength(1)
  })

  it('HARNESS_DEVICE_OBSERVED=off: nothing is read, asked or watched', () => {
    const switched = env as { HARNESS_DEVICE_OBSERVED: boolean }
    switched.HARNESS_DEVICE_OBSERVED = false
    onTestFinished(() => { switched.HARNESS_DEVICE_OBSERVED = true })
    const { oc, port } = withOpencode()
    attach(port)
    seen.host.watching!(false)
    attach(port)
    expect(oc.asked).toEqual([])
    expect(oc.streams).toEqual([])
    expect(watchedFolders.calls).toEqual([])
  })

  // The desktop app runs opencode's service with no `opencode` command installed.
  it('it runs with no opencode on PATH, and on Windows', async () => {
    const away = withOpencode({ orca: { ...onMac, onPath: () => null } })
    await away.live()
    expect(await listed()).toEqual([{ id: expect.any(String), name: 'Fix the login test', caps: 'sv' }])
    const windows = withOpencode({ orca: { ...onMac, platform: 'win32' } })
    await windows.live()
    expect(await listed()).toEqual([{ id: expect.any(String), name: 'Fix the login test', caps: 'sv' }])
  })

  // P5: a watch above them, on ~/.local or the home folder, would wake the devices on every write below it on macOS.
  it('only the folder of service.json and the state folder above it are watched, while a dial is attached', () => {
    const { port } = withOpencode()
    const path = opencodeClientDeps().servicePath
    const folders = [dirname(path), dirname(dirname(path))]
    expect(watchedFolders.calls).toEqual([])
    attach(port)
    expect(watchedFolders.calls).toEqual([[folders, expect.any(Function)]])
    seen.host.watching!(false)
    expect(watchedFolders.stopped).toBe(1)
    // A state folder made while neither was there is watched from the next attach.
    attach(port)
    expect(watchedFolders.calls.map(([watched]) => watched)).toEqual([folders, folders])
  })

  it('a state folder that is the home folder or a disk\'s root is not watched', () => {
    onTestFinished(() => { vi.unstubAllEnvs() })
    for (const state of [homedir(), parse(homedir()).root]) {
      vi.stubEnv('XDG_STATE_HOME', state)
      watchedFolders.calls.length = 0
      attach(withOpencode().port)
      expect(watchedFolders.calls).toEqual([[[join(state, 'opencode')], expect.any(Function)]])
    }
  })

  it('the devices stopping stops the source', async () => {
    const { port, oc, live } = withOpencode()
    await live()
    await port.stop()
    expect(oc.streams.map(({ closed }) => closed)).toEqual([true])
    expect(watchedFolders.stopped).toBe(1)
  })

  it('an opencode part that throws costs the dial nothing', async () => {
    const { port, oc } = withOpencode({ faults: ['opencode'] })
    port.observed({ engine: 'claude', sessionId: 'sess-1', event: 'session-start', cwd: '/work/web', callerPid: 4242,
      transcriptPath: '/t/sess-1.jsonl', hostHints: {} })
    attach(port)
    expect(oc.streams).toEqual([])
    expect(logs).toContain('[devices] opencode failed · injected fault: opencode')
    expect((await listed()).map(({ id }) => id)).toEqual([observedAgentId('claude', 'sess-1')])
  })

  it('no log line holds a session id, a title, a folder or the words', async () => {
    const { oc, live, tell } = withOpencode()
    await live([session({ id: 'ses_secret1', title: 'Nebula', location: { directory: '/work/secret-folder' } })])
    const [{ id }] = await listed()
    tell('session.execution.started', { sessionID: 'ses_secret1' })
    tell('permission.asked', { sessionID: 'ses_secret1', id: 'per_secret2' })
    await host().sendTurn(id, 'run the secret tests')
    tell('session.execution.succeeded', { sessionID: 'ses_secret1' })
    await host().sendTurn(id, 'run the secret tests')
    await host().openAgent(id)
    oc.streams[0].onClose('ended')
    expect(logs).toEqual(expect.arrayContaining(['[opencode] listed · 1 sessions', '[device] voice · waiting', '[device] voice · opencode',
      '[opencode] closed · ended', '[opencode] retry · 1']))
    const secrets = ['ses_secret1', 'per_secret2', 'Nebula', 'secret-folder', 'secret tests']
    expect(logs.filter((line) => secrets.some((secret) => line.includes(secret)))).toEqual([])
  })
})

describe('the dial setup, from the devices\' own process (cable/dialSetup.ts)', () => {
  let homes: string
  let saved: { claude: string; codex: string }
  beforeEach(() => {
    homes = mkdtempSync(join(tmpdir(), 'dial-homes-'))
    saved = { claude: env.CLAUDE_PROJECTS_DIR, codex: env.CODEX_HOME }
    env.CLAUDE_PROJECTS_DIR = join(homes, 'claude', 'projects')
    env.CODEX_HOME = join(homes, 'codex')
    mkdirSync(env.CODEX_HOME)
  })
  afterEach(() => {
    env.CLAUDE_PROJECTS_DIR = saved.claude
    env.CODEX_HOME = saved.codex
    rmSync(homes, { recursive: true, force: true })
  })
  const held = (home: string): string | undefined => {
    const file = join(home, 'skills', 'dial', 'SKILL.md')
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined
  }
  const claudeHome = () => dirname(env.CLAUDE_PROJECTS_DIR)
  /** A dial attached on this computer once. */
  const dialOnce = () => writeSetup(dataDir, { dial: true, homes: { claude: [], codex: [] }, pluginHomes: [] })
  /** A `claude` 2.1.287 with no plugin yet: each call recorded, and each home it was looked for in. */
  const fakeClaude = () => {
    const calls: string[] = []
    const looked: string[] = []
    const run: ClaudeRun = async (args) => {
      calls.push(args.join(' '))
      return { code: 0, stdout: args[0] === '--version' ? '2.1.287 (Claude Code)\n' : args.includes('--json') ? '[]' : '', stderr: '' }
    }
    const found: NonNullable<DevicesDeps['claude']> = async (home) => {
      looked.push(home)
      return run
    }
    return { calls, looked, found }
  }

  it('a dial\'s first attach sets the agents up', async () => {
    const claude = fakeClaude()
    start({ faults: ['fleet'], listen: fakeListener().listen, claude: claude.found })
    expect(held(env.CODEX_HOME)).toBeUndefined()

    seen.host.watching!(true)

    expect(held(env.CODEX_HOME)).toBe(DIAL_SKILL)
    await vi.waitFor(() => expect(claude.calls).toContain('plugin install harness-device@openharness --scope user'))
    expect(claude.looked).toEqual([claudeHome()])
    expect(logs).toContain('[device] dial setup · codex · set up')
    expect(logs).toContainEqual(expect.stringMatching(/^\[device\] dial setup · day \d{4}-\d\d-\d\d · claude set up 0 updated 0 failed 0 left removed 0 · codex set up 1 updated 0 failed 0 left removed 0$/))
  })

  it('the dial setup is given Orca\'s Claude Code homes and whether the read answered', async () => {
    const home = join(homes, 'orca-claude')
    mkdirSync(home)
    // The default home's plugin on, as the install leaves it: Orca's homes follow it.
    mkdirSync(claudeHome())
    writeFileSync(join(claudeHome(), 'settings.json'), JSON.stringify({ enabledPlugins: { 'harness-device@openharness': true } }))
    const claude = fakeClaude()
    const read = fakeOrcaHomes({ claude: [home], codex: [] })
    start({ faults: ['fleet'], listen: fakeListener().listen, claude: claude.found, orcaHomes: read })

    seen.host.watching!(true)

    await vi.waitFor(() => expect(readSetup(dataDir).pluginHomes).toEqual([realpathSync(home)]))
    expect(claude.looked).toEqual([claudeHome(), realpathSync(home)])
    expect(claude.calls).toContain('plugin enable harness-device@openharness --scope user')

    // A read that failed lists no home and drops none from the record; Orca's answer with none does.
    read.homes = { claude: [], codex: [] }
    read.answered = false
    seen.host.watching!(true)
    // The attach's pass, which runs no `claude` here, ends within the tick.
    await new Promise((resolve) => setImmediate(resolve))
    expect(readSetup(dataDir).pluginHomes).toEqual([realpathSync(home)])
    read.homes = { claude: [], codex: [] }
    read.answered = true
    seen.host.watching!(true)
    await vi.waitFor(() => expect(readSetup(dataDir).pluginHomes).toEqual([]))
  })

  it('the devices\' start on a computer that never had a dial writes nothing', async () => {
    // Claude Code's plugin already on, as a person may have turned it on by hand.
    mkdirSync(claudeHome())
    writeFileSync(join(claudeHome(), 'settings.json'), JSON.stringify({ enabledPlugins: { 'harness-device@openharness': true } }))
    const claude = fakeClaude()

    await start({ faults: ['fleet'], listen: fakeListener().listen, claude: claude.found }).orcaHomes.landed()

    expect(held(env.CODEX_HOME)).toBeUndefined()
    expect(held(claudeHome())).toBeUndefined()
    expect(existsSync(join(dataDir, 'dial-setup.json'))).toBe(false)
    expect(claude.looked).toEqual([])
  })

  it('once a dial attached, the devices\' start sets the homes up, once Orca\'s homes are read', async () => {
    dialOnce()
    await start({ faults: ['fleet'], listen: fakeListener().listen }).orcaHomes.landed()
    expect(held(env.CODEX_HOME)).toBe(DIAL_SKILL)
  })

  it('the dial skill reaches an Orca Codex home once the first read lands', async () => {
    dialOnce()
    const orca = join(homes, 'orca-codex')
    mkdirSync(orca)
    const read = fakeOrcaHomes()
    read.held = true
    start({ faults: ['fleet'], listen: fakeListener().listen, orcaHomes: read })
    // The start pass waits for the read.
    expect(held(env.CODEX_HOME)).toBeUndefined()
    read.homes = { claude: [], codex: [orca] }
    read.pending[0](true)
    await read.landed()
    expect(held(orca)).toBe(DIAL_SKILL)
    expect(held(env.CODEX_HOME)).toBe(DIAL_SKILL)
  })

  it('a later read that changes the list runs the start pass again', async () => {
    vi.useFakeTimers()
    dialOnce()
    const orca = join(homes, 'orca-codex')
    mkdirSync(orca)
    const read = fakeOrcaHomes()
    start({ faults: ['fleet'], listen: fakeListener().listen, orcaHomes: read })
    await read.landed()
    // Each scan reads Orca's homes first, so this fake's reads count these devices' scans: a scan of devices an earlier
    // spec left attached is not one.
    seen.host.watching!(true)
    await vi.waitFor(() => expect(read.refresh).toHaveBeenCalledTimes(2))
    // A scan whose read says the list is as it was runs no start pass.
    read.homes = { claude: [], codex: [orca] }
    await vi.advanceTimersByTimeAsync(60_000)
    expect(read.refresh).toHaveBeenCalledTimes(3)
    expect(held(orca)).toBeUndefined()
    read.changed = true
    await vi.advanceTimersByTimeAsync(60_000)
    expect(read.refresh).toHaveBeenCalledTimes(4)
    expect(held(orca)).toBe(DIAL_SKILL)
  })

  it('a read that lands after the devices stopped starts nothing', async () => {
    dialOnce()
    const read = fakeOrcaHomes()
    read.held = true
    const { port } = start({ faults: ['fleet'], listen: fakeListener().listen, orcaHomes: read })
    await port.stop()
    read.pending[0](true)
    await read.landed()
    expect(held(env.CODEX_HOME)).toBeUndefined()
  })

  it('a scan\'s owners reach the dial setup', async () => {
    vi.useFakeTimers()
    // A Codex app-server: no terminal, and no row, in a home the daemon does not know.
    const other = join(homes, 'codex-other')
    mkdirSync(other)
    readers.known.set('cx-app', 'app')
    readers.owners.set('cx-app', { engine: 'codex', pid: 91, tty: null,
      record: join(other, 'sessions', '2026', '11', '16', 'rollout-2026-11-16T00-00-00-a.jsonl') })
    start({ faults: ['fleet'], listen: fakeListener().listen })
    expect(held(other)).toBeUndefined()
    seen.host.watching!(true)
    await vi.waitFor(() => expect(held(other)).toBe(DIAL_SKILL))
  })

  it('with no claude given, the daemon\'s own lookup is used and finds none', async () => {
    // An empty PATH and home: no `claude` of the developer's is found, or run.
    const empty = mkdtempSync(join(homes, 'path-'))
    vi.stubEnv('PATH', empty)
    vi.stubEnv('HOME', empty)
    dialOnce()
    const lookup = vi.spyOn(claudePlugin, 'claudeFound')

    await start({ faults: ['fleet'], listen: fakeListener().listen, claude: null }).orcaHomes.landed()

    expect(held(env.CODEX_HOME)).toBe(DIAL_SKILL)
    // The start's lookup, the process's first: the login shell's PATH is read with it.
    expect(lookup.mock.calls).toEqual([[claudeHome(), true]])
    expect(await lookup.mock.results[0].value).toBeNull()
    await new Promise((resolve) => setImmediate(resolve))
    expect(readSetup(dataDir).plugin).toBeUndefined()
    expect(logs.filter((line) => line.startsWith('[device] dial setup · claude'))).toEqual([])
  })

  it('a process with no uid writes the dial skill into no home', () => {
    // No uid owns a home, so none is taken as this user's.
    vi.spyOn(process, 'getuid').mockReturnValue(undefined as unknown as number)
    start({ faults: ['fleet'], listen: fakeListener().listen })
    seen.host.watching!(true)
    expect(held(env.CODEX_HOME)).toBeUndefined()
  })

  it('with the devices inside the core nothing is set up', () => {
    const claude = fakeClaude()
    start({ faults: ['fleet'], claude: claude.found })
    seen.host.watching!(true)
    expect(held(env.CODEX_HOME)).toBeUndefined()
    expect(existsSync(join(dataDir, 'dial-setup.json'))).toBe(false)
    expect(claude.looked).toEqual([])
  })

  it('a dial setup that fails costs the dial nothing', async () => {
    vi.useFakeTimers()
    readers.known.set('sess-9', 'terminal')
    readers.owners.set('sess-9', { engine: 'codex', pid: 77 })
    readers.rows.set('sess-9', { cwd: '/work/web', transcriptPath: null })
    readers.working.set('sess-9', false)
    await start({ faults: ['fleet', 'skill'], listen: fakeListener().listen }).orcaHomes.landed()
    expect(logs).toContain('[devices] skill failed · injected fault: skill')
    await vi.waitFor(() => expect(calls('start')).toHaveLength(1))
    // The scan goes on past the setup to list what it found.
    seen.host.watching!(true)
    expect(held(env.CODEX_HOME)).toBeUndefined()
    await vi.waitFor(() => expect(readers.apps.mock.calls).toEqual([[[77]]]))
  })
})

describe('Harness\'s VS Code extension, set up once a computer from the devices\' own process (cable/vscodeExtensionSetup.ts)', () => {
  /** Lets an install's answer be taken. */
  const settled = () => new Promise((resolve) => setImmediate(resolve))
  const flags = (vscode: ReturnType<typeof fakeVscode>) => vscode.runs.map(([, flag]) => flag)
  const tallied = (line: string) => line.startsWith('[device] vscode extension · vscode')

  it('a dial\'s first attach installs it once, records it in dial-setup.json and counts it set up', async () => {
    const vscode = fakeVscode({ app: true })
    start({ faults: ['fleet'], listen: fakeListener().listen, vscodeExtension: vscode.deps })
    await settled()
    // No dial here yet: the start installs nothing.
    expect(vscode.runs).toEqual([])

    seen.host.watching!(true)

    await vi.waitFor(() => expect(readSetup(dataDir).vscode).toBe('9.9.9'))
    expect(flags(vscode)).toEqual(['--install-extension'])
    expect(logs.filter(tallied)).toEqual(['[device] vscode extension · vscode · set up'])
    expect(logs).toContainEqual(expect.stringMatching(/^\[device\] vscode extension · day \d{4}-\d\d-\d\d · vscode set up 1 updated 0 failed 0 left removed 0$/))
    // A replug installs nothing more.
    seen.host.watching!(false)
    seen.host.watching!(true)
    await settled()
    expect(flags(vscode)).toEqual(['--install-extension'])
  })

  it.each([
    ['their own process: brought current as they start', true, ['--install-extension']],
    ['the core\'s process: nothing, at a start or an attach', false, []],
  ])('on at another version, in %s', async (_, own, runs) => {
    const vscode = fakeVscode({ installed: '0.0.1' })
    start({ faults: ['fleet'], listen: own ? fakeListener().listen : undefined, vscodeExtension: vscode.deps })
    await vi.waitFor(() => expect(flags(vscode)).toEqual(runs))
    seen.host.watching!(true)
    await settled()
    expect(flags(vscode)).toEqual(runs)
    expect(logs.filter(tallied)).toEqual(own ? ['[device] vscode extension · vscode · updated'] : [])
  })

  // The end-to-end harness points HARNESS_VSCODE_BIN at a file inside each daemon's own root that is not there
  // (e2e/harness/daemon.ts): a fake dial's attach on a Mac with VS Code in /Applications installs nothing into it.
  it.each([
    ['unset: VS Code in /Applications is found, and installed into', undefined, ['--install-extension']],
    ['a file that is not there: none is found, and nothing runs', '/tmp/e2e/root/vscode/code', []],
  ])('HARNESS_VSCODE_BIN %s', async (_, bin, runs) => {
    vi.stubEnv('HARNESS_VSCODE_BIN', bin)
    const vscode = fakeVscode({ app: true })
    const inApplications = (path: string) => path.startsWith('/Applications/')
    const own = vi.spyOn(vscodeExtension, 'vscodeExtensionDeps')
      .mockImplementation((given) => ({ ...vscode.deps, exists: inApplications, executable: inApplications, bin: given }))
    start({ faults: ['fleet'], listen: fakeListener().listen, vscodeExtension: null })
    seen.host.watching!(true)
    await settled()
    expect(own.mock.calls).toEqual([[bin]])
    expect(flags(vscode)).toEqual(runs)
    expect(readSetup(dataDir).vscode).toBe(runs.length ? '9.9.9' : undefined)
  })

  it('a throw there costs the dial nothing', async () => {
    const vscode = fakeVscode({ installed: '0.0.1' })
    // Its start pass follows the dial setup's, once Orca's homes are read.
    await start({ faults: ['fleet', 'vscodeExtension'], listen: fakeListener().listen, vscodeExtension: vscode.deps }).orcaHomes.landed()
    expect(logs).toContain('[devices] vscodeExtension failed · injected fault: vscodeExtension')
    await vi.waitFor(() => expect(calls('start')).toHaveLength(1))
    await settled()
    expect(vscode.runs).toEqual([])
  })
})

describe('Orca\'s ring follows Orca\'s tabs (docs/plans/2026-11-16-dial-orca-focus-order-design.md)', () => {
  const H = (n: number) => `term_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  /** Claude Code in Orca terminal `n`, as its hook says. */
  const hook = (n: number, over: Partial<ObservedHookEvent> = {}): ObservedHookEvent => ({
    engine: 'claude', sessionId: `sess-${n}`, event: 'session-start', cwd: '/work/api', callerPid: 4240 + n,
    transcriptPath: `/t/sess-${n}.jsonl`,
    hostHints: { ORCA_AGENT_SESSION_ID: 'orca-1', ORCA_TERMINAL_HANDLE: H(n), __CFBundleIdentifier: 'com.stablyai.orca' }, ...over,
  })
  const agent = (n: number) => observedAgentId('claude', `sess-${n}`)
  /** Claude Code in a Ghostty tab, and its id. */
  const inGhostty = (n: number) => hook(n, { sessionId: `g-${n}`, hostHints: { TERM_PROGRAM: 'ghostty' } })
  const ghostty = (n: number) => observedAgentId('claude', `g-${n}`)
  const host = () => seen.dial as unknown as DaemonCableHost
  /** The devices on Orca's reads the spec lands, `n` sessions in Orca listed, no window, no dial yet. The timers are
   *  held, as a turn's end reads its answer on one; `setImmediate` is left to let a landing run. */
  const withOrca = (n: number, over: Parameters<typeof start>[0] = {}) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const fake = fakeOrcaReads()
    const started = start({ orcaReads: fake.reads, ...over, faults: ['fleet', ...over.faults ?? []] })
    for (let i = 1; i <= n; i++) started.port.observed(hook(i))
    started.port.swarms(null)
    return { ...started, fake }
  }
  /** The same, and a dial attached. */
  const dialWith = (n: number, over: Parameters<typeof start>[0] = {}) => {
    const started = withOrca(n, over)
    seen.host.watching!(true)
    return started
  }
  /** Lets what a landing sets off run. */
  const settled = () => new Promise((resolve) => setImmediate(resolve))
  /** The latest read lands with these tabs, these terminals an agent runs in, and these terminals' worktrees: a handle
   *  alone is one in a tab with no title. */
  const land = async (fake: ReturnType<typeof fakeOrcaReads>, tabs: Array<string | { handle: string; title?: string; renamed?: true }> | null,
    terminals: OrcaTerminal[] = [], worktrees: ReadonlyMap<string, string> = new Map()) => {
    const read = fake.orders.at(-1)
    expect(read, 'a read asked').toBeTypeOf('function')
    read!(tabs && { tabs: tabs.map((tab) => typeof tab === 'string' ? { handle: tab } : tab), terminals, worktrees })
    await settled()
  }
  /** Sessions `ns` running in Orca before the dial came, as their parent processes say, idle since: no hook, so no pane. */
  const scanned = (...ns: number[]) => {
    for (const n of ns) {
      readers.known.set(`sess-${n}`, 'terminal')
      readers.owners.set(`sess-${n}`, { engine: 'claude', pid: 4240 + n })
      readers.rows.set(`sess-${n}`, { cwd: '/work/api', transcriptPath: null })
      readers.working.set(`sess-${n}`, false)
    }
    readers.apps.mockResolvedValueOnce(new Map(ns.map((n) => [4240 + n, 'orca'])))
  }
  /** Orca's terminal `n`, Claude Code in it, in that folder. */
  const claudeIn = (n: number, worktreePath = '/work/api', agentIdentity = 'claude'): OrcaTerminal => ({ handle: H(n), worktreePath, agentIdentity })
  const ring = async () => (await host().listAgentSnapshot({ apps: true })).agents.map((a) => a.id)
  /** The names the dial lists, in Orca's ring and in the one ring. */
  const names = async () => {
    const [orcaRing, single] = await Promise.all([host().listAgentSnapshot({ apps: true }), host().listAgentSnapshot()])
    return { orca: orcaRing.agents.map((a) => a.name), single: single.agents.map((a) => a.name) }
  }
  const orderLines = () => logs.filter((line) => line.startsWith('[device] orca order'))

  it('with a dial attached, an agent entering Orca\'s ring asks for one read, and its landing puts the ring in tab order', async () => {
    const { fake } = dialWith(3)
    expect(fake.orders).toHaveLength(1)
    expect(await ring()).toEqual([agent(1), agent(2), agent(3)])
    await land(fake, [H(3), H(1), H(2)])
    expect(await ring()).toEqual([agent(3), agent(1), agent(2)])
    expect(orderLines()).toEqual(['[device] orca order · read'])
  })

  it('a change during a read asks for one more after it lands, never two at once', async () => {
    const { port, fake } = dialWith(1)
    port.observed(hook(2))
    port.observed(hook(3))
    expect(fake.orders).toHaveLength(1)
    await land(fake, [H(1)])
    expect(fake.orders).toHaveLength(2)
    await land(fake, [H(3), H(2), H(1)])
    expect(fake.orders).toHaveLength(2)
    expect(await ring()).toEqual([agent(3), agent(2), agent(1)])
  })

  it('the same members ask for nothing: a turn, a prompt, a state change', async () => {
    const { port, fake } = dialWith(2)
    await land(fake, [H(1), H(2)])
    port.observed(hook(1, { event: 'turn-start' }))
    port.observed(hook(1, { event: 'needs-input' }))
    port.observed(hook(1, { event: 'turn-stop' }))
    port.observed(hook(2, { event: 'turn-start' }))
    await settled()
    expect(fake.orders).toHaveLength(1)
  })

  it('an agent leaving Orca\'s ring asks for one read', async () => {
    const { port, fake } = dialWith(2)
    await land(fake, [H(2), H(1)])
    expect(await ring()).toEqual([agent(2), agent(1)])
    // Resumed in Ghostty.
    port.observed(hook(2, { hostHints: { TERM_PROGRAM: 'ghostty' } }))
    expect(fake.orders).toHaveLength(2)
    await land(fake, [H(1)])
    expect(await ring()).toEqual([agent(1)])
  })

  it('a failed read keeps the ring as it was and says so; the next change asks again', async () => {
    const { port, fake } = dialWith(2)
    await land(fake, [H(2), H(1)])
    expect(await ring()).toEqual([agent(2), agent(1)])
    port.observed(hook(3))
    await land(fake, null)
    expect(orderLines()).toEqual(['[device] orca order · read', '[device] orca order · failed'])
    // The last order still holds: the agent that came, in none of it, after the ranked.
    expect(await ring()).toEqual([agent(2), agent(1), agent(3)])
    port.observed(hook(4))
    expect(fake.orders).toHaveLength(3)
  })

  it('an Orca agent the attach scan found asks for one more read when its first hook gives its pane, and takes its tab\'s place', async () => {
    const { port, fake } = withOrca(0)
    port.observed(hook(2))
    // Running in Orca before the dial came, as its parent processes say: no pane until its first hook.
    readers.known.set('sess-1', 'terminal')
    readers.owners.set('sess-1', { engine: 'claude', pid: 4241 })
    readers.rows.set('sess-1', { cwd: '/work/api', transcriptPath: null })
    readers.working.set('sess-1', false)
    readers.apps.mockResolvedValueOnce(new Map([[4241, 'orca']]))
    seen.host.watching!(true)
    await settled()
    await land(fake, [H(1), H(2)])
    await land(fake, [H(1), H(2)])
    expect(fake.orders).toHaveLength(2)
    expect(await ring()).toEqual([agent(2), agent(1)])
    port.observed(hook(1))
    expect(fake.orders).toHaveLength(3)
    await land(fake, [H(1), H(2)])
    expect(fake.orders).toHaveLength(3)
    expect(await ring()).toEqual([agent(1), agent(2)])
  })

  // Diego's main worktree (Orca 1.4.256, PM 2026-11-16): a shell, an idle agent the attach scan found in a tab Orca titled
  // after it, and a hooked agent in a tab he renamed "PM" whose session he named "harness root".
  const diego = [{ handle: H(1), title: 'Terminal 3' }, { handle: H(2), title: 'Skill từ SKILL.md' }, { handle: H(3), title: 'PM', renamed: true as const }]

  it('Diego\'s layout: the agent the scan found takes its tab\'s place and name by elimination, and the renamed tab names PM', async () => {
    const { port, fake } = withOrca(0)
    port.observed(hook(3, { title: 'harness root' }))
    scanned(2)
    seen.host.watching!(true)
    await settled()
    // Another engine's terminal in its folder, and Claude Code's in another folder, are not its.
    const terminals = [claudeIn(2), claudeIn(3), claudeIn(4, '/work/api', 'codex'), claudeIn(5, '/work/web')]
    await land(fake, diego, terminals)
    await land(fake, diego, terminals)
    expect(fake.orders).toHaveLength(2)
    expect(await ring()).toEqual([agent(2), agent(3)])
    expect((await names()).orca).toEqual(['Skill từ SKILL.md', 'PM'])
  })

  const oneTwoPM = [{ handle: H(1), title: 'One' }, { handle: H(2), title: 'Two' }, { handle: H(3), title: 'PM', renamed: true as const }]

  // Diego's main worktree at his dial check (PM 2026-11-16): a shell, an agent, the idle agent the scan found, and PM.
  const diego4 = [{ handle: H(1), title: 'Terminal 3' }, { handle: H(2), title: 'harness' }, { handle: H(3), title: 'Skill từ SKILL.md' },
    { handle: H(4), title: 'PM', renamed: true as const }]
  /** Diego's four tabs, read: Skill (agent 3) placed at its terminal by elimination. */
  const diegoPlaced = async (over: Parameters<typeof start>[0] = {}, worktrees: ReadonlyMap<string, string> = new Map()) => {
    const { port, fake } = withOrca(0, over)
    port.observed(hook(2))
    port.observed(hook(4))
    scanned(3)
    seen.host.watching!(true)
    await settled()
    await land(fake, diego4, [claudeIn(2), claudeIn(3), claudeIn(4)], worktrees)
    await land(fake, diego4, [claudeIn(2), claudeIn(3), claudeIn(4)], worktrees)
    expect(await ring()).toEqual([agent(2), agent(3), agent(4)])
    return { port, fake }
  }
  const switchTo = (n: number): [string, string[], number] => ['/opt/orca/bin/orca', ['terminal', 'switch', '--terminal', H(n), '--json'], 10_000]

  it('a rest on the agent placed by elimination switches Orca to its placed terminal', async () => {
    await diegoPlaced()
    expect(host().swipeSwitches(agent(3))).toBe(true)
    host().swipeEnded(agent(3), 'rest')
    await vi.waitFor(() => expect(orcaRuns).toEqual([switchTo(3)]))
  })

  it('a tap on it switches to its placed terminal before Orca comes forward', async () => {
    await diegoPlaced()
    expect(await host().openAgent(agent(3))).toBeUndefined()
    expect(orcaRuns).toEqual([switchTo(3)])
  })

  it('on macOS a tap on it switches to its placed terminal, then brings Orca forward by Orca\'s own bundle', async () => {
    await diegoPlaced({ orca: { ...orca, platform: 'darwin' } })
    expect(await host().openAgent(agent(3))).toBeUndefined()
    expect(orcaRuns).toEqual([switchTo(3), ['/usr/bin/open', ['-b', 'com.stablyai.orca'], 10_000]])
  })

  it('on macOS a hooked agent\'s tap brings forward the app its own hook named', async () => {
    const { port } = await diegoPlaced({ orca: { ...orca, platform: 'darwin' } })
    // Its hook says its window is VS Code's, though its terminal is Orca's.
    port.observed(hook(2, { hostHints: { ...hook(2).hostHints, __CFBundleIdentifier: 'com.microsoft.VSCode' } }))
    expect(await host().openAgent(agent(2))).toBeUndefined()
    expect(orcaRuns).toEqual([switchTo(2), ['/usr/bin/open', ['-b', 'com.microsoft.VSCode'], 10_000]])
  })

  it('on macOS words to it are never typed into its placed terminal, nor anywhere', async () => {
    await diegoPlaced({ orca: { ...orca, platform: 'darwin' } })
    expect(await host().sendTurn(agent(3), 'run the tests')).toMatchObject({ ok: false })
    await settled()
    expect(orcaRuns).toEqual([])
  })

  it('words or voice to it are never typed into its placed terminal, nor anywhere', async () => {
    await diegoPlaced()
    expect(await host().sendTurn(agent(3), 'run the tests')).toMatchObject({ ok: false })
    await settled()
    expect(orcaRuns).toEqual([])
  })

  it('an ambiguous placement switches nothing and, on macOS, brings nothing forward', async () => {
    const { port, fake } = withOrca(0, { orca: { ...orca, platform: 'darwin' } })
    port.observed(hook(3))
    scanned(1, 2)
    seen.host.watching!(true)
    await settled()
    await land(fake, oneTwoPM, [claudeIn(1), claudeIn(2), claudeIn(3)])
    await land(fake, oneTwoPM, [claudeIn(1), claudeIn(2), claudeIn(3)])
    expect(host().swipeSwitches(agent(1))).toBe(false)
    host().swipeEnded(agent(1), 'rest')
    await host().openAgent(agent(2))
    await settled()
    expect(orcaRuns).toEqual([])
  })

  // Orca 1.4.256's switch reveals a worktree only lightly: a parked session showed once the person pressed Back, whose
  // full activation `worktree activate` runs (PM, 2026-11-16).
  const WT = 'bfeba4a9-ec47-4daa-bdb0-5a6b702b5a08::/Users/d/autonomous-harness'
  const activateIn = (worktreeId: string): [string, string[], number] =>
    ['/opt/orca/bin/orca', ['worktree', 'activate', '--worktree', `id:${worktreeId}`, '--json'], 10_000]

  it('after a read, a rest and a tap on an Orca agent activate its worktree, then switch to its terminal', async () => {
    const { fake } = dialWith(2)
    await land(fake, [H(1), H(2)], [], new Map([[H(1), WT]]))
    host().swipeEnded(agent(1), 'rest')
    await vi.waitFor(() => expect(orcaRuns).toEqual([activateIn(WT), switchTo(1)]))
    expect(await host().openAgent(agent(1))).toBeUndefined()
    expect(orcaRuns).toEqual([activateIn(WT), switchTo(1), activateIn(WT), switchTo(1)])
    // A terminal the read gave no worktree: the switch alone.
    orcaRuns.length = 0
    host().swipeEnded(agent(2), 'rest')
    await vi.waitFor(() => expect(orcaRuns).toEqual([switchTo(2)]))
  })

  it('each read replaces the worktrees: one the latest read did not give is a switch alone', async () => {
    const { port, fake } = dialWith(2)
    await land(fake, [H(1), H(2)], [], new Map([[H(1), WT]]))
    port.observed(hook(3))
    await land(fake, [H(1), H(2), H(3)], [], new Map([[H(2), WT]]))
    host().swipeEnded(agent(1), 'rest')
    await vi.waitFor(() => expect(orcaRuns).toEqual([switchTo(1)]))
    host().swipeEnded(agent(2), 'rest')
    await vi.waitFor(() => expect(orcaRuns).toEqual([switchTo(1), activateIn(WT), switchTo(2)]))
  })

  it('an activate that fails says so in one line with no id, and the switch still runs', async () => {
    const refusing = { ...orca, run: async (file: string, args: string[], timeoutMs: number) => {
      orcaRuns.push([file, args, timeoutMs])
      return { code: args[0] === 'worktree' ? 1 : 0, stdout: '' }
    } }
    const { fake } = dialWith(1, { orca: refusing })
    await land(fake, [H(1)], [], new Map([[H(1), WT]]))
    host().swipeEnded(agent(1), 'rest')
    await vi.waitFor(() => expect(logs).toContain('[device] swipe · ok'))
    expect(orcaRuns).toEqual([activateIn(WT), switchTo(1)])
    expect(logs.filter((line) => line.startsWith('[device] orca activate'))).toEqual(['[device] orca activate · failed'])
    expect(logs.filter((line) => [WT, 'bfeba4a9', '/Users/d', H(1), agent(1)].some((secret) => line.includes(secret)))).toEqual([])
  })

  it('a rest on the agent placed by elimination activates its placed terminal\'s worktree, then switches to it', async () => {
    await diegoPlaced({}, new Map([[H(3), WT]]))
    host().swipeEnded(agent(3), 'rest')
    await vi.waitFor(() => expect(orcaRuns).toEqual([activateIn(WT), switchTo(3)]))
  })

  it('once it hooks with its own terminal, a rest switches to that one', async () => {
    const { port } = await diegoPlaced()
    // Its own terminal is another than the one it was placed at, and the read its hook asks for has not landed.
    port.observed(hook(3, { hostHints: { ...hook(3).hostHints, ORCA_TERMINAL_HANDLE: H(5) } }))
    host().swipeEnded(agent(3), 'rest')
    await vi.waitFor(() => expect(orcaRuns).toEqual([switchTo(5)]))
  })

  it('two agents with no pane in one folder place neither', async () => {
    const { port, fake } = withOrca(0)
    port.observed(hook(3))
    scanned(1, 2)
    seen.host.watching!(true)
    await settled()
    await land(fake, oneTwoPM, [claudeIn(1), claudeIn(2), claudeIn(3)])
    await land(fake, oneTwoPM, [claudeIn(1), claudeIn(2), claudeIn(3)])
    expect(await ring()).toEqual([agent(3), agent(1), agent(2)])
    expect((await names()).orca).toEqual(['PM', 'api', 'api'])
  })

  it('two agents with no pane and one terminal no agent holds place neither', async () => {
    const { port, fake } = withOrca(0)
    port.observed(hook(3))
    scanned(1, 2)
    seen.host.watching!(true)
    await settled()
    // Terminal 2 is not listed with an agent: H(1) is the one free, and either agent could be in it.
    await land(fake, oneTwoPM, [claudeIn(1), claudeIn(3)])
    await land(fake, oneTwoPM, [claudeIn(1), claudeIn(3)])
    expect(await ring()).toEqual([agent(3), agent(1), agent(2)])
    expect((await names()).orca).toEqual(['PM', 'api', 'api'])
  })

  it('two terminals no agent holds place neither', async () => {
    const { fake } = withOrca(0)
    scanned(1)
    seen.host.watching!(true)
    await settled()
    await land(fake, oneTwoPM.slice(0, 2), [claudeIn(1), claudeIn(2)])
    expect(fake.orders).toHaveLength(1)
    expect((await names()).orca).toEqual(['api'])
  })

  it('an agent with no folder is placed nowhere', async () => {
    const { port, fake } = dialWith(1)
    // In tmux inside Orca, so no Orca pane, and its hook said no folder.
    port.observed(hook(2, { cwd: undefined, hostHints: { TMUX_PANE: '%3', ORCA_TERMINAL_HANDLE: H(2), __CFBundleIdentifier: 'com.stablyai.orca' } }))
    await land(fake, [{ handle: H(2), title: 'Two' }, H(1)], [claudeIn(1), claudeIn(2)])
    expect(await ring()).toEqual([agent(1), agent(2)])
    expect((await names()).orca).toEqual(['api', 'claude'])
  })

  it('an agent no layout names, and one in tmux inside Orca, come after the ranked, in ring order', async () => {
    const { port, fake } = dialWith(1)
    // Its handle names the terminal tmux started in, not its pane: it has no Orca pane, listed or not.
    port.observed(hook(2, { hostHints: { TMUX_PANE: '%3', ORCA_TERMINAL_HANDLE: H(2), __CFBundleIdentifier: 'com.stablyai.orca' } }))
    port.observed(hook(3))
    port.observed(hook(4))
    await land(fake, [H(3), H(2), H(1)])
    expect(await ring()).toEqual([agent(3), agent(1), agent(2), agent(4)])
  })

  it('only Orca\'s ring: the single ring and another app\'s ring keep first-entry order', async () => {
    const { port, fake } = dialWith(1)
    port.observed(inGhostty(1))
    port.observed(hook(2))
    port.observed(inGhostty(2))
    port.observed(hook(3))
    await land(fake, [H(3), H(2), H(1)])
    expect(await ring()).toEqual([agent(3), agent(2), agent(1)])
    expect((await host().listAgentSnapshot()).agents.map((a) => a.id)).toEqual([agent(1), ghostty(1), agent(2), ghostty(2), agent(3)])
    expect(host().pickApp('ghostty')).toBe('switched')
    expect(await ring()).toEqual([ghostty(1), ghostty(2)])
  })

  it('the agent the dial shows is still in the ring after the reorder, and nothing is asked of the dial or of Orca', async () => {
    const { fake } = dialWith(3)
    expect(await ring()).toEqual([agent(1), agent(2), agent(3)])
    turnTo(agent(1))
    const asked = () => ({ local: calls('followLocal'), app: calls('followApp'), pushed: calls('syncAgents').length, runs: [...orcaRuns] })
    const before = asked()
    await land(fake, [H(3), H(1), H(2)])
    expect(await ring()).toEqual([agent(3), agent(1), agent(2)])
    // Nothing is pushed either: the dials read the ring on their next list.
    expect(asked()).toEqual(before)
  })

  it('with no dial attached nothing is read; attaching asks for one; detaching and attaching again asks again', async () => {
    const { port, fake } = withOrca(2)
    expect(fake.orders).toEqual([])
    seen.host.watching!(true)
    expect(fake.orders).toHaveLength(1)
    await land(fake, [H(2), H(1)])
    seen.host.watching!(false)
    port.observed(hook(3))
    expect(fake.orders).toHaveLength(1)
    seen.host.watching!(true)
    expect(fake.orders).toHaveLength(2)
  })

  it('a read that lands after the dial detached changes nothing and asks for no other', async () => {
    const { port, fake } = dialWith(2)
    expect(await ring()).toEqual([agent(1), agent(2)])
    // A change during the read, noted, and forgotten with the dial.
    port.observed(hook(3))
    seen.host.watching!(false)
    await land(fake, [H(3), H(2), H(1)])
    expect(fake.orders).toHaveLength(1)
    expect(orderLines()).toEqual([])
    expect(await ring()).toEqual([agent(1), agent(2), agent(3)])
  })

  it('a dial that detaches and attaches again during a read: that read lands on nothing, and the one the attach asks for follows it', async () => {
    const { fake } = dialWith(2)
    seen.host.watching!(false)
    seen.host.watching!(true)
    // Never two at once: the attach's read waits for the one under way.
    expect(fake.orders).toHaveLength(1)
    await land(fake, [H(2), H(1)])
    expect(orderLines()).toEqual([])
    expect(fake.orders).toHaveLength(2)
    await land(fake, [H(2), H(1)])
    expect(await ring()).toEqual([agent(2), agent(1)])
    expect(orderLines()).toEqual(['[device] orca order · read'])
  })

  it('no Orca agent: nothing is read', () => {
    const { port, fake } = dialWith(0)
    port.observed(inGhostty(1))
    expect(fake.orders).toEqual([])
    // The first that comes asks.
    port.observed(hook(1))
    expect(fake.orders).toHaveLength(1)
  })

  it('HARNESS_DEVICE_OBSERVED=off: nothing is read', () => {
    const switched = env as { HARNESS_DEVICE_OBSERVED: boolean }
    switched.HARNESS_DEVICE_OBSERVED = false
    onTestFinished(() => { switched.HARNESS_DEVICE_OBSERVED = true })
    const { fake } = dialWith(2)
    expect(fake.orders).toEqual([])
  })

  it('an orca part that throws costs the dial nothing', async () => {
    const { fake } = dialWith(2, { faults: ['orca'] })
    expect(await ring()).toEqual([agent(1), agent(2)])
    expect(fake.orders).toEqual([])
    expect(logs).toContain('[devices] orca failed · injected fault: orca')
  })

  it('an order read that throws as it is asked leaves the next change free to ask again', async () => {
    const fake = fakeOrcaReads()
    const { orcaTabs } = fake.reads
    let asks = 0
    const { port } = dialWith(1, { orcaReads: { ...fake.reads, orcaTabs: () => { if (++asks === 1) throw new Error('made up'); return orcaTabs() } } })
    expect(asks).toBe(1)
    expect(fake.orders).toEqual([])
    port.observed(hook(2))
    expect(asks).toBe(2)
    await land(fake, [H(2), H(1)])
    expect(await ring()).toEqual([agent(2), agent(1)])
  })

  it('the reads are built on the orca given when none is given', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const ports = emptyPorts()
    startDevices(fakeCore({ dataDir }), ports, {
      logsDir: join(dataDir, 'logs'), cableDisabled: true, faults: new Set(['fleet']), log: (line) => { logs.push(line) }, onExit: vi.fn(), orca, codex, herdr,
    })
    ports.devices!.observed(hook(1))
    seen.host.watching!(true)
    await settled()
    expect(orcaRuns).toEqual([['/opt/orca/bin/orca', ['terminal', 'list', '--json', '--include-visual-layouts'], 10_000]])
    // The fake prints nothing a list would.
    expect(orderLines()).toEqual(['[device] orca order · failed'])
  })

  it('after a read, an Orca agent with no name of its own is called by its tab, and the dial\'s list says it', async () => {
    const { fake } = dialWith(3)
    // Its folder's name until then.
    expect(await names()).toEqual({ orca: ['api', 'api', 'api'], single: ['api', 'api', 'api'] })
    await land(fake, [{ handle: H(2), title: 'Dev' }, { handle: H(1), title: 'PM' }, H(3)])
    // The one in a tab with no title keeps its folder's.
    expect(await names()).toEqual({ orca: ['Dev', 'PM', 'api'], single: ['PM', 'Dev', 'api'] })
  })

  it('a session the person named keeps its name', async () => {
    const { port, fake } = withOrca(0)
    port.observed(hook(1, { title: 'Mine' }))
    port.observed(hook(2))
    seen.host.watching!(true)
    await land(fake, [{ handle: H(1), title: 'PM' }, { handle: H(2), title: 'Dev' }])
    expect((await names()).orca).toEqual(['Mine', 'Dev'])
  })

  it('a later read with another title renames it', async () => {
    const { port, fake } = dialWith(1)
    await land(fake, [{ handle: H(1), title: 'PM' }])
    expect((await names()).orca).toEqual(['PM'])
    port.observed(hook(2))
    await land(fake, [{ handle: H(1), title: 'Lead' }, { handle: H(2), title: 'Dev' }])
    expect((await names()).orca).toEqual(['Lead', 'Dev'])
    // A tab that lost its title gives the folder's back.
    port.observed(hook(3))
    await land(fake, [H(1), { handle: H(2), title: 'Dev' }, H(3)])
    expect((await names()).orca).toEqual(['api', 'Dev', 'api'])
  })

  it('a failed read renames nobody', async () => {
    const { port, fake } = dialWith(1)
    await land(fake, [{ handle: H(1), title: 'PM' }])
    port.observed(hook(2))
    await land(fake, null)
    expect((await names()).orca).toEqual(['PM', 'api'])
  })

  it('no log line holds a title', async () => {
    const { port, fake } = dialWith(1)
    await land(fake, [{ handle: H(1), title: 'Secret tab' }])
    port.observed(hook(2))
    await land(fake, [{ handle: H(1), title: 'Other secret' }, { handle: H(2), title: 'Third secret' }])
    port.observed(hook(3))
    await land(fake, null)
    expect((await names()).orca).toEqual(['Other secret', 'Third secret', 'api'])
    expect(logs.filter((line) => /secret/i.test(line))).toEqual([])
  })

  it('a tab-named agent\'s turn end, with a dial linked, logs no title: the tier\'s tally is a measure', async () => {
    readers.answer.mockResolvedValue('Shipped.')
    const { port, fake } = dialWith(1, { decideTier: null })
    await land(fake, [{ handle: H(1), title: 'Secret tab' }])
    port.observed(hook(1, { event: 'turn-start' }))
    port.observed(hook(1, { event: 'turn-stop' }))
    await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
    expect(calls('summary')).toEqual([[agent(1), 'Shipped.', 'Shipped.', 'alert', 'Shipped.', false]])
    expect(logs.filter((line) => /secret/i.test(line))).toEqual([])
    expect(logs).toContain('[cable] notify · alert · rule:turn · turn · 0ms')
  })

  it('no line holds a handle or an agent', async () => {
    const { port, fake } = dialWith(2)
    await land(fake, [H(1), H(2)])
    port.observed(hook(3))
    await land(fake, null)
    expect(orderLines()).toEqual(['[device] orca order · read', '[device] orca order · failed'])
    const secrets = [1, 2, 3].flatMap((n) => [H(n), agent(n), `sess-${n}`])
    expect(logs.filter((line) => secrets.some((secret) => line.includes(secret)))).toEqual([])
  })
})

describe('the dial follows the pane focused in Orca (docs/plans/2026-11-16-dial-orca-focus-order-design.md)', () => {
  const H = (n: number) => `term_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  /** Claude Code in Orca terminal `n`, as its hook says. */
  const hook = (n: number, over: Partial<ObservedHookEvent> = {}): ObservedHookEvent => ({
    engine: 'claude', sessionId: `sess-${n}`, event: 'session-start', cwd: '/work/api', callerPid: 4240 + n,
    transcriptPath: `/t/sess-${n}.jsonl`,
    hostHints: { ORCA_AGENT_SESSION_ID: 'orca-1', ORCA_TERMINAL_HANDLE: H(n), __CFBundleIdentifier: 'com.stablyai.orca' }, ...over,
  })
  const agent = (n: number) => observedAgentId('claude', `sess-${n}`)
  const host = () => seen.dial as unknown as DaemonCableHost
  let clock = 0
  /** Lets what a landing sets off run. */
  const settled = () => new Promise((resolve) => setImmediate(resolve))
  /** The devices on Orca's reads the spec drives, `agents` sessions in Orca listed, no window, a dial attached unless
   *  `attached` is false, no app settled in front, and the devices' monotonic clock at 0. `settle` keeps an app in front
   *  for the settle, as `harness hardware watch` tells it, and lets the probe it asks land. `line` is a line of the
   *  latest watch. The timers are held; `setImmediate` is left to let a landing run. */
  const dialWith = async (over: { watches?: boolean | Promise<boolean>; agents?: number; attached?: boolean; faults?: string[]; orca?: typeof orca } = {}) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    clock = 0
    const listener = fakeListener()
    const fake = fakeOrcaReads({ watches: over.watches ?? true })
    const started = start({ faults: ['fleet', ...over.faults ?? []], listen: listener.listen, now: () => clock, orcaReads: fake.reads,
      ...over.orca ? { orca: over.orca } : {} })
    for (let n = 1; n <= (over.agents ?? 2); n++) started.port.observed(hook(n))
    if (over.attached !== false) seen.host.watching!(true)
    started.port.swarms(null)
    const settle = async (app: string) => {
      expect(listener.front(app)).toBeUndefined()
      await vi.advanceTimersByTimeAsync(FRONT_SETTLE_MS)
      await settled()
    }
    const line = (handle: string | null) => {
      const watch = fake.watches.at(-1)
      expect(watch, 'a watch runs').toBeDefined()
      watch!.line(handle)
    }
    return { ...started, fake, settle, line }
  }
  const asked = () => calls('followLocal')
  const focusLines = () => logs.filter((line) => line.startsWith('[device] focus'))
  const watchLines = () => logs.filter((line) => line.startsWith('[device] orca watch'))
  const prompts = () => logs.filter((line) => line.startsWith('[device] prompt'))
  const unlinked = (off: boolean) => { (seen.cable as unknown as { connected: boolean }).connected = !off }
  const STARTED = '[device] orca watch · started'
  const ENDED = '[device] orca watch · ended'
  const ECHO = '[device] focus · skipped · echo'

  describe('the watch\'s life', () => {
    it('Orca\'s settle with a dial attached asks the CLI and starts one watch; a second settle starts no other', async () => {
      const { fake, settle } = await dialWith()
      await settle('orca')
      expect(fake.probes.count).toBe(1)
      expect(fake.watches).toHaveLength(1)
      // A front told again starts no settle: Orca settles again after another app.
      await settle('ghostty')
      await settle('orca')
      expect(fake.probes.count).toBe(1)
      expect(fake.watches).toHaveLength(1)
      expect(watchLines()).toEqual([STARTED])
    })

    it('a CLI without watch-focus starts none, says unsupported, and is asked again at the next settle', async () => {
      const { fake, settle } = await dialWith({ watches: false })
      await settle('orca')
      expect(watchLines()).toEqual(['[device] orca watch · unsupported'])
      await settle('ghostty')
      await settle('orca')
      expect(fake.probes.count).toBe(2)
      expect(fake.watches).toEqual([])
      expect(watchLines()).toEqual(['[device] orca watch · unsupported', '[device] orca watch · unsupported'])
    })

    it('with no dial attached, and for another app\'s settle, nothing is asked', async () => {
      const { fake, settle } = await dialWith({ attached: false })
      await settle('orca')
      await settle('ghostty')
      seen.host.watching!(true)
      await settle('claude')
      expect(fake.probes.count).toBe(0)
      expect(watchLines()).toEqual([])
    })

    it('a dial that attaches while Orca is already the settled front app asks the CLI and starts the watch, its first line followed by the settle rule; one that attaches with another app in front starts none', async () => {
      const { fake, settle, line } = await dialWith({ attached: false })
      await settle('orca')
      seen.host.watching!(true)
      await settled()
      expect(fake.probes.count).toBe(1)
      expect(watchLines()).toEqual([STARTED])
      // The settle's rule: the dial turned a moment ago, and Orca's focus must not turn it back.
      turnTo(agent(1))
      clock = 1_999
      line(H(2))
      expect(focusLines()).toEqual([ECHO])
      expect(asked()).toEqual([])
      seen.host.watching!(false)
      await settle('ghostty')
      seen.host.watching!(true)
      await settled()
      expect(fake.probes.count).toBe(1)
      expect(fake.watches).toHaveLength(1)
      expect(watchLines()).toEqual([STARTED, ENDED])
    })

    it('a settle while the probe runs starts nothing more: one watch', async () => {
      let answer = (_watches: boolean): void => {}
      const { fake, settle } = await dialWith({ watches: new Promise<boolean>((resolve) => { answer = resolve }) })
      await settle('orca')
      await settle('ghostty')
      await settle('orca')
      expect(fake.probes.count).toBe(1)
      answer(true)
      await settled()
      expect(fake.watches).toHaveLength(1)
      expect(watchLines()).toEqual([STARTED])
    })

    it('a dial that detaches during the probe gets no watch; one attached again with Orca in front does', async () => {
      let answer = (_watches: boolean): void => {}
      const { fake, settle } = await dialWith({ watches: new Promise<boolean>((resolve) => { answer = resolve }) })
      await settle('orca')
      seen.host.watching!(false)
      answer(true)
      await settled()
      expect(fake.watches).toEqual([])
      expect(watchLines()).toEqual([])
      seen.host.watching!(true)
      await settled()
      expect(fake.probes.count).toBe(2)
      expect(fake.watches).toHaveLength(1)
      expect(watchLines()).toEqual([STARTED])
    })

    it('a dial that detaches and attaches again during the probe gets one watch', async () => {
      let answer = (_watches: boolean): void => {}
      const { fake, settle } = await dialWith({ watches: new Promise<boolean>((resolve) => { answer = resolve }) })
      await settle('orca')
      seen.host.watching!(false)
      seen.host.watching!(true)
      answer(true)
      await settled()
      expect(fake.probes.count).toBe(1)
      expect(fake.watches).toHaveLength(1)
      expect(watchLines()).toEqual([STARTED])
    })

    it('the dial detaching stops the watch and drops its pane: a late line of the old one moves nothing, and the next settle starts a new one', async () => {
      const { fake, settle, line } = await dialWith()
      await settle('orca')
      const old = fake.watches[0]
      line(H(1))
      expect(asked()).toEqual([[agent(1), 'focus']])
      seen.host.watching!(false)
      expect(old.stopped).toBe(true)
      // A line already on its way as it stopped: neither followed nor kept.
      old.line(H(2))
      await settled()
      await settle('ghostty')
      seen.host.watching!(true)
      await settle('orca')
      expect(fake.watches).toHaveLength(2)
      await settle('ghostty')
      await settle('orca')
      expect(asked()).toEqual([[agent(1), 'focus']])
      expect(watchLines()).toEqual([STARTED, ENDED, STARTED])
    })

    it('a watch that ends by itself is dropped and says ended; nothing starts until Orca settles again, and a prompt in Orca moves the dial again meanwhile', async () => {
      const { port, fake, settle, line } = await dialWith()
      await settle('orca')
      line(H(1))
      fake.watches[0].end()
      await settled()
      expect(watchLines()).toEqual([STARTED, ENDED])
      port.observed(hook(2, { event: 'turn-start' }))
      expect(asked()).toEqual([[agent(1), 'focus'], [agent(2), 'prompt']])
      await settle('ghostty')
      expect(fake.probes.count).toBe(1)
      await settle('orca')
      expect(fake.probes.count).toBe(2)
      expect(fake.watches).toHaveLength(2)
      // Its pane went with it: the settle that started the new one followed nothing.
      expect(asked()).toHaveLength(2)
      expect(watchLines()).toEqual([STARTED, ENDED, STARTED])
    })

    it('the devices stopping stops the watch', async () => {
      const { port, fake, settle } = await dialWith()
      await settle('orca')
      await port.stop()
      expect(fake.watches[0].stopped).toBe(true)
      await settled()
      expect(watchLines()).toEqual([STARTED, ENDED])
    })
  })

  describe('following', () => {
    it('the watch\'s first line is followed as the settle: the dials are asked to follow that pane\'s agent, as a focus follow', async () => {
      const { settle, line } = await dialWith()
      await settle('orca')
      line(H(2))
      expect(asked()).toEqual([[agent(2), 'focus']])
      // What the dials make of it is theirs to count.
      expect(focusLines()).toEqual([])
    })

    it('a later line with Orca in front asks the dials to follow, right after a turn of the dial too', async () => {
      const { settle, line } = await dialWith()
      await settle('orca')
      line(H(1))
      // Only the settle is set aside by a turn: a person clicks a pane after it.
      turnTo(agent(1))
      line(H(2))
      expect(asked()).toEqual([[agent(1), 'focus'], [agent(2), 'focus']])
      expect(focusLines()).toEqual([])
    })

    it('the dial\'s answer is counted: focus · moved, and focus · skipped · no tile', () => {
      start({ faults: ['fleet'] })
      seen.host.localFollowed!('focus', 'moved')
      seen.host.localFollowed!('focus', 'no-tile')
      expect(focusLines()).toEqual(['[device] focus · moved', '[device] focus · skipped · no tile'])
    })

    it('a line with another app in front moves nothing, counted not in front, and Orca\'s next settle follows it', async () => {
      const { settle, line } = await dialWith()
      await settle('orca')
      await settle('ghostty')
      // The first line too: it is kept for the settle.
      line(H(1))
      expect(asked()).toEqual([])
      await settle('orca')
      expect(asked()).toEqual([[agent(1), 'focus']])
      await settle('ghostty')
      line(H(2))
      expect(asked()).toHaveLength(1)
      await settle('orca')
      expect(asked()).toEqual([[agent(1), 'focus'], [agent(2), 'focus']])
      expect(focusLines()).toEqual(Array(2).fill('[device] focus · skipped · not in front'))
    })

    it('a null line is kept and moves nothing: the settle after it follows nothing', async () => {
      const { settle, line } = await dialWith()
      await settle('orca')
      line(H(1))
      line(null)
      await settle('ghostty')
      line(null)
      await settle('orca')
      expect(asked()).toEqual([[agent(1), 'focus']])
      expect(focusLines()).toEqual([])
    })

    it('a pane no listed agent holds, or an ended session\'s, is skipped as unknown agent', async () => {
      const { port, settle, line } = await dialWith()
      await settle('orca')
      line(H(9))
      port.observed(hook(2, { event: 'session-end' }))
      line(H(2))
      expect(asked()).toEqual([])
      expect(focusLines()).toEqual(Array(2).fill('[device] focus · skipped · unknown agent'))
    })

    it('a line for the terminal an agent was only placed at by elimination finds no agent', async () => {
      const { port, fake, settle, line } = await dialWith({ agents: 0, attached: false })
      port.observed(hook(4))
      // Running in Orca before the dial came, idle since: no hook, so no pane.
      readers.known.set('sess-3', 'terminal')
      readers.owners.set('sess-3', { engine: 'claude', pid: 4243 })
      readers.rows.set('sess-3', { cwd: '/work/api', transcriptPath: null })
      readers.working.set('sess-3', false)
      readers.apps.mockResolvedValueOnce(new Map([[4243, 'orca']]))
      seen.host.watching!(true)
      await settled()
      const read = { tabs: [{ handle: H(3) }, { handle: H(4) }], terminals: [3, 4].map((n) => ({ handle: H(n), worktreePath: '/work/api', agentIdentity: 'claude' })), worktrees: new Map() }
      for (let i = 0; i < 2; i++) {
        fake.orders.at(-1)!(read)
        await settled()
      }
      expect(host().swipeSwitches(agent(3))).toBe(true)
      await settle('orca')
      line(H(3))
      expect(asked()).toEqual([])
      expect(focusLines()).toEqual(['[device] focus · skipped · unknown agent'])
    })

    it('no dial linked: nothing is followed or counted, in front or not', async () => {
      const { settle, line } = await dialWith()
      await settle('orca')
      unlinked(true)
      turnTo(agent(1))
      line(H(1))
      line(H(2))
      await settle('ghostty')
      line(H(1))
      await settle('orca')
      expect(asked()).toEqual([])
      expect(focusLines()).toEqual([])
    })
  })

  describe('the echo guard', () => {
    it('a rest\'s switch is the dial\'s echo: a line for that pane within 2 s is skipped once', async () => {
      const { settle, line } = await dialWith()
      await settle('orca')
      line(null)
      host().swipeEnded(agent(2), 'rest')
      expect(orcaRuns.map(([, args]) => args)).toEqual([['terminal', 'switch', '--terminal', H(2), '--json']])
      clock = 1_999
      line(H(2))
      expect(focusLines()).toEqual([ECHO])
      expect(asked()).toEqual([])
      // The person focusing that pane again moves the dial.
      line(H(2))
      expect(asked()).toEqual([[agent(2), 'focus']])
      clock = 3_000
      host().swipeEnded(agent(2), 'rest')
      clock = 5_000
      line(H(2))
      expect(asked()).toEqual([[agent(2), 'focus'], [agent(2), 'focus']])
      expect(focusLines()).toEqual([ECHO])
    })

    it('a switch after a slow worktree activate: a line for that pane within 2 s of the switch itself is still its echo', async () => {
      // `worktree activate` runs first, and can take long: Orca's line for the pane comes after the switch, not the rest.
      let activated = (): void => {}
      const holding = { ...orca, run: (file: string, args: string[], timeoutMs: number) => {
        orcaRuns.push([file, args, timeoutMs])
        return args[0] === 'worktree'
          ? new Promise<{ code: number; stdout: string }>((resolve) => { activated = () => resolve({ code: 0, stdout: '' }) })
          : Promise.resolve({ code: 0, stdout: '' })
      } }
      const { fake, settle, line } = await dialWith({ orca: holding })
      fake.orders.at(-1)!({ tabs: [{ handle: H(1) }, { handle: H(2) }], terminals: [], worktrees: new Map([[H(2), 'w0']]) })
      await settled()
      await settle('orca')
      line(null)
      host().swipeEnded(agent(2), 'rest')
      clock = 1_500
      activated()
      await vi.waitFor(() => expect(orcaRuns.map(([, args]) => args[0])).toEqual(['worktree', 'terminal']))
      clock = 3_400
      line(H(2))
      expect(asked()).toEqual([])
      expect(focusLines()).toEqual([ECHO])
    })

    it('a tap\'s switch is its echo too', async () => {
      const { settle, line } = await dialWith()
      await settle('orca')
      line(null)
      expect(await host().openAgent(agent(2))).toBeUndefined()
      expect(orcaRuns.map(([, args]) => args)).toEqual([['terminal', 'switch', '--terminal', H(2), '--json']])
      clock = 1_000
      line(H(2))
      expect(focusLines()).toEqual([ECHO])
      expect(asked()).toEqual([])
    })

    it('a line for a pane switched before the latest switch is still an echo, and uses up those before it', async () => {
      const { settle, line } = await dialWith({ agents: 3 })
      await settle('orca')
      line(null)
      host().swipeEnded(agent(1), 'rest')
      clock = 300
      host().swipeEnded(agent(2), 'rest')
      clock = 500
      host().swipeEnded(agent(3), 'rest')
      // Orca's line for the pane a fast swipe passed comes late: the dial is not pulled back to it.
      clock = 900
      line(H(2))
      // Orca shows its switches in order: the one before it will print no line now.
      clock = 1_000
      line(H(1))
      clock = 1_100
      line(H(3))
      expect(focusLines()).toEqual([ECHO, ECHO])
      expect(asked()).toEqual([[agent(1), 'focus']])
    })

    it('of nine switches the oldest is forgotten', async () => {
      const { settle, line } = await dialWith({ agents: 9 })
      await settle('orca')
      line(null)
      for (let n = 1; n <= 9; n++) {
        clock = (n - 1) * 100
        host().swipeEnded(agent(n), 'rest')
      }
      line(H(1))
      expect(asked()).toEqual([[agent(1), 'focus']])
      line(H(2))
      expect(focusLines()).toEqual([ECHO])
      expect(asked()).toHaveLength(1)
    })

    it('the settle is set aside right after the dial moved, counted echo, and follows 2 s later', async () => {
      const { settle, line } = await dialWith()
      turnTo(agent(1))
      await settle('orca')
      line(H(2))
      expect(focusLines()).toEqual([ECHO])
      expect(asked()).toEqual([])
      clock = 2_000
      await settle('ghostty')
      await settle('orca')
      expect(asked()).toEqual([[agent(2), 'focus']])
      expect(focusLines()).toEqual([ECHO])
    })

    it('the dial detaching forgets its switches', async () => {
      const { settle, line } = await dialWith()
      await settle('orca')
      host().swipeEnded(agent(2), 'rest')
      seen.host.watching!(false)
      seen.host.watching!(true)
      await settled()
      clock = 2_000
      line(H(2))
      expect(asked()).toEqual([[agent(2), 'focus']])
      expect(focusLines()).toEqual([])
    })
  })

  describe('the prompt', () => {
    it('while the watch runs, a prompt in an agent with an Orca pane asks nothing, counted focus followed', async () => {
      const { port, settle } = await dialWith()
      await settle('orca')
      expect(watchLines()).toEqual([STARTED])
      port.observed(hook(1, { event: 'turn-start' }))
      expect(asked()).toEqual([])
      expect(prompts()).toEqual(['[device] prompt · skipped · focus followed'])
    })

    it('one in tmux inside Orca still asks', async () => {
      const { port, settle } = await dialWith()
      const inTmux = { hostHints: { TMUX_PANE: '%3', ORCA_TERMINAL_HANDLE: H(3), __CFBundleIdentifier: 'com.stablyai.orca' } }
      port.observed(hook(3, inTmux))
      await settle('orca')
      expect(watchLines()).toEqual([STARTED])
      port.observed(hook(3, { ...inTmux, event: 'turn-start' }))
      expect(asked()).toEqual([[agent(3), 'prompt']])
      expect(prompts()).toEqual([])
    })

    it('with a CLI without watch-focus a prompt in Orca asks as before', async () => {
      const { port, settle } = await dialWith({ watches: false })
      await settle('orca')
      port.observed(hook(1, { event: 'turn-start' }))
      expect(asked()).toEqual([[agent(1), 'prompt']])
    })

    it('a relayed prompt, the dial\'s own and one not in front keep their own lines while the watch runs', async () => {
      const { port, settle } = await dialWith()
      await settle('orca')
      port.observed(hook(1, { event: 'turn-start', relayed: true }))
      port.observed(hook(1, { event: 'turn-stop' }))
      const poll = port.inboxPoll({ pollId: 'p1', sessionId: 'sess-1' })
      expect(await host().sendTurn(agent(1), 'run the tests')).toEqual({ ok: true })
      expect(await poll).toEqual({ text: 'run the tests' })
      port.observed(hook(1, { event: 'turn-start' }))
      port.observed(hook(1, { event: 'turn-stop' }))
      await settle('ghostty')
      port.observed(hook(1, { event: 'turn-start' }))
      expect(asked()).toEqual([])
      expect(prompts()).toEqual(['relayed', 'dial prompt', 'not in front'].map((why) => `[device] prompt · skipped · ${why}`))
    })
  })

  describe('the rest', () => {
    it('HARNESS_DEVICE_OBSERVED=off: no probe and no watch', async () => {
      const switched = env as { HARNESS_DEVICE_OBSERVED: boolean }
      switched.HARNESS_DEVICE_OBSERVED = false
      onTestFinished(() => { switched.HARNESS_DEVICE_OBSERVED = true })
      const { fake, settle } = await dialWith()
      await settle('orca')
      seen.host.watching!(false)
      seen.host.watching!(true)
      await settled()
      expect(fake.probes.count).toBe(0)
      expect(fake.watches).toEqual([])
      expect(watchLines()).toEqual([])
    })

    it('an orca part that throws costs the dial nothing', async () => {
      const { port, fake, settle } = await dialWith({ faults: ['orca'] })
      await settle('orca')
      port.observed(hook(1, { event: 'turn-start' }))
      expect(asked()).toEqual([[agent(1), 'prompt']])
      expect(fake.probes.count).toBe(0)
      expect(logs).toContain('[devices] orca failed · injected fault: orca')
    })

    it('no line holds a handle or an agent', async () => {
      const { port, settle, line } = await dialWith()
      turnTo(agent(1))
      await settle('orca')
      line(H(1))
      line(H(9))
      host().swipeEnded(agent(2), 'rest')
      line(H(2))
      port.observed(hook(1, { event: 'turn-start' }))
      await settle('ghostty')
      line(H(2))
      seen.host.localFollowed!('focus', 'moved')
      seen.host.localFollowed!('focus', 'no-tile')
      seen.host.watching!(false)
      expect(focusLines()).toHaveLength(6)
      for (const said of focusLines()) expect(said).toMatch(/^\[device\] focus · (moved|skipped · (echo|unknown agent|no tile|not in front))$/)
      expect(watchLines()).toEqual([STARTED, ENDED])
      expect(prompts()).toEqual(['[device] prompt · skipped · focus followed'])
      const secrets = [1, 2, 9].flatMap((n) => [H(n), agent(n), `sess-${n}`])
      expect(logs.filter((said) => secrets.some((secret) => said.includes(secret)))).toEqual([])
    })
  })
})
