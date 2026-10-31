import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor, type AgentConfiguration } from './model.js'
import { appendRouting, instructionsHash, legacyRoleName, MAX_INSTRUCTIONS_BYTES, roleNameOf, routingSummary, summarySchema } from './instructions.js'
import type { SwarmProject } from './projects.js'
import { INSTRUCTIONS_TEMPLATE } from './instructionsTemplate.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const config: AgentConfiguration = { engine: 'codex', model: 'test-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })

function fixture() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: 1000, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const invite = (role: 'viewer' | 'collaborator' = 'collaborator') => {
    const invited = run({ type: 'invite.create', email: peer.email, role, conversationId: 'lead' })
    run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, peer)
  }
  const add = (harnessId: string, group = 'lead', lead = false, extra: Partial<Extract<Command, { type: 'agent.add' }>> = {}) =>
    run({ type: 'agent.add', conversationId: group, machineId: 'host', harnessId, name: harnessId, configuration: config, lead, ...extra }, owner,
      { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }).result.agentId as string
  const group = () => run({ type: 'conversation.create', title: 'Offline editing', brief: 'Save edits while offline.', checks: [] }).result.conversationId as string
  return { run, invite, add, group, get state() { return state } }
}

describe('the built-in template', () => {
  it('describes the spec\'s roles, workflow and routing in one short document', () => {
    for (const heading of ['## Roles', '## Workflow', '## Routing', '### PM', '### Engineer', '### Reviewer', '### Tester']) {
      expect(INSTRUCTIONS_TEMPLATE).toContain(heading)
    }
    expect(INSTRUCTIONS_TEMPLATE).toContain('Review and test run in parallel')
    expect(INSTRUCTIONS_TEMPLATE).toContain('Does not read the code')
    expect(INSTRUCTIONS_TEMPLATE).toContain('No Engineer runs on Claude Sonnet or Claude Haiku')
    expect(INSTRUCTIONS_TEMPLATE).toMatch(/Low-risk docs, tests and fixtures go to a model on the Swarm's grid first/)
    expect(INSTRUCTIONS_TEMPLATE).toContain('Does not write the code itself')
    // A Yes to a nightly routing proposal is a line the PM writes into Routing (project instructions, phase 4, decision 21).
    const pm = INSTRUCTIONS_TEMPLATE.slice(INSTRUCTIONS_TEMPLATE.indexOf('### PM'), INSTRUCTIONS_TEMPLATE.indexOf('### Engineer'))
    expect(pm).toContain('nightly routing proposal')
    expect(pm).toContain('- When the project owner answers Yes to a nightly routing proposal, writes its line into Routing, naming the owner as who asked.')
    expect(Buffer.byteLength(INSTRUCTIONS_TEMPLATE)).toBeLessThan(16_384)
  })
})

describe('role names', () => {
  it('reads an agent without one by what it is: PM, Buddy, its custom role, Reviewer or Engineer; a stored one wins', () => {
    const f = fixture()
    const lead = f.add('lead', 'lead', true), group = f.group()
    const engineer = f.add('engineer', group), named = f.add('named', group)
    f.state.agents.find(a => a.id === named)!.roleName = 'QA on the device'
    const reviewer = f.add('reviewer', group)
    f.state.agents.find(a => a.id === reviewer)!.role = 'reviewer'
    const buddy = f.add('buddy', group)
    f.state.agents.find(a => a.id === buddy)!.buddyOf = { personId: 'owner', generation: 'tab' }
    const name = (id: string) => roleNameOf(f.state, f.state.agents.find(a => a.id === id)!)
    expect([lead, engineer, reviewer, buddy, named].map(name)).toEqual(['PM', 'Engineer', 'Reviewer', 'Buddy', 'QA on the device'])
    // A custom set an older client made names its agents, the PM's included.
    Object.assign(f.state.projects![0]!, { skillSet: 'custom', roles: [{ id: 'lead', name: 'Coordinator', kind: 'lead', version: 'v' },
      { id: 'dev', name: 'Builder', kind: 'builder', version: 'v' }, { id: 'review', name: 'Checker', kind: 'reviewer', version: 'v' }] })
    expect([lead, engineer, reviewer, named].map(name)).toEqual(['Coordinator', 'Builder', 'Checker', 'QA on the device'])
  })

  it('names an older client\'s role: its custom role\'s name, else Reviewer for its kind, else none', () => {
    const project = { roles: [{ id: 'lead', name: 'Coordinator', kind: 'lead', version: 'v' }, { id: 'aaaaaaaaaaaa', name: 'Docs writer', kind: 'builder', version: 'v' },
      { id: 'bbbbbbbbbbbb', name: 'Checker', kind: 'reviewer', version: 'v' }] } as SwarmProject
    expect(legacyRoleName(project, { role: 'reviewer' })).toBe('Reviewer')
    expect(legacyRoleName(project, { roleId: 'aaaaaaaaaaaa' })).toBe('Docs writer')
    expect(legacyRoleName(project, { role: 'reviewer', roleId: 'bbbbbbbbbbbb' })).toBe('Checker')
    // A role the set no longer has falls back to the kind; a Builder's kind names nothing (roleNameOf reads it as Engineer).
    expect(legacyRoleName(project, { role: 'reviewer', roleId: 'cccccccccccc' })).toBe('Reviewer')
    expect(legacyRoleName({ ...project, roles: undefined }, { roleId: 'aaaaaaaaaaaa' })).toBeUndefined()
    expect(legacyRoleName(project, { role: 'builder' })).toBeUndefined()
    expect(legacyRoleName(project, {})).toBeUndefined()
  })
})

// An older client's rule.set lands in the document's Routing section (project instructions, phase 4, decision 3).
describe('a routing line an older client adds', () => {
  it('summarizes a routing line in at most 200 characters, as a save\'s summary', () => {
    expect(routingSummary('No  Haiku.\n')).toBe('Routing: No Haiku.')
    // An older client's rule is up to 200 characters, and "Routing: " comes before it.
    const long = routingSummary(`${'word '.repeat(39)}last.`)
    expect(long.length).toBeLessThanOrEqual(200)
    expect(long.startsWith('Routing: word word')).toBe(true)
    expect(long.endsWith('…')).toBe(true)
    expect(summarySchema.safeParse(long).success).toBe(true)
  })

  it('appends a routing line', () => {
    // At the end of the first Routing section, before the next section.
    expect(appendRouting('# Doc\n\n## Routing\n\n- Opus builds.\n\n## Notes\n\nNone.\n', 'No Haiku.'))
      .toBe('# Doc\n\n## Routing\n\n- Opus builds.\n- No Haiku.\n\n## Notes\n\nNone.\n')
    // A Routing section at the end; its own subsections stay in it.
    expect(appendRouting('# Doc\n\n## Routing\n\n- Opus builds.\n\n### Reviews\n\nAny engine.\n', 'No Haiku.'))
      .toBe('# Doc\n\n## Routing\n\n- Opus builds.\n\n### Reviews\n\nAny engine.\n- No Haiku.\n')
    // An empty section, and only the first of two.
    expect(appendRouting('## Routing\n\n## Routing\n\n- Second.', 'No Haiku.')).toBe('## Routing\n\n- No Haiku.\n\n## Routing\n\n- Second.')
    // No section: one at the end.
    expect(appendRouting('# Doc\n\nText.\n', 'No Haiku.')).toBe('# Doc\n\nText.\n\n## Routing\n\n- No Haiku.\n')
    expect(appendRouting('# Doc\n\n## Routing notes\n\nOld.', 'No Haiku.')).toBe('# Doc\n\n## Routing notes\n\nOld.\n\n## Routing\n\n- No Haiku.\n')
    // One line: the rule's words never open a new paragraph or section.
    expect(appendRouting('## Routing\n\n- A.', 'No Haiku.\n## Roles')).toBe('## Routing\n\n- A.\n- No Haiku. ## Roles\n')
    // Past 64 KB nothing is written.
    expect(() => appendRouting('x'.repeat(MAX_INSTRUCTIONS_BYTES), 'No Haiku.')).toThrow(expect.objectContaining({ code: 'INSTRUCTIONS_FULL', status: 409 }))
    // Up to exactly 64 KB is written.
    const nearly = `## Routing\n\n- ${'x'.repeat(MAX_INSTRUCTIONS_BYTES - 21)}`
    expect(Buffer.byteLength(appendRouting(nearly, 'Ok.'))).toBe(MAX_INSTRUCTIONS_BYTES)
    expect(() => appendRouting(`${nearly}x`, 'Ok.')).toThrow(expect.objectContaining({ code: 'INSTRUCTIONS_FULL' }))
  })
})

describe('instructions.save', () => {
  const save = (baseRevision: number, text: string, extra: Partial<Extract<Command, { type: 'instructions.save' }>> = {}): Command =>
    ({ type: 'instructions.save', projectId: 'lead', baseRevision, text, summary: 'Reviews run on Opus', ...extra })

  it('saves on the latest revision, announces it in the project chat and hands the text to the store', () => {
    const f = fixture()
    expect(f.state.projects![0]).toMatchObject({ instructionsRevision: 1, instructionsHash: instructionsHash(INSTRUCTIONS_TEMPLATE) })
    const effects = f.run(save(1, 'Reviews run on Opus.'))
    expect(effects.result).toMatchObject({ projectId: 'lead', revision: 2, hash: instructionsHash('Reviews run on Opus.') })
    expect(effects.instructions).toEqual({ projectId: 'lead', revision: 2, hash: instructionsHash('Reviews run on Opus.'), text: 'Reviews run on Opus.',
      summary: 'Reviews run on Opus', writtenBy: { kind: 'person', id: 'owner' }, askedBy: 'owner', at: 1000 })
    expect(f.state.projects![0]).toMatchObject({ instructionsRevision: 2, instructionsHash: instructionsHash('Reviews run on Opus.') })
    expect(effects.messages).toHaveLength(1)
    expect(effects.messages[0]).toMatchObject({ conversationId: 'lead', author: { kind: 'person', id: 'owner' }, recipients: [],
      text: 'owner changed the instructions: Reviews run on Opus.', source: { kind: 'instructions', projectId: 'lead', revision: 2 } })
  })

  it('refuses a save on an older revision with the current revision and text, so the caller can merge', () => {
    const f = fixture()
    f.invite()
    f.run(save(1, 'Owner text.'))
    let refused: unknown
    try { f.run(save(1, 'Peer text.'), peer, { instructions: { revision: 2, text: 'Owner text.' } }) } catch (error) { refused = error }
    expect(refused).toMatchObject({ code: 'INSTRUCTIONS_STALE', status: 409, details: { revision: 2, text: 'Owner text.' } })
    expect(f.run(save(2, 'Peer text.'), peer).result.revision).toBe(3)
    // A project without a document yet runs on the template, which is what a stale save there merges with.
    f.state.projects![0]!.instructionsRevision = undefined
    let template: unknown
    try { f.run(save(3, 'Peer text.'), peer, { instructions: null }) } catch (error) { template = error }
    expect(template).toMatchObject({ code: 'INSTRUCTIONS_STALE', details: { revision: 0, text: INSTRUCTIONS_TEMPLATE } })
  })

  it('lets the coordinator save for the member who asked, and no other agent or a viewer', () => {
    const f = fixture()
    f.invite()
    const lead = f.add('lead', 'lead', true), group = f.group(), engineer = f.add('engineer', group)
    expect(() => f.run(save(1, 'PM text.'), as(lead))).toThrow(expect.objectContaining({ code: 'ASKED_BY_REQUIRED' }))
    expect(() => f.run(save(1, 'PM text.', { askedBy: 'stranger' }), as(lead))).toThrow(expect.objectContaining({ code: 'ASKED_BY_UNAVAILABLE' }))
    const effects = f.run(save(1, 'PM text.', { askedBy: 'peer' }), as(lead))
    expect(effects.instructions).toMatchObject({ writtenBy: { kind: 'agent', id: lead }, askedBy: 'peer' })
    expect(effects.messages[0]).toMatchObject({ author: { kind: 'agent', id: lead }, text: 'lead changed the instructions for peer: Reviews run on Opus.' })
    expect(() => f.run(save(2, 'Engineer text.', { askedBy: 'owner' }), as(engineer))).toThrow(expect.objectContaining({ code: 'COORDINATOR_REQUIRED' }))
    const buddy = f.add('buddy', group)
    f.state.agents.find(a => a.id === buddy)!.buddyOf = { personId: 'owner', generation: 'tab' }
    expect(() => f.run(save(2, 'Buddy text.', { askedBy: 'owner' }), as(buddy))).toThrow(expect.objectContaining({ code: 'BUDDY_FORBIDDEN' }))
    const viewer = fixture()
    viewer.invite('viewer')
    expect(() => viewer.run(save(1, 'Viewer text.'), peer)).toThrow(expect.objectContaining({ code: 'READ_ONLY' }))
  })

  it('names in the chat line the member a person saved for, and no one when they saved for themselves (review of phase 2)', () => {
    const f = fixture()
    f.invite()
    const effects = f.run(save(1, 'Peer text.', { askedBy: 'peer' }))
    expect(effects.instructions).toMatchObject({ writtenBy: { kind: 'person', id: 'owner' }, askedBy: 'peer' })
    expect(effects.messages[0]!.text).toBe('owner changed the instructions for peer: Reviews run on Opus.')
    expect(f.run(save(2, 'Owner text.', { askedBy: 'owner' })).messages[0]!.text).toBe('owner changed the instructions: Reviews run on Opus.')
  })

  it('keeps a document within 64 KB and a summary on one line, and saves nothing new for the same text', () => {
    const f = fixture()
    expect(() => f.run(save(1, 'x'.repeat(65_537)))).toThrow()
    expect(f.run(save(1, 'é'.repeat(32_768))).result.revision).toBe(2)
    expect(() => f.run(save(2, 'Other.', { summary: 'two\nlines' }))).toThrow()
    const same = f.run(save(2, 'é'.repeat(32_768)))
    expect(same.result).toMatchObject({ revision: 2, unchanged: true })
    expect(same.instructions).toBeUndefined()
    expect(same.messages).toEqual([])
  })

  it('starts a new project on a copy of the template as revision 1', () => {
    const f = fixture()
    const created = f.run({ type: 'project.create', name: 'App', visibility: 'public', brief: '' })
    const projectId = created.result.projectId as string
    expect(f.state.projects!.find(p => p.id === projectId)).toMatchObject({ instructionsRevision: 1, instructionsHash: instructionsHash(INSTRUCTIONS_TEMPLATE) })
    expect(created.instructions).toMatchObject({ projectId, revision: 1, text: INSTRUCTIONS_TEMPLATE, writtenBy: { kind: 'person', id: 'owner' }, askedBy: 'owner' })
  })
})

describe('PM notes', () => {
  const note = (text: string, extra: Partial<Extract<Command, { type: 'note.add' }>> = {}): Command =>
    ({ type: 'note.add', projectId: 'lead', text, askedBy: 'owner', ...extra })
  const kept = (id: string, expiresAt: number | null = null, text = 'Old note.') => ({ id, text, askedBy: 'owner', at: 500, expiresAt })

  it('lets only the coordinator keep a note, quietly, for a member who reads the project, ending when asked', () => {
    const f = fixture()
    const lead = f.add('lead', 'lead', true), group = f.group(), engineer = f.add('engineer', group)
    const effects = f.run(note('Do not use Codex on machine A.', { expiresAt: new Date(5000).toISOString() }), as(lead))
    expect(effects.notes).toEqual({ projectId: 'lead', add: { id: effects.result.noteId, text: 'Do not use Codex on machine A.', askedBy: 'owner', at: 1000, expiresAt: 5000 } })
    expect(effects.messages).toEqual([])
    expect(f.state.projects![0]!.notesRevision).toBe(1)
    expect(() => f.run(note('A person writes no note.'))).toThrow(expect.objectContaining({ code: 'COORDINATOR_REQUIRED' }))
    expect(() => f.run(note('Nor an Engineer.'), as(engineer))).toThrow(expect.objectContaining({ code: 'COORDINATOR_REQUIRED' }))
    expect(() => f.run(note('For nobody.', { askedBy: 'stranger' }), as(lead))).toThrow(expect.objectContaining({ code: 'ASKED_BY_UNAVAILABLE' }))
    expect(() => f.run(note('Already over.', { expiresAt: new Date(1000).toISOString() }), as(lead))).toThrow(expect.objectContaining({ code: 'NOTE_EXPIRED' }))
    expect(() => f.run(note('x'.repeat(301)), as(lead))).toThrow()
  })

  it('keeps at most 100 live notes; an expired one does not count and goes on the next write', () => {
    const f = fixture()
    const lead = f.add('lead', 'lead', true)
    const full = Array.from({ length: 100 }, (_, i) => kept(`n${i}`))
    expect(() => f.run(note('One more.'), as(lead), { notes: full })).toThrow(expect.objectContaining({ code: 'NOTES_FULL' }))
    const effects = f.run(note('One more.'), as(lead), { notes: [...full.slice(1), kept('gone', 900)] })
    expect(effects.notes).toMatchObject({ projectId: 'lead', add: { text: 'One more.' } })
  })

  it('lets a member or the coordinator remove a note, and tells the coordinator when a person did', () => {
    const f = fixture()
    f.invite()
    const lead = f.add('lead', 'lead', true)
    const notes = [kept('n1', null, 'Do not use Codex on machine A.'), kept('n2', 900)]
    const removed = f.run({ type: 'note.remove', projectId: 'lead', noteId: 'n1' }, peer, { notes })
    expect(removed.notes).toEqual({ projectId: 'lead', removeId: 'n1' })
    expect(removed.messages).toEqual([expect.objectContaining({ conversationId: 'lead', recipients: [lead], author: expect.objectContaining({ id: 'peer' }),
      text: 'peer removed your note: "Do not use Codex on machine A."', source: { kind: 'note-removed' } })])
    expect(f.run({ type: 'note.remove', projectId: 'lead', noteId: 'n1' }, as(lead), { notes }).messages).toEqual([])
    // An expired note is gone already, as one never kept.
    expect(() => f.run({ type: 'note.remove', projectId: 'lead', noteId: 'n2' }, peer, { notes })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(() => f.run({ type: 'note.remove', projectId: 'lead', noteId: 'n9' }, peer, { notes })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
  })
})

describe('role names and the coordinator\'s name', () => {
  it('keeps the role an agent is added or started in, and nothing when an old client names none', () => {
    const f = fixture()
    const group = f.group()
    const tester = f.add('tester', group, false, { roleName: ' Tester ' }), plain = f.add('plain', group)
    expect(f.state.agents.find(a => a.id === tester)!.roleName).toBe('Tester')
    expect(f.state.agents.find(a => a.id === plain)).not.toHaveProperty('roleName')
    expect(() => f.add('long', group, false, { roleName: 'x'.repeat(41) })).toThrow()
    const contribution = { machineOwnerId: 'host-owner', contributorId: 'owner', hostGrant: null }
    const request = { conversationId: group, machineId: 'host', engine: 'claude', name: 'Designer', cwd: '/repo', worktree: true, roleName: 'Designer',
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }
    const startId = f.run({ type: 'agent.start', request }, owner, { contribution }).result.startId as string
    expect(f.state.starts!.find(s => s.id === startId)!.request.roleName).toBe('Designer')
    const designer = f.run({ type: 'agent.started', startId, harnessId: 'native-designer', configuration: { ...config, engine: 'claude' } }, owner,
      { contribution }).result.agentId as string
    expect(f.state.agents.find(a => a.id === designer)!.roleName).toBe('Designer')
  })

  it('lets the coordinator or the project owner rename the coordinator, nobody else', () => {
    const f = fixture()
    f.invite()
    const lead = f.add('lead', 'lead', true), group = f.group(), engineer = f.add('engineer', group)
    const rename = (name: string): Command => ({ type: 'project.coordinatorName', projectId: 'lead', name })
    f.run(rename('Lead engineer'), as(lead))
    expect(f.state.projects![0]!.coordinatorName).toBe('Lead engineer')
    f.run(rename(' Coordinator '))
    expect(f.state.projects![0]!.coordinatorName).toBe('Coordinator')
    expect(() => f.run(rename('Boss'), peer)).toThrow(expect.objectContaining({ code: 'PROJECT_OWNER_REQUIRED' }))
    expect(() => f.run(rename('Boss'), as(engineer))).toThrow(expect.objectContaining({ code: 'COORDINATOR_REQUIRED' }))
    expect(() => f.run(rename('x'.repeat(41)))).toThrow()
  })
})
