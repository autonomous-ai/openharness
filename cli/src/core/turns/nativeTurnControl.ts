/** Eager turn state for one immutable native incarnation. Optional readers may
 * decorate its history; they cannot choose a turn or release its input. */
import { createHash } from 'node:crypto'
import { createNativeGenerations, type NativeGeneration, type NativeGenerationOwner,
  type NativeGenerationSource, type NativeGenerationView } from './nativeGenerations.js'
import { EMPTY_NATIVE_CONTENT, nativeGenerationContent, type NativeGenerationContent } from './nativeGenerationContent.js'
import { MAX_RETAINED_GENERATION_FACTS } from '../../engines/kit/nativeGenerationCancellation.js'
import { nativeTasks, type NativeTaskProjection } from './nativeTasks.js'

export interface NativeTurn {
  readonly owner: NativeGenerationOwner
  readonly generation: NativeGeneration
  readonly content: NativeGenerationContent
  /** Generation-scoped presentation; never forwarded as ordinary session tool
   * events, whose existing consumers can alter a successor's live activity. */
  readonly tasks: NativeTaskProjection
  /** Native facts retained before this core first admitted a delivery. A late
   * response cannot turn a recovered Stop into another live completion. */
  readonly recovery: { readonly started: boolean; readonly ended: boolean }
  /** Idempotent presentation identity. It never grants a physical effect. */
  readonly version: string
}
export interface NativeTurnState {
  readonly owner: NativeGenerationOwner
  readonly selection: NativeGenerationView['selection']
  readonly turns: readonly NativeTurn[]
  /** Every fact in this publication belonged to the fixed recovery baseline.
   * Mixed publications use each turn's recovery flags for lifecycle events. */
  readonly recovered: boolean
  readonly cancelRequested: boolean
}
export interface NativeTurnControlDeps {
  owner: NativeGenerationOwner
  /** Captured from the confirmed journal before admitting this core's first
   * delivery, never inferred from the first successful asynchronous read. */
  recoveredFactIds: readonly string[]
  /** Includes binding and any durable explicit rearm relation. A new PID alone
   * must never make this true for a cancelled incarnation's replacement. */
  current(): boolean
  read(owner: NativeGenerationOwner): Promise<NativeGenerationSource>
  /** Core ports are synchronous and idempotent. Each use of state is fenced by
   * verify; deferred consumers must obtain a new permit after their own waits. */
  publish(state: NativeTurnState, verify: () => void): void
  revoke(owner: NativeGenerationOwner): void
  held(owner: NativeGenerationOwner, reason: string): void
  /** A monotonic clock; wall-clock corrections cannot extend an inspection. */
  now?(): number
  readWaitMs?: number
  retryMs?: number
}
const scope = (owner: NativeGenerationOwner) => JSON.stringify([owner.agentId, owner.sessionId, owner.processKey])
function unavailable(reason: string): never { throw Error(`Waiting for native turn control: ${reason}.`) }

export function createNativeTurnControl({ owner, recoveredFactIds, current, read, publish, revoke, held,
  now = () => performance.now(), readWaitMs = 5000, retryMs = 1000,
}: NativeTurnControlDeps) {
  if (!Number.isFinite(readWaitMs) || readWaitMs <= 0 || readWaitMs > 5000
    || !Number.isFinite(retryMs) || retryMs <= 0 || retryMs > 60_000) unavailable('the retry or read deadline is invalid')
  if (!Array.isArray(recoveredFactIds) || recoveredFactIds.length > MAX_RETAINED_GENERATION_FACTS
    || recoveredFactIds.some(id => typeof id !== 'string' || !id.length || id.length > 200)) unavailable('the recovery baseline is invalid')
  const recovered = new Set(recoveredFactIds)
  const original = Object.freeze({ ...owner }), identity = scope(original)
  let revision = 0, closed = false, pending = true, cancelled = false, dirty = false
  let running: Promise<void> | undefined, retry: ReturnType<typeof setTimeout> | undefined
  type Inspection = { view: NativeGenerationView; turns: readonly NativeTurn[]; recovered: boolean; verify(): void }
  let reading: { version: number; result: Promise<Inspection>; check(): void; reject(error: Error): void } | undefined
  const live = () => !closed && current()
  const check = (version: number) => { if (!live() || version !== revision) unavailable('the original control revision changed') }
  const hold = (reason: string) => {
    if (!live()) return
    try { held(original, reason) } catch (error) { console.warn('[native-turn] hold notification failed', error) }
  }
  const revokeEffects = () => {
    try { revoke(original) } catch { hold('The original native effects could not be revoked at their consumer.') }
  }
  const invalidate = () => {
    revision++
    reading?.reject(Error('Waiting for native turn control: the original control revision changed.'))
    revokeEffects()
  }
  const inspect = async (version: number): Promise<Inspection> => {
    check(version)
    if (reading) {
      if (reading.version !== version) unavailable('the previous native generation read has not settled')
      reading.check()
      return reading.result
    }
    const deadline = now() + readWaitMs
    let resolve!: (value: Inspection) => void, reject!: (error: unknown) => void
    const result = new Promise<Inspection>((yes, no) => { resolve = yes; reject = no })
    const expire = () => {
      const error = Error('Waiting for native turn control: the native generation read deadline expired.')
      reject(error)
      if (reading?.result === result && live() && version === revision) { invalidate(); hold(error.message) }
      return error
    }
    const checkRead = () => {
      check(version)
      if (now() >= deadline) throw expire()
    }
    const timer = setTimeout(expire, readWaitMs)
    reading = { version, result, check: checkRead, reject: error => { clearTimeout(timer); reject(error) } }
    // Every reader, including permits, shares this actual I/O slot. Waiters can
    // leave on revocation or timeout, but only I/O settlement releases the slot.
    const settle = () => { clearTimeout(timer); reading = undefined; if (dirty) schedule() }
    void (async () => {
      const source = await read(original)
      checkRead()
      if (scope(source.owner) !== identity) unavailable('the source belongs to another owner')
      // Copy native content before the scalar projection's await as well.
      const content = nativeGenerationContent(source)
      const baseline = source.facts.filter(fact => recovered.has(fact.id)).map(fact => ({ ...fact }))
      const allRecovered = source.facts.every(fact => recovered.has(fact.id))
      const view = await createNativeGenerations({ owner: original, current: () => live() && version === revision,
        read: async () => source }).inspect()
      const verify = () => { checkRead(); view.verify(); checkRead() }
      verify()
      if (view.selection === 'cancelled' && !cancelled) { cancelled = true; revokeEffects() }
      const turns = Object.freeze(view.generations.map(generation => {
        const prior = baseline.filter(fact => fact.generationId === generation.id)
        const generationContent = content.get(generation.id) ?? EMPTY_NATIVE_CONTENT
        const fields = { owner: original, generation, content: generationContent,
          tasks: nativeTasks(original, generation, generationContent.tools, cancelled),
          recovery: Object.freeze({ started: prior.some(fact => fact.kind === 'activity' || fact.kind === 'stopped'),
            ended: prior.some(fact => fact.kind === 'stopped' || fact.kind === 'cancelled') }) }
        return Object.freeze({ ...fields, version: createHash('sha256').update(JSON.stringify(fields)).digest('hex') })
      }))
      verify()
      return { view, turns, recovered: allRecovered, verify }
    })().then(value => { settle(); resolve(value) }, error => { settle(); reject(error) })
    return result
  }
  const schedule = () => {
    if (!live() || pending || retry || reading) return
    retry = setTimeout(() => { retry = undefined; void refresh() }, retryMs)
  }
  const refresh = (): Promise<void> => {
    if (!live() || pending) return Promise.resolve()
    dirty = true
    if (running) return running
    const version = revision
    dirty = false
    running = (async () => {
      try {
        const state = await inspect(version)
        state.verify()
        publish(Object.freeze({ owner: original, selection: cancelled ? 'cancelled' : state.view.selection, turns: state.turns,
          recovered: state.recovered, cancelRequested: cancelled }), state.verify)
        state.verify()
      } catch (error) {
        if (live() && version === revision) hold(error instanceof Error ? error.message : String(error))
        dirty = true
      } finally {
        running = undefined
        if (dirty) schedule()
      }
    })()
    return running
  }
  const observe = (source: NativeGenerationSource, admissionPending: boolean): void => {
    if (!live()) return
    invalidate()
    pending = true
    if (scope(source.owner) !== identity) unavailable('the notification belongs to another owner')
    source.verify()
    pending = admissionPending
    if (retry) { clearTimeout(retry); retry = undefined }
    if (pending) { hold('Native hook admission is still pending.'); return }
    void refresh()
  }
  /** Call after optional preparation, immediately before a scoped effect. The
   * returned verifier is checked again at its actual dispatch, after any waits.
   * Presentation recovery never invokes this method or repeats one-shot work. */
  const permit = async (generationId: string, purpose: 'running' | 'terminal' | 'recap') => {
    if (pending || cancelled) unavailable('admission or Cancel holds this incarnation')
    const version = revision, state = await inspect(version)
    const turn = state.turns.find(candidate => candidate.generation.id === generationId)
    if (!turn) unavailable('the requested generation has no effect authority')
    if (purpose === 'running' ? !turn.generation.running : !turn.generation.terminal) unavailable('the generation is not in the requested state')
    if (purpose === 'recap' && (turn.generation.terminal !== 'completed' || turn.content.response.state !== 'available')) {
      unavailable('this generation has no unambiguous completed response')
    }
    const verify = () => {
      state.verify()
      if (cancelled) unavailable('Cancel holds this incarnation')
    }
    verify()
    return Object.freeze({ turn, verify })
  }
  /** Physical input is distinct from native execution. Submitted-only facts can
   * be rejected by another native hook and never receive Stop; they must not
   * block the next explicit input forever. Answers may enter a running turn,
   * but no control interaction can choose between unordered running turns. */
  const admit = async (purpose: 'input' | 'control' | 'answer') => {
    if (pending || cancelled) unavailable('admission or Cancel holds this incarnation')
    const state = await inspect(revision)
    const verify = () => {
      state.verify()
      if (pending || cancelled) unavailable('admission or Cancel holds this incarnation')
    }
    verify()
    if (state.view.selection === 'ambiguous' || purpose !== 'answer' && state.view.selection !== 'idle') {
      unavailable('a native turn is still running or its selection is ambiguous')
    }
    return Object.freeze({ owner: original, generationId: state.view.running[0]?.id, verify })
  }
  return {
    observe, refresh, permit, admit,
    /** This is immediate local revocation, not confirmation that Cancel was
     * saved or dispatched. Only the durable Cancel port can supply that proof. */
    cancel: () => { if (live()) { cancelled = true; invalidate(); hold('Waiting for the saved native cancellation result.'); } },
    close: () => { if (!closed) { closed = true; invalidate(); if (retry) clearTimeout(retry); retry = undefined } },
  }
}
