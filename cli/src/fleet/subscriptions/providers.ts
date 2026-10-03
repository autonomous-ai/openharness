// Originally written by Fred Nix (@nixfred) in github.com/nixfred/openharness (MIT).

/**
 * One reader per subscription provider. Each answers the same question, "what does this plan's own
 * meter say right now", from the one source that provider really publishes, and says plainly when the
 * provider is not on this machine at all.
 *
 * Sources, ported from Burn Bar (https://github.com/nixfred/burnbar) and the collectors it reads, but
 * reimplemented here so neither Burn Bar nor Omarchy has to be installed (Linux or macOS):
 *
 *   Claude  GET https://api.anthropic.com/api/oauth/usage with the Claude Code login's own OAuth token,
 *           read from ~/.claude/.credentials.json (or $CLAUDE_CONFIG_DIR), or on macOS from the login
 *           keychain item "Claude Code-credentials" via `security find-generic-password -w`.
 *   Codex   no network: the newest `rate_limits` snapshot Codex itself writes into its session rollouts
 *           under ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (or $CODEX_HOME).
 *   Grok    no network: the newest "billing: fetched credits config" line in ~/.grok/logs/unified.jsonl
 *           (or $GROK_HOME). A snapshot: Grok writes it when Grok starts, not on every use.
 *   Kimi    GET {KIMI_BASE_URL or https://api.kimi.com/coding/v1}/usages with KIMI_API_KEY from the
 *           environment or a KIMI_API_KEY= line in ~/.env.
 *
 * Every credential read is local and read-only. A token only ever goes into the Authorization header of
 * its own provider's HTTPS request: it is never returned, logged, or put on a command line.
 */
import { normPercent, parseIsoMs, type LimitRow } from './pace.js'

export type ProviderId = 'claude' | 'codex' | 'grok' | 'kimi'
export const PROVIDERS: ReadonlyArray<{ id: ProviderId; name: string }> = [
  { id: 'claude', name: 'Claude' },
  { id: 'codex', name: 'Codex' },
  { id: 'grok', name: 'Grok' },
  { id: 'kimi', name: 'Kimi' },
]

export type ReadingState = 'ok' | 'not-detected' | 'not-configured' | 'error'

export interface ProviderReading {
  id: ProviderId
  name: string
  state: ReadingState
  plan: string
  limits: LimitRow[]
  /** A snapshot cannot be re-measured on demand (Grok): it needs a bigger margin before it is advice. */
  snapshot: boolean
  measuredAt: number
  /** One short line for the card: why a figure is missing, or its age. Never contains a secret. */
  status: string
  /** The remedy, when there is one. */
  help: string
}

export interface ProviderDeps {
  home: string
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  now(): number
  /** Whole file as text, or null when missing or unreadable. */
  readFile(path: string): Promise<string | null>
  /** The last `bytes` of a file as text, or null. */
  readTail(path: string, bytes: number): Promise<string | null>
  /** Entry names, or [] when missing. */
  listDir(path: string): Promise<string[]>
  exists(path: string): Promise<boolean>
  fetchJson(url: string, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number; body: unknown }>
  /** stdout, or null on any failure. Used only for the macOS keychain read. */
  execFile(cmd: string, args: string[], timeoutMs: number): Promise<string | null>
}

const nameOf = (id: ProviderId): string => PROVIDERS.find((p) => p.id === id)!.name
const reading = (id: ProviderId, state: ReadingState, extra: Partial<ProviderReading> = {}): ProviderReading =>
  ({ id, name: nameOf(id), state, plan: '', limits: [], snapshot: false, measuredAt: 0, status: '', help: '', ...extra })
const join = (...parts: string[]): string => parts.join('/').replace(/\/+/g, '/')
const isoOrEmpty = (v: unknown): string => { const ms = resetMs(v); return ms ? new Date(ms).toISOString() : '' }

/** A reset as epoch seconds, epoch ms, or ISO text. */
function resetMs(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0
  if (typeof v === 'number' || /^\d+$/.test(String(v).trim())) {
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0) return 0
    return n < 1e12 ? n * 1000 : n
  }
  return parseIsoMs(v)
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
}

// ── Claude ───────────────────────────────────────────────────────────────────────────────────────

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

function claudePlan(tier: string, sub: string): string {
  const m = /max_(\d+x)/i.exec(tier)
  if (m) return `Max ${m[1]}`
  return sub ? sub[0]!.toUpperCase() + sub.slice(1) : ''
}

export async function readClaude(deps: ProviderDeps): Promise<ProviderReading> {
  const dir = deps.env.CLAUDE_CONFIG_DIR || join(deps.home, '.claude')
  let raw = await deps.readFile(join(dir, '.credentials.json'))
  if (!raw && deps.platform === 'darwin') raw = await deps.execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], 5000)
  let login: Record<string, unknown> | null = null
  try { login = asObj(asObj(JSON.parse(raw ?? 'null'))?.claudeAiOauth) } catch { login = null }
  const token = typeof login?.accessToken === 'string' ? login.accessToken : ''
  if (!token) {
    if (!(await deps.exists(dir))) return reading('claude', 'not-detected')
    return reading('claude', 'not-configured', { status: 'No Claude Code login found', help: 'Run `claude` and sign in with a Claude subscription' })
  }
  const plan = claudePlan(String(login?.rateLimitTier ?? ''), String(login?.subscriptionType ?? ''))
  let res: { status: number; body: unknown }
  try {
    res = await deps.fetchJson(CLAUDE_USAGE_URL, { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' }, 10_000)
  } catch { res = { status: 0, body: null } }
  if (res.status !== 200) {
    const why = res.status === 0 || res.status >= 599 ? 'could not reach Anthropic' : `usage endpoint returned ${res.status}`
    return reading('claude', 'error', { plan, status: `Claude ${why}`, help: res.status === 401 ? 'Run `claude` and sign in again' : '' })
  }
  const body = asObj(res.body) ?? {}
  const weekly = asObj(body.seven_day_oauth_apps) ?? asObj(body.seven_day)
  const session = asObj(body.five_hour)
  // One payload speaks one convention: any value >= 1 means the whole payload is percent-scaled.
  const rawVals = [session?.utilization, weekly?.utilization].map((v) => Number(v))
  const percentScale = rawVals.some((v) => v >= 1)
  const norm = (v: unknown): number => {
    const n = Number(v)
    if (!(n >= 0)) return -1
    return Math.min(1, percentScale || n > 1 ? n / 100 : n)
  }
  const limits: LimitRow[] = []
  if (session && norm(session.utilization) >= 0) limits.push({ label: 'Session (5-hour)', percent: norm(session.utilization), resetsAt: isoOrEmpty(session.resets_at) })
  if (weekly && norm(weekly.utilization) >= 0) limits.push({ label: 'Weekly (7-day)', percent: norm(weekly.utilization), resetsAt: isoOrEmpty(weekly.resets_at) })
  if (!limits.length) return reading('claude', 'error', { plan, status: 'Anthropic returned no limits' })
  return reading('claude', 'ok', { plan, limits, measuredAt: deps.now() })
}

// ── Codex ────────────────────────────────────────────────────────────────────────────────────────

const CODEX_TAIL_BYTES = 512 * 1024
const CODEX_FILES_TO_TRY = 6

function codexLabel(mins: number): string {
  if (mins === 10080) return 'Weekly (7-day)'
  if (mins === 300) return 'Session (5-hour)'
  if (mins && mins % 1440 === 0) return `${mins / 1440}-day window`
  if (mins && mins % 60 === 0) return `${mins / 60}-hour window`
  return mins ? `${mins}m window` : 'Limit'
}

/** The newest rollout files, newest first, walking YYYY/MM/DD in descending order. */
async function newestRollouts(deps: ProviderDeps, root: string, want: number): Promise<string[]> {
  const out: string[] = []
  const desc = (xs: string[]) => xs.filter((x) => /^\d+$/.test(x)).sort((a, b) => Number(b) - Number(a))
  for (const y of desc(await deps.listDir(root))) {
    for (const m of desc(await deps.listDir(join(root, y)))) {
      for (const d of desc(await deps.listDir(join(root, y, m)))) {
        const files = (await deps.listDir(join(root, y, m, d))).filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl')).sort().reverse()
        for (const f of files) { out.push(join(root, y, m, d, f)); if (out.length >= want) return out }
      }
    }
  }
  return out
}

export async function readCodex(deps: ProviderDeps): Promise<ProviderReading> {
  const home = deps.env.CODEX_HOME || join(deps.home, '.codex')
  const root = join(home, 'sessions')
  if (!(await deps.exists(root))) return reading('codex', 'not-detected')
  // Rollout names sort by start time, but a long session keeps writing into an older file, so the
  // newest few are all read and the snapshot with the latest timestamp wins.
  let best: { at: number; rl: Record<string, unknown> } | null = null
  for (const file of await newestRollouts(deps, root, CODEX_FILES_TO_TRY)) {
    const text = await deps.readTail(file, CODEX_TAIL_BYTES)
    if (!text) continue
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!
      if (!line.includes('"rate_limits"')) continue
      let obj: Record<string, unknown> | null
      try { obj = asObj(JSON.parse(line)) } catch { continue }
      const rl = asObj(asObj(obj?.payload)?.rate_limits) ?? asObj(obj?.rate_limits)
      if (!rl || !asObj(rl.primary)) continue
      const at = parseIsoMs(obj?.timestamp)
      if (!best || at > best.at) best = { at, rl }
      break
    }
  }
  if (!best) return reading('codex', 'not-configured', { status: 'No Codex rate-limit snapshot yet', help: 'Run one Codex turn signed in with a ChatGPT plan' })
  const limits: LimitRow[] = []
  for (const key of ['primary', 'secondary']) {
    const w = asObj(best.rl[key])
    if (!w || w.used_percent === undefined || w.used_percent === null) continue
    let resets = resetMs(w.resets_at)
    // Older Codex builds wrote a relative reset; anchor it to the line's own timestamp.
    if (!resets && Number(w.resets_in_seconds) > 0 && best.at) resets = best.at + Number(w.resets_in_seconds) * 1000
    limits.push({ label: codexLabel(Number(w.window_minutes) || 0), percent: normPercent(Number(w.used_percent) / 100), resetsAt: resets ? new Date(resets).toISOString() : '' })
  }
  // Weekly first, so the card judges the plan by its week.
  limits.sort((a, b) => (/^weekly/i.test(b.label) ? 1 : 0) - (/^weekly/i.test(a.label) ? 1 : 0))
  const plan = typeof best.rl.plan_type === 'string' ? best.rl.plan_type : ''
  const open = limits.some((l) => parseIsoMs(l.resetsAt) > deps.now())
  return reading('codex', 'ok', {
    plan, limits, measuredAt: best.at,
    status: open ? '' : 'Codex window has reset since the last turn; run Codex to refresh',
  })
}

// ── Grok ─────────────────────────────────────────────────────────────────────────────────────────

const GROK_TAIL_BYTES = 8 * 1024 * 1024
const GROK_MARK = 'billing: fetched credits config'

export async function readGrok(deps: ProviderDeps): Promise<ProviderReading> {
  const home = deps.env.GROK_HOME || join(deps.home, '.grok')
  if (!(await deps.exists(home))) return reading('grok', 'not-detected')
  const text = await deps.readTail(join(home, 'logs', 'unified.jsonl'), GROK_TAIL_BYTES)
  let latest: { config: Record<string, unknown>; tier: string; at: number } | null = null
  for (const line of (text ?? '').split('\n')) {
    if (!line.includes(GROK_MARK)) continue
    let e: Record<string, unknown> | null
    try { e = asObj(JSON.parse(line)) } catch { continue }
    if (!e || e.msg !== GROK_MARK) continue
    const ctx = asObj(e.ctx)
    const config = asObj(ctx?.config)
    if (!config) continue
    latest = { config, tier: typeof ctx?.subscriptionTier === 'string' ? ctx.subscriptionTier : '', at: parseIsoMs(e.ts) }
  }
  if (!latest) return reading('grok', 'not-configured', { snapshot: true, status: 'No Grok billing snapshot yet', help: 'Start Grok once while signed in' })
  const period = asObj(latest.config.currentPeriod) ?? {}
  const end = isoOrEmpty(period.end ?? latest.config.billingPeriodEnd)
  const start = isoOrEmpty(period.start ?? latest.config.billingPeriodStart)
  const raw = latest.config.creditUsagePercent
  // Grok logs 0..100. A config without the figure is unknown, not a confident 0%.
  const percent = raw === undefined || raw === null || typeof raw === 'boolean' ? -1 : normPercent(Number(raw) / 100)
  const row: LimitRow = { label: 'Weekly (7-day)', percent, resetsAt: end }
  if (start) row.startsAt = start
  const open = !end || parseIsoMs(end) > deps.now()
  return reading('grok', 'ok', {
    plan: latest.tier, limits: [row], snapshot: true, measuredAt: latest.at,
    status: open ? '' : 'Grok window has reset since the last snapshot; start Grok to refresh',
  })
}

// ── Kimi ─────────────────────────────────────────────────────────────────────────────────────────

export const KIMI_DEFAULT_BASE = 'https://api.kimi.com/coding/v1'

/** KEY from the environment, else a KEY= line in ~/.env. Only the named keys are ever looked at. */
async function envOrDotenv(deps: ProviderDeps, key: string): Promise<string> {
  const v = (deps.env[key] ?? '').trim()
  if (v) return v
  const text = await deps.readFile(join(deps.home, '.env'))
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.trim().replace(/^export\s+/, '')
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '')
  }
  return ''
}

function kimiWindowLabel(w: Record<string, unknown> | null): string {
  let n = Number(w?.duration) || 0
  let unit = String(w?.timeUnit ?? '').replace('TIME_UNIT_', '').toLowerCase()
  if (n <= 0 || !unit) return ''
  if (unit === 'minute' && n % 60 === 0) { n /= 60; unit = 'hour' }
  return `${n}-${unit}`
}

/** Burn Bar's rows from Kimi's /usages: the request window binds the session; the month is the budget. */
export function kimiLimitsFromUsages(raw: unknown): LimitRow[] {
  const body = asObj(raw) ?? {}
  const out: LimitRow[] = []
  const seen = new Set<string>()
  for (const entry of Array.isArray(body.limits) ? body.limits : []) {
    const e = asObj(entry)
    const label = kimiWindowLabel(asObj(e?.window))
    const detail = asObj(e?.detail) ?? {}
    const limit = Number(detail.limit) || 0
    const used = Number(detail.used) || 0
    if (!label || limit <= 0) continue
    seen.add(label)
    out.push({ label: `Session (${label})`, percent: Math.max(0, Math.min(1, used / limit)), resetsAt: isoOrEmpty(detail.resetTime) })
  }
  const names: Array<[string, string, string]> = [['limit_5h', 'Session (5-hour)', '5-hour'], ['limit_month_total', 'Monthly (total)', ''], ['limit_month_code', 'Monthly (code)', '']]
  const usages = asObj(body.usages) ?? {}
  for (const [key, label, span] of names) {
    const e = asObj(usages[key])
    if (!e || (span && seen.has(span))) continue
    const ratio = Number(e.used_ratio)
    if (!Number.isFinite(ratio)) continue
    out.push({ label, percent: Math.max(0, Math.min(1, ratio)), resetsAt: isoOrEmpty(e.reset_time) })
  }
  return out
}

export async function readKimi(deps: ProviderDeps): Promise<ProviderReading> {
  const key = await envOrDotenv(deps, 'KIMI_API_KEY')
  if (!key) return reading('kimi', 'not-detected')
  const base = ((await envOrDotenv(deps, 'KIMI_BASE_URL')) || KIMI_DEFAULT_BASE).replace(/\/+$/, '')
  // The key never travels in clear text, except to this machine itself.
  if (!/^https:\/\//.test(base) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(`${base}/`)) {
    return reading('kimi', 'error', { status: 'KIMI_BASE_URL must be https', help: 'Fix KIMI_BASE_URL' })
  }
  let res: { status: number; body: unknown }
  try { res = await deps.fetchJson(`${base}/usages`, { Authorization: `Bearer ${key}`, Accept: 'application/json' }, 8000) } catch { res = { status: 0, body: null } }
  if (res.status !== 200) {
    const why = res.status === 0 || res.status >= 599 ? 'could not reach Kimi' : `usages endpoint returned ${res.status}`
    return reading('kimi', 'error', { status: `Kimi ${why}`, help: res.status === 401 ? 'Check KIMI_API_KEY' : '' })
  }
  const limits = kimiLimitsFromUsages(res.body)
  if (!limits.length) return reading('kimi', 'error', { status: 'Kimi returned no limits' })
  return reading('kimi', 'ok', { limits, measuredAt: deps.now() })
}

export const READERS: Record<ProviderId, (deps: ProviderDeps) => Promise<ProviderReading>> = {
  claude: readClaude, codex: readCodex, grok: readGrok, kimi: readKimi,
}
