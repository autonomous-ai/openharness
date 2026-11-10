import { describe, expect, it } from 'vitest'
import { addPhase, commandPhases, timeCommand, timedPhase, type CommandPhases } from './commandTiming.js'

/** Runs [work] as one command on [clock], returning its result and what it reported. */
async function timed<T>(clock: () => number, work: () => Promise<T>) {
  let reported: { phases: CommandPhases; totalMs: number } | undefined
  const result = await timeCommand(clock, work, (phases, totalMs) => { reported = { phases, totalMs } })
  return { result, phases: reported!.phases, totalMs: reported!.totalMs }
}

// Task #4560: some commands wait ~3.5 s in prod with little DB or CPU time; each phase's time names the wait.
describe('a command\'s phase timings', () => {
  it('adds each phase\'s time on the command\'s own clock, sums repeats, and counts attempts', async () => {
    let now = 0
    const { result, phases, totalMs } = await timed(() => now, async () => {
      await timedPhase('read:pullRequestMerges', async () => { now += 3_400 })
      addPhase('pool', 5)
      addPhase('pool', 7)
      addPhase('attempts', 1)
      addPhase('attempts', 1)
      expect(commandPhases()).toMatchObject({ pool: 12 })
      return 'done'
    })
    expect(result).toBe('done')
    expect(phases).toEqual({ 'read:pullRequestMerges': 3_400, pool: 12, attempts: 2 })
    expect(totalMs).toBe(3_400)
  })

  it('keeps a read\'s inner transaction out of the command\'s own phases, and records nothing outside a command', async () => {
    let now = 0
    const { phases } = await timed(() => now, async () => {
      await timedPhase('read:pullRequestMerges', async () => { addPhase('body', 50); now += 80 })
      addPhase('body', 20)
    })
    expect(phases).toEqual({ 'read:pullRequestMerges': 80, body: 20 })
    addPhase('body', 1)
    expect(commandPhases()).toBeUndefined()
    expect(await timedPhase('stamps', async () => 'outside')).toBe('outside')
  })

  it('reports a command that failed, with its phases and total', async () => {
    let now = 0, reported: { phases: CommandPhases; totalMs: number } | undefined
    await expect(timeCommand(() => now, async () => { addPhase('backoff', 2_900); now += 3_500; throw new Error('busy') },
      (phases, totalMs) => { reported = { phases, totalMs } })).rejects.toThrow('busy')
    expect(reported).toEqual({ phases: { backoff: 2_900 }, totalMs: 3_500 })
  })

  it('still records a phase whose work failed', async () => {
    let now = 0
    const { phases } = await timed(() => now, async () => {
      await timedPhase('read:pullRequestMerges', async () => { now += 900; throw new Error('GitHub down') }).catch(() => undefined)
    })
    expect(phases).toEqual({ 'read:pullRequestMerges': 900 })
  })
})
