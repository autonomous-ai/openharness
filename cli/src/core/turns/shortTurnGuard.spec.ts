import { describe, expect, it } from 'vitest'
import { createShortTurnGuard } from './shortTurnGuard.js'

function setup() {
  let at = 1_000_000
  const lines: string[] = []
  const guard = createShortTurnGuard({ now: () => at, log: (line) => lines.push(line) })
  const wait = (ms: number) => { at += ms }
  /** One turn of [ms], started [gap] ms after the last one ended. */
  const turn = (session: string, ms: number, gap = 500) => {
    wait(gap); guard.started(session, `agent-${session}`); wait(ms); guard.ended(session)
  }
  const turns = (session: string, count: number, ms = 2_000, gap = 500) => { for (let i = 0; i < count; i++) turn(session, ms, gap) }
  return { guard, lines, wait, turn, turns }
}

describe('short-turn guard', () => {
  it('holds an agent after ten back-to-back turns under 10 s, and says so once', () => {
    const { guard, lines, turns } = setup()
    turns('s1', 10)
    expect(guard.holding('s1')).toBe(30_000)
    expect(lines).toEqual(['[turn-guard] loop session=s1 agent=agent-s1 turns=10 hold=30s'])
  })

  it('does not hold after nine', () => {
    const { guard, lines, turns } = setup()
    turns('s1', 9)
    expect(guard.holding('s1')).toBe(0)
    expect(lines).toEqual([])
  })

  it('a turn of 10 s or more starts the count again', () => {
    const { guard, turn, turns } = setup()
    turns('s1', 9)
    turn('s1', 10_000)
    turns('s1', 9)
    expect(guard.holding('s1')).toBe(0)
  })

  it('a pause of 10 s or more between turns starts the count again', () => {
    const { guard, turn, turns } = setup()
    turns('s1', 9)
    turn('s1', 2_000, 10_000)
    turns('s1', 8)
    expect(guard.holding('s1')).toBe(0)
    turn('s1', 2_000)
    expect(guard.holding('s1')).toBe(30_000)
  })

  it('counts each agent apart', () => {
    const { guard, turns } = setup()
    turns('s1', 5)
    turns('s2', 5)
    expect(guard.holding('s1')).toBe(0)
    expect(guard.holding('s2')).toBe(0)
  })

  it('the hold runs out, and a loop that goes on doubles it up to 30 minutes', () => {
    const { guard, lines, wait, turns } = setup()
    turns('s1', 10)
    wait(29_000)
    expect(guard.holding('s1')).toBe(1_000)
    wait(1_000)
    expect(guard.holding('s1')).toBe(0)
    const holds: number[] = []
    for (let i = 0; i < 8; i++) {
      turns('s1', 10)
      holds.push(guard.holding('s1'))
      wait(guard.holding('s1'))
    }
    expect(holds).toEqual([60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000, 1_800_000])
    expect(lines.at(-1)).toBe('[turn-guard] loop session=s1 agent=agent-s1 turns=10 hold=1800s')
  })

  it('a normal turn lifts the hold and the backoff', () => {
    const { guard, turn, turns } = setup()
    turns('s1', 10)
    turn('s1', 15_000)
    expect(guard.holding('s1')).toBe(0)
    turns('s1', 10)
    expect(guard.holding('s1')).toBe(30_000)
  })

  it('an end with no start counts nothing', () => {
    const { guard, wait } = setup()
    for (let i = 0; i < 20; i++) { wait(100); guard.ended('s1') }
    expect(guard.holding('s1')).toBe(0)
  })

  it('keeps at most 1000 agents, forgetting the oldest', () => {
    const { guard, turns } = setup()
    turns('first', 10)
    for (let i = 0; i < 1_000; i++) turns(`other-${i}`, 1)
    expect(guard.size).toBe(1_000)
    expect(guard.holding('first')).toBe(0)
  })
})
