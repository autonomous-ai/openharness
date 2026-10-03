// Originally written by Fred Nix (@nixfred) in github.com/nixfred/openharness (MIT).

/**
 * Subscriptions: every AI plan on this machine on one screen. Weekly percent used, percent banked
 * against an even pace, the reset, a come-back timer when over pace, and which plan to use next.
 *
 * The math and the provider sources are ported from Burn Bar (https://github.com/nixfred/burnbar, by
 * nixfred, MIT). Burn Bar does not have to be installed: nothing here calls it or reads its files.
 *
 * Served by the daemon as `GET /api/subscriptions`, `POST /api/fleet {action: "subs"}`, a compact
 * block on the attention payload, and `harness subs [--json]`.
 * State lives in the daemon's data dir: `subscriptions.json` (which plans are switched on) and
 * `subscription-samples.jsonl` (the percentages over time, which is what a burn rate is made of).
 */
import { guidePick, paceFor, paceLive, parseIsoMs, spanWords, windowId, type Guide, type LimitRow, type Pace, type Sample } from './pace.js'
import { PROVIDERS, READERS, type ProviderDeps, type ProviderId, type ProviderReading } from './providers.js'

export * from './pace.js'
export * from './providers.js'

const SAMPLE_MAX_AGE_MS = 40 * 86_400_000
const SAMPLE_MIN_GAP_MS = 5 * 60_000
/** Network providers are asked at most this often; Anthropic rate-limits eager pollers. */
const NETWORK_TTL_MS = 4 * 60_000
const LOCAL_TTL_MS = 30_000
/** A snapshot has to be this far ahead before it is advice (Burn Bar's snapshot margin). */
const SNAPSHOT_MIN_BANK = 0.1

export type CardState = ProviderReading['state'] | 'disabled'
/** banked = green; on-pace = neutral; amber = over pace; red = well over or spent. */
export type Tone = 'banked' | 'on-pace' | 'amber' | 'red' | 'unknown'

export interface PrimaryWindow {
  label: string
  used: number
  resetsAt: string
  resetsInMs: number
  windowMs: number
  elapsed: number
  /** elapsed - used: positive = banked, negative = ahead of the clock (over pace). */
  bankedSigned: number
  banked: number
  bankedMs: number
  behind: number
  over: boolean
  spent: boolean
  comeBackAt: number
  comeBackMs: number
  room: number
  ratio: number
  tone: Tone
  sentence: string
  pace: Pace
}

export interface SubscriptionCard {
  id: ProviderId
  name: string
  state: CardState
  enabled: boolean
  plan: string
  snapshot: boolean
  measuredAt: number
  status: string
  help: string
  primary: PrimaryWindow | null
  windows: LimitRow[]
  /** A short window (5-hour session) is nearly full: this plan would stop you right now. */
  blocked: boolean
  isPick: boolean
}

export interface SubscriptionsPayload {
  at: number
  subs: SubscriptionCard[]
  guide: Guide & { verdict: string }
  settings: SubscriptionSettings
}

export interface SubscriptionSettings { enabled: Record<ProviderId, boolean> }

export interface SubscriptionsDeps {
  dataDir: string
  now(): number
  readers: Record<ProviderId, (deps: ProviderDeps) => Promise<ProviderReading>>
  providerDeps?: ProviderDeps
  readFile(path: string): Promise<string | null>
  writeFile(path: string, data: string): Promise<void>
}

const SETTINGS_FILE = 'subscriptions.json'
const SAMPLES_FILE = 'subscription-samples.jsonl'
const pct = (n: number): string => `${Math.round(n * 100)}%`

/** The window a plan is judged by: weekly, else the monthly pool, else the first non-session window. */
export function primaryLimit(rows: LimitRow[]): LimitRow | null {
  const session = (l: string) => /session|5-hour/i.test(l)
  return rows.find((r) => /^weekly/i.test(r.label)) ?? rows.find((r) => /monthly \(total\)/i.test(r.label)) ?? rows.find((r) => !session(r.label)) ?? null
}

function toneOf(live: ReturnType<typeof paceLive>): Tone {
  if (!live) return 'unknown'
  if (live.spent) return 'red'
  if (live.over) return live.elapsed > 0 && live.used / live.elapsed > 1.25 ? 'red' : 'amber'
  if (live.banked >= 0.005) return 'banked'
  return 'on-pace'
}

function sentenceOf(live: NonNullable<ReturnType<typeof paceLive>>): string {
  const reset = `Resets in ${spanWords(live.leftMs)}.`
  if (live.spent) return `Spent. Back at the reset in ${spanWords(live.leftMs)}.`
  if (live.over) return `${pct(live.behind)} over pace. Stop now and you are back on pace in ${spanWords(live.comeBackMs)}. ${reset}`
  if (live.banked >= 0.005) return `${pct(live.banked)} banked, about ${spanWords(live.bankedMs)} of even pace in hand. ${reset}`
  return `On pace. ${reset}`
}

export class SubscriptionsService {
  private settings: SubscriptionSettings | null = null
  private samples: Map<string, Sample[]> | null = null
  private cache = new Map<ProviderId, { at: number; reading: ProviderReading }>()
  private previousPick = ''
  private last: SubscriptionsPayload | null = null

  constructor(private readonly deps: SubscriptionsDeps) {}

  private path(name: string): string { return `${this.deps.dataDir.replace(/\/+$/, '')}/${name}` }

  async getSettings(): Promise<SubscriptionSettings> {
    if (this.settings) return this.settings
    const enabled = Object.fromEntries(PROVIDERS.map((p) => [p.id, true])) as Record<ProviderId, boolean>
    try {
      const raw = JSON.parse((await this.deps.readFile(this.path(SETTINGS_FILE))) ?? '{}') as { enabled?: Record<string, unknown> }
      for (const p of PROVIDERS) if (typeof raw.enabled?.[p.id] === 'boolean') enabled[p.id] = raw.enabled[p.id] as boolean
    } catch { /* a bad file keeps the defaults */ }
    this.settings = { enabled }
    return this.settings
  }

  async setEnabled(id: ProviderId, on: boolean): Promise<SubscriptionSettings> {
    if (!PROVIDERS.some((p) => p.id === id)) throw new Error(`unknown subscription: ${String(id)}`)
    const s = await this.getSettings()
    s.enabled[id] = on
    await this.deps.writeFile(this.path(SETTINGS_FILE), JSON.stringify(s, null, 2))
    return s
  }

  private async loadSamples(): Promise<Map<string, Sample[]>> {
    if (this.samples) return this.samples
    const out = new Map<string, Sample[]>()
    const floor = this.deps.now() - SAMPLE_MAX_AGE_MS
    for (const line of ((await this.deps.readFile(this.path(SAMPLES_FILE))) ?? '').split('\n')) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line) as { ts: number; key: string; pct: number; resets: number }
        if (!(r.ts >= floor) || !(r.pct >= 0 && r.pct <= 1) || typeof r.key !== 'string') continue
        const list = out.get(r.key) ?? []
        list.push([Number(r.ts), Number(r.pct), Number(r.resets) || 0])
        out.set(r.key, list)
      } catch { /* a malformed line is skipped, never fatal */ }
    }
    for (const v of out.values()) v.sort((a, b) => a[0] - b[0])
    this.samples = out
    return out
  }

  private async saveSamples(): Promise<void> {
    if (!this.samples) return
    const floor = this.deps.now() - SAMPLE_MAX_AGE_MS
    const lines: string[] = []
    for (const [key, pts] of this.samples) for (const [ts, p, resets] of pts) if (ts >= floor) lines.push(JSON.stringify({ ts, key, pct: Math.round(p * 1e6) / 1e6, resets }))
    await this.deps.writeFile(this.path(SAMPLES_FILE), lines.length ? `${lines.join('\n')}\n` : '')
  }

  private async read(id: ProviderId, force: boolean): Promise<ProviderReading> {
    const now = this.deps.now()
    const hit = this.cache.get(id)
    const ttl = id === 'claude' || id === 'kimi' ? NETWORK_TTL_MS : LOCAL_TTL_MS
    if (hit && !force && now - hit.at < ttl) return hit.reading
    let fresh: ProviderReading
    try { fresh = await this.deps.readers[id](this.deps.providerDeps as ProviderDeps) } catch (e) {
      fresh = { id, name: PROVIDERS.find((p) => p.id === id)!.name, state: 'error', plan: '', limits: [], snapshot: false, measuredAt: 0, status: 'reader failed', help: '' }
      void e
    }
    // A failed probe keeps the last good figure rather than blanking it, and says so.
    if (fresh.state === 'error' && hit?.reading.state === 'ok') fresh = { ...hit.reading, status: `last known; ${fresh.status}` }
    this.cache.set(id, { at: now, reading: fresh })
    return fresh
  }

  /** Read every enabled provider and build the payload. `force` skips the per-provider TTL. */
  async collect(force = false): Promise<SubscriptionsPayload> {
    const now = this.deps.now()
    const settings = await this.getSettings()
    const samples = await this.loadSamples()
    let dirty = false
    const cards: SubscriptionCard[] = []
    for (const p of PROVIDERS) {
      const enabled = settings.enabled[p.id]
      if (!enabled) {
        cards.push({ id: p.id, name: p.name, state: 'disabled', enabled, plan: '', snapshot: false, measuredAt: 0, status: 'Switched off in settings', help: '', primary: null, windows: [], blocked: false, isPick: false })
        continue
      }
      const r = await this.read(p.id, force)
      let primary: PrimaryWindow | null = null
      let blocked = false
      for (const row of r.limits) {
        const key = `${p.id}|${row.label.slice(0, 64)}`
        const resets = windowId(parseIsoMs(row.resetsAt))
        const pts = samples.get(key) ?? []
        const paceBlock = paceFor(row, pts, !r.snapshot, now)
        if (row.percent >= 0 && resets) {
          const lastPt = pts[pts.length - 1]
          if (!lastPt || lastPt[2] !== resets || Math.abs(lastPt[1] - row.percent) > 1e-9 || now - lastPt[0] >= SAMPLE_MIN_GAP_MS) {
            pts.push([now, row.percent, resets])
            samples.set(key, pts)
            dirty = true
          }
        }
        if (/session|5-hour/i.test(row.label) && row.percent >= 0 && parseIsoMs(row.resetsAt) > now) {
          const rate = paceBlock.ratePerHour
          if (row.percent >= 0.9 || (rate > 0 && (1 - row.percent) / rate < 0.5)) blocked = true
        }
        if (row === primaryLimit(r.limits)) {
          const live = paceLive(row.percent, paceBlock.resetsMs, paceBlock.windowMs, now)
          if (live) {
            primary = {
              label: row.label, used: live.used, resetsAt: row.resetsAt, resetsInMs: live.leftMs, windowMs: live.windowMs,
              elapsed: live.elapsed, bankedSigned: live.bankedSigned, banked: live.banked, bankedMs: live.bankedMs, behind: live.behind,
              over: live.over, spent: live.spent, comeBackAt: live.comeBackAt, comeBackMs: live.comeBackMs, room: live.room,
              ratio: paceBlock.ratio, tone: toneOf(live), sentence: sentenceOf(live), pace: paceBlock,
            }
          }
        }
      }
      cards.push({ id: p.id, name: p.name, state: r.state, enabled, plan: r.plan, snapshot: r.snapshot, measuredAt: r.measuredAt, status: r.status, help: r.help, primary, windows: r.limits, blocked, isPick: false })
    }
    if (dirty) await this.saveSamples().catch(() => {})
    const present = cards.filter((c) => c.state !== 'disabled' && c.state !== 'not-detected')
    const guide = guidePick(present.map((c) => ({
      id: c.id,
      live: c.primary ? paceLive(c.primary.used, c.primary.pace.resetsMs, c.primary.windowMs, now) : null,
      fresh: !!c.primary,
      blocked: c.blocked,
      minBank: c.snapshot ? SNAPSHOT_MIN_BANK : undefined,
    })), this.previousPick)
    this.previousPick = guide.pick
    const name = (id: string) => PROVIDERS.find((p) => p.id === id)?.name ?? id
    let verdict = ''
    if (guide.pick) {
      const top = cards.find((c) => c.id === guide.pick)!
      top.isPick = true
      verdict = guide.urgent
        ? `Use ${name(guide.pick)} next: ${pct(1 - top.primary!.used)} unspent and it resets in ${spanWords(top.primary!.resetsInMs)}. Use it or lose it.`
        : `Use ${name(guide.pick)} next: the most room, ${guide.room.toFixed(1)}x an even pace.`
      if (guide.next) verdict += ` Then ${name(guide.next)}.`
    } else if (guide.count < 2) {
      verdict = guide.count === 1 ? 'One subscription here, so there is nothing to choose between.' : 'No subscriptions detected on this machine.'
    } else if (guide.rest.length) {
      const first = guide.rest[0]!
      verdict = `No plan is clearly ahead. ${name(first.id)} is back on pace first, in ${spanWords(Math.max(0, first.comeBackAt - now))}.`
    } else {
      verdict = 'Every plan is on pace; no clear pick.'
    }
    this.last = { at: now, subs: cards, guide: { ...guide, verdict }, settings }
    return this.last
  }

  /** The last payload, trimmed for the attention frame (the bar and the device). */
  compact(): { at: number; pick: string; verdict: string; subs: Array<{ id: ProviderId; name: string; used: number; bankedSigned: number; tone: Tone; resetsInMs: number; comeBackMs: number }> } | null {
    if (!this.last) return null
    return {
      at: this.last.at,
      pick: this.last.guide.pick,
      verdict: this.last.guide.verdict,
      subs: this.last.subs.filter((s) => s.primary).map((s) => ({
        id: s.id, name: s.name, used: s.primary!.used, bankedSigned: s.primary!.bankedSigned, tone: s.primary!.tone,
        resetsInMs: s.primary!.resetsInMs, comeBackMs: s.primary!.comeBackMs,
      })),
    }
  }
}

/** Plain lines for `harness subs`. */
export function describeSubscriptions(p: SubscriptionsPayload): string[] {
  const lines: string[] = []
  for (const s of p.subs) {
    const head = `${s.isPick ? '>' : ' '} ${s.name.padEnd(7)}`
    if (s.state === 'disabled') { lines.push(`${head} off (harness subs set ${s.id} on)`); continue }
    if (s.state === 'not-detected') { lines.push(`${head} not detected`); continue }
    if (!s.primary) { lines.push(`${head} ${s.state}${s.status ? `: ${s.status}` : ''}${s.help ? ` (${s.help})` : ''}`); continue }
    const w = s.primary
    const bank = w.bankedSigned >= 0 ? `${pct(w.bankedSigned)} banked` : `${pct(-w.bankedSigned)} over pace`
    lines.push(`${head} ${s.plan ? `${s.plan} ` : ''}${w.label}: ${pct(w.used)} used, ${bank}, resets in ${spanWords(w.resetsInMs)}${s.snapshot ? ' (snapshot)' : ''}`)
    lines.push(`          ${w.sentence}`)
    if (s.status) lines.push(`          ${s.status}`)
  }
  lines.push('', p.guide.verdict)
  return lines
}
