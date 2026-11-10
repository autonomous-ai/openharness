import { describe, expect, it } from 'vitest'
import { applyCommand, type Command } from './commands.js'
import { CREDENTIAL_MARKER } from './credentials.js'
import { createSuperTab, type Actor } from './model.js'

// Task #3595 (Inventory Table A #4): a join-link token was logged in #2480. Whatever an agent posts, in its project's channel
// or in the 1:1 chat with its person, is stored with every credential in it removed, a bare join or link token too.

/** Deterministic noise, assembled at run time: the repository holds nothing a scanner could take for a real secret. */
function noise(length: number, seed: number, alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'): string {
  let out = '', x = seed
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0
    out += alphabet[(x >>> 16) % alphabet.length]
  }
  return out
}
/** A join or link token as sharing.ts makes one: 32 random bytes as base64url, 43 characters. */
const linkToken = (seed: number) => noise(43, seed)
const SECRETS = {
  'a GitHub token': ['ghp', noise(36, 12).replace(/[-_]/g, 'Q')].join('_'),
  'a bare join token': linkToken(31),
  // About 1 in 1,500 has no digit.
  'a bare join token with no digit': noise(43, 35, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_'),
  'a percent-encoded join link': `harness%3A%2F%2Fswarm%2Fjoin%2Fc51479bd73b59e58176ad9e4%3Ftoken%3D${linkToken(33)}`,
}

/** A Swarm with one project and its PM, on its person's own machine (Swarm v4), and the PM's channel and own chat. */
function fixture() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: 'owner@example.com' }, 'prod')
  let next = 0
  const owner: Actor = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
  const run = (command: Command, actor: Actor = owner) => {
    const effects = applyCommand(state, actor, command, { operationId: `op${next++}`, now: 1000, contribution: { machineOwnerId: 'owner', contributorId: 'owner' } })
    state = effects.state
    return effects
  }
  const channel = (run({ type: 'project.create', name: 'App', visibility: 'public', brief: '' }).result as { conversationId: string }).conversationId
  const pm = run({ type: 'agent.add', conversationId: channel, harnessId: 'pm', machineId: 'mac', name: 'pm', lead: true,
    configuration: { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null } }).result.agentId as string
  const chat = state.conversations.find(c => c.kind === 'agent-chat' && c.agentIds.includes(pm))!.id
  const post = (conversationId: string, text: string) => run({ type: 'message.send', conversationId, text, replyTo: null, recipientIds: [] },
    { kind: 'agent', agentId: pm, machineOwnerId: 'owner' })
  return { channel, chat, post }
}

describe('an agent\'s post with a credential in it', () => {
  for (const [what, secret] of Object.entries(SECRETS)) {
    it(`is stored without ${what}, in its project's channel and in its own chat`, () => {
      const f = fixture()
      for (const conversationId of [f.channel, f.chat]) {
        const sent = f.post(conversationId, `Here it is: ${secret} (for the deploy)`)
        const post = sent.messages.find(m => m.conversationId === conversationId && !m.source)!
        expect(post.text, conversationId).toMatch(new RegExp(`^Here it is: .*${CREDENTIAL_MARKER.replace(/[[\]]/g, '\\$&')} \\(for the deploy\\)$`))
        expect(JSON.stringify(sent.messages), conversationId).not.toContain(secret.slice(-20))
        expect(sent.result.credentialNotice).toMatch(/Revoke or rotate it/)
      }
    })
  }

  it('keeps commit ids, message ids, UUIDs, pull request links and names made of words', () => {
    const f = fixture()
    for (const text of ['Ready for review at c474d81d7ccad7edeaba906169aa577d77e537ea: https://github.com/autonomous-ai/openharness/pull/3286',
      'Answered message 5b6396a89b995dece38076d1 in 68147b53127efbff8fd66147.', 'Request d86c8a35-9192-4459-8ac6-55dac1abe72a failed once; retried.',
      // A 43-character name made of words, as a branch or a test is named.
      'Renamed to feature-Add-OAuth2-login-for-mobile-clients today.']) {
      for (const conversationId of [f.channel, f.chat]) expect(f.post(conversationId, text).messages.find(m => !m.source)!.text).toBe(text)
    }
  })
})
