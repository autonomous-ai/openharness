/** Core-owned profile snapshots and transactions. Vendor interpretation happens only in the worker. */
import type { RuntimeAnswer, RuntimeOperation } from '../../engines/worker/runtimeProtocol.js'
import { RUNTIME_RECORDS, RUNTIME_REQUEST_BYTES, RUNTIME_WAIT_MS } from '../../engines/worker/runtimeProtocol.js'
import type { RuntimeContext, RuntimeControl, RuntimeProfile, RuntimeRecord, RuntimeSession, RuntimeState } from '../../engines/facets/runtime.js'
import { blankRuntimeState, encodeRuntimeProfile, RUNTIME_EFFORTS } from '../../engines/kit/runtime.js'
import { EngineReadError } from '../../engines/worker/protocol.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { transcriptReadIdentity } from '../transcripts/readIdentity.js'
import { parseRuntimeProfile } from '../../lib/runtimeProfileWire.js'
import type { RuntimeTransport } from './runtimeTransport.js'

interface View {
  agentId: string
  sessionId: string
  identity: string
  revision: number
  state: RuntimeState
  control?: RuntimeControl
  selected: string | null
}
interface Waiter { check(): boolean; resolve(value: boolean): void; timer: ReturnType<typeof setTimeout> }
export interface RuntimeSessionDeps {
  resolve(id: string): RegisteredSession | undefined
  transport: RuntimeTransport
  changed?(sessionId: string): void
}
export interface RuntimeStage {
  ingest(records: readonly RuntimeRecord[]): Promise<void>
  config(): Promise<void>
  /** Atomically install the associated live parser and its reported profile. */
  commit(install?: () => boolean): boolean
}

const binding = (s: RegisteredSession | undefined): string => s ? JSON.stringify([transcriptReadIdentity(s), s.cwd, !!s.gateway]) : ''
const snapshot = (s: RegisteredSession): RuntimeSession => ({ agentId: s.agentId, sessionId: s.sessionId, engine: s.engine,
  model: typeof s.model === 'string' ? s.model : null, cliVersion: s.cliVersion, cwd: s.cwd, transcriptPath: s.transcriptPath, codexHome: s.codexHome })
const controlCopy = (control: RuntimeControl | undefined): RuntimeControl | undefined => control && { ...control, target: { ...control.target } }
const unavailable = (): never => { throw new EngineReadError('ENGINE_STALE_REPLY') }

export function createRuntimeSessions(deps: RuntimeSessionDeps) {
  const views = new Map<string, View>()
  const queues = new Map<string, Promise<void>>()
  const pending = new Map<string, number>()
  const changes = new Map<string, ReturnType<typeof setTimeout>>()
  const waiters = new Map<string, Set<Waiter>>()
  let suppressed = 0
  let stopped = false

  const valid = (view: View): boolean => !stopped && views.get(view.agentId) === view && view.identity === binding(deps.resolve(view.agentId))
  const wake = (id: string): void => {
    for (const waiter of waiters.get(id) ?? []) if (waiter.check()) {
      clearTimeout(waiter.timer); waiters.get(id)!.delete(waiter); waiter.resolve(true)
    }
    if (!waiters.get(id)?.size) waiters.delete(id)
  }
  const forget = (id: string): void => {
    if (!id) return
    const view = [...views.values()].find(v => v.sessionId === id || v.agentId === id)
    if (view) { view.revision++; views.delete(view.agentId) }
    const sid = view?.sessionId ?? id
    const timer = changes.get(sid)
    if (timer) clearTimeout(timer)
    changes.delete(sid)
    for (const waiter of waiters.get(sid) ?? []) { clearTimeout(waiter.timer); waiter.resolve(false) }
    waiters.delete(sid)
  }
  const viewFor = (s: RegisteredSession): View => {
    const previous = views.get(s.agentId)
    const identity = binding(s)
    // A delayed caller holding the old binding must not evict a newer accepted view.
    if (stopped || identity !== binding(deps.resolve(s.agentId))) unavailable()
    if (previous?.identity === identity) return previous
    if (previous) forget(previous.agentId)
    const view: View = { agentId: s.agentId, sessionId: s.sessionId, identity, revision: 0, state: blankRuntimeState(), selected: null }
    views.set(s.agentId, view)
    return view
  }
  const byId = (id: string): View | undefined => {
    if (!id) return undefined
    const session = deps.resolve(id)
    if (!session) return undefined
    const view = views.get(session.agentId)
    return view && valid(view) ? view : undefined
  }
  const notify = (view: View): void => {
    if (!view.sessionId) return
    const old = changes.get(view.sessionId)
    if (old) clearTimeout(old)
    changes.set(view.sessionId, setTimeout(() => {
      changes.delete(view.sessionId)
      if (valid(view) && !view.control) deps.changed?.(view.sessionId)
    }, 120))
  }
  const slot = async <T>(engine: string, run: () => Promise<T>): Promise<T> => {
    if ((pending.get(engine) ?? 0) >= 256) throw new EngineReadError('ENGINE_BUSY')
    const deadline = performance.now() + RUNTIME_WAIT_MS
    pending.set(engine, (pending.get(engine) ?? 0) + 1)
    const before = queues.get(engine) ?? Promise.resolve()
    let release!: () => void
    const tail = new Promise<void>(resolve => { release = resolve })
    queues.set(engine, tail)
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new EngineReadError('ENGINE_BUSY')), RUNTIME_WAIT_MS)
        void before.then(() => { clearTimeout(timer); resolve() })
      })
      if (performance.now() >= deadline) throw new EngineReadError('ENGINE_BUSY')
      return await run()
    } finally {
      // Expiry answers the caller immediately, but its successor still waits for the active call.
      // Keep that reservation in the cap until released so expired queue links cannot grow forever.
      void before.then(() => {
        pending.set(engine, pending.get(engine)! - 1); release()
        if (queues.get(engine) === tail) queues.delete(engine)
      })
    }
  }
  const contextFor = (s: RegisteredSession, view: View): RuntimeContext => ({ session: snapshot(s), state: { ...view.state },
    ...(view.control ? { control: controlCopy(view.control) } : {}) })
  const accept = (view: View, answer: RuntimeAnswer, silent: boolean): void => {
    const before = view.selected
    view.state = view.sessionId ? { ...answer.state } : blankRuntimeState()
    view.control = controlCopy(answer.control ?? undefined)
    view.selected = view.sessionId ? answer.selectedModel : null
    view.revision++
    const current = deps.resolve(view.agentId)!
    current.cliVersion = answer.cliVersion
    wake(view.sessionId)
    if (!silent && !suppressed && before !== view.selected && !view.control) notify(view)
  }
  const read = (s: RegisteredSession, operation: RuntimeOperation, silent = false): Promise<RuntimeAnswer> => {
    const identity = binding(s), view = viewFor(s)
    return slot(s.engine, async () => {
      if (!valid(view) || view.identity !== identity) unavailable()
      const current = deps.resolve(view.agentId)!, version = current.cliVersion, revision = view.revision
      const answer = await deps.transport.read(current.engine, contextFor(current, view), operation)
      if (!valid(view) || revision !== view.revision || deps.resolve(view.agentId)?.cliVersion !== version) unavailable()
      if (operation.kind === 'records' || operation.kind === 'pane' || operation.kind === 'config') accept(view, answer, silent)
      return answer
    })
  }

  const stage = (s: RegisteredSession, hydrate: boolean, silent: boolean): RuntimeStage => {
    const view = viewFor(s), revision = view.revision, version = s.cliVersion
    const context = contextFor(s, view)
    if (hydrate) context.state = { ...blankRuntimeState(), model: typeof s.model === 'string' ? s.model : null, cliVersion: s.cliVersion }
    let answer: RuntimeAnswer | null = null
    let committed = false, failed = false
    const current = (): boolean => !committed && !failed && valid(view) && view.revision === revision && deps.resolve(view.agentId)?.cliVersion === version
    const reduce = (operation: RuntimeOperation): Promise<void> => slot(s.engine, async () => {
      if (!current()) unavailable()
      const next = await deps.transport.read(s.engine, context, operation)
      if (!current()) unavailable()
      context.state = { ...next.state }; context.session.cliVersion = next.cliVersion
      context.control = controlCopy(next.control ?? undefined); answer = next
    }).catch(error => { failed = true; throw error })
    return {
      async ingest(records) {
        let batch: RuntimeRecord[] = [], bytes = Buffer.byteLength(JSON.stringify(context)) + 256
        for (const evidence of records) {
          const size = Buffer.byteLength(JSON.stringify(evidence)) + 1
          if (batch.length && (batch.length >= RUNTIME_RECORDS || bytes + size > RUNTIME_REQUEST_BYTES - 1024)) {
            await reduce({ kind: 'records', records: batch }); batch = []; bytes = Buffer.byteLength(JSON.stringify(context)) + 256
          }
          if (bytes + size > RUNTIME_REQUEST_BYTES - 1024) { failed = true; throw new EngineReadError('ENGINE_REPLY_TOO_LARGE') }
          batch.push(evidence); bytes += size
        }
        if (batch.length) await reduce({ kind: 'records', records: batch })
      },
      config: () => reduce({ kind: 'config' }),
      commit(install = () => true) {
        if (!current() || !install()) return false
        committed = true
        if (answer) accept(view, answer, silent)
        return true
      },
    }
  }
  const waitFor = (id: string, check: () => boolean, timeout: number): Promise<boolean> => {
    id = deps.resolve(id)?.sessionId ?? id
    if (!id || stopped) return Promise.resolve(false)
    if (check()) return Promise.resolve(true)
    return new Promise(resolve => {
      const waiter: Waiter = { check, resolve, timer: setTimeout(() => {
        const set = waiters.get(id)
        set?.delete(waiter)
        if (!set?.size) waiters.delete(id)
        resolve(false)
      }, timeout) }
      const set = waiters.get(id) ?? new Set(); set.add(waiter); waiters.set(id, set)
    })
  }
  return {
    read,
    stage,
    async prepare(s: RegisteredSession, records: readonly RuntimeRecord[]): Promise<() => boolean> {
      const pending = stage(s, false, false)
      await pending.ingest(records)
      return () => pending.commit()
    },
    selectedModel(s: RegisteredSession): string | null {
      return s.sessionId && binding(s) === binding(deps.resolve(s.agentId)) ? byId(s.agentId)?.selected ?? null : null
    },
    getState(id: string): RuntimeState { return { ...(byId(id)?.state ?? blankRuntimeState()) } },
    async withoutChangeEvents<T>(run: () => Promise<T>): Promise<T> { suppressed++; try { return await run() } finally { suppressed-- } },
    beginControl(s: RegisteredSession, target: RuntimeProfile): boolean {
      const view = viewFor(s)
      if (!s.sessionId || view.control || !valid(view)) return false
      const current = parseRuntimeProfile(view.selected)
      view.control = { target: { ...target }, before: view.selected,
        modelConfirmed: current?.model === target.model, effortConfirmed: current?.effort === target.effort }
      view.revision++
      return true
    },
    cancelControl(id: string): void {
      const view = byId(id)
      if (!view) return
      const previous = view.control
      view.control = undefined; view.revision++; wake(view.sessionId)
      if (previous) notify(view)
    },
    finishControl(s: RegisteredSession): void {
      const view = byId(s.agentId)
      if (!view || view.identity !== binding(s)) return
      view.control = undefined; view.revision++; wake(view.sessionId); notify(view)
    },
    confirmEffort(id: string, effort: string): void {
      const view = byId(id)
      if (!view?.sessionId || !RUNTIME_EFFORTS.has(effort)) return
      // Confirmation comes from core's checked control driver, never an arbitrary transcript field.
      view.state = { ...view.state, effort, observedAt: Date.now() }
      const selection = parseRuntimeProfile(view.selected)
      const s = deps.resolve(view.agentId)!
      if (selection) view.selected = encodeRuntimeProfile({ sessionId: s.agentId, engine: s.engine, model: selection.model, effort })
      if (view.control) view.control.effortConfirmed = view.control.target.effort === effort
      view.revision++; wake(view.sessionId)
    },
    confirmControlProfile(target: RuntimeProfile): void {
      const view = byId(target.sessionId)
      if (!view) return
      view.state = { ...view.state, model: target.model, effort: target.effort, observedAt: Date.now() }
      view.selected = encodeRuntimeProfile({ ...target, sessionId: view.agentId })
      if (view.control?.target.id === target.id) { view.control.modelConfirmed = true; view.control.effortConfirmed = true }
      view.revision++; wake(view.sessionId)
    },
    waitForModel(id: string, timeout: number): Promise<boolean> { return waitFor(id, () => byId(id)?.control?.modelConfirmed === true, timeout) },
    waitForProfile(id: string, timeout: number): Promise<boolean> { return waitFor(id, () => {
      const control = byId(id)?.control; return control?.modelConfirmed === true && control.effortConfirmed === true
    }, timeout) },
    forget,
    stop(): void {
      stopped = true
      for (const id of views.keys()) forget(id)
      for (const set of waiters.values()) for (const waiter of set) { clearTimeout(waiter.timer); waiter.resolve(false) }
      waiters.clear()
    },
  }
}

export type RuntimeSessions = ReturnType<typeof createRuntimeSessions>
