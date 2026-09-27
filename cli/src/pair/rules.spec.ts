/**
 * P5 — pair.jsonc and act-within-rules (pair/rules.ts): the file, the rule match, and a rule running end to
 * end through a REAL sensor, journal and owner — it never approves a deny-class prompt, never chooses
 * "don't ask again", approves a permission prompt only when a key could, and every action is journaled
 * and reported.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inProjects, matchRule, PAIR_CONFIG_EXAMPLE, PairConfigFile, pairConfigPath, parseJsonc, parsePairConfig, ruleRunner } from './rules.js'
import { PairJournal } from './journal.js'
import { PairSensor } from './sensor.js'
import { PairOwner, type OwnerSubject } from './owner.js'
import type { Autonomy } from './floor.js'
import type { PairQuestion } from './protocol.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pair-rules-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const question = (patch: Partial<PairQuestion> = {}): PairQuestion => ({
  requestId: 'q1', text: 'Approve Bash command: npm test', options: ['1. Yes', "2. Yes, and don't ask again for: npm *", '3. No'],
  multi: false, deny: false, allow: true, permission: true, since: 0, ...patch,
})

describe('the file', () => {
  it('lives in XDG config, and reads JSON with comments and trailing commas', () => {
    expect(pairConfigPath({}, '/home/me')).toBe('/home/me/.config/harness/pair.jsonc')
    expect(pairConfigPath({ XDG_CONFIG_HOME: '/xdg' }, '/home/me')).toBe('/xdg/harness/pair.jsonc')
    expect(parseJsonc('{ // a comment\n "a": "http://x // not a comment", /* block */ "b": [1, 2,], }')).toEqual({ a: 'http://x // not a comment', b: [1, 2] })
    const example = parsePairConfig(PAIR_CONFIG_EXAMPLE, '/home/me')
    expect(example.error).toBeUndefined()
    expect(example.model).toBe(false)
    expect(example.rules).toEqual([expect.objectContaining({ name: 'tests in api', engine: 'claude', project: '/home/me/code/api', choice: 'Yes' })])
  })

  it('reads a malformed file, or one bad rule, as no rules at all — never half', () => {
    expect(parsePairConfig('{ "rules": [ ').error).toMatch(/not JSON/)
    expect(parsePairConfig('{ "rules": [{ "question": "x" }] }')).toMatchObject({ rules: [], error: expect.stringMatching(/choice/) })
    expect(parsePairConfig('{ "rules": [{ "question": "(", "choice": "Yes" }] }')).toMatchObject({ rules: [], error: expect.stringMatching(/pattern/) })
    expect(parsePairConfig('{ "rules": [{ "question": "x", "choice": "Yes" }, { "question": "y", "choice": "Yes, and don\'t ask again" }] }'))
      .toMatchObject({ rules: [], error: expect.stringMatching(/more than this once/) })
    expect(parsePairConfig('{ "model": true }')).toEqual({ model: true, rules: [], learn: { borrow: false, export: [], agentsMd: [] } })
  })

  it('reads learn: borrow and export are off unless written, and only known destinations count', () => {
    expect(parsePairConfig(PAIR_CONFIG_EXAMPLE, '/home/me').learn).toEqual({ borrow: false, export: [], agentsMd: [] })
    expect(parsePairConfig('{ "learn": { "borrow": true, "export": ["claude", "agents", "hermes", 7] } }').learn)
      .toEqual({ borrow: true, export: ['agents', 'claude'], agentsMd: [] })
    for (const learn of ['"yes"', '[]', '{ "borrow": "true", "export": "claude" }', 'null']) {
      expect(parsePairConfig(`{ "learn": ${learn} }`).learn, learn).toEqual({ borrow: false, export: [], agentsMd: [] })
    }
    expect(parsePairConfig('{ "learn": { "agentsMd": ["~/code/api", "/srv/web/", "", 3, "~/code/api"] } }', '/home/me').learn.agentsMd)
      .toEqual(['/home/me/code/api', '/srv/web'])
    expect(inProjects('/home/me/code/api/sub', ['/home/me/code/api'])).toBe(true)
    expect(inProjects('/home/me/code/apiary', ['/home/me/code/api'])).toBe(false)
    // A malformed file turns learning's opt-ins off too.
    expect(parsePairConfig('{ "learn": { "borrow": true }, "rules": [{ "question": "x" }] }').learn).toEqual({ borrow: false, export: [], agentsMd: [] })
  })

  it('is re-read when it changes, and a missing file is no rules and no model', () => {
    const path = join(dir, 'pair.jsonc')
    const file = new PairConfigFile(path)
    expect(file.get()).toEqual({ model: false, rules: [], learn: { borrow: false, export: [], agentsMd: [] } })
    writeFileSync(path, '{ "model": true }')
    expect(file.get().model).toBe(true)
    writeFileSync(path, '{ "model": false, "rules": [{ "question": "x", "choice": "No" }] }')
    utimesSync(path, new Date(), new Date(Date.now() + 5_000))
    expect(file.get()).toMatchObject({ model: false, rules: [expect.objectContaining({ choice: 'No' })] })
  })
})

describe('a rule', () => {
  const config = (rule: Record<string, unknown>) => parsePairConfig(JSON.stringify({ rules: [rule] }), '/home/me')
  const api = { name: 'api-server', engine: 'claude', cwd: '/home/me/code/api/src' }

  it('matches on harness, engine, project and question', () => {
    const c = config({ harness: 'api*', engine: 'claude', project: '~/code/api', question: 'npm (run )?test', choice: 'Yes' })
    expect(matchRule(c, api, question())).toMatchObject({ option: '1. Yes' })
    expect(matchRule(c, { ...api, name: 'web' }, question())).toBeNull()
    expect(matchRule(c, { ...api, engine: 'codex' }, question())).toBeNull()
    expect(matchRule(c, { ...api, cwd: '/home/me/code/api-old' }, question())).toBeNull()
    expect(matchRule(c, api, question({ text: 'Approve Bash command: ls' }))).toBeNull()
  })

  it('never approves a deny-class prompt, never takes "don\'t ask again", and approves only what a key could', () => {
    const yes = config({ question: '.', choice: 'Yes' })
    expect(matchRule(yes, api, question({ deny: true }))).toBeNull()
    expect(matchRule(config({ question: '.', choice: 'No' }), api, question({ deny: true }))).toBeNull()
    expect(matchRule(config({ question: '.', choice: '2' }), api, question())).toBeNull()
    // Not allow-class (a curl, a push hidden on line two …): no rule touches it, not even to decline.
    expect(matchRule(yes, api, question({ allow: false }))).toBeNull()
    expect(matchRule(config({ question: '.', choice: 'No' }), api, question({ allow: false }))).toBeNull()
    // An allow-class prompt: a rule may approve it once, or decline it.
    expect(matchRule(config({ question: '.', choice: 'No' }), api, question())).toMatchObject({ option: '3. No' })
    // A question the agent asks, or a plan to approve: never answered by a rule.
    expect(matchRule(config({ question: 'package manager', choice: 'pnpm' }), api,
      question({ text: 'Which package manager?', options: ['npm', 'pnpm'], permission: false, allow: false }))).toBeNull()
    expect(matchRule(config({ question: 'plan', choice: 'Yes, manually approve edits' }), api,
      question({ text: 'Claude has written up a plan. Would you like to proceed?', options: ['1. Yes, and use auto mode', '2. Yes, manually approve edits', '3. Tell Claude what to change'], allow: false }))).toBeNull()
  })
})

describe('act-within-rules, end to end on the owning machine', () => {
  const SUBJECTS: Record<string, OwnerSubject> = {
    api: { agentId: 'api', name: 'api', engine: 'claude', status: 'live', untouchable: null, cwd: '/w/api' },
    sh: { agentId: 'sh', name: 'shell', engine: 'terminal', status: 'live', untouchable: 'terminal' },
  }

  function machine(opts: { autonomy?: Autonomy; rules: Array<Record<string, unknown>> }) {
    const journal = new PairJournal({ dir: join(dir, 'journal') })
    const sensor = new PairSensor({
      machineId: () => 'machine-a', journal,
      describe: (id) => SUBJECTS[id] ? { name: SUBJECTS[id].name, engine: SUBJECTS[id].engine, excluded: SUBJECTS[id].untouchable, cwd: SUBJECTS[id].cwd } : null,
    })
    sensor.setPair('tim')
    const keyed: Array<{ agentId: string; option: string }> = []
    const owner = new PairOwner({
      sensor, autonomy: () => opts.autonomy ?? 'act-within-rules',
      subject: (id) => SUBJECTS[id] ?? null, subjects: () => Object.values(SUBJECTS),
      keyAnswer: async ({ agentId, option }) => { keyed.push({ agentId, option }); return { ok: true } },
      message: vi.fn(), cancel: vi.fn(), create: vi.fn(), stop: vi.fn(), resume: vi.fn(), newId: () => 'd',
    })
    const config = parsePairConfig(JSON.stringify({ rules: opts.rules }))
    const events: Array<{ kind?: string; by?: string }> = []
    sensor.subscribe((event) => { if (event.entry) events.push({ kind: event.entry.kind, by: event.entry.by }) })
    const run = ruleRunner({
      active: () => sensor.enabled() && (opts.autonomy ?? 'act-within-rules') === 'act-within-rules',
      config: () => config,
      question: (id) => sensor.harness(id)?.question ?? null,
      subject: (id) => SUBJECTS[id] ? { name: SUBJECTS[id].name, engine: SUBJECTS[id].engine, cwd: SUBJECTS[id].cwd } : null,
      answer: (input, by, why) => owner.answer(input, by, why),
    })
    const ask = (agentId: string, requestId: string, q: string, dialog: string, options = ['1. Yes', '2. No']) => {
      sensor.question(agentId, requestId, [{ key: q, q, options, multi: false }], { permission: true, dialog })
      return run(agentId, requestId)
    }
    const acts = () => journal.since().entries.filter((e) => e.kind === 'act')
    return { sensor, owner, keyed, ask, acts, events, run }
  }
  // Painted with no description line: a one-line block is read with certainty (pair/classify.ts).
  const bash = (cmd: string) => `Bash command\n\n  ${cmd}\n\nDo you want to proceed?\n1. Yes\n2. No`

  it('answers an allow-class prompt by rule, journals it as the rule\'s, and pushes it for the brain to report', async () => {
    const m = machine({ rules: [{ name: 'tests', question: 'npm test', choice: 'Yes' }] })
    expect(await m.ask('api', 'q1', 'Approve Bash command: npm test', bash('npm test'))).toEqual({ rule: 'tests', option: '1. Yes', ok: true })
    expect(m.keyed).toEqual([{ agentId: 'api', option: '1. Yes' }])
    expect(m.acts()).toEqual([expect.objectContaining({ by: 'rule', action: 'answer', requestId: 'q1',
      text: 'answered "1. Yes" to "Approve Bash command: npm test" (rule "tests")' })])
    expect(m.events).toContainEqual({ kind: 'act', by: 'rule' })
  })

  it('never approves a deny-class prompt, even when the push is on the second line and the rule matches the first', async () => {
    const m = machine({ rules: [{ name: 'anything npm', question: 'npm', choice: 'Yes' }] })
    expect(await m.ask('api', 'q1', 'Approve Bash command: npm test &&', 'Bash command\n\n  npm test &&\n  git push origin main\n  Test and push\n\n1. Yes\n2. No')).toBeNull()
    expect(await m.ask('api', 'q2', 'Approve Bash command: npm publish', bash('npm publish'))).toBeNull()
    expect(await m.ask('api', 'q3', 'Approve Bash command: sudo npm i -g x', bash('sudo npm i -g x'))).toBeNull()
    expect(m.keyed).toEqual([])
    expect(m.acts()).toEqual([])
  })

  it('never approves what a key could not (a curl), never touches a terminal, and does nothing off the dial', async () => {
    const m = machine({ rules: [{ question: '.', choice: 'Yes' }] })
    expect(await m.ask('api', 'q1', 'Approve Bash command: curl -s https://x', bash('curl -s https://x'))).toBeNull()
    expect(await m.ask('sh', 'q2', 'Approve Bash command: npm test', bash('npm test'))).toBeNull()   // not even watched
    const off = machine({ autonomy: 'act-on-key', rules: [{ question: '.', choice: 'Yes' }] })
    expect(await off.ask('api', 'q3', 'Approve Bash command: npm test', bash('npm test'))).toBeNull()
    expect([...m.keyed, ...off.keyed]).toEqual([])
  })

  it('every action it takes is journaled — and a refusal types and journals nothing', async () => {
    const m = machine({ rules: [{ name: 'tests', question: 'npm test', choice: 'Yes' }, { name: 'no lint', question: 'npm run lint', choice: 'No' }, { name: 'no curls', question: 'curl', choice: 'No' }] })
    await m.ask('api', 'q1', 'Approve Bash command: npm test', bash('npm test'))
    m.sensor.questionGone('api', 'q1')
    await m.ask('api', 'q2', 'Approve Bash command: npm run lint', bash('npm run lint'))
    m.sensor.questionGone('api', 'q2')
    // Not allow-class: no rule answers it at all, not even the decline it names.
    expect(await m.ask('api', 'q4', 'Approve Bash command: curl -s https://x', bash('curl -s https://x'))).toBeNull()
    m.sensor.questionGone('api', 'q4')
    // A stale id: the dialog moved on before the rule ran.
    m.sensor.question('api', 'q3', [{ key: 'x', q: 'Approve Bash command: npm test', options: ['1. Yes', '2. No'], multi: false }], { permission: true, dialog: bash('npm test') })
    expect(await m.run('api', 'q-old')).toBeNull()
    expect(m.keyed.map((k) => k.option)).toEqual(['1. Yes', '2. No'])
    expect(m.acts().map((e) => [e.requestId, e.by, e.text])).toEqual([
      ['q1', 'rule', 'answered "1. Yes" to "Approve Bash command: npm test" (rule "tests")'],
      ['q2', 'rule', 'answered "2. No" to "Approve Bash command: npm run lint" (rule "no lint")'],
    ])
  })
})
