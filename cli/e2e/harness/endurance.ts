/**
 * What the soak and chaos run (e2e/endurance.e2e.ts) reads of a daemon over time: every harnessd process
 * it runs (the master, the core and each service's process) with its memory and open files, sampled on a
 * period; the slope of each, over the run; and the ledger of every turn the run sent, against what a
 * window saw.
 */
import { execFile } from 'node:child_process'
import { appendFileSync, readdirSync, readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import type { Frame, LocalClient } from './client.js'
import type { IsolatedDaemon } from './daemon.js'

const exec = promisify(execFile)

/** This daemon's harnessd processes now, by name: `master`, `core`, and each service process by its name. */
export function harnessdProcesses(d: IsolatedDaemon): Map<string, number> {
  const found = new Map<string, number>()
  if (d.pid) found.set('master', d.pid)
  const core = d.corePid()
  if (core) found.set('core', core)
  for (const match of d.log().matchAll(/\[harnessd\] service (\S+) started \(pid (\d+)\)/g)) found.set(match[1], Number(match[2]))
  return found
}

/** Every pid this daemon's master ever said it started, cores and services: none may outlive it. */
export function everyPid(d: IsolatedDaemon): number[] {
  return [...(d.pid ? [d.pid] : []), ...[...d.log().matchAll(/\[harnessd\] (?:core|service \S+) started \(pid (\d+)\)/g)].map((match) => Number(match[1]))]
}

export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

export interface Sample { at: number; name: string; pid: number; rssMiB: number; footprintMiB: number | null; fds: number | null }

/** Resident memory, footprint (macOS's own measure of what a process costs) and open files of one process. */
export async function measure(pid: number): Promise<Omit<Sample, 'at' | 'name' | 'pid'> | null> {
  if (process.platform === 'linux') {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8')
      const rss = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) / 1024
      return { rssMiB: rss, footprintMiB: null, fds: readdirSync(`/proc/${pid}/fd`).length }
    } catch { return null }
  }
  const rss = await exec('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 3000 }).then(({ stdout }) => Number(stdout.trim()) / 1024, () => 0)
  if (!rss) return null
  const footprint = await exec('footprint', ['-p', String(pid)], { timeout: 3000 }).then(({ stdout }) => {
    const match = /Footprint:\s+([\d.]+)\s+(KB|MB|GB)/.exec(stdout)
    if (!match) return null
    const value = Number(match[1])
    return match[2] === 'KB' ? value / 1024 : match[2] === 'GB' ? value * 1024 : value
  }, () => null)
  const fds = await exec('lsof', ['-n', '-P', '-a', '-p', String(pid), '-F', 'f'], { timeout: 3000, maxBuffer: 16 * 1024 * 1024 })
    .then(({ stdout }) => stdout.split('\n').filter(line => /^f\d+$/.test(line)).length, () => null)
  return { rssMiB: rss, footprintMiB: footprint, fds }
}

/** Every harnessd process of a daemon, every `everyMs`, into `samples` and a CSV file. */
export function startSampler(d: IsolatedDaemon, everyMs: number, csv: string, samples: Sample[]): () => Promise<void> {
  appendFileSync(csv, 'at,name,pid,rssMiB,footprintMiB,fds\n')
  let stopped = false
  let failure: unknown
  let running: Promise<void> = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined
  const round = async (): Promise<void> => {
    const at = Date.now()
    for (const [name, pid] of harnessdProcesses(d)) {
      if (stopped) break
      if (!alive(pid)) continue
      const measured = await measure(pid)
      if (!measured) continue
      const sample = { at, name, pid, ...measured }
      samples.push(sample)
      appendFileSync(csv, `${at},${name},${pid},${measured.rssMiB.toFixed(1)},${measured.footprintMiB?.toFixed(1) ?? ''},${measured.fds ?? ''}\n`)
    }
  }
  const tick = (): void => {
    running = round().catch(error => { failure = error; stopped = true }).finally(() => { if (!stopped) timer = setTimeout(tick, everyMs) })
  }
  tick()
  return async () => { stopped = true; clearTimeout(timer); await running; if (failure) throw failure }
}

export interface Slope { name: string; samples: number; first: number; last: number; perHour: number | null; windows: number; fdsFirst: number | null; fdsLast: number | null; fdsPerHour: number | null; restarts: number }

/** Least squares over (minutes, value). */
function fit(points: Array<[number, number]>): number {
  const n = points.length
  if (n < 2) return 0
  const mx = points.reduce((sum, [x]) => sum + x, 0) / n
  const my = points.reduce((sum, [, y]) => sum + y, 0) / n
  const sxx = points.reduce((sum, [x]) => sum + (x - mx) ** 2, 0)
  if (!sxx) return 0
  return points.reduce((sum, [x, y]) => sum + (x - mx) * (y - my), 0) / sxx
}

/**
 * Each process's growth per hour, past the warm-up: the line through the lowest sample of each window of
 * `windowMs`, so a collection that has not run yet is not read as growth (the lowest is what the process
 * holds), and only the last pid of each name (a process restarted starts over).
 */
export function slopes(samples: Sample[], warmupMs: number, windowMs: number): Slope[] {
  if (!samples.length) return []
  const start = samples[0].at
  const names = [...new Set(samples.map((sample) => sample.name))]
  return names.map((name) => {
    const all = samples.filter((sample) => sample.name === name)
    const pids = [...new Set(all.map((sample) => sample.pid))]
    const lastPid = pids[pids.length - 1]
    const mine = all.filter((sample) => sample.pid === lastPid && sample.at - start >= warmupMs)
    const windows = new Map<number, Sample[]>()
    for (const sample of mine) {
      const key = Math.floor((sample.at - start) / windowMs)
      windows.set(key, [...(windows.get(key) ?? []), sample])
    }
    const lows = [...windows.values()].map((group) => group.reduce((low, sample) => (sample.rssMiB < low.rssMiB ? sample : low)))
    const fdLows = [...windows.values()].map((group) => group.filter((sample) => sample.fds !== null).reduce<Sample | null>((low, sample) => (!low || sample.fds! < low.fds! ? sample : low), null))
      .filter((sample): sample is Sample => !!sample)
    const minutes = (sample: Sample): number => (sample.at - start) / 60_000
    return {
      name,
      samples: mine.length,
      first: mine[0]?.rssMiB ?? 0,
      last: mine[mine.length - 1]?.rssMiB ?? 0,
      perHour: lows.length >= 3 ? fit(lows.map((sample) => [minutes(sample), sample.rssMiB])) * 60 : null,
      windows: lows.length,
      fdsFirst: fdLows[0]?.fds ?? null,
      fdsLast: fdLows[fdLows.length - 1]?.fds ?? null,
      fdsPerHour: fdLows.length >= 2 ? fit(fdLows.map((sample) => [minutes(sample), sample.fds!])) * 60 : null,
      restarts: pids.length - 1,
    }
  })
}

/**
 * Every turn the run sends, by agent, against what a window saw: each started once, in the order sent.
 * The window's frames are read as they come and then let go, so a run of an hour does not hold them all.
 */
export class TurnLedger {
  private readonly sent = new Map<string, string[]>()
  private readonly seen = new Map<string, string[]>()
  private read = 0

  constructor(private readonly window: LocalClient, private readonly marker: RegExp) {}

  send(agentId: string, token: string): void {
    this.sent.set(agentId, [...(this.sent.get(agentId) ?? []), token])
  }

  /** What the window has heard since the last look; its frames are then dropped. */
  drain(): void {
    const frames: Frame[] = this.window.frames
    for (; this.read < frames.length; this.read++) {
      const frame = frames[this.read]
      if (frame.type !== 'turn_started' || typeof frame.agentId !== 'string') continue
      const token = this.marker.exec(String(frame.payload?.userMessage ?? ''))?.[0]
      if (token) this.seen.set(frame.agentId, [...(this.seen.get(frame.agentId) ?? []), token])
    }
    if (frames.length > 2_000) { frames.length = 0; this.read = 0 }
  }

  /** Each agent's difference: a token sent and never seen, seen twice, or seen out of the order sent. */
  differences(): string[] {
    this.drain()
    const out: string[] = []
    for (const agentId of new Set([...this.sent.keys(), ...this.seen.keys()])) {
      const sent = this.sent.get(agentId) ?? []
      const seen = this.seen.get(agentId) ?? []
      const unexpected = seen.filter(token => !sent.includes(token))
      if (unexpected.length) out.push(`${agentId.slice(0, 8)}: never sent ${unexpected.slice(0, 5).join(' ')}`)
      const twice = seen.filter((token, at) => seen.indexOf(token) !== at)
      if (twice.length) out.push(`${agentId.slice(0, 8)}: seen twice ${twice.slice(0, 5).join(' ')}`)
      const missing = sent.filter((token) => !seen.includes(token))
      if (missing.length) out.push(`${agentId.slice(0, 8)}: never seen ${missing.slice(0, 5).join(' ')} (${missing.length} of ${sent.length})`)
      const order = seen.filter((token) => sent.includes(token))
      const expected = sent.filter((token) => order.includes(token))
      if (order.join(' ') !== [...new Set(expected)].join(' ') && !twice.length) out.push(`${agentId.slice(0, 8)}: out of order`)
    }
    return out
  }

  totals(): { sent: number; seen: number } {
    return { sent: [...this.sent.values()].reduce((sum, list) => sum + list.length, 0), seen: [...this.seen.values()].reduce((sum, list) => sum + list.length, 0) }
  }
}

/** Frames and terminal frames a long-lived client no longer needs, let go. */
export function forget(client: LocalClient): void {
  if (client.frames.length > 2_000) client.frames.length = 0
  if (client.binaries.length > 2_000) client.binaries.length = 0
}

/** tmux clients attached on the daemon's private server: one per open terminal stream. */
export async function tmuxClients(d: IsolatedDaemon): Promise<number> {
  const listed = await d.tmux.run('list-clients')
  return listed.trim() ? listed.trim().split('\n').length : 0
}

/** Processes still running whose command line names this daemon's root: its engines, viewer servers, workers. */
export async function strays(d: IsolatedDaemon): Promise<string[]> {
  const { stdout } = await exec('ps', ['-A', '-o', 'pid=,command='], { timeout: 5000 })
  return stdout.split('\n').filter((line) => line.includes(d.root) && !line.includes(' ps -A')).map((line) => line.trim())
}
