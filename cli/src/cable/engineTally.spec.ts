import { describe, expect, it } from 'vitest'
import { createEngineTally } from './engineTally.js'

// Built from local time, so a day is the person's day whatever the zone the test runs in.
const at = (day: number, hour: number, minute = 0): number => new Date(2026, 10, day, hour, minute).getTime()

function tally(clock = { at: at(17, 9) }) {
  const log: string[] = []
  const count = createEngineTally('[device] notify', ['claude', 'codex', 'agent'], ['shown', 'no dial', 'limited'],
    (line) => log.push(line), () => clock.at)
  return { count, log, clock }
}

describe('createEngineTally', () => {
  it('an event is one line, then the day\'s counts for every engine', () => {
    const { count, log } = tally()
    count('claude', 'shown')
    expect(log).toEqual([
      '[device] notify · claude · shown',
      '[device] notify · day 2026-11-17 · claude shown 1 no dial 0 limited 0 · codex shown 0 no dial 0 limited 0 · agent shown 0 no dial 0 limited 0',
    ])
  })

  it('a new local day starts at zero', () => {
    const { count, log, clock } = tally({ at: at(17, 23, 59) })
    count('codex', 'limited')
    count('codex', 'limited')
    clock.at = at(18, 0, 1)
    count('agent', 'no dial')
    expect(log.at(-1)).toBe('[device] notify · day 2026-11-18 · claude shown 0 no dial 0 limited 0 · codex shown 0 no dial 0 limited 0 · agent shown 0 no dial 1 limited 0')
  })

  it('a reason is on the event\'s line and not the day\'s', () => {
    const log: string[] = []
    const count = createEngineTally('[device] dial setup', ['claude', 'codex'], ['set up', 'updated', 'failed', 'left removed'],
      (line) => log.push(line), () => at(17, 9))
    count('claude', 'failed', 'install')
    expect(log).toEqual([
      '[device] dial setup · claude · failed · install',
      '[device] dial setup · day 2026-11-17 · claude set up 0 updated 0 failed 1 left removed 0 · codex set up 0 updated 0 failed 0 left removed 0',
    ])
  })
})
