import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CompanionIntelligence, type CompanionRuntime } from './intelligence.js'
import { encodeRuntimeProfile } from '../../../cli/src/lib/runtimeProfile.js'
import type { OneShotOptions } from '../../../cli/src/lib/oneshot.js'
import { openCodeSnapshotIdentity, type OpenCodeMemorySnapshot, type OpenCodeMemoryInferenceOptions } from '../memory/opencodeInference.js'
import { MemoryError } from '../memory/types.js'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'collection-model-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

function world() {
  let enabled = true
  let runtime: CompanionRuntime | null = { agentId: 'collection', sessionId: 'session-1', engine: 'claude', stopped: false,
    profile: encodeRuntimeProfile({ sessionId: 'collection', engine: 'claude', model: 'opus', effort: 'high' }) }
  const run = vi.fn<(engine: 'claude' | 'codex', options: OneShotOptions) => Promise<{ text: string }>>(async () => ({ text: '{"lesson":null}' }))
  const deps = { enabled: () => enabled, current: () => runtime, run, directory, stateFile: join(directory, 'model.json') }
  return { brain: new CompanionIntelligence(deps), deps, run,
    off: () => { enabled = false }, set: (next: CompanionRuntime | null) => { runtime = next }, get: () => runtime! }
}

describe('the collection DSH supplies its intelligence', () => {
  it('inherits the exact observed engine, model, effort and changes with the model picker', async () => {
    const w = world()
    expect(w.brain.status()).toMatchObject({ state: 'ready', model: 'opus', effort: 'high' })
    await w.brain.run('review evidence', { timeoutMs: 1000, signal: new AbortController().signal })
    expect(w.run).toHaveBeenLastCalledWith('claude', expect.objectContaining({ model: 'opus', effort: 'high', prompt: 'review evidence' }))
    w.set({ ...w.get(), engine: 'codex', codexHome: '/profiles/collection', profile: encodeRuntimeProfile({ sessionId: 'collection', engine: 'codex', model: 'gpt-test', effort: 'xhigh' }) })
    await w.brain.run('more evidence', { timeoutMs: 1000, signal: new AbortController().signal })
    expect(w.run).toHaveBeenLastCalledWith('codex', expect.objectContaining({ model: 'gpt-test', effort: 'xhigh', codexHome: '/profiles/collection' }))
  })

  it('keeps an observed profile across idle pause and daemon restart, only for the same conversation', () => {
    const w = world()
    w.brain.status()
    w.set({ ...w.get(), stopped: true, profile: null })
    expect(new CompanionIntelligence(w.deps).status()).toMatchObject({ state: 'ready', model: 'opus' })
    w.set({ ...w.get(), sessionId: 'another-conversation' })
    expect(new CompanionIntelligence(w.deps).status().state).toBe('waiting')
    expect(readFileSync(w.deps.stateFile, 'utf8')).not.toContain('prompt')
  })

  it('can review before the first message with live startup evidence, without persisting a fake conversation', async () => {
    const w = world()
    const startup = { processKey: 'live-process-1', profile: w.get().profile! }
    w.set({ ...w.get(), sessionId: '', profile: null, startup })
    expect(w.brain.status()).toMatchObject({ state: 'ready', model: 'opus' })
    expect(await w.brain.run('evidence', { timeoutMs: 1000, signal: new AbortController().signal })).toBe('{"lesson":null}')
    expect(existsSync(w.deps.stateFile)).toBe(false)
    w.set({ ...w.get(), stopped: true })
    expect(new CompanionIntelligence(w.deps).status().state).toBe('waiting')
    w.set({ ...w.get(), stopped: false, startup: null })
    expect(w.brain.status().state).toBe('waiting')
  })

  it('rejects an unbound review result from a replaced process even with the same agent and model', async () => {
    const w = world(), startup = { processKey: 'live-process-1', profile: w.get().profile! }
    w.set({ ...w.get(), sessionId: '', profile: null, startup })
    let finish!: (result: { text: string }) => void
    w.run.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const result = w.brain.run('evidence', { timeoutMs: 1000, signal: new AbortController().signal })
    w.set({ ...w.get(), startup: { ...startup, processKey: 'live-process-2' } })
    finish({ text: 'old answer' })
    expect(await result).toBeNull()
  })

  it('does not guess a model from another agent, setup, unsupported credentials, or a missing DSH', async () => {
    const w = world()
    w.set({ ...w.get(), profile: encodeRuntimeProfile({ sessionId: 'other-agent', engine: 'claude', model: 'haiku', effort: 'low' }) })
    expect(w.brain.status().state).toBe('waiting')
    w.set({ ...w.get(), sessionId: null })
    expect(await w.brain.run('x', { timeoutMs: 100, signal: new AbortController().signal })).toBeNull()
    w.set({ ...w.get(), sessionId: 'session-1', customProvider: true })
    expect(w.brain.status().state).toBe('unsupported')
    w.set(null)
    expect(w.brain.status().state).toBe('unopened')
    w.off()
    expect(w.brain.status().state).toBe('off')
    expect(w.run).not.toHaveBeenCalled()
  })

  it('does not apply a result after the collection is turned off or its model changes', async () => {
    const w = world()
    let resolve!: (result: { text: string }) => void
    w.run.mockImplementation(() => new Promise(done => { resolve = done }))
    const result = w.brain.run('evidence', { timeoutMs: 1000, signal: new AbortController().signal })
    w.off(); w.brain.cancel()
    resolve({ text: 'old answer' })
    expect(await result).toBeNull()
    expect(w.run.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })

  it('binds extraction to the selected runtime and rejects a changed observed account', async () => {
    const w = world()
    w.set({ ...w.get(), accountKey: 'first-account' })
    const before = w.brain.status().contextKey
    let finish!: (result: { text: string }) => void
    w.run.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const contextKey = (await w.brain.extractionStatus()).contextKey!
    const pending = w.brain.extract('coding evidence only', { timeoutMs: 1000, signal: new AbortController().signal, contextKey })
    await vi.waitFor(() => expect(w.run).toHaveBeenCalledWith('claude', expect.objectContaining({ prompt: 'coding evidence only', model: 'opus', effort: 'high' })))
    w.set({ ...w.get(), accountKey: 'second-account' })
    expect(w.brain.status().contextKey).not.toBe(before)
    finish({ text: 'result from the previous account' })
    expect(await pending).toBeNull()
  })

  it('rechecks native account metadata after extraction, including a new login at the same path', async () => {
    const w = world()
    let account: string | null = 'native-account-1'
    const brain = new CompanionIntelligence({ ...w.deps, accountIdentity: async () => account })
    const before = (await brain.extractionStatus()).contextKey
    let finish!: (result: { text: string }) => void
    w.run.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const pending = brain.extract('evidence', { timeoutMs: 1000, signal: new AbortController().signal, contextKey: before! })
    await vi.waitFor(() => expect(w.run).toHaveBeenCalledOnce())
    account = 'native-account-2'
    expect((await brain.extractionStatus()).contextKey).not.toBe(before)
    finish({ text: 'answer from old account' })
    expect(await pending).toBeNull()
    account = null
    expect(await brain.extractionStatus()).toMatchObject({ state: 'waiting', reason: 'companion_account_unavailable' })
    expect(await brain.extract('evidence', { timeoutMs: 1000, signal: new AbortController().signal, contextKey: before! })).toBeNull()
    expect(w.run).toHaveBeenCalledOnce()
  })

  it('distinguishes unopened, starting, missing model and unsupported configuration without guessing credentials', async () => {
    const w = world()
    w.set(null)
    expect(w.brain.status()).toEqual({ state: 'unopened', reason: 'companion_unopened' })
    w.set({ agentId: 'collection', engine: 'claude', stopped: false, sessionId: null, profile: null })
    expect(w.brain.status()).toMatchObject({ state: 'waiting', reason: 'companion_starting' })
    w.set({ ...w.get(), sessionId: 'session' })
    expect(w.brain.status()).toMatchObject({ state: 'waiting', reason: 'companion_model_unavailable' })
    w.set({ ...w.get(), customProvider: true })
    expect(w.brain.status()).toMatchObject({ state: 'unsupported', reason: 'companion_configuration_unsupported' })
    expect(w.run).not.toHaveBeenCalled()
  })

  it('cancels while the native account lookup is pending without launching extraction', async () => {
    const w = world()
    let finish!: (value: string) => void
    const account = new Promise<string>(resolve => { finish = resolve })
    const brain = new CompanionIntelligence({ ...w.deps,
      accountIdentity: () => account })
    const pending = brain.extract('synthetic evidence', { timeoutMs: 1000, signal: new AbortController().signal, contextKey: 'cancelled-before-binding' })
    brain.cancel()
    finish('account-before-cancellation')
    expect(await pending).toBeNull()
    expect(w.run).not.toHaveBeenCalled()
  })

  it('does not send a leased prompt after the selected extraction context changes', async () => {
    const w = world()
    w.set({ ...w.get(), accountKey: 'first-account' })
    const contextKey = (await w.brain.extractionStatus()).contextKey!
    w.set({ ...w.get(), accountKey: 'replacement-account' })
    const options = { timeoutMs: 1000, signal: new AbortController().signal, contextKey }
    await expect(w.brain.extract('synthetic evidence from the original lease', options)).rejects.toThrow('inference_context_changed')
    expect(w.run).not.toHaveBeenCalled()
  })
})

describe('OpenCode companion request binding', () => {
  function openCodeWorld() {
    const w = world()
    w.set({ ...w.get(), engine: 'opencode', nativeProcessKey: 'native-process', accountKey: 'harness-owner-binding', profile: null, customProvider: true })
    let snapshot: OpenCodeMemorySnapshot | null = { model: 'selected/model', variant: 'high',
      auth: { type: 'api', key: 'synthetic-selected-account' }, provider: {
        npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://selected.invalid/v1' },
        models: { model: { name: 'Selected', limit: { context: 10000, output: 1000 } } },
      } }
    const run = vi.fn<(options: OpenCodeMemoryInferenceOptions) => Promise<{ text: string }>>(async options => {
      await options.beforeRun?.(); options.assertAuthorized?.()
      return { text: '{"proposals":[]}' }
    })
    const accountIdentity = vi.fn(async () => 'must-not-fall-back')
    const brain = new CompanionIntelligence({ ...w.deps, openCodeSnapshot: () => snapshot, runOpenCode: run, accountIdentity })
    return { ...w, brain, openCodeRun: run, accountIdentity, snapshot: () => snapshot!, setSnapshot: (value: OpenCodeMemorySnapshot | null) => { snapshot = value } }
  }

  it('distinguishes a stopped companion from an unobserved live connection without starting either', async () => {
    const w = openCodeWorld()
    w.set({ ...w.get(), stopped: true })
    expect(await w.brain.extractionStatus()).toMatchObject({ state: 'waiting', reason: 'companion_stopped' })
    w.set({ ...w.get(), stopped: false })
    w.setSnapshot(null)
    expect(await w.brain.extractionStatus()).toMatchObject({ state: 'waiting', reason: 'companion_connection_unavailable' })
    expect(w.openCodeRun).not.toHaveBeenCalled()
    expect(w.accountIdentity).not.toHaveBeenCalled()
  })

  it('uses the foreground model/account/variant for extraction and ordinary companion intelligence', async () => {
    const w = openCodeWorld()
    expect(w.brain.status()).toMatchObject({ state: 'ready', engine: 'opencode', model: 'selected/model', effort: 'high' })
    const contextKey = (await w.brain.extractionStatus()).contextKey!
    expect(await w.brain.extract('coding evidence', { contextKey, timeoutMs: 1000, signal: new AbortController().signal })).toBe('{"proposals":[]}')
    expect(w.openCodeRun).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'selected/model', expectedSnapshot: openCodeSnapshotIdentity(w.snapshot()) }))
    expect(await w.openCodeRun.mock.calls[0][0].readSnapshot()).toEqual(w.snapshot())
    await w.brain.run('companion triage', { timeoutMs: 1000, signal: new AbortController().signal })
    expect(w.openCodeRun).toHaveBeenCalledTimes(2)
    expect(w.run).not.toHaveBeenCalled()
    expect(w.accountIdentity).not.toHaveBeenCalled()
    expect(readFileSync(w.deps.stateFile, 'utf8')).not.toContain('synthetic-selected-account')
  })

  it('waits for live observation, never falling back to another provider or saved OpenCode profile', async () => {
    const w = openCodeWorld()
    w.brain.status()
    w.setSnapshot(null)
    expect(w.brain.status().state).toBe('waiting')
    expect(await w.brain.run('triage', { timeoutMs: 1000, signal: new AbortController().signal })).toBeNull()
    w.set({ ...w.get(), stopped: true })
    expect(w.brain.status().state).toBe('waiting')
    expect(w.openCodeRun).not.toHaveBeenCalled()
    expect(w.run).not.toHaveBeenCalled()
  })

  it.each(['model', 'account', 'process', 'owner'] as const)('holds a provider refusal until the selected %s changes', async change => {
    const w = openCodeWorld(), contextKey = (await w.brain.extractionStatus()).contextKey!
    const options = { contextKey, timeoutMs: 1000, signal: new AbortController().signal }
    w.openCodeRun.mockRejectedValueOnce(new MemoryError('inference_provider_restricted'))
    await expect(w.brain.extract('synthetic evidence', options)).rejects.toThrow('inference_provider_restricted')
    expect(await w.brain.extractionStatus()).toMatchObject({ state: 'unsupported', reason: 'inference_provider_restricted', contextKey })
    expect(await w.brain.extract('same queued evidence', options)).toBeNull()
    expect(await w.brain.run('background triage', options)).toBeNull()
    const savedSnapshot = w.snapshot()
    w.setSnapshot(null)
    expect(w.brain.status().state).toBe('waiting')
    w.setSnapshot(structuredClone(savedSnapshot))
    expect(w.brain.status().state).toBe('unsupported')
    expect(w.openCodeRun).toHaveBeenCalledOnce()
    expect(w.run).not.toHaveBeenCalled()
    expect(readFileSync(w.deps.stateFile, 'utf8')).not.toContain('inference_provider_restricted')
    if (change === 'model') w.setSnapshot({ ...w.snapshot(), model: 'selected/another',
      provider: { ...w.snapshot().provider, models: { another: { name: 'Another', limit: { context: 10000, output: 1000 } } } } })
    if (change === 'account') w.setSnapshot({ ...w.snapshot(), auth: { type: 'api', key: 'replacement' } })
    if (change === 'process') w.set({ ...w.get(), nativeProcessKey: 'new-process' })
    if (change === 'owner') w.set({ ...w.get(), accountKey: 'new-owner' })
    const next = await w.brain.extractionStatus()
    expect(next.state).toBe('ready')
    expect(next.contextKey).not.toBe(contextKey)
    expect(await w.brain.extract('synthetic evidence', { ...options, contextKey: next.contextKey! })).toBe('{"proposals":[]}')
    expect(w.openCodeRun).toHaveBeenCalledTimes(2)
  })

  it('does not apply a late refusal to a replacement connection', async () => {
    const w = openCodeWorld(), contextKey = (await w.brain.extractionStatus()).contextKey!
    let fail!: (error: Error) => void
    w.openCodeRun.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    const pending = w.brain.extract('synthetic evidence', { contextKey, timeoutMs: 1000, signal: new AbortController().signal })
    const assertion = expect(pending).rejects.toThrow('inference_provider_restricted')
    await vi.waitFor(() => expect(w.openCodeRun).toHaveBeenCalledOnce())
    w.set({ ...w.get(), nativeProcessKey: 'replacement-process' })
    fail(new MemoryError('inference_provider_restricted'))
    await assertion
    expect((await w.brain.extractionStatus()).state).toBe('ready')
  })

  it('rejects a queued extraction after the observed account changes', async () => {
    const w = openCodeWorld(), contextKey = (await w.brain.extractionStatus()).contextKey!
    w.setSnapshot({ ...w.snapshot(), auth: { type: 'api', key: 'replacement-account' } })
    await expect(w.brain.extract('leased evidence', { contextKey, timeoutMs: 1000, signal: new AbortController().signal })).rejects.toThrow('inference_context_changed')
    expect(w.openCodeRun).not.toHaveBeenCalled()
  })

  it.each(['account', 'variant', 'process', 'owner', 'off'] as const)('discards a running extraction after %s changes', async change => {
    const w = openCodeWorld(), contextKey = (await w.brain.extractionStatus()).contextKey!
    let finish!: (value: { text: string }) => void
    w.openCodeRun.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const result = w.brain.extract('evidence', { contextKey, timeoutMs: 1000, signal: new AbortController().signal })
    await vi.waitFor(() => expect(w.openCodeRun).toHaveBeenCalledOnce())
    if (change === 'account') w.setSnapshot({ ...w.snapshot(), auth: { type: 'api', key: 'replacement' } })
    if (change === 'variant') w.setSnapshot({ ...w.snapshot(), variant: 'low' })
    if (change === 'process') w.set({ ...w.get(), nativeProcessKey: 'new-native-process' })
    if (change === 'owner') w.set({ ...w.get(), accountKey: 'replacement-harness-owner-binding' })
    if (change === 'off') w.off()
    await expect(w.openCodeRun.mock.calls[0][0].beforeRun!()).rejects.toThrow('inference_context_changed')
    finish({ text: 'old-context-answer' })
    expect(await result).toBeNull()
  })
})
