import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { CREDENTIAL_MARKER } from './credentials.js'
import { createSuperTab, type Actor, type AgentConfiguration } from './model.js'

// Task #4540 (spec 2026-11-07-members-and-leads, build task 2): a project says what it is in one line, which the Cmd-N and
// join project list shows. Its owner or its Lead sets it, as they set the coordinator's name.
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const config: AgentConfiguration = { engine: 'codex', model: 'test-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }

function fixture() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: 1000, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const invited = run({ type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: 'lead' })
  run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, peer)
  const lead = run({ type: 'agent.add', conversationId: 'lead', machineId: 'host', harnessId: 'lead', name: 'lead', configuration: config, lead: true },
    owner, { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }).result.agentId as string
  const asLead: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }
  return { run, asLead, get state() { return state } }
}

const about = (text: string): Command => ({ type: 'project.about', projectId: 'lead', about: text })

describe('project.about', () => {
  it('is set by the project owner and by its Lead, trimmed, and cleared by an empty line', () => {
    const f = fixture()
    f.run(about('  The Harness app and Swarm  '))
    expect(f.state.projects![0]!.about).toBe('The Harness app and Swarm')
    f.run(about('Ships the Swarm'), f.asLead)
    expect(f.state.projects![0]!.about).toBe('Ships the Swarm')
    f.run(about('   '))
    expect(f.state.projects![0]).not.toHaveProperty('about')
  })

  it('refuses anyone else', () => {
    const f = fixture()
    expect(() => f.run(about('Mine now'), peer)).toThrow(expect.objectContaining({ code: 'PROJECT_OWNER_REQUIRED' }))
  })

  it('is one line of at most 80 characters', () => {
    const f = fixture()
    f.run(about('x'.repeat(80)))
    expect(() => f.run(about('x'.repeat(81)))).toThrow()
    expect(() => f.run(about('Two\nlines'))).toThrow()
    expect(f.state.projects![0]!.about).toBe('x'.repeat(80))
  })

  it('never stores a credential pasted into it', () => {
    const f = fixture()
    // Assembled at run time from obviously fake parts, never a credential-shaped literal.
    const token = ['ghp', 'Fixture0Token1Not2Real3Value4abcdefgh'].join('_')
    f.run(about(`Deploys with ${token}`))
    expect(f.state.projects![0]!.about).toBe(`Deploys with ${CREDENTIAL_MARKER}`)
    expect(JSON.stringify(f.state)).not.toContain(token)
  })
})
