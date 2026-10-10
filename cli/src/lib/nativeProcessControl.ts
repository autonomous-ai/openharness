/** Joined, bounded kernel evidence for control. Discovery's partial image reader is not authority. */
import { execFile } from 'node:child_process'
import { constants, closeSync, fstatSync, openSync, opendirSync, readlinkSync, readSync, statSync } from 'node:fs'
import { IdentityReadUnavailable } from '../engines/kit/identityScan.js'
import type { NativeDescriptor } from '../engines/kit/nativeDescriptors.js'
import { NativeEvidenceBudget, nativeText, nativeUnavailable } from '../engines/kit/nativeEvidence.js'
import { bundledProcessImageHelper, invalidateProcessImageHelper } from './nativeProcessImages.js'
import { psEnv } from './childLocale.js'

export interface NativeControlRow {
  pid: number
  parentPid: number
  command: string
  imagePath: string
  argv?: readonly string[]
  commandDigest?: string
  birth: string
  fds: readonly NativeDescriptor[]
}
export interface NativeControlSnapshot {
  parent: number
  children: readonly number[]
  rows: ReadonlyMap<number, NativeControlRow>
}
export const controlIdentity = (row: Omit<NativeControlRow, 'fds'>) =>
  JSON.stringify([row.pid, row.parentPid, row.birth, row.command, row.imagePath, row.argv ?? null, row.commandDigest ?? null])
const validPid = (pid: unknown): pid is number => Number.isInteger(pid) && Number(pid) > 0 && Number(pid) <= 0x7fffffff
const sorted = (pids: readonly number[]) => [...pids].sort((a, b) => a - b).join(',')
const uint = (value: unknown, max: number) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max

/** lsof's socket family is immaterial to file ownership; every numeric FD remains in the pool. */
export function controlDescriptors(rows: readonly NativeDescriptor[]): string {
  return rows.filter(row => /^\d+$/.test(row.fd)).map(row => process.platform === 'darwin'
    ? JSON.stringify([row.fd, /^(?:unix|IPv[46]|systm|NDRV|LINK|SOCKET)$/.test(row.kind) ? 'SOCKET' : row.kind,
      String(row.device), String(row.inode)])
    : JSON.stringify([row.fd, row.path, row.kind, String(row.device), String(row.inode)])).sort().join('\n')
}

function hex(value: unknown, max: number, allowNul = false): string {
  if (typeof value !== 'string' || !value.length || value.length > max * 2 || value.length % 2 || !/^[a-f0-9]+$/.test(value)) {
    return nativeUnavailable('the native control reply contains invalid bytes')
  }
  const text = nativeText(Buffer.from(value, 'hex'))
  if (!allowNul && text.includes('\0')) return nativeUnavailable('the native control reply contains an invalid string')
  return text
}

/** No prefixes, duplicate/missing rows, permissive JSON types or rounded inode numbers. */
export function parseNativeProcessControl(output: string, pids: readonly number[], parent: number,
  budget: NativeEvidenceBudget,
): NativeControlSnapshot {
  if (!output.endsWith('\n') || Buffer.byteLength(output) > 5 * 1024 * 1024) return nativeUnavailable('the native control reply is incomplete')
  const lines = output.slice(0, -1).split('\n'), rows = new Map<number, NativeControlRow>()
  if (lines.length !== pids.length + 1) return nativeUnavailable('the native control reply has an incomplete process pool')
  const json = (text: string) => { try { return JSON.parse(text) } catch { return nativeUnavailable('the native control reply is malformed') } }
  const header = json(lines.shift()!)
  if (header?.schema !== 2 || header.mode !== 'control' || header.parent !== parent || !Array.isArray(header.children)
    || header.children.length > 32 || header.children.some((pid: unknown) => !validPid(pid) || pid === parent)
    || new Set(header.children).size !== header.children.length || (!parent && header.children.length)) {
    return nativeUnavailable('the native control reply has an ambiguous child pool')
  }
  let fds = 0
  for (const line of lines) {
    budget.step()
    const row = json(line)
    if (!row || !validPid(row.pid) || !pids.includes(row.pid) || rows.has(row.pid) || !uint(row.parentPid, 0x7fffffff)
      || !uint(row.startSeconds, Number.MAX_SAFE_INTEGER) || !row.startSeconds || !uint(row.startMicros, 999_999)
      || typeof row.commandDigest !== 'string' || !/^[a-f0-9]{64}$/.test(row.commandDigest)
      || !Array.isArray(row.fds) || (fds += row.fds.length) > 4096) {
      return nativeUnavailable('the native control reply has an invalid process record')
    }
    const command = hex(row.commandHex, 16), imagePath = hex(row.imageHex, 4095)
    if (!imagePath.startsWith('/') || imagePath.endsWith(' (deleted)')) {
      return nativeUnavailable('the native control command is incomplete')
    }
    const descriptors: NativeDescriptor[] = [], seen = new Set<number>()
    for (const fd of row.fds) {
      budget.step()
      if (!fd || !uint(fd.fd, 0x7fffffff) || seen.has(fd.fd) || !uint(fd.type, 11) || fd.type === 8
        || !uint(fd.mode, 0xffff) || typeof fd.device !== 'string' || !/^\d{1,10}$/.test(fd.device)
        || BigInt(fd.device) > 0xffffffffn || typeof fd.inode !== 'string' || !/^\d{1,20}$/.test(fd.inode)
        || BigInt(fd.inode) > 0xffffffffffffffffn) return nativeUnavailable('the native control descriptor is invalid')
      seen.add(fd.fd)
      const kinds: Record<number, string> = { 2: 'SOCKET', 3: 'PSXSHM', 4: 'PSXSEM', 5: 'KQUEUE', 6: 'PIPE', 7: 'FSEVENT' }
      const modes: Record<number, string> = { [0o100000]: 'REG', [0o040000]: 'DIR', [0o020000]: 'CHR', [0o060000]: 'BLK', [0o010000]: 'FIFO' }
      const kind = fd.type === 1 ? modes[fd.mode] : kinds[fd.type]
      if (!kind || (fd.type === 1 ? fd.inode === '0' : fd.mode !== 0 || fd.device !== '0' || fd.inode !== '0')) {
        return nativeUnavailable('the native control descriptor type is unavailable')
      }
      descriptors.push({ fd: String(fd.fd), path: '', kind,
        ...(fd.type === 1 ? { device: BigInt(fd.device), inode: BigInt(fd.inode) } : {}) })
    }
    rows.set(row.pid, { pid: row.pid, parentPid: row.parentPid, command, imagePath, commandDigest: row.commandDigest,
      birth: `${row.startSeconds}:${row.startMicros}`, fds: descriptors })
  }
  return { parent, children: header.children, rows }
}

export function linuxProcessStat(text: string, pid: number): { command: string; parentPid: number; state: string; startTicks: number } {
  const start = text.indexOf('('), end = text.lastIndexOf(')')
  if (start < 1 || end <= start || Number(text.slice(0, start).trim()) !== pid) return nativeUnavailable('the native process generation is malformed')
  const fields = text.slice(end + 1).trim().split(/\s+/), startTicks = Number(fields[19])
  if (!/^[A-Za-z]$/.test(fields[0] ?? '') || !/^\d+$/.test(fields[1] ?? '') || !uint(Number(fields[1]), 0x7fffffff)
    || !/^\d+$/.test(fields[19] ?? '') || !Number.isSafeInteger(startTicks)) return nativeUnavailable('the native process generation is incomplete')
  return { command: text.slice(start + 1, end), parentPid: Number(fields[1]), state: fields[0], startTicks }
}

function linuxControl(pids: readonly number[], parent: number, budget: NativeEvidenceBudget): NativeControlSnapshot {
  const bytes = (path: string, limit: number) => {
    budget.step()
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      if (!fstatSync(fd).isFile()) return nativeUnavailable('a native process record is not regular')
      const result = Buffer.alloc(limit + 1)
      let used = 0
      for (let calls = 0; calls < 64; calls++) {
        budget.step()
        const count = readSync(fd, result, used, Math.min(4096, result.length - used), used)
        budget.step(count); used += count
        if (used > limit) return nativeUnavailable('a native process record exceeds its byte limit')
        if (!count) return nativeText(result.subarray(0, used))
      }
      return nativeUnavailable('a native process record exceeds its read limit')
    } finally { closeSync(fd) }
  }
  const entries = (path: string, limit: number) => {
    budget.step()
    const directory = opendirSync(path, { bufferSize: 32 }), names: string[] = []
    try {
      for (;;) {
        budget.step()
        const next = directory.readSync()
        if (!next) return names
        if (!/^\d+$/.test(next.name) || names.length >= limit) return nativeUnavailable('the native directory pool exceeds its limit')
        names.push(next.name)
      }
    } finally { directory.closeSync() }
  }
  const stat = (pid: number) => linuxProcessStat(bytes(`/proc/${pid}/stat`, 8192), pid)
  const children = () => {
    if (!parent) return []
    const tasks = entries(`/proc/${parent}/task`, 128), ids: number[] = []
    if (!tasks.length) return nativeUnavailable('the native task pool is empty')
    for (const task of tasks) {
      const text = bytes(`/proc/${parent}/task/${task}/children`, 1024)
      if (!/^(?:\d+\s+)*$/.test(text)) return nativeUnavailable('the native child pool is malformed')
      for (const value of text.trim().split(/\s+/).filter(Boolean)) {
        const id = Number(value)
        if (!validPid(id) || ids.includes(id) || ids.length >= 32) return nativeUnavailable('the native child pool exceeds its limit or is ambiguous')
        const info = stat(id)
        if (info.parentPid !== parent) return nativeUnavailable('the native child changed parent')
        if (!/^[ZXx]/.test(info.state)) ids.push(id)
      }
    }
    if (entries(`/proc/${parent}/task`, 128).sort().join(',') !== tasks.sort().join(',')) return nativeUnavailable('the native task pool changed')
    return ids
  }
  const metadata = (pid: number) => {
    const before = stat(pid)
    if (/^[ZXx]/.test(before.state)) return nativeUnavailable('the native process has exited')
    budget.step()
    const imagePath = readlinkSync(`/proc/${pid}/exe`), args = bytes(`/proc/${pid}/cmdline`, 65_536)
    const after = stat(pid)
    budget.step()
    if (before.parentPid !== after.parentPid || before.startTicks !== after.startTicks || before.command !== after.command
      || /^[ZXx]/.test(after.state) || readlinkSync(`/proc/${pid}/exe`) !== imagePath) return nativeUnavailable('the native process changed during control inspection')
    if (!imagePath.startsWith('/') || imagePath.endsWith(' (deleted)') || !args.endsWith('\0') || !args[0] || args[0] === '\0') return nativeUnavailable('the native process command is incomplete')
    return { pid, parentPid: before.parentPid, command: before.command, imagePath, argv: args.slice(0, -1).split('\0'), birth: String(before.startTicks) }
  }
  const read = () => {
    const rows = new Map<number, NativeControlRow>()
    let total = 0
    for (const pid of pids) {
      const before = metadata(pid), fds: NativeDescriptor[] = []
      for (const fd of entries(`/proc/${pid}/fd`, 4096)) {
        budget.step()
        if (++total > 4096) return nativeUnavailable('the native descriptor pool exceeds its limit')
        const location = `/proc/${pid}/fd/${fd}`, path = readlinkSync(location)
        budget.step(Buffer.byteLength(path))
        if (path.startsWith('/')) {
          const info = statSync(location, { bigint: true })
          fds.push({ fd, path, kind: info.isFile() ? 'REG' : 'OTHER', device: info.dev, inode: info.ino })
        } else {
          if (!/^(?:socket:\[\d+\]|pipe:\[\d+\]|anon_inode:.*)$/.test(path)) return nativeUnavailable('a native descriptor target is unreadable')
          fds.push({ fd, path, kind: 'OTHER' })
        }
      }
      if (controlIdentity(metadata(pid)) !== controlIdentity(before)) return nativeUnavailable('the native process changed around its descriptors')
      rows.set(pid, { ...before, fds })
    }
    return rows
  }
  try {
    const firstChildren = children(), first = read(), rows = read()
    if (sorted(children()) !== sorted(firstChildren)) return nativeUnavailable('the native child pool changed during control inspection')
    for (const [pid, row] of first) {
      const now = rows.get(pid)!
      if (controlIdentity(now) !== controlIdentity(row) || controlDescriptors(now.fds) !== controlDescriptors(row.fds)) return nativeUnavailable('the native control evidence changed during inspection')
    }
    budget.step()
    return { parent, children: firstChildren, rows }
  } catch (error) {
    if (error instanceof IdentityReadUnavailable) throw error
    return nativeUnavailable('the native control evidence could not be read completely')
  }
}

/** No ps/lsof wait separates the last process and descriptor observations. This does not
 * freeze an external process; immutable core ownership is still checked by every caller. */
export async function nativeProcessControl(pids: readonly number[], parent: number, budget: NativeEvidenceBudget): Promise<NativeControlSnapshot> {
  if (!pids.length || pids.length > 33 || pids.some(pid => !validPid(pid)) || new Set(pids).size !== pids.length
    || (parent !== 0 && (!validPid(parent) || !pids.includes(parent)))) return nativeUnavailable('the native control request is invalid')
  if (process.platform === 'linux') return linuxControl(pids, parent, budget)
  if (process.platform !== 'darwin') return nativeUnavailable('native control evidence is unavailable on this platform')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const helper = await Promise.race([bundledProcessImageHelper({ retryUnavailable: true }), new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), budget.remaining())
    })])
    if (!helper) return nativeUnavailable('the native control helper is unavailable')
    const timeout = budget.probe()
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      execFile(helper.path, ['--control', String(Math.min(timeout, 3000)), String(parent), ...pids.map(String)],
        { encoding: 'buffer', timeout, maxBuffer: 5 * 1024 * 1024, killSignal: 'SIGKILL', env: psEnv() },
        (error, stdout, stderr) => {
          if (error && ['ENOENT', 'ENOTDIR', 'EACCES', 'ENOEXEC'].includes(String(error.code))) invalidateProcessImageHelper(helper.key)
          if (error || stderr.length) reject(new IdentityReadUnavailable('the native control probe did not complete'))
          else resolve(stdout)
        })
    })
    budget.step(bytes.length)
    return parseNativeProcessControl(nativeText(bytes), pids, parent, budget)
  } catch (error) {
    if (error instanceof IdentityReadUnavailable) throw error
    return nativeUnavailable('the native control probe could not start')
  } finally { if (timer) clearTimeout(timer) }
}
