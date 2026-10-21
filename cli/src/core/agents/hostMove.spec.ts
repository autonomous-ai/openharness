import { describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/gatewayRuntime.js', async (real) => ({ ...await real<object>(), probeGatewayRuntime: vi.fn(async () => ({ kind: 'ori' })) }))
import type { RegisteredSession } from '../../lib/registry.js'
import type { RestartAgentDeps } from '../../lib/restartAgent.js'
import type { RestoreLaunch } from '../../lib/restoreAgents.js'
import type { TerminalBackend } from '../../lib/terminalBackend.js'
import type { ProcessIdentity, TerminalRuntimeRef } from '../../lib/terminalTypes.js'
import { terminalRouteKey } from '../../lib/terminalRuntime.js'
import { MoveGate } from '../../lib/hostMove/gate.js'
import { MOVE_MARKER_ENV } from '../../lib/hostMove/moveAgent.js'
import { SEED_HISTORY_LINES } from '../../lib/hostMove/seed.js'
import { createHostMove, hostMoveDeps, moveWaitingArgv, type HostMoveWiring } from './hostMove.js'

const OLD: TerminalRuntimeRef = { backend: 'ptyhost', instance: 'p2', paneId: '%1' }
const NEW: TerminalRuntimeRef = { backend: 'ptyhost', instance: 'p2-1.2.3', paneId: '%7' }
const OLD_ID: ProcessIdentity = { pid: 42, executable: 'claude', startMarker: 'old' }
const NEW_ID: ProcessIdentity = { pid: 43, executable: 'claude', startMarker: 'new' }

function session(): RegisteredSession {
  return {
    agentId: 'a1', sessionId: 's1', engine: 'claude', cwd: '/w', runtimes: [OLD], tmuxPane: '%1', registeredAt: 1,
    processIdentity: { ...OLD_ID }, permissionMode: null,
  } as unknown as RegisteredSession
}

const OVERRIDES = { env: { GRID: '1' }, extraArgs: ['--grid'], clearEnv: [] }
function deferredLaunch(prepare = vi.fn()): RestoreLaunch {
  return {
    argv: ['claude', '--resume', 's1'],
    paneLaunch: { afterExit: ['pwsh'], clearInherited: ['ANTHROPIC_API_KEY'] } as unknown as RestoreLaunch['paneLaunch'],
    deferred: { prepare, overrides: OVERRIDES, permission: { permissionMode: 'plan', bypassPermission: false } },
  }
}

function backend(): TerminalBackend & Record<string, ReturnType<typeof vi.fn>> {
  return {
    name: 'ptyhost',
    holdOpen: vi.fn(async () => ({ state: 'succeeded', dispatch: 'executed' })),
    respawn: vi.fn(async () => ({ state: 'succeeded', dispatch: 'executed' })),
    releaseHold: vi.fn(async () => {}),
    kill: vi.fn(async () => ({ state: 'succeeded', dispatch: 'executed' })),
    create: vi.fn(async () => ({ state: 'succeeded', dispatch: 'executed', runtime: NEW })),
  } as unknown as TerminalBackend & Record<string, ReturnType<typeof vi.fn>>
}

function wiring(overrides: Partial<HostMoveWiring> = {}) {
  const row = session()
  const old = backend()
  const target = backend()
  const swapDeps = {
    holdOpen: vi.fn(async () => ({ ok: true })),
    terminate: vi.fn(async () => 'terminated' as const),
    respawn: vi.fn(async () => ({ ok: true })),
    waitForProcess: vi.fn(async () => ({ ...OLD_ID, pid: 44 })),
    buildArgv: vi.fn(() => ['claude', '--resume', 's1']),
    prepareResume: vi.fn(),
    log: vi.fn(),
  } satisfies RestartAgentDeps
  const releases: Array<ReturnType<typeof vi.fn>> = []
  const w: HostMoveWiring = {
    registry: {
      byAgent: vi.fn(() => row),
      transaction: vi.fn(async (apply: () => unknown) => apply()) as unknown as HostMoveWiring['registry']['transaction'],
      updateRuntimes: vi.fn((_id: string, runtimes: readonly TerminalRuntimeRef[]) => { row.runtimes = [...runtimes]; return true }),
      updateProcessIdentity: vi.fn((_id: string, identity: ProcessIdentity) => { row.processIdentity = identity; return true }),
      setActive: vi.fn(() => true),
    },
    terminals: {
      backendFor: vi.fn((runtime: TerminalRuntimeRef) => terminalRouteKey(runtime) === terminalRouteKey(OLD) ? old : target),
      capture: vi.fn(async () => ({ state: 'succeeded' as const, value: 'history' })),
    },
    createBackend: () => target,
    restore: {
      respawn: vi.fn(async () => ({ ok: true })),
      probeProcess: vi.fn(async () => NEW_ID),
    },
    buildLaunch: vi.fn(async () => deferredLaunch()),
    paneSwapDeps: vi.fn(() => swapDeps) as unknown as HostMoveWiring['paneSwapDeps'],
    retarget: vi.fn(async () => {}),
    gate: new MoveGate(),
    eligible: vi.fn(() => true),
    holdRoute: vi.fn(() => { const release = vi.fn(); releases.push(release); return release }),
    announce: vi.fn(),
    refreshGridAssignment: vi.fn(),
    invalidateControl: vi.fn(),
    waitingArgv: () => ['wait'],
    log: vi.fn(),
    ...overrides,
  }
  return { w, row, old, target, swapDeps, releases }
}

describe('the move, wired to the core', () => {
  it('holds routes with the reconciler, with no auto-release, and hands back that hold\'s own release', () => {
    const { w, releases } = wiring()
    const deps = hostMoveDeps(session(), () => true, w)
    // The eligibility asked before the stop is the core's, of this agent.
    vi.mocked(w.eligible).mockReturnValueOnce(false)
    expect(deps.eligible()).toBe(false)
    expect(w.eligible).toHaveBeenCalledWith('a1')
    const release = deps.holdRoute(terminalRouteKey(OLD))
    expect(w.holdRoute).toHaveBeenCalledWith(terminalRouteKey(OLD), null)
    expect(release).toBe(releases[0])
  })

  it('captures the old pane with its history and colours, and opens the new pane waiting, marked and seeded', async () => {
    const { w, target } = wiring()
    const deps = hostMoveDeps(session(), () => true, w)
    expect(await deps.capture(session())).toBe('history')
    expect(w.terminals.capture).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a1' }), { historyLines: SEED_HISTORY_LINES, ansi: true })
    expect(await deps.createSeeded(session(), 'seed')).toEqual({ ok: true, runtime: NEW })
    expect(target.create).toHaveBeenCalledWith(expect.objectContaining({
      command: ['wait'], cwd: '/w', env: { [MOVE_MARKER_ENV]: 'a1' }, seed: 'seed', current: expect.any(Function),
    }))
  })

  it('starts the engine in the new pane with the whole launch, its Windows pane launch included', async () => {
    const { w } = wiring()
    let live = true
    const deps = hostMoveDeps(session(), () => live, w)
    const launch = deferredLaunch()
    await deps.respawn(NEW, launch)
    expect(w.restore.respawn).toHaveBeenCalledWith(NEW, launch, { current: expect.any(Function) })
    const control = vi.mocked(w.restore.respawn).mock.calls[0]![2]!
    expect(control.current!()).toBe(true)
    live = false
    expect(control.current!()).toBe(false)
  })

  it('switches the row in one transaction, and an announce that fails after it is logged, not thrown', () => {
    const { w, row } = wiring({ announce: vi.fn(() => { throw new Error('socket closed') }) })
    const deps = hostMoveDeps(session(), () => true, w)
    expect(() => deps.swap('a1', NEW, NEW_ID)).not.toThrow()
    expect(row.runtimes).toEqual([NEW])
    expect(row.processIdentity).toEqual(NEW_ID)
    expect(w.registry.updateRuntimes).toHaveBeenCalledWith('a1', [NEW], terminalRouteKey(NEW))
    expect(w.invalidateControl).toHaveBeenCalledWith('a1')
    expect(vi.mocked(w.log).mock.calls.flat().join('\n')).toContain('[terminal] move a1: ')
  })

  it('throws when the row was not switched', () => {
    const { w } = wiring()
    vi.mocked(w.registry.updateRuntimes).mockReturnValue(false)
    const deps = hostMoveDeps(session(), () => true, w)
    expect(() => deps.swap('a1', NEW, NEW_ID)).toThrow()
    expect(w.registry.updateProcessIdentity).not.toHaveBeenCalled()
    expect(w.announce).not.toHaveBeenCalled()
  })

  it('stops the process the row recorded when the move began, keeping its pane', async () => {
    const { w, row, swapDeps, old } = wiring()
    const deps = hostMoveDeps(row, () => true, w)
    // Discovery records another process for the row after the move began: the move still targets the one it saw.
    row.processIdentity = { ...OLD_ID, pid: 99 }
    expect(await deps.stopEngine(row)).toBe('terminated')
    const [target, place] = vi.mocked(w.paneSwapDeps).mock.calls[0]!
    expect(target.processIdentity).toEqual(OLD_ID)
    expect(place).toEqual({ backend: old, runtime: OLD })
    expect(swapDeps.holdOpen).toHaveBeenCalled()
    expect(swapDeps.holdOpen.mock.invocationCallOrder[0]).toBeLessThan(swapDeps.terminate.mock.invocationCallOrder[0]!)
  })

  it('a pane that cannot be kept open is not stopped', async () => {
    const { w, swapDeps } = wiring()
    swapDeps.holdOpen.mockResolvedValue({ ok: false, reason: 'gone' } as never)
    const deps = hostMoveDeps(session(), () => true, w)
    expect(await deps.stopEngine(session())).toBe('failed')
    expect(swapDeps.terminate).not.toHaveBeenCalled()
  })

  it('prepares the conversation with what the launch was built with, without asking for overrides again', async () => {
    const prepare = vi.fn()
    const { w } = wiring({ buildLaunch: vi.fn(async () => deferredLaunch(prepare)) })
    const deps = hostMoveDeps(session(), () => true, w)
    await expect(deps.prepareResume(session())).rejects.toThrow()
    await deps.buildLaunch(session(), { resumeSessionId: 's1', current: () => true, prepare: false })
    await deps.prepareResume(session())
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(w.buildLaunch).toHaveBeenCalledTimes(1)
  })

  it('relaunches in the old pane with the launch\'s own overrides, and the row keeps the old pane', async () => {
    const prepare = vi.fn()
    const { w, swapDeps, old, row } = wiring({ buildLaunch: vi.fn(async () => deferredLaunch(prepare)) })
    const deps = hostMoveDeps(row, () => true, w)
    // No launch yet: nothing to relaunch with.
    expect(await deps.relaunchOld(row)).toBe(false)
    await deps.buildLaunch(row, { resumeSessionId: 's1', current: () => true, prepare: false })
    await deps.prepareResume(row)
    expect(await deps.relaunchOld(row)).toBe(true)
    const [, place, overrides, permissionMode] = vi.mocked(w.paneSwapDeps).mock.calls.at(-1)!
    expect(place).toEqual({ backend: old, runtime: OLD })
    expect(overrides).toBe(OVERRIDES)
    expect(permissionMode).toBe('plan')
    expect(swapDeps.respawn).toHaveBeenCalled()
    // Prepared already, before the stop: not prepared twice.
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(swapDeps.prepareResume).not.toHaveBeenCalled()
    // Committed as a restart commits (`commitRelaunchedEngine`): gateway, active, the pane released, announced, and
    // its grid assignment refreshed.
    expect(w.registry.updateProcessIdentity).toHaveBeenCalledWith('a1', { ...OLD_ID, pid: 44 }, 'ori')
    expect(w.registry.setActive).toHaveBeenCalledWith('a1', true)
    expect(old.releaseHold).toHaveBeenCalledWith(OLD)
    expect(w.announce).toHaveBeenCalled()
    expect(w.refreshGridAssignment).toHaveBeenCalledWith(row)
  })

  it('a relaunch cancelled once the row has its engine still says the engine came back', async () => {
    const { w, old, row } = wiring()
    let live = true
    vi.mocked(old.releaseHold).mockImplementation(async () => { live = false })
    const deps = hostMoveDeps(row, () => live, w)
    await deps.buildLaunch(row, { resumeSessionId: 's1', current: () => true, prepare: false })
    expect(await deps.relaunchOld(row)).toBe(true)
    expect(w.registry.updateProcessIdentity).toHaveBeenCalled()
    expect(w.announce).not.toHaveBeenCalled()
  })

  it('a relaunch whose engine does not come back says so', async () => {
    const { w, swapDeps, row } = wiring()
    swapDeps.waitForProcess.mockResolvedValue(null as never)
    const deps = hostMoveDeps(row, () => true, w)
    await deps.buildLaunch(row, { resumeSessionId: 's1', current: () => true, prepare: false })
    expect(await deps.relaunchOld(row)).toBe(false)
    expect(w.registry.updateProcessIdentity).not.toHaveBeenCalled()
  })

  it('closes a pane on its own backend, and says whether it is gone', async () => {
    const { w, target } = wiring()
    const deps = hostMoveDeps(session(), () => true, w)
    expect(await deps.killPane(NEW)).toBe(true)
    vi.mocked(target.kill).mockResolvedValue({ state: 'failed', dispatch: 'rejected', reason: 'busy' })
    expect(await deps.killPane(NEW)).toBe(false)
    await deps.releaseHold(NEW)
    expect(target.releaseHold).toHaveBeenCalledWith(NEW)
  })

  it('the new pane waits printing nothing over its seed', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const argv = moveWaitingArgv(platform)
      expect(argv.join(' '), platform).not.toMatch(/printf|stdout|echo/)
    }
    expect(moveWaitingArgv('win32')[1]).toBe('-e')
  })
})

describe('the move, wired to the core: the paths that do not go through', () => {
  it('reads no history from a pane that cannot be captured, and probes the new pane\'s engine', async () => {
    const { w } = wiring()
    vi.mocked(w.terminals.capture).mockResolvedValue({ state: 'failed', dispatch: 'rejected', reason: 'gone' } as never)
    const deps = hostMoveDeps(session(), () => true, w)
    expect(await deps.capture(session())).toBeNull()
    expect(await deps.probeProcess(NEW, 'claude')).toEqual(NEW_ID)
    expect(w.restore.probeProcess).toHaveBeenCalledWith(NEW, 'claude')
    await deps.retarget('a1', NEW)
    expect(w.retarget).toHaveBeenCalledWith('a1', NEW)
    deps.log('a line')
    expect(w.log).toHaveBeenCalledWith('a line')
  })

  it('opens no pane without a target host, and says why a host refused one', async () => {
    const none = wiring({ createBackend: () => null })
    expect(await hostMoveDeps(session(), () => true, none.w).createSeeded(session(), 'seed')).toEqual({ ok: false, reason: 'no target host' })
    const { w, target } = wiring()
    vi.mocked(target.create).mockResolvedValue({ state: 'failed', dispatch: 'rejected', reason: 'full' } as never)
    expect(await hostMoveDeps(session(), () => true, w).createSeeded(session(), 'seed')).toEqual({ ok: false, reason: 'full' })
  })

  it('does not stop an engine whose pane has no backend, and names a hold failure that gave no reason', async () => {
    const lost = wiring()
    vi.mocked(lost.w.terminals.backendFor).mockReturnValue(undefined as never)
    expect(await hostMoveDeps(session(), () => true, lost.w).stopEngine(session())).toBe('failed')
    expect(lost.w.paneSwapDeps).not.toHaveBeenCalled()
    const { w, swapDeps } = wiring()
    swapDeps.holdOpen.mockResolvedValue({ ok: false } as never)
    expect(await hostMoveDeps(session(), () => true, w).stopEngine(session())).toBe('failed')
    expect(vi.mocked(w.log).mock.calls.flat().join('\n')).toContain('(unknown reason)')
  })

  it('a switch whose save fails is logged, and a row gone after it or no grid refresh is not an error', async () => {
    for (const thrown of [new Error('disk full'), 'plain']) {
      const { w } = wiring({ registry: { ...wiring().w.registry, transaction: vi.fn(async () => { throw thrown }) as never } })
      expect(() => hostMoveDeps(session(), () => true, w).swap('a1', NEW, NEW_ID)).toThrow('the row is gone')
      await new Promise((done) => setImmediate(done))
      expect(vi.mocked(w.log).mock.calls.flat().join('\n')).toContain(`saving the switch failed: ${thrown instanceof Error ? thrown.message : thrown}`)
    }
    const gone = wiring()
    vi.mocked(gone.w.registry.byAgent).mockReturnValue(undefined)
    hostMoveDeps(session(), () => true, gone.w).swap('a1', NEW, NEW_ID)
    expect(gone.w.announce).not.toHaveBeenCalled()
    const plain = wiring({ refreshGridAssignment: undefined })
    hostMoveDeps(session(), () => true, plain.w).swap('a1', NEW, NEW_ID)
    expect(plain.w.announce).toHaveBeenCalled()
  })

  it('releases no hold on a pane with no backend', async () => {
    const { w } = wiring()
    vi.mocked(w.terminals.backendFor).mockReturnValue(undefined as never)
    const deps = hostMoveDeps(session(), () => true, w)
    await expect(deps.releaseHold(NEW)).rejects.toThrow('no backend for the new pane')
    expect(await deps.killPane(NEW)).toBe(false)
  })

  it('relaunches a resume-only, bypassing agent that was never prepared, and says when the relaunch fails or the row is gone', async () => {
    const prepare = vi.fn()
    const launch = deferredLaunch(prepare)
    launch.deferred!.permission = { bypassPermission: true } as never
    const row = { ...session(), resumeOnly: true } as RegisteredSession
    const { w, swapDeps } = wiring({ buildLaunch: vi.fn(async () => launch) })
    const deps = hostMoveDeps(row, () => true, w)
    await deps.buildLaunch(row, { resumeSessionId: 's1', current: () => true, prepare: false })
    // The row is gone once the engine is back: not a failure of the relaunch.
    vi.mocked(w.registry.byAgent).mockReturnValue(undefined)
    expect(await deps.relaunchOld(row)).toBe(false)
    expect(vi.mocked(w.paneSwapDeps).mock.calls[0]![3]).toBeNull()
    expect(prepare).toHaveBeenCalledTimes(1)
    // A relaunch cancelled before the row learned the engine.
    expect(await hostMoveDeps(row, () => false, w).relaunchOld(row)).toBe(false)
    expect(swapDeps.waitForProcess).toHaveBeenCalled()
  })

  it('has nothing to relaunch without a conversation, or for a pane with no backend', async () => {
    const bare = { ...session(), sessionId: undefined } as unknown as RegisteredSession
    const { w } = wiring()
    const deps = hostMoveDeps(bare, () => true, w)
    await deps.buildLaunch(bare, { resumeSessionId: 's1', current: () => true, prepare: false })
    expect(await deps.relaunchOld(bare)).toBe(false)
    const refused = wiring({ buildLaunch: vi.fn(async () => ({ error: 'no' }) as never) })
    const d2 = hostMoveDeps(session(), () => true, refused.w)
    expect(await d2.buildLaunch(session(), { resumeSessionId: 's1', current: () => true, prepare: false })).toEqual({ error: 'no' })
    expect(await d2.relaunchOld(session())).toBe(false)
  })

  it('createHostMove runs a move of a snapshot of the row, and a row with no conversation is not moved', async () => {
    const { w } = wiring()
    const bare = { ...session(), sessionId: undefined } as unknown as RegisteredSession
    expect(await createHostMove(w)(bare, () => true)).toEqual({ moved: false, reason: 'no conversation to resume', fellBack: false })
  })
})
