import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, SuperTabError, type Actor, type SuperTabState } from './model.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const config = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }
const own = { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }

function swarm() {
  let state: SuperTabState = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: 1_000 + sequence, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const pm = run({ type: 'agent.add', conversationId: 'lead', machineId: 'mac', harnessId: 'h-pm', name: 'Faye', lead: true, configuration: config } as Command,
    owner, own).result.agentId as string
  const asPm: Actor = { kind: 'agent', agentId: pm, machineOwnerId: 'owner' }
  return { run, asPm, get state() { return state } }
}
const code = (body: () => unknown) => {
  try { body(); return null } catch (error) { return error instanceof SuperTabError ? error.code : String(error) }
}
const post = (conversationId: string, text: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'message.send', conversationId, text, replyTo: null, recipientIds: [], ...extra }) as Command

// Swarm v4 (anh Dee, 2026-11-08): a project's channel is agents only. People read it and talk to their own agents; the app
// only hid the composer, so an older app or the phone still posted there (ken15 in # lamp, 2026-11-09). The server refuses it.
describe('a project\'s channel', () => {
  it('refuses a person\'s post, in the channel and in its threads', () => {
    const f = swarm()
    expect(code(() => f.run(post('lead', 'Can you look at this?')))).toBe('AGENTS_ONLY')
    const said = f.run(post('lead', 'Plan for today.'), f.asPm).messages.find(m => m.text === 'Plan for today.')!
    expect(code(() => f.run(post('lead', 'Me too', { replyTo: said.id }), owner,
      { reply: { id: said.id, conversationId: 'lead', author: { kind: 'agent', id: f.asPm.kind === 'agent' ? f.asPm.agentId : '' },
        createdAt: 1_000, thread: null, threadSource: null } } as Partial<CommandContext>))).toBe('AGENTS_ONLY')
  })

  it('takes its agents\' posts', () => {
    const f = swarm()
    expect(f.run(post('lead', 'Shipped #12.'), f.asPm).messages.map(m => m.text)).toContain('Shipped #12.')
  })

  it('leaves a person\'s own chat with their agent to them', () => {
    const f = swarm()
    const chat = f.run({ type: 'agent.new', kind: 'regular', name: 'Ada', machineId: 'mac', engine: 'claude', local: true } as Command, owner, own)
      .result.conversationId as string
    expect(code(() => f.run(post(chat, 'Fix the docs')))).toBeNull()
  })
})
