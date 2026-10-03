/**
 * PairSensor edges (pair/sensor.ts) beyond sensor.spec.ts: what the sensor does with inputs that do not
 * belong to it (pairing off, an unknown harness, a mismatched request), the records it keeps that are not
 * a harness change (`acted` on a gone harness, `learned`, `relayed`), and that one failing listener or
 * watcher never stops the others. A temp journal and a fake clock; `home` pinned so nothing reads ~.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { PairJournal } from './journal.js'
import { PairSensor, type PairSubject } from './sensor.js'
import type { PairEvent } from './protocol.js'

let dir: string
let clock: number
const now = (): number => clock

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pair-sensor-more-'))
  clock = 1_000_000
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function sensor(opts: { on?: boolean; subjects?: Record<string, PairSubject>; home?: string | null; onEnabledChanged?: (on: boolean) => void } = {}) {
  const subjects: Record<string, PairSubject> = opts.subjects ?? {
    api: { name: 'api', engine: 'claude', cwd: '/work/api' },
    blank: { name: '   ', engine: 'codex' },
  }
  const journal = new PairJournal({ dir, newEpoch: () => 'ep' })
  const s = new PairSensor({
    machineId: () => 'machine-a', journal, describe: (id) => subjects[id] ?? null, now,
    home: opts.home === undefined ? '/home/tester' : opts.home,
    ...(opts.onEnabledChanged ? { onEnabledChanged: opts.onEnabledChanged } : {}),
  })
  const events: PairEvent[] = []
  s.subscribe((event) => events.push(event))
  if (opts.on !== false) s.setPair('tim')
  return { s, journal, events, subjects }
}

describe('PairSensor: the switch', () => {
  it('reports a change of state once; the same id again, or a new id while on, is not a change', () => {
    const changed = vi.fn()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { s } = sensor({ on: false, onEnabledChanged: changed })
    s.setPair(null)
    expect(changed).not.toHaveBeenCalled()
    s.setPair('tim')
    s.setPair('tim')
    s.setPair('ada')
    expect(changed.mock.calls).toEqual([[true]])
    expect(s.pairedDaemon()).toBe('ada')
    s.setPair(null)
    expect(changed.mock.calls).toEqual([[true], [false]])
    expect(s.pairedDaemon()).toBeNull()
    log.mockRestore()
  })

  it('while off it keeps no record: acted, learned and relayed return null and write nothing', () => {
    const { s, journal, events } = sensor({ on: false })
    expect(s.acted({ agentId: 'api', name: 'api', engine: 'claude' }, { by: 'key', action: 'send', text: 'x' })).toBeNull()
    expect(s.learned({ daemon: 'tim', name: 'lesson' })).toBeNull()
    expect(s.relayed({ target: 'b', agentId: 'api', name: 'api', engine: 'claude', requestId: 'q', text: 'y', origin: 'w' })).toBeNull()
    s.recap('api', 'did a thing')
    s.failed('api', 'boom')
    s.turnEnded('api')
    expect(journal.seq).toBe(0)
    expect(events).toEqual([])
  })
})

describe('PairSensor: inputs it ignores', () => {
  it('a close for another request, for an unknown harness, or with pairing off moves nothing', () => {
    const { s, journal, events } = sensor()
    s.question('api', 'q_1', [{ key: 'k', q: 'Run it?', options: ['Yes', 'No'], multi: false }])
    const seq = journal.seq
    const n = events.length
    s.questionGone('api', 'q_other')
    s.questionGone('ghost', 'q_1')
    expect(journal.seq).toBe(seq)
    expect(events.length).toBe(n)
    expect(s.harness('api')?.question?.requestId).toBe('q_1')
    s.setPair(null)
    s.questionGone('api', 'q_1')
    expect(journal.seq).toBe(seq)
  })

  it('a question with no requestId, an empty agentId, or an unknown harness is not asked', () => {
    const { s, journal } = sensor()
    s.question('api', '', [{ key: 'k', q: 'Run it?', options: ['Yes'], multi: false }])
    s.question('', 'q_1', [{ key: 'k', q: 'Run it?', options: ['Yes'], multi: false }])
    s.question('ghost', 'q_1', [{ key: 'k', q: 'Run it?', options: ['Yes'], multi: false }])
    expect(journal.seq).toBe(0)
    expect(s.harness('ghost')).toBeNull()
  })

  it('a removal of a harness it never watched pushes nothing', () => {
    const { s, events } = sensor()
    s.removed('ghost')
    expect(events).toEqual([])
    expect(s.snapshot().rev).toBe(0)
  })

  it('a recap that is blank or unchanged is not news; a failure with no reason still says "failed", once', () => {
    const { s, journal } = sensor()
    s.recap('api', '   \n\t ')
    expect(journal.seq).toBe(0)
    s.recap('api', 'ran the tests')
    s.recap('api', 'ran   the\ntests')
    expect(journal.since().entries.map((e) => [e.kind, e.text])).toEqual([['recap', 'ran the tests']])
    s.failed('api', '\u0007\u0007')
    s.failed('api', '')
    const fails = journal.since().entries.filter((e) => e.kind === 'fail')
    expect(fails.map((e) => e.text)).toEqual(['failed'])
    expect(s.harness('api')?.failing).toBe('failed')
  })
})

describe('PairSensor: the question it records', () => {
  it('an empty shaped list still records the dialog, with no options, not multi', () => {
    const { s } = sensor()
    s.question('api', 'q_1', [], { permission: true, dialog: 'Bash command\n  npm test\nDo you want to proceed?' })
    const q = s.harness('api')!.question!
    expect(q).toMatchObject({ requestId: 'q_1', text: '', options: [], multi: false, permission: true })
    expect(q.dialog).toContain('npm test')
  })

  it('without a dialog it reads the question text; without a permission flag it is not a permission prompt', () => {
    const { s } = sensor()
    s.question('api', 'q_1', [{ key: 'k', q: 'Which colour?', options: ['Red', 'Blue'], multi: true }])
    const q = s.harness('api')!.question!
    expect(q).toMatchObject({ text: 'Which colour?', options: ['Red', 'Blue'], multi: true, permission: false, allow: false, deny: false, dialog: 'Which colour?' })
  })

  it('a painted dialog that is empty falls back to the question for what is shown', () => {
    const { s } = sensor()
    s.question('api', 'q_1', [{ key: 'k', q: 'Proceed?', options: ['Yes', 'No'], multi: false }], { permission: false, dialog: '' })
    expect(s.harness('api')!.question!.dialog).toBe('Proceed?')
  })
})

describe('PairSensor: what it records that is not a harness change', () => {
  it('an act on a harness that is gone is journaled under the name it had and pushed as removed', () => {
    const { s, journal, events } = sensor()
    const entry = s.acted({ agentId: 'paused-1234567890', name: '', engine: 'claude' },
      { by: 'rule', action: 'pause', text: 'paused it', requestId: 'r1', origin: 'local:window\nlabel' })
    expect(entry).toMatchObject({ kind: 'act', by: 'rule', action: 'pause', name: 'paused-1', requestId: 'r1', origin: 'local:window label' })
    expect(journal.seq).toBe(1)
    expect(events.at(-1)).toMatchObject({ agentId: 'paused-1234567890', harness: null, removed: true, rev: 1 })
    expect(events.at(-1)!.entry).toEqual(entry)

    // An empty agentId is not an act on anything.
    expect(s.acted({ agentId: '', name: 'x', engine: 'claude' }, { by: 'key', action: 'send', text: 'y' })).toBeNull()
    // An act on a watched harness rides its change (no removal), with no requestId/origin when absent.
    const live = s.acted({ agentId: 'api', name: 'api', engine: 'claude' }, { by: 'pair', action: 'send', text: 'hello' })
    expect(live).not.toHaveProperty('requestId')
    expect(live).not.toHaveProperty('origin')
    expect(events.at(-1)).toMatchObject({ agentId: 'api', harness: { agentId: 'api' } })
    expect(events.at(-1)!.removed).toBeUndefined()
  })

  it('learned credits the daemon, falls back to "lesson" for a blank name, and pushes nothing', () => {
    const { s, events } = sensor()
    const a = s.learned({ daemon: 'tim', name: '  ', agentId: 'api', engine: 'claude' })
    expect(a).toMatchObject({ kind: 'learned', daemon: 'tim', name: 'lesson', text: 'learned "lesson"', agentId: 'api', engine: 'claude' })
    const b = s.learned({ daemon: 'ada', name: 'run tests with --run' })
    expect(b).toMatchObject({ agentId: '', engine: '', name: 'run tests with --run' })
    expect(events).toEqual([])
  })

  it('relayed records the target and the window, redacted, and pushes nothing', () => {
    const { s, events } = sensor()
    const e = s.relayed({ target: 'machine-b', agentId: 'api', name: 'api', engine: 'claude', requestId: 'q_1',
      text: 'answered with password=hunter2hunter2', origin: 'local:window' })
    expect(e).toMatchObject({ kind: 'relayed', by: 'key', action: 'answer', target: 'machine-b', origin: 'local:window', requestId: 'q_1' })
    expect(e!.text).not.toContain('hunter2')
    expect(events).toEqual([])
  })

  it('an unnamed subject is named by its id, and a subject renamed later is followed', () => {
    const subjects: Record<string, PairSubject> = { 'abcdefghijkl': { name: '', engine: 'codex' } }
    const { s } = sensor({ subjects })
    s.turnStarted('abcdefghijkl')
    expect(s.harness('abcdefghijkl')?.name).toBe('abcdefgh')
    subjects['abcdefghijkl'] = { name: 'web', engine: 'claude' }
    s.turnEnded('abcdefghijkl')
    expect(s.harness('abcdefghijkl')).toMatchObject({ name: 'web', engine: 'claude' })
  })
})

describe('PairSensor: reads', () => {
  it('journal takes an epoch/seq cursor, a time, and a limit; ignores ones that are not finite numbers', async () => {
    const { s } = sensor()
    for (let i = 0; i < 5; i++) { clock += 1_000; s.recap('api', `step ${i}`) }
    expect(s.journal({ limit: 2 }).entries.map((e) => e.seq)).toEqual([1, 2])
    expect(s.journal({ epoch: 'ep', seq: 3 }).entries.map((e) => e.seq)).toEqual([4, 5])
    expect(s.journal({ at: 1_004_000 }).entries.map((e) => e.seq)).toEqual([4, 5])
    expect(s.journal({ at: Number.NaN, limit: Infinity, seq: '2', epoch: 7 }).entries).toHaveLength(5)
    expect((await s.local({ verb: 'journal', limit: 1 })).entries).toHaveLength(1)
  })

  it('read wants a watched agentId; the local verbs default to status', async () => {
    const { s } = sensor()
    s.turnStarted('api')
    expect(s.read({})).toEqual({ error: 'NOT_FOUND' })
    expect(s.read({ agentId: 42 })).toEqual({ error: 'NOT_FOUND' })
    expect(s.read({ agentId: 'ghost' })).toEqual({ error: 'NOT_FOUND' })
    expect(await s.local({ verb: 'read', agentId: 'api' })).toMatchObject({ harness: { agentId: 'api', working: true } })
    expect(await s.local({})).toEqual({ on: true, pair: 'tim', machineId: 'machine-a', epoch: 'ep', seq: 1 })
    expect(await s.local({ verb: 7 })).toMatchObject({ on: true })
  })

  it('what it hands out is a copy: changing it changes nothing inside', () => {
    const { s } = sensor()
    s.question('api', 'q_1', [{ key: 'k', q: 'Go?', options: ['Yes', 'No'], multi: false }])
    const h = s.harness('api')!
    h.question!.options.push('Maybe')
    h.working = true
    expect(s.harness('api')!.question!.options).toEqual(['Yes', 'No'])
    expect(s.harness('api')!.working).toBe(false)
  })

  it('home: null turns off only the configured-home rule; left out, it is os.homedir() (a string, nothing read)', () => {
    const { s, journal } = sensor({ home: null })
    s.recap('api', 'edited /srv/people/tester/notes.txt and /home/tester/secret.txt')
    expect(journal.since().entries[0].text).toBe('edited /srv/people/tester/notes.txt and ~/secret.txt')

    rmSync(dir, { recursive: true, force: true })
    dir = mkdtempSync(join(tmpdir(), 'pair-sensor-more-'))
    const journal2 = new PairJournal({ dir, newEpoch: () => 'ep2' })
    const home = homedir()
    const s2 = new PairSensor({ machineId: () => 'm', journal: journal2, describe: () => ({ name: 'api', engine: 'claude' }), now })
    s2.setPair('tim')
    s2.recap('api', `edited ${home}/project/file.ts`)
    expect(journal2.since().entries[0].text).toBe('edited ~/project/file.ts')
  })
})

describe('PairSensor: fan-out', () => {
  it('an aborted turn is journaled as done, "interrupted"; an unsubscribed listener and an unwatched connection hear nothing more', () => {
    const { s, journal } = sensor()
    const heard: PairEvent[] = []
    const off = s.subscribe((e) => heard.push(e))
    const pushed: PairEvent[] = []
    s.watch('remote-1', (e) => { pushed.push(e); return true })
    s.turnStarted('api')
    s.turnEnded('api', { aborted: true })
    expect(journal.since().entries.map((e) => [e.kind, e.text])).toEqual([['start', undefined], ['done', 'interrupted']])
    off()
    s.unwatch('remote-1')
    s.turnStarted('api')
    expect(heard).toHaveLength(2)
    expect(pushed).toHaveLength(2)
  })

  it('a listener that throws is logged and the rest still hear; a watcher that throws is dropped', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { s, events } = sensor()
    s.subscribe(() => { throw new Error('listener broke') })
    s.subscribe(() => { throw 'not an error' })
    const after: PairEvent[] = []
    s.subscribe((e) => after.push(e))
    let calls = 0
    s.watch('remote-1', () => { calls++; throw new Error('socket gone') })
    const kept: PairEvent[] = []
    s.watch('remote-2', (e) => { kept.push(e); return true })
    s.turnStarted('api')
    s.turnEnded('api')
    expect(events).toHaveLength(2)
    expect(after).toHaveLength(2)
    expect(kept).toHaveLength(2)
    expect(calls).toBe(1)
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      '[pair] listener failed: listener broke', '[pair] listener failed: not an error',
      '[pair] listener failed: listener broke', '[pair] listener failed: not an error',
    ])
    warn.mockRestore()
  })
})
