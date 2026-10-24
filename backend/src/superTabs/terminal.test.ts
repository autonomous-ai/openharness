import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from './commands.js'
import { createSuperTab, visibleState, type Actor, type AgentConfiguration, type SuperTabState } from './model.js'

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

  it('refuses the worker itself, another worker and another project\'s Lead', () => {
    const s = swarm()
    const second = s.run({ type: 'agent.add', conversationId: s.group, machineId: 'host', harnessId: 'second', name: 'second', configuration: config, lead: false },
      owner, { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }).result.agentId as string
    for (const actor of [as(s.worker), as(second), as(s.otherLead)]) {
      expect(() => s.run({ type: 'agent.screen', agentId: s.worker }, actor)).toThrow()
      expect(() => s.run({ type: 'agent.input', agentId: s.worker, keys: ['Enter'] }, actor)).toThrow()
    }
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

  it('logs input to the Lead in the project\'s Lead conversation', () => {
    const s = swarm()
    expect(s.run({ type: 'agent.input', agentId: s.lead, keys: ['Esc', '2'] }).messages[0])
      .toMatchObject({ conversationId: 'lead', text: `owner typed Esc + 2 in ${name(s, s.lead)}'s terminal` })
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
      text: `${name(s, s.worker)} can't get answers from its model: its requests keep failing. Stop it, or give the work to another model.` })
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
