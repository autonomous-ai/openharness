import { expect, it } from 'vitest'
import { OpenCodeMemoryBinding, type OpenCodeMemoryOwner } from './opencodeBinding.js'

const snapshot = { model: 'selected/model', variant: 'high', auth: { type: 'api', key: 'synthetic-account-a' },
  provider: { npm: '@ai-sdk/openai-compatible', models: { model: { name: 'Selected', limit: { context: 10000, output: 1000 } } } } }
function world() {
  let owner: OpenCodeMemoryOwner | null = { ownerKey: 'owner', agentId: 'companion', sessionId: 'native', processKey: 'process-one', model: 'selected/model' }
  let now = 100
  const binding = new OpenCodeMemoryBinding({ current: () => owner, now: () => now })
  const actor = { agentId: owner.agentId, sessionId: owner.sessionId, processKey: owner.processKey }
  const observe = (value: unknown = snapshot) => {
    const { challenge } = binding.receive(actor, { kind: 'probe' })
    return binding.receive(actor, { kind: 'observe', challenge, nativeVersion: '1.18.34', snapshot: value })
  }
  return { binding, actor, observe, owner: () => owner!, set: (next: OpenCodeMemoryOwner | null) => { owner = next }, advance: (ms: number) => { now += ms } }
}

it('requires a one-use process-owned handshake and does not return credentials to the hook', () => {
  const w = world()
  expect(w.binding.read(w.actor)).toBeNull()
  const grant = w.binding.receive(w.actor, { kind: 'probe' })
  const payload = { kind: 'observe', challenge: grant.challenge, nativeVersion: '1.18.34', snapshot }
  expect(w.binding.receive(w.actor, payload)).toEqual({ observe: true, recorded: true })
  expect(w.binding.receive(w.actor, payload)).toEqual({ observe: false })
  expect(w.binding.read(w.actor)).toEqual(snapshot)
  w.binding.read(w.actor)!.auth.key = 'mutated-caller-copy'
  expect(w.binding.read(w.actor)!.auth.key).toBe('synthetic-account-a')
})

it('keeps identical native credentials bound to the Harness owner who authorized them', () => {
  const w = world(); w.observe()
  const before = w.binding.identity(w.actor)
  expect(before).toMatch(/^[a-f0-9]{64}$/)
  w.set({ ...w.owner(), ownerKey: 'replacement-owner' })
  expect(w.binding.identity(w.actor)).toBeNull()
  w.observe()
  expect(w.binding.identity(w.actor)).not.toBe(before)
})

it.each(['ownerKey', 'agentId', 'sessionId', 'processKey'] as const)('withdraws credentials and pending grants after %s changes', field => {
  const w = world(); w.observe()
  const grant = w.binding.receive(w.actor, { kind: 'probe' })
  w.set({ ...w.owner(), [field]: 'replacement' })
  expect(w.binding.read(w.actor)).toBeNull()
  expect(w.binding.receive(w.actor, { kind: 'observe', challenge: grant.challenge, nativeVersion: '1.18.34', snapshot })).toEqual({ observe: false })
})

it('refuses another process/session without erasing the selected companion binding', () => {
  const w = world(); w.observe()
  expect(w.binding.receive({ ...w.actor, sessionId: 'subagent' }, { kind: 'probe' })).toEqual({ observe: false })
  expect(w.binding.read(w.actor)).toEqual(snapshot)
})

it('withdraws on off/consent loss and does not resurrect credentials when reenabled', () => {
  const w = world(); w.observe(); const owner = w.owner()
  w.set(null)
  expect(w.binding.read(w.actor)).toBeNull()
  w.set(owner)
  expect(w.binding.read(w.actor)).toBeNull()
  expect(w.observe()).toEqual({ observe: true, recorded: true })
  w.binding.clear()
  expect(w.binding.read(w.actor)).toBeNull()
})

it('withdraws a changed model and waits for a matching native request', () => {
  const w = world(); w.observe()
  w.set({ ...w.owner(), model: 'changed/model' })
  expect(w.binding.read(w.actor)).toBeNull()
  expect(w.observe()).toEqual({ observe: false })
  w.set({ ...w.owner(), model: null })
  expect(w.binding.read(w.actor)).toBeNull()
  w.observe()
  expect(w.binding.read(w.actor)).toEqual(snapshot)
})

it('expires grants and observations, and withdraws old credentials before an unsupported new request', () => {
  const w = world()
  const grant = w.binding.receive(w.actor, { kind: 'probe' })
  w.advance(5000)
  expect(w.binding.receive(w.actor, { kind: 'observe', challenge: grant.challenge, nativeVersion: '1.18.34', snapshot })).toEqual({ observe: false })
  w.observe(); w.advance(15 * 60_000)
  expect(w.binding.read(w.actor)).toBeNull()
  w.observe()
  expect(w.observe({ ...snapshot, auth: { type: 'oauth', access: 'unsupported' } })).toEqual({ observe: false })
  expect(w.binding.read(w.actor)).toBeNull()
})
