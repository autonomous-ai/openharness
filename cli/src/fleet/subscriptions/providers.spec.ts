// Originally written by Fred Nix (@nixfred) in github.com/nixfred/openharness (MIT).

import { describe, expect, it } from 'vitest'
import { readClaude, readCodex, readGrok, readKimi, type ProviderDeps } from './providers.js'

const NOW = Date.UTC(2026, 8, 30, 12)
const HOME = '/h'

function deps(files: Record<string, string>, over: Partial<ProviderDeps> = {}): ProviderDeps & { calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  return {
    calls,
    home: HOME,
    platform: 'linux',
    env: {},
    now: () => NOW,
    readFile: async (p) => (p in files ? files[p]! : null),
    readTail: async (p, bytes) => (p in files ? files[p]!.slice(-bytes) : null),
    listDir: async (p) => {
      const prefix = p.endsWith('/') ? p : `${p}/`
      const names = new Set<string>()
      for (const f of Object.keys(files)) if (f.startsWith(prefix)) names.add(f.slice(prefix.length).split('/')[0]!)
      return [...names]
    },
    exists: async (p) => Object.keys(files).some((f) => f === p || f.startsWith(`${p}/`)),
    fetchJson: async (url, headers) => { calls.push({ url, headers }); return { status: 599, body: null } },
    execFile: async () => null,
    ...over,
  }
}

describe('provider absent: not detected, never an error', () => {
  it('claude, codex, grok and kimi on an empty machine', async () => {
    const d = deps({})
    for (const r of [await readClaude(d), await readCodex(d), await readGrok(d), await readKimi(d)]) {
      expect(r.state).toBe('not-detected')
      expect(r.limits).toEqual([])
    }
    expect(d.calls).toHaveLength(0) // nothing leaves the machine when nothing is configured
  })
  it('claude installed but not logged in is not configured', async () => {
    const r = await readClaude(deps({ '/h/.claude/settings.json': '{}' }))
    expect(r.state).toBe('not-configured')
    expect(r.help).toMatch(/claude/)
  })
})

describe('claude', () => {
  const creds = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-SECRETSECRETSECRET', rateLimitTier: 'default_claude_max_20x', subscriptionType: 'max' } })
  it('reads the OAuth usage endpoint with the local token and maps percent-scale rows', async () => {
    const d = deps({ '/h/.claude/.credentials.json': creds }, {
      fetchJson: async (url, headers) => {
        d.calls.push({ url, headers })
        return { status: 200, body: { five_hour: { utilization: 7, resets_at: '2026-09-30T15:00:00Z' }, seven_day: { utilization: 32, resets_at: '2026-10-04T10:00:00Z' } } }
      },
    })
    const r = await readClaude(d)
    expect(d.calls[0]!.url).toBe('https://api.anthropic.com/api/oauth/usage')
    expect(d.calls[0]!.headers.Authorization).toMatch(/^Bearer /)
    expect(r.state).toBe('ok')
    expect(r.plan).toBe('Max 20x')
    expect(r.limits).toEqual([
      { label: 'Session (5-hour)', percent: 0.07, resetsAt: '2026-09-30T15:00:00.000Z' },
      { label: 'Weekly (7-day)', percent: 0.32, resetsAt: '2026-10-04T10:00:00.000Z' },
    ])
    expect(JSON.stringify(r)).not.toContain('SECRET')
  })
  it('an HTTP error says so and never echoes the token', async () => {
    const d = deps({ '/h/.claude/.credentials.json': creds }, { fetchJson: async () => ({ status: 429, body: null }) })
    const r = await readClaude(d)
    expect(r.state).toBe('error')
    expect(r.status).toMatch(/429/)
    expect(JSON.stringify(r)).not.toContain('SECRET')
  })
  it('on macOS the token comes from the login keychain, read only', async () => {
    const seen: string[][] = []
    const d = deps({ '/h/.claude/x': '' }, {
      platform: 'darwin',
      execFile: async (cmd, args) => { seen.push([cmd, ...args]); return creds },
      fetchJson: async () => ({ status: 200, body: { seven_day: { utilization: 0.5, resets_at: '2026-10-04T10:00:00Z' } } }),
    })
    const r = await readClaude(d)
    expect(seen[0]).toEqual(['security', 'find-generic-password', '-s', 'Claude Code-credentials', '-w'])
    expect(r.limits[0]!.percent).toBe(0.5)
  })
})

describe('codex', () => {
  const line = (ts: string, rl: unknown) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', rate_limits: rl } })
  it('takes the newest rate_limits snapshot from the newest rollout, no network', async () => {
    const f = '/h/.codex/sessions/2026/09/30/rollout-2026-09-30T10-00-00-abc.jsonl'
    const old = '/h/.codex/sessions/2026/09/29/rollout-2026-09-29T10-00-00-abc.jsonl'
    const d = deps({
      [old]: line('2026-09-29T10:00:00Z', { primary: { used_percent: 1, window_minutes: 10080, resets_at: 1791308664 } }),
      [f]: [
        line('2026-09-30T10:00:00Z', { primary: { used_percent: 12, window_minutes: 10080, resets_at: 1791308664 } }),
        line('2026-09-30T11:00:00Z', { primary: { used_percent: 16, window_minutes: 10080, resets_at: 1791308664 }, secondary: { used_percent: 40, window_minutes: 300, resets_at: 1790780000 }, plan_type: 'pro' }),
        '{"not json',
      ].join('\n'),
    })
    const r = await readCodex(d)
    expect(r.state).toBe('ok')
    expect(r.plan).toBe('pro')
    expect(r.limits[0]).toEqual({ label: 'Weekly (7-day)', percent: 0.16, resetsAt: new Date(1791308664000).toISOString() })
    expect(r.limits[1]!.label).toBe('Session (5-hour)')
    expect(r.measuredAt).toBe(Date.parse('2026-09-30T11:00:00Z'))
    expect(d.calls).toHaveLength(0)
  })
  it('sessions but no snapshot yet is detected with a remedy', async () => {
    const r = await readCodex(deps({ '/h/.codex/sessions/2026/09/30/rollout-x.jsonl': '{}' }))
    expect(r.state).toBe('not-configured')
  })
})

describe('grok', () => {
  it('reads the newest billing snapshot, with its own period start', async () => {
    const snap = (pct: number, end: string) => JSON.stringify({ ts: '2026-09-28T02:03:03.932Z', msg: 'billing: fetched credits config', ctx: { config: { creditUsagePercent: pct, currentPeriod: { start: '2026-09-24T03:10:03Z', end } }, subscriptionTier: 'SuperGrok Plus' } })
    const r = await readGrok(deps({ '/h/.grok/logs/unified.jsonl': ['{"msg":"other"}', snap(1, '2026-10-01T03:10:03Z'), snap(3, '2026-10-01T03:10:03Z')].join('\n') }))
    expect(r.state).toBe('ok')
    expect(r.snapshot).toBe(true)
    expect(r.plan).toBe('SuperGrok Plus')
    expect(r.limits).toEqual([{ label: 'Weekly (7-day)', percent: 0.03, resetsAt: '2026-10-01T03:10:03.000Z', startsAt: '2026-09-24T03:10:03.000Z' }])
  })
  it('a snapshot with no percentage is unknown, never a confident zero', async () => {
    const line = JSON.stringify({ ts: '2026-09-28T02:03:03Z', msg: 'billing: fetched credits config', ctx: { config: { currentPeriod: { end: '2026-10-01T03:10:03Z' } } } })
    const r = await readGrok(deps({ '/h/.grok/logs/unified.jsonl': line }))
    expect(r.limits[0]!.percent).toBe(-1)
  })
  it('a window that has reset since the snapshot says so', async () => {
    const line = JSON.stringify({ ts: '2026-09-20T02:03:03Z', msg: 'billing: fetched credits config', ctx: { config: { creditUsagePercent: 50, currentPeriod: { end: '2026-09-25T03:10:03Z' } } } })
    const r = await readGrok(deps({ '/h/.grok/logs/unified.jsonl': line }))
    expect(r.status).toMatch(/reset/)
  })
})

describe('kimi', () => {
  const usages = { limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', used: '9', resetTime: '2026-09-30T08:43:48Z' } }], usages: { limit_5h: { used_ratio: 0, reset_time: '2026-09-30T08:43:47Z' }, limit_month_total: { used_ratio: 0.0711, reset_time: '2026-10-19T00:00:00Z' }, limit_month_code: { used_ratio: 0, reset_time: '2026-10-19T00:00:00Z' } } }
  it('uses KIMI_API_KEY from ~/.env and maps the request window and month', async () => {
    const d = deps({ '/h/.env': '# x\nKIMI_API_KEY="kimi-secret-key-value"\nOTHER=1\n' }, {
      fetchJson: async (url, headers) => { d.calls.push({ url, headers }); return { status: 200, body: usages } },
    })
    const r = await readKimi(d)
    expect(d.calls[0]!.url).toBe('https://api.kimi.com/coding/v1/usages')
    expect(r.state).toBe('ok')
    expect(r.limits.map((l) => l.label)).toEqual(['Session (5-hour)', 'Monthly (total)', 'Monthly (code)'])
    expect(r.limits[0]!.percent).toBeCloseTo(0.09, 9)
    expect(r.limits[1]!.percent).toBeCloseTo(0.0711, 9)
    expect(JSON.stringify(r)).not.toContain('kimi-secret')
  })
  it('refuses a non-https base URL rather than sending the key in clear', async () => {
    const d = deps({}, { env: { KIMI_API_KEY: 'k', KIMI_BASE_URL: 'http://evil.example' } })
    const r = await readKimi(d)
    expect(r.state).toBe('error')
    expect(d.calls).toHaveLength(0)
  })
})
