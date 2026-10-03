// Originally written by Fred Nix (@nixfred) in github.com/nixfred/openharness (MIT).

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { cpus, loadavg } from 'node:os'

/**
 * What this machine can take right now: GPU memory and load, CPU load, power source, thermal
 * headroom, lid state and which toolchains are on PATH. Read on demand, never cached for long,
 * because the whole point is to refuse work on a card that just got busy or a laptop that just
 * went to battery. Every reader is injectable so the placement rules are testable without a GPU.
 */
export interface GpuCapability {
  name: string
  vramTotalMb: number
  vramUsedMb: number
  utilizationPct: number
}

export interface MachineCapabilities {
  at: number
  hostname: string
  cpu: { cores: number; load1: number; load5: number }
  gpus: GpuCapability[]
  power: { onAc: boolean; batteryPct: number | null }
  thermal: { maxC: number | null }
  lid: 'open' | 'closed' | 'unknown'
  toolchains: Record<string, boolean>
}

export interface CapabilityReaders {
  nvidiaSmi: () => Promise<string>
  readFile: (path: string) => Promise<string>
  listDir: (path: string) => Promise<string[]>
  which: (cmd: string) => Promise<boolean>
  hostname: () => string
  loadavg: () => number[]
  cores: () => number
  now: () => number
}

export const TOOLCHAINS_TO_PROBE = ['node', 'python3', 'git', 'gh', 'tmux', 'flutter', 'qs', 'docker', 'cargo', 'bun', 'uv']

const run = (cmd: string, args: string[], timeout = 3000): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 1 << 20 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))))
  })

export const systemReaders: CapabilityReaders = {
  nvidiaSmi: () => run('nvidia-smi', ['--query-gpu=name,memory.total,memory.used,utilization.gpu', '--format=csv,noheader,nounits']),
  readFile: (p) => fs.readFile(p, 'utf8'),
  listDir: (p) => fs.readdir(p),
  which: async (cmd) => { try { await run('sh', ['-c', `command -v ${cmd}`]); return true } catch { return false } },
  hostname: () => process.env.HOSTNAME ?? require('node:os').hostname(),
  loadavg,
  cores: () => cpus().length,
  now: () => Date.now(),
}

export function parseNvidiaSmi(csv: string): GpuCapability[] {
  return csv.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const [name = '', total = '0', used = '0', util = '0'] = line.split(',').map((s) => s.trim())
    return { name, vramTotalMb: Number(total) || 0, vramUsedMb: Number(used) || 0, utilizationPct: Number(util) || 0 }
  })
}

async function readPower(r: CapabilityReaders): Promise<MachineCapabilities['power']> {
  let onAc = true
  let batteryPct: number | null = null
  let supplies: string[] = []
  try { supplies = await r.listDir('/sys/class/power_supply') } catch { return { onAc, batteryPct } }
  for (const s of supplies) {
    const base = `/sys/class/power_supply/${s}`
    let type = ''
    try { type = (await r.readFile(`${base}/type`)).trim() } catch { continue }
    if (type === 'Mains') {
      try { onAc = (await r.readFile(`${base}/online`)).trim() === '1' } catch { /* keep default */ }
    } else if (type === 'Battery') {
      try { batteryPct = Number((await r.readFile(`${base}/capacity`)).trim()) } catch { /* unknown */ }
      // A battery that is discharging means no mains, even when no Mains supply is exposed.
      try { if ((await r.readFile(`${base}/status`)).trim() === 'Discharging') onAc = false } catch { /* ignore */ }
    }
  }
  return { onAc, batteryPct }
}

async function readThermal(r: CapabilityReaders): Promise<number | null> {
  let zones: string[] = []
  try { zones = await r.listDir('/sys/class/thermal') } catch { return null }
  let max: number | null = null
  for (const z of zones) {
    if (!z.startsWith('thermal_zone')) continue
    try {
      const milli = Number((await r.readFile(`/sys/class/thermal/${z}/temp`)).trim())
      if (Number.isFinite(milli)) max = Math.max(max ?? -Infinity, milli / 1000)
    } catch { /* zone without a reading */ }
  }
  return max
}

async function readLid(r: CapabilityReaders): Promise<MachineCapabilities['lid']> {
  let lids: string[] = []
  try { lids = await r.listDir('/proc/acpi/button/lid') } catch { return 'unknown' }
  for (const l of lids) {
    try {
      const state = await r.readFile(`/proc/acpi/button/lid/${l}/state`)
      if (/closed/i.test(state)) return 'closed'
      if (/open/i.test(state)) return 'open'
    } catch { /* next lid */ }
  }
  return 'unknown'
}

export async function readMachineCapabilities(r: CapabilityReaders = systemReaders): Promise<MachineCapabilities> {
  let gpus: GpuCapability[] = []
  try { gpus = parseNvidiaSmi(await r.nvidiaSmi()) } catch { gpus = [] }
  const [power, maxC, lid] = await Promise.all([readPower(r), readThermal(r), readLid(r)])
  const toolchains: Record<string, boolean> = {}
  await Promise.all(TOOLCHAINS_TO_PROBE.map(async (t) => { toolchains[t] = await r.which(t) }))
  const [load1 = 0, load5 = 0] = r.loadavg()
  return { at: r.now(), hostname: r.hostname(), cpu: { cores: r.cores(), load1, load5 }, gpus, power, thermal: { maxC }, lid, toolchains }
}

/** What a job asks of a machine. Everything optional: an empty request fits anywhere that is up. */
export interface PlacementRequest {
  needsGpu?: boolean
  minFreeVramMb?: number
  interactive?: boolean
  allowOnBattery?: boolean
  allowLidClosed?: boolean
  maxLoadPerCore?: number
  toolchains?: string[]
}

export interface PlacementDecision { ok: boolean; reasons: string[] }

export const GPU_BUSY_UTILIZATION_PCT = 60
export const HOT_C = 90

/** Pure rule check: refuse work the machine should not take, and say exactly why. */
export function decidePlacement(caps: MachineCapabilities, req: PlacementRequest): PlacementDecision {
  const reasons: string[] = []
  if (req.needsGpu) {
    if (caps.gpus.length === 0) reasons.push('no GPU on this machine')
    else {
      const best = caps.gpus.reduce((a, b) => (b.vramTotalMb - b.vramUsedMb > a.vramTotalMb - a.vramUsedMb ? b : a))
      const free = best.vramTotalMb - best.vramUsedMb
      if (req.minFreeVramMb !== undefined && free < req.minFreeVramMb) reasons.push(`GPU has ${free} MB free, needs ${req.minFreeVramMb} MB`)
      if (best.utilizationPct >= GPU_BUSY_UTILIZATION_PCT) reasons.push(`GPU busy at ${best.utilizationPct}%`)
    }
  }
  if (!req.allowOnBattery && !caps.power.onAc) reasons.push('on battery')
  if (!req.allowLidClosed && !req.interactive && caps.lid === 'closed' && caps.power.batteryPct !== null) reasons.push('lid closed on a laptop')
  const perCore = caps.cpu.cores > 0 ? caps.cpu.load1 / caps.cpu.cores : 0
  const maxLoad = req.maxLoadPerCore ?? 1.5
  if (perCore > maxLoad) reasons.push(`CPU load ${caps.cpu.load1.toFixed(1)} over ${caps.cpu.cores} cores`)
  if (caps.thermal.maxC !== null && caps.thermal.maxC >= HOT_C) reasons.push(`thermal ${caps.thermal.maxC.toFixed(0)}C`)
  for (const t of req.toolchains ?? []) if (!caps.toolchains[t]) reasons.push(`missing ${t}`)
  return { ok: reasons.length === 0, reasons }
}

/** Compact one-line summary for logs, the device and the bar. */
export function describeCapabilities(c: MachineCapabilities): string {
  const gpu = c.gpus[0] ? `${c.gpus[0].name} ${c.gpus[0].vramTotalMb - c.gpus[0].vramUsedMb}/${c.gpus[0].vramTotalMb}MB free ${c.gpus[0].utilizationPct}%` : 'no GPU'
  const power = c.power.onAc ? 'AC' : `battery ${c.power.batteryPct ?? '?'}%`
  const heat = c.thermal.maxC === null ? '' : ` ${c.thermal.maxC.toFixed(0)}C`
  return `${c.hostname}: ${gpu}, load ${c.cpu.load1.toFixed(1)}/${c.cpu.cores}, ${power}${heat}, lid ${c.lid}`
}
