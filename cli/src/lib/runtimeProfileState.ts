/** Eager state/control owner; native interpretation is supplied by engine facets. */
import { parseRuntimeProfile } from './runtimeProfileWire.js'
export { parseRuntimeProfile } from './runtimeProfileWire.js'
import type { RegisteredSession } from './registry.js'
import type { RuntimeFor, RuntimeProfile, RuntimeModelOption, RuntimeState, RuntimeField, RuntimeControl, RuntimeCatalogModel } from '../engines/facets/runtime.js'
import type { InlineRuntimeContext, InlineRuntimeReader } from '../engines/facets/inlineRuntime.js'
export type { RuntimeProfile, RuntimeModelOption, RuntimeState, RuntimeField } from '../engines/facets/runtime.js'
import { encodeRuntimeProfile, record, stripAnsi, transcriptFields, RUNTIME_EFFORTS } from '../engines/kit/runtime.js'
export { encodeRuntimeProfile, runtimeModelLabel } from '../engines/kit/runtime.js'
import { engineNow, isOtherEngine, loadEngine } from '../engines/inProcess.js'
import { processIdentityKey } from './terminalRuntime.js'

const blankState = (): RuntimeState => ({ model: null, effort: null, mode: 'unknown', cliVersion: null, observedAt: null })

/** Where a session's runtime state starts before its transcript is read. */
function freshState(session: RegisteredSession): RuntimeState {
  return {
    ...blankState(),
    // Registries written by older builds can hold a non-string model; treat it as unknown instead of
    // letting it reach claudeAliasForModel and abort startup.
    model: typeof session.model === 'string' ? session.model : null,
    cliVersion: session.cliVersion,
  }
}

interface StateWaiter {
  check: () => boolean
  resolve: (matched: boolean) => void
  timer: NodeJS.Timeout
}

const EFFORTS = RUNTIME_EFFORTS
const CHANGE_DEBOUNCE_MS = 120
const readIdentity = (session: RegisteredSession): string => JSON.stringify([session.agentId, session.sessionId,
  session.engine, session.cwd, session.transcriptPath, session.codexHome, session.hermesHome,
  session.model, session.cliVersion, session.boundAt, session.tmuxPane, session.primaryRuntimeKey, session.runtimes,
  session.active, session.evidenceRevision, !!session.identityHold, session.processIdentity ? processIdentityKey(session.engine, session.processIdentity) : undefined])
const copyControl = (control: RuntimeControl | undefined): RuntimeControl | undefined => control && {
  ...control, target: { ...control.target },
}

export class RuntimeProfileState {
  constructor(private readonly runtimeFor: RuntimeFor,
    private readonly resolve?: (agentId: string) => RegisteredSession | undefined) {}
  private readonly states = new Map<string, RuntimeState>()
  private readonly controls = new Map<string, RuntimeControl>()
  private readonly waiters = new Map<string, Set<StateWaiter>>()
  private readonly changeTimers = new Map<string, NodeJS.Timeout>()
  private readonly readers = new Map<string, InlineRuntimeReader>()
  private readonly failedReaders = new Set<string>()
  private readonly versions = new WeakMap<RuntimeState, number>()
  private readonly configReads = new WeakMap<RuntimeState, object>()
  private suppressNotifications = 0
  onChanged: ((sessionId: string) => void) | null = null

  private version(state: RuntimeState): number { return this.versions.get(state) ?? 0 }
  private accepted(state: RuntimeState): void { this.versions.set(state, this.version(state) + 1) }
  private authoritative(state: RuntimeState): void {
    this.accepted(state)
    // Core confirmation/control revokes queued reads as well as reads already in flight.
    this.configReads.set(state, {})
  }
  private currentSession(session: RegisteredSession, identity = readIdentity(session)): RegisteredSession | undefined {
    const current = this.resolve ? this.resolve(session.agentId) : session
    return current && !current.identityHold && readIdentity(current) === identity && readIdentity(session) === identity ? current : undefined
  }

  private observe(context: InlineRuntimeContext): InlineRuntimeContext {
    // A repeated authoritative value is still newer evidence. Track writes, not value differences;
    // ignored transcript records must not starve a pending config read during a long answer.
    const track = <T extends object>(value: T): T => new Proxy(value, { set: (target, key, next) => {
      this.accepted(context.state)
      return Reflect.set(target, key, next)
    } })
    return { ...context, state: track(context.state), control: context.control && track(context.control) }
  }

  private keep(engine: string, module: { createRuntimeProfileReader?: () => InlineRuntimeReader }): InlineRuntimeReader | null {
    const existing = this.readers.get(engine)
    if (existing) return existing
    if (this.failedReaders.has(engine)) return null
    try {
      const reader = module.createRuntimeProfileReader?.()
      if (!reader || reader.engine !== engine) throw new Error('runtime reader is missing or belongs to another engine')
      this.readers.set(engine, reader)
      return reader
    } catch (error) {
      this.failedReaders.add(engine)
      console.warn(`[runtime-profile] ${engine} reader unavailable:`, error instanceof Error ? error.message : String(error))
      return null
    }
  }

  private readerNow(engine: string): InlineRuntimeReader | null {
    if (!isOtherEngine(engine)) return null
    const module = engineNow(engine, 'its profile was read')
    if (!module) return null
    return this.keep(engine, module)
  }

  private async reader(engine: string): Promise<InlineRuntimeReader | null> {
    if (!isOtherEngine(engine)) return null
    const module = await loadEngine(engine)
    if (!module) return null
    return this.keep(engine, module)
  }

  private context(session: RegisteredSession, silent: boolean): InlineRuntimeContext {
    const state = this.state(session.sessionId)
    const identity = readIdentity(session)
    return { session, state, control: this.controls.get(session.sessionId),
      refreshConfig: (override) => {
        const read = this.configReads.get(state)
        // Finish accepting the synchronous observation before starting its dependent config read.
        queueMicrotask(() => {
          if (this.states.get(session.sessionId) === state && this.currentSession(session, identity)
            && this.configReads.get(state) === read) {
            void this.ingestConfig(session, override ?? silent).catch(() => undefined)
          }
        })
      } }
  }

  private observed(session: RegisteredSession, before: string | null, silent: boolean): boolean {
    const after = this.selectedModel(session)
    this.wake(session.sessionId)
    if (!silent && this.suppressNotifications === 0 && before !== after && !this.controls.has(session.sessionId)) this.scheduleChanged(session.sessionId)
    return before !== after
  }

  ingest(session: RegisteredSession, rawLine: string, silent = false): boolean {
    const current = this.currentSession(session)
    if (!current) return false
    session = current
    let raw: Record<string, unknown> | null
    try { raw = record(JSON.parse(rawLine)) } catch { return false }
    if (!raw) return false
    const before = this.selectedModel(session)
    const runtime = this.runtimeFor(session.engine)
    const context = this.observe(this.context(session, silent))
    if (runtime) runtime.transcript(context, raw)
    else this.readerNow(session.engine)?.transcript?.(context, raw)
    return this.observed(session, before, silent)
  }

  ingestPane(session: RegisteredSession, paneText: string, silent = false): boolean {
    const current = this.currentSession(session)
    if (!current) return false
    session = current
    const before = this.selectedModel(session)
    const runtime = this.runtimeFor(session.engine)
    const context = this.observe(this.context(session, silent))
    const text = stripAnsi(paneText)
    if (runtime) runtime.pane(context, text)
    else if (this.readerNow(session.engine)?.pane?.(context, text) === false) return false
    return this.observed(session, before, silent)
  }

  /** Capture and consume one observation under the binding and authority that requested it. */
  async capturePane(session: RegisteredSession, capture: (id: string, historyLines?: number) => Promise<string | null>,
    historyLines?: number, silent = false): Promise<string | null> {
    if (this.unbound(session.sessionId) || !this.currentSession(session)) return null
    const id = session.sessionId, identity = readIdentity(session)
    const state = this.state(id), version = this.version(state)
    const text = await capture(session.agentId, historyLines)
    if (!text || this.states.get(id) !== state || this.version(state) !== version || !this.currentSession(session, identity)) return null
    this.ingestPane(session, text, silent)
    return text
  }

  async ingestConfig(session: RegisteredSession, silent = false): Promise<boolean> {
    if (this.unbound(session.sessionId) || !this.currentSession(session)) return false
    const state = this.state(session.sessionId), version = this.version(state)
    const identity = readIdentity(session), token = {}
    const control = this.controls.get(session.sessionId)
    this.configReads.set(state, token)
    const current = () => this.states.get(session.sessionId) === state && this.version(state) === version
      && this.configReads.get(state) === token && !!this.currentSession(session, identity)
      && this.controls.get(session.sessionId) === control
    const runtime = this.runtimeFor(session.engine)
    const reader = runtime ? null : await this.reader(session.engine)
    if (!current() || (!runtime?.configuredEffort && !reader?.config)) return false
    const before = this.selectedModel(session)
    const context = { ...this.context(session, silent), session: { ...session }, state: { ...state }, control: copyControl(control) }
    if (runtime?.configuredEffort) {
      context.state.effort = await runtime.configuredEffort(context.session)
      context.state.observedAt = Date.now()
    } else if (!await reader!.config!(context)) return false
    // An optional reader cannot publish into a forgotten/rebound row or replace newer evidence.
    if (!current()) return false
    Object.assign(state, context.state)
    if (control) Object.assign(control, context.control)
    this.accepted(state)
    return this.observed(session, before, silent)
  }

  supportsControl(session: RegisteredSession): boolean {
    return !session.gateway && (this.runtimeFor(session.engine)?.supportsControl(session) ?? false)
  }

  effortAllowed(session: RegisteredSession, model: string, effort: string, listed: readonly string[] | null): boolean {
    return this.runtimeFor(session.engine)?.effortAllowed?.(model, effort, listed) ?? false
  }

  hydrate(session: RegisteredSession, rawLines: string[]): void {
    if (this.unbound(session.sessionId) || !this.currentSession(session)) return
    this.states.set(session.sessionId, freshState(session))
    for (const line of rawLines) this.ingest(session, line, true)
  }

  beginHydrate(session: RegisteredSession): {
    ingest(rawLine: string): void
    commit(): void
    config?(): Promise<void>
    commitWith?(install: () => boolean): boolean
  } {
    const previous = this.state(session.sessionId), version = this.version(previous)
    const identity = readIdentity(session), control = this.controls.get(session.sessionId)
    const stagedSession = { ...session }, stagedControl = copyControl(control)
    const staged = freshState(session)
    let committed = false, failed = false
    const current = () => !committed && !failed && !this.unbound(session.sessionId)
      && this.states.get(session.sessionId) === previous && this.version(previous) === version
      && !!this.currentSession(session, identity) && this.controls.get(session.sessionId) === control
    const commitWith = (install: () => boolean): boolean => {
      if (!current() || !install()) return false
      committed = true
      this.currentSession(session, identity)!.cliVersion = stagedSession.cliVersion
      if (control) Object.assign(control, stagedControl)
      this.states.set(session.sessionId, staged)
      this.wake(session.sessionId)
      return true
    }
    return {
      ingest: (rawLine) => {
        if (!current()) return
        let raw: Record<string, unknown> | null
        try { raw = record(JSON.parse(rawLine)) } catch { return }
        if (!raw) return
        this.runtimeFor(stagedSession.engine)?.transcript({ session: stagedSession, state: staged, control: stagedControl }, raw)
      },
      config: async () => {
        if (!current()) return
        try {
          const runtime = this.runtimeFor(stagedSession.engine)
          if (runtime?.configuredEffort) {
            staged.effort = await runtime.configuredEffort(stagedSession)
            staged.observedAt = Date.now()
          } else if (!runtime) {
            const reader = await this.reader(stagedSession.engine)
            if (current()) await reader?.config?.({ session: stagedSession, state: staged, control: stagedControl, refreshConfig: () => {} })
          }
        } catch (error) { failed = true; throw error }
      },
      commitWith,
      commit: () => { commitWith(() => true) },
    }
  }

  transcriptFields(session: RegisteredSession, rawLine: string): RuntimeField[] {
    return transcriptFields(this.runtimeFor(session.engine), session, rawLine)
  }

  getState(sessionId: string): RuntimeState {
    return { ...this.state(sessionId) }
  }

  async withoutChangeEvents<T>(operation: () => Promise<T>): Promise<T> {
    this.suppressNotifications++
    try { return await operation() } finally { this.suppressNotifications-- }
  }

  selectedModel(session: RegisteredSession): string | null {
    if (this.unbound(session.sessionId)) return null
    const state = this.states.get(session.sessionId)
    if (!state?.model) return null
    const adapter = this.runtimeFor(session.engine)
    if (adapter) return adapter.selectedModel(session, state)
    const model = state.model
    const effort = state.effort
    if (!effort) return null
    return encodeRuntimeProfile({
      sessionId: session.agentId,
      engine: session.engine,
      model,
      effort,
    })
  }

  beginControl(session: RegisteredSession, target: RuntimeProfile): boolean {
    if (this.controls.has(session.sessionId)) return false
    const before = this.selectedModel(session)
    const current = parseRuntimeProfile(before)
    this.controls.set(session.sessionId, {
      target,
      before,
      modelConfirmed: current?.model === target.model,
      effortConfirmed: current?.effort === target.effort,
    })
    this.authoritative(this.state(session.sessionId))
    return true
  }

  cancelControl(sessionId: string): void {
    const control = this.controls.get(sessionId)
    this.controls.delete(sessionId)
    const state = this.states.get(sessionId)
    if (state) this.authoritative(state)
    this.wake(sessionId)
    if (control) this.scheduleChanged(sessionId)
  }

  finishControl(session: RegisteredSession): void {
    this.controls.delete(session.sessionId)
    const state = this.states.get(session.sessionId)
    if (state) this.authoritative(state)
    this.wake(session.sessionId)
    this.scheduleChanged(session.sessionId)
  }

  confirmEffort(sessionId: string, effort: string): void {
    if (!EFFORTS.has(effort)) return
    const state = this.state(sessionId)
    state.effort = effort
    state.observedAt = Date.now()
    this.authoritative(state)
    const control = this.controls.get(sessionId)
    if (control) control.effortConfirmed = control.target.effort === effort
    this.wake(sessionId)
  }

  confirmControlProfile(target: RuntimeProfile): void {
    const state = this.state(target.sessionId)
    state.model = target.model
    state.effort = target.effort
    state.observedAt = Date.now()
    this.authoritative(state)
    const control = this.controls.get(target.sessionId)
    if (control?.target.id === target.id) {
      control.modelConfirmed = true
      control.effortConfirmed = true
    }
    this.wake(target.sessionId)
  }

  waitForModel(sessionId: string, timeoutMs: number): Promise<boolean> {
    return this.waitFor(sessionId, () => this.controls.get(sessionId)?.modelConfirmed === true, timeoutMs)
  }

  waitForProfile(sessionId: string, timeoutMs: number): Promise<boolean> {
    return this.waitFor(sessionId, () => {
      const control = this.controls.get(sessionId)
      return control?.modelConfirmed === true && control.effortConfirmed === true
    }, timeoutMs)
  }

  forget(sessionId: string): void {
    this.states.delete(sessionId)
    this.controls.delete(sessionId)
    const timer = this.changeTimers.get(sessionId)
    if (timer) clearTimeout(timer)
    this.changeTimers.delete(sessionId)
    for (const waiter of this.waiters.get(sessionId) ?? []) {
      clearTimeout(waiter.timer)
      waiter.resolve(false)
    }
    this.waiters.delete(sessionId)
    // Native cleanup is optional and cannot interrupt the caller's eager tail/input/turn cleanup.
    const readers = [...this.readers.values()]
    queueMicrotask(() => {
      if (this.states.has(sessionId)) return
      for (const reader of readers) {
        try { reader.forget?.(sessionId) }
        catch (error) { console.warn(`[runtime-profile] ${reader.engine} cleanup failed:`, error instanceof Error ? error.message : String(error)) }
      }
    })
  }

  async modelsForSessions(sessions: RegisteredSession[]): Promise<RuntimeModelOption[]> {
    const groups = await Promise.all(sessions.map((session) => this.modelsForSession(session)))
    return groups.flat()
  }

  async modelsForSession(session: RegisteredSession): Promise<RuntimeModelOption[]> {
    // Display-only through a gateway: the empty catalogue IS the mechanism (see the note above), so web
    // renders a static chip and the device picker closes instead of offering a list we cannot enumerate.
    if (session.gateway) return []
    return this.runtimeFor(session.engine)?.models(session, this.states.get(session.sessionId)) ?? []
  }

  private unbound(sessionId: string): boolean {
    return !sessionId
  }

  private state(sessionId: string): RuntimeState {
    if (this.unbound(sessionId)) return blankState()
    let state = this.states.get(sessionId)
    if (!state) {
      state = blankState()
      this.states.set(sessionId, state)
    }
    return state
  }

  async codexCatalog(session: RegisteredSession): Promise<RuntimeCatalogModel[]> {
    return this.runtimeFor(session.engine)?.catalog?.(session) ?? []
  }

  private scheduleChanged(sessionId: string): void {
    const previous = this.changeTimers.get(sessionId)
    if (previous) clearTimeout(previous)
    this.changeTimers.set(sessionId, setTimeout(() => {
      this.changeTimers.delete(sessionId)
      if (!this.controls.has(sessionId)) this.onChanged?.(sessionId)
    }, CHANGE_DEBOUNCE_MS))
  }

  private waitFor(sessionId: string, check: () => boolean, timeoutMs: number): Promise<boolean> {
    if (check()) return Promise.resolve(true)
    return new Promise((resolve) => {
      const waiter: StateWaiter = {
        check,
        resolve,
        timer: setTimeout(() => {
          this.waiters.get(sessionId)?.delete(waiter)
          resolve(false)
        }, timeoutMs),
      }
      const set = this.waiters.get(sessionId) ?? new Set<StateWaiter>()
      set.add(waiter)
      this.waiters.set(sessionId, set)
    })
  }

  private wake(sessionId: string): void {
    const set = this.waiters.get(sessionId)
    if (!set) return
    for (const waiter of [...set]) {
      if (!waiter.check()) continue
      clearTimeout(waiter.timer)
      set.delete(waiter)
      waiter.resolve(true)
    }
    if (set.size === 0) this.waiters.delete(sessionId)
  }

  cursorTarget(sessionId: string, profileId: string) {
    const reader = this.readerNow('cursor')
    return reader?.engine === 'cursor' ? reader.target(sessionId, profileId) : null
  }

  devinTarget(sessionId: string, profileId: string) {
    const reader = this.readerNow('devin')
    return reader?.engine === 'devin' ? reader.target(sessionId, profileId) : null
  }

  hermesTarget(sessionId: string, profileId: string) {
    const reader = this.readerNow('hermes')
    return reader?.engine === 'hermes' ? reader.target(sessionId, profileId) : null
  }

  commandcodeTarget(sessionId: string, profileId: string) {
    const reader = this.readerNow('commandcode')
    return reader?.engine === 'commandcode' ? reader.target(sessionId, profileId) : null
  }

  async opencodeCatalog() {
    const reader = await this.reader('opencode')
    return reader?.engine === 'opencode' ? reader.catalog() : []
  }

  async kiloCatalog() {
    const reader = await this.reader('kilo')
    return reader?.engine === 'kilo' ? reader.catalog() : []
  }

}
