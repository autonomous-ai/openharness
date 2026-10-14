/** Fresh kernel incarnation evidence after asynchronous hook journal publication. */
import type { RegisteredSession } from '../../lib/registry.js'
import { readProcessEvidence } from '../../lib/processEvidence.js'
import { controlIdentity, nativeProcessControl, type NativeControlRow } from '../../lib/nativeProcessControl.js'
import { NativeEvidenceBudget, nativeUnavailable } from './nativeEvidence.js'
import { kernelBootId } from './nativeHookBoot.js'
import { nativeHookIdentityV1, type NativeHookOriginOwner } from './nativeHookOrigin.js'

export interface NativeHookOwner {
  /** Kernel boot, engine, PID and precise kernel birth; never an agent ID. */
  key: string
  /** Original image and command evidence, retained with the intake. */
  evidence: string
}
export type NativeHookOwnerProof = NativeHookOwner & { verify(): void }
export type NativeHookExpectedOwner = NativeHookOwner | NativeHookOriginOwner
export type NativeHookOwnerReader = (row: RegisteredSession, expected?: NativeHookExpectedOwner) => Promise<NativeHookOwnerProof>
export type NativeHookCaller = { owner(row: RegisteredSession): NativeHookExpectedOwner & { source?: 'caller' | 'runtime' } }
export type NativeHookCallerReader = (callerPid: number, runtimeOwners: readonly RegisteredSession[]) => Promise<NativeHookCaller>

export function createNativeHookOwnerReader(): NativeHookOwnerReader & { captureCaller: NativeHookCallerReader } {
  let boot: string | undefined, active = 0
  const slot = async <T>(read: (budget: NativeEvidenceBudget, boot: string) => Promise<T>): Promise<T> => {
    if (active >= 8) return nativeUnavailable('the native hook process evidence slots are occupied')
    active++
    try {
      const budget = new NativeEvidenceBudget()
      // A kernel boot UUID cannot change during this core's life. Failed reads
      // are never cached, and no wall-clock/uptime approximation is authority.
      boot ??= await kernelBootId(budget)
      return await read(budget, boot)
    } finally { active-- }
  }
  const identity = (row: RegisteredSession, birth: string, evidence: string, boot: string): NativeHookOwner => ({
    key: `${boot}\u0000${row.engine}\u0000${row.processIdentity!.pid}\u0000${birth}`, evidence,
  })
  const read: NativeHookOwnerReader = async (input, expected) => {
    const row = structuredClone(input), original = expected && { ...expected }
    if (!row.active || !row.processIdentity) return nativeUnavailable('the native hook process owner is unavailable')
    return slot(async (budget, boot) => {
      // Membership of the captured caller tree proves origin, not the Registry's
      // declared executable. Preserve both checks after an exec-in-place or PID reuse.
      const process = (await readProcessEvidence(row.processIdentity!.pid, budget, undefined, row.processIdentity!)).parent
      if (original && !process) return nativeUnavailable('the original native hook process exited')
      const birth = process?.nativeBirth, evidence = process?.controlIdentity
      if (!birth || !evidence) return nativeUnavailable('the precise native hook process incarnation is unavailable')
      const owner = identity(row, birth, evidence, boot)
      if (original && (original.key !== owner.key || ('evidence' in original
        ? original.evidence !== evidence : original.identityV1 !== nativeHookIdentityV1(evidence)))) {
        return nativeUnavailable('the original native hook process incarnation changed')
      }
      // The final probe is the last await before registry publication. Its
      // remaining work deadline is checked again inside that synchronous lock.
      const verify = () => budget.step()
      verify()
      return { ...owner, verify }
    })
  }
  const captureCaller: NativeHookCallerReader = async (callerPid, runtimeOwners) => {
    const candidates = structuredClone(runtimeOwners)
    if (!Number.isSafeInteger(callerPid) || callerPid <= 1) return nativeUnavailable('the native hook caller is unavailable')
    const prefix = slot(async (budget, boot) => {
      const ancestry = new Map<number, { birth: string; evidence: string }>()
      let bytes = 0
      let child: NativeControlRow | undefined, pid = callerPid
      while (pid > 1 && ancestry.size < 32 && !ancestry.has(pid)) {
        try {
          const pool = await nativeProcessControl(child ? [child.pid, pid] : [pid], 0, budget, false)
          const parent = pool.rows.get(pid)
          if (!parent || child && (!pool.rows.get(child.pid) || controlIdentity(pool.rows.get(child.pid)!) !== controlIdentity(child))) break
          const evidence = controlIdentity(parent)
          if ((bytes += Buffer.byteLength(evidence)) > 128 * 1024) break
          ancestry.set(pid, { birth: parent.birth, evidence }); child = parent; pid = parent.parentPid
        } catch {
          // An unreadable ancestor above the engine is not required. A later
          // resolution may select only the complete prefix already retained.
          break
        }
      }
      return { ancestry, boot }
    }).catch(() => undefined)
    // The fallback and ancestry take independent actual probe slots and budgets.
    // An unreadable Cursor runtime must not outlive its short-lived hook shell
    // before ancestry even starts. Neither observation is filled in after a wait.
    const initial = candidates.length === 1 ? candidates[0] : undefined
    const fallback = initial ? read(initial).catch(() => undefined) : Promise.resolve(undefined)
    const [captured, runtime] = await Promise.all([prefix, fallback])
    return { owner: row => {
      const native = row.processIdentity && captured?.ancestry.get(row.processIdentity.pid)
      if (native) return { ...identity(row, native.birth, native.evidence, captured!.boot), source: 'caller' }
      if (runtime && initial && initial.agentId === row.agentId && initial.engine === row.engine
        && JSON.stringify([initial.processIdentity, initial.runtimes, initial.primaryRuntimeKey])
          === JSON.stringify([row.processIdentity, row.runtimes, row.primaryRuntimeKey])) return { key: runtime.key, evidence: runtime.evidence, source: 'runtime' }
      return nativeUnavailable('the selected engine was not proved in the original native hook caller ancestry or runtime')
    } }
  }
  return Object.assign(read, { captureCaller })
}
