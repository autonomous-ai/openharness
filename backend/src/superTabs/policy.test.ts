import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor, type AgentConfiguration } from './model.js'
import { RULE_MESSAGE_MS } from './rules.js'
import { MAX_RULES_BYTES, projectRulesSchema, rulesDiff, rulesEqual, SEED_RULES, type ProjectRules } from './policy.js'

const copy = (): ProjectRules => structuredClone(SEED_RULES)
const refused = (value: unknown) => projectRulesSchema.safeParse(value).success === false

describe('the project rules record', () => {
  // Task #3393 (anh Dee's Swarm redesign, 11-05): the numbers the project runs on today, in project data, not constants.
  it('seeds today\'s numbers', () => {
    expect(projectRulesSchema.parse(SEED_RULES)).toEqual(SEED_RULES)
    expect(SEED_RULES.releaseWindow).toEqual({ start: '09:00', end: '18:00', timeZone: 'Asia/Ho_Chi_Minh' })
    // The backend stays off the morning peak (Shipper, #3405).
    expect(SEED_RULES.releasePace).toEqual({ backendEveryMinutes: 120, appsAfterVisibleBatch: true, backendPause: { start: '09:00', end: '10:00' } })
    expect(SEED_RULES.reviews.defaultReads).toBe(1)
    expect(SEED_RULES.reviews.rows.map(r => [r.area, r.reads])).toEqual(['Sign-in', 'Tokens', 'Encryption', 'Access', 'Buddy guard', 'Device links', 'Deletion']
      .map(area => [area, 2]))
    // Every security row has its paths, so a change there is counted (#3401, #3402: fail closed).
    for (const row of SEED_RULES.reviews.rows) expect(row.paths.length).toBeGreaterThan(0)
    expect(SEED_RULES.reviews.test.map(t => t.where)).toEqual(['Desktop on a Mac', 'The CLI on a Mac and on a Linux machine',
      'The phone app in a simulator', 'The web in a browser', 'Install and update on a Mac', 'Firmware on the device plugged into a machine'])
    // The merge train is opt-in per project (River, #3402).
    expect(SEED_RULES.mergeTrain).toEqual({ enabled: false, everyMinutes: 10 })
    expect(SEED_RULES).toMatchObject({ caps: [], paths: [], crew: [] })
  })

  it('seeds the current dispatch lanes and numbers and accepts project replacements', () => {
    const seed = projectRulesSchema.parse(SEED_RULES)
    expect(seed.lanes).toEqual([
      { name: 'backend', owns: ['backend/'] }, { name: 'CLI', owns: ['cli/'] },
      { name: 'Desktop', owns: ['desktop/'] }, { name: 'mobile', owns: ['mobile/'] }, { name: 'docs', owns: ['docs/'] },
    ])
    expect(seed.dispatch).toEqual({ everyMs: 30_000, maxHanded: 3, nudgeAfterMs: 7_200_000, returnAfterMs: 10_800_000 })
    const custom = { ...copy(), lanes: [{ name: 'firmware', owns: ['devices/'] }],
      dispatch: { everyMs: 60_000, maxHanded: 1, nudgeAfterMs: 60_000, returnAfterMs: 120_000 } }
    expect(projectRulesSchema.parse(custom)).toEqual(custom)
  })

  it('normalizes legacy empty lanes but preserves a new deliberately empty list', () => {
    const { dispatch: _old, ...legacy } = copy()
    expect(projectRulesSchema.parse({ ...legacy, lanes: [] }).lanes.map(l => l.name)).toEqual(['backend', 'CLI', 'Desktop', 'mobile', 'docs'])
    expect(projectRulesSchema.parse({ ...copy(), lanes: [] }).lanes).toEqual([])
    const custom = projectRulesSchema.parse({ ...legacy, lanes: [{ name: 'firmware', owns: ['devices/'] }] })
    expect(custom.lanes).toEqual([{ name: 'firmware', owns: ['devices/'] }])
    expect(custom.dispatch).toEqual({ everyMs: 30_000, maxHanded: 3, nudgeAfterMs: 7_200_000, returnAfterMs: 10_800_000 })
  })

  it('refuses unsafe dispatch bounds and ambiguous lane names', () => {
    for (const dispatch of [
      { everyMs: 29_999 }, { everyMs: 3_600_001 }, { maxHanded: 0 }, { maxHanded: 1001 },
      { maxHanded: 1.5 }, { nudgeAfterMs: 59_999 }, { nudgeAfterMs: 604_800_001 },
      { returnAfterMs: 1_209_600_001 }, { nudgeAfterMs: 120_000, returnAfterMs: 120_000 },
    ]) expect(refused({ ...copy(), dispatch: { ...copy().dispatch, ...dispatch } }), JSON.stringify(dispatch)).toBe(true)
    expect(refused({ ...copy(), lanes: [{ name: 'firmware', owns: [] }, { name: 'Firmware', owns: [] }] })).toBe(true)
    expect(refused({ ...copy(), lanes: [{ name: '', owns: [] }] })).toBe(true)
  })

  it('holds caps, paths, the crew and lanes', () => {
    const rules = { ...copy(), caps: [{ name: 'Agents on the phone Mac', value: 4 }], paths: [{ name: 'Plans', path: 'docs/plans/' }],
      crew: [{ role: 'Engineer', names: ['Ledger'] }], lanes: [{ name: 'Backend', owns: ['backend/'] }] }
    expect(projectRulesSchema.parse(rules)).toEqual(rules)
  })

  it('accepts optional approval authority with explicit linked account IDs and rejects ambiguous links', () => {
    const authority = { topDeciderId: 'dee-id', people: [{ name: 'Ken', accountIds: ['ken-id', 'other-ken-id'] }] }
    expect(projectRulesSchema.parse({ ...copy(), instructionApprovals: authority })).toMatchObject({ instructionApprovals: authority })
    expect(projectRulesSchema.parse({ ...copy(), instructionApprovals: null })).toMatchObject({ instructionApprovals: null })
    expect(projectRulesSchema.parse(copy())).not.toHaveProperty('instructionApprovals')
    const bad = [
      { ...authority, people: [{ name: 'Ken', accountIds: [] }] },
      { ...authority, people: [{ name: 'Ken', accountIds: ['a', 'a'] }] },
      { ...authority, people: [{ name: 'Ken', accountIds: ['a'] }, { name: 'KEN', accountIds: ['b'] }] },
      { ...authority, people: [{ name: 'Ken', accountIds: ['a'] }, { name: 'Other', accountIds: ['a'] }] },
      { ...authority, people: [{ name: 'Ken', accountIds: Array.from({ length: 11 }, (_, i) => `a${i}`) }] },
      { ...authority, people: Array.from({ length: 51 }, (_, i) => ({ name: `Person ${i}`, accountIds: [`a${i}`] })) },
    ]
    for (const instructionApprovals of bad) expect(projectRulesSchema.safeParse({ ...copy(), instructionApprovals }).success).toBe(false)
  })

  it('refuses bad values', () => {
    expect(refused({ ...copy(), extra: 1 })).toBe(true)
    expect(refused({ ...copy(), releaseWindow: { ...SEED_RULES.releaseWindow, start: '25:00' } })).toBe(true)
    expect(refused({ ...copy(), releaseWindow: { ...SEED_RULES.releaseWindow, start: '18:00', end: '09:00' } })).toBe(true)
    expect(refused({ ...copy(), releaseWindow: { ...SEED_RULES.releaseWindow, timeZone: 'Mars/Base' } })).toBe(true)
    expect(refused({ ...copy(), releasePace: { ...SEED_RULES.releasePace, backendEveryMinutes: 0 } })).toBe(true)
    expect(refused({ ...copy(), releasePace: { ...SEED_RULES.releasePace, backendEveryMinutes: 1.5 } })).toBe(true)
    expect(refused({ ...copy(), releasePace: { ...SEED_RULES.releasePace, backendPause: { start: '10:00', end: '09:00' } } })).toBe(true)
    expect(refused({ ...copy(), releasePace: { ...SEED_RULES.releasePace, backendPause: { start: '9:00', end: '10:00' } } })).toBe(true)
    expect(projectRulesSchema.safeParse({ ...copy(), releasePace: { ...SEED_RULES.releasePace, backendPause: null } }).success).toBe(true)
    expect(refused({ ...copy(), reviews: { ...SEED_RULES.reviews, defaultReads: 0 } })).toBe(true)
    expect(refused({ ...copy(), reviews: { ...SEED_RULES.reviews, rows: [{ area: '', reads: 2, paths: ['**/*auth*'] }] } })).toBe(true)
    expect(refused({ ...copy(), reviews: { ...SEED_RULES.reviews, rows: [{ area: 'Tokens', reads: 2, paths: [] }, { area: 'tokens', reads: 1, paths: [] }] } })).toBe(true)
    // A glob is a relative path pattern: never absolute, never climbing out, at most 50 a row.
    for (const glob of ['/etc/**', '../**', 'a/../b', '']) {
      expect(refused({ ...copy(), reviews: { ...SEED_RULES.reviews, rows: [{ area: 'Tokens', reads: 2, paths: [glob] }] } })).toBe(true)
    }
    expect(refused({ ...copy(), reviews: { ...SEED_RULES.reviews, rows: [{ area: 'Tokens', reads: 2, paths: Array.from({ length: 51 }, (_, i) => `a${i}/**`) }] } })).toBe(true)
    // Security review of #3216: at most 4 wildcards a pattern, a double star counting as one, and no run of three stars.
    const pattern = (glob: string) => refused({ ...copy(), reviews: { ...SEED_RULES.reviews, rows: [{ area: 'Tokens', reads: 2, paths: [glob] }] } })
    for (const glob of ['*a*a*a*a*a', '**/'.repeat(5) + 'z', '**/**/**/**/*.ts', 'a???b??', '***.ts', '*'.repeat(200)]) {
      expect(pattern(glob), glob).toBe(true)
    }
    for (const glob of ['**/*buddy_guard*', '**/*.test.*', 'a/**/b/*.ts', '**/?x*']) expect(pattern(glob), glob).toBe(false)
    // The backend pause is a part of the release window (review of #3216).
    expect(refused({ ...copy(), releasePace: { ...SEED_RULES.releasePace, backendPause: { start: '08:00', end: '10:00' } } })).toBe(true)
    expect(refused({ ...copy(), releasePace: { ...SEED_RULES.releasePace, backendPause: { start: '17:00', end: '19:00' } } })).toBe(true)
    expect(refused({ ...copy(), releasePace: { ...SEED_RULES.releasePace, backendPause: { start: '09:00', end: '18:00' } } })).toBe(false)
    expect(refused({ ...copy(), reviews: { ...SEED_RULES.reviews, test: [{ where: 'Mac', paths: ['desktop/**'] }, { where: 'mac', paths: [] }] } })).toBe(true)
    expect(refused({ ...copy(), mergeTrain: { enabled: 'yes', everyMinutes: 30 } })).toBe(true)
    expect(refused({ ...copy(), caps: Array.from({ length: 51 }, (_, i) => ({ name: `Cap ${i}`, value: i })) })).toBe(true)
    expect(refused({ ...copy(), caps: [{ name: 'Agents', value: -1 }] })).toBe(true)
    expect(refused({ ...copy(), paths: [{ name: 'Plans', path: 'docs/\nplans/' }] })).toBe(true)
    const { mergeTrain: _gone, ...missing } = copy()
    expect(refused(missing)).toBe(true)
    // At most 8 KB as stored: within every list's own limits, still too big together.
    const big = { ...copy(), crew: Array.from({ length: 50 }, (_, i) => ({ role: `Role ${i}`, names: Array.from({ length: 5 }, (_, j) => `${'n'.repeat(60)}${j}`) })) }
    expect(Buffer.byteLength(JSON.stringify(big))).toBeGreaterThan(MAX_RULES_BYTES)
    expect(refused(big)).toBe(true)
  })

  it('lists what changed, by path, and nothing for an equal record', () => {
    const after = copy()
    after.releaseWindow.start = '10:00'
    after.reviews.rows = [...after.reviews.rows, { area: 'Payments', reads: 2, paths: ['**/payments/**'] }]
    after.mergeTrain.enabled = true
    expect(rulesDiff(SEED_RULES, after)).toEqual([
      { path: 'releaseWindow.start', before: '09:00', after: '10:00' },
      { path: 'reviews.rows', before: SEED_RULES.reviews.rows, after: after.reviews.rows },
      { path: 'mergeTrain.enabled', before: false, after: true },
    ])
    expect(rulesDiff(SEED_RULES, copy())).toEqual([])
    expect(rulesEqual(SEED_RULES, copy())).toBe(true)
    expect(rulesEqual(SEED_RULES, after)).toBe(false)
  })
})

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const config: AgentConfiguration = { engine: 'codex', model: 'test-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
const NOW = 5 * RULE_MESSAGE_MS

function fixture() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: NOW, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const invite = (role: 'viewer' | 'collaborator' = 'collaborator') => {
    const invited = run({ type: 'invite.create', email: peer.email, role, conversationId: 'lead' })
    run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, peer)
  }
  const add = (harnessId: string, group = 'lead', lead = false) =>
    run({ type: 'agent.add', conversationId: group, machineId: 'host', harnessId, name: harnessId, configuration: config, lead }, owner,
      { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }).result.agentId as string
  const group = () => run({ type: 'conversation.create', title: 'Offline editing', brief: 'Save edits while offline.', checks: [] }).result.conversationId as string
  return { run, invite, add, group, get state() { return state } }
}

// An earlier start keeps the seed's 09:00-10:00 backend pause inside the window.
const later = (): ProjectRules => ({ ...copy(), releaseWindow: { ...SEED_RULES.releaseWindow, start: '08:00' } })
const set = (baseRevision: number, rules: ProjectRules, extra: Partial<Extract<Command, { type: 'rules.set' }>> = {}): Command =>
  ({ type: 'rules.set', projectId: 'lead', baseRevision, rules, summary: 'Releases start at 10', ...extra })
const code = (run: () => unknown): unknown => { try { run() } catch (error) { return (error as { code?: string }).code ?? 'INVALID' } return undefined }

describe('rules.set', () => {
  it('validates, versions and records who, when, the diff and why, and changes no state or chat', () => {
    const f = fixture()
    const before = structuredClone(f.state.projects)
    const effects = f.run(set(0, later()), owner, { projectRules: null })
    expect(effects.result).toMatchObject({ projectId: 'lead', revision: 1 })
    expect(effects.projectRules).toEqual({ projectId: 'lead', revision: 1, rules: later(), summary: 'Releases start at 10',
      diff: [{ path: 'releaseWindow.start', before: '09:00', after: '08:00' }],
      writtenBy: { kind: 'person', id: 'owner' }, askedBy: 'owner', askedIn: null, at: NOW })
    expect(effects.messages).toEqual([])
    expect(f.state.projects).toEqual(before)
    // The next revision diffs against the stored one, not the seed.
    const next = { ...later(), mergeTrain: { enabled: true, everyMinutes: 10 } }
    const second = f.run(set(1, next, { summary: 'Merge train on' }), owner, { projectRules: { revision: 1, rules: later() } })
    expect(second.projectRules).toMatchObject({ revision: 2, diff: [{ path: 'mergeTrain.enabled', before: false, after: true }], summary: 'Merge train on' })
  })

  it('refuses bad values and a summary that is not one line, storing nothing', () => {
    const f = fixture()
    expect(code(() => f.run(set(0, { ...copy(), releasePace: { ...SEED_RULES.releasePace, backendEveryMinutes: -5 } }), owner, { projectRules: null }))).toBe('INVALID')
    expect(code(() => f.run(set(0, { ...copy(), surprise: true } as ProjectRules), owner, { projectRules: null }))).toBe('INVALID')
    expect(code(() => f.run(set(0, later(), { summary: 'two\nlines' }), owner, { projectRules: null }))).toBe('INVALID')
  })

  it('refuses a save on an older revision with the current record to merge, and saves nothing for the same record', () => {
    const f = fixture()
    let refused: unknown
    try { f.run(set(0, later()), owner, { projectRules: { revision: 3, rules: later() } }) } catch (error) { refused = error }
    expect(refused).toMatchObject({ code: 'RULES_STALE', status: 409, details: { revision: 3, rules: later() } })
    expect((refused as Error).message).toContain('revision 3')
    // The record could not be read: nothing is saved over what nobody saw.
    expect(code(() => f.run(set(0, later())))).toBe('RULES_UNAVAILABLE')
    const same = f.run(set(3, later()), owner, { projectRules: { revision: 3, rules: later() } })
    expect(same.result).toMatchObject({ projectId: 'lead', revision: 3, unchanged: true })
    expect(same.projectRules).toBeUndefined()
    const seed = f.run(set(0, copy()), owner, { projectRules: null })
    expect(seed.result).toMatchObject({ revision: 0, unchanged: true })
    expect(seed.projectRules).toBeUndefined()
  })
})

describe('who changes the rules', () => {
  const asked = (conversationId: string, messageId = 'ask-1') => ({ askedIn: { conversationId, messageId } })
  const author = (kind: 'person' | 'agent', id: string) => ({ kind, id, name: id, membershipGeneration: 'tab' })
  const personAsked = (id = 'peer', createdAt = NOW - 60_000) => ({ author: author('person', id), source: false, createdAt })

  it('lets a person who may write the project change them, never a viewer', () => {
    const f = fixture()
    f.invite()
    expect(f.run(set(0, later()), peer, { projectRules: null }).projectRules).toMatchObject({ writtenBy: { kind: 'person', id: 'peer' }, askedBy: 'peer' })
    const viewer = fixture()
    viewer.invite('viewer')
    expect(code(() => viewer.run(set(0, later()), peer, { projectRules: null }))).toBe('READ_ONLY')
  })

  it('lets the project\'s PM change them only with a person\'s own chat message of this project from the last day', () => {
    const f = fixture()
    f.invite()
    const lead = f.add('lead', 'lead', true), task = f.group()
    const pm = (extra: Partial<Extract<Command, { type: 'rules.set' }>>, context: Partial<CommandContext>) =>
      () => f.run(set(0, later(), extra), as(lead), { projectRules: null, ...context })
    expect(code(pm({}, {}))).toBe('RULES_ASKED_IN_REQUIRED')
    // Quoted but not found in this tab.
    expect(code(pm(asked('lead'), {}))).toBe('RULES_ASKED_IN_REQUIRED')
    // An agent's message, a Swarm notice, and a person's message older than a day.
    expect(code(pm(asked('lead'), { askedIn: { author: author('agent', lead), source: false, createdAt: NOW } }))).toBe('RULES_ASKED_IN_REQUIRED')
    expect(code(pm(asked('lead'), { askedIn: { ...personAsked(), source: true } }))).toBe('RULES_ASKED_IN_REQUIRED')
    expect(code(pm(asked('lead'), { askedIn: personAsked('peer', NOW - RULE_MESSAGE_MS - 1) }))).toBe('RULES_ASKED_IN_REQUIRED')
    // A person who is no member any more.
    expect(code(pm(asked('lead'), { askedIn: personAsked('stranger') }))).toBe('ASKED_BY_UNAVAILABLE')
    // A person who may only read the project now (security review of #3216).
    f.state.people.find(p => p.id === 'peer')!.role = 'viewer'
    expect(code(pm(asked('lead'), { askedIn: personAsked() }))).toBe('RULES_ASKED_IN_REQUIRED')
    f.state.people.find(p => p.id === 'peer')!.role = 'collaborator'
    // A message of another project's chat: the PM reads none of it, so the quote is refused as one it cannot see.
    const other = f.run({ type: 'project.create', name: 'App', visibility: 'public', brief: '' }).result as { conversationId: string }
    expect(code(pm(asked(other.conversationId), { askedIn: personAsked() }))).toBe('NOT_FOUND')
    // In a task of this project: recorded with who asked and where.
    const effects = pm(asked(task, 'ask-2'), { askedIn: personAsked() })() as ReturnType<typeof f.run>
    expect(effects.projectRules).toMatchObject({ writtenBy: { kind: 'agent', id: lead }, askedBy: 'peer', askedIn: { conversationId: task, messageId: 'ask-2' } })
    expect(effects.messages).toEqual([])
  })

  it.each(['owner', 'peer'])('refuses authority changes through the PM quoting %s, while allowing that person directly', id => {
    const f = fixture()
    f.invite()
    const lead = f.add('lead', 'lead', true)
    const authority = { topDeciderId: 'peer', people: [{ name: 'Ken', accountIds: ['owner'] }] }
    const current = { revision: 1, rules: { ...copy(), instructionApprovals: authority } }
    const context = { projectRules: current, askedIn: personAsked(id) }
    for (const instructionApprovals of [null, { ...authority, topDeciderId: 'owner' },
      { ...authority, people: [{ name: 'Ken', accountIds: ['owner', 'peer'] }] }]) {
      expect(code(() => f.run(set(1, { ...later(), instructionApprovals }, asked('lead')), as(lead), context)))
        .toBe('RULES_APPROVAL_EDITOR_REQUIRED')
    }
    // The PM may still make ordinary edits with either omitted or unchanged authority.
    for (const rules of [later(), { ...later(), instructionApprovals: authority }]) {
      expect(f.run(set(1, rules, asked('lead')), as(lead), context).projectRules?.rules.instructionApprovals).toEqual(authority)
    }
    expect(f.run(set(1, { ...later(), instructionApprovals: null }), id === 'owner' ? owner : peer, { projectRules: current })
      .projectRules?.rules.instructionApprovals).toBeNull()
  })

  it('refuses every other agent, the PM of another project and a Buddy', () => {
    const f = fixture()
    f.invite()
    f.add('lead', 'lead', true)
    const task = f.group(), engineer = f.add('engineer', task)
    const context = { projectRules: null, askedIn: personAsked() }
    expect(code(() => f.run(set(0, later(), asked(task)), as(engineer), context))).toBe('RULES_EDITOR_REQUIRED')
    const other = f.run({ type: 'project.create', name: 'App', visibility: 'public', brief: '' }).result as { projectId: string; conversationId: string }
    const otherLead = f.add('other-lead', other.conversationId, true)
    // Another project's PM reads nothing of this one.
    expect(code(() => f.run(set(0, later(), asked('lead')), as(otherLead), context))).toBe('NOT_FOUND')
    const buddy = f.add('buddy', task)
    f.state.agents.find(a => a.id === buddy)!.buddyOf = { personId: 'owner', generation: 'tab' }
    expect(code(() => f.run(set(0, later(), asked(task)), as(buddy), context))).toBe('BUDDY_FORBIDDEN')
  })
})

// Task #3964 (part 2 of #3576): the four Machines rules of the Routing instructions, as project data by machine id.
describe('machine rules in the record', () => {
  const RULES = [
    { machineIds: ['ken-mbp'], why: 'Ken travels then', away: { days: [1, 2, 3, 4, 5], windows: [['07:30', '09:30'], ['18:00', '21:00']], timeZone: 'Asia/Ho_Chi_Minh' } },
    { machineIds: ['tony-mac'], why: 'Tony\'s Mac has the phone setup', first: { lanes: ['mobile'] } },
    { machineIds: ['diego-mac'], why: 'Diego runs no Codex', noEngines: ['codex'] },
    { machineIds: ['local-codex'], why: 'Its Codex defaults to a local model', noReviews: true },
  ]
  const withMachines = (machines: unknown): ProjectRules => ({ ...copy(), machines } as ProjectRules)

  it('holds each of the four kinds, and refuses a rule that is wrong or says nothing', () => {
    expect(projectRulesSchema.parse(withMachines(RULES)).machines).toEqual(RULES)
    const away = RULES[0]!.away
    expect(refused(withMachines([{ ...RULES[0], away: { ...away, windows: [['09:30', '07:30']] } }]))).toBe(true)
    expect(refused(withMachines([{ ...RULES[0], away: { ...away, days: [7] } }]))).toBe(true)
    expect(refused(withMachines([{ ...RULES[0], away: { ...away, timeZone: 'Mars/Olympus' } }]))).toBe(true)
    expect(refused(withMachines([{ ...RULES[2], noEngines: ['gemini'] }]))).toBe(true)
    // A lane the record does not have: the rule would never apply.
    expect(refused(withMachines([{ ...RULES[1], first: { lanes: ['firmware'] } }]))).toBe(true)
    expect(refused(withMachines([{ machineIds: ['m'], why: 'Nothing' }]))).toBe(true)
    expect(refused(withMachines([{ ...RULES[3], machineIds: [] }]))).toBe(true)
    // A record from before has none.
    expect(projectRulesSchema.parse(copy()).machines).toBeUndefined()
  })

  it('preserves approval authority and machine rules together without letting an ordinary member change authority', () => {
    const f = fixture()
    f.invite()
    const authority = { topDeciderId: 'owner', people: [{ name: 'Ken', accountIds: ['owner', 'peer'] }] }
    const current = { revision: 1, rules: { ...withMachines(RULES), instructionApprovals: authority } }
    const kept = f.run(set(1, later()), peer, { projectRules: current })
    expect(kept.projectRules?.rules).toMatchObject({ machines: RULES, instructionApprovals: authority })
    expect(kept.projectRules?.diff).toEqual([{ path: 'releaseWindow.start', before: '09:00', after: '08:00' }])
    expect(f.run(set(1, copy()), peer, { projectRules: current }).result.unchanged).toBe(true)
    expect(code(() => f.run(set(1, { ...later(), instructionApprovals: null }), peer, { projectRules: current })))
      .toBe('RULES_APPROVAL_EDITOR_REQUIRED')
    const cleared = f.run(set(1, { ...later(), instructionApprovals: null, machines: [] }), owner, { projectRules: current })
    expect(cleared.projectRules?.rules).toMatchObject({ instructionApprovals: null, machines: [] })
    expect(code(() => f.run(set(1, { ...copy(), lanes: [{ name: 'phone', owns: ['mobile/'] }] }), owner, { projectRules: current })))
      .toBe('RULES_INVALID')
  })

  it('keeps the current machine rules when a save leaves them out, and clears them only when it says so', () => {
    const f = fixture()
    const current = { revision: 1, rules: withMachines(RULES) }
    const kept = f.run(set(1, later()), owner, { projectRules: current })
    expect(kept.projectRules?.rules.machines).toEqual(RULES)
    expect(kept.projectRules?.diff).toEqual([{ path: 'releaseWindow.start', before: '09:00', after: '08:00' }])
    const cleared = f.run(set(1, { ...later(), machines: [] } as ProjectRules), owner, { projectRules: current })
    expect(cleared.projectRules?.rules.machines).toEqual([])
    // An old client renaming the phone lane cannot keep a rule naming a lane that is gone.
    expect(code(() => f.run(set(1, { ...copy(), lanes: [{ name: 'phone', owns: ['mobile/'] }] }), owner, { projectRules: current }))).toBe('RULES_INVALID')
  })
})
