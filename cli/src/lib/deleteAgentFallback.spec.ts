import { describe, expect, it, vi } from 'vitest'
import { terminateDeletedAgent, checkPidRuntime, type TerminateDeps } from './deleteAgentFallback.js'
import type { RegisteredSession } from './registry.js'
import type { RuntimeCheck } from './paneEngineProcess.js'
import type { ProcessRow } from './processTable.js'
import type { TreeProcess } from './processTree.js'

const processRows = vi.hoisted(() => vi.fn())
vi.mock('./processTable.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./processTable.js')>(),
  processRows,
}))

/**
 * The one place in the adapter that signals somebody else's process. Everything here is about NOT hitting
 * the wrong target and NOT going quiet when it fails: by the time this runs the UI already told the user
 * the agent is gone, so an unreported failure leaves a running engine nothing accounts for.
 */

const SESSION = {
  sessionId: 's1',
  engine: 'claude',
  tmuxPane: '%3',
  processIdentity: { pid: 4242, executable: 'claude', startMarker: 'Mon Aug  3 09:00:00 2026' },
} as unknown as RegisteredSession

const runtime = (alive: boolean): RuntimeCheck => alive
  ? { state: 'alive' }
  : { state: 'gone', reason: 'process exited' }

/** The engine's checks in turn, the last one from then on. */
const sequence = (...alive: boolean[]) => {
  let at = 0
  return async () => runtime(alive[Math.min(at++, alive.length - 1)]!)
}

const tree: TreeProcess[] = [
  { pid: 10, pgid: 4242, startMarker: 'm10' }, // in the engine's own group
  { pid: 20, pgid: 20, startMarker: 'm20' }, // left the session: leads its own group
  { pid: 21, pgid: 20, startMarker: 'm21' },
  { pid: 30, pgid: 77, startMarker: 'm30' }, // in a group led from outside the tree (the pane's shell)
]

/** Deps whose clock is instant, so the real (multi-second) waits do not slow the suite down. */
function deps(over: Partial<TerminateDeps> = {}): TerminateDeps & { kills: Array<[number, string]>; logs: string[] } {
  const kills: Array<[number, string]> = []
  const logs: string[] = []
  return {
    kills,
    logs,
    checkRuntime: async () => runtime(true),
    kill: (pid, signal) => { kills.push([pid, signal]) },
    sleep: async () => { /* instant */ },
    log: (m) => { logs.push(m) },
    ...over,
  }
}

describe('delete-agent process termination', () => {
  it.each(['initial wait', 'identity read', 'tree read', 'grace read', 'escalation read'] as const)('does not signal after ownership is revoked during %s', async phase => {
    let current = true, reads = 0
    const d = deps({ current: () => current,
      sleep: async () => { if (phase === 'initial wait') current = false },
      checkRuntime: async () => {
        reads++
        if ((phase === 'identity read' && reads === 1) || (phase === 'grace read' && reads === 2)
          || (phase === 'escalation read' && reads === 3)) current = false
        return runtime(true)
      },
      descendants: async () => { if (phase === 'tree read') current = false; return [] },
    })
    expect(await terminateDeletedAgent(SESSION, d, 0, 250)).toBe('not-ours')
    expect(d.kills).toEqual(['initial wait', 'identity read', 'tree read'].includes(phase) ? [] : [[4242, 'SIGTERM']])
  })

  it('does nothing when the engine already left', async () => {
    const d = deps({ checkRuntime: async () => runtime(false) })
    await expect(terminateDeletedAgent(SESSION, d)).resolves.toBe('gone')
    expect(d.kills).toEqual([])
  })

  it('SIGTERMs an engine that is still there, and stops once it goes', async () => {
    let alive = true
    const d = deps({ checkRuntime: async () => runtime(alive), kill: (pid, signal) => { alive = false; d.kills.push([pid, signal]) } })
    await expect(terminateDeletedAgent(SESSION, d)).resolves.toBe('terminated')
    expect(d.kills).toEqual([[4242, 'SIGTERM']])
  })

  it('escalates to SIGKILL for an engine that ignores SIGTERM', async () => {
    // Some CLIs trap SIGTERM for a "press again to quit" prompt. Delete has to mean deleted.
    let alive = true
    const d = deps({
      checkRuntime: async () => runtime(alive),
      kill: (pid, signal) => { if (signal === 'SIGKILL') alive = false; d.kills.push([pid, signal]) },
    })
    await expect(terminateDeletedAgent(SESSION, d)).resolves.toBe('killed')
    expect(d.kills).toEqual([[4242, 'SIGTERM'], [4242, 'SIGKILL']])
    expect(d.logs.join('\n')).toContain('SIGKILL')
  })

  it('never signals a pane that now holds a different process', async () => {
    // checkRuntime compares pid AND start time, so a recycled pid reads as gone — the pid-reuse guard.
    const d = deps({ checkRuntime: async () => runtime(false) })
    await terminateDeletedAgent({ ...SESSION, processIdentity: { pid: 4242, executable: 'x', startMarker: 'later' } } as RegisteredSession, d)
    expect(d.kills).toEqual([])
  })

  it('has nothing to signal when the session never had a pid on record', async () => {
    const d = deps()
    await expect(terminateDeletedAgent({ ...SESSION, processIdentity: null } as RegisteredSession, d))
      .resolves.toBe('not-ours')
    expect(d.kills).toEqual([])
  })

  it('reports a refused signal instead of swallowing it', async () => {
    // EPERM: a differently-owned engine (sudo, another account). The delete silently did not happen, and
    // the user was already told it did — so this must be loud, and must not throw.
    const d = deps({
      kill: () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }) },
    })
    await expect(terminateDeletedAgent(SESSION, d)).resolves.toBe('failed')
    expect(d.logs.join('\n')).toContain('operation not permitted')
  })

  it('treats a process that vanished mid-signal as gone, not as a failure', async () => {
    let alive = true
    const d = deps({
      checkRuntime: async () => runtime(alive),
      kill: () => { alive = false; throw Object.assign(new Error('no such process'), { code: 'ESRCH' }) },
    })
    await expect(terminateDeletedAgent(SESSION, d)).resolves.toBe('gone')
    expect(d.logs.join('\n')).not.toContain('could not') // ESRCH is not an error worth reporting
  })

  it('says failed — loudly — when even SIGKILL does not take', async () => {
    const d = deps() // alive forever
    await expect(terminateDeletedAgent(SESSION, d)).resolves.toBe('failed')
    expect(d.logs.join('\n')).toContain('STILL running')
  })

  it('signals immediately without a launcher wait', async () => {
    const waits: number[] = []
    const d = deps({ checkRuntime: async () => runtime(false), sleep: async (ms) => { waits.push(ms) } })
    await terminateDeletedAgent(SESSION, d)
    expect(waits[0]).toBe(0)
  })

  it('keeps the runtime suppressed when identity validation is unknown', async () => {
    const d = deps({ checkRuntime: async () => { throw new Error('tmux is unavailable') } })
    await expect(terminateDeletedAgent(SESSION, d)).resolves.toBe('failed')
    expect(d.logs.join('\n')).toContain('could not validate')
  })

  it('does not SIGKILL when identity validation becomes unknown after SIGTERM', async () => {
    let checks = 0
    const d = deps({
      checkRuntime: async () => {
        checks += 1
        return checks > 13
          ? { state: 'unknown', reason: 'process table timed out' }
          : runtime(true)
      },
    })
    await expect(terminateDeletedAgent(SESSION, d)).resolves.toBe('failed')
    expect(d.kills).toEqual([[4242, 'SIGTERM']])
    expect(d.logs.join('\n')).toContain('before SIGKILL')
  })

  it('does not SIGKILL a PID whose process identity changed after SIGTERM', async () => {
    let checks = 0
    const d = deps({
      checkRuntime: async () => {
        checks += 1
        return checks > 13
          ? { state: 'gone', reason: 'saved PID was reused' }
          : runtime(true)
      },
    })
    await expect(terminateDeletedAgent(SESSION, d)).resolves.toBe('terminated')
    expect(d.kills).toEqual([[4242, 'SIGTERM']])
  })
})

// A tool an engine spawned `detached` (OpenClaw on POSIX) is in neither the engine's group nor its session: only a
// signal of its own ends it (#4173).
describe('delete-agent termination of the engine\'s tree', () => {
  it('SIGTERMs the engine once, each group one of its tree leads, and the rest by pid', async () => {
    const d = deps({ checkRuntime: sequence(true, false), descendants: async () => tree, survivors: async () => [] })
    expect(await terminateDeletedAgent(SESSION, d)).toBe('terminated')
    expect(d.kills).toEqual([[4242, 'SIGTERM'], [-20, 'SIGTERM'], [10, 'SIGTERM'], [30, 'SIGTERM']])
  })

  it('SIGKILLs what is left of the tree after the grace, by pid', async () => {
    const left = [[tree[2]!], []]
    const d = deps({ checkRuntime: sequence(true, false), descendants: async () => tree, survivors: async () => left.shift() ?? [] })
    expect(await terminateDeletedAgent(SESSION, d)).toBe('terminated')
    expect(d.kills).toContainEqual([21, 'SIGKILL'])
    expect(d.kills.some(([pid, signal]) => pid < 0 && signal === 'SIGKILL')).toBe(false)
  })

  // The engine left early, and the rest of the grace is seconds: a process that leaves meanwhile can have its number
  // handed to another before the SIGKILL.
  it('reads its tree again before a SIGKILL that follows the rest of the grace', async () => {
    const left = [[tree[2]!], []]
    const d = deps({ checkRuntime: sequence(true, false), descendants: async () => tree, survivors: async () => left.shift() ?? [] })
    expect(await terminateDeletedAgent(SESSION, d)).toBe('terminated')
    expect(d.kills.filter(([, signal]) => signal === 'SIGKILL')).toEqual([])
  })

  it('fails the stop when one of the tree outlives its SIGKILL, and says which', async () => {
    const d = deps({ checkRuntime: sequence(true, false), descendants: async () => tree, survivors: async () => [tree[2]!] })
    expect(await terminateDeletedAgent(SESSION, d)).toBe('failed')
    expect(d.logs.join('\n')).toContain('pid 21 is STILL running after SIGKILL')
  })

  it('stops the engine alone, and says so, when its tree cannot be listed', async () => {
    const d = deps({ checkRuntime: sequence(true, false), descendants: async () => null })
    expect(await terminateDeletedAgent(SESSION, d)).toBe('terminated')
    expect(d.kills).toEqual([[4242, 'SIGTERM']])
    expect(d.logs.join('\n')).toContain("could not list claude's processes")
  })

  it('lists the tree once, before the first signal', async () => {
    const signalledBefore: number[] = []
    const descendants = vi.fn(async () => { signalledBefore.push(d.kills.length); return tree })
    const d = deps({ checkRuntime: sequence(true, false), descendants, survivors: async () => [] })
    await terminateDeletedAgent(SESSION, d)
    expect(descendants).toHaveBeenCalledOnce()
    expect(signalledBefore).toEqual([0])
  })
})

describe('delete-agent process termination timing', () => {
  it('polls during the kill grace rather than sleeping through it', async () => {
    // A polled grace lets a well-behaved engine's exit be noticed immediately; one long sleep would make
    // every SIGTERM cost the full grace before the outcome is known.
    let alive = true
    const sleeps: number[] = []
    let calls = 0
    const d = deps({
      checkRuntime: async () => { calls += 1; if (calls > 3) alive = false; return runtime(alive) },
      sleep: async (ms) => { sleeps.push(ms) },
    })
    await expect(terminateDeletedAgent(SESSION, d)).resolves.toBe('terminated')
    expect(sleeps.filter((ms) => ms < 1_000).length).toBeGreaterThan(0)
  })

  it('honours caller-supplied budgets', async () => {
    const sleeps: number[] = []
    const d = deps({ checkRuntime: async () => runtime(false), sleep: async (ms) => { sleeps.push(ms) } })
    await terminateDeletedAgent(SESSION, d, 10, 20)
    expect(sleeps[0]).toBe(10)
  })
})

describe('delete-agent process termination wiring', () => {
  it('uses the session it was handed, not a lookup', async () => {
    // The registry entry is already gone by the time this runs (forgetSession removed it), so the caller
    // must pass the captured session. Pinning it here keeps that ordering from being "fixed" later.
    const seen: RegisteredSession[] = []
    const d = deps({ checkRuntime: async (s) => { seen.push(s); return runtime(false) } })
    await terminateDeletedAgent(SESSION, d)
    expect(seen[0]).toBe(SESSION)
  })
})

/**
 * `checkPidRuntime` — the exact PID + start-marker + executable check extracted out of onDeleteAgent's
 * former inline lambda so restart can reuse it via `terminateDeletedAgent` too, without duplicating the
 * PID-reuse guard. Pure extraction: this must not change onDeleteAgent's own behavior.
 */
describe('checkPidRuntime', () => {
  const row = (over: Partial<ProcessRow> = {}): ProcessRow => ({
    pid: 4242, parentPid: 1, executable: 'claude', startMarker: 'Mon Aug  3 09:00:00 2026', args: 'claude', ...over,
  })

  it('is alive when pid, startMarker, and executable all match', async () => {
    processRows.mockResolvedValue([row()])
    await expect(checkPidRuntime(SESSION)).resolves.toEqual({ state: 'alive' })
  })

  it('is gone when the saved pid is no longer in the process table', async () => {
    processRows.mockResolvedValue([row({ pid: 1 })])
    await expect(checkPidRuntime(SESSION)).resolves.toMatchObject({ state: 'gone' })
  })

  it('is gone — not alive — when the pid was recycled by a different process', async () => {
    // Same pid, different start time: the PID-reuse guard.
    processRows.mockResolvedValue([row({ startMarker: 'Tue Aug  4 09:00:00 2026' })])
    await expect(checkPidRuntime(SESSION)).resolves.toMatchObject({ state: 'gone' })
  })

  it('is gone when the executable identity does not match, even with the same pid/startMarker', async () => {
    processRows.mockResolvedValue([row({ executable: 'not-claude' })])
    await expect(checkPidRuntime(SESSION)).resolves.toMatchObject({ state: 'gone' })
  })

  it('is unknown, not gone, when the process table itself could not be read', async () => {
    processRows.mockResolvedValue(null)
    await expect(checkPidRuntime(SESSION)).resolves.toMatchObject({ state: 'unknown' })
  })

  it('is gone when the session never had a saved process identity', async () => {
    processRows.mockResolvedValue([row()])
    await expect(checkPidRuntime({ ...SESSION, processIdentity: null })).resolves.toMatchObject({ state: 'gone' })
  })
})
