import { execFile } from 'node:child_process'
import { readFile, statfs } from 'node:fs/promises'
import { freemem, homedir, totalmem } from 'node:os'
import { parse } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const KiB = 1024
const MiB = KiB ** 2
export type MemoryPressure = 'normal' | 'warning' | 'critical'
export interface GpuResource {
  id: string
  name: string
  utilizationPercent: number | null
  memoryUsedBytes?: number | null
  memoryTotalBytes?: number | null
}
export interface MemoryReading {
  total: number
  available: number
  pressure?: MemoryPressure | null
  swapUsedBytes?: number | null
}

// Fixed arguments, bounded output and no shell, privileges, helper installation,
// persistent process or timer. A missing driver/counter stays unavailable.
async function command(file: string, args: string[]): Promise<string> {
  const { stdout } = await exec(file, args, {
    encoding: 'utf8', timeout: 1200, maxBuffer: 2 * MiB,
    windowsHide: true, env: { ...process.env, LC_ALL: 'C' },
  })
  return stdout
}
function number(value: string | undefined): number | null {
  if (value == null || !/^\d+(?:\.\d+)?$/.test(value.trim())) return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}
function percent(value: string | undefined): number | null {
  const n = number(value)
  return n != null && n <= 100 ? n : null
}

export function parseDarwinMemory(vm: string, total: number, sysctl: string): MemoryReading | null {
  const pageSize = number(/page size of\s+(\d+)\s+bytes/.exec(vm)?.[1])
  if (!pageSize || !Number.isFinite(total) || total <= 0) return null
  const counts = new Map<string, number>()
  for (const match of vm.matchAll(/^([^:\n]+):\s+(\d+)\.?\s*$/gm)) counts.set(match[1].trim(), Number(match[2]))
  const keys = ['Pages active', 'Pages inactive', 'Pages speculative', 'Pages wired down',
    'Pages occupied by compressor', 'Pages purgeable', 'File-backed pages']
  if (keys.some(key => !counts.has(key))) return null
  const used = (keys.slice(0, 5).reduce((sum, key) => sum + counts.get(key)!, 0)
    - counts.get('Pages purgeable')! - counts.get('File-backed pages')!) * pageSize
  if (!Number.isFinite(used) || used < 0 || used > total) return null
  const pressureLevel = /^\s*([124])\s*$/m.exec(sysctl)?.[1]
  const swap = /used\s*=\s*([\d.]+)([KMG])\b/.exec(sysctl)
  const swapValue = number(swap?.[1])
  return { total, available: total - used,
    pressure: pressureLevel === '1' ? 'normal' : pressureLevel === '2' ? 'warning' : pressureLevel === '4' ? 'critical' : null,
    swapUsedBytes: swap && swapValue != null ? swapValue * ({ K: KiB, M: MiB, G: KiB ** 3 }[swap[2]]!) : null,
  }
}

export function parseLinuxMemory(text: string, total: number): MemoryReading | null {
  const values = new Map([...text.matchAll(/^(\w+):\s+(\d+)\s+kB$/gm)].map(m => [m[1], Number(m[2]) * KiB]))
  const available = values.get('MemAvailable')
  if (available == null || available > total || !Number.isFinite(total) || total <= 0) return null
  const swapTotal = values.get('SwapTotal'), swapFree = values.get('SwapFree')
  return { total, available,
    swapUsedBytes: swapTotal != null && swapFree != null && swapFree <= swapTotal ? swapTotal - swapFree : null,
  }
}

export async function readMachineMemory(): Promise<MemoryReading> {
  const total = totalmem()
  try {
    if (process.platform === 'darwin') {
      const [vm, pressure] = await Promise.all([
        command('/usr/bin/vm_stat', []),
        command('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level', 'vm.swapusage']).catch(() => ''),
      ])
      const reading = parseDarwinMemory(vm, total, pressure)
      if (reading) return reading
    } else if (process.platform === 'linux') {
      const reading = parseLinuxMemory(await readFile('/proc/meminfo', 'utf8'), total)
      if (reading) return reading
    }
  } catch { /* Older/restricted hosts retain the portable OS reading. */ }
  return { total, available: freemem() }
}

export function parseNvidiaGpus(text: string): GpuResource[] {
  return text.split('\n').flatMap(line => {
    const fields = line.split(',').map(s => s.trim())
    if (fields.length !== 5 || !/^GPU-[\w-]+$/.test(fields[0]) || !fields[1]) return []
    const used = number(fields[3]), total = number(fields[4])
    const validMemory = used != null && total != null && total > 0 && used <= total
    return [{ id: fields[0], name: fields[1], utilizationPercent: percent(fields[2]),
      memoryUsedBytes: validMemory ? used * MiB : null,
      memoryTotalBytes: validMemory ? total * MiB : null }]
  })
}

export function parseDarwinGpus(text: string): GpuResource[] {
  const devices = text.split(/(?=\+-o )/)
  const readings = devices.flatMap(device => {
    const header = /^\+-o (.+?)\s+<class ([^,]+), id (0x[\da-f]+)/i.exec(device)
    const stats = /"PerformanceStatistics"\s*=\s*\{([^\n]+)\}/.exec(device)?.[1]
    if (!header || !stats) return []
    const read = (key: string) => new RegExp('"' + key + '"\\s*=\\s*(\\d+(?:\\.\\d+)?)').exec(stats)?.[1]
    const poweredOff = /"poweredOffByAGC"\s*=\s*1\b/.test(device)
    const utilizationPercent = poweredOff ? null : percent(read('Device Utilization %') ?? read('GPU Activity\\(%\\)'))
    const model = /"model"\s*=\s*"([^"\n]+)"/.exec(device)?.[1]
    const name = model ?? (/AGX/i.test(header[2]) ? 'Apple GPU' : /Intel/i.test(header[2]) ? 'Intel GPU'
      : /AMD/i.test(header[2]) ? 'AMD GPU' : header[1])
    return [{ id: header[3], name, utilizationPercent }]
  })
  // IORegistry may expose the same accelerator under multiple parents.
  return [...new Map(readings.map(gpu => [gpu.id, gpu])).values()]
}

export async function readMachineGpus(): Promise<GpuResource[]> {
  try {
    if (process.platform === 'darwin') {
      return parseDarwinGpus(await command('/usr/sbin/ioreg', ['-r', '-c', 'IOAccelerator', '-d', '1', '-l']))
    }
    if (process.platform === 'linux' || process.platform === 'win32') {
      return parseNvidiaGpus(await command('nvidia-smi', [
        '--query-gpu=uuid,name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits',
      ]))
    }
  } catch { /* GPU telemetry is optional; lack of it must never fail CPU/RAM. */ }
  return []
}

export async function readMachineDisk(): Promise<{ diskFreeBytes: number | null; diskTotalBytes: number | null }> {
  try {
    const disk = await statfs(parse(homedir()).root)
    const free = disk.bavail * disk.bsize, total = disk.blocks * disk.bsize
    if (Number.isSafeInteger(free) && Number.isSafeInteger(total) && total > 0 && free >= 0 && free <= total) {
      return { diskFreeBytes: free, diskTotalBytes: total }
    }
  } catch { /* Filesystem information is optional. */ }
  return { diskFreeBytes: null, diskTotalBytes: null }
}
