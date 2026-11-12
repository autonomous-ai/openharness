import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { HERMES_TERMINAL_RECORD, HERMES_TERMINAL_SAID } from '../../engines/hermes/contract.js'
import { terminalRecordNames, type Terminal, type TerminalRecordRead } from '../../engines/kit/terminalRecord.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { terminalRouteKey } from '../../lib/terminalRuntime.js'
import type { TerminalPaneInfo, TerminalRuntimeRef } from '../../lib/terminalTypes.js'
import { createHermesTerminal, type HermesObserved, type HermesPass } from './hermesTerminal.js'

const S = '20261112_100000_aaaaaa'
const OLD = '20261111_090000_bbbbbb'
const HOME = '/home/u/.hermes'
const STARTED = '2026-11-12T10:00:00Z'
const TMUX: TerminalRuntimeRef = { backend: 'tmux', paneId: '%5' }
const PTY: TerminalRuntimeRef = { backend: 'ptyhost', paneId: '%2', instance: 'p3' }
const RECORD: TerminalRecordRead = { state: 'record', sessionId: S, at: Date.parse(STARTED) + 1_000 }

const agent = (over: Partial<RegisteredSession> = {}): RegisteredSession =>
  ({ agentId: 'a1', sessionId: '', engine: 'hermes', lastHookAt: 0, ...over }) as RegisteredSession
const observed = (over: Partial<HermesObserved> = {}): HermesObserved => ({
  processIdentity: { pid: 42, executable: '/usr/local/bin/hermes', startMarker: STARTED },
  runtimes: [TMUX],
  primaryRuntimeKey: terminalRouteKey(TMUX),
  sandboxed: false,
  ...over,
})
const pass = (over: Partial<HermesPass> = {}) => ({ current: vi.fn(() => true), mayClaim: vi.fn((_sessionId: string) => true), hold: vi.fn((_error: unknown) => {}), ...over })

let clock = 0
function setup(platform: NodeJS.Platform = 'linux') {
  const deps = {
    platform,
    defaultHome: HOME,
    registry: { byAgent: vi.fn((agentId: string): RegisteredSession | undefined => agent({ agentId })) },
    paneInfo: vi.fn(async (_runtime: TerminalRuntimeRef): Promise<TerminalPaneInfo | null> => ({ command: 'hermes', path: '/work', pid: 42, tty: '/dev/pts/3' })),
    names: vi.fn((terminal: Terminal) => terminalRecordNames(HERMES_TERMINAL_RECORD, terminal)),
    stamp: vi.fn(async (_home: string, _names: readonly string[]) => '7:60:1000'),
    read: vi.fn(async (_home: string, _names: readonly string[], _sinceMs: number) => RECORD),
    kind: vi.fn(async (_home: string, _sessionId: string): Promise<'own' | 'waiting' | 'other'> => 'own'),
    recordSeen: vi.fn((_home: string) => {}),
    now: vi.fn(() => clock),
  }
  return { deps, t: createHermesTerminal(deps) }
}

let log: MockInstance<typeof console.log>
beforeEach(() => {
  clock = 0
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())
const lines = (text: string): string[] => log.mock.calls.map(([line]) => String(line)).filter(line => line.includes(text))

describe('following a Hermes from its terminal record', () => {
  it('is not asked on Windows', async () => {
    const { deps, t } = setup('win32')
    expect(await t.follow(agent(), observed(), pass())).toBe('none')
    expect(deps.paneInfo).not.toHaveBeenCalled()
    expect(deps.stamp).not.toHaveBeenCalled()
  })

  it('names the pane by its tty and, for tmux, its pane id, once per process', async () => {
    const { deps, t } = setup()
    await t.follow(agent(), observed(), pass())
    await t.follow(agent(), observed(), pass())
    expect(deps.names).toHaveBeenCalledExactlyOnceWith({ tty: '/dev/pts/3', tmuxPane: '%5' })
    expect(deps.paneInfo).toHaveBeenCalledExactlyOnceWith(TMUX)

    // The primary runtime is the one asked, and a pty host's pane has no tmux pane id.
    const pty = setup()
    await pty.t.follow(agent(), observed({ runtimes: [TMUX, PTY], primaryRuntimeKey: terminalRouteKey(PTY) }), pass())
    expect(pty.deps.paneInfo).toHaveBeenCalledExactlyOnceWith(PTY)
    expect(pty.deps.names).toHaveBeenCalledExactlyOnceWith({ tty: '/dev/pts/3', tmuxPane: null })
    expect(pty.deps.read).toHaveBeenCalledWith(HOME, ['tty-dev-pts-3'], expect.any(Number))

    // A runtime no longer primary falls back to the first.
    const first = setup()
    await first.t.follow(agent(), observed({ runtimes: [PTY, TMUX], primaryRuntimeKey: 'gone' }), pass())
    expect(first.deps.paneInfo).toHaveBeenCalledExactlyOnceWith(PTY)

    // A tty the backend does not name is asked for again on the next pass.
    const unnamed = setup()
    unnamed.deps.paneInfo.mockResolvedValueOnce(null).mockResolvedValueOnce({ command: 'hermes', path: '/work', pid: 42, tty: '' })
    expect(await unnamed.t.follow(agent(), observed({ runtimes: [PTY], primaryRuntimeKey: terminalRouteKey(PTY) }), pass())).toBe('none')
    expect(await unnamed.t.follow(agent(), observed({ runtimes: [PTY], primaryRuntimeKey: terminalRouteKey(PTY) }), pass())).toBe('none')
    expect(unnamed.deps.stamp).not.toHaveBeenCalled()
    expect(await unnamed.t.follow(agent(), observed({ runtimes: [PTY], primaryRuntimeKey: terminalRouteKey(PTY) }), pass())).toEqual({ sessionId: S })
    expect(unnamed.deps.paneInfo).toHaveBeenCalledTimes(3)
  })

  it('binds an unbound agent to the session its record names', async () => {
    const { deps, t } = setup()
    expect(await t.follow(agent({ sessionId: '' }), observed(), pass())).toEqual({ sessionId: S })
    expect(deps.read).toHaveBeenCalledWith(HOME, ['tty-dev-pts-3', 'tmux_pane--5'], Date.parse(STARTED) - 5_000)
    expect(deps.kind).toHaveBeenCalledExactlyOnceWith(HOME, S)
    expect(deps.recordSeen).toHaveBeenCalledExactlyOnceWith(HOME)
    expect(log).not.toHaveBeenCalled()
  })

  it('carries a home that is not the default and not yet on the row', async () => {
    const { deps, t } = setup()
    expect(await t.follow(agent(), observed({ hermesHome: '/sandbox/agent/.hermes' }), pass()))
      .toEqual({ sessionId: S, hermesHome: '/sandbox/agent/.hermes' })
    expect(deps.read).toHaveBeenCalledWith('/sandbox/agent/.hermes', expect.any(Array), expect.any(Number))
    expect(deps.recordSeen).toHaveBeenCalledExactlyOnceWith('/sandbox/agent/.hermes')

    const kept = setup()
    expect(await kept.t.follow(agent({ hermesHome: '/sandbox/agent/.hermes' }), observed({ hermesHome: '/other/.hermes' }), pass()))
      .toEqual({ sessionId: S })
    expect(kept.deps.kind).toHaveBeenCalledWith('/sandbox/agent/.hermes', S)
  })

  it('switches a bound agent', async () => {
    const { t } = setup()
    expect(await t.follow(agent({ sessionId: OLD, lastHookAt: 1 }), observed(), pass())).toEqual({ sessionId: S })
  })

  it('makes its lstats and nothing else once settled', async () => {
    const { deps, t } = setup()
    expect(await t.follow(agent(), observed(), pass())).toEqual({ sessionId: S })
    expect(await t.follow(agent({ sessionId: S, lastHookAt: 1 }), observed(), pass())).toBe('wait')
    const settled = pass()
    expect(await t.follow(agent({ sessionId: S, lastHookAt: 1 }), observed(), settled)).toBe('wait')
    expect(deps.read).toHaveBeenCalledTimes(1)
    expect(deps.kind).toHaveBeenCalledTimes(1)
    expect(deps.paneInfo).toHaveBeenCalledTimes(1)
    expect(deps.stamp).toHaveBeenCalledTimes(4)
    expect(settled.current).not.toHaveBeenCalled()
    expect(settled.mayClaim).not.toHaveBeenCalled()
  })

  it('confirms a resumed row once', async () => {
    const { deps, t } = setup()
    expect(await t.follow(agent({ sessionId: S, resumeOnly: true, lastHookAt: 0 }), observed(), pass())).toEqual({ sessionId: S })
    expect(deps.kind).not.toHaveBeenCalled()
    expect(await t.follow(agent({ sessionId: S, resumeOnly: true, lastHookAt: 5 }), observed(), pass())).toBe('wait')
    expect(deps.kind).not.toHaveBeenCalled()
  })

  it('never falls back while a record of this process waits for its row', async () => {
    const { deps, t } = setup()
    deps.kind.mockResolvedValue('waiting')
    expect(await t.follow(agent(), observed(), pass())).toBe('wait')
    expect(await t.follow(agent(), observed(), pass())).toBe('wait')
    expect(deps.kind).toHaveBeenCalledTimes(2)
    expect(log.mock.calls).toEqual([['[discovery] a1 hermes terminal record ignored · its session is not in its store']])
  })

  it('asks the store on 24 passes, then once a minute', async () => {
    const { deps, t } = setup()
    deps.kind.mockResolvedValue('waiting')
    for (let passes = 0; passes < 24; passes++, clock += 5_000) await t.follow(agent(), observed(), pass())
    expect(deps.kind).toHaveBeenCalledTimes(24)
    const lastAsk = clock - 5_000
    expect(await t.follow(agent(), observed(), pass())).toBe('wait')
    expect(deps.kind).toHaveBeenCalledTimes(24)
    clock = lastAsk + 60_001
    await t.follow(agent(), observed(), pass())
    expect(deps.kind).toHaveBeenCalledTimes(25)
    clock += 5_000
    await t.follow(agent(), observed(), pass())
    expect(deps.kind).toHaveBeenCalledTimes(25)

    // A record replaced by another is asked about afresh.
    deps.stamp.mockResolvedValue('8:60:2000')
    await t.follow(agent(), observed(), pass())
    expect(deps.kind).toHaveBeenCalledTimes(26)
  })

  it('says once why a record is ignored, and lets the fallback run', async () => {
    const { deps, t } = setup()
    deps.read.mockResolvedValue({ state: 'ignored', reason: 'stale' })
    deps.stamp.mockResolvedValueOnce('a').mockResolvedValueOnce('b').mockResolvedValueOnce('b').mockResolvedValueOnce('c')
    expect(await t.follow(agent(), observed(), pass())).toBe('none')
    expect(await t.follow(agent(), observed(), pass())).toBe('none')
    expect(await t.follow(agent(), observed(), pass())).toBe('none')
    expect(deps.read).toHaveBeenCalledTimes(2)
    deps.read.mockResolvedValue({ state: 'ignored', reason: 'malformed' })
    expect(await t.follow(agent(), observed(), pass())).toBe('none')
    expect(log.mock.calls).toEqual([
      ['[discovery] a1 hermes terminal record ignored · older than its process'],
      ['[discovery] a1 hermes terminal record ignored · malformed'],
    ])
    expect(deps.recordSeen).not.toHaveBeenCalled()
    expect(deps.kind).not.toHaveBeenCalled()
  })

  it('has nothing to say of a terminal with no record, or of a process whose start cannot be read', async () => {
    const { deps, t } = setup()
    deps.read.mockResolvedValue({ state: 'none' })
    expect(await t.follow(agent(), observed(), pass())).toBe('none')
    expect(await t.follow(agent(), observed(), pass())).toBe('none')
    expect(deps.read).toHaveBeenCalledTimes(1)

    const unknown = setup()
    expect(await unknown.t.follow(agent(), observed({ processIdentity: { pid: 42, executable: 'hermes', startMarker: 'unknown' } }), pass())).toBe('none')
    expect(unknown.deps.read).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it('binds nothing a sub-agent or an editor made', async () => {
    const { deps, t } = setup()
    deps.kind.mockResolvedValue('other')
    expect(await t.follow(agent({ sessionId: OLD, lastHookAt: 1 }), observed(), pass())).toBe('wait')
    expect(await t.follow(agent({ sessionId: OLD, lastHookAt: 1 }), observed(), pass())).toBe('wait')
    expect(deps.kind).toHaveBeenCalledTimes(1)
    expect(deps.read).toHaveBeenCalledTimes(1)
    expect(log.mock.calls).toEqual([["[discovery] a1 hermes terminal record ignored · its session is not a pane's own"]])
  })

  it('holds an unbound agent whose store cannot be read, and leaves a bound one as it is', async () => {
    const { deps, t } = setup()
    const unreadable = new Error('the store is busy')
    deps.kind.mockRejectedValue(unreadable)
    const unbound = pass()
    expect(await t.follow(agent({ sessionId: '' }), observed(), unbound)).toBe('wait')
    expect(unbound.hold).toHaveBeenCalledExactlyOnceWith(unreadable)
    const bound = pass()
    expect(await t.follow(agent({ agentId: 'a2', sessionId: OLD, lastHookAt: 1 }), observed(), bound)).toBe('wait')
    expect(bound.hold).not.toHaveBeenCalled()
  })

  it('waits when the record changed while the store was read', async () => {
    const { deps, t } = setup()
    deps.stamp.mockResolvedValueOnce('a').mockResolvedValueOnce('b').mockResolvedValue('b')
    expect(await t.follow(agent(), observed(), pass())).toBe('wait')
    expect(deps.read).toHaveBeenCalledTimes(1)
    expect(await t.follow(agent(), observed(), pass())).toEqual({ sessionId: S })
    expect(deps.read).toHaveBeenCalledTimes(2)
  })

  it('waits when a later agent holds the session, without asking the store', async () => {
    const { deps, t } = setup()
    expect(await t.follow(agent(), observed(), pass({ mayClaim: vi.fn(() => false) }))).toBe('wait')
    expect(deps.kind).not.toHaveBeenCalled()
    // Or takes it while the store is read.
    expect(await t.follow(agent(), observed(), pass({ mayClaim: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false) }))).toBe('wait')
    expect(deps.kind).toHaveBeenCalledTimes(1)
  })

  it('waits when the pane changed hands while the store was read', async () => {
    const { deps, t } = setup()
    deps.kind.mockResolvedValue('other')
    expect(await t.follow(agent(), observed(), pass({ current: vi.fn(() => false) }))).toBe('wait')
    deps.kind.mockResolvedValue('own')
    expect(await t.follow(agent(), observed(), pass({ current: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false) }))).toBe('wait')
    // Neither settled what the record says.
    expect(await t.follow(agent(), observed(), pass())).toEqual({ sessionId: S })
    expect(deps.kind).toHaveBeenCalledTimes(3)
    expect(log).not.toHaveBeenCalled()
  })

  it('says once that a sandboxed agent is followed from its record', async () => {
    const { t } = setup()
    await t.follow(agent(), observed({ sandboxed: true }), pass())
    await t.follow(agent(), observed({ sandboxed: true }), pass())
    await t.follow(agent({ agentId: 'a2' }), observed(), pass())
    expect(log.mock.calls).toEqual([[`[discovery] a1 ${HERMES_TERMINAL_SAID.sandbox}`]])
  })

  it('starts again for a new process and keeps what it said', async () => {
    const { deps, t } = setup()
    deps.read.mockResolvedValue({ state: 'ignored', reason: 'malformed' })
    expect(await t.follow(agent(), observed(), pass())).toBe('none')
    const later = observed({ processIdentity: { pid: 43, executable: '/usr/local/bin/hermes', startMarker: '2026-11-12T11:00:00Z' } })
    expect(await t.follow(agent(), later, pass())).toBe('none')
    expect(deps.paneInfo).toHaveBeenCalledTimes(2)
    expect(deps.read).toHaveBeenCalledTimes(2)
    expect(deps.read).toHaveBeenLastCalledWith(HOME, expect.any(Array), Date.parse('2026-11-12T11:00:00Z') - 5_000)
    expect(lines('ignored · malformed')).toHaveLength(1)

    deps.read.mockResolvedValue(RECORD)
    const again = observed({ processIdentity: { pid: 44, executable: '/usr/local/bin/hermes', startMarker: '2026-11-12T12:00:00Z' } })
    await t.follow(agent(), again, pass())
    await t.follow(agent(), again, pass())
    expect(deps.recordSeen).toHaveBeenCalledTimes(1)
    await t.follow(agent(), observed(), pass())
    expect(deps.recordSeen).toHaveBeenCalledTimes(2)
  })

  it('keeps at most 256 agents, dropping those the registry no longer has', async () => {
    const { deps, t } = setup()
    deps.registry.byAgent.mockImplementation((agentId: string) => agentId === 'a0' ? undefined : agent({ agentId }))
    for (let i = 0; i < 256; i++) await t.follow(agent({ agentId: `a${i}` }), observed(), pass())
    expect(deps.read).toHaveBeenCalledTimes(256)
    // a0 is gone from the registry, so it makes room; a1 is still known.
    await t.follow(agent({ agentId: 'a256' }), observed(), pass())
    await t.follow(agent({ agentId: 'a1' }), observed(), pass())
    expect(deps.read).toHaveBeenCalledTimes(257)
    // a0 comes back to 256 agents the registry all has: every one is dropped.
    await t.follow(agent({ agentId: 'a0' }), observed(), pass())
    expect(deps.read).toHaveBeenCalledTimes(258)
    await t.follow(agent({ agentId: 'a1' }), observed(), pass())
    expect(deps.read).toHaveBeenCalledTimes(259)
  })

  it('says the fallback once, and never on Windows', () => {
    const { t } = setup()
    t.fellBack('a1')
    t.fellBack('a1')
    expect(lines('keeps no terminal record')).toEqual([`[discovery] a1 ${HERMES_TERMINAL_SAID.fallback}`])
    const windows = setup('win32')
    windows.t.fellBack('a1')
    expect(lines('keeps no terminal record')).toHaveLength(1)
  })
})
