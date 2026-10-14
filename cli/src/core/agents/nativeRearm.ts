/** A cancelled native agent needs one explicit, durable replacement request.
 * Dependency retries never inherit permission to dispatch a claimed launch. */
import { randomUUID } from 'node:crypto'
import { creationFingerprint, validCreationId, type AgentCreationOutcome, type AgentCreationReceipts,
  type AgentCreationStatus, type CreationAuthority, type NativeRelaunchRequest } from '../../lib/agentCreationReceipt.js'
import { nativeRearmRequest, nativeTurnTarget, parseNativeTurnIntent, type NativeTurnIntent } from '../../lib/nativeTurnIntent.js'
import type { RegisteredSession, registry } from '../../lib/registry.js'
import type { StoppedAgentStore } from '../../lib/stoppedAgents.js'
import { nativeAllocationCanReserve } from '../../lib/nativeAllocation.js'

type Source = 'live' | 'saved'
type Rearm = NonNullable<NativeTurnIntent['rearm']>
export interface NativeRearmOptions {
  agentId: string
  creationId: string
  operation: Rearm['operation']
  source: Source
  permissionMode?: Rearm['permissionMode']
}
export interface NativeRearmPreparation {
  source: Source
  row: RegisteredSession
  receipt: NativeRelaunchRequest
  authority: CreationAuthority
}
export interface NativeRearmDispatch {
  /** Exactly once, immediately before the first physical mutation. */
  begin(): void
  /** Recheck after each wait and before every subsequent physical mutation. */
  current(): boolean
}
export interface NativeRearmDeps {
  registry: Pick<typeof registry, 'byAgent' | 'readNativeAbsence' | 'readNativeControl' | 'commitNativeControl'>
  saved: Pick<StoppedAgentStore, 'get' | 'readNativeControl' | 'commitNativeControl'>
  receipts: Pick<AgentCreationReceipts, 'has' | 'status' | 'runIntent' | 'cancelIntent'>
  /** No signals, history repair, route leases or pane allocation in preparation.
   * The returned operation uses only the original launch and cannot fall back. */
  prepare(input: NativeRearmPreparation): Promise<((guard: NativeRearmDispatch) => Promise<void>) | null>
  held(agentId: string, reason: string): void
}

const same = (a: unknown, b: unknown) => creationFingerprint(a) === creationFingerprint(b)
const notDispatched: AgentCreationOutcome = { state: 'failed', error: 'NATIVE_REARM_NOT_DISPATCHED',
  detail: 'The original launch callback ended before its first physical mutation.' }

/** This owns reservation and exclusive dispatch only. Reconciliation proves the
 * original allocation separately; an effect callback cannot declare success. */
export function createNativeRearm({ registry, saved, receipts, prepare, held }: NativeRearmDeps) {
  type Attempt = { revoked: boolean }
  const attempts = new Map<string, Attempt>()
  let closed = false
  const get = (source: Source, id: string) => source === 'live' ? registry.byAgent(id) : saved.get(id)
  const read = (source: Source, row: RegisteredSession) => source === 'live' ? registry.readNativeControl(row) : saved.readNativeControl(row)
  const hold = (id: string, reason: string, publish = true): AgentCreationStatus => {
    const detail = `Waiting for native restart: ${reason}.`
    if (publish && !closed) held(id, detail)
    return { state: 'pending', held: { service: 'native', detail } }
  }
  const fingerprint = (options: NativeRearmOptions) => creationFingerprint({ kind: 'native-rearm',
    agentId: options.agentId, operation: options.operation, source: options.source,
    ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
  })
  const matches = (options: NativeRearmOptions, rearm: Rearm) => rearm.requestId === options.creationId
    && rearm.agentId === options.agentId && rearm.operation === options.operation && rearm.source === options.source
    && rearm.permissionMode === options.permissionMode
  const local = () => { if (closed) throw Error('the core has stopped') }

  const dispatch = async (options: NativeRearmOptions, row: RegisteredSession, absence?: { verify(): void }): Promise<AgentCreationStatus> => {
    const control = parseNativeTurnIntent(row.nativeControl), request = control && nativeRearmRequest(control)
    if (!control?.rearm || !request || !matches(options, control.rearm)) return hold(options.agentId, 'the complete original reservation is unavailable')
    if (control.rearm.revoked) return receipts.cancelIntent(options.creationId)
    if (control.rearm.replacement) return hold(options.agentId, 'the original replacement needs receipt reconciliation')
    if (!nativeAllocationCanReserve(row.nativeAllocation, control.rearm.requestId, control.rearm.launchToken)) {
      return hold(options.agentId, 'the retained original allocations need physical accounting before another launch')
    }
    const receipt = { fingerprint: fingerprint(options), request }
    return receipts.runIntent(options.creationId, receipt.fingerprint, request,
      { service: 'native', detail: 'Waiting for the original native launch dependencies.' }, async (recorded, originalAuthority) => {
        if (!same(recorded, request)) {
          originalAuthority.hold({ service: 'native', detail: 'The receipt differs from the original reserved launch.' })
          return null
        }
        if (closed || attempts.size >= 4 || attempts.has(options.creationId) || !originalAuthority.settled) {
          originalAuthority.hold({ service: 'native', detail: 'Waiting for original native launch capacity and lifetime authority.' })
          return null
        }
        const attempt: Attempt = { revoked: false }
        attempts.set(options.creationId, attempt)
        // Registered before the first await. The receipt owns this slot even
        // when its bounded answer has already returned or a peer wins the claim.
        void originalAuthority.settled.then(() => { attempts.delete(options.creationId) })
        let began = false
        const active = () => !closed && !attempt.revoked && attempts.get(options.creationId) === attempt
        const target = (current: RegisteredSession | null | undefined) => !!current && current.engine === 'cursor'
          && same(current.nativeControl, control) && nativeTurnTarget(current) === control.rearm!.target
        const current = () => {
          if (!active()) return false
          try {
            absence?.verify()
            if (options.source === 'saved' && registry.byAgent(options.agentId)) return false
            if (!originalAuthority.current()) return false
            const current = get(options.source, options.agentId)
            if (!target(current)) return false
            read(options.source, current!).verify()
            if (!originalAuthority.current()) return false
            // Proof callbacks can revoke or change the original row. Finish
            // with the exact target and a final disk-free lifetime check.
            absence?.verify()
            return target(get(options.source, options.agentId)) && active()
              && (options.source !== 'saved' || !registry.byAgent(options.agentId)) && active()
          } catch { return false }
        }
        const authority: CreationAuthority = { id: originalAuthority.id, settled: originalAuthority.settled, current,
          hold: reason => { if (current()) originalAuthority.hold(reason) },
        }
        if (!current()) return null
        const effect = await prepare({ source: options.source, row: structuredClone(row), receipt: structuredClone(receipt), authority })
        if (!effect || !current()) return null
        return async () => {
          if (!current()) return notDispatched
          let executing = true
          const currentEffect = () => executing && current()
          const guard: NativeRearmDispatch = { current: currentEffect, begin: () => {
            if (began || !currentEffect()) throw Error('the original native dispatch is unavailable')
            began = true
          } }
          try { await effect(guard) } catch { /* A begun effect remains uncertain; never replay it. */ }
          finally { executing = false }
          return began ? { state: 'unconfirmed' } : notDispatched
        }
      })
  }

  return {
    async start(input: NativeRearmOptions): Promise<AgentCreationStatus> {
      const options = structuredClone(input)
      let original: RegisteredSession | undefined
      try {
        local()
        if (!validCreationId(options.creationId)) return hold(options.agentId, 'the request identity is invalid')
        const expected = fingerprint(options)
        // Check the caller's immutable semantic choice before reserving R. A
        // completed or cancelled same-ID retry cannot start another launch.
        const existing = receipts.has(options.creationId, expected)
        const status = existing ? receipts.status(options.creationId) : undefined
        if (status && status.state !== 'pending' && status.state !== 'unconfirmed') return status
        const absence = options.source === 'saved' ? registry.readNativeAbsence(options.agentId) : undefined
        const placement = () => {
          local()
          absence?.verify()
          if (options.source === 'saved' && registry.byAgent(options.agentId)) throw Error('the original live handoff must finish before saved dispatch')
          local()
        }
        placement()
        let row = get(options.source, options.agentId)
        if (!row || row.engine !== 'cursor') return hold(options.agentId, 'the original Cursor agent is unavailable')
        row = structuredClone(row)
        original = row
        const control = parseNativeTurnIntent(row.nativeControl)
        if (!control) return hold(options.agentId, 'the durable cancellation is unavailable')
        if (control.rearm) {
          if (!matches(options, control.rearm)) return hold(options.agentId, 'a different original launch must be reconciled first')
        } else {
          if (existing) return hold(options.agentId, 'the original reservation is missing')
          if (!nativeAllocationCanReserve(row.nativeAllocation, options.creationId)) {
            return hold(options.agentId, 'the retained original allocations need physical accounting before another launch')
          }
          const next = parseNativeTurnIntent({ ...control, rearm: { requestId: options.creationId, agentId: row.agentId,
            operation: options.operation, source: options.source, target: nativeTurnTarget(row), launchToken: randomUUID(),
            sourceProcess: { processKey: control.cancel.processKey,
              ...(control.cancel.namespace === undefined ? {} : { namespace: control.cancel.namespace }) },
            ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
          } })
          if (!next) return hold(options.agentId, 'the original launch options are invalid')
          const compatible = () => { placement(); receipts.has(options.creationId, expected); placement() }
          // Store methods retain their own exact old row through publication.
          // The receipt compatibility fence survives the intentional row write.
          row = options.source === 'live' ? registry.commitNativeControl(row, next, compatible)
            : saved.commitNativeControl(row, next, { verify: compatible, current: local })
        }
        row = structuredClone(row)
        original = row
        read(options.source, row).verify(); placement()
        return await dispatch(options, row, absence)
      } catch (error) {
        let unchanged = false
        try {
          const current = get(options.source, options.agentId)
          unchanged = !!current && !!original && same(current.nativeControl, original.nativeControl)
            && nativeTurnTarget(current) === nativeTurnTarget(original)
        } catch { /* A late failed read cannot replace a successor's status. */ }
        return hold(options.agentId, error instanceof Error ? error.message : String(error), unchanged)
      }
    },
    /** Cancel has already durably revoked R before it calls this. A tombstone
     * also covers a crash between R publication and creation-receipt creation. */
    revoke(requestId: string): void {
      const attempt = attempts.get(requestId)
      if (attempt) attempt.revoked = true
      receipts.cancelIntent(requestId)
    },
    close(): void { closed = true; for (const attempt of attempts.values()) attempt.revoked = true },
  }
}
