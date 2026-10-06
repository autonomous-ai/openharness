import { randomUUID } from 'node:crypto'

export interface DeviceUsage {
  scope: 'local-transcripts'
  machineId: string
  machineName: string
  day: string
  windowStartMs: number
  windowEndMs: number
  generatedAtMs: number
  asOfMs?: number
  currency: 'USD'
  costKind: 'estimated'
  coverage: 'complete' | 'partial' | 'unavailable'
  costUsd?: number
  stale: boolean
  providers: Array<{
    id: 'claude' | 'codex' | 'opencode'
    enabled: boolean
    state: 'disabled' | 'scanning' | 'ok' | 'partial' | 'unavailable' | 'failed'
    priced: boolean
    asOfMs?: number
  }>
}
export type MetricsResult = { ok: true; usage: DeviceUsage } | { ok: false; error: string }
const unavailable = (): MetricsResult => ({ ok: false, error: 'Local usage is unavailable.' })
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const timestamp = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0

/** Decode into a fresh bounded object. Never forward unknown fields, paths,
 * provider diagnostics, or a missing cost converted to zero. */
export function readDeviceUsage(raw: unknown, machineId: string, now = Date.now()): DeviceUsage | undefined {
  if (!object(raw) || raw.scope !== 'local-transcripts' || raw.machineId !== machineId ||
      Buffer.byteLength(machineId) > 47 || !machineId ||
      typeof raw.machineName !== 'string' || Buffer.byteLength(raw.machineName) > 39 ||
      typeof raw.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.day) ||
      raw.currency !== 'USD' || raw.costKind !== 'estimated' ||
      !['complete', 'partial', 'unavailable'].includes(raw.coverage as string) || typeof raw.stale !== 'boolean' ||
      !timestamp(raw.windowStartMs) || !timestamp(raw.windowEndMs) || !timestamp(raw.generatedAtMs) ||
      raw.windowStartMs > raw.generatedAtMs || raw.generatedAtMs >= raw.windowEndMs ||
      raw.windowEndMs - raw.windowStartMs < 23 * 3600000 || raw.windowEndMs - raw.windowStartMs > 25 * 3600000 ||
      raw.generatedAtMs > now + 2000 || raw.generatedAtMs < now - 20000 ||
      !Array.isArray(raw.providers) || raw.providers.length !== 3) return undefined
  const providers: DeviceUsage['providers'] = []
  const seen = new Set<string>()
  for (const p of raw.providers) {
    if (!object(p) || typeof p.id !== 'string' || !['claude', 'codex', 'opencode'].includes(p.id) || seen.has(p.id) ||
        typeof p.enabled !== 'boolean' || typeof p.priced !== 'boolean' ||
        !['disabled', 'scanning', 'ok', 'partial', 'unavailable', 'failed'].includes(p.state as string) ||
        (!p.enabled && (p.state !== 'disabled' || p.priced || p.asOfMs !== undefined)) ||
        (p.enabled && p.state === 'disabled') ||
        (p.asOfMs !== undefined && (!timestamp(p.asOfMs) || p.asOfMs > raw.generatedAtMs)) ||
        (p.priced && (!p.enabled || !timestamp(p.asOfMs) || p.asOfMs < raw.windowStartMs || !['ok', 'partial', 'scanning'].includes(p.state as string)))) return undefined
    seen.add(p.id)
    providers.push({ id: p.id as DeviceUsage['providers'][number]['id'], enabled: p.enabled,
      state: p.state as DeviceUsage['providers'][number]['state'], priced: p.priced,
      ...(p.asOfMs !== undefined ? { asOfMs: p.asOfMs as number } : {}) })
  }
  const hasCost = raw.costUsd !== undefined
  if (hasCost && (typeof raw.costUsd !== 'number' || !Number.isFinite(raw.costUsd) || raw.costUsd < 0 || raw.costUsd > 1e9 ||
      !timestamp(raw.asOfMs) || raw.asOfMs < raw.windowStartMs || raw.asOfMs > raw.generatedAtMs)) return undefined
  if ((!hasCost && raw.asOfMs !== undefined) || (raw.coverage === 'unavailable') === hasCost ||
      raw.stale !== (!hasCost || raw.generatedAtMs - (raw.asOfMs as number) > 300000)) return undefined
  const enabled = providers.filter(p => p.enabled)
  if (hasCost && (!enabled.length || !enabled.some(p => p.asOfMs === raw.asOfMs && ['ok', 'partial', 'scanning'].includes(p.state)))) return undefined
  if (raw.coverage === 'complete' && !enabled.every(p => p.state === 'ok' && p.priced)) return undefined
  return {
    scope: 'local-transcripts', machineId, machineName: raw.machineName, day: raw.day,
    windowStartMs: raw.windowStartMs, windowEndMs: raw.windowEndMs, generatedAtMs: raw.generatedAtMs,
    currency: 'USD', costKind: 'estimated', coverage: raw.coverage as DeviceUsage['coverage'], stale: raw.stale,
    ...(hasCost ? { costUsd: raw.costUsd as number, asOfMs: raw.asOfMs as number } : {}), providers,
  }
}

interface Window { connId: string; machineId: string }
interface Pending extends Window { requestId: string; expiresAt: number; resolve: (r: MetricsResult) => void; timer: ReturnType<typeof setTimeout> }

/** Read only from a capability-announcing LOCAL UI socket. Remote focus never
 * selects a data source. A request stays pinned to one window until it ends. */
export class WindowMetrics {
  private windows = new Map<string, Window>()
  private pending?: Pending
  constructor(private readonly wiring: {
    send: (connId: string, payload: Record<string, unknown>) => boolean
    timeoutMs?: number
  }) {}

  ready(connId: string, machineId: string, payload: Record<string, unknown>): void {
    if (payload.schema === 1 && machineId && Buffer.byteLength(machineId) <= 47) {
      this.windows.set(connId, { connId, machineId })
    }
  }

  read(): Promise<MetricsResult> {
    if (this.pending) return Promise.resolve({ ok: false, error: 'Usage is being refreshed.' })
    const window = [...this.windows.values()].at(-1)
    if (!window) return Promise.resolve({ ok: false, error: 'Open an updated Harness app on this computer.' })
    const requestId = randomUUID(), timeout = this.wiring.timeoutMs ?? 15000, expiresAt = Date.now() + timeout
    return new Promise(resolve => {
      const timer = setTimeout(() => this.finish({ ok: false, error: 'Usage refresh timed out.' }), timeout)
      this.pending = { ...window, requestId, expiresAt, resolve, timer }
      try {
        if (!this.wiring.send(window.connId, { requestId, schema: 1, machineId: window.machineId, expiresAt })) this.finish(unavailable())
      } catch { this.finish(unavailable()) }
    })
  }

  reply(connId: string, machineId: string, payload: Record<string, unknown>): void {
    const p = this.pending
    if (!p || p.connId !== connId || p.machineId !== machineId || payload.machineId !== machineId ||
        payload.requestId !== p.requestId || payload.schema !== 1) return
    const usage = payload.ok === true && Date.now() < p.expiresAt ? readDeviceUsage(payload.usage, machineId) : undefined
    this.finish(usage ? { ok: true, usage } : unavailable())
  }

  disconnected(connId: string): void {
    this.windows.delete(connId)
    if (this.pending?.connId === connId) this.finish(unavailable())
  }

  private finish(result: MetricsResult): void {
    const p = this.pending
    this.pending = undefined
    if (!p) return
    clearTimeout(p.timer)
    p.resolve(result)
  }
}
