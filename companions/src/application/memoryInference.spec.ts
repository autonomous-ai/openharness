import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { companionMemoryInference } from './memoryInference.js'
import { CompanionIntelligence, type CompanionRuntime } from './intelligence.js'
import { CodingMemoryStore } from '../memory/store.js'
import { MemoryLearner } from '../memory/learner.js'
import { QUEUE_OPERATIONS, type MemoryPort, type Operation, type Arguments, type Result } from '../memory/operations.js'
import { MemoryError } from '../memory/types.js'
import type { InferenceWaitReason } from '../memory/inferenceStatus.js'

it('waits for a certified selected Codex runtime and preserves foreground priority', async () => {
  const intelligence = { extractionStatus: async () => ({ state: 'ready' as const, agentId: 'companion', engine: 'codex', contextKey: 'selected' }),
    extract: vi.fn(async () => '{"proposals":[]}') }
  const capability = vi.fn(async () => ({ supported: false, version: 'untested' }))
  let busy = true
  const foreground = vi.fn((id: string) => id === 'companion' && busy)
  const inference = companionMemoryInference(intelligence, foreground, capability)
  expect(await inference.target()).toEqual({ state: 'unsupported', reason: 'codex_version_uncertified' })
  expect(intelligence.extract).not.toHaveBeenCalled()
  capability.mockResolvedValue({ supported: true, version: '0.159.0' })
  expect(await inference.target()).toEqual({ state: 'ready', key: 'selected', foregroundBusy: true })
  expect(foreground).toHaveBeenLastCalledWith('companion')
  busy = false
  expect((await inference.target()).foregroundBusy).toBe(false)
  const options = { signal: new AbortController().signal, timeoutMs: 1000, contextKey: 'selected' }
  expect(await inference.run('evidence', options)).toBe('{"proposals":[]}')
  expect(intelligence.extract).toHaveBeenCalledExactlyOnceWith('evidence', options)
})

it('uses only the selected companion for foreground priority and waits when that binding is missing', async () => {
  const busyIds = new Set(['other-local-agent', 'remote-agent'])
  let agentId: string | undefined = 'companion'
  const capability = vi.fn(async () => ({ supported: true, version: '0.159.0' }))
  const inference = companionMemoryInference({ extractionStatus: async () => ({ state: 'ready', agentId,
    engine: 'codex', contextKey: 'selected' }), extract: async () => null }, id => busyIds.has(id), capability)
  expect((await inference.target()).foregroundBusy).toBe(false)
  busyIds.add('companion')
  expect((await inference.target()).foregroundBusy).toBe(true)
  agentId = undefined
  capability.mockClear()
  expect(await inference.target()).toEqual({ state: 'waiting' })
  expect(capability).not.toHaveBeenCalled()
})

it('checks OpenCode native compatibility without probing a different engine', async () => {
  const claude = vi.fn(), codex = vi.fn()
  const opencode = vi.fn(async () => ({ supported: false, version: '2.0.0' }))
  const inference = companionMemoryInference({ extractionStatus: async () => ({ state: 'ready', agentId: 'companion',
    engine: 'opencode', contextKey: 'native-binding' }), extract: async () => null }, () => false, codex, claude, opencode)
  expect(await inference.target()).toEqual({ state: 'unsupported', reason: 'opencode_version_uncertified' })
  opencode.mockResolvedValue({ supported: true, version: '1.18.34' })
  expect(await inference.target()).toEqual({ state: 'ready', key: 'native-binding', foregroundBusy: false })
  expect(codex).not.toHaveBeenCalled(); expect(claude).not.toHaveBeenCalled()
})

it.each<InferenceWaitReason>(['companion_unopened', 'companion_stopped', 'companion_starting',
  'companion_connection_unavailable', 'companion_model_unavailable', 'companion_account_unavailable',
  'companion_configuration_unsupported', 'inference_context_changed'])(
  'preserves %s without probing native versions or running extraction', async reason => {
    const capability = vi.fn(), extract = vi.fn()
    const inference = companionMemoryInference({ extractionStatus: async () => ({ state: 'waiting', reason }), extract },
      () => false, capability, capability, capability)
    expect(await inference.target()).toEqual({ state: 'waiting', reason })
    expect(capability).not.toHaveBeenCalled()
    expect(extract).not.toHaveBeenCalled()
  })

it('reports an unsupported Claude version as compatibility, not missing setup', async () => {
  const capability = vi.fn(async () => ({ supported: false, version: 'unverified' }))
  const inference = companionMemoryInference({ extractionStatus: async () => ({ state: 'ready', agentId: 'companion',
    engine: 'claude', contextKey: 'binding' }), extract: vi.fn() }, () => false, vi.fn(), capability, vi.fn())
  expect(await inference.target()).toEqual({ state: 'unsupported', reason: 'claude_version_uncertified' })
})

it('preserves queued evidence and stops calls and native probes after a refusal, then resumes on a new connection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'memory-refusal-'))
  let now = 10_000
  const opened = CodingMemoryStore.open({ directory: join(directory, 'store'), profileId: 'owner', now: () => now })
  if (!opened.ok) throw new Error(opened.reason)
  const store = opened.store
  try {
    store.registerProject('project')
    store.setControls({ learn: true, recall: true })
    store.learning.capture({ streamId: 'stream', engine: 'codex', sessionId: 'coding-session', projectId: 'project',
      episodeId: 'episode', from: null, to: '1', boundary: 'complete', events: [{
        id: 'source', profileId: 'owner', projectId: 'project', engine: 'codex', sessionId: 'coding-session',
        nativeEventId: 'source', role: 'user', eligibility: 'coding', observedAt: now, rootIds: ['source'],
        text: 'Use SQLite for the synthetic offline project.',
      }] })
    const memory: MemoryPort = { async request<K extends Operation>(operation: K, args: Arguments<K>): Promise<Result<K>> {
      const owner = (QUEUE_OPERATIONS as readonly string[]).includes(operation) ? store.learning : store
      return (owner as unknown as Record<string, (...args: unknown[]) => unknown>)[operation].apply(owner, args) as Result<K>
    } }
    let runtime: CompanionRuntime = { agentId: 'companion', sessionId: 'companion-session', engine: 'opencode',
      stopped: false, nativeProcessKey: 'process-a', accountKey: 'synthetic-owner', profile: null }
    const run = vi.fn(async () => ({ text: '{"proposals":[]}' }))
    run.mockRejectedValueOnce(new MemoryError('inference_provider_restricted'))
    const intelligence = new CompanionIntelligence({ enabled: () => true, current: () => runtime,
      directory: join(directory, 'work'), stateFile: join(directory, 'model.json'), runOpenCode: run,
      openCodeSnapshot: () => ({ model: 'selected/model', auth: { type: 'api', key: 'synthetic-account' },
        provider: { npm: '@ai-sdk/openai-compatible', models: { model: {} } } }),
    })
    const capability = vi.fn(async () => ({ supported: true, version: '1.18.34' }))
    const inference = companionMemoryInference(intelligence, () => false, vi.fn(), vi.fn(), capability)
    const learner = new MemoryLearner(memory, inference)
    const refused = { state: 'waiting_for_model', reason: 'inference_provider_restricted' }
    expect(await learner.tick()).toEqual(refused)
    expect(capability).toHaveBeenCalledOnce()
    for (const elapsed of [0, 60_001, 3_600_001]) {
      now += elapsed
      expect(await learner.tick()).toEqual(refused)
      expect(run).toHaveBeenCalledOnce()
      expect(capability).toHaveBeenCalledOnce()
      expect(store.learning.status().jobs).toEqual({ waiting_for_model: 1 })
      expect(store.source('source', { profileId: 'owner', projectIds: ['project'], includeProfile: false })?.text)
        .toBe('Use SQLite for the synthetic offline project.')
    }
    runtime = { ...runtime, nativeProcessKey: 'process-b' }
    expect(await learner.tick()).toEqual({ state: 'no_useful_memory', learned: 0 })
    expect(run).toHaveBeenCalledTimes(2)
    expect(store.learning.status().jobs).toEqual({ no_useful_memory: 1 })
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})
