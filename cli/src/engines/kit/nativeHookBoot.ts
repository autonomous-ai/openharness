/** A kernel-issued boot UUID, shared without loading daemon configuration. */
import { execFile } from 'node:child_process'
import { NativeEvidenceBudget, nativeBytes, nativeText, nativeUnavailable } from './nativeEvidence.js'

export async function kernelBootId(budget: NativeEvidenceBudget): Promise<string> {
  const raw = process.platform === 'linux'
    ? nativeText(await nativeBytes('/proc/sys/kernel/random/boot_id', 128, budget))
    : process.platform === 'darwin' ? await new Promise<string>((resolve, reject) => {
      execFile('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
        encoding: 'utf8', timeout: budget.probe(), maxBuffer: 128, killSignal: 'SIGKILL',
      }, (error, stdout, stderr) => {
        if (error || stderr.length) reject(error ?? Error('kernel boot probe failed'))
        else resolve(stdout)
      })
    }) : nativeUnavailable('the kernel boot identity is unavailable on this platform')
  budget.step()
  const value = raw.trim().toLowerCase()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    return nativeUnavailable('the kernel boot identity is incomplete')
  }
  return `${process.platform}:${value}`
}
