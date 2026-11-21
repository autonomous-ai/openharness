/** Native paste fixture ownership. Reads process identity only, never process arguments or environment. */
import { readFileSync } from 'node:fs'

export interface OwnedProcess { pid: number; start: string }
interface ProcessStat extends OwnedProcess { group: number }
type ReadStat = (pid: number) => string
const readStat: ReadStat = pid => readFileSync(`/proc/${pid}/stat`, 'utf8')

function parseStat(stat: string): ProcessStat {
  const pid = Number(stat.slice(0, stat.indexOf(' ')))
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
  const group = Number(fields[2]), start = fields[19]
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(group) || group <= 0
    || !start || !/^\d+$/.test(start)) throw new Error('PASTE_NATIVE_INVALID_PROCESS_IDENTITY')
  return { pid, group, start }
}

export function captureProcess(pid: number, read: ReadStat = readStat): OwnedProcess {
  const found = parseStat(read(pid))
  if (found.pid !== pid) throw new Error('PASTE_NATIVE_PROCESS_IDENTITY_CHANGED')
  return { pid, start: found.start }
}

export function processGone(owner: OwnedProcess, read: ReadStat = readStat): boolean {
  try { return captureProcess(owner.pid, read).start !== owner.start }
  catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return true
    throw error
  }
}

/** The wrapper records its real process-group leader before exec; the watcher keeps that group alive. */
export function captureClipboardGroup(marker: string, rows: string, read: ReadStat = readStat): OwnedProcess[] {
  const leader = parseStat(marker)
  if (leader.group !== leader.pid) throw new Error('PASTE_NATIVE_NOT_OWN_GROUP')
  const lines = rows.trim().split('\n')
  if (lines.length > 4096) throw new Error('PASTE_NATIVE_PROCESS_LIST_LIMIT')
  const owners: OwnedProcess[] = []
  for (const line of lines) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (!match) throw new Error('PASTE_NATIVE_INVALID_PROCESS_LIST')
    if (Number(match[2]) !== leader.group) continue
    if (owners.length >= 8) throw new Error('PASTE_NATIVE_GROUP_LIMIT')
    const stat = parseStat(read(Number(match[1])))
    if (stat.pid !== Number(match[1]) || stat.group !== leader.group || BigInt(stat.start) < BigInt(leader.start)) {
      throw new Error('PASTE_NATIVE_PROCESS_IDENTITY_CHANGED')
    }
    owners.push({ pid: stat.pid, start: stat.start })
  }
  if (owners.length < 2) throw new Error('PASTE_NATIVE_SELECTION_OWNER_NOT_CAPTURED')
  return owners
}

export function terminateProcess(owner: OwnedProcess, read: ReadStat = readStat,
  kill: (pid: number) => void = pid => { process.kill(pid, 'SIGKILL') }): void {
  if (processGone(owner, read)) return
  try { kill(owner.pid) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
}

/** A failed wait must never skip termination of another fixture-owned process or removal of its root. */
export async function cleanupPasteFixture(actions: ReadonlyArray<readonly [string, () => void | Promise<void>]>): Promise<void> {
  const failures: Error[] = []
  for (const [name, action] of actions) {
    try { await action() }
    catch (cause) { failures.push(new Error(name, { cause })) }
  }
  if (failures.length) throw new AggregateError(failures, 'PASTE_NATIVE_CLEANUP_FAILED')
}
