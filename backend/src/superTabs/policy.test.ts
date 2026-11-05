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
    expect(SEED_RULES.releasePace).toEqual({ backendEveryMinutes: 120, appsAfterVisibleBatch: true })
    expect(SEED_RULES.reviews.defaultReads).toBe(1)
    expect(SEED_RULES.reviews.rows).toEqual(['Sign-in', 'Tokens', 'Encryption', 'Access', 'Buddy guard', 'Device links', 'Deletion']
      .map(area => ({ area, reads: 2 })))
    expect(SEED_RULES.reviews.test).toBe('Where the change runs')
    expect(SEED_RULES.mergeTrain).toEqual({ enabled: true, everyMinutes: 30 })
    expect(SEED_RULES).toMatchObject({ caps: [], paths: [], crew: [], lanes: [] })
  })

  it('holds caps, paths, the crew and lanes', () => {
    const rules = { ...copy(), caps: [{ name: 'Agents on the phone Mac', value: 4 }], paths: [{ name: 'Plans', path: 'docs/plans/' }],
      crew: [{ role: 'Engineer', names: ['Ledger'] }], lanes: [{ name: 'Backend', owns: ['backend/'] }] }
    expect(projectRulesSchema.parse(rules)).toEqual(rules)
  })

  it('refuses bad values', () => {
    expect(refused({ ...copy(), extra: 1 })).toBe(true)
    expect(refused({ ...copy(), releaseWindow: { ...SEED_RULES.releaseWindow, start: '25:00' } })).toBe(true)
    expect(refused({ ...copy(), releaseWindow: { ...SEED_RULES.releaseWindow, start: '18:00', end: '09:00' } })).toBe(true)
    expect(refused({ ...copy(), releaseWindow: { ...SEED_RULES.releaseWindow, timeZone: 'Mars/Base' } })).toBe(true)
    expect(refused({ ...copy(), releasePace: { ...SEED_RULES.releasePace, backendEveryMinutes: 0 } })).toBe(true)
    expect(refused({ ...copy(), releasePace: { ...SEED_RULES.releasePace, backendEveryMinutes: 1.5 } })).toBe(true)
    expect(refused({ ...copy(), reviews: { ...SEED_RULES.reviews, defaultReads: 0 } })).toBe(true)
    expect(refused({ ...copy(), reviews: { ...SEED_RULES.reviews, rows: [{ area: '', reads: 2 }] } })).toBe(true)
    expect(refused({ ...copy(), reviews: { ...SEED_RULES.reviews, rows: [{ area: 'Tokens', reads: 2 }, { area: 'tokens', reads: 1 }] } })).toBe(true)
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
    after.reviews.rows = [...after.reviews.rows, { area: 'Payments', reads: 2 }]
    after.mergeTrain.enabled = false
    expect(rulesDiff(SEED_RULES, after)).toEqual([
      { path: 'releaseWindow.start', before: '09:00', after: '10:00' },
      { path: 'reviews.rows', before: SEED_RULES.reviews.rows, after: after.reviews.rows },
      { path: 'mergeTrain.enabled', before: true, after: false },
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

const later = (): ProjectRules => ({ ...copy(), releaseWindow: { ...SEED_RULES.releaseWindow, start: '10:00' } })
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
      diff: [{ path: 'releaseWindow.start', before: '09:00', after: '10:00' }],
      writtenBy: { kind: 'person', id: 'owner' }, askedBy: 'owner', askedIn: null, at: NOW })
    expect(effects.messages).toEqual([])
    expect(f.state.projects).toEqual(before)
    // The next revision diffs against the stored one, not the seed.
    const next = { ...later(), mergeTrain: { enabled: false, everyMinutes: 30 } }
    const second = f.run(set(1, next, { summary: 'Merge train off' }), owner, { projectRules: { revision: 1, rules: later() } })
    expect(second.projectRules).toMatchObject({ revision: 2, diff: [{ path: 'mergeTrain.enabled', before: true, after: false }], summary: 'Merge train off' })
  })

  it('refuses bad values and a summary that is not one line, storing nothing', () => {
    const f = fixture()
    expect(code(() => f.run(set(0, { ...copy(), releasePace: { backendEveryMinutes: -5, appsAfterVisibleBatch: true } }), owner, { projectRules: null }))).toBe('INVALID')
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
  const personAsked = (id = 'peer', createdAt = NOW - 60_000) => ({ author: { kind: 'person' as const, id }, source: false, createdAt })

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
    expect(code(pm(asked('lead'), { askedIn: { author: { kind: 'agent', id: lead }, source: false, createdAt: NOW } }))).toBe('RULES_ASKED_IN_REQUIRED')
    expect(code(pm(asked('lead'), { askedIn: { ...personAsked(), source: true } }))).toBe('RULES_ASKED_IN_REQUIRED')
    expect(code(pm(asked('lead'), { askedIn: personAsked('peer', NOW - RULE_MESSAGE_MS - 1) }))).toBe('RULES_ASKED_IN_REQUIRED')
    // A person who is no member any more.
    expect(code(pm(asked('lead'), { askedIn: personAsked('stranger') }))).toBe('ASKED_BY_UNAVAILABLE')
    // A message of another project's chat.
    const other = f.run({ type: 'project.create', name: 'App', visibility: 'public', brief: '' }).result as { conversationId: string }
    expect(code(pm(asked(other.conversationId), { askedIn: personAsked() }))).toBe('RULES_ASKED_IN_REQUIRED')
    // In a task of this project: recorded with who asked and where.
    const effects = pm(asked(task, 'ask-2'), { askedIn: personAsked() })() as ReturnType<typeof f.run>
    expect(effects.projectRules).toMatchObject({ writtenBy: { kind: 'agent', id: lead }, askedBy: 'peer', askedIn: { conversationId: task, messageId: 'ask-2' } })
    expect(effects.messages).toEqual([])
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
    expect(code(() => f.run(set(0, later(), asked('lead')), as(otherLead), context))).toBe('RULES_EDITOR_REQUIRED')
    const buddy = f.add('buddy', task)
    f.state.agents.find(a => a.id === buddy)!.buddyOf = { personId: 'owner', generation: 'tab' }
    expect(code(() => f.run(set(0, later(), asked(task)), as(buddy), context))).toBe('BUDDY_FORBIDDEN')
  })
})
