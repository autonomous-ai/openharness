import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from './commands.js'
import { createSuperTab, visibleState, type Actor, type AgentConfiguration, type SuperTabState } from './model.js'
import { mayDrive } from './terminal.js'

const owner: Actor = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Actor = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const config: AgentConfiguration = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })

function swarm(peerRole: 'collaborator' | 'viewer' = 'collaborator') {
  let state: SuperTabState = createSuperTab('tab', 'Pilot', { id: 'owner', email: 'owner@example.com' }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: 1_000_000, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const invited = run({ type: 'invite.create', email: 'peer@example.com', role: peerRole, conversationId: 'lead' })
  run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, peer)
  const add = (harnessId: string, group: string, lead = false) => run({ type: 'agent.add', conversationId: group, machineId: 'host', harnessId,
    name: harnessId, configuration: config, lead }, owner, { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }).result.agentId as string
  const lead = add('lead', 'lead', true)
  const group = run({ type: 'conversation.create', title: 'Drafts', brief: 'Save drafts.', checks: [{ description: 'Saved', independent: false }] }).result.conversationId as string
  run({ type: 'conversation.agent', conversationId: group, agentId: lead, present: true, lead: true })
  const worker = add('worker', group)
  const other = run({ type: 'project.create', name: 'Other', visibility: 'public', brief: '' }).result.conversationId as string
  const otherLead = add('other-lead', other, true)
  return { run, lead, worker, group, otherLead, get state() { return state } }
}

const name = (s: ReturnType<typeof swarm>, agentId: string) => { const a = s.state.agents.find(a => a.id === agentId)!; return a.displayName ?? a.name }

describe('reading and typing in an agent terminal', () => {
  it('lets the project Lead read a worker terminal, without writing to any group', () => {
    const s = swarm()
    const effects = s.run({ type: 'agent.screen', agentId: s.worker, scrollback: 200 }, as(s.lead))
    expect(effects.result.requestId).toEqual(expect.any(String))
    expect(effects.terminal).toEqual({ op: 'request', id: effects.result.requestId, kind: 'screen', agentId: s.worker, machineId: 'host',
      machineOwnerId: 'host-owner', harnessId: 'worker', requesterKey: `agent:${s.lead}`, scrollback: 200 })
    expect(effects.messages).toEqual([])
  })

  it('lets a person with write access read and type, and refuses a viewer', () => {
    expect(swarm().run({ type: 'agent.screen', agentId: swarm().worker }, peer).terminal).toMatchObject({ requesterKey: 'person:peer' })
    const s = swarm('viewer')
    expect(() => s.run({ type: 'agent.screen', agentId: s.worker }, peer)).toThrow('read-only')
  })

  // Reading or typing in another agent's terminal is workflow (project instructions, phase 4); the Product Manager's stays private.
  it('lets any agent of the project read or type in another agent\'s terminal', () => {
    const s = swarm()
    const second = s.run({ type: 'agent.add', conversationId: s.group, machineId: 'host', harnessId: 'second', name: 'second', configuration: config, lead: false },
      owner, { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }).result.agentId as string
    const outside = s.run({ type: 'agent.add', conversationId: s.state.conversations.find(c => c.leadId === s.otherLead)!.id, machineId: 'host', harnessId: 'outside',
      name: 'outside', configuration: config, lead: false }, owner, { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }).result.agentId as string
    const target = (id: string) => s.state.agents.find(a => a.id === id)!
    expect(() => mayDrive(s.state, as(second), target(s.worker))).not.toThrow()
    expect(s.run({ type: 'agent.input', agentId: s.worker, keys: ['Enter'] }, as(second)).terminal).toMatchObject({ requesterKey: `agent:${second}` })
    expect(() => mayDrive(s.state, as(second), target(outside))).toThrow()
    expect(() => s.run({ type: 'agent.screen', agentId: outside }, as(second))).toThrow()
    expect(() => mayDrive(s.state, as(second), target(s.lead), false, 'screen')).toThrow(expect.objectContaining({ code: 'TERMINAL_PRIVATE' }))
  })

  it('refuses another project\'s Lead', () => {
    const s = swarm()
    expect(() => s.run({ type: 'agent.screen', agentId: s.worker }, as(s.otherLead))).toThrow()
    expect(() => s.run({ type: 'agent.input', agentId: s.worker, keys: ['Enter'] }, as(s.otherLead))).toThrow()
  })

  // Security review S1: Bob's own sign-in speaks for the agent his machine runs, so through it he would type, as Alice, into
  // her private project's agents. An agent drives another login's agent only where its own machine's person could.
  it('lets an agent drive another login\'s agent only where the person whose machine runs it could', () => {
    let state: SuperTabState = createSuperTab('tab', 'Pilot', { id: 'owner', email: 'owner@example.com' }, 'prod')
    state.people.push({ id: 'alice', email: 'alice@example.com', role: 'collaborator', generation: 'a1' },
      { id: 'bob', email: 'bob@example.com', role: 'collaborator', generation: 'b1' })
    const alice: Actor = { kind: 'person', userId: 'alice', email: 'alice@example.com' }
    const bob: Actor = { kind: 'person', userId: 'bob', email: 'bob@example.com' }
    let sequence = 0
    const run = (command: Command, actor: Actor, context: Partial<CommandContext> = {}) => {
      const effects = applyCommand(state, actor, command, { now: 1_000_000, operationId: `op-${++sequence}`, ...context })
      state = effects.state
      return effects
    }
    // As a start on a host's own contributed machine leaves its agent: hosted and contributed by that host.
    const add = (conversationId: string, harnessId: string, host: string, by: Actor = alice) => run({ type: 'agent.add', conversationId,
      machineId: `${host}-mac`, harnessId, name: harnessId, configuration: config, lead: false }, by,
      { contribution: { machineOwnerId: host, contributorId: host } }).result.agentId as string
    const hosted = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: state.agents.find(a => a.id === agentId)!.machineOwnerId })
    const secret = run({ type: 'project.create', name: 'Secret', visibility: 'private', brief: '' }, alice).result.projectId as string
    const task = run({ type: 'conversation.create', projectId: secret, title: 'Task', brief: 'Do it.', checks: [] }, alice).result.conversationId as string
    const onAlice = add(task, 'on-alice', 'alice'), sibling = add(task, 'sibling', 'alice'), onBob = add(task, 'on-bob', 'bob')
    const target = (id: string) => state.agents.find(a => a.id === id)!
    // Bob himself reads nothing of Secret, so the agent his machine runs drives none of its agents on Alice's login.
    expect(() => run({ type: 'agent.input', agentId: onAlice, text: '!id', keys: ['Enter'] }, bob)).toThrow()
    for (const command of [{ type: 'agent.input', agentId: onAlice, text: '!id', keys: ['Enter'] }, { type: 'agent.screen', agentId: onAlice }] as Command[]) {
      expect(() => run(command, hosted(onBob))).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    }
    for (const kind of ['input', 'screen'] as const) expect(() => mayDrive(state, hosted(onBob), target(onAlice), false, kind)).toThrow()
    // The same login's agents drive each other, and Alice's agent still drives the one on Bob's machine: she could herself.
    expect(run({ type: 'agent.input', agentId: onAlice, keys: ['Enter'] }, hosted(sibling)).terminal).toMatchObject({ machineOwnerId: 'alice' })
    expect(run({ type: 'agent.screen', agentId: onBob }, hosted(onAlice)).terminal).toMatchObject({ machineOwnerId: 'bob' })
    // In a project Bob reads, his agent drives Alice's as he could.
    const open = run({ type: 'project.create', name: 'Open', visibility: 'public', brief: '' }, alice).result.projectId as string
    const shared = run({ type: 'conversation.create', projectId: open, title: 'Task', brief: 'Do it.', checks: [] }, alice).result.conversationId as string
    const herWorker = add(shared, 'her-worker', 'alice'), hisWorker = add(shared, 'his-worker', 'bob', bob)
    expect(run({ type: 'agent.input', agentId: herWorker, keys: ['Enter'] }, hosted(hisWorker)).terminal).toMatchObject({ machineOwnerId: 'alice' })
  })

  // The project's coordinator keeps its pre-branch power (to answer an agent's input prompt), even on a machine whose owner
  // could not drive the target.
  it('lets the coordinator drive a project agent on another login even where its host could not', () => {
    let state: SuperTabState = createSuperTab('tab', 'Pilot', { id: 'owner', email: 'owner@example.com' }, 'prod')
    state.people.push({ id: 'alice', email: 'alice@example.com', role: 'collaborator', generation: 'a1' },
      { id: 'bob', email: 'bob@example.com', role: 'collaborator', generation: 'b1' })
    const alice: Actor = { kind: 'person', userId: 'alice', email: 'alice@example.com' }
    let sequence = 0
    const run = (command: Command, actor: Actor, context: Partial<CommandContext> = {}) => {
      const effects = applyCommand(state, actor, command, { now: 1_000_000, operationId: `op-${++sequence}`, ...context })
      state = effects.state
      return effects
    }
    const add = (conversationId: string, harnessId: string, host: string, lead = false) => run({ type: 'agent.add', conversationId,
      machineId: `${host}-mac`, harnessId, name: harnessId, configuration: config, lead }, alice,
      { contribution: { machineOwnerId: host, contributorId: host } }).result.agentId as string
    const hosted = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: state.agents.find(a => a.id === agentId)!.machineOwnerId })
    const created = run({ type: 'project.create', name: 'Secret', visibility: 'private', brief: '' }, alice).result
    const task = run({ type: 'conversation.create', projectId: created.projectId as string, title: 'Task', brief: 'Do it.', checks: [] }, alice).result.conversationId as string
    const worker = add(task, 'worker', 'alice'), helper = add(task, 'helper', 'bob')
    const coordinator = add(created.conversationId as string, 'pm', 'bob', true)
    expect(run({ type: 'agent.input', agentId: worker, keys: ['Enter'] }, hosted(coordinator)).terminal).toMatchObject({ machineOwnerId: 'alice' })
    expect(run({ type: 'agent.screen', agentId: worker }, hosted(coordinator)).terminal).toMatchObject({ machineOwnerId: 'alice' })
    // Any other agent there still drives only as its host could.
    expect(() => run({ type: 'agent.screen', agentId: worker }, hosted(helper))).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  })

  // Ken (2026-10-28): members may watch the Lead, but driving another person's Lead needs its machine's owner, whether or not
  // its session counts as private.
  it('lets only its machine\'s owner read or type in a Lead\'s terminal, for being the Lead', () => {
    const s = swarm()
    for (const command of [{ type: 'agent.screen', agentId: s.lead }, { type: 'agent.input', agentId: s.lead, keys: ['Enter'] }] as Command[]) {
      expect(() => s.run(command, peer)).toThrow('in a Product Manager’s terminal')
    }
    const hostOwner: Actor = { kind: 'person', userId: 'host-owner', email: 'host-owner@example.com' }
    const invited = s.run({ type: 'invite.create', email: 'host-owner@example.com', role: 'collaborator', conversationId: 'lead' })
    s.run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, hostOwner)
    expect(s.run({ type: 'agent.input', agentId: s.lead, keys: ['Enter'] }, hostOwner).terminal).toMatchObject({ requesterKey: 'person:host-owner' })
  })

  it('logs typed input as a terminal-input row in the agent\'s current group, delivered to nobody', () => {
    const s = swarm()
    s.run({ type: 'work.assign', conversationId: s.group, agentId: s.worker })
    const effects = s.run({ type: 'agent.input', agentId: s.worker, text: 'y'.repeat(250), keys: ['Enter'] }, as(s.lead))
    expect(effects.terminal).toMatchObject({ op: 'request', kind: 'input', text: 'y'.repeat(250), keys: ['Enter'] })
    expect(effects.messages).toEqual([expect.objectContaining({ conversationId: s.group, recipients: [],
      text: `${name(s, s.lead)} typed \`${'y'.repeat(199)}…\` + Enter in ${name(s, s.worker)}'s terminal`,
      source: { kind: 'terminal-input', agentId: s.worker, requestId: effects.result.requestId } })])
  })

  it('types a credential as given but never shows it in the group\'s row, even where the row is cut', () => {
    const s = swarm()
    s.run({ type: 'work.assign', conversationId: s.group, agentId: s.worker })
    // Assembled at run time from obviously fake parts.
    const token = ['ghp', 'Fixture0Token1Not2Real3Value4abcdefgh'].join('_')
    const text = `${'x'.repeat(150)} gh auth login --with-token ${token} and more words after it`
    const effects = s.run({ type: 'agent.input', agentId: s.worker, text, keys: ['Enter'] }, as(s.lead))
    expect(effects.terminal).toMatchObject({ op: 'request', kind: 'input', text })
    expect(effects.messages).toHaveLength(1)
    expect(effects.messages[0]!.text).not.toContain(token.slice(0, 12))
    // Cut at 200 first, the row would have kept the token's first 21 characters.
    const shown = `${'x'.repeat(150)} gh auth login --with-token [credential removed] and more words after it`.slice(0, 199)
    expect(effects.messages[0]!.text).toBe(`${name(s, s.lead)} typed \`${shown}…\` + Enter in ${name(s, s.worker)}'s terminal`)
    expect(effects.result.credentialNotice).toBe('Removed a credential (GitHub token) before saving. Revoke or rotate it.')
  })

  it('logs input to the Lead in the project\'s Lead conversation', () => {
    const s = swarm()
    // Only the person whose machine runs the Lead may type in it (final review, Critical 1).
    const machineOwner: Actor = { kind: 'person', userId: 'host-owner', email: 'host@example.com' }
    const invited = s.run({ type: 'invite.create', email: 'host@example.com', role: 'collaborator', conversationId: 'lead' })
    s.run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, machineOwner)
    expect(s.run({ type: 'agent.input', agentId: s.lead, keys: ['Esc', '2'] }, machineOwner).messages[0])
      .toMatchObject({ conversationId: 'lead', text: `host typed Esc + 2 in ${name(s, s.lead)}'s terminal` })
    expect(() => s.run({ type: 'agent.input', agentId: s.lead, keys: ['Esc'] })).toThrow('Only the person whose machine runs this agent')
  })

  it('accepts only printable text and named keys, and needs one of them', () => {
    const input = (patch: Record<string, unknown>) => commandSchema.safeParse({ type: 'agent.input', agentId: 'a', ...patch }).success
    expect(input({ text: 'continue' })).toBe(true)
    expect(input({ keys: ['Enter', 'Esc', 'Tab', 'Up', 'Down', 'Left', 'Right', 'Ctrl-C', '0', '9'] })).toBe(true)
    expect(input({})).toBe(false)
    expect(input({ text: 'rm -rf /\n' })).toBe(false)
    expect(input({ text: '\x1b[A' })).toBe(false)
    expect(input({ keys: ['Ctrl-D'] })).toBe(false)
    expect(commandSchema.safeParse({ type: 'agent.screen', agentId: 'a', scrollback: 201 }).success).toBe(false)
  })

  it('fails at once when the agent\'s terminal or machine is down', () => {
    const s = swarm()
    s.state.agents.find(a => a.id === s.worker)!.downSince = new Date(0).toISOString()
    expect(() => s.run({ type: 'agent.screen', agentId: s.worker }, as(s.lead))).toThrow('offline')
  })
})

describe('answering a terminal request', () => {
  const claimed = (s: ReturnType<typeof swarm>, kind: 'screen' | 'input' = 'screen') =>
    ({ terminalRequest: { id: 'req', agentId: s.worker, harnessId: 'worker', kind, status: 'claimed' } }) as Partial<CommandContext>

  it('takes the screen from the agent\'s own host and writes nothing to a group', () => {
    const s = swarm()
    const effects = s.run({ type: 'agent.screenResult', requestId: 'req', ok: true, text: 'Allow edit? (y/n)' }, as(s.worker), claimed(s))
    expect(effects.terminal).toEqual({ op: 'result', id: 'req', ok: true, text: 'Allow edit? (y/n)', error: null })
    expect(effects.messages).toEqual([])
    expect(s.run({ type: 'agent.inputResult', requestId: 'req', ok: false, error: 'No pane' }, as(s.worker), claimed(s, 'input')).terminal)
      .toEqual({ op: 'result', id: 'req', ok: false, text: null, error: 'No pane' })
  })

  it('refuses another agent, a replaced terminal, a closed request and the wrong kind', () => {
    const s = swarm()
    const answer: Command = { type: 'agent.screenResult', requestId: 'req', ok: true, text: 'x' }
    expect(() => s.run(answer, as(s.lead), claimed(s))).toThrow()
    expect(() => s.run(answer, as(s.worker))).toThrow()
    expect(() => s.run(answer, as(s.worker), { terminalRequest: { ...claimed(s).terminalRequest!, harnessId: 'old' } })).toThrow()
    expect(() => s.run(answer, as(s.worker), { terminalRequest: { ...claimed(s).terminalRequest!, status: 'done' } })).toThrow()
    expect(() => s.run(answer, as(s.worker), claimed(s, 'input'))).toThrow()
  })

  it('caps the screen at 64 KB and needs an error when it failed', () => {
    const result = (patch: Record<string, unknown>) => commandSchema.safeParse({ type: 'agent.screenResult', requestId: 'r', ok: true, ...patch }).success
    expect(result({ text: 'x'.repeat(65_536) })).toBe(true)
    expect(result({ text: 'é'.repeat(40_000) })).toBe(false)
    expect(result({ ok: false })).toBe(false)
    expect(result({ ok: false, error: 'Pane closed' })).toBe(true)
  })
})

describe('terminal alerts', () => {
  it('posts one row per episode to the agent\'s group and delivers it to the Lead', () => {
    const s = swarm()
    s.run({ type: 'work.assign', conversationId: s.group, agentId: s.worker })
    const prompt: Command = { type: 'agent.alert', agentId: s.worker, alert: 'prompt', active: true }
    expect(s.run(prompt, as(s.worker)).messages).toEqual([expect.objectContaining({ conversationId: s.group, recipients: [s.lead],
      text: `${name(s, s.worker)} is waiting at a prompt in its terminal.`, source: { kind: 'terminal-alert', agentId: s.worker, alert: 'prompt' } })])
    expect(s.run(prompt, as(s.worker)).messages).toEqual([])
    s.run({ ...prompt, active: false } as Command, as(s.worker))
    expect(s.run(prompt, as(s.worker)).messages).toHaveLength(1)
  })

  it('delivers to the worker\'s project Lead, not the group\'s Lead, and through the Lead chat when the Lead is not in the group', () => {
    const s = swarm()
    const bare = s.run({ type: 'conversation.create', title: 'Bare', brief: 'No Lead here.', checks: [] }).result.conversationId as string
    const room = s.state.conversations.find(c => c.id === bare)!
    room.leadId = null
    room.agentIds = room.agentIds.filter(id => id !== s.lead)
    const other = s.run({ type: 'agent.add', conversationId: bare, machineId: 'host', harnessId: 'other-worker', name: 'other-worker', configuration: config, lead: false },
      owner, { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }).result.agentId as string
    const rows = s.run({ type: 'agent.alert', agentId: other, alert: 'prompt', active: true }, as(other)).messages
    expect(rows.map(r => [r.conversationId, r.recipients])).toEqual([[bare, []], ['lead', [s.lead]]])
    s.state.conversations.find(c => c.id === s.group)!.leadId = other
    expect(s.run({ type: 'agent.alert', agentId: s.worker, alert: 'prompt', active: true }, as(s.worker)).messages
      .map(r => [r.conversationId, r.recipients])).toEqual([[s.group, [s.lead]]])
  })

  it('marks a limited agent until its reset time, or an hour, and shows null once it passed', () => {
    const s = swarm()
    const reset = new Date(1_000_000 + 600_000).toISOString()
    const effects = s.run({ type: 'agent.alert', agentId: s.worker, alert: 'limit', active: true, resetAt: reset }, as(s.worker))
    expect(effects.messages[0]).toMatchObject({ text: `${name(s, s.worker)} hit a usage limit. Routing skips it until 00:26 UTC.`,
      source: { kind: 'terminal-alert', agentId: s.worker, alert: 'limit', limitedUntil: reset } })
    expect(s.state.agents.find(a => a.id === s.worker)!.limitedUntil).toBe(reset)
    expect(visibleState(s.state, owner, 1_000_000).agents.find(a => a.id === s.worker)!.limitedUntil).toBe(reset)
    expect(visibleState(s.state, owner, 1_600_000).agents.find(a => a.id === s.worker)!.limitedUntil).toBeNull()
    const lead = s.run({ type: 'agent.alert', agentId: s.lead, alert: 'limit', active: true }, as(s.lead))
    expect(s.state.agents.find(a => a.id === s.lead)!.limitedUntil).toBe(new Date(1_000_000 + 3_600_000).toISOString())
    expect(lead.messages[0]).toMatchObject({ conversationId: 'lead', recipients: [] })
  })

  it('tells the Lead when an agent cannot get answers from its model, once per episode', () => {
    const s = swarm()
    const on = () => s.run({ type: 'agent.alert', agentId: s.worker, alert: 'model', active: true }, as(s.worker)).messages
    expect(on()[0]).toMatchObject({ recipients: [s.lead], source: { kind: 'terminal-alert', agentId: s.worker, alert: 'model' },
      text: `${name(s, s.worker)} can't get answers from its model: its requests keep failing.` })
    expect(on()).toEqual([])
    expect(s.state.agents.find(a => a.id === s.worker)!.limitedUntil).toBeUndefined()
    s.run({ type: 'agent.alert', agentId: s.worker, alert: 'model', active: false }, as(s.worker))
    expect(on()).toHaveLength(1)
  })

  it('takes alerts only from the agent\'s own host', () => {
    const s = swarm()
    expect(() => s.run({ type: 'agent.alert', agentId: s.worker, alert: 'prompt', active: true }, as(s.lead))).toThrow()
    expect(() => s.run({ type: 'agent.alert', agentId: s.worker, alert: 'prompt', active: true })).toThrow()
  })
})
