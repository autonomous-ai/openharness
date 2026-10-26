// The pty host rollover on two real builds (sub-project G): a host an older daemon started keeps its pane while new
// panes go to the installed build's host, an agent moves from one to the other with its scrollback and the input typed
// meanwhile, and the old host is shut down and its version folder removed once its last pane has gone.
//
// The move is the daemon's own (core/agents/hostMove.ts on lib/hostMove/moveAgent.ts), on real PtyHostBackends, a real
// coordinator, stream manager and move gate. Faked is only what needs a whole core: the registry (an in-memory row),
// the launch (a stand-in engine that prints its argv and waits for input, in place of a real engine's resume), the old
// engine's stop (the pane is kept, its process killed) and the probe of the new engine (the process the respawn put in
// the pane). Both builds come from the same source; the previous one is stamped with an older version:
//   cd pty && HARNESS_PTY_VERSION=0.0.1 cargo +stable build && cp target/debug/harness-pty <scratch>/harness-pty-old && cargo +stable build
//   cd cli && HARNESS_PTY_BIN=$(pwd)/../pty/target/debug/harness-pty HARNESS_PTY_BIN_PREV=<scratch>/harness-pty-old \
//     npx vitest run src/lib/hostMove/hostMove.real.spec.ts
// The previous build's version names its folder under <runtime>/pty/, as an install's does: a number (VERSION_DIR).
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHostMove, moveWaitingArgv } from '../../core/agents/hostMove.js'
import type { PtyHostBackend } from '../ptyHostBackend.js'
import { PtyHostClient } from '../ptyHost/client.js'
import { ptyHostBackends, PtyHostDrain, rowsOnInstance } from '../ptyHost/drain.js'
import { binaryVersion, compareVersions, readInstanceDiscovery, removeUnusedPtyVersions, targetHost, VERSION_DIR, type PtyHostTarget } from '../ptyHost/launch.js'
import type { RegisteredSession } from '../registry.js'
import type { RestartAgentDeps } from '../restartAgent.js'
import { restoreTerminals } from '../restoreTerminals.js'
import { removeTree } from '../terminalBackend.contract.js'
import type { TerminalBackend } from '../terminalBackend.js'
import { TerminalBackendCoordinator } from '../terminalBackendCoordinator.js'
import { TerminalBinaryKind, type TerminalBinaryClear } from '../terminalBinary.js'
import { terminalRouteKey } from '../terminalRuntime.js'
import { TerminalStreamManager } from '../terminalStreamManager.js'
import type { ProcessIdentity, PtyRuntimeRef, TerminalRuntimeRef } from '../terminalTypes.js'
import { MoveGate } from './gate.js'
import type { MoveOutcome } from './moveAgent.js'

const realBinary = process.env.HARNESS_PTY_BIN
const previousBinary = process.env.HARNESS_PTY_BIN_PREV
const WINDOWS = process.platform === 'win32'
const CASE_TIMEOUT_MS = WINDOWS ? 90_000 : 30_000
const WAIT_MS = WINDOWS ? 20_000 : 8_000
const ENTER = WINDOWS ? '\r' : '\n'
const BINARY = WINDOWS ? 'harness-pty.exe' : 'harness-pty'
/** What the host loads from its own folder on Windows, as it ships in runtime\pty\<version>\ (windows.yml places them). */
const BESIDE = ['conpty.dll', 'OpenConsole.exe']
const OWNER = 'me'
const AGENT = 'agent-rollover'
const CONVERSATION = 'conv-rollover'
const OLD_LINES = 60

/**
 * The stand-in engine: prints its argv, a start prints [OLD_LINES] lines of history (more than a screen holds), then
 * it says it is ready and prints each line it is sent, until it is killed. Started as `--start <id>`, resumed as
 * `--resume <id>`, as an engine's resume names its conversation.
 */
const ENGINE = `
const args = process.argv.slice(2)
console.log('engine-argv ' + args.join(' '))
if (args[0] === '--start') for (let i = 1; i <= ${OLD_LINES}; i++) console.log('old-line-' + i)
console.log('engine-ready')
let buffered = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffered += chunk
  for (let at = buffered.search(/[\\r\\n]/); at >= 0; at = buffered.search(/[\\r\\n]/)) {
    const line = buffered.slice(0, at)
    buffered = buffered.slice(at + 1)
    if (line) console.log('engine-got=' + line)
  }
})
`

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function until<T>(read: () => Promise<T> | T, ok: (value: T) => boolean, ms = WAIT_MS): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await read()
    if (ok(value) || Date.now() > end) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const killPid = (pid: number | undefined) => { if (pid) try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
const count = (text: string, part: string) => text.split(part).length - 1

/** [binary] installed as `<runtime>/pty/<version>/`, with what it loads beside it. */
function install(runtimeDir: string, binary: string, version: string): string {
  const dir = path.join(runtimeDir, 'pty', version)
  mkdirSync(dir, { recursive: true })
  copyFileSync(binary, path.join(dir, BINARY))
  for (const name of BESIDE) {
    const file = path.join(path.dirname(binary), name)
    if (existsSync(file)) copyFileSync(file, path.join(dir, name))
  }
  return dir
}

interface Rollover {
  home: string
  runtimeDir: string
  oldDir: string
  newDir: string
  oldVersion: string
  target: PtyHostTarget
  oldPid: number
  oldPane: PtyRuntimeRef
  create: PtyHostBackend
  drain: PtyHostBackend
  backends: TerminalBackend[]
  terminals: TerminalBackendCoordinator
  rows: Map<string, RegisteredSession>
  gate: MoveGate
  manager: TerminalStreamManager
  engineArgv(...args: string[]): string[]
  screen(runtime: PtyRuntimeRef): Promise<string>
  /** A stream on the agent, as a window opens one: what it showed so far, and a keystroke line through it. */
  openStream(connId: string): Promise<{ output(): string; type(text: string): Promise<void> }>
}

/**
 * A home with both builds installed (`current-pty` naming the new one), the old build's host started as an older
 * daemon left it with the agent's pane, and this daemon's backends: the target's host (started from its installed
 * folder) and a drain backend on the old one.
 */
async function rollover(): Promise<Rollover> {
  // The drain's own lines (a backend that left, the old host's connection lost as it shuts down): the cases check
  // what they say happened.
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const home = mkdtempSync(path.join(tmpdir(), 'pty-rollover-'))
  cleanup.push(() => removeTree(home, 20_000))
  const runtimeDir = path.join(home, 'runtime')
  const newVersion = binaryVersion(realBinary!)?.version
  const oldVersion = binaryVersion(previousBinary!)?.version
  if (!newVersion || !oldVersion) throw new Error('a binary says no version')
  for (const version of [newVersion, oldVersion]) {
    if (!VERSION_DIR.test(version)) throw new Error(`${version} cannot name a version folder: build with a numeric HARNESS_PTY_VERSION`)
  }
  expect(compareVersions(oldVersion, newVersion)).toBeLessThan(0)
  const oldDir = install(runtimeDir, previousBinary!, oldVersion)
  const newDir = install(runtimeDir, realBinary!, newVersion)
  writeFileSync(path.join(runtimeDir, 'pty', 'current-pty'), `${newVersion}\n`)
  // The host this daemon starts is the installed one's: the create backend's launch resolves HARNESS_PTY_BIN first.
  vi.stubEnv('HARNESS_PTY_BIN', path.join(newDir, BINARY))
  const target = targetHost({ runtimeDir })
  if (!target) throw new Error('the installed build says no version')
  expect(target).toMatchObject({ version: newVersion, source: 'installed', features: expect.arrayContaining(['seed']) })
  const previous = targetHost({ runtimeDir, env: { HARNESS_PTY_BIN: path.join(oldDir, BINARY) } })!
  expect(previous.instance).not.toBe(target.instance)
  cleanup.push(() => { killPid(readInstanceDiscovery(home, previous.instance)?.pid); killPid(readInstanceDiscovery(home, target.instance)?.pid) })

  const script = path.join(home, 'engine.cjs')
  writeFileSync(script, ENGINE)
  const engineArgv = (...args: string[]) => [process.execPath, script, ...args]

  // The host an older daemon started from its own folder, with the agent's engine in a pane, held as every pane is.
  spawn(path.join(oldDir, BINARY), ['serve', '--home', home], { cwd: home, detached: true, stdio: 'ignore', windowsHide: true }).unref()
  const old = await until(() => readInstanceDiscovery(home, previous.instance), (found) => found !== null)
  if (!old) throw new Error('the old host published no discovery file')
  const before = await PtyHostClient.connect(old)
  if (!(before instanceof PtyHostClient)) throw new Error(JSON.stringify(before))
  const made = await before.call({ op: 'create', command: engineArgv('--start', CONVERSATION), cwd: home, cols: 80, rows: 24, owner: OWNER, hold: true })
  before.close()
  if (made.state !== 'ok') throw new Error(JSON.stringify(made))
  const oldPane: PtyRuntimeRef = { backend: 'ptyhost', instance: previous.instance, paneId: made.value.pane }

  // This daemon.
  const hosts = ptyHostBackends(home, { target, owner: () => OWNER })
  const [drain] = hosts.drain
  const create = hosts.create
  cleanup.push(() => { create.dispose(); drain?.dispose() })
  expect(hosts.drain.map((backend) => backend.instanceId)).toEqual([`ptyhost:${previous.instance}`])
  expect(await create.prepare({ ownedPanes: new Map() })).toEqual({ state: 'ready' })
  expect(await drain.prepare({ ownedPanes: new Map() })).toEqual({ state: 'ready' })
  expect(create.instanceId).toBe(`ptyhost:${target.instance}`)
  expect(create.canSeed).toBe(true)
  const backends: TerminalBackend[] = [create, drain]
  const terminals = new TerminalBackendCoordinator(backends, ['ptyhost'])

  const rows = new Map<string, RegisteredSession>([[AGENT, {
    schemaVersion: 2, agentId: AGENT, sessionId: CONVERSATION, engine: 'codex', active: true, boundAt: null, cwd: home,
    registeredAt: Date.now(), touchedAt: Date.now(), runtimes: [oldPane], primaryRuntimeKey: terminalRouteKey(oldPane),
  } as unknown as RegisteredSession]])
  const gate = new MoveGate()
  const binarySent: Array<{ connId: string; frame: TerminalBinaryClear }> = []
  const sent: Array<{ connId: string; type: string; payload: Record<string, unknown> }> = []
  const manager = new TerminalStreamManager({
    terminals,
    resolveAgent: (id) => rows.get(id),
    sendTarget: (connId, type, payload) => { sent.push({ connId, type, payload }); return true },
    sendBinaryTarget: (connId, frame) => { binarySent.push({ connId, frame }); return true },
    streamingAvailable: true,
    moveGate: gate,
  })
  cleanup.push(() => manager.stop())

  const screen = async (runtime: PtyRuntimeRef) => {
    const read = await terminals.backendFor(runtime)!.capture(runtime, { historyLines: 2000, ansi: false })
    return read.state === 'succeeded' ? read.value : ''
  }
  expect(await until(() => screen(oldPane), (text) => text.includes('engine-ready'))).toContain('engine-ready')

  const openStream = async (connId: string) => {
    await manager.handleFrame(connId, 'terminal_open', { requestId: `open-${connId}`, protocolVersion: 3, agentId: AGENT, cols: 100, rows: 30 })
    const ready = sent.findLast((frame) => frame.connId === connId && frame.type === 'terminal_ready')
    if (!ready) throw new Error(`no stream opened: ${JSON.stringify(sent.filter((frame) => frame.connId === connId))}`)
    const streamId = String(ready.payload.streamId)
    let seq = 0
    return {
      output: () => binarySent
        .filter((entry) => entry.connId === connId && entry.frame.streamId === streamId
          && (entry.frame.kind === TerminalBinaryKind.output || entry.frame.kind === TerminalBinaryKind.keyframe))
        .map((entry) => Buffer.from(entry.frame.bytes).toString('utf8')).join(''),
      type: (text: string) => manager.handleBinary(connId, { kind: TerminalBinaryKind.input, streamId, seq: seq++, bytes: Buffer.from(text), compressed: false }),
    }
  }

  return {
    home, runtimeDir, oldDir, newDir, oldVersion, target, oldPid: old.pid, oldPane, create, drain, backends, terminals,
    rows, gate, manager, engineArgv, screen, openStream,
  }
}

/**
 * The agent's move to the target's host, as the mover runs it (core/agents/hostMove.ts `createHostMove`). [duringStop]
 * runs as the old engine is about to be stopped, with the agent's input held: the swap is under way.
 */
async function move(rig: Rollover, duringStop: () => Promise<void> = async () => {}): Promise<{ outcome: MoveOutcome; lines: string[] }> {
  const { rows, terminals } = rig
  const lines: string[] = []
  const restore = restoreTerminals({
    backendFor: (runtime) => terminals.backendFor(runtime),
    listTmuxPanes: async () => ({ ok: false }),
    cwd: rig.home,
    label: () => 'rollover',
  })
  /** The waiting command each new pane ran before its respawn: the engine is the process that took its place. */
  const waiting = new Map<string, number>()
  const backendOf = (runtime: TerminalRuntimeRef) => terminals.backendFor(runtime) as PtyHostBackend
  const moveOne = createHostMove({
    registry: {
      byAgent: (id) => rows.get(id),
      transaction: async (apply) => apply(),
      updateRuntimes: (id, runtimes, primaryRuntimeKey) => {
        const row = rows.get(id)
        if (!row) return false
        rows.set(id, { ...row, runtimes: [...runtimes], ...(primaryRuntimeKey ? { primaryRuntimeKey } : {}) })
        return true
      },
      updateProcessIdentity: (id, identity) => {
        const row = rows.get(id)
        if (!row) return false
        rows.set(id, { ...row, processIdentity: identity })
        return true
      },
      setActive: () => true,
    },
    terminals,
    createBackend: () => rig.create,
    restore: {
      respawn: async (runtime, launch, control) => {
        const pid = await backendOf(runtime).rootProcess(runtime as PtyRuntimeRef)
        if (typeof pid === 'number') waiting.set(terminalRouteKey(runtime), pid)
        return restore.respawn(runtime, launch, control)
      },
      probeProcess: async (runtime) => {
        const pid = await backendOf(runtime).rootProcess(runtime as PtyRuntimeRef)
        if (typeof pid !== 'number' || pid === waiting.get(terminalRouteKey(runtime))) return null
        return { pid, executable: process.execPath, startMarker: `pid-${pid}` } satisfies ProcessIdentity
      },
    },
    buildLaunch: async (row, options) => ({
      argv: rig.engineArgv('--resume', options.resumeSessionId ?? row.sessionId),
      deferred: { prepare: () => {}, overrides: { env: {}, extraArgs: [], clearEnv: [] }, permission: {} },
    }),
    // The stop a restart makes: the pane is kept, then its engine ends. Nothing else of a swap is asked by a move.
    paneSwapDeps: (_session, { backend, runtime }) => ({
      holdOpen: async () => {
        const kept = await backend.holdOpen(runtime)
        return kept.state === 'succeeded' ? { ok: true } : { ok: false, reason: kept.reason }
      },
      terminate: async () => {
        await duringStop()
        const pid = await backend.rootProcess(runtime)
        if (typeof pid !== 'number') return 'failed'
        process.kill(pid, 'SIGKILL')
        const state = await until(() => backend.paneState(runtime), (read) => read !== 'unknown' && read !== 'gone' && read.dead)
        return state !== 'unknown' && state !== 'gone' && state.dead ? 'killed' : 'failed'
      },
    }) as unknown as RestartAgentDeps,
    retarget: (agentId, runtime) => rig.manager.retarget(agentId, runtime),
    gate: rig.gate,
    eligible: () => true,
    holdRoute: () => () => {},
    announce: () => {},
    invalidateControl: () => {},
    waitingArgv: () => moveWaitingArgv(),
    log: (line) => { lines.push(line) },
  })
  const outcome = await moveOne(rows.get(AGENT)!, () => true)
  return { outcome, lines }
}

/** The pane the agent's row names now. */
const rowPane = (rig: Rollover) => rig.rows.get(AGENT)!.runtimes[0] as PtyRuntimeRef

describe.runIf(!!realBinary && !!previousBinary)('the pty host rollover on two real builds', () => {
  it('a pane on the old host keeps streaming and taking input while a new pane opens on the new host', async () => {
    const rig = await rollover()
    const stream = await rig.openStream('window-1')
    await stream.type(`before-new-pane${ENTER}`)
    expect(await until(() => stream.output(), (text) => text.includes('engine-got=before-new-pane'))).toContain('engine-got=before-new-pane')

    const fresh = await rig.create.create({ command: rig.engineArgv('--start', 'conv-other'), cwd: rig.home })
    if (fresh.state !== 'succeeded') throw new Error(JSON.stringify(fresh))
    expect(fresh.runtime.instance).toBe(rig.target.instance)
    expect(rig.terminals.backendFor(fresh.runtime)).toBe(rig.create)
    expect(await until(() => rig.screen(fresh.runtime), (text) => text.includes('engine-ready'))).toContain('engine-argv --start conv-other')
    // The old host refuses new panes from this daemon: they go to the target's.
    expect(await rig.drain.create({ command: rig.engineArgv('--start', 'conv-refused') })).toMatchObject({ state: 'failed', dispatch: 'not_started' })

    await stream.type(`after-new-pane${ENTER}`)
    expect(await until(() => stream.output(), (text) => text.includes('engine-got=after-new-pane'))).toContain('engine-got=after-new-pane')
    expect(alive(rig.oldPid)).toBe(true)
    const oldListed = await rig.drain.inventory()
    expect(oldListed.state === 'available' && oldListed.roots.map((root) => root.runtime)).toEqual([rig.oldPane])
    const newListed = await rig.create.inventory()
    expect(newListed.state === 'available' && newListed.roots.map((root) => root.runtime)).toEqual([fresh.runtime])
    expect((await rig.create.kill(fresh.runtime)).state).toBe('succeeded')
  }, CASE_TIMEOUT_MS)

  it('a moved pane\'s history holds the old pane\'s lines', async () => {
    const rig = await rollover()
    const { outcome, lines } = await move(rig)
    expect(outcome, lines.join('\n')).toEqual({ moved: true, resumed: true })
    const moved = rowPane(rig)
    expect(moved.instance).toBe(rig.target.instance)
    expect(rig.terminals.backendFor(moved)).toBe(rig.create)
    const text = await until(() => rig.screen(moved), (value) => value.includes('engine-argv --resume'))
    // The old pane's whole scrollback, past one screen, then the resumed engine below it, naming the conversation.
    for (let line = 1; line <= OLD_LINES; line++) expect(text).toMatch(new RegExp(`^old-line-${line}$`, 'm'))
    expect(text.indexOf(`engine-argv --start ${CONVERSATION}`)).toBeGreaterThanOrEqual(0)
    expect(text.indexOf(`old-line-${OLD_LINES}`)).toBeLessThan(text.indexOf(`engine-argv --resume ${CONVERSATION}`))
    // The move closed the old pane.
    expect(await until(() => rig.drain.paneState(rig.oldPane), (state) => state === 'gone')).toBe('gone')
  }, CASE_TIMEOUT_MS)

  it('the old host shuts down after its last pane goes, and its version folder is removed', async () => {
    const rig = await rollover()
    const removed: string[] = []
    const drainer = new PtyHostDrain({
      drain: [rig.drain],
      backends: rig.backends,
      coordinator: rig.terminals,
      inUse: (instanceId) => rowsOnInstance([...rig.rows.values()], instanceId),
      cleanup: () => { removed.push(...removeUnusedPtyVersions(rig.home, rig.runtimeDir)) },
    })
    // While the old host runs, its folder stays: its version is a running host's.
    expect(removeUnusedPtyVersions(rig.home, rig.runtimeDir)).toEqual([])
    await drainer.step()
    await drainer.step()
    expect(rig.backends).toHaveLength(2)
    expect(existsSync(path.join(rig.oldDir, BINARY))).toBe(true)

    const { outcome, lines } = await move(rig)
    expect(outcome, lines.join('\n')).toEqual({ moved: true, resumed: true })
    // The move closed the old host's last pane: two empty passes later it is shut down, and its backend has left.
    await until(() => rig.drain.drainState(), (state) => state === 'empty')
    await drainer.step()
    expect(rig.backends).toHaveLength(2)
    await drainer.step()
    expect(rig.backends).toEqual([rig.create])
    expect(rig.terminals.instances()).toEqual([rig.create])
    expect(await until(() => alive(rig.oldPid), (up) => !up)).toBe(false)
    expect(readInstanceDiscovery(rig.home, rig.drain.instanceId.replace(/^ptyhost:/, ''))).toBeNull()
    // Its binaries are deleted with it; the installed build's stay, and its host runs the moved agent.
    // A folder that could not be removed (a file still locked on Windows) is said on console.error, stubbed here.
    const said = vi.mocked(console.error).mock.calls.map((call) => call.join(' ')).join('\n')
    expect(removed, said).toEqual([rig.oldVersion])
    expect(existsSync(rig.oldDir), said).toBe(false)
    expect(existsSync(path.join(rig.newDir, BINARY))).toBe(true)
    expect(await rig.create.paneState(rowPane(rig))).toMatchObject({ dead: false })
  }, CASE_TIMEOUT_MS)

  it('input sent during the swap arrives in the new pane', async () => {
    const rig = await rollover()
    const stream = await rig.openStream('window-1')
    expect(await until(() => stream.output(), (text) => text.includes('engine-ready'))).toContain('engine-ready')
    let held = false
    let oldScreen = ''
    const { outcome, lines } = await move(rig, async () => {
      // Typed as the old engine is about to stop, while it still runs: the gate holds it, and the old engine, given
      // the time to print it, never sees it.
      await stream.type(`typed-in-swap${ENTER}`)
      held = rig.gate.holding(AGENT)
      await new Promise((resolve) => setTimeout(resolve, 500))
      oldScreen = await rig.screen(rig.oldPane)
    })
    expect(outcome, lines.join('\n')).toEqual({ moved: true, resumed: true })
    expect(held).toBe(true)
    expect(oldScreen).toContain('engine-ready')
    expect(oldScreen).not.toContain('typed-in-swap')
    const moved = rowPane(rig)
    expect(moved.instance).toBe(rig.target.instance)
    const text = await until(() => rig.screen(moved), (value) => value.includes('engine-got=typed-in-swap'))
    // Delivered once, to the resumed engine.
    expect(count(text, 'engine-got=typed-in-swap')).toBe(1)
    expect(text.indexOf(`engine-argv --resume ${CONVERSATION}`)).toBeLessThan(text.indexOf('engine-got=typed-in-swap'))
    // The window's stream followed the agent: it shows the new pane, and what is typed now goes there.
    expect(await until(() => stream.output(), (value) => value.includes('engine-got=typed-in-swap'))).toContain('engine-got=typed-in-swap')
    await stream.type(`after-move${ENTER}`)
    expect(await until(() => rig.screen(moved), (value) => value.includes('engine-got=after-move'))).toContain('engine-got=after-move')
  }, CASE_TIMEOUT_MS)
})
