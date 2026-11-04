import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { PERSONAL_SWARM_OPERATION } from './deletion.js'
import { createSuperTab, stableId, type Actor, type AgentConfiguration, type SuperTabState } from './model.js'
import { projectsOf } from './projects.js'

// A Personal Swarm's project chat with no Lead (task #2633, Huy 11-04): the person's message waits for the project's Lead,
// which their Desktop starts on their own machine after one claim (lead.claim), and reaches it once it joins. A Team Swarm
// keeps "Not sent": nothing waits there and nothing is claimed.

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const config: AgentConfiguration = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
const NOW = 1_000_000
const MINUTE = 60_000

function fixture(personal = true) {
  const id = personal ? stableId('super-tab', 'prod', 'owner', PERSONAL_SWARM_OPERATION) : 'team'
  let state = createSuperTab(id, personal ? 'Personal' : 'Team', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  let now = NOW
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}, operationId = `op-${++sequence}`) => {
    const effects = applyCommand(state, actor, command, { now, operationId, ...context })
    state = effects.state
    return effects
  }
  const created = run({ type: 'project.create', name: 'Games', visibility: 'private', brief: '' }).result as { projectId: string; conversationId: string }
  const project = () => projectsOf(state).find(p => p.id === created.projectId)!
  /** The id of the message it sent. */
  const send = (text: string) => run({ type: 'message.send', conversationId: created.conversationId, text, replyTo: null, recipientIds: [] })
    .result.messageId as string
  const claim = (machineId: string) => run({ type: 'lead.claim', projectId: created.projectId, machineId }).result.leadStart
  const join = (harnessId: string, repo: boolean) => run({ type: 'agent.add', conversationId: created.conversationId, machineId: 'mac', harnessId, name: 'Lead',
    configuration: config, lead: true, ...(repo ? { project: { cwd: '/Users/huy/games', repositoryUrl: 'https://github.com/huy/games' } } : {}) },
  owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } })
  return { run, send, claim, join, project, conversationId: created.conversationId, projectId: created.projectId,
    get state(): SuperTabState { return state }, advance: (ms: number) => { now += ms } }
}

const refusal = (run: () => unknown) => {
  try { run(); return 'applied' } catch (error) { return (error as { code?: string }).code }
}

describe('a Personal Swarm project chat with no Lead', () => {
  it('keeps the message for the Lead, and the first claim starts it', () => {
    const f = fixture()
    const m1 = f.send('make the landing page dark')
    expect(f.project().leadWaiting).toEqual([{ id: m1, at: NOW }])
    expect(f.claim('mac')).toBe('start')
    expect(f.project().leadClaim).toMatchObject({ machineId: 'mac', at: NOW })
  })

  it('delivers the waiting message to the Lead that joins with a repo, and clears what waited', () => {
    const f = fixture()
    const m1 = f.send('make the landing page dark')
    f.claim('mac')
    const joined = f.join('h1', true)
    const agentId = joined.result.agentId as string
    expect(joined.lateDeliveries).toEqual([{ messageId: m1, conversationId: f.conversationId, agentId, lead: true,
      author: { kind: 'person', id: 'owner', generation: f.state.people[0]!.generation } }])
    expect(f.project().leadWaiting).toBeUndefined()
    expect(f.project().leadClaim).toBeUndefined()
    expect(f.project().repository).toMatchObject({ cwd: '/Users/huy/games' })
  })

  it('delivers the waiting message to the Lead that joins with no repo', () => {
    const f = fixture()
    const m1 = f.send('a scratch idea')
    f.claim('mac')
    const joined = f.join('h1', false)
    expect(joined.lateDeliveries?.map(d => d.messageId)).toEqual([m1])
    expect(f.project().repository).toBeUndefined()
  })

  it('starts one Lead for two quick sends: the second claim from another machine waits, and both messages reach the Lead', () => {
    const f = fixture()
    const m1 = f.send('first')
    expect(f.claim('mac')).toBe('start')
    const m2 = f.send('second')
    expect(f.claim('mini')).toBe('waiting')
    expect(f.project().leadClaim).toMatchObject({ machineId: 'mac' })
    expect(f.join('h1', false).lateDeliveries?.map(d => d.messageId)).toEqual([m1, m2])
  })

  it('lets the claiming machine claim again, and another machine once the claim is 10 minutes old', () => {
    const f = fixture()
    f.send('first')
    expect(f.claim('mac')).toBe('start')
    expect(f.claim('mac')).toBe('start')
    f.advance(9 * MINUTE)
    expect(f.claim('mini')).toBe('waiting')
    f.advance(MINUTE)
    expect(f.claim('mini')).toBe('start')
    expect(f.project().leadClaim).toMatchObject({ machineId: 'mini' })
  })

  it('never delivers a message that waited over 30 minutes, and keeps at most 20', () => {
    const f = fixture()
    f.send('old')
    f.advance(31 * MINUTE)
    const sent = Array.from({ length: 21 }, (_, i) => f.send(`new ${i}`))
    expect(f.project().leadWaiting?.map(w => w.id)).toEqual(sent.slice(1))
    expect(f.join('h1', false).lateDeliveries?.map(d => d.messageId)).toEqual(sent.slice(1))
  })

  it('keeps nothing once the chat has its Lead, and refuses a claim then', () => {
    const f = fixture()
    f.join('h1', false)
    f.send('hello')
    expect(f.project().leadWaiting).toBeUndefined()
    expect(refusal(() => f.claim('mac'))).toBe('LEAD_EXISTS')
  })
})

describe('a Team Swarm project chat with no Lead', () => {
  it('keeps nothing for a Lead and refuses the claim, so it still says Not sent', () => {
    const f = fixture(false)
    f.send('hello')
    expect(f.project().leadWaiting).toBeUndefined()
    expect(refusal(() => f.claim('mac'))).toBe('PERSONAL_SWARM_ONLY')
    expect(f.join('h1', false).lateDeliveries).toBeUndefined()
  })
})
