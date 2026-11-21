/** The probe's bounded child lifetime, also used by the artifact preparer. */
import { spawn, type ChildProcess } from 'node:child_process'

export interface OwnedTask<T> { result: Promise<T>; cancel(): void }
export interface CapturedChild { started: boolean; code: number | null; signal: NodeJS.Signals | null; out: string; err: string; failure: string | null }
export type CaptureStart = (file: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess

export function captureChild(node: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number,
  start?: CaptureStart, input?: string): OwnedTask<CapturedChild> {
  let child: ChildProcess
  try { child = start ? start(node, args, env) : spawn(node, args, { env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }) } catch {
    return { result: Promise.resolve({ started: false, code: null, signal: null, out: '', err: '', failure: 'probe process could not start' }), cancel: () => {} }
  }
  let out = '', err = '', bytes = 0, oversized = false
  let failure: string | null = null
  const kill = (): void => { try { child.kill('SIGKILL') } catch { /* actual close still owns the child */ } }
  const capture = (chunk: Buffer, stderr: boolean): void => {
    bytes += chunk.length
    if (bytes > 65_536) { if (!oversized) { oversized = true; kill() }; return }
    if (stderr) err += chunk.toString('utf8')
    else out += chunk.toString('utf8')
  }
  child.stdout?.on('data', (chunk: Buffer) => capture(chunk, false))
  child.stderr?.on('data', (chunk: Buffer) => capture(chunk, true))
  const result = new Promise<CapturedChild>(resolve => {
    let settled = false
    const timer = setTimeout(() => { failure ??= `no answer within ${timeoutMs} ms`; kill() }, timeoutMs)
    child.on('error', error => { failure ??= error.message })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ started: child.pid !== undefined, code, signal, out, err, failure: failure ?? (oversized ? 'probe output exceeds 65536 bytes' : null) })
    })
    if (input !== undefined) {
      const failed = (): void => { failure ??= 'child stdin delivery failed'; kill() }
      child.stdin?.on('error', failed)
      // One bounded payload. Writable.end queues EOF after buffered data, including under backpressure.
      try { if (child.stdin) child.stdin.end(input); else failed() } catch { failed() }
    }
  })
  return { result, cancel: kill }
}
