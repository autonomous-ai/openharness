/**
 * pair/voice.ts on its own: the roster templates filled with facts (never a made-up one), the lines that
 * carry every fact their mood must, and PairVoice's limits — one unsolicited line per two minutes, six a
 * minute, a line said once, keys that die with the line.
 */
import { describe, expect, it } from 'vitest'
import {
  PairVoice, SAY_WINDOW_MAX, SAY_WINDOW_MS, UNSOLICITED_GAP_MS,
  ago, autoLine, backLine, doneLine, failLine, fillLine, isRosterDaemon, keysPrefix, lineText, needLine, rosterDaemon, rosterLine,
  summaryOf, voicedLine, type BackFacts,
} from './voice.js'
import type { DaemonMood, DaemonSay } from './protocol.js'
import { PAIR_ROSTER } from './roster.g.js'

const MIN = 60_000
const HOUR = 60 * MIN

describe('the roster', () => {
  it('knows each daemon by id and nothing else', () => {
    expect(isRosterDaemon('tim')).toBe(true)
    expect(isRosterDaemon('nobody')).toBe(false)
    expect(isRosterDaemon(42)).toBe(false)
    expect(isRosterDaemon(undefined)).toBe(false)
    expect(rosterDaemon('nobody')).toBeNull()
    expect(rosterLine('nobody', 'need')).toBeNull()
    expect(rosterLine('tim', 'need')).toBe('{who}: {q}  (bell)')
  })
})

describe('fillLine', () => {
  it('fills every known slot verbatim, flattened to one ASCII line', () => {
    expect(fillLine('{who}: {q}', { who: 'api', q: 'Run\nnpm test?' })).toBe('api: Run npm test?')
    expect(fillLine('{n} panes', { n: 0 })).toBe('0 panes')
  })

  it('refuses (null) when a slot it names has no value, rather than claim something nobody said', () => {
    expect(fillLine('{who} failed: {recap}', { who: 'api' })).toBeNull()
    expect(fillLine('{who} failed: {recap}', { who: 'api', recap: null })).toBeNull()
    expect(fillLine('{who}: {q}', { who: 'api', q: 'éé' })).toBeNull()   // nothing printable left
  })

  it('leaves a slot the roster does not know exactly as written', () => {
    expect(fillLine('{who} {mystery}', { who: 'api' })).toBe('api {mystery}')
  })
})

describe('lineText / keysPrefix', () => {
  it('keeps deliberate spacing but cuts a long line with a marker', () => {
    expect(lineText('[1]  + done', 40)).toBe('[1]  + done')
    const cut = lineText(`${'word '.repeat(40)}`, 20)
    expect(cut.endsWith('...')).toBe(true)
    expect(cut.length).toBeLessThanOrEqual(20)
  })

  it('lists the keys in y/n/s/g order whatever order the actions come in, and nothing for none', () => {
    expect(keysPrefix([{ key: 'g' }, { key: 'y' }, { key: 'n' }])).toBe('[y/n/g] ')
    expect(keysPrefix([{ key: 's' }])).toBe('[s] ')
    expect(keysPrefix([])).toBe('')
  })
})

describe('voicedLine', () => {
  it('falls back to the neutral line for a daemon that is not in the roster', () => {
    expect(voicedLine('nobody', 'need', { who: 'api', q: 'x' }, ['who', 'q'], 'api: x')).toBe('api: x')
  })

  it('falls back when a slot the template names cannot be filled', () => {
    expect(voicedLine('tim', 'fail', { who: 'api', recap: '' }, ['who'], 'api failed.')).toBe('api failed.')
  })

  it('appends a required fact its template leaves out, in that fact\'s own form', () => {
    // grue's back line has no {summary}; bat's done line has no {n}.
    expect(voicedLine('grue', 'back', { summary: '2 done' }, ['summary'], 'x')).toBe('you have moved into a dark place. 2 done.')
    expect(voicedLine('bat', 'done', { who: 'api', recap: 'ok', n: 3 }, ['who', 'n'], 'x')).toBe('api finished. highlighted: ok (3)')
    expect(voicedLine('grue', 'done', { who: 'api', recap: 'r' }, ['who', 'recap'], 'x')).toBe('the lamp is lit. api is done. r')
    expect(voicedLine('grue', 'need', { who: 'api', q: 'go?' }, ['who', 'q'], 'x')).toBe('api: go?  (in the dark)')
    expect(voicedLine('tim', 'back', { summary: 's', who: 'api' }, ['summary', 'who'], 'x')).toBe('reattached. s. (api)')
    expect(voicedLine('tim', 'done', { who: 'api', recap: 'r', q: 'go?' }, ['q'], 'x')).toBe('silence in api: r: go?')
  })

  it('appends nothing for a required fact that has no value', () => {
    expect(voicedLine('grue', 'back', { summary: null }, ['summary'], 'x')).toBe('you have moved into a dark place.')
    expect(voicedLine('grue', 'back', { summary: 'é' }, ['summary'], 'x')).toBe('you have moved into a dark place.')
  })
})

describe('the mood lines', () => {
  it('needLine: keys first, then who and what is asked, for every daemon in the roster', () => {
    for (const daemon of PAIR_ROSTER.daemons) {
      const line = needLine(daemon.id, { who: 'api@laptop', question: 'Bash: npm test' }, [{ key: 'y' }, { key: 'g' }])
      expect(line.startsWith('[y/g] ')).toBe(true)
      expect(line).toContain('api@laptop')
      expect(line).toContain('Bash: npm test')
      expect(line.length).toBeLessThanOrEqual(140)
    }
  })

  it('failLine: says "failed" when the reason is empty, never leaving the slot blank', () => {
    expect(failLine('tim', { who: 'api', reason: '' })).toBe('api failed: failed  (pane is dead)')
    expect(failLine('nobody', { who: 'api', reason: 'exit 2' })).toBe('api failed: exit 2')
  })

  it('doneLine: the recap when there is one, a neutral line when the template needs one that is missing', () => {
    expect(doneLine('tim', { who: 'api', recap: 'tests pass' })).toBe('silence in api: tests pass')
    expect(doneLine('tim', { who: 'api', recap: null })).toBe('api finished.')
    expect(doneLine('nobody', { who: 'api', recap: 'r' })).toBe('api finished: r')
  })

  it('autoLine: says who did it — a rule or the pair — on one bounded ASCII line', () => {
    expect(autoLine({ by: 'rule', who: 'api', text: 'answered "Yes"\nfor you' })).toBe('rule: api answered "Yes" for you')
    expect(autoLine({ by: 'pair', who: 'web@laptop', text: 'x'.repeat(300) }).length).toBe(140)
  })

  it('backLine: every daemon says the same facts', () => {
    const facts: BackFacts = { done: 2, waiting: 1, oldestWaitMs: 40 * MIN, awayMs: HOUR, failed: ['api'], unreachable: ['nas'], asleep: ['laptop'], machines: 3, changed: 3, total: 5 }
    for (const daemon of PAIR_ROSTER.daemons) {
      expect(backLine(daemon.id, facts)).toContain('2 done, 1 waiting 40m, api failed, nas unreachable, laptop asleep')
    }
  })
})

describe('summaryOf / ago', () => {
  const none: BackFacts = { done: 0, waiting: 0, oldestWaitMs: null, awayMs: 0, failed: [], unreachable: [], asleep: [], machines: 1, changed: 0, total: 0 }

  it('is "nothing new" when there is nothing, and a bare count when the wait is unknown', () => {
    expect(summaryOf(none)).toBe('nothing new')
    expect(summaryOf({ ...none, waiting: 2 })).toBe('2 waiting')
  })

  it('reads a duration the way a status line would', () => {
    expect(ago(0)).toBe('1s')
    expect(ago(12_000)).toBe('12s')
    expect(ago(29_999)).toBe('30s')
    expect(ago(40 * MIN)).toBe('40m')
    expect(ago(119 * MIN)).toBe('119m')
    expect(ago(120 * MIN)).toBe('2h')
    expect(ago(47 * HOUR)).toBe('47h')
    expect(ago(48 * HOUR)).toBe('2d')
    expect(ago(10 * 24 * HOUR)).toBe('10d')
  })
})

describe('PairVoice', () => {
  function voice(start = 1_000_000) {
    let t = start
    const frames: Array<Record<string, unknown>> = []
    const v = new PairVoice({ sendLocal: (f) => { frames.push(f) }, now: () => t })
    return { v, frames, advance: (ms: number) => { t += ms } }
  }
  const say = (id: string, mood: DaemonMood, over: Partial<DaemonSay> = {}): DaemonSay =>
    ({ id, about: { machineId: 'm1', agentId: 'a1' }, mood, line: id, actions: [], ttlMs: 5_200, ...over })

  it('says a line once, however often it is asked to', () => {
    const { v, frames, advance } = voice()
    expect(v.say(say('x', 'say'))).toBe(true)
    advance(10 * MIN)
    expect(v.say(say('x', 'say'))).toBe(false)
    expect(v.wasSaid('x')).toBe(true)
    expect(v.wasSaid('y')).toBe(false)
    expect(frames).toHaveLength(1)
  })

  it('allows one unsolicited line per gap; an `always` line ignores the gap', () => {
    const { v, advance } = voice()
    expect(v.say(say('a', 'need'))).toBe(true)
    expect(v.say(say('b', 'fail'))).toBe(false)
    expect(v.say(say('c', 'auto'), { always: true })).toBe(true)
    advance(UNSOLICITED_GAP_MS)
    expect(v.say(say('b', 'fail'))).toBe(true)
  })

  it('caps every line at six a minute, except a proposal (ask) and an `always` line', () => {
    const { v, frames, advance } = voice()
    for (let i = 0; i < SAY_WINDOW_MAX; i++) expect(v.say(say(`s${i}`, 'say'))).toBe(true)
    expect(v.say(say('over', 'say'))).toBe(false)
    expect(v.say(say('back', 'back'))).toBe(false)
    expect(v.say(say('proposal', 'ask'))).toBe(true)
    expect(v.say(say('gate', 'say'), { always: true })).toBe(true)
    advance(SAY_WINDOW_MS)
    expect(v.say(say('over', 'say'))).toBe(true)
    expect(frames.map((f) => (f.payload as DaemonSay).id)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 'proposal', 'gate', 'over'])
  })

  it('forgets the oldest ids past 500, so it stays bounded', () => {
    const { v, advance } = voice()
    for (let i = 0; i <= 500; i++) { v.say(say(`id${i}`, 'say'), { always: true }); advance(1) }
    expect(v.wasSaid('id0')).toBe(false)
    expect(v.wasSaid('id1')).toBe(true)
    expect(v.wasSaid('id500')).toBe(true)
  })

  it('replaces a line still showing in place, with only the time it had left', () => {
    const { v, frames, advance } = voice()
    v.say(say('x', 'need', { ttlMs: 5_000 }))
    advance(2_000)
    expect(v.replace('x', { line: 'better words', actions: [{ key: 'g', label: 'open', choice: 'open' }] })).toBe(true)
    expect(frames[1]).toEqual({ type: 'daemon_say', payload: expect.objectContaining({ id: 'x', line: 'better words', ttlMs: 3_000 }) })
    expect(v.get('x')?.line).toBe('better words')
    advance(3_000)
    expect(v.get('x')).toBeNull()                                  // the replacement did not extend it
    expect(v.replace('x', { line: 'late', actions: [] })).toBe(false)
  })

  it('holds keys for a brief without sending a line, and lets them lapse', () => {
    const { v, frames, advance } = voice()
    v.hold(say('brief-1', 'ask', { ttlMs: 1_000 }))
    expect(frames).toEqual([])
    expect(v.showing('ask')).toBe(true)
    expect(v.showing('need')).toBe(false)
    advance(1_000)
    expect(v.showing('ask')).toBe(false)
  })

  it('takes back a showing line (once), and every line about a harness — or one question of it', () => {
    const { v, frames } = voice()
    v.say(say('q1', 'ask', { about: { machineId: 'm1', agentId: 'a1', requestId: 'r1' } }))
    v.say(say('q2', 'ask', { about: { machineId: 'm1', agentId: 'a1', requestId: 'r2' } }))
    v.say(say('other', 'ask', { about: { machineId: 'm1', agentId: 'a2', requestId: 'r1' } }))
    v.say(say('elsewhere', 'ask', { about: { machineId: 'm2', agentId: 'a1' } }))

    v.unsayAbout('m1', 'a1', 'answered', 'r1')
    expect(frames.slice(4)).toEqual([{ type: 'daemon_unsay', payload: { id: 'q1', reason: 'answered' } }])
    expect(v.get('q2')).not.toBeNull()

    v.unsayAbout('m1', 'a1', 'gone')
    expect(frames.slice(5)).toEqual([{ type: 'daemon_unsay', payload: { id: 'q2', reason: 'gone' } }])
    expect(v.get('other')).not.toBeNull()
    expect(v.get('elsewhere')).not.toBeNull()

    expect(v.unsay('other', 'x')).toBe(true)
    expect(v.unsay('other', 'x')).toBe(false)
  })
})
