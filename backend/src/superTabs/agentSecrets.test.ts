import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { CREDENTIAL_MARKER, findCredentials } from './credentials.js'
import { createSuperTab, type Actor } from './model.js'

// Task #3595 (Inventory Table A #4, anh Dee 11-06: checkable rules run as code): a join-link token was logged in #2480. An
// agent's text that holds a credential is refused before anything is stored, naming its kind and never its value. People's own
// posts keep today's redaction. Ordinary agent text (commit ids, message ids, UUIDs, pull request links) passes.

// Assembled at run time from obviously fake parts, as credentials.test.ts does: the repository holds nothing a scanner could
// take for a real secret.
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
function noise(length: number, alphabet: string, seed: number): string {
  let out = '', x = seed
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0
    out += alphabet[(x >>> 16) % alphabet.length]
  }
  return out
}
/** A join or link token as sharing.ts makes one: 32 random bytes as base64url, 43 characters. */
const joinToken = (seed = 31) => `Aa1${noise(40, `${ALNUM}-_`, seed)}`
const SECRETS = {
  'a GitHub token': () => ['ghp', noise(36, ALNUM, 12)].join('_'),
  'a bare join token': () => joinToken(),
  'a join link': () => `harness://swarm/join/c51479bd73b59e58176ad9e4?token=${joinToken(33)}`,
}
const ORDINARY = [
  'Ready for review at c474d81d7ccad7edeaba906169aa577d77e537ea: https://github.com/autonomous-ai/openharness/pull/3286',
  'Answered message 5b6396a89b995dece38076d1 in 68147b53127efbff8fd66147.',
  'Request d86c8a35-9192-4459-8ac6-55dac1abe72a failed once; retried.',
]

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }
const asAgent = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'owner' })

function fixture() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let next = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { operationId: `op${next++}`, now: 1000,
      contribution: { machineOwnerId: 'owner', contributorId: 'owner' }, ...context })
    state = effects.state
    return effects
  }
  const app = run({ type: 'project.create', name: 'App', visibility: 'public', brief: '' }).result as { projectId: string; conversationId: string }
  const add = (harnessId: string, lead: boolean) => run({ type: 'agent.add', conversationId: app.conversationId, harnessId, machineId: 'machine', name: harnessId,
    lead, configuration }).result.agentId as string
  const pm = add('pm', true), worker = add('worker', false)
  const group = run({ type: 'conversation.create', projectId: app.projectId, title: 'Copy', brief: '', checks: [{ description: 'It works', independent: false }] }).result.conversationId as string
  const assignmentId = run({ type: 'work.assign', conversationId: group, agentId: worker }).result.assignmentId as string
  const checkId = state.conversations.find(c => c.id === group)!.checks[0]!.id
  // A task no one is assigned, whose task text an agent may rewrite.
  const open = run({ type: 'conversation.create', projectId: app.projectId, title: 'Docs', brief: '', checks: [] }).result.conversationId as string
  /** Each agent text path, with [text] where its words go. */
  const paths: Record<string, (text: string) => Command> = {
    'message.send': text => ({ type: 'message.send', conversationId: group, text, replyTo: null, recipientIds: [] }),
    'work.status result': text => ({ type: 'work.status', conversationId: group, assignmentId, status: 'working', result: text }),
    'work.check evidence': text => ({ type: 'work.check', conversationId: group, assignmentId, checkId, passed: true, evidence: text }),
    'conversation.create task': text => ({ type: 'conversation.create', projectId: app.projectId, title: 'Follow-up', priority: 'P2', requesterId: 'owner',
      task: { goal: text, changes: 'None', constraints: 'None', owns: ['docs/'] }, checks: [{ description: 'Done', independent: false }] }),
    'work.define task': text => ({ type: 'work.define', conversationId: open, task: { goal: 'Do it', changes: text, constraints: 'None', owns: ['docs/'] }, checks: [] }),
    'person.tell': text => ({ type: 'person.tell', personId: 'owner', text }),
    'decision.ask': text => ({ type: 'decision.ask', conversationId: group, personId: 'owner',
      questions: [{ question: text, options: ['Yes', 'No'], recommended: 0, unblocks: 'The release' }] }),
    // SecAlder's security review 1 of #3310: a needs_human question's options and what it unblocks are text too.
    'work.status ask options': text => ({ type: 'work.status', conversationId: group, assignmentId, status: 'needs_human', result: 'Which key?',
      ask: { personId: 'owner', options: [text, 'Another'], recommended: 0, unblocks: 'The deploy' } }),
    'work.status ask unblocks': text => ({ type: 'work.status', conversationId: group, assignmentId, status: 'needs_human', result: 'Which key?',
      ask: { personId: 'owner', options: ['A', 'B'], recommended: 0, unblocks: text } }),
  }
  return { run, paths, pm, worker, group, get state() { return state } }
}

describe('an agent\'s text with a credential in it', () => {
  it('is refused on every text path, naming its kind and never its value', () => {
    for (const [name, secret] of Object.entries(SECRETS)) {
      const f = fixture()
      for (const [path, command] of Object.entries(f.paths)) {
        const value = secret()
        const before = JSON.stringify(f.state)
        let error: unknown
        try { f.run(command(`Here it is: ${value} (for the deploy)`), asAgent(f.worker)) } catch (e) { error = e }
        expect(error, `${path}, ${name}`).toMatchObject({ code: 'SECRET_LIKE', status: 400 })
        const said = JSON.stringify(error) + String((error as Error).message)
        expect(said, `${path}, ${name}: the refusal echoes the value`).not.toContain(value)
        expect((error as Error).message, `${path}, ${name}`).toMatch(/token|password|secret|key/i)
        expect(JSON.stringify(f.state), `${path}, ${name}: something was stored`).toBe(before)
      }
    }
  })

  it('passes ordinary agent text: commit ids, message and task ids, UUIDs and pull request links', () => {
    for (const text of ORDINARY) {
      const f = fixture()
      for (const [path, command] of Object.entries(f.paths)) {
        expect(() => f.run(command(text), asAgent(f.worker)), `${path}: ${text}`).not.toThrow()
      }
    }
  })
})

describe('a person\'s own post with a credential in it', () => {
  it('is redacted as before, not refused', () => {
    const f = fixture()
    const value = SECRETS['a GitHub token']()
    const sent = f.run(f.paths['message.send']!(`My token is ${value}`))
    expect(sent.messages.find(m => !m.source)!.text).toContain(CREDENTIAL_MARKER)
    expect(JSON.stringify(sent.messages)).not.toContain(value)
    expect(sent.result.credentialNotice).toMatch(/GitHub token/)
  })
})

describe('the bare join or link token', () => {
  it('is found as its own kind, and an id an agent posts is not', () => {
    expect(findCredentials(`token ${joinToken()} here`).map(f => f.kind)).toEqual(['link-token'])
    for (const text of ORDINARY) expect(findCredentials(text), text).toEqual([])
  })
})
