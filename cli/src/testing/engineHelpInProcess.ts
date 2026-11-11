/**
 * `node:child_process` with an engine's `--help` answered in this process, for a spec that runs real native launch
 * preparation (engines/nativeLaunch.ts) to test what it prepares, not its probe. A launch that names no mode asks the
 * engine for its help; a real `/bin/sh` engine answering it ran past the probe's 5 s deadline on a loaded machine
 * (load 60), or failed at once (load 10), and the launch was held. What the probe does is nativeLaunch.probe.spec.ts's
 * to test. Every other call is the real one.
 *
 *   vi.mock('node:child_process', async (real) =>
 *     (await import('../../testing/engineHelpInProcess.js')).withEngineHelp(await real()))
 */
import type * as ChildProcess from 'node:child_process'
import { promisify } from 'node:util'

export function withEngineHelp(actual: typeof ChildProcess): typeof ChildProcess {
  const real = actual.execFile as unknown as (...values: unknown[]) => unknown
  const execFile = (file: string, ...rest: unknown[]) => {
    const args = rest[0]
    if (!Array.isArray(args) || args.length !== 1 || args[0] !== '--help') return real(file, ...rest)
    const done = rest.at(-1) as (error: null, stdout: string, stderr: string) => void
    queueMicrotask(() => done(null, 'Usage: engine\n', ''))
    return { stdin: { end() {} } }
  }
  // promisify(execFile) resolves { stdout, stderr } through Node's own custom form: kept, and real.
  const custom = (actual.execFile as unknown as Record<symbol, unknown>)[promisify.custom]
  return { ...actual, execFile: Object.assign(execFile, { [promisify.custom]: custom }) as unknown as typeof actual.execFile }
}
