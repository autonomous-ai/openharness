/**
 * P1 — the PairSensor and its journal (daemons/BRAIN.md).
 *
 * No model, no transport: a fake clock, a temp journal directory and the three inputs the daemon feeds
 * it (turns, questions, recaps). What is pinned here is what must never be reported as news, and what
 * the journal promises a reader that was not watching.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PairJournal } from './journal.js'
import { PairSensor, type PairSubject } from './sensor.js'
import { isDenyClass, type PairEvent } from './protocol.js'

let dir: string
let clock: number
const now = (): number => clock

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pair-sensor-'))
  clock = 1_000_000
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const SUBJECTS: Record<string, PairSubject> = {
  api: { name: 'api', engine: 'claude' },
  web: { name: 'web', engine: 'codex' },
  shell: { name: 'shell', engine: 'terminal', excluded: 'terminal' },
  pair: { name: 'pair', engine: 'claude', excluded: 'pair' },
}

function sensor(opts: { max?: number; on?: boolean } = {}) {
  const journal = new PairJournal({ dir, max: opts.max, newEpoch: () => `epoch-${clock}` })
  const s = new PairSensor({ machineId: () => 'machine-a', journal, describe: (id) => SUBJECTS[id] ?? null, now })
  const events: PairEvent[] = []
  s.subscribe((event) => events.push(event))
  if (opts.on !== false) s.setPair('tim')
  return { s, journal, events }
}

const ask = (q: string, options = ['Yes', 'No']) => [{ key: q, q, options, multi: false }]

describe('PairSensor', () => {
  it('records nothing while pairing is off, and forgets everything when it goes off', () => {
    const { s, journal, events } = sensor({ on: false })
    s.turnStarted('api')
    s.question('api', 'q_1', ask('Run the migration?'))
    expect(events).toEqual([])
    expect(journal.seq).toBe(0)
    expect(s.local({ verb: 'list' })).resolves.toEqual({ error: 'PAIR_OFF' })
    s.setPair('tim')
    s.turnStarted('api')
    expect(s.snapshot().harnesses).toHaveLength(1)
    s.setPair(null)
    expect(s.enabled()).toBe(false)
    expect(s.snapshot().harnesses).toEqual([])
  })

  it('journals a live turn, question, answer and recap in order, with the machine and epoch', () => {
    const { s, events } = sensor()
    s.turnStarted('api')
    clock += 1_000
    s.question('api', 'q_1', ask('Run the migration?'))
    s.questionGone('api', 'q_1')
    s.turnEnded('api')
    s.recap('api', 'Ran the migration. 3 tables.')
    const entries = events.map((e) => e.entry)
    expect(entries.map((e) => e?.kind)).toEqual(['start', 'question', 'answered', 'done', 'recap'])
    expect(entries.map((e) => e?.seq)).toEqual([1, 2, 3, 4, 5])
    expect(entries[1]).toMatchObject({ epoch: 'epoch-1000000', agentId: 'api', name: 'api', engine: 'claude', requestId: 'q_1',
      text: 'Run the migration?', options: ['Yes', 'No'], deny: false, at: 1_001_000 })
    expect(events.every((e) => e.machineId === 'machine-a' && !e.baseline)).toBe(true)
    expect(s.snapshot().harnesses[0]).toMatchObject({ working: false, question: null, recap: 'Ran the migration. 3 tables.' })
  })

  it('replays are baselines: the state moves, nothing is journaled, and the event says so', () => {
    const { s, journal, events } = sensor()
    s.turnStarted('api', { replay: true })
    s.turnEnded('api', { replay: true })
    expect(journal.seq).toBe(0)
    expect(events.map((e) => [e.baseline, e.entry])).toEqual([[true, undefined], [true, undefined]])
    expect(events[0].harness?.working).toBe(true)
    expect(events[1].harness?.working).toBe(false)
  })

  it('a question already open before the daemon restarted is a baseline, and its close is still journaled', () => {
    const first = sensor()
    first.s.turnStarted('api')
    first.s.question('api', 'q_open', ask('Allow the edit?'))
    // The daemon restarts (a new sensor over the same journal) and the watcher re-announces the dialog.
    const { s, journal, events } = sensor()
    expect(journal.epoch).toBe('epoch-1000000')
    s.turnStarted('api', { replay: true })
    s.question('api', 'q_open', ask('Allow the edit?'))
    expect(events.map((e) => [e.baseline === true, e.entry?.kind])).toEqual([[true, undefined], [true, undefined]])
    expect(s.snapshot().harnesses[0].question?.requestId).toBe('q_open')
    s.questionGone('api', 'q_open')
    expect(events.at(-1)?.entry).toMatchObject({ kind: 'answered', requestId: 'q_open', seq: 3 })
  })

  it('a re-announced question (same requestId) is not asked twice', () => {
    const { s, events } = sensor()
    s.question('api', 'q_1', ask('Run it?'))
    s.question('api', 'q_1', ask('Run it?'))
    expect(events.filter((e) => e.entry?.kind === 'question')).toHaveLength(1)
  })

  it('excludes sub-agents, terminals and the pair harness itself', () => {
    const { s, journal, events } = sensor()
    s.turnStarted('api', { subagent: true })
    s.turnEnded('api', { subagent: true })
    for (const id of ['shell', 'pair']) {
      s.turnStarted(id)
      s.question(id, `q_${id}`, ask('Continue?'))
      s.recap(id, 'did things')
      s.turnEnded(id)
    }
    s.turnStarted('nobody')
    expect(events).toEqual([])
    expect(journal.seq).toBe(0)
    expect(s.snapshot().harnesses).toEqual([])
  })

  it('a harness that turns into a terminal is removed rather than left standing', () => {
    const subjects = { ...SUBJECTS }
    const journal = new PairJournal({ dir })
    const s = new PairSensor({ machineId: () => 'm', journal, describe: (id) => subjects[id] ?? null, now })
    s.setPair('tim')
    s.turnStarted('api')
    subjects.api = { name: 'api', engine: 'terminal', excluded: 'terminal' }
    const events: PairEvent[] = []
    s.subscribe((e) => events.push(e))
    s.turnEnded('api')
    expect(events).toEqual([{ machineId: 'm', rev: 2, agentId: 'api', harness: null, removed: true }])
  })

  it('closes each turn once though two sources report it, and records why a harness failed once per reason', () => {
    const { s, events } = sensor()
    s.turnStarted('api')
    s.turnEnded('api')
    s.turnEnded('api')
    s.failed('web', 'RESUME_SESSION_MISMATCH')
    s.failed('web', 'RESUME_SESSION_MISMATCH')
    expect(events.map((e) => e.entry?.kind)).toEqual(['start', 'done', 'fail'])
    s.turnStarted('web')
    expect(s.snapshot().harnesses.find((h) => h.agentId === 'web')?.failing).toBeNull()
  })

  it('marks deny-class questions on the machine that owns them', () => {
    const { s } = sensor()
    s.question('api', 'q_push', ask('Bash: git push --force origin main'))
    s.question('web', 'q_ls', ask('Bash: ls -la'))
    const byId = Object.fromEntries(s.snapshot().harnesses.map((h) => [h.agentId, h.question?.deny]))
    expect(byId).toEqual({ api: true, web: false })
  })

  it('reads allow-class from the transcript\'s tool call when the painted block is not certain', () => {
    const { s } = sensor()
    SUBJECTS.cwd = { name: 'cwd', engine: 'claude', cwd: dir }
    const painted = 'Bash command\n\n  npm test\n  Run the test suite\n\n Do you want to proceed?\n ❯ 1. Yes\n   3. No'
    s.question('cwd', 'q_1', ask('Approve Bash command: npm test'), { permission: true, dialog: painted })
    expect(s.harness('cwd')?.question?.allow).toBe(false)
    s.questionGone('cwd', 'q_1')
    s.question('cwd', 'q_2', ask('Approve Bash command: npm test'), { permission: true, dialog: painted,
      tools: [{ name: 'Bash', input: { command: 'npm test', description: 'Run the test suite' } }] })
    expect(s.harness('cwd')?.question?.allow).toBe(true)
    delete SUBJECTS.cwd
  })

  it('takes secrets out of every journal line, and out of a page on its way to another machine', () => {
    const { s, journal } = sensor()
    const token = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'
    s.question('api', 'q_1', ask(`Bash: curl -H "Authorization: Bearer ${token}" https://x`, ['Yes', `No, use ${token}`]))
    s.recap('api', `set API_KEY=${token} and ran it`)
    s.acted({ agentId: 'api', name: 'api', engine: 'claude' }, { by: 'key', action: 'send', text: `sent "password=hunter2hunter2"` })
    const written = readFileSync(journal.path, 'utf8')
    expect(written).not.toContain(token)
    expect(written).not.toContain('hunter2hunter2')
    expect(written).toContain('[redacted]')
    // What the window shows the person is the dialog as it is: only the journal is redacted.
    expect(s.harness('api')?.question?.text).toContain(token)
    // A line written before redaction existed still leaves redacted.
    writeFileSync(journal.path, `${written}${JSON.stringify({ epoch: journal.epoch, seq: 99, at: clock, kind: 'recap', agentId: 'api', name: 'api', engine: 'claude', text: `token=${token}` })}\n`)
    const page = new PairSensor({ machineId: () => 'machine-a', journal: new PairJournal({ dir }), describe: (id) => SUBJECTS[id] ?? null, now }).journal({})
    expect(JSON.stringify(page)).not.toContain(token)
  })

  it('pushes to a remote watcher until its push says it is gone', () => {
    const { s } = sensor()
    const got: PairEvent[] = []
    let alive = true
    const snapshot = s.watch('peer-1', (e) => { got.push(e); return alive })
    expect(snapshot).toMatchObject({ machineId: 'machine-a', epoch: 'epoch-1000000', seq: 0, rev: 0, harnesses: [] })
    s.turnStarted('api')
    alive = false
    s.turnEnded('api')
    s.recap('api', 'shipped')
    expect(got.map((e) => e.entry?.kind)).toEqual(['start', 'done'])
    expect(got.map((e) => e.rev)).toEqual([1, 2])
  })

  it('answers the local `pair` verbs', async () => {
    const { s } = sensor()
    s.turnStarted('api')
    expect(await s.local({ verb: 'status' })).toEqual({ on: true, pair: 'tim', machineId: 'machine-a', epoch: 'epoch-1000000', seq: 1 })
    expect(await s.local({ verb: 'list' })).toMatchObject({ snapshot: { harnesses: [{ agentId: 'api', working: true }] } })
    expect(await s.local({ verb: 'read', agentId: 'api' })).toMatchObject({ harness: { agentId: 'api' } })
    expect(await s.local({ verb: 'read', agentId: 'ghost' })).toEqual({ error: 'NOT_FOUND' })
    expect(await s.local({ verb: 'journal', epoch: 'epoch-1000000', seq: 0 })).toMatchObject({ entries: [{ kind: 'start' }] })
    expect(await s.local({ verb: 'rm' })).toMatchObject({ error: 'UNKNOWN_VERB' })
  })
})

describe('PairJournal', () => {
  it('is a 0600 ring: old entries fall off, seq keeps counting, the epoch stays', () => {
    const journal = new PairJournal({ dir, max: 10, newEpoch: () => 'e1' })
    for (let i = 0; i < 30; i++) journal.append({ at: i, kind: 'start', agentId: 'a', name: 'a', engine: 'claude' })
    expect(statSync(journal.path).mode & 0o777).toBe(0o600)
    const lines = readFileSync(journal.path, 'utf8').trim().split('\n')
    expect(lines.length).toBeLessThanOrEqual(13)
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ epoch: 'e1', seq: 30 })
    // Reopened (a daemon restart): the same epoch, and seq carries on rather than starting over.
    const reopened = new PairJournal({ dir, max: 10, newEpoch: () => 'e2' })
    expect([reopened.epoch, reopened.seq]).toEqual(['e1', 30])
    expect(reopened.append({ at: 99, kind: 'done', agentId: 'a', name: 'a', engine: 'claude' }).seq).toBe(31)
  })

  it('reads on from a cursor, says when the ring dropped unread entries, and resets a cursor from another epoch', () => {
    const journal = new PairJournal({ dir, max: 10, newEpoch: () => 'e1' })
    for (let i = 1; i <= 5; i++) journal.append({ at: i * 100, kind: 'start', agentId: 'a', name: 'a', engine: 'claude' })
    expect(journal.since({ epoch: 'e1', seq: 3 }).entries.map((e) => e.seq)).toEqual([4, 5])
    expect(journal.since({ epoch: 'e1', seq: 3 }).truncated).toBeUndefined()
    expect(journal.since({ at: 400 }).entries.map((e) => e.seq)).toEqual([4, 5])
    expect(journal.since({ epoch: 'old', seq: 99 })).toMatchObject({ reset: true, epoch: 'e1', seq: 5 })
    for (let i = 6; i <= 20; i++) journal.append({ at: i * 100, kind: 'start', agentId: 'a', name: 'a', engine: 'claude' })
    const behind = journal.since({ epoch: 'e1', seq: 2 })
    expect(behind.truncated).toBe(true)
    expect(behind.entries[0].seq).toBeGreaterThan(3)
    expect(journal.since({ epoch: 'e1', seq: 2, limit: 3 }).entries).toHaveLength(3)
  })

  it('starts a new epoch over a file it cannot read, and skips a torn last line', () => {
    writeFileSync(join(dir, 'journal.jsonl'), 'not json\n{"half":')
    const journal = new PairJournal({ dir, newEpoch: () => 'fresh' })
    expect([journal.epoch, journal.seq]).toEqual(['fresh', 0])
    journal.append({ at: 1, kind: 'start', agentId: 'a', name: 'a', engine: 'claude' })
    writeFileSync(journal.path, `${readFileSync(journal.path, 'utf8')}{"epoch":"fresh","seq":2,`)
    const reopened = new PairJournal({ dir, newEpoch: () => 'other' })
    expect([reopened.epoch, reopened.seq]).toEqual(['fresh', 1])
  })

  it('knows which questions were left open', () => {
    const journal = new PairJournal({ dir })
    journal.append({ at: 1, kind: 'question', requestId: 'q1', agentId: 'a', name: 'a', engine: 'claude' })
    journal.append({ at: 2, kind: 'question', requestId: 'q2', agentId: 'a', name: 'a', engine: 'claude' })
    journal.append({ at: 3, kind: 'answered', requestId: 'q1', agentId: 'a', name: 'a', engine: 'claude' })
    expect([...journal.openQuestions().keys()]).toEqual(['q2'])
  })
})

describe('deny class', () => {
  it.each([
    'Bash: git push origin main',
    'Bash: git push --force-with-lease',
    'Bash: rm -rf node_modules dist',
    'Bash: rm -fr /tmp/x',
    'Run `npm publish`?',
    'Deploy to production?',
    'Bash: psql -c "DROP TABLE users"',
    'Merge PR #42 into main?',
    'Bash: git reset --force',
  ])('%s', (q) => expect(isDenyClass(q)).toBe(true))

  it.each([
    'Bash: ls -la',
    'Edit the dropdown component?',
    'Bash: npm test',
    'Read src/auth.ts?',
    'Bash: rm build.log',
  ])('not %s', (q) => expect(isDenyClass(q)).toBe(false))

  it('reads the options too', () => {
    expect(isDenyClass('Pick one', ['Run tests', 'Push to origin'])).toBe(true)
  })
})
