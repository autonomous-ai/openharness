// Originally written by Fred Nix (@nixfred) in github.com/nixfred/openharness (MIT).

import { describe, expect, it } from 'vitest'
import { describeSubscriptions, SubscriptionsService, type SubscriptionsDeps } from './index.js'
import type { ProviderReading } from './providers.js'

const HOUR = 3_600_000
const DAY = 86_400_000
const NOW = Date.UTC(2026, 8, 30, 12)

function reading(id: ProviderReading['id'], over: Partial<ProviderReading> = {}): ProviderReading {
  return { id, name: id[0]!.toUpperCase() + id.slice(1), state: 'ok', plan: '', limits: [], snapshot: false, measuredAt: NOW, status: '', help: '', ...over }
}
/** A week that is `gone` of the way through with `used` spent. */
const week = (used: number, gone: number) => ({ label: 'Weekly (7-day)', percent: used, resetsAt: new Date(NOW + 7 * DAY * (1 - gone)).toISOString() })

function service(readings: Partial<Record<ProviderReading['id'], ProviderReading>>, files: Record<string, string> = {}) {
  let now = NOW
  const deps: SubscriptionsDeps = {
    dataDir: '/d',
    now: () => now,
    readers: {
      claude: async () => readings.claude ?? reading('claude', { state: 'not-detected' }),
      codex: async () => readings.codex ?? reading('codex', { state: 'not-detected' }),
      grok: async () => readings.grok ?? reading('grok', { state: 'not-detected' }),
      kimi: async () => readings.kimi ?? reading('kimi', { state: 'not-detected' }),
    },
    readFile: async (p) => files[p] ?? null,
    writeFile: async (p, d) => { files[p] = d },
  }
  return { svc: new SubscriptionsService(deps), files, tick: (ms: number) => { now += ms } }
}

describe('the subscriptions payload', () => {
  it('lists all four providers, not-detected ones included, and never the local GPU', async () => {
    const { svc } = service({})
    const p = await svc.collect()
    expect(p.subs.map((s) => s.id)).toEqual(['claude', 'codex', 'grok', 'kimi'])
    expect(p.subs.every((s) => s.state === 'not-detected' && s.primary === null)).toBe(true)
    expect(p.guide.pick).toBe('')
    expect(JSON.stringify(p)).not.toMatch(/"local"/)
  })

  it('weekly used, signed banked, reset and pace sentence on the card', async () => {
    const { svc } = service({ claude: reading('claude', { plan: 'Max 20x', limits: [{ label: 'Session (5-hour)', percent: 0.07, resetsAt: new Date(NOW + HOUR).toISOString() }, week(0.3, 0.5)] }) })
    const c = (await svc.collect()).subs[0]!
    expect(c.primary!.label).toBe('Weekly (7-day)')
    expect(c.primary!.used).toBeCloseTo(0.3, 6)
    expect(c.primary!.bankedSigned).toBeCloseTo(0.2, 3)
    expect(c.primary!.banked).toBeCloseTo(0.2, 3)
    expect(c.primary!.tone).toBe('banked')
    expect(c.primary!.sentence).toMatch(/20% banked/)
    expect(c.primary!.resetsInMs).toBeCloseTo(3.5 * DAY, -4)
    expect(c.windows).toHaveLength(2)
  })

  it('over pace: negative banked, amber or red, with a come-back timer', async () => {
    const { svc } = service({ codex: reading('codex', { limits: [week(0.6, 0.3)] }) })
    const c = (await svc.collect()).subs[1]!.primary!
    expect(c.bankedSigned).toBeCloseTo(-0.3, 3)
    expect(c.tone).toBe('red')
    expect(c.comeBackMs).toBeGreaterThan(0)
    expect(c.sentence).toMatch(/over pace/i)
    expect(c.sentence).toMatch(/back on pace in/)
  })

  it('a month is judged when there is no week (Kimi)', async () => {
    const { svc } = service({ kimi: reading('kimi', { limits: [{ label: 'Session (5-hour)', percent: 0.09, resetsAt: new Date(NOW + HOUR).toISOString() }, { label: 'Monthly (total)', percent: 0.07, resetsAt: new Date(NOW + 19 * DAY).toISOString() }] }) })
    expect((await svc.collect()).subs[3]!.primary!.label).toBe('Monthly (total)')
  })

  it('names the next sub when there is a real choice', async () => {
    const { svc } = service({ claude: reading('claude', { limits: [week(0.6, 0.3)] }), grok: reading('grok', { snapshot: true, limits: [week(0.02, 0.51)] }) })
    const p = await svc.collect()
    expect(p.guide.pick).toBe('grok')
    expect(p.guide.verdict).toMatch(/Grok/)
    expect(p.subs.find((s) => s.id === 'grok')!.isPick).toBe(true)
  })

  it('a disabled sub is left out of the verdict and never read', async () => {
    let read = 0
    const { svc } = service({ grok: reading('grok', { limits: [week(0.02, 0.51)] }) })
    const orig = (svc as unknown as { deps: SubscriptionsDeps }).deps.readers.grok
    ;(svc as unknown as { deps: SubscriptionsDeps }).deps.readers.grok = async (d) => { read++; return orig(d) }
    await svc.setEnabled('grok', false)
    const p = await svc.collect()
    expect(read).toBe(0)
    expect(p.subs.find((s) => s.id === 'grok')!.state).toBe('disabled')
    expect(p.settings.enabled.grok).toBe(false)
  })

  it('persists settings and rate samples in its own data dir', async () => {
    const { svc, files, tick } = service({ claude: reading('claude', { limits: [week(0.3, 0.5)] }) })
    await svc.setEnabled('kimi', false)
    await svc.collect()
    tick(10 * 60_000)
    await svc.collect()
    expect(JSON.parse(files['/d/subscriptions.json']!).enabled.kimi).toBe(false)
    expect(files['/d/subscription-samples.jsonl']!.trim().split('\n').length).toBe(2)
  })

  it('rejects an unknown provider id', async () => {
    const { svc } = service({})
    await expect(svc.setEnabled('local' as never, true)).rejects.toThrow(/unknown/)
  })

  it('describes itself in plain lines for `harness subs`', async () => {
    const { svc } = service({ claude: reading('claude', { plan: 'Max 20x', limits: [week(0.3, 0.5)] }) })
    const lines = describeSubscriptions(await svc.collect())
    expect(lines[0]).toMatch(/Claude/)
    expect(lines.join('\n')).toMatch(/30% used/)
    expect(lines.join('\n')).toMatch(/Codex\s+not detected/)
  })

  it('a compact summary rides on the attention payload', async () => {
    const { svc } = service({ claude: reading('claude', { limits: [week(0.3, 0.5)] }) })
    await svc.collect()
    const c = svc.compact()!
    expect(c.subs[0]).toMatchObject({ id: 'claude', tone: 'banked' })
    expect(c.subs).toHaveLength(1)
  })
})
