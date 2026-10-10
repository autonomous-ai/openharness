/** One native lookup owns one work budget, including its final verification. */
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { psEnv } from '../../lib/childLocale.js'
import { IdentityReadUnavailable } from './identityScan.js'

export const nativeUnavailable = (reason: string): never => { throw new IdentityReadUnavailable(reason) }

export class NativeEvidenceBudget {
  private readonly deadline: number
  private operations = 32_768
  private bytes = 16 * 1024 * 1024
  private probes = 64
  constructor(timeoutMs = 3_000) { this.deadline = performance.now() + timeoutMs }
  remaining(): number {
    const left = Math.floor(this.deadline - performance.now())
    if (left <= 0) nativeUnavailable('the native process evidence deadline was reached')
    return left
  }
  step(bytes = 0): void {
    this.remaining()
    if (--this.operations < 0 || (this.bytes -= bytes) < 0) nativeUnavailable('the native process evidence work limit was reached')
  }
  probe(): number {
    this.step()
    if (--this.probes < 0) nativeUnavailable('the native process probe limit was reached')
    return this.remaining()
  }
}

/** Error plus a readable prefix still means that the probe did not finish. */
export async function nativeProbe(command: 'ps' | 'lsof', args: string[], budget: NativeEvidenceBudget,
  maxBuffer = 512 * 1024,
): Promise<string> {
  const timeout = budget.probe()
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    execFile(command, args, { encoding: 'buffer', timeout, killSignal: 'SIGKILL', maxBuffer,
      env: psEnv({ ...process.env, LC_ALL: '', LC_CTYPE: process.platform === 'darwin' ? 'UTF-8' : 'C.UTF-8' }),
    }, (error, stdout, stderr) => {
      if (error || stderr.length) { reject(new IdentityReadUnavailable(`the native ${command} probe did not complete`)); return }
      resolve(stdout)
    })
  }).catch((error: unknown) => {
    if (error instanceof IdentityReadUnavailable) throw error
    return nativeUnavailable(`the native ${command} probe could not start`)
  })
  budget.step(bytes.length)
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return nativeUnavailable(`the native ${command} output is not complete UTF-8`) }
}

/** /proc reports zero file sizes. Read to a bounded EOF rather than trusting that size. */
export async function nativeBytes(path: string, maxBytes: number, budget: NativeEvidenceBudget): Promise<Buffer> {
  budget.step()
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    if (!(await handle.stat()).isFile()) nativeUnavailable('a native process record is not a regular file')
    const chunks: Buffer[] = []
    let total = 0
    for (let calls = 0; calls < 64; calls++) {
      budget.step()
      const buffer = Buffer.alloc(Math.min(4096, maxBytes + 1 - total))
      const read = await handle.read(buffer, 0, buffer.length, total)
      budget.step(read.bytesRead)
      if (!read.bytesRead) return Buffer.concat(chunks, total)
      total += read.bytesRead
      if (total > maxBytes) nativeUnavailable('a native process record exceeds its byte limit')
      chunks.push(buffer.subarray(0, read.bytesRead))
    }
    return nativeUnavailable('a native process record exceeds its read-operation limit')
  } catch (error) {
    if (error instanceof IdentityReadUnavailable) throw error
    return nativeUnavailable('a native process record could not be read completely')
  } finally { await handle?.close().catch(() => nativeUnavailable('a native process record could not be closed')) }
}

export function nativeText(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return nativeUnavailable('a native process record is not complete UTF-8') }
}
