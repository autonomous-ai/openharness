/**
 * pair/brief.ts composeBrief, pure: the ordering of what needs you, the facts line, and the journals a
 * remote machine sends (untrusted: a missing name or text must not become a made-up fact).
 */
import { describe, expect, it } from 'vitest'
import { composeBrief, type BriefInput } from './brief.js'
import type { FleetHarness, MachineJournal } from './fleet.js'
import type { PairJournalEntry, PairQuestion } from './protocol.js'

const MIN = 60_000
const NOW = 10_000 * MIN

const e = (kind: PairJournalEntry['kind'], agentId: string, name: string, at: number, text?: string): PairJournalEntry =>
  ({ epoch: 'x', seq: at, at, kind, agentId, name, engine: 'claude', ...(text !== undefined ? { text } : {}) })

const question = (text: string, since: number): PairQuestion =>
  ({ requestId: `r-${text}`, text, options: ['Yes', 'No'], multi: false, deny: false, allow: true, permission: true, since })

const waitingOn = (machineId: string, machine: string, local: boolean, agentId: string, name: string, q: PairQuestion): FleetHarness =>
  ({ machineId, machine, local, harness: { agentId, name, engine: 'claude', working: false, question: q, failing: null, lastDoneAt: null, recap: null } })

const input = (over: Partial<BriefInput>): BriefInput => ({ journals: [], harnesses: [], machines: [], awayMs: 60 * MIN, now: NOW, ...over })

describe('composeBrief', () => {
  it('orders waiting items oldest-first and dates the oldest wait', () => {
    const { facts, items } = composeBrief(input({
      harnesses: [
        waitingOn('m1', 'desk', true, 'a', 'api', question('newer?', NOW - 5 * MIN)),
        waitingOn('m2', 'laptop', false, 'b', 'web', question('older?', NOW - 40 * MIN)),
      ],
      machines: [{ machineId: 'm1', name: 'desk', status: 'ok', local: true }, { machineId: 'm2', name: 'laptop', status: 'ok', local: false }],
    }))
    expect(items.map((i) => i.line)).toEqual(['web@laptop: older? (40m)', 'api: newer? (5m)'])
    expect(items[0]).toMatchObject({ id: 'waiting:m2:b', kind: 'waiting', question: { text: 'older?' } })
    expect(facts).toMatchObject({ waiting: 2, oldestWaitMs: 40 * MIN, changed: 2, total: 2, machines: 2 })
  })

  it('says "failed" when a fail entry carries no reason, never inventing one', () => {
    const { facts, items } = composeBrief(input({
      journals: [{ machineId: 'm1', machine: 'desk', local: true, entries: [e('fail', 'a', 'api', NOW - MIN)] }],
    }))
    expect(items).toEqual([expect.objectContaining({ kind: 'failed', line: 'api failed: failed' })])
    expect(facts.failed).toEqual(['api'])
    expect(facts.oldestWaitMs).toBeNull()
  })

  it('keeps a nameless remote entry nameless rather than inventing a name', () => {
    const nameless = (kind: PairJournalEntry['kind'], at: number, text?: string): PairJournalEntry => {
      const entry = e(kind, 'z', 'ignored', at, text)
      delete (entry as Partial<PairJournalEntry>).name
      return entry
    }
    const { facts, items } = composeBrief(input({
      journals: [{ machineId: 'm2', machine: 'laptop', local: false, entries: [nameless('fail', NOW - 2 * MIN, 'exit 1'), nameless('done', NOW - MIN)] }],
    }))
    expect(items.map((i) => i.line)).toEqual(['@laptop failed: exit 1', '@laptop finished.'])
    expect(facts.failed).toEqual(['@laptop'])
  })

  it('counts turns, keeps the latest recap, ignores an interrupt, and drops a recap with no turn', () => {
    const { facts, items } = composeBrief(input({
      journals: [{
        machineId: 'm1', machine: 'desk', local: true, entries: [
          e('recap', 'orphan', 'docs', NOW - 9 * MIN, 'a recap with no turn before it'),
          e('done', 'a', 'api', NOW - 8 * MIN),
          e('recap', 'a', 'api', NOW - 8 * MIN, 'first'),
          e('done', 'a', 'api', NOW - 3 * MIN),
          e('recap', 'a', 'api', NOW - 3 * MIN, 'tests pass'),
          e('done', 'b', 'web', NOW - 2 * MIN, 'interrupted'),
          e('recap', 'b', 'web', NOW - MIN, ''),
        ],
      }],
    }))
    expect(items.map((i) => i.line)).toEqual(['api finished 2 turns: tests pass'])
    expect(facts.done).toBe(1)
    // The orphan recap and the api turns touched two harnesses; an interrupt with an empty recap touched none.
    expect(facts.changed).toBe(2)
  })

  it('names an erroring machine that is not in the machine list by its own name', () => {
    const journals: MachineJournal[] = [
      { machineId: 'm9', machine: 'ghost', local: false, entries: [], error: 'TIMEOUT' },
      { machineId: 'm8', machine: 'owl', local: false, entries: [], error: 'asleep' },
    ]
    const { facts, items } = composeBrief(input({ journals }))
    expect(items).toEqual([
      { id: 'unreachable:ghost', kind: 'unreachable', machineId: 'ghost', machine: 'ghost', line: 'ghost did not answer.' },
      { id: 'asleep:owl', kind: 'asleep', machineId: 'owl', machine: 'owl', line: 'owl is asleep.' },
    ])
    expect(facts).toMatchObject({ unreachable: ['ghost'], asleep: ['owl'] })
  })

  it('calls a machine asleep, never unreachable, when the account says it sleeps', () => {
    const { facts } = composeBrief(input({
      journals: [{ machineId: 'm2', machine: 'laptop', local: false, entries: [], error: 'TIMEOUT' }],
      machines: [
        { machineId: 'm2', name: 'laptop', status: 'asleep', local: false },
        { machineId: 'm3', name: 'nas', status: 'unreachable', local: false },
        { machineId: 'm4', name: 'here', status: 'unreachable', local: true },   // the local machine is never named
      ],
    }))
    expect(facts.asleep).toEqual(['laptop'])
    expect(facts.unreachable).toEqual(['nas'])
  })

  it('never lists more than five items, what needs you first', () => {
    const harnesses = Array.from({ length: 4 }, (_, i) => waitingOn('m1', 'desk', true, `w${i}`, `w${i}`, question(`q${i}?`, NOW - (10 - i) * MIN)))
    const { items, facts } = composeBrief(input({
      harnesses,
      journals: [{ machineId: 'm1', machine: 'desk', local: true, entries: [e('fail', 'f', 'f', NOW - MIN, 'x'), e('done', 'd', 'd', NOW - MIN)] }],
    }))
    expect(items.map((i) => i.kind)).toEqual(['waiting', 'waiting', 'waiting', 'waiting', 'failed'])
    expect(facts.done).toBe(1)   // the facts still count what the list had no room for
  })
})
