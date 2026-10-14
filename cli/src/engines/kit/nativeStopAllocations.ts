/** Select every durable physical obligation before Stop can close any pane.
 * Latest-R lookup alone loses earlier engines after Cancel or another restart. */
import { creationFingerprint, type AgentCreationReceipts, type NativeRelaunchRequest } from '../../lib/agentCreationReceipt.js'
import { NATIVE_ALLOCATION_LIMIT, parseNativeAllocation } from '../../lib/nativeAllocation.js'
import { parseNativeLaunchAllocation } from '../../lib/nativeLaunchAllocation.js'
import { parseNativeCreateRequest } from '../../lib/nativeCreateRequest.js'
import { nativeRearmRequest, nativeTurnProcess, nativeTurnTarget, parseNativeTurnIntent } from '../../lib/nativeTurnIntent.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { NativeEvidenceBudget, NATIVE_EVIDENCE_MS, nativeUnavailable } from './nativeEvidence.js'
import { validNativeHookWriter, type NativeHookWriter } from './nativeHookWriter.js'
import type { NativePhysicalStopOwner, NativeStopAllocation } from './nativePhysicalStop.js'

const held = (reason: string): never => nativeUnavailable(`native Stop allocation accounting ${reason}`)
const identity = (owner: NativeHookWriter) => JSON.stringify([owner.boot, owner.namespace, owner.pid, owner.birth])

/** `verify` retains the exact source row; `current` is a disk-free lifetime
 * check that survives its intentional retirement. Receipt proofs are separate. */
export function readNativeStopAllocations(input: RegisteredSession,
  receipts: Pick<AgentCreationReceipts, 'readNativeRelaunchProcess' | 'readNativeRelaunchNotDispatched' | 'readNativeCreationProcess'>,
  fence: Pick<NativePhysicalStopOwner, 'verify' | 'current'>,
): NativePhysicalStopOwner {
  // Five active-to-released panes, six engines and two roots require at most
  // 289 Darwin probes. Selection and physical work share one deadline/budget.
  const budget = new NativeEvidenceBudget(NATIVE_EVIDENCE_MS, 320), row = structuredClone(input), { verify: verifyOwner, current: ownerCurrent } = fence
  const control = parseNativeTurnIntent(row.nativeControl)
  const allocation = row.nativeAllocation === undefined ? undefined : parseNativeAllocation(row.nativeAllocation)
  if (row.engine !== 'cursor' || !control || ![3, 4].includes(row.schemaVersion)
    || row.schemaVersion === 4 && !allocation || row.schemaVersion === 3 && row.nativeAllocation !== undefined
    || control.rearm && !control.rearm.revoked) return held('needs the complete revoked original owner')
  const current = () => { budget.step(); ownerCurrent(); budget.step() }
  const source = Object.freeze({ target: nativeTurnTarget(row), controlFingerprint: creationFingerprint(control) })
  verifyOwner(); current()
  const requests = (allocation?.receipts ?? []).map(receipt => ({ receipt, admitted: true }))
  if (requests.some(({ receipt }) => receipt.request.agentId !== row.agentId)) return held('contains a foreign admitted launch')
  if (control.rearm) {
    const request = nativeRearmRequest(control), rearm = control.rearm
    if (!request || rearm.agentId !== row.agentId) return held('has an incomplete pending request')
    const receipt: NativeRelaunchRequest = { request, fingerprint: creationFingerprint({ kind: 'native-rearm',
      agentId: rearm.agentId, operation: rearm.operation, source: rearm.source,
      ...(rearm.permissionMode === undefined ? {} : { permissionMode: rearm.permissionMode }),
    }) }
    const admitted = requests.find(value => value.receipt.request.creationId === rearm.requestId)
    if (admitted) {
      if (creationFingerprint(admitted.receipt) !== creationFingerprint(receipt)) return held('has a conflicting original request')
    } else {
      if (rearm.replacement) return held('is missing its admitted launch reference')
      requests.push({ receipt, admitted: false })
    }
  }
  if (!requests.length || requests.length > NATIVE_ALLOCATION_LIMIT + 1
    || new Set(requests.map(value => value.receipt.request.launchToken)).size !== requests.length) return held('has incomplete or reused launch identities')
  const engines = new Map<string, Readonly<NativeHookWriter>>(), panes = new Map<string, NativeStopAllocation>()
  const retained: Array<() => void> = []
  const addEngine = (owner: NativeHookWriter | null) => {
    if (!owner || !validNativeHookWriter(owner)) return held('has an unknown original engine incarnation')
    const value = Object.freeze({ boot: owner.boot, namespace: owner.namespace, pid: owner.pid, birth: owner.birth })
    engines.set(identity(value), value)
  }
  if (control.cancel.processKey !== null) addEngine(nativeTurnProcess(control.cancel))
  for (const { receipt, admitted } of requests) {
    current()
    const initial = receipt.request.kind === 'native-create-v2' ? parseNativeCreateRequest(receipt.request) : null
    if (!initial) {
      const original = receipt.request.sourceProcess
      addEngine(original && typeof original === 'object' ? nativeTurnProcess(original as { processKey: unknown; namespace?: unknown }) : null)
    }
    const id = receipt.request.creationId as string
    let proof: ReturnType<AgentCreationReceipts['readNativeRelaunchProcess']>
    try { proof = initial ? receipts.readNativeCreationProcess(id, { fingerprint: receipt.fingerprint, request: initial })
      : receipts.readNativeRelaunchProcess(id, receipt) }
    catch {
      if (admitted) return held('cannot read an admitted original witness')
      // A missing witness is not absence. Only the complete exact cancellation
      // or known-not-dispatched receipt can account for an unexecuted request.
      const absent = receipts.readNativeRelaunchNotDispatched(id, receipt)
      absent.verify(); retained.push(absent.verify); current()
      continue
    }
    const process = proof.process, pane = parseNativeLaunchAllocation(process.allocation, process)
    if (!pane || pane.token !== receipt.request.launchToken) return held('has no complete original pane witness')
    addEngine(process as NativeHookWriter)
    // Endpoint aliases can reach one server. They cannot hide a conflicting
    // lifetime behind a second spelling of the same pane address.
    const key = JSON.stringify([identity(pane.endpoint.server), pane.pane])
    const previous = panes.get(key)
    if (previous && creationFingerprint(previous) !== creationFingerprint(pane)) return held('needs its original pane lifetime transfer accounted for')
    panes.set(key, pane)
    proof.verify(); retained.push(proof.verify); current()
  }
  // Four confirmed references plus a separate pending R can retain six engine
  // incarnations: the oldest source and five exec witnesses. Never truncate.
  if (engines.size > NATIVE_ALLOCATION_LIMIT + 2 || panes.size > NATIVE_ALLOCATION_LIMIT + 1) return held('exceeds the bounded complete original ownership set')
  const verifyAllocations = () => { for (const verify of retained) { verify(); current() } current() }
  const verify = () => { verifyOwner(); current() }
  verifyAllocations(); verify()
  return Object.freeze({ budget, source, engines: Object.freeze([...engines.values()]), allocations: Object.freeze([...panes.values()]),
    verify, verifyAllocations, current })
}
