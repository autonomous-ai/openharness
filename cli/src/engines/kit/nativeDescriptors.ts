/** Fresh descriptor evidence. An incomplete listing is never an empty conversation pool. */
import { opendir, readlink, stat } from 'node:fs/promises'
import { NativeEvidenceBudget, nativeProbe, nativeUnavailable } from './nativeEvidence.js'
import { IdentityReadUnavailable } from './identityScan.js'

export interface NativeDescriptor {
  fd: string
  path: string
  kind: string
  device?: bigint
  inode?: bigint
}
export interface DescriptorEvidence {
  descriptors: readonly NativeDescriptor[]
  verify(): Promise<void>
}
export const descriptorKey = (row: NativeDescriptor) => `${row.device}:${row.inode}`
const signature = (rows: readonly NativeDescriptor[]) => rows.map(row =>
  JSON.stringify([row.fd, row.path, row.kind, String(row.device), String(row.inode)])).sort().join('\n')
const knownKinds = new Set(['REG', 'DIR', 'CHR', 'BLK', 'FIFO', 'PIPE', 'unix', 'IPv4', 'IPv6', 'KQUEUE', 'FSEVENT', 'PSXSEM', 'PSXSHM', 'systm', 'NDRV', 'LINK'])

/** -F0 still terminates each process/file set with NL after its final NUL field. */
export function parseDescriptors(output: string, pid: number, budget: NativeEvidenceBudget): NativeDescriptor[] {
  if (!output.endsWith('\0\n')) return nativeUnavailable('the native descriptor listing is incomplete')
  const groups = output.slice(0, -1).split('\n')
  const rows: NativeDescriptor[] = [], seen = new Set<string>()
  let processSeen = false
  for (const group of groups) {
    budget.step()
    if (!group.endsWith('\0')) return nativeUnavailable('the native descriptor fields are incomplete')
    const fields = new Map<string, string>()
    for (const field of group.slice(0, -1).split('\0')) {
      if (!field || !'pftDin'.includes(field[0]) || fields.has(field[0])) return nativeUnavailable('the native descriptor fields are ambiguous')
      if (Buffer.byteLength(field) > (field[0] === 'n' ? 16_385 : 65)) return nativeUnavailable('a native descriptor field exceeds its limit')
      fields.set(field[0], field.slice(1))
    }
    if (fields.has('p')) {
      if (processSeen || fields.size !== 1 || fields.get('p') !== String(pid)) return nativeUnavailable('the native descriptor owner is ambiguous')
      processSeen = true
      continue
    }
    const fd = fields.get('f'), kind = fields.get('t'), path = fields.get('n')
    if (!processSeen || !fd || !kind || !path || rows.length >= 4096) {
      return nativeUnavailable('the native descriptor pool is incomplete or exceeds its limit')
    }
    if (!/^(?:\d{1,10}|cwd|rtd|txt|mem)$/.test(fd) || !knownKinds.has(kind)) return nativeUnavailable('a native descriptor is unreadable or has an unknown type')
    const device = fields.get('D'), inode = fields.get('i')
    if ((device !== undefined && !/^0x[0-9a-f]{1,16}$/i.test(device)) || (inode !== undefined && !/^\d{1,20}$/.test(inode))
      || (inode !== undefined && BigInt(inode) > 0xffffffffffffffffn)
      || (kind === 'REG' && (device === undefined || inode === undefined || !path.startsWith('/')))) {
      return nativeUnavailable('a native file descriptor has no conclusive file identity')
    }
    // A mapped executable/library is reported as another `txt` row. Numeric descriptors
    // remain unique; treating all `txt` records as one silently loses mapped files.
    const key = /^\d+$/.test(fd) ? fd : JSON.stringify([fd, device, inode, path])
    if (seen.has(key)) return nativeUnavailable('the native descriptor pool has duplicate entries')
    seen.add(key)
    rows.push({ fd, kind, path, ...(device === undefined ? {} : { device: BigInt(device) }),
      ...(inode === undefined ? {} : { inode: BigInt(inode) }) })
  }
  if (!processSeen) return nativeUnavailable('the native descriptor owner is missing')
  return rows
}

async function linuxDescriptors(pid: number, budget: NativeEvidenceBudget): Promise<NativeDescriptor[]> {
  const rows: NativeDescriptor[] = []
  budget.step()
  try {
    const directory = await opendir(`/proc/${pid}/fd`, { bufferSize: 32 })
    for await (const entry of directory) {
      budget.step()
      if (!/^\d+$/.test(entry.name) || rows.length >= 4096) return nativeUnavailable('the native descriptor pool exceeds its limit or has an invalid entry')
      const location = `/proc/${pid}/fd/${entry.name}`, path = await readlink(location)
      budget.step(Buffer.byteLength(path))
      if (path.startsWith('/')) {
        const info = await stat(location, { bigint: true })
        rows.push({ fd: entry.name, path, kind: info.isFile() ? 'REG' : 'OTHER', device: info.dev, inode: info.ino })
      } else {
        if (!/^(?:socket:\[\d+\]|pipe:\[\d+\]|anon_inode:.*)$/.test(path)) return nativeUnavailable('a native descriptor target is unreadable')
        rows.push({ fd: entry.name, path, kind: 'OTHER' })
      }
    }
  } catch (error) {
    if (error instanceof IdentityReadUnavailable) throw error
    return nativeUnavailable('the native descriptor pool could not be read completely')
  }
  budget.step()
  return rows
}

export async function readDescriptorEvidence(pid: number, budget: NativeEvidenceBudget): Promise<DescriptorEvidence> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return nativeUnavailable('the native descriptor owner is invalid')
  const read = () => process.platform === 'linux' ? linuxDescriptors(pid, budget)
    : nativeProbe('lsof', ['-n', '-P', '-p', String(pid), '-F0pftDin'], budget, 1024 * 1024)
      .then(output => parseDescriptors(output, pid, budget))
  const descriptors = await read(), before = signature(descriptors)
  return { descriptors, verify: async () => {
    if (signature(await read()) !== before) nativeUnavailable('the native descriptor pool changed during inspection')
  } }
}

/** lsof can escape control and non-ASCII bytes even in field mode. The kernel inode, not
 * a guessed spelling, chooses between literal and escaped names. Unresolvable names hold. */
export function descriptorPaths(path: string): string[] {
  if (Buffer.byteLength(path) > 16_384) return nativeUnavailable('a native descriptor path exceeds its limit')
  const bytes: Buffer[] = []
  for (let index = 0; index < path.length;) {
    const escape = /^\\(?:x([0-9a-fA-F]{2})|([abfnrtv\\]))/.exec(path.slice(index))
    if (escape) {
      const special: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92 }
      bytes.push(Buffer.from([escape[1] ? parseInt(escape[1], 16) : special[escape[2]]]))
      index += escape[0].length
    } else {
      const char = String.fromCodePoint(path.codePointAt(index)!)
      bytes.push(Buffer.from(char)); index += char.length
    }
  }
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(bytes))
    return [...new Set([path, decoded])]
  } catch { return [path] }
}
