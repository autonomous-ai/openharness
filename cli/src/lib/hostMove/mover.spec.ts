import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../registry.js'
import { resumesConversation } from '../resumeCapability.js'
import type { ActivityState } from '../turnActivity.js'
import type { TerminalRuntimeRef } from '../terminalTypes.js'
import { HostMover, type HostMoverDeps } from './mover.js'
import type { MoveOutcome } from './moveAgent.js'
import { QUIET_MS, QuietClock } from './quiet.js'

const OLD_HOST = 'p2'
const TARGET = 'p2-1.2.3'

function row(agentId: string, fields: Partial<RegisteredSession> & { instance?: string } = {}): RegisteredSession {
  const { instance = OLD_HOST, ...rest } = fields
  const runtime: TerminalRuntimeRef = { backend: 'ptyhost', instance, paneId: `%${agentId}` }
  return {
    agentId, sessionId: `s-${agentId}`, engine: 'claude', cwd: '/w', runtimes: [runtime], tmuxPane: runtime.paneId,
    processIdentity: { pid: 42, executable: 'claude', startMarker: 'x' }, launch: { state: 'ready' },
    ...rest,
  } as unknown as RegisteredSession
}

/** A mover over [rows] on a fake clock, every agent idle, unwatched and free unless a test says otherwise. Agents
 *  have been quiet for QUIET_MS once `settle()` has run one tick and advanced the clock. */
function harness(rows: RegisteredSession[], overrides: Partial<HostMoverDeps> = {}) {
  let clock = 1_000_000
  const now = () => clock
  const quiet = new QuietClock({ now })
  const activity = new Map<string, ActivityState>()
  const lookedAt = new Set<string>()
  const busy = new Set<string>()
  const drainHosts = new Set([OLD_HOST, 'p2-9.9.9'])
  let canSeed = true
  const moves: string[] = []
  let outcome: (agentId: string) => Promise<MoveOutcome> = async () => ({ moved: true, resumed: true })
  const log = vi.fn<(message: string) => void>()
  const deps: HostMoverDeps = {
    list: () => rows,
    isDrainRow: (r) => r.runtimes.some((runtime) => runtime.backend === 'ptyhost' && drainHosts.has(runtime.instance)),
    targetCanSeed: () => canSeed,
    target: TARGET,
    resumesConversation,
    activity: (r) => activity.get(r.agentId) ?? 'idle',
    quiet,
    lookedAt: (agentId) => lookedAt.has(agentId),
    busy: (agentId) => busy.has(agentId),
    // A moved agent's row names its pane on the target from then on, as the swap leaves it.
    move: async (r) => {
      moves.push(r.agentId)
      const result = await outcome(r.agentId)
      if (result.moved) r.runtimes = [{ backend: 'ptyhost', instance: TARGET, paneId: `%new-${r.agentId}` }]
      return result
    },
    log,
    ...overrides,
  }
  const mover = new HostMover(deps)
  return {
    mover, quiet, activity, lookedAt, busy, moves, log,
    lines: () => log.mock.calls.map(([line]) => line),
    advance: (ms: number) => { clock += ms },
    setCanSeed: (value: boolean) => { canSeed = value },
    setOutcome: (fn: (agentId: string) => Promise<MoveOutcome>) => { outcome = fn },
    /** One tick to start every clock, then enough time for each agent to count as quiet. */
    settle: async () => { await mover.step(); clock += QUIET_MS },
  }
}

describe('HostMover', () => {
  it('moves an idle, quiet, unwatched conversation agent on an old host', async () => {
    const h = harness([row('a1')])
    await h.settle()
    await h.mover.step()
    expect(h.moves).toEqual(['a1'])
    expect(h.lines()).toContain('[terminal] move a1: moved (resumed)')
  })

  it('a working agent is not moved', async () => {
    const h = harness([row('a1')])
    h.activity.set('a1', 'working')
    await h.settle()
    await h.mover.step()
    expect(h.moves).toEqual([])
    expect(h.lines()).toContain('[terminal] move a1: skipped (working)')
  })

  it('unknown activity is not moved', async () => {
    const h = harness([row('a1')])
    h.activity.set('a1', 'unknown')
    await h.settle()
    await h.mover.step()
    expect(h.moves).toEqual([])
    expect(h.lines()).toContain('[terminal] move a1: skipped (activity unknown)')
  })

  it('input within QUIET_MS blocks', async () => {
    const h = harness([row('a1')])
    await h.mover.step()
    h.advance(QUIET_MS - 60_000)
    h.quiet.noteInput('a1')
    h.advance(60_000)
    await h.mover.step()
    expect(h.moves).toEqual([])
    expect(h.lines()).toContain('[terminal] move a1: skipped (not quiet yet)')
    // Quiet for the whole period since that input: now it moves.
    h.advance(QUIET_MS)
    await h.mover.step()
    expect(h.moves).toEqual(['a1'])
  })

  it('a looked-at agent is not moved', async () => {
    const h = harness([row('a1')])
    h.lookedAt.add('a1')
    await h.settle()
    await h.mover.step()
    expect(h.moves).toEqual([])
    expect(h.lines()).toContain('[terminal] move a1: skipped (looked at)')
  })

  it('a terminal is never moved', async () => {
    const h = harness([row('t1', { engine: 'terminal' as RegisteredSession['engine'], sessionId: undefined })])
    await h.settle()
    await h.mover.step()
    expect(h.moves).toEqual([])
    expect(h.lines()).toContain('[terminal] move t1: skipped (a terminal)')
  })

  it('a fresh engine is never moved', async () => {
    // An engine with no resume argv (resumeCapability.ts `fresh`): moved, it would come back in a new conversation.
    const fresh = vi.fn((engine: string, sessionId: string | null | undefined) => engine !== 'devin' && !!sessionId)
    const h = harness([row('d1', { engine: 'devin' as RegisteredSession['engine'] })], { resumesConversation: fresh })
    await h.settle()
    await h.mover.step()
    expect(h.moves).toEqual([])
    expect(h.lines()).toContain('[terminal] move d1: skipped (its engine cannot resume)')
  })

  it('no session id is never moved', async () => {
    const h = harness([row('a1', { sessionId: null as unknown as string })])
    await h.settle()
    await h.mover.step()
    expect(h.moves).toEqual([])
    expect(h.lines()).toContain('[terminal] move a1: skipped (no session id)')
  })

  it('a busy agent is not moved', async () => {
    const h = harness([row('a1')])
    h.busy.add('a1')
    await h.settle()
    await h.mover.step()
    expect(h.moves).toEqual([])
    expect(h.lines()).toContain('[terminal] move a1: skipped (busy)')
    h.busy.delete('a1')
    await h.mover.step()
    expect(h.moves).toEqual(['a1'])
  })

  it('one at a time', async () => {
    const h = harness([row('a1'), row('a2')])
    let finish!: (outcome: MoveOutcome) => void
    h.setOutcome(() => new Promise<MoveOutcome>((resolve) => { finish = resolve }))
    await h.settle()
    const first = h.mover.step()
    await h.mover.step()
    await h.mover.step()
    expect(h.moves).toHaveLength(1)
    finish({ moved: true, resumed: true })
    await first
    h.setOutcome(async () => ({ moved: true, resumed: true }))
    await h.mover.step()
    expect(h.moves).toHaveLength(2)
    expect(new Set(h.moves)).toEqual(new Set(['a1', 'a2']))
  })

  it('moves the agent quiet the longest first', async () => {
    const h = harness([row('a1'), row('a2')])
    await h.mover.step()
    h.advance(QUIET_MS)
    h.quiet.noteInput('a1')
    h.advance(QUIET_MS)
    await h.mover.step()
    expect(h.moves).toEqual(['a2'])
  })

  it('a failed agent is not retried until restart', async () => {
    const h = harness([row('a1')])
    h.setOutcome(async () => ({ moved: false, reason: 'the new engine was not proven', fellBack: true }))
    await h.settle()
    await h.mover.step()
    await h.mover.step()
    await h.mover.step()
    expect(h.moves).toEqual(['a1'])
    expect(h.lines()).toContain('[terminal] move a1: failed (the new engine was not proven)')
    expect(h.lines()).toContain('[terminal] move a1: skipped (a move failed this start)')
    // A move that throws counts as failed too.
    const t = harness([row('a2')])
    t.setOutcome(async () => { throw new Error('boom') })
    await t.settle()
    await t.mover.step()
    await t.mover.step()
    expect(t.moves).toEqual(['a2'])
    expect(t.lines()).toContain('[terminal] move a2: failed (boom)')
  })

  it('a cancelled move is not a failure: the agent may move later', async () => {
    const h = harness([row('a1')])
    h.setOutcome(async () => ({ moved: false, reason: 'the move was cancelled', fellBack: false, cancelled: true }))
    await h.settle()
    await h.mover.step()
    h.setOutcome(async () => ({ moved: true, resumed: true }))
    await h.mover.step()
    expect(h.moves).toEqual(['a1', 'a1'])
    expect(h.lines()).toContain('[terminal] move a1: skipped (the move was cancelled)')
  })

  it('an agent on the target host is never a candidate', async () => {
    const h = harness([row('a1', { instance: TARGET })])
    await h.settle()
    await h.mover.step()
    expect(h.moves).toEqual([])
    // Not a drain host's agent: nothing to say about it.
    expect(h.lines().filter((line) => line.includes('a1'))).toEqual([])
  })

  it('nothing moves while the target cannot seed', async () => {
    const h = harness([row('a1')])
    h.setCanSeed(false)
    await h.settle()
    await h.mover.step()
    await h.mover.step()
    expect(h.moves).toEqual([])
    expect(h.lines()).toEqual([`[terminal] ptyhost: target ${TARGET} cannot seed; agents stay on their hosts`])
  })

  it('a turn that starts and ends between two ticks restarts the quiet period', async () => {
    const h = harness([row('a1')])
    await h.settle()
    // The funnel's live events (core/turns/funnel.ts `working`): a /loop wake-up, over before the next tick reads idle.
    h.quiet.noteActivity('a1', 'working')
    await h.mover.step()
    expect(h.moves).toEqual([])
    expect(h.lines()).toContain('[terminal] move a1: skipped (not quiet yet)')
    h.advance(QUIET_MS)
    await h.mover.step()
    expect(h.moves).toEqual(['a1'])
  })

  it('says when a target that could not seed can, once', async () => {
    const h = harness([row('a1')])
    h.setCanSeed(false)
    await h.mover.step()
    h.setCanSeed(true)
    await h.settle()
    await h.mover.step()
    expect(h.lines().filter((line) => line.startsWith('[terminal] ptyhost:'))).toEqual([
      `[terminal] ptyhost: target ${TARGET} cannot seed; agents stay on their hosts`,
      `[terminal] ptyhost: target ${TARGET} can seed now; idle agents move to it`,
    ])
    expect(h.moves).toEqual(['a1'])
  })

  it('an agent on a newer host moves after a rollback', async () => {
    // The target went back to 1.2.3; a host of 9.9.9 is drained like any other.
    const h = harness([row('a1', { instance: 'p2-9.9.9' })])
    await h.settle()
    await h.mover.step()
    expect(h.moves).toEqual(['a1'])
  })

  it('logs a skip once per reason change, not every tick', async () => {
    const h = harness([row('a1')])
    h.activity.set('a1', 'working')
    await h.mover.step()
    await h.mover.step()
    await h.mover.step()
    h.activity.set('a1', 'idle')
    await h.mover.step()
    await h.mover.step()
    expect(h.lines()).toEqual(['[terminal] move a1: skipped (working)', '[terminal] move a1: skipped (not quiet yet)'])
  })

  it('never moves a held, starting or guest agent, nor one with no engine process', async () => {
    const h = harness([
      row('h1', { launch: { state: 'held', service: 'models', detail: 'x' } }),
      row('s1', { launch: { state: 'starting' } }),
      row('g1', { guest: 'u1' }),
      row('p1', { processIdentity: null }),
    ])
    await h.settle()
    await h.mover.step()
    expect(h.moves).toEqual([])
    expect(h.lines()).toEqual(expect.arrayContaining([
      '[terminal] move h1: skipped (not launched)',
      '[terminal] move s1: skipped (not launched)',
      "[terminal] move g1: skipped (a guest's harness)",
      '[terminal] move p1: skipped (no engine process)',
    ]))
  })
})
