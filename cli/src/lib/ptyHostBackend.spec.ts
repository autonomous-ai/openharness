import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyEvent, PtyOp } from './ptyHost/protocol.js'
import type { PtyHostClient } from './ptyHost/client.js'
import type { EnsurePtyHostResult } from './ptyHost/launch.js'
import type { PtyRuntimeRef } from './terminalTypes.js'

// validate's branches, not the process table: the same narrow mock tmuxBackendValidate.spec.ts uses.
const lookupPaneEngineProcess = vi.hoisted(() => vi.fn())
vi.mock('./paneEngineProcess.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./paneEngineProcess.js')>()),
  lookupPaneEngineProcess,
}))

// The Windows seams, watched: the real ones still run (setProcessTableSource feeds processRows below).
vi.mock('./processTable.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./processTable.js')>()
  return { ...actual, setProcessTableSource: vi.fn(actual.setProcessTableSource) }
})
vi.mock('./processSignals.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./processSignals.js')>()
  return { ...actual, setAgentSignaller: vi.fn(actual.setAgentSignaller) }
})

const { PtyHostBackend } = await import('./ptyHostBackend.js')
const { defaultWindowsShell } = await import('./windows/shell.js')
const { processRows, setProcessTableSource } = await import('./processTable.js')
const { setAgentSignaller, signalAgentProcess } = await import('./processSignals.js')

type Reply = unknown | ((op: PtyOp) => unknown)

/** A backend over a stub client: [replies] by op name, an `ok {}` for the rest. */
interface BackendOptions {
  owner?: string
  stream?: () => Promise<unknown>
  platform?: NodeJS.Platform
  endTree?: (pid: number) => Promise<'sent' | 'gone' | 'failed'>
}

function backendWith(replies: Record<string, Reply>, options: BackendOptions = {}) {
  const calls: PtyOp[] = []
  const listeners = new Set<(event: PtyEvent) => void>()
  const client = {
    instance: 'p1',
    call: async (op: PtyOp) => {
      calls.push(op)
      const reply = replies[op.op]
      return (typeof reply === 'function' ? reply(op) : reply) ?? { state: 'ok', value: {} }
    },
    onEvent: (listener: (event: PtyEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    onClose: () => () => {},
    close() {},
    openStream: options.stream ?? (async () => null),
  }
  const backend = new PtyHostBackend({
    home: '/tmp/h',
    launch: async () => ({ client: client as unknown as PtyHostClient }),
    owner: () => options.owner ?? 'me',
    // The platform is the test's, not the machine's: off Windows unless it says otherwise.
    platform: options.platform ?? 'linux',
    ...(options.endTree ? { endTree: options.endTree } : {}),
  })
  const emit = (event: PtyEvent) => { for (const listener of listeners) listener(event) }
  return { backend, calls, emit }
}

async function ready(replies: Record<string, Reply> = {}, options: BackendOptions = {}) {
  const made = backendWith(replies, options)
  expect(await made.backend.prepare({ ownedPanes: new Map() })).toEqual({ state: 'ready' })
  return made
}

const PANE: PtyRuntimeRef = { backend: 'ptyhost', instance: 'p1', paneId: '%1' }
const UUID = /^[a-f0-9-]{36}$/

afterEach(() => {
  vi.useRealTimers()
  lookupPaneEngineProcess.mockReset()
})

describe('PtyHostBackend prepare', () => {
  it('takes its instance from the host it reached', async () => {
    const { backend } = await ready()
    expect(backend.name).toBe('ptyhost')
    expect(backend.instanceId).toBe('ptyhost:p1')
    expect(await backend.capabilities()).toEqual({ sessionEnv: true })
  })

  it('says the host is unavailable, with its code', async () => {
    const backend = new PtyHostBackend({ home: '/tmp/h', launch: async () => ({ unavailable: 'harness-pty is not installed', code: 'PTY_HOST_UNAVAILABLE' }) })
    expect(await backend.prepare({ ownedPanes: new Map() }))
      .toEqual({ state: 'unavailable', code: 'PTY_HOST_UNAVAILABLE', reason: 'harness-pty is not installed' })
    expect(await backend.inventory()).toEqual({ state: 'unavailable', reason: 'pty host is unavailable' })
    expect(await backend.create({ command: ['/bin/sh'] })).toMatchObject({ state: 'failed', dispatch: 'not_started' })
  })

  it('reads an incompatible host as unavailable, saying why', async () => {
    const launch = async (): Promise<EnsurePtyHostResult> => ({ incompatible: 'incompatible: wrong token' })
    const backend = new PtyHostBackend({ home: '/tmp/h', launch })
    expect(await backend.prepare({ ownedPanes: new Map() }))
      .toEqual({ state: 'unavailable', code: 'PTY_HOST_UNAVAILABLE', reason: 'incompatible: wrong token' })
  })
})

describe('PtyHostBackend create', () => {
  it('asks for a held 200x50 pane owned by this daemon', async () => {
    const { backend, calls } = await ready({ create: { state: 'ok', value: { pane: '%4' } } })
    const result = await backend.create({ command: ['claude'], cwd: '/w', label: 'harness-claude-1', env: { K: 'v' } })
    expect(result).toEqual({ state: 'succeeded', dispatch: 'executed', runtime: { backend: 'ptyhost', instance: 'p1', paneId: '%4' } })
    expect(calls).toEqual([{ op: 'create', command: ['claude'], cwd: '/w', env: { K: 'v' }, cols: 200, rows: 50, owner: 'me', label: 'harness-claude-1', hold: true }])
  })

  it('gives the host what the pane runs after its command, without its env when it has none', async () => {
    const { backend, calls } = await ready({ create: { state: 'ok', value: { pane: '%4' } } })
    await backend.create({ command: ['codex.exe'], afterExit: { command: ['pwsh.exe'], env: { HARNESS_ENGINE_COMMAND: 'codex' } } })
    await backend.create({ command: ['codex.exe'], afterExit: { command: ['cmd.exe'] }, clearInherited: ['ANTHROPIC_API_KEY'] })
    expect(calls.map((call) => (call as { afterExit?: unknown }).afterExit)).toEqual([
      { command: ['pwsh.exe'], env: { HARNESS_ENGINE_COMMAND: 'codex' } }, { command: ['cmd.exe'] },
    ])
    // What the pane must not inherit from the host's environment; none sent when there is none.
    expect(calls.map((call) => (call as { clearInherited?: unknown }).clearInherited)).toEqual([undefined, ['ANTHROPIC_API_KEY']])
    await backend.respawn(PANE, { command: ['codex.exe'], afterExit: { command: ['pwsh.exe'], env: { A: 'b' } } })
    await backend.respawn(PANE, { command: ['codex.exe'], afterExit: { command: ['cmd.exe'] } })
    // The two lists stay apart: the create env's names, and this launch's inherited ones.
    await backend.respawn(PANE, { command: ['codex.exe'], clearEnv: ['ANTHROPIC_BASE_URL'], clearInherited: ['ANTHROPIC_API_KEY'] })
    expect(calls.at(-1)).toEqual({ op: 'respawn', pane: '%1', command: ['codex.exe'], clearEnv: ['ANTHROPIC_BASE_URL'], clearInherited: ['ANTHROPIC_API_KEY'] })
    calls.pop()
    expect(calls.slice(2)).toEqual([
      { op: 'respawn', pane: '%1', command: ['codex.exe'], afterExit: { command: ['pwsh.exe'], env: { A: 'b' } } },
      { op: 'respawn', pane: '%1', command: ['codex.exe'], afterExit: { command: ['cmd.exe'] } },
    ])
  })

  it('runs the shell when given no command', async () => {
    const { backend, calls } = await ready({ create: { state: 'ok', value: { pane: '%4' } } })
    await backend.create({})
    expect(calls[0]).toMatchObject({ op: 'create', command: [process.env.SHELL || '/bin/sh'] })
  })

  it('runs PowerShell on Windows when given no command', async () => {
    const { backend, calls } = await ready({ create: { state: 'ok', value: { pane: '%4' } } }, { platform: 'win32' })
    try {
      await backend.create({})
      expect(calls.find((call) => call.op === 'create')).toMatchObject({ op: 'create', command: defaultWindowsShell() })
    } finally { backend.dispose() }
  })

  it('sends nothing once the harness has changed', async () => {
    const { backend, calls } = await ready()
    const dispatched = vi.fn()
    expect(await backend.create({ command: ['sh'], current: () => false, onDispatch: dispatched }))
      .toMatchObject({ state: 'failed', dispatch: 'not_started' })
    expect(calls).toEqual([])
    expect(dispatched).not.toHaveBeenCalled()
  })

  it('passes a host refusal on as it is', async () => {
    const { backend } = await ready({ create: { state: 'failed', dispatch: 'rejected', code: 'spawn_failed', reason: 'no such file' } })
    expect(await backend.create({ command: ['nope'] })).toEqual({ state: 'failed', dispatch: 'rejected', reason: 'no such file' })
  })

  it('records the pane before an exit that overtook its reply is released', async () => {
    // The client holds an exit that came in before the create reply and releases it on setImmediate
    // (client.ts): the create's own continuation must already know the pane by then.
    let emit: (event: PtyEvent) => void = () => {}
    const made = await ready({
      create: () => {
        setImmediate(() => emit({ event: 'exit', pane: '%9', status: 3 }))
        return { state: 'ok', value: { pane: '%9' } }
      },
    })
    emit = made.emit
    const created = await made.backend.create({ command: ['sh', '-c', 'exit 3'] })
    expect(created.state).toBe('succeeded')
    await new Promise((resolve) => setImmediate(resolve))
    expect(made.backend.known({ ...PANE, paneId: '%9' })).toEqual({ hold: true, exited: 3 })
  })
})

describe('PtyHostBackend pane records', () => {
  it('forgets a pane whose process ended once it is no longer held', async () => {
    const { backend, emit } = await ready({ create: { state: 'ok', value: { pane: '%1' } } })
    await backend.create({ command: ['sh'] })
    await backend.releaseHold(PANE)
    expect(backend.known(PANE)).toEqual({ hold: false })
    emit({ event: 'exit', pane: '%1', status: 0 })
    expect(backend.known(PANE)).toBeUndefined()
  })

  it('forgets a held pane that already exited when its hold is released', async () => {
    const { backend, emit, calls } = await ready({ create: { state: 'ok', value: { pane: '%1' } } })
    await backend.create({ command: ['sh'] })
    emit({ event: 'exit', pane: '%1', status: 1 })
    await backend.releaseHold(PANE)
    expect(calls.at(-1)).toEqual({ op: 'releaseHold', pane: '%1' })
    expect(backend.known(PANE)).toBeUndefined()
  })

  it('ignores exits of panes it never made', async () => {
    const { backend, emit } = await ready()
    emit({ event: 'exit', pane: '%7', status: 0 })
    emit({ event: 'title', pane: '%7', title: 't' })
    expect(backend.known({ ...PANE, paneId: '%7' })).toBeUndefined()
  })

  it('a release the harness changed before sends nothing', async () => {
    const { backend, calls } = await ready()
    await backend.releaseHold(PANE, () => false)
    expect(calls).toEqual([])
  })
})

describe('PtyHostBackend kill', () => {
  it('kills with a 2 s grace and forgets the pane', async () => {
    const { backend, calls } = await ready({ create: { state: 'ok', value: { pane: '%1' } } })
    await backend.create({ command: ['sh'] })
    expect(await backend.kill(PANE)).toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(calls.at(-1)).toEqual({ op: 'kill', pane: '%1', graceMs: 2000 })
    expect(backend.known(PANE)).toBeUndefined()
  })

  it('checks the stop is still current right before the call', async () => {
    const { backend, calls } = await ready()
    expect(await backend.kill(PANE, () => false)).toMatchObject({ state: 'failed', dispatch: 'not_started' })
    expect(calls).toEqual([])
  })

  it('a pane the host no longer has is already closed', async () => {
    const { backend } = await ready({ kill: { state: 'failed', dispatch: 'not_started', code: 'no_pane', reason: 'no pane %1' } })
    expect(await backend.kill(PANE)).toEqual({ state: 'succeeded', dispatch: 'executed' })
  })

  it('an unanswered kill may have happened', async () => {
    const { backend } = await ready({ kill: { state: 'unknown', dispatch: 'possibly_executed', reason: 'timeout' } })
    expect(await backend.kill(PANE)).toEqual({ state: 'unknown', dispatch: 'possibly_executed', reason: 'timeout' })
  })
})

describe('PtyHostBackend inventory and titles', () => {
  it('inventory unavailable when the host call fails', async () => {
    const { backend } = backendWith({ inventory: { state: 'unknown', dispatch: 'possibly_executed', reason: 'timeout' } })
    await backend.prepare({ ownedPanes: new Map() })
    expect(await backend.inventory()).toEqual({ state: 'unavailable', reason: 'timeout' })
  })

  it('lists this daemon\'s panes, a dead held one with its last pid as tmux lists it', async () => {
    const row = (pane: string, owner: string, rootPid: number | null, dead = false) => ({ pane, rootPid, cwd: `/w${pane}`, title: '', dead, owner, label: null })
    const { backend } = await ready({
      inventory: { state: 'ok', value: { panes: [row('%1', 'me', 11), row('%2', 'other', 12), row('%3', 'me', 13, true), row('%4', 'me', null, true)] } },
    })
    expect(await backend.inventory()).toEqual({
      state: 'available',
      roots: [
        { runtime: { backend: 'ptyhost', instance: 'p1', paneId: '%1' }, rootPid: 11, cwd: '/w%1' },
        { runtime: { backend: 'ptyhost', instance: 'p1', paneId: '%3' }, rootPid: 13, cwd: '/w%3' },
      ],
    })
  })

  it('keys titles by route', async () => {
    const { backend } = await ready({ titles: { state: 'ok', value: { titles: { '%1': 'one' } } } })
    const titles = await backend.titles()
    expect(titles).toEqual({ state: 'succeeded', value: new Map([['ptyhost\u0000p1\u0000%1', 'one']]) })
  })

  it('titles fail when the host does not answer', async () => {
    const { backend } = await ready({ titles: { state: 'failed', dispatch: 'not_started', code: 'not_connected', reason: 'closed' } })
    expect(await backend.titles()).toEqual({ state: 'failed', reason: 'closed' })
  })
})

describe('PtyHostBackend reads', () => {
  it('rootProcess says missing for no_pane', async () => {
    const { backend } = backendWith({ paneInfo: { state: 'failed', dispatch: 'not_started', code: 'no_pane', reason: 'x' } })
    await backend.prepare({ ownedPanes: new Map() })
    expect(await backend.rootProcess({ backend: 'ptyhost', instance: 'p1', paneId: '%3' })).toBe('missing')
  })

  it('rootProcess names the pid, null when it could not ask', async () => {
    const info = { command: 'sh', path: '/w', pid: 42, tty: '/dev/ttys001' }
    expect(await (await ready({ paneInfo: { state: 'ok', value: { info } } })).backend.rootProcess(PANE)).toBe(42)
    expect(await (await ready({ paneInfo: { state: 'unknown', dispatch: 'possibly_executed', reason: 't' } })).backend.rootProcess(PANE)).toBeNull()
  })

  it('rootProcess of a held pane whose process ended is missing: no process runs there', async () => {
    const info = { command: 'sh', path: '/w', pid: null, tty: '/dev/ttys001' }
    expect(await (await ready({ paneInfo: { state: 'ok', value: { info } } })).backend.rootProcess(PANE)).toBe('missing')
  })

  it('paneInfo passes the host\'s answer on, null otherwise', async () => {
    const info = { command: 'sh', path: '/w', pid: 42, tty: '/dev/ttys001' }
    expect(await (await ready({ paneInfo: { state: 'ok', value: { info } } })).backend.paneInfo(PANE)).toEqual(info)
    expect(await (await ready({ paneInfo: { state: 'failed', dispatch: 'not_started', code: 'no_pane', reason: 'x' } })).backend.paneInfo(PANE)).toBeNull()
  })

  it('paneState: gone, unknown, or the pane as tmux would describe it', async () => {
    expect(await (await ready({ paneState: { state: 'ok', value: { state: 'gone' } } })).backend.paneState(PANE)).toBe('gone')
    expect(await (await ready({ paneState: { state: 'unknown', dispatch: 'possibly_executed', reason: 't' } })).backend.paneState(PANE)).toBe('unknown')
    const state = { dead: true, exitStatus: 3, command: ['/usr/local/bin/claude', '--x'], engineExit: 2, startCommand: '/usr/local/bin/claude --x' }
    expect(await (await ready({ paneState: { state: 'ok', value: { state } } })).backend.paneState(PANE))
      .toEqual({ dead: true, exitStatus: 3, command: 'claude', engineExit: 2 })
  })

  it('reads nothing from a pane of another host instance', async () => {
    const { backend, calls } = await ready()
    const other: PtyRuntimeRef = { ...PANE, instance: 'p2' }
    expect(await backend.paneState(other)).toBe('unknown')
    expect(await backend.rootProcess(other)).toBeNull()
    expect(await backend.typeLiteral(other, 'x')).toMatchObject({ state: 'failed', dispatch: 'not_started' })
    expect(calls).toEqual([])
  })
})

describe('PtyHostBackend capture', () => {
  async function captured(options?: Parameters<InstanceType<typeof PtyHostBackend>['capture']>[1]) {
    const { backend, calls } = await ready({ capture: { state: 'ok', value: { text: 'screen' } } })
    expect(await backend.capture(PANE, options)).toEqual({ state: 'succeeded', value: 'screen' })
    return calls[0]
  }

  it('visible: the screen alone', async () => {
    expect(await captured({ mode: 'visible', ansi: false })).toEqual({ op: 'capture', pane: '%1', visible: true, ansi: false })
  })

  it('recent_unwrapped: history lines, bounded as tmuxCaptureArgs bounds them, ansi unless told not', async () => {
    expect(await captured({ mode: 'recent_unwrapped', historyLines: 50 })).toEqual({ op: 'capture', pane: '%1', visible: false, historyLines: 50, ansi: true })
    expect(await captured({ mode: 'recent_unwrapped', historyLines: 5000, ansi: false })).toMatchObject({ historyLines: 300, ansi: false })
    expect(await captured({ historyLines: 1 })).toMatchObject({ historyLines: 20, visible: false })
    expect(await captured()).toMatchObject({ historyLines: 100, visible: false, ansi: true })
  })

  it('detection: as TmuxBackend.capture, which gives only `visible` by mode', async () => {
    const { tmuxCaptureArgs } = await import('./tmuxCapture.js')
    // tmux: `capture-pane -p -e -J -t %1 -S -100`, and with the caller's lines and no colours `-p -J … -S -40`.
    expect(tmuxCaptureArgs('%1', undefined, { visible: false, ansi: undefined })).toEqual(['capture-pane', '-p', '-e', '-J', '-t', '%1', '-S', '-100'])
    expect(await captured({ mode: 'detection' })).toEqual({ op: 'capture', pane: '%1', visible: false, historyLines: 100, ansi: true })
    expect(tmuxCaptureArgs('%1', 40, { visible: false, ansi: false })).toEqual(['capture-pane', '-p', '-J', '-t', '%1', '-S', '-40'])
    expect(await captured({ mode: 'detection', historyLines: 40, ansi: false })).toEqual({ op: 'capture', pane: '%1', visible: false, historyLines: 40, ansi: false })
  })

  it('a failed capture says why', async () => {
    const { backend } = await ready({ capture: { state: 'failed', dispatch: 'not_started', code: 'no_pane', reason: 'no pane %1' } })
    expect(await backend.capture(PANE)).toEqual({ state: 'failed', reason: 'no pane %1' })
  })
})

describe('PtyHostBackend input', () => {
  it('typeLiteral types the text unbracketed, as tmux types it', async () => {
    const { backend, calls } = await ready()
    expect(await backend.typeLiteral(PANE, 'héllo')).toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(calls).toEqual([{ op: 'paste', pane: '%1', text: 'héllo', bracketed: false }])
  })

  it('sendKey sends the tmux name of the key', async () => {
    const { backend, calls } = await ready()
    await backend.sendKey(PANE, 'backtab')
    await backend.sendKey(PANE, 'ctrl-c')
    expect(calls).toEqual([{ op: 'key', pane: '%1', key: 'BTab' }, { op: 'key', pane: '%1', key: 'C-c' }])
  })

  it('submitText withholds Enter when beforeEnter objects', async () => {
    const { backend, calls } = backendWith({})
    await backend.prepare({ ownedPanes: new Map() })
    const result = await backend.submitText({ backend: 'ptyhost', instance: 'p1', paneId: '%1' }, 'hi', { beforeEnter: async () => 'dialog' })
    expect(result).toMatchObject({ state: 'unknown', reason: 'enter_withheld:dialog' })
    expect(calls.some((c) => c.op === 'key')).toBe(false)
  })

  it('submitText pastes bracketed, without trailing newlines, then presses Enter', async () => {
    const { backend, calls } = await ready()
    const beforeEnter = vi.fn(async () => null)
    expect(await backend.submitText(PANE, 'hi\n\n', { beforeEnter })).toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(calls).toEqual([{ op: 'paste', pane: '%1', text: 'hi', bracketed: true }, { op: 'key', pane: '%1', key: 'Enter' }])
    expect(beforeEnter).toHaveBeenCalledOnce()
  })

  it('submitText gives a multi-line paste time to settle before Enter', async () => {
    vi.useFakeTimers()
    const { backend, calls } = await ready()
    const text = 'one\ntwo'
    const sent = backend.submitText(PANE, text)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.map((c) => c.op)).toEqual(['paste'])
    await vi.advanceTimersByTimeAsync(399)
    expect(calls.map((c) => c.op)).toEqual(['paste'])
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.map((c) => c.op)).toEqual(['paste', 'key'])
    expect(await sent).toEqual({ state: 'succeeded', dispatch: 'executed' })
  })

  it('submitText stops before the paste, and before the Enter, once control is revoked', async () => {
    const before = await ready()
    expect(await before.backend.submitText(PANE, 'hi', { allowed: () => false })).toMatchObject({ state: 'failed', dispatch: 'not_started' })
    expect(before.calls).toEqual([])
    const after = await ready()
    let allowed = true
    const result = await after.backend.submitText(PANE, 'hi', { allowed: () => allowed, beforeEnter: async () => { allowed = false; return null } })
    expect(result).toMatchObject({ state: 'unknown', reason: 'enter_withheld:terminal control revoked' })
    expect(after.calls.map((c) => c.op)).toEqual(['paste'])
  })

  it('submitText reports a paste the host refused and presses no Enter', async () => {
    const { backend, calls } = await ready({ paste: { state: 'failed', dispatch: 'rejected', code: 'bad_request', reason: 'pane %1 has exited' } })
    expect(await backend.submitText(PANE, 'hi')).toEqual({ state: 'failed', dispatch: 'rejected', reason: 'pane %1 has exited' })
    expect(calls.map((c) => c.op)).toEqual(['paste'])
  })

  it('setTitle sets it on the host; notify needs nothing', async () => {
    const { backend, calls } = await ready()
    expect(await backend.setTitle(PANE, 'x'.repeat(300))).toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(await backend.notify(PANE, 'done', 'body')).toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(calls).toEqual([{ op: 'setTitle', pane: '%1', title: 'x'.repeat(200) }])
  })
})

describe('PtyHostBackend hold and respawn', () => {
  const TOKEN = '0b5f9d38-3c1e-4c55-9f1a-1d2e3f4a5b6c'

  it('holdOpen holds the pane, and needs no token', async () => {
    const { backend, calls } = await ready()
    expect(await backend.holdOpen(PANE)).toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(calls).toEqual([{ op: 'holdOpen', pane: '%1' }])
    expect(backend.known(PANE)).toEqual({ hold: true })
  })

  it('respawn passes the request on, and the caller\'s held token', async () => {
    const { backend, calls } = await ready()
    expect(await backend.respawn(PANE, { command: ['claude'], cwd: '/w', env: { K: 'v' } })).toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(await backend.respawn(PANE, { command: ['sh'], expectedHeldToken: TOKEN })).toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(calls).toEqual([
      { op: 'respawn', pane: '%1', command: ['claude'], cwd: '/w', env: { K: 'v' } },
      { op: 'respawn', pane: '%1', command: ['sh'], expectedHeldToken: TOKEN },
    ])
  })

  it('respawn sends the names to clear from the pane\'s create-time environment, and none when there are none', async () => {
    const { backend, calls } = await ready()
    await backend.respawn(PANE, { command: ['claude'], clearEnv: ['ANTHROPIC_BASE_URL'] })
    await backend.respawn(PANE, { command: ['claude'], clearEnv: [] })
    expect(calls).toEqual([
      { op: 'respawn', pane: '%1', command: ['claude'], clearEnv: ['ANTHROPIC_BASE_URL'] },
      { op: 'respawn', pane: '%1', command: ['claude'] },
    ])
  })

  it('a respawn clears the exit its pane had', async () => {
    const { backend, emit } = await ready({ create: { state: 'ok', value: { pane: '%1' } } })
    await backend.create({ command: ['sh'] })
    emit({ event: 'exit', pane: '%1', status: 1 })
    expect(backend.known(PANE)).toEqual({ hold: true, exited: 1 })
    await backend.respawn(PANE, { command: ['sh'] })
    expect(backend.known(PANE)).toEqual({ hold: true })
  })

  it('a pane that is not the held shell is not replaced', async () => {
    const { backend } = await ready({ respawn: { state: 'failed', dispatch: 'rejected', code: 'held_mismatch', reason: 'pane %1 is not held under that token' } })
    expect(await backend.respawn(PANE, { command: ['sh'], expectedHeldToken: TOKEN }))
      .toEqual({ state: 'failed', dispatch: 'not_started', reason: 'The waiting pane changed' })
  })

  it('a token that is not one is refused before anything is sent', async () => {
    const { backend, calls } = await ready()
    expect(await backend.respawn(PANE, { command: ['sh'], expectedHeldToken: 'tok' }))
      .toEqual({ state: 'failed', dispatch: 'not_started', reason: 'invalid waiting pane identity' })
    expect(calls).toEqual([])
  })

  it('a respawn that failed after the host may have killed the old process may have happened', async () => {
    const spawnFailed = await ready({ respawn: { state: 'failed', dispatch: 'rejected', code: 'spawn_failed', reason: 'No such file or directory' } })
    expect(await spawnFailed.backend.respawn(PANE, { command: ['nope'] }))
      .toEqual({ state: 'unknown', dispatch: 'possibly_executed', reason: 'pty host could not respawn the pane: No such file or directory' })
    const timedOut = await ready({ respawn: { state: 'unknown', dispatch: 'possibly_executed', reason: 'timeout' } })
    expect(await timedOut.backend.respawn(PANE, { command: ['sh'] })).toMatchObject({ state: 'unknown', dispatch: 'possibly_executed' })
    const unsent = await ready({ respawn: { state: 'failed', dispatch: 'not_started', code: 'not_connected', reason: 'closed' } })
    expect(await unsent.backend.respawn(PANE, { command: ['sh'] })).toEqual({ state: 'failed', dispatch: 'not_started', reason: 'closed' })
  })

  it('nothing is sent once the harness changed', async () => {
    const { backend, calls } = await ready()
    const dispatched = vi.fn()
    expect(await backend.respawn(PANE, { command: ['sh'], current: () => false, onDispatch: dispatched })).toMatchObject({ dispatch: 'not_started' })
    expect(await backend.holdOpen(PANE, () => false)).toMatchObject({ dispatch: 'not_started' })
    expect(calls).toEqual([])
    expect(dispatched).not.toHaveBeenCalled()
  })

  it('isHeld: a running pane whose start command is the held shell under this token', async () => {
    const state = (dead: boolean, startCommand: string) => ({ state: 'ok', value: { state: { dead, exitStatus: null, command: ['sh'], engineExit: null, startCommand } } })
    const held = `/bin/sh -c harness-held ${TOKEN}`
    const isHeld = async (reply: unknown, token = TOKEN) => (await ready({ paneState: reply })).backend.isHeld(PANE, token)
    expect(await isHeld(state(false, held))).toBe(true)
    expect(await isHeld(state(true, held))).toBe(false)
    expect(await isHeld(state(false, `/bin/sh -c harness-held ${'1'.repeat(36)}`))).toBe(false)
    expect(await isHeld(state(false, `/bin/sh -c ${TOKEN}`))).toBe(false)
    expect(await isHeld(state(false, `HARNESS_NATIVE_LAUNCH_TOKEN=${TOKEN} ${held}`))).toBe(false)
    expect(await isHeld({ state: 'ok', value: { state: 'gone' } })).toBe(false)
    expect(await isHeld({ state: 'unknown', dispatch: 'possibly_executed', reason: 't' })).toBe('unknown')
    expect(await isHeld(state(false, held), 'tok')).toBe('unknown')
  })
})

describe('PtyHostBackend killHeld', () => {
  const TOKEN = '0b5f9d38-3c1e-4c55-9f1a-1d2e3f4a5b6c'
  const held = `/bin/sh -c harness-held ${TOKEN}`
  const state = (dead: boolean, startCommand: string) => ({ state: 'ok', value: { state: { dead, exitStatus: null, command: ['sh'], engineExit: null, startCommand } } })

  it('closes the pane while it is the held shell under this token, dead or alive, as tmux\'s format reads it', async () => {
    for (const dead of [false, true]) {
      const { backend, calls } = await ready({ paneState: state(dead, held) })
      expect(await backend.killHeld(PANE, TOKEN, () => true)).toEqual({ state: 'succeeded', dispatch: 'executed' })
      expect(calls).toEqual([{ op: 'paneState', pane: '%1' }, { op: 'kill', pane: '%1', graceMs: 2000 }])
    }
  })

  it('leaves a pane that runs anything else, and calls a pane already gone closed', async () => {
    const other = await ready({ paneState: state(false, '/usr/local/bin/claude --resume x') })
    expect(await other.backend.killHeld(PANE, TOKEN, () => true))
      .toEqual({ state: 'failed', dispatch: 'not_started', reason: 'The waiting pane no longer has this adoption identity' })
    expect(other.calls.map((call) => call.op)).toEqual(['paneState'])
    const gone = await ready({ paneState: { state: 'ok', value: { state: 'gone' } } })
    expect(await gone.backend.killHeld(PANE, TOKEN, () => true)).toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(gone.calls.map((call) => call.op)).toEqual(['paneState'])
  })

  it('closes nothing it could not read, nor once the adoption changed, nor for an identity that is not one', async () => {
    const unread = await ready({ paneState: { state: 'unknown', dispatch: 'possibly_executed', reason: 'timeout' } })
    expect(await unread.backend.killHeld(PANE, TOKEN, () => true)).toEqual({ state: 'failed', dispatch: 'not_started', reason: 'timeout' })
    let current = true
    const changed = await ready({ paneState: () => { current = false; return state(false, held) } })
    expect(await changed.backend.killHeld(PANE, TOKEN, () => current))
      .toEqual({ state: 'failed', dispatch: 'not_started', reason: 'Adoption changed before pane close' })
    expect(changed.calls.map((call) => call.op)).toEqual(['paneState'])
    const invalid = await ready()
    expect(await invalid.backend.killHeld(PANE, 'tok', () => true)).toEqual({ state: 'failed', dispatch: 'not_started', reason: 'invalid waiting pane identity' })
    expect(await invalid.backend.killHeld({ ...PANE, paneId: '1' }, TOKEN, () => true)).toMatchObject({ dispatch: 'not_started' })
    expect(invalid.calls).toEqual([])
    const detached = backendWith({})
    expect(await detached.backend.killHeld(PANE, TOKEN, () => true)).toEqual({ state: 'failed', dispatch: 'not_started', reason: 'pty host is unavailable' })
  })
})

describe('PtyHostBackend validate', () => {
  const LIVE = { pid: 15160, executable: '/usr/local/bin/claude', startMarker: 'Tue Sep 15 23:10:38 2026' }

  it('alive when the pane runs the recorded process', async () => {
    const { backend } = await ready()
    lookupPaneEngineProcess.mockResolvedValue({ ok: true, identity: LIVE })
    expect(await backend.validate(PANE, { engine: 'claude', processIdentity: LIVE })).toEqual({ state: 'alive' })
    expect(await backend.validate(PANE, { engine: 'claude' })).toEqual({ state: 'alive' })
    expect(lookupPaneEngineProcess).toHaveBeenCalledWith(backend, PANE, 'claude')
  })

  it('replaced when the pane runs another process of the engine', async () => {
    const { backend } = await ready()
    lookupPaneEngineProcess.mockResolvedValue({ ok: true, identity: LIVE })
    const saved = { ...LIVE, pid: 999, startMarker: 'Mon Sep 14 08:00:00 2026' }
    expect(await backend.validate(PANE, { engine: 'claude', processIdentity: saved }))
      .toEqual({ state: 'gone', reason: 'process changed under ptyhost pane', replaced: true })
  })

  it('takes a marker written before psEnv, which no live process can match', async () => {
    const { backend } = await ready()
    lookupPaneEngineProcess.mockResolvedValue({ ok: true, identity: LIVE })
    expect(await backend.validate(PANE, { engine: 'claude', processIdentity: { ...LIVE, startMarker: 'K szept. 15 23:10:38 2026' } }))
      .toEqual({ state: 'alive' })
  })

  it('gone and unknown as the lookup says, unknown when it throws', async () => {
    const { backend } = await ready()
    lookupPaneEngineProcess.mockResolvedValueOnce({ ok: false, unknown: false, reason: 'ptyhost:p1:%1 has no pane' })
    expect(await backend.validate(PANE, { engine: 'claude' })).toEqual({ state: 'gone', reason: 'ptyhost:p1:%1 has no pane' })
    lookupPaneEngineProcess.mockResolvedValueOnce({ ok: false, unknown: true, reason: 'ptyhost:p1:%1 could not be resolved' })
    expect(await backend.validate(PANE, { engine: 'claude' })).toEqual({ state: 'unknown', reason: 'ptyhost:p1:%1 could not be resolved' })
    lookupPaneEngineProcess.mockRejectedValueOnce(new Error('boom'))
    expect(await backend.validate(PANE, { engine: 'claude' })).toEqual({ state: 'unknown', reason: 'pty host runtime probe failed' })
  })
})

describe('PtyHostBackend validate on Windows', () => {
  const ENGINE = { pid: 11, executable: 'claude.exe', startMarker: 'w:5' }
  afterEach(() => setProcessTableSource(null))

  it('pid outside job is gone', async () => {
    const { backend, calls } = backendWith({ jobPids: { state: 'ok', value: { pids: [1, 2] } }, paneInfo: { state: 'ok', value: { info: { pid: 10 } } } })
    await backend.prepare({ ownedPanes: new Map() })
    setProcessTableSource(async () => [
      { pid: 10, parentPid: 1, executable: 'pwsh', startMarker: 'w:1', args: 'pwsh' },
      { pid: 11, parentPid: 10, executable: 'claude.exe', startMarker: 'w:5', args: 'claude.exe' },
    ])
    lookupPaneEngineProcess.mockResolvedValue({ ok: true, identity: ENGINE })
    const v = await backend.validateOn('win32', PANE, { engine: 'claude', processIdentity: ENGINE })
    expect(v).toEqual({ state: 'gone', reason: 'process is not in the pane job' })
    expect(calls).toContainEqual({ op: 'jobPids', pane: '%1' })
  })

  it('alive when the engine is in the pane job, with or without a recorded identity', async () => {
    const { backend } = await ready({ jobPids: { state: 'ok', value: { pids: [10, 11] } } }, { platform: 'win32' })
    lookupPaneEngineProcess.mockResolvedValue({ ok: true, identity: ENGINE })
    expect(await backend.validate(PANE, { engine: 'claude', processIdentity: ENGINE })).toEqual({ state: 'alive' })
    expect(await backend.validate(PANE, { engine: 'claude' })).toEqual({ state: 'alive' })
  })

  it('unknown, never gone, when the job cannot be listed or the host is not reached', async () => {
    const { backend } = await ready({ jobPids: { state: 'unknown', dispatch: 'possibly_executed', reason: 'no reply within 5000 ms' } })
    lookupPaneEngineProcess.mockResolvedValue({ ok: true, identity: ENGINE })
    expect(await backend.validateOn('win32', PANE, { engine: 'claude', processIdentity: ENGINE }))
      .toEqual({ state: 'unknown', reason: 'pty host could not list the pane job: no reply within 5000 ms' })
    expect(await backend.validateOn('win32', { ...PANE, instance: 'p2' }, { engine: 'claude', processIdentity: ENGINE }))
      .toEqual({ state: 'unknown', reason: 'pty host is unavailable' })
  })

  it('compares a Windows start marker: another process with the pid is a replacement', async () => {
    const { backend, calls } = await ready({ jobPids: { state: 'ok', value: { pids: [11] } } })
    lookupPaneEngineProcess.mockResolvedValue({ ok: true, identity: { ...ENGINE, startMarker: 'w:6' } })
    expect(await backend.validateOn('win32', PANE, { engine: 'claude', processIdentity: ENGINE }))
      .toEqual({ state: 'gone', reason: 'process changed under ptyhost pane', replaced: true })
    expect(calls.some((op) => op.op === 'jobPids')).toBe(false)
  })

  it('asks for no job off Windows', async () => {
    const { backend, calls } = await ready()
    lookupPaneEngineProcess.mockResolvedValue({ ok: true, identity: ENGINE })
    expect(await backend.validateOn('linux', PANE, { engine: 'claude', processIdentity: ENGINE })).toEqual({ state: 'alive' })
    expect(calls.some((op) => op.op === 'jobPids')).toBe(false)
  })
})

describe('PtyHostBackend on Windows: the process table and the agent signaller', () => {
  const ROW = { pid: 900, parentPid: 4, executable: 'claude.exe', startMarker: 'w:133', args: 'claude.exe', nativeArgv: ['claude.exe'] }
  const inventory = (panes: Array<{ pane: string; rootPid: number; dead?: boolean }>) => ({
    state: 'ok', value: { panes: panes.map((pane) => ({ cwd: '/', title: '', owner: 'me', label: null, dead: false, ...pane })) },
  })
  beforeEach(() => {
    vi.mocked(setProcessTableSource).mockClear()
    vi.mocked(setAgentSignaller).mockClear()
  })
  afterEach(() => {
    setProcessTableSource(null)
    setAgentSignaller(null)
    vi.restoreAllMocks()
  })

  it('reads the process table from the connected host until disposed', async () => {
    const { backend, calls } = await ready({ processes: { state: 'ok', value: { rows: [ROW] } } }, { platform: 'win32' })
    expect(await processRows()).toEqual([ROW])
    expect(calls).toContainEqual({ op: 'processes' })
    backend.dispose()
    expect(setProcessTableSource).toHaveBeenLastCalledWith(null)
    expect(setAgentSignaller).toHaveBeenLastCalledWith(null)
  })

  it('reads it from the host it reconnected to', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const asked: string[] = []
    const host = (name: string) => {
      const made = hostClient(10)
      made.call = (async (op: PtyOp) => {
        asked.push(`${name}:${op.op}`)
        return op.op === 'processes' ? { state: 'ok', value: { rows: [{ ...ROW, args: name }] } } : { state: 'ok', value: {} }
      }) as typeof made.call
      return made
    }
    const first = host('first')
    const second = host('second')
    const launch = vi.fn(async (): Promise<EnsurePtyHostResult> => ({ client: (launch.mock.calls.length === 1 ? first : second) as unknown as PtyHostClient }))
    const backend = new PtyHostBackend({ home: '/tmp/h', launch, owner: () => 'me', platform: 'win32' })
    await backend.prepare({ ownedPanes: new Map() })
    expect((await processRows())?.[0]?.args).toBe('first')
    first.lose()
    await vi.advanceTimersByTimeAsync(1_000)
    expect((await processRows())?.[0]?.args).toBe('second')
    expect(asked).toEqual(['first:processes', 'second:processes'])
    backend.dispose()
  })

  it('installs nothing off Windows', async () => {
    const { backend } = await ready()
    backend.dispose()
    expect(setProcessTableSource).not.toHaveBeenCalled()
    expect(setAgentSignaller).not.toHaveBeenCalled()
  })

  it('ends every pid\'s tree, a pane root too, for SIGTERM and SIGKILL alike, and never closes the pane', async () => {
    const endTree = vi.fn(async () => 'sent' as const)
    const { calls } = await ready({ inventory: inventory([{ pane: '%3', rootPid: 900 }]) }, { platform: 'win32', endTree })
    // The root of a pane (a restart's held pane must survive its engine) and any other process alike.
    for (const [pid, signal] of [[900, 'SIGTERM'], [900, 'SIGKILL'], [905, 'SIGTERM'], [905, 'SIGKILL']] as const) {
      endTree.mockClear()
      signalAgentProcess(pid, signal)
      await vi.waitFor(() => expect(endTree).toHaveBeenCalledExactlyOnceWith(pid))
    }
    expect(calls.some((op) => op.op === 'kill' || op.op === 'inventory')).toBe(false)
  })

  it('ends the tree with TerminateProcess over the host\'s table, leaves first, and never with taskkill', async () => {
    const rows = [
      { ...ROW, pid: 900, parentPid: 4, startMarker: 'w:100' },
      { ...ROW, pid: 901, parentPid: 900, startMarker: 'w:110' },
      { ...ROW, pid: 902, parentPid: 901, startMarker: 'w:120' },
      // A parent pid reused: started before the root, so not the root's.
      { ...ROW, pid: 700, parentPid: 900, startMarker: 'w:99' },
    ]
    const { calls } = await ready({ processes: { state: 'ok', value: { rows } } }, { platform: 'win32' })
    const killed: Array<[number, unknown]> = []
    const kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal: unknown) => { killed.push([pid, signal]); return true }) as typeof process.kill)
    signalAgentProcess(900, 'SIGTERM')
    await vi.waitFor(() => expect(killed).toEqual([[902, 'SIGKILL'], [901, 'SIGKILL'], [900, 'SIGKILL']]))
    expect(calls.filter((op) => op.op === 'processes')).toHaveLength(1)
    kill.mockRestore()
  })

  it('says which descendant would not end, and goes on to the root; a gone one it says nothing of', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rows = [
      { ...ROW, pid: 900, parentPid: 4, startMarker: 'w:100' },
      { ...ROW, pid: 901, parentPid: 900, startMarker: 'w:110' },
      { ...ROW, pid: 902, parentPid: 900, startMarker: 'w:120' },
    ]
    await ready({ processes: { state: 'ok', value: { rows } } }, { platform: 'win32' })
    const killed: number[] = []
    vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      killed.push(pid)
      if (pid === 901) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
      if (pid === 902) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
      return true
    }) as typeof process.kill)
    signalAgentProcess(900, 'SIGKILL')
    await vi.waitFor(() => expect(killed).toEqual([901, 902, 900]))
    expect(error.mock.calls).toEqual([['[terminal] ptyhost: could not end pid 901, under pid 900: kill EPERM']])
  })

  it('says when it could not end the process', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await ready({}, { platform: 'win32', endTree: vi.fn(async () => 'failed' as const) })
    signalAgentProcess(900, 'SIGTERM')
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('[terminal] ptyhost: could not end pid 900 (SIGTERM)'))
  })

  it('logs a signal it could not send at all', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const endTree = vi.fn(async () => { throw new Error('spawn failed') })
    const { backend } = await ready({}, { platform: 'win32', endTree })
    backend.dispose()
    backend.signalProcess(77, 'SIGTERM')
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('[terminal] ptyhost: could not SIGTERM pid 77: spawn failed'))
    const odd = vi.fn(async () => { throw 'odd' })
    const other = (await ready({}, { platform: 'win32', endTree: odd })).backend
    other.dispose()
    other.signalProcess(78, 'SIGKILL')
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('[terminal] ptyhost: could not SIGKILL pid 78: odd'))
  })
})

describe('PtyHostBackend openStream', () => {
  const sink = { onData: () => {}, onClose: () => {} }

  it('fails without a connection to the host, or with none for the stream', async () => {
    const unprepared = new PtyHostBackend({ home: '/tmp/h', launch: async () => ({ unavailable: 'no', code: 'PTY_HOST_UNAVAILABLE' }) })
    expect(await unprepared.openStream(PANE, { engine: 'terminal' }, { cols: 80, rows: 24 }, sink))
      .toEqual({ state: 'failed', reason: 'pty host is unavailable' })
    const { backend } = await ready()
    expect(await backend.openStream({ ...PANE, instance: 'p0' }, { engine: 'terminal' }, { cols: 80, rows: 24 }, sink))
      .toEqual({ state: 'failed', reason: 'pty host is unavailable' })
    expect(await backend.openStream(PANE, { engine: 'terminal' }, { cols: 80, rows: 24 }, sink))
      .toEqual({ state: 'failed', reason: 'pty host stream connection is unavailable' })
  })

  it('subscribes a stream connection to the pane', async () => {
    const { Duplex, PassThrough } = await import('node:stream')
    const { encodeFrame, FrameKind, FrameReader } = await import('./ptyHost/protocol.js')
    const toStream = new PassThrough()
    const fromStream = new PassThrough()
    const reader = new FrameReader()
    fromStream.on('data', (chunk: Buffer) => {
      for (const frame of reader.push(chunk)) {
        expect(frame.kind).toBe(FrameKind.Subscribe)
        expect(JSON.parse(frame.payload.toString())).toEqual({ pane: '%1', cols: 80, rows: 24, readOnly: true })
        toStream.write(encodeFrame(FrameKind.Ack, Buffer.from(JSON.stringify({ for: FrameKind.Subscribe, ok: true }))))
      }
    })
    const { backend } = await ready({}, { stream: async () => Duplex.from({ readable: toStream, writable: fromStream }) })
    const opened = await backend.openStream(PANE, { engine: 'terminal' }, { cols: 80, rows: 24 }, sink, true)
    expect(opened.state).toBe('succeeded')
    if (opened.state === 'succeeded') {
      expect(opened.value.runtime).toEqual(PANE)
      await opened.value.close()
    }
  })
})

/** A stub client whose connection the test ends, from a host with [pid]. */
function hostClient(pid: number, inventory: unknown = { state: 'ok', value: { panes: [] } }) {
  const events = new Set<(event: PtyEvent) => void>()
  const closes = new Set<() => void>()
  const client = {
    instance: 'p1',
    pid,
    closed: false,
    call: async (op: PtyOp) => (op.op === 'inventory' ? inventory : op.op === 'create' ? { state: 'ok', value: { pane: '%1' } } : { state: 'ok', value: {} }),
    onEvent: (listener: (event: PtyEvent) => void) => { events.add(listener); return () => { events.delete(listener) } },
    onClose: (listener: () => void) => { closes.add(listener); return () => { closes.delete(listener) } },
    close() { client.closed = true },
    openStream: async () => null,
    /** The host ended the connection. */
    lose() { for (const listener of [...closes]) listener() },
    emit(event: PtyEvent) { for (const listener of [...events]) listener(event) },
    events,
    closes,
  }
  return client
}
type HostClient = ReturnType<typeof hostClient>

/** A backend whose launches answer from [results] in turn (a client, or unavailable), then unavailable. */
function reconnecting(results: Array<HostClient | 'down' | Error>) {
  const launches: number[] = []
  const launch = vi.fn(async (): Promise<EnsurePtyHostResult> => {
    launches.push(Date.now())
    const next = results.shift() ?? 'down'
    if (next instanceof Error) throw next
    if (next === 'down') return { unavailable: 'harness-pty did not publish its discovery file within 5000 ms', code: 'PTY_HOST_UNAVAILABLE' }
    return { client: next as unknown as PtyHostClient }
  })
  const backend = new PtyHostBackend({ home: '/tmp/h', launch, owner: () => 'me' })
  return { backend, launch, launches }
}

describe('PtyHostBackend host connection', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('a second prepare replaces the first connection and its listeners', async () => {
    const first = hostClient(10)
    const second = hostClient(10)
    const { backend } = reconnecting([first, second])
    await backend.prepare({ ownedPanes: new Map() })
    await backend.prepare({ ownedPanes: new Map() })
    expect(first.events.size + first.closes.size).toBe(0)
    expect(first.closed).toBe(true)
    expect(second.events.size).toBe(1)
    expect(second.closes.size).toBe(1)
    // The first connection ending later is not this backend's concern any more.
    first.lose()
    expect((await backend.inventory()).state).toBe('available')
  })

  it('is unavailable while disconnected, and reconnects after 1 s, then 2 s, 4 s … at most 30 s apart', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const first = hostClient(10)
    const again = hostClient(10)
    const { backend, launch, launches } = reconnecting([first, 'down', new Error('spawn EAGAIN'), 'down', 'down', 'down', 'down', 'down', 'down', again])
    await backend.prepare({ ownedPanes: new Map() })
    const start = Date.now()
    first.lose()
    expect(await backend.inventory()).toEqual({ state: 'unavailable', reason: 'pty host is unavailable' })
    expect(await backend.create({ command: ['sh'] })).toMatchObject({ state: 'failed', dispatch: 'not_started' })
    expect(launch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000 + 8_000 + 16_000 + 30_000 + 30_000 + 30_000 + 30_000)
    expect(launches.slice(1).map((at) => at - start)).toEqual([
      1_000, 3_000, 7_000, 15_000, 31_000, 61_000, 91_000, 121_000, 151_000,
    ])
    expect(await backend.inventory()).toEqual({ state: 'available', roots: [] })
    expect(again.events.size).toBe(1)
    // A loss after the connection stayed up 30 s starts again from 1 s.
    await vi.advanceTimersByTimeAsync(30_000)
    again.lose()
    await vi.advanceTimersByTimeAsync(999)
    expect(launch).toHaveBeenCalledTimes(10)
    await vi.advanceTimersByTimeAsync(1)
    expect(launch).toHaveBeenCalledTimes(11)
  })

  it('a host that dies within 30 s of the connection keeps the growing delay', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const hosts = [hostClient(10), hostClient(11), hostClient(12), hostClient(13)]
    const { backend, launches } = reconnecting([...hosts])
    await backend.prepare({ ownedPanes: new Map() })
    const start = Date.now()
    // Each host dies 29 s after the connection: the delays go on growing, 1 s, 2 s, 4 s.
    for (const [index, host] of hosts.slice(0, 3).entries()) {
      if (index > 0) await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(29_000)
      host.lose()
      const before = launches.length
      await vi.advanceTimersByTimeAsync(2 ** index * 1_000 - 1)
      expect(launches.length).toBe(before)
      await vi.advanceTimersByTimeAsync(1)
      expect(launches.length).toBe(before + 1)
    }
    expect(launches.slice(1).map((at) => at - start)).toEqual([30_000, 61_000, 94_000])
    expect(hosts[3].events.size).toBe(1)
  })

  it('says the host was replaced when the one it reconnects to has another pid, and forgets its panes', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const first = hostClient(10)
    const same = hostClient(10)
    const other = hostClient(11)
    const { backend } = reconnecting([first, same, other])
    const replaced = vi.fn()
    backend.onHostReplaced = replaced
    await backend.prepare({ ownedPanes: new Map() })
    const created = await backend.create({ command: ['sh'] })
    if (created.state !== 'succeeded') throw new Error('create')
    first.lose()
    await vi.advanceTimersByTimeAsync(1_000)
    // The same host, its connection dropped: nothing was lost.
    expect(replaced).not.toHaveBeenCalled()
    expect(backend.known(created.runtime)).toEqual({ hold: true })
    same.lose()
    // Lost again at once: the next attempt is 2 s on.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(replaced).toHaveBeenCalledTimes(1)
    expect(backend.known(created.runtime)).toBeUndefined()
    expect(other.events.size).toBe(1)
  })

  it('dispose closes the connection, leaves the host alone and stops reconnecting', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = hostClient(10)
    const { backend, launch } = reconnecting([first])
    await backend.prepare({ ownedPanes: new Map() })
    first.lose()
    backend.dispose()
    expect(first.events.size + first.closes.size).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(launch).toHaveBeenCalledTimes(1)
    expect(await backend.inventory()).toMatchObject({ state: 'unavailable' })
  })

  it('dispose while connected closes the client; one reached after dispose is closed at once', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = hostClient(10)
    const late = hostClient(11)
    let release: (value: EnsurePtyHostResult) => void = () => {}
    const launch = vi.fn()
      .mockResolvedValueOnce({ client: first as unknown as PtyHostClient })
      .mockReturnValueOnce(new Promise<EnsurePtyHostResult>((resolve) => { release = resolve }))
    const backend = new PtyHostBackend({ home: '/tmp/h', launch, owner: () => 'me' })
    const replaced = vi.fn()
    backend.onHostReplaced = replaced
    await backend.prepare({ ownedPanes: new Map() })
    first.lose()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(launch).toHaveBeenCalledTimes(2)
    backend.dispose()
    release({ client: late as unknown as PtyHostClient })
    await vi.advanceTimersByTimeAsync(0)
    expect(late.closed).toBe(true)
    expect(replaced).not.toHaveBeenCalled()
    const connected = hostClient(12)
    const fresh = new PtyHostBackend({ home: '/tmp/h', launch: async () => ({ client: connected as unknown as PtyHostClient }) })
    await fresh.prepare({ ownedPanes: new Map() })
    fresh.dispose()
    expect(connected.closed).toBe(true)
    expect(connected.events.size + connected.closes.size).toBe(0)
  })
})
