/** Kernel evidence for local staging writers; unavailable is never dead. */
import type { NativeControlHelpers, NativeControlSnapshot } from '../../lib/nativeProcessControlProbe.js'
import { NativeEvidenceBudget, nativeUnavailable } from './nativeEvidence.js'
import { nativeHookScope, type NativeHookScope } from './nativeHookScope.js'

export interface NativeHookWriter { boot: string; namespace: string; pid: number; birth: string }

type Probe = (pids: readonly number[], budget: NativeEvidenceBudget) => Promise<NativeControlSnapshot>
const bootPattern = /^(linux|darwin):[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const decimal = (text: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER) => {
  const value = Number(text)
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum && String(value) === text
}
export function validNativeHookWriter(value: NativeHookWriter): boolean {
  if (!value || typeof value.boot !== 'string' || !bootPattern.test(value.boot)
    || !Number.isSafeInteger(value.pid) || value.pid <= 1 || value.pid > 0x7fffffff
    || typeof value.birth !== 'string' || value.birth.length > 40
    || typeof value.namespace !== 'string') return false
  // Compare only the exact strings the native probe emits. An alternate spelling
  // of the same birth must never be mistaken for a replacement process.
  if (value.boot.startsWith('linux:')) return decimal(value.birth, 0)
    && /^linux:(?:0|[1-9][0-9]{0,19}):[1-9][0-9]{0,19}$/.test(value.namespace)
    && value.namespace.split(':').slice(1).every(part => BigInt(part) <= 0xffffffffffffffffn)
  const parts = value.birth.split(':')
  return value.namespace === 'darwin' && parts.length === 2 && decimal(parts[0], 1) && decimal(parts[1], 0, 999_999)
}
function inspect(writer: NativeHookWriter): NativeHookWriter {
  const saved = writer && { boot: writer.boot, namespace: writer.namespace, pid: writer.pid, birth: writer.birth }
  if (!validNativeHookWriter(saved)) {
    return nativeUnavailable('the native hook writer identity is incomplete')
  }
  return saved
}
async function confirm(root: string, before: NativeHookScope, budget: NativeEvidenceBudget, helpers: NativeControlHelpers): Promise<void> {
  budget.step()
  const after = await nativeHookScope(root, budget, helpers)
  try {
    budget.step()
    before.verify(root); after.verify(root)
    if (before.boot !== after.boot || before.namespace !== after.namespace || before.storage !== after.storage) {
      return nativeUnavailable('the native hook writer scope changed during proof')
    }
  } finally { after.close() }
}

/** The writer is this process, separately from the hook's original engine caller. */
export async function captureNativeHookWriter(root: string, budget: NativeEvidenceBudget, probe: Probe, helpers: NativeControlHelpers) {
  const pid = process.pid, before = await nativeHookScope(root, budget, helpers)
  try {
    const row = (await probe([pid], budget)).rows.get(pid)
    budget.step()
    if (!row || row.pid !== pid) return nativeUnavailable('the current native hook writer is unreadable')
    const writer = inspect({ boot: before.boot, namespace: before.namespace, pid, birth: row.birth })
    await confirm(root, before, budget, helpers)
    // Close only after the pool's actual work and cleanup settle, not merely
    // when its request expires. Closing revokes every retained root fence.
    return { writer: Object.freeze(writer), verifyWriter: before.verify, closeWriter: before.close }
  } catch (error) { before.close(); throw error }
}

/** A local kernel restart, explicit ESRCH, or a freshly proved replacement birth
 * can retire the old writer. Permission errors and incomplete probes cannot. */
export async function nativeHookWriterDead(root: string, input: NativeHookWriter, budget: NativeEvidenceBudget, probe: Probe,
  helpers: NativeControlHelpers): Promise<boolean> {
  const writer = inspect(input), before = await nativeHookScope(root, budget, helpers)
  try {
    before.verify(root)
    if (before.boot.split(':')[0] !== writer.boot.split(':')[0]) return nativeUnavailable('the native hook writer platform scope differs')
    if (before.boot !== writer.boot) { await confirm(root, before, budget, helpers); return true }
    if (before.namespace !== writer.namespace) return nativeUnavailable('the native hook writer PID namespace differs')
    let absent = false
    budget.step()
    try { process.kill(writer.pid, 0) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return nativeUnavailable('native hook writer liveness is unavailable')
      absent = true
    }
    budget.step()
    if (absent) {
      await confirm(root, before, budget, helpers)
      return true
    }
    const row = (await probe([writer.pid], budget)).rows.get(writer.pid)
    budget.step()
    if (!row || row.pid !== writer.pid) return nativeUnavailable('the native hook writer generation is unavailable')
    const fresh = inspect({ boot: before.boot, namespace: before.namespace, pid: row.pid, birth: row.birth })
    await confirm(root, before, budget, helpers)
    return fresh.birth !== writer.birth
  } finally { before.close() }
}
