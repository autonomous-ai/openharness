import { describe, expect, it, vi } from 'vitest'
import { AgentRestartCoordinator, restartAgent, type RestartAgentDeps } from './restartAgent.js'
import type { ProcessIdentity } from './registry.js'

const IDENTITY: ProcessIdentity = { pid: 555, executable: 'claude', startMarker: 'Mon Aug  3 09:05:00 2026' }

interface Overrides {
  holdOpen?: RestartAgentDeps['holdOpen']
  terminate?: RestartAgentDeps['terminate']
  respawn?: RestartAgentDeps['respawn']
  waitForProcess?: RestartAgentDeps['waitForProcess']
  buildArgv?: RestartAgentDeps['buildArgv']
  prepareResume?: RestartAgentDeps['prepareResume']
}

/** Every primitive records its own call, even when overridden — so `calls` always reflects the real
 *  order regardless of which primitive a test customizes the return value of. */
function deps(over: Overrides = {}): RestartAgentDeps & { calls: string[] } {
  const calls: string[] = []
  const holdOpenImpl = over.holdOpen ?? (async () => ({ ok: true }))
  const terminateImpl = over.terminate ?? (async () => 'terminated' as const)
  const respawnImpl = over.respawn ?? (async () => ({ ok: true }))
  const waitForProcessImpl = over.waitForProcess ?? (async () => IDENTITY)
  const buildArgvImpl = over.buildArgv ?? (() => ['claude'])
  return {
    calls,
    ...(over.prepareResume ? { prepareResume: async () => { calls.push('prepareResume'); await over.prepareResume!() } } : {}),
    holdOpen: async () => { calls.push('holdOpen'); return holdOpenImpl() },
    terminate: async (checkAfterMs) => { calls.push('terminate'); return terminateImpl(checkAfterMs) },
    respawn: async (argv) => { calls.push('respawn'); return respawnImpl(argv) },
    waitForProcess: async () => { calls.push('waitForProcess'); return waitForProcessImpl() },
    buildArgv: (opts) => { calls.push('buildArgv'); return buildArgvImpl(opts) },
    log: () => {},
  }
}

describe('restartAgent', () => {
  it('prepares history after its writer stops and before the resume launch', async () => {
    const d = deps({ prepareResume: vi.fn() })
    await restartAgent({ engine: 'codex', sessionId: 's1' }, false, d)
    expect(d.calls).toEqual(['holdOpen', 'terminate', 'prepareResume', 'buildArgv', 'respawn', 'waitForProcess'])
  })

  it('never prepares history while the old writer may still be alive', async () => {
    const prepareResume = vi.fn()
    const d = deps({ terminate: async () => 'failed', prepareResume })
    await restartAgent({ engine: 'codex', sessionId: 's1' }, false, d)
    expect(prepareResume).not.toHaveBeenCalled()
  })

  it('does not fall back to a fresh conversation if preparing history fails', async () => {
    const d = deps({ prepareResume: () => { throw new Error('rollout changed') } })
    const outcome = await restartAgent({ engine: 'codex', sessionId: 's1' }, false, d)
    expect(outcome).toEqual({ ok: false, detail: 'could not prepare codex session for resume: rollout changed' })
    expect(d.calls).toEqual(['holdOpen', 'terminate', 'prepareResume'])
  })

  it('does not prepare a fresh launch or repeat preparation on the fresh fallback', async () => {
    const prepareResume = vi.fn()
    const d = deps({ prepareResume, waitForProcess: async () => null })
    await restartAgent({ engine: 'codex', sessionId: '' }, false, d)
    expect(prepareResume).not.toHaveBeenCalled()
    await restartAgent({ engine: 'codex', sessionId: 's1' }, false, d)
    expect(prepareResume).toHaveBeenCalledTimes(1)
  })

  it('holds the pane open, kills, respawns, and verifies — in that order', async () => {
    const d = deps()
    const outcome = await restartAgent({ engine: 'claude', sessionId: 's1' }, false, d)
    expect(outcome).toEqual({ ok: true, processIdentity: IDENTITY, resumed: true })
    expect(d.calls).toEqual(['holdOpen', 'terminate', 'buildArgv', 'respawn', 'waitForProcess'])
  })

  it('never respawns when holdOpen fails to re-arm the pane', async () => {
    const d = deps({ holdOpen: async () => ({ ok: false, reason: 'tmux unreachable' }) })
    const outcome = await restartAgent({ engine: 'claude', sessionId: 's1' }, false, d)
    expect(outcome).toEqual({ ok: false, detail: 'tmux unreachable' })
    expect(d.calls).toEqual(['holdOpen'])
  })

  it('never respawns over a kill that could not be confirmed (not-ours)', async () => {
    const d = deps({ terminate: async () => 'not-ours' })
    const outcome = await restartAgent({ engine: 'claude', sessionId: 's1' }, false, d)
    expect(outcome.ok).toBe(false)
    expect(d.calls).toEqual(['holdOpen', 'terminate'])
  })

  it('never respawns over a kill that failed', async () => {
    const d = deps({ terminate: async () => 'failed' })
    const outcome = await restartAgent({ engine: 'claude', sessionId: 's1' }, false, d)
    expect(outcome.ok).toBe(false)
    expect(d.calls).toEqual(['holdOpen', 'terminate'])
  })

  it('treats "gone" (the process had already exited) as a confirmed kill, safe to respawn over', async () => {
    const d = deps({ terminate: async () => 'gone' })
    const outcome = await restartAgent({ engine: 'claude', sessionId: 's1' }, false, d)
    expect(outcome.ok).toBe(true)
  })

  it('passes the resolved sessionId as resumeSessionId on the first attempt', async () => {
    const argvCalls: Array<{ bypassPermission: boolean; resumeSessionId?: string }> = []
    const d = deps({ buildArgv: (opts) => { argvCalls.push(opts); return ['claude'] } })
    await restartAgent({ engine: 'claude', sessionId: 'sess-42' }, true, d)
    expect(argvCalls).toEqual([{ bypassPermission: true, resumeSessionId: 'sess-42' }])
  })

  it('launches fresh (no resumeSessionId) when the session has none', async () => {
    const argvCalls: Array<{ bypassPermission: boolean; resumeSessionId?: string }> = []
    const d = deps({ buildArgv: (opts) => { argvCalls.push(opts); return ['claude'] } })
    const outcome = await restartAgent({ engine: 'claude', sessionId: '' }, false, d)
    expect(argvCalls).toEqual([{ bypassPermission: false }])
    expect(outcome).toMatchObject({ ok: true, resumed: false })
  })

  it('falls back to a fresh relaunch when the resumed relaunch never produces a recognizable process', async () => {
    let attempt = 0
    const argvCalls: Array<{ bypassPermission: boolean; resumeSessionId?: string }> = []
    const d = deps({
      buildArgv: (opts) => { argvCalls.push(opts); return ['claude'] },
      waitForProcess: async () => { attempt += 1; return attempt === 1 ? null : IDENTITY },
    })
    const outcome = await restartAgent({ engine: 'claude', sessionId: 'sess-42' }, false, d)
    expect(argvCalls).toEqual([
      { bypassPermission: false, resumeSessionId: 'sess-42' },
      { bypassPermission: false },
    ])
    expect(outcome).toEqual({ ok: true, processIdentity: IDENTITY, resumed: false })
    // respawn + waitForProcess ran twice (once per attempt); holdOpen/terminate ran once.
    expect(d.calls.filter((c) => c === 'respawn')).toHaveLength(2)
    expect(d.calls.filter((c) => c === 'holdOpen')).toHaveLength(1)
    expect(d.calls.filter((c) => c === 'terminate')).toHaveLength(1)
  })

  it('fails outright when even the fresh fallback relaunch never comes up', async () => {
    const d = deps({ waitForProcess: async () => null })
    const outcome = await restartAgent({ engine: 'codex', sessionId: 'sess-1' }, false, d)
    expect(outcome).toEqual({ ok: false, detail: 'codex did not come back up after restart' })
  })

  it('never retries a resume fallback for an engine with no session to resume in the first place', async () => {
    let respawnCalls = 0
    const d = deps({
      respawn: async () => { respawnCalls += 1; return { ok: true } },
      waitForProcess: async () => null,
    })
    await restartAgent({ engine: 'claude', sessionId: '' }, false, d)
    expect(respawnCalls).toBe(1) // no resume attempt to fall back FROM
  })

  it('does not poll for a process when respawn-pane itself fails', async () => {
    const d = deps({ respawn: async () => ({ ok: false, reason: 'tmux respawn-pane did not complete' }) })
    const outcome = await restartAgent({ engine: 'claude', sessionId: 's1' }, false, d)
    expect(outcome.ok).toBe(false)
    expect(d.calls).not.toContain('waitForProcess')
  })
})


describe('restart cancellation', () => {
  for (const phase of ['before', 'hold', 'terminate', 'prepare', 'respawn', 'wait'] as const) {
    it(`does not continue process replacement after cancellation at ${phase}`, async () => {
      let current = phase !== 'before'
      const stopAt = (at: string) => { if (phase === at) current = false }
      const d = deps({
        holdOpen: async () => { stopAt('hold'); return { ok: true } },
        terminate: async () => { stopAt('terminate'); return 'terminated' },
        prepareResume: async () => { stopAt('prepare') },
        respawn: async () => { stopAt('respawn'); return { ok: true } },
        waitForProcess: async () => { stopAt('wait'); return null },
      })
      const result = await restartAgent({ engine: 'codex', sessionId: 's1' }, false, { ...d, isCurrent: () => current })
      expect(result).toEqual({ ok: false, detail: 'the agent changed or stopped during restart' })
      expect(d.calls.filter((call) => call === 'respawn')).toHaveLength(['respawn', 'wait'].includes(phase) ? 1 : 0)
      if (phase === 'before') expect(d.calls).toEqual([])
      if (phase === 'hold') expect(d.calls).toEqual(['holdOpen'])
    })
  }

  it('joins overlapping restarts but leaves other agents independent', async () => {
    const coordinator = new AgentRestartCoordinator()
    let finish!: () => void
    const handler = vi.fn(async () => { await new Promise<void>((resolve) => { finish = resolve }); return { ok: false, error: 'fixture' } as const })
    const first = coordinator.run('a', handler)
    expect(coordinator.run('a', handler)).toBe(first)
    expect(await coordinator.run('b', async () => ({ ok: false, error: 'other' }))).toEqual({ ok: false, error: 'other' })
    finish()
    await first
    expect(handler).toHaveBeenCalledTimes(1)
    expect(await coordinator.run('a', async () => ({ ok: false, error: 'fresh' }))).toEqual({ ok: false, error: 'fresh' })
  })

  it('Stop cancels before dispatch and during an outstanding step', async () => {
    const coordinator = new AgentRestartCoordinator()
    const untouched = vi.fn(async () => ({ ok: false, error: 'unexpected' } as const))
    const first = coordinator.run('a', untouched)
    coordinator.cancel('a')
    expect(await first).toEqual({ ok: false, error: 'AGENT_CHANGED' })
    expect(untouched).not.toHaveBeenCalled()
    let finish!: () => void
    let isCurrent!: () => boolean
    const second = coordinator.run('a', async (current) => {
      isCurrent = current
      await new Promise<void>((resolve) => { finish = resolve })
      return { ok: false, error: 'old receipt' }
    })
    await Promise.resolve()
    coordinator.cancel('a')
    expect(isCurrent()).toBe(false)
    expect(coordinator.run('a', untouched)).toBe(second)
    finish()
    expect(await second).toEqual({ ok: false, error: 'AGENT_CHANGED' })
    expect(untouched).not.toHaveBeenCalled()
  })

  it('a thrown restart releases the coordinator for a new explicit attempt', async () => {
    const coordinator = new AgentRestartCoordinator()
    await expect(coordinator.run('a', async () => { throw new Error('lost') })).rejects.toThrow('lost')
    expect(await coordinator.run('a', async () => ({ ok: false, error: 'fresh' }))).toEqual({ ok: false, error: 'fresh' })
  })
})
