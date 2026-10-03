/** The collection's background reasoning uses its DSH's observed model, never the voice router. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { encodeRuntimeProfile, parseRuntimeProfile, type RuntimeProfile } from './modelProfile.js'
import type { OneShotOptions } from '../../../cli/src/lib/oneshot.js'
import type { PairOneShot } from '../companion/triage.js'
import type { StartupProfile } from '../companion/startupProfile.js'
import { runCodexMemoryInference } from '../memory/inference.js'
import { runClaudeMemoryInference } from '../memory/claudeInference.js'
import { memoryAccountIdentity } from '../memory/account.js'
import type { MemoryInference, MemoryInferenceRunOptions } from '../memory/learner.js'
import type { MemoryInferenceOptions } from '../memory/inferenceProcess.js'
import { MemoryError } from '../memory/types.js'
import type { InferenceWaitReason } from '../memory/inferenceStatus.js'
import { openCodeSnapshotIdentity, runOpenCodeMemoryInference,
  type OpenCodeMemorySnapshot, type OpenCodeMemoryInferenceOptions } from '../memory/opencodeInference.js'

export interface CompanionRuntime {
  agentId: string
  sessionId: string | null
  engine: string
  profile: string | null
  stopped: boolean
  codexHome?: string | null
  customProvider?: boolean
  nativeProcessKey?: string | null
  /** Opaque observed account identity, when supplied by the native host. */
  accountKey?: string | null
  startup?: StartupProfile | null
}

export interface IntelligenceStatus {
  state: 'off' | 'unopened' | 'waiting' | 'unsupported' | 'ready'
  agentId?: string
  engine?: string
  model?: string
  effort?: string
  contextKey?: string
  reason?: InferenceWaitReason
}

interface IntelligenceDeps {
  enabled: () => boolean
  current: () => CompanionRuntime | null
  directory: string
  stateFile: string
  run?: (engine: 'claude' | 'codex', options: MemoryInferenceOptions) => Promise<{ text: string }>
  accountIdentity?: (runtime: CompanionRuntime) => Promise<string | null>
  /** Volatile observation from the selected foreground process, with host consent checked on each read. */
  openCodeSnapshot?: (runtime: CompanionRuntime) => OpenCodeMemorySnapshot | null
  runOpenCode?: (options: OpenCodeMemoryInferenceOptions) => Promise<{ text: string }>
}

export class CompanionIntelligence {
  private saved: Record<string, { sessionId: string; profile: string }> | null = null
  private readonly calls = new Set<AbortController>()
  /** Volatile refusal for one observed connection. No credentials or policy failures are persisted. */
  private restrictedContext: string | null = null

  constructor(private readonly deps: IntelligenceDeps) {}

  status(): IntelligenceStatus { return this.target().status }
  async extractionStatus(): Promise<IntelligenceStatus> { return (await this.extractionTarget()).status }
  ready(): boolean { return this.status().state === 'ready' }

  /** Abort on experimental-off/account changes. No worker becomes a discoverable agent. */
  cancel(): void { for (const call of this.calls) call.abort(); this.calls.clear() }

  readonly run: PairOneShot = (prompt, opts) => this.execute(prompt, opts, false)
  readonly extract: MemoryInference['run'] = (prompt, opts) => this.execute(prompt, opts, true)

  private async execute(prompt: string, opts: Parameters<PairOneShot>[1] | MemoryInferenceRunOptions, extraction: boolean): Promise<string | null> {
    // Register before the account lookup: cancel() must cover startup as well as a running child.
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    opts.signal?.addEventListener('abort', abort, { once: true })
    if (opts.signal?.aborted) controller.abort()
    this.calls.add(controller)
    let target: ReturnType<CompanionIntelligence['target']> | undefined
    try {
      const bound = extraction || this.deps.current()?.engine === 'opencode'
      target = bound ? await this.extractionTarget() : this.target()
      if (controller.signal.aborted || !target.profile || !target.runtime || target.status.state !== 'ready') return null
      if (extraction && (!('contextKey' in opts) || opts.contextKey !== target.status.contextKey)) throw new MemoryError('inference_context_changed')
      const selected = target
      const { runtime, profile } = target
      const engine = runtime.engine as 'claude' | 'codex' | 'opencode'
      const assertAuthorized = (): void => {
        if (controller.signal.aborted) throw new MemoryError('inference_cancelled')
        if ('assertAuthorized' in opts) opts.assertAuthorized?.()
        if (this.target().status.contextKey !== selected.runtimeContextKey) throw new MemoryError('inference_context_changed')
      }
      if (bound) assertAuthorized()
      mkdirSync(this.deps.directory, { recursive: true, mode: 0o700 })
      const options: MemoryInferenceOptions = {
        prompt, cwd: this.deps.directory, model: profile.model,
        ...(profile.effort !== 'auto' ? { effort: profile.effort as OneShotOptions['effort'] } : {}),
        ...(engine === 'codex' && runtime.codexHome ? { codexHome: runtime.codexHome } : {}),
        timeoutMs: opts.timeoutMs, signal: controller.signal,
        ...(bound ? { assertAuthorized, beforeRun: async () => {
          const current = await this.extractionTarget()
          if (current.status.state !== 'ready' || current.status.contextKey !== selected.status.contextKey) throw new MemoryError('inference_context_changed')
        } } : {}),
      }
      const run = this.deps.run ?? ((engine, options) => engine === 'claude'
        ? runClaudeMemoryInference(options) : runCodexMemoryInference(options))
      const result = engine === 'opencode'
        ? await (this.deps.runOpenCode ?? runOpenCodeMemoryInference)({ ...options,
          expectedSnapshot: openCodeSnapshotIdentity(target.openCodeSnapshot!),
          readSnapshot: async () => this.target().openCodeSnapshot ?? null,
        })
        : await run(engine, options)
      const current = bound ? await this.extractionTarget() : this.target()
      // A result from an old model, account, or conversation is never accepted under the new one.
      if (controller.signal.aborted || current.status.state !== 'ready' ||
        current.runtime?.sessionId !== runtime.sessionId || current.profile?.id !== profile.id ||
        (!runtime.sessionId && current.runtime?.startup?.processKey !== runtime.startup?.processKey) ||
        current.runtime?.codexHome !== runtime.codexHome || current.status.contextKey !== target.status.contextKey) return null
      return result.text
    } catch (error) {
      if (error instanceof MemoryError && error.code === 'inference_provider_restricted'
        && !controller.signal.aborted && target?.runtime?.engine === 'opencode'
        && target.runtimeContextKey && this.target().status.contextKey === target.runtimeContextKey) {
        this.restrictedContext = target.runtimeContextKey
      }
      throw error
    } finally {
      opts.signal?.removeEventListener('abort', abort)
      this.calls.delete(controller)
    }
  }

  private async extractionTarget(): Promise<ReturnType<CompanionIntelligence['target']>> {
    const target = this.target()
    if (target.status.state !== 'ready' || !target.runtime) return target
    if (target.runtime.engine === 'opencode') return target
    const identity = target.runtime.accountKey ?? await (this.deps.accountIdentity ?? memoryAccountIdentity)(target.runtime)
    const current = this.target()
    if (current.status.contextKey !== target.status.contextKey) return current.status.state !== 'ready' ? current
      : { status: { ...current.status, state: 'waiting', reason: 'inference_context_changed' } }
    if (!identity) return { status: { ...current.status, state: 'waiting', reason: 'companion_account_unavailable' } }
    return { ...target, status: { ...target.status,
      contextKey: createHash('sha256').update(JSON.stringify([target.status.contextKey, identity])).digest('hex') } }
  }

  private target(): { status: IntelligenceStatus; runtimeContextKey?: string; runtime?: CompanionRuntime; profile?: RuntimeProfile;
    openCodeSnapshot?: OpenCodeMemorySnapshot } {
    if (!this.deps.enabled()) return { status: { state: 'off' } }
    const runtime = this.deps.current()
    if (!runtime) return { status: { state: 'unopened', reason: 'companion_unopened' } }
    const status: IntelligenceStatus = { state: 'waiting', agentId: runtime.agentId, engine: runtime.engine }
    // Custom provider credentials must not silently fall back to the local subscription.
    if (!['claude', 'codex', 'opencode'].includes(runtime.engine) || (runtime.customProvider && runtime.engine !== 'opencode')) {
      return { status: { ...status, state: 'unsupported', reason: 'companion_configuration_unsupported' } }
    }
    const openCodeSnapshot = runtime.engine === 'opencode' ? this.deps.openCodeSnapshot?.(runtime) ?? undefined : undefined
    if (runtime.engine === 'opencode') {
      if (runtime.stopped) return { status: { ...status, reason: 'companion_stopped' } }
      if (!runtime.sessionId || !runtime.nativeProcessKey) return { status: { ...status, reason: 'companion_starting' } }
      if (!runtime.accountKey || !openCodeSnapshot) return { status: { ...status, reason: 'companion_connection_unavailable' } }
    }
    if (!runtime.sessionId && (runtime.stopped || !runtime.startup)) {
      return { status: { ...status, reason: runtime.stopped ? 'companion_stopped' : 'companion_starting' } }
    }
    this.load()
    const cached = this.saved![runtime.agentId]
    const value = runtime.sessionId
      ? runtime.profile ?? (openCodeSnapshot ? encodeRuntimeProfile({ sessionId: runtime.agentId, engine: 'opencode', model: openCodeSnapshot.model, effort: 'auto' })
        : runtime.stopped && cached?.sessionId === runtime.sessionId ? cached.profile : null)
      : runtime.startup?.profile
    const profile = parseRuntimeProfile(value)
    const efforts = runtime.engine === 'claude'
      ? ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode']
      : runtime.engine === 'opencode' ? ['auto'] : ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
    if (!profile || profile.sessionId !== runtime.agentId || profile.engine !== runtime.engine || !efforts.includes(profile.effort)) {
      return { status: { ...status, reason: 'companion_model_unavailable' } }
    }
    if (openCodeSnapshot && openCodeSnapshot.model !== profile.model) return { status: { ...status, reason: 'inference_context_changed' } }
    // Pre-conversation readiness is live evidence, never a durable substitute for a conversation ID.
    if (runtime.sessionId && (cached?.profile !== profile.id || cached.sessionId !== runtime.sessionId)) {
      this.saved![runtime.agentId] = { sessionId: runtime.sessionId, profile: profile.id }
      mkdirSync(dirname(this.deps.stateFile), { recursive: true, mode: 0o700 })
      const tmp = `${this.deps.stateFile}.tmp`
      writeFileSync(tmp, JSON.stringify(this.saved), { mode: 0o600 })
      renameSync(tmp, this.deps.stateFile)
    }
    const contextKey = createHash('sha256').update(JSON.stringify([runtime.agentId, runtime.sessionId,
      runtime.sessionId ? null : runtime.startup?.processKey, runtime.engine, profile.id, runtime.codexHome ?? null, runtime.accountKey ?? null,
      runtime.nativeProcessKey ?? null, openCodeSnapshot ? openCodeSnapshotIdentity(openCodeSnapshot) : null])).digest('hex')
    if (this.restrictedContext !== contextKey) this.restrictedContext = null
    return { runtime, profile, openCodeSnapshot, runtimeContextKey: contextKey,
      status: { ...status, state: this.restrictedContext ? 'unsupported' : 'ready',
        ...(this.restrictedContext ? { reason: 'inference_provider_restricted' as const } : {}),
        model: profile.model, effort: openCodeSnapshot?.variant ?? profile.effort, contextKey } }
  }

  private load(): void {
    if (this.saved) return
    this.saved = Object.create(null) as Record<string, { sessionId: string; profile: string }>
    try {
      const raw: unknown = JSON.parse(readFileSync(this.deps.stateFile, 'utf8'))
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
      for (const [id, value] of Object.entries(raw)) {
        if (!value || typeof value !== 'object') continue
        const row = value as { sessionId?: unknown; profile?: unknown }
        if (typeof row.sessionId === 'string' && typeof row.profile === 'string' && parseRuntimeProfile(row.profile)?.sessionId === id) {
          this.saved[id] = { sessionId: row.sessionId, profile: row.profile }
        }
      }
    } catch { /* No selected model has been observed yet. */ }
  }
}
