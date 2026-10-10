/** Final PID-record proof after asynchronous process ownership checks. */
import { constants, openSync, closeSync, fstatSync, statSync, readSync, type BigIntStats } from 'node:fs'
import { NativeEvidenceBudget, nativeText, nativeUnavailable } from './nativeEvidence.js'
import { IdentityReadUnavailable } from './identityScan.js'

const stamp = (info: BigIntStats) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
/** Whole records only, bounded independently of the file's reported size. Missing records
 * are evidence too: a new native claim invalidates an earlier directory fallback. */
export function verifyProcessRecord(file: string, text: string | null, budget: NativeEvidenceBudget): void {
  budget.step()
  let fd: number
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && text === null) return
    return nativeUnavailable('the process records changed or became unreadable during discovery')
  }
  try {
    const before = fstatSync(fd, { bigint: true })
    if (!before.isFile() || before.size > 64n * 1024n) return nativeUnavailable('the process record is not a bounded regular file')
    const bytes = Buffer.alloc(Number(before.size))
    let length = 0
    for (let calls = 0; length < bytes.length; calls++) {
      budget.step()
      if (calls >= 64) return nativeUnavailable('the process record verification read limit was reached')
      const read = readSync(fd, bytes, length, bytes.length - length, length)
      budget.step(read)
      if (!read) return nativeUnavailable('the process record ended during verification')
      length += read
    }
    if (nativeText(bytes) !== text || stamp(fstatSync(fd, { bigint: true })) !== stamp(before)
      || stamp(statSync(file, { bigint: true })) !== stamp(before)) return nativeUnavailable('the process records changed during discovery')
  } catch (error) {
    if (error instanceof IdentityReadUnavailable) throw error
    return nativeUnavailable('the process record became unreadable during verification')
  } finally {
    try { closeSync(fd) } catch { nativeUnavailable('the process record could not be closed after verification') }
  }
}
