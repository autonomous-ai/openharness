import { describe, expect, it } from 'vitest'
import { declaredHttpClient, refusalLogFields } from './refusalLog.js'

/** Ken's prod scan (11-04): 615 agent.configuration refusals in 32 minutes, and the log could not say whose. Each refusal now
 *  names its Swarm, the agent it names or acts as, and the client that sent it, never what the command says. */
describe('refusal log', () => {
  it('names the Swarm, the agent a host acts as, and the CLI and its version', () => {
    const client = declaredHttpClient({ 'user-agent': 'node', 'x-harness-client': 'cli/0.5.34' })
    expect(refusalLogFields('tab1', { type: 'agent.configuration' }, 'AGENT_UNAVAILABLE', { asAgentId: 'agent7', client, machineId: 'm1' }))
      .toEqual({ code: 'AGENT_UNAVAILABLE', type: 'agent.configuration', tabId: 'tab1', agentId: 'agent7', asAgent: true,
        client: 'cli', version: '0.5.34', machineId: 'm1' })
  })

  it('names the agent a command names over the one it acts as', () => {
    const fields = refusalLogFields('tab1', { type: 'agent.alert', agentId: 'agent9' }, 'AGENT_UNAVAILABLE',
      { asAgentId: 'agent7', client: declaredHttpClient({}) })
    expect(fields.agentId).toBe('agent9')
    expect(fields.asAgent).toBe(true)
  })

  it('a person’s message: no agent, the app by its user agent, and none of its words', () => {
    const command = { type: 'message.send', conversationId: 'g1', text: 'secret plan for ken@example.com', recipientIds: ['a1'] }
    const fields = refusalLogFields('tab1', command, 'NOT_FOUND', { client: declaredHttpClient({ 'user-agent': 'Dart/3.13 (dart:io)' }) })
    expect(fields).toEqual({ code: 'NOT_FOUND', type: 'message.send', tabId: 'tab1', agentId: null, asAgent: false, client: 'app', version: null })
    expect(JSON.stringify(fields)).not.toMatch(/secret|ken@example|g1|a1/)
  })

  it('a declared client is believed only in its own shape', () => {
    expect(declaredHttpClient({ 'x-harness-client': 'cli/0.5.34' })).toEqual({ kind: 'cli', version: '0.5.34' })
    expect(declaredHttpClient({ 'x-harness-client': 'desktop/1.3.57' })).toEqual({ kind: 'desktop', version: '1.3.57' })
    for (const bad of ['cli', 'robot/1.0', 'cli/1.0 <script>', `cli/${'9'.repeat(60)}`, ['cli/1.0', 'cli/2.0']]) {
      expect(declaredHttpClient({ 'user-agent': 'node', 'x-harness-client': bad })).toEqual({ kind: 'cli', version: null })
    }
    expect(declaredHttpClient({ 'user-agent': 'Mozilla/5.0' })).toEqual({ kind: 'web', version: null })
    expect(declaredHttpClient({})).toEqual({ kind: 'other', version: null })
  })
})
