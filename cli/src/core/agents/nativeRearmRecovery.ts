/** A claimed native restart can be confirmed, never launched a second time. */
import { creationFingerprint, type AgentCreationReceipts, type AgentCreationStatus } from '../../lib/agentCreationReceipt.js'
import { nativeRearmRequest, nativeTurnTarget, parseNativeTurnIntent } from '../../lib/nativeTurnIntent.js'
import type { RegisteredSession, registry } from '../../lib/registry.js'
import type { StoppedAgentStore } from '../../lib/stoppedAgents.js'
import { permissionModeApproves } from '../../lib/engineLaunch.js'
import type { createNativeRearmProof, NativeRearmReplacementProof } from '../../engines/kit/nativeRearmProof.js'
import { appendNativeAllocation } from '../../lib/nativeAllocation.js'

export interface NativeRearmRecoveryDeps {
  registry: Pick<typeof registry, 'byAgent' | 'readNativeAbsence' | 'readNativeControl' | 'readNativeReplacementSource' | 'commitNativeReplacement' | 'commitNativeSavedReplacement'>
  saved: Pick<StoppedAgentStore, 'get' | 'readNativeResumeSource' | 'withNativeResume'>
  receipts: Pick<AgentCreationReceipts, 'status' | 'readNativeRelaunchCompletion' | 'confirmNativeRelaunch'>
  proof: ReturnType<typeof createNativeRearmProof>
  held(agentId: string, reason: string): void
}

/** Recovery has no launch callback. A bounded reply never releases an occupied
 * native read, and Cancel/shutdown revoke the original attempt before it settles. */
export function createNativeRearmRecovery({ registry, saved, receipts, proof, held }: NativeRearmRecoveryDeps) {
  type Attempt = { revoked: boolean; expired: boolean; deadline: number }
  const attempts = new Map<string, Attempt>()
  let closed = false
  const savedOwner = (row: RegisteredSession) => row.nativeControl?.rearm?.source === 'saved'
    && !row.nativeArchive && !row.nativeControl.rearm.replacement
  const sameOwner = (row: RegisteredSession, current = registry.byAgent(row.agentId)) => !!current
    && nativeTurnTarget(current) === nativeTurnTarget(row)
    && creationFingerprint(current.nativeControl ?? null) === creationFingerprint(row.nativeControl ?? null)
  const hold = (row: RegisteredSession, reason: string, publish = () => true): AgentCreationStatus => {
    const detail = `Waiting to confirm the original native launch: ${reason}.`
    try {
      if (publish() && !closed) {
        if (savedOwner(row)) {
          const source = saved.readNativeResumeSource(row), absent = registry.readNativeAbsence(row.agentId)
          source.verify(); absent.verify(); source.verify()
          if (sameOwner(row, saved.get(row.agentId) ?? undefined)
            && publish() && !closed && !registry.byAgent(row.agentId)) held(row.agentId, detail)
        } else if (sameOwner(row) && publish() && !closed) held(row.agentId, detail)
      }
    } catch {
      // The returned hold still carries its reason. An unavailable saved proof
      // or presentation callback cannot publish over a new owner or strand control.
    }
    return { state: 'pending', held: { service: 'native', detail } }
  }

  return {
    recover(input: RegisteredSession): Promise<AgentCreationStatus> {
      const deadline = performance.now() + 5000
      let owner = structuredClone(input)
      const agentId = owner.agentId
      const control = parseNativeTurnIntent(owner.nativeControl), rearm = control?.rearm
      const request = control && nativeRearmRequest(control)
      let fromSaved = savedOwner(owner)
      if (closed || owner.engine !== 'cursor' || !owner.sessionId || !rearm || !request
        || fromSaved && (owner.active || rearm.operation !== 'resume')
        || rearm.source === 'saved' && !fromSaved && !rearm.replacement) {
        return Promise.resolve(hold(owner, 'the complete original reservation is unavailable'))
      }
      const fingerprint = creationFingerprint({ kind: 'native-rearm', agentId: rearm.agentId,
        operation: rearm.operation, source: rearm.source,
        ...(rearm.permissionMode === undefined ? {} : { permissionMode: rearm.permissionMode }),
      })
      const receipt = { fingerprint, request }
      try {
        const status = receipts.status(rearm.requestId)
        if (performance.now() >= deadline) return Promise.resolve(hold(owner, 'native recovery exceeded its deadline'))
        if (status.state === 'created') {
          const completed = receipts.readNativeRelaunchCompletion(rearm.requestId, receipt)
          completed.verify()
          if (performance.now() >= deadline) return Promise.resolve(hold(owner, 'native recovery exceeded its deadline'))
          return Promise.resolve(completed.outcome)
        }
      } catch (error) {
        return Promise.resolve(hold(owner, error instanceof Error ? error.message : String(error)))
      }
      if (attempts.has(owner.agentId) || attempts.size >= 4) return Promise.resolve(hold(owner, 'original recovery reads are still occupied'))
      const attempt: Attempt = { revoked: false, expired: false, deadline }
      attempts.set(owner.agentId, attempt)
      let actual: Promise<void> | undefined
      const present = () => !closed && !attempt.revoked && attempts.get(agentId) === attempt
      const lifetime = () => {
        if (!present() || attempt.expired || performance.now() >= attempt.deadline) throw Error('the original recovery owner or deadline changed')
      }
      // Store/Registry own the saved-to-live rename. This final callback cannot
      // re-read the archive leaf they intentionally consume during that commit.
      const current = () => { lifetime(); if (!fromSaved && !sameOwner(owner)) throw Error('the original recovery owner changed'); lifetime() }
      const link = { version: 1 as const, agentId, requestId: rearm.requestId, launchToken: rearm.launchToken, target: rearm.target }
      const same = (a: unknown, b: unknown) => creationFingerprint(a) === creationFingerprint(b)
      const committedOwner = (original: RegisteredSession, value: RegisteredSession, replacement: NativeRearmReplacementProof) => {
        const expected: RegisteredSession = { ...original, active: true, processIdentity: { ...replacement.processIdentity },
          schemaVersion: 4, nativeAllocation: appendNativeAllocation(original.nativeAllocation, receipt),
          ...(fromSaved ? { nativeArchive: link, runtimes: [{ backend: 'tmux', paneId: replacement.pane }],
            primaryRuntimeKey: `tmux\0${replacement.pane}`, tmuxPane: replacement.pane } : {}),
          ...(rearm.permissionMode === undefined ? {} : { permissionMode: rearm.permissionMode, bypassPermission: permissionModeApproves(rearm.permissionMode) }),
        }
        const expectedControl = { ...control, rearm: { ...rearm, replacement: { processKey: replacement.key, sessionId: original.sessionId } } }
        if (nativeTurnTarget(value) !== nativeTurnTarget(expected) || !same(value.nativeControl, expectedControl)) {
          throw Error('the committed native replacement belongs to a different owner')
        }
        return structuredClone(value)
      }
      const transferredArchive = (replacement: NativeRearmReplacementProof) => {
        if (rearm.source !== 'saved') return undefined
        const original = saved.get(agentId)
        if (!original || !original.nativeControl || !same(nativeRearmRequest(original.nativeControl), request)
          || !same(owner.nativeArchive, link)) throw Error('the original saved Resume association changed')
        const retained = saved.readNativeResumeSource(original), transfer = retained.transfer
        const pending: RegisteredSession = { ...original, nativeArchive: link, active: false, processIdentity: null,
          runtimes: [{ backend: 'tmux', paneId: replacement.pane }], primaryRuntimeKey: `tmux\0${replacement.pane}`, tmuxPane: replacement.pane }
        if (!transfer || !same(transfer.link, link) || transfer.processKey !== replacement.key || transfer.pane !== replacement.pane
          || transfer.pendingTarget !== nativeTurnTarget(pending)) throw Error('the original saved Resume destination changed')
        retained.verify(); current()
        return retained
      }
      const recover = async (): Promise<AgentCreationStatus> => {
        lifetime()
        if (rearm.revoked) throw Error('the original reservation was revoked')
        current()
        const source = fromSaved ? saved.readNativeResumeSource(owner)
          : rearm.replacement ? registry.readNativeControl(owner) : registry.readNativeReplacementSource(owner)
        const fence = { verify: () => { source.verify(); current() }, current }
        const observation = fromSaved ? proof.recoverSaved(owner, receipt, fence) : rearm.replacement ? proof(owner, receipt, fence)
          : proof.recover(owner, receipt, fence, owner.tmuxPane)
        actual = observation.settled
        const replacement = await observation
        fence.verify(); replacement.verify(); current()
        if (!rearm.replacement) {
          const committed = fromSaved ? registry.commitNativeSavedReplacement(owner, replacement, saved, current)
            : registry.commitNativeReplacement(owner, replacement, current)
          // Only the exact durable commit can change this attempt's owner. Its
          // former file proof is intentionally invalidated by that same rename.
          owner = committedOwner(owner, committed, replacement)
          fromSaved = false
        }
        const archive = transferredArchive(replacement)
        const published = registry.readNativeControl(owner)
        const verify = () => { archive?.verify(); published.verify(); replacement.verifyExecution(); current() }
        verify()
        const verifyConfirmation = () => { archive?.verify(); published.verify(); replacement.verifyConfirmation(); current() }
        let confirmed: { verify(): void } | undefined
        const status = receipts.confirmNativeRelaunch(rearm.requestId, { ...receipt,
          outcome: { state: 'created', agentId: owner.agentId, resumed: true },
        }, { verify: verifyConfirmation, current: () => { replacement.current(); current() } }, retained => { confirmed = retained })
        if (!confirmed) throw Error('the original confirmation proof is unavailable')
        confirmed.verify()
        return status
      }
      return new Promise(resolve => {
        let replied = false
        const finish = (status: AgentCreationStatus) => { replied = true; clearTimeout(timer); resolve(status) }
        const timer = setTimeout(() => {
          attempt.expired = true
          finish(hold(owner, 'native recovery exceeded its deadline', present))
        }, Math.max(0, deadline - performance.now()))
        void recover().then(finish, error => {
          if (!replied) finish(hold(owner, error instanceof Error ? error.message : String(error), present))
        }).finally(async () => {
          attempt.revoked = true
          await actual
          attempts.delete(agentId)
        })
      })
    },
    revoke(agentId: string): void { const attempt = attempts.get(agentId); if (attempt) attempt.revoked = true },
    close(): void { closed = true; for (const attempt of attempts.values()) attempt.revoked = true },
  }
}
