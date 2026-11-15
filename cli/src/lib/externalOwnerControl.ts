/** Session-control primitives stay in core's eager import closure, independent of search readers. */
import { execFile } from 'node:child_process'

function run(command: string, args: string[], timeout: number): Promise<string | null> {
  return new Promise(resolve => execFile(command, args, { timeout, encoding: 'utf8' }, (error, stdout) => resolve(error ? null : stdout)))
}

/** Failed process evidence is distinct from verified non-leadership for new core admissions. */
export async function verifiedForegroundJob(pid: number, exec: typeof run = run): Promise<number | null | 'unknown'> {
  const out = await exec('ps', ['-o', 'pgid=,tpgid=', '-p', String(pid)], 3_000)
  if (!out) return 'unknown'
  const values = out.trim().split(/\s+/).map(Number)
  if (values.length !== 2 || !values.every(Number.isSafeInteger) || values[0] <= 0 || values[1] === 0) return 'unknown'
  return values[0] === pid && values[1] === pid ? pid : null
}
