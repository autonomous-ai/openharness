import { afterEach, expect, it, vi } from 'vitest'
import { WindowMetrics, readDeviceUsage, type DeviceUsage } from './windowMetrics.js'

export function usageFixture(machineId = 'local', now = Date.now()): DeviceUsage {
  const date = new Date(now)
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime()
  return { scope: 'local-transcripts', machineId, machineName: 'This Mac',
    day: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
    windowStartMs: start, windowEndMs: end, generatedAtMs: now, asOfMs: now,
    currency: 'USD', costKind: 'estimated', coverage: 'complete', costUsd: 0, stale: false,
    providers: [
      { id: 'claude', enabled: true, state: 'ok', priced: true, asOfMs: now },
      { id: 'codex', enabled: false, state: 'disabled', priced: false },
      { id: 'opencode', enabled: false, state: 'disabled', priced: false },
    ] }
}
function fixture() {
  const sent: Array<{ conn: string; payload: Record<string, unknown> }> = []
  const metrics = new WindowMetrics({ send: (conn, payload) => { sent.push({ conn, payload }); return true }, timeoutMs: 100 })
  const answer = (extra = {}, conn = 'desk', machine = 'local') => metrics.reply(conn, machine, {
    ...sent.at(-1)?.payload, ok: true, usage: usageFixture(), ...extra,
  })
  metrics.ready('desk', 'local', { schema: 1 })
  return { metrics, sent, answer }
}
afterEach(() => vi.useRealTimers())

it('requires a capable local window and never changes a pending request recipient', async () => {
  const f = fixture()
  const p = f.metrics.read()
  f.metrics.ready('other', 'local', { schema: 1 })
  f.answer({}, 'other'); f.answer({}, 'desk', 'remote')
  f.answer({ requestId: 'old' }); f.answer({ machineId: 'remote' }); f.answer({ schema: 2 })
  expect(await f.metrics.read()).toMatchObject({ ok: false })
  expect(f.sent).toHaveLength(1)
  f.answer()
  expect(await p).toMatchObject({ ok: true, usage: { machineId: 'local', costUsd: 0 } })
  const next = f.metrics.read()
  expect(f.sent.at(-1)?.conn).toBe('other')
  f.metrics.disconnected('other')
  expect(await next).toMatchObject({ ok: false })
})

it('times out, ignores late replies, and clears only the disconnected window', async () => {
  vi.useFakeTimers()
  const f = fixture(), p = f.metrics.read()
  f.metrics.disconnected('unrelated')
  await vi.advanceTimersByTimeAsync(101)
  expect(await p).toMatchObject({ ok: false })
  f.answer()
  const pending = f.metrics.read()
  const expired = { ...f.sent.at(-1)!.payload }
  f.metrics.disconnected('desk')
  expect(await pending).toMatchObject({ ok: false })
  f.metrics.reply('desk', 'local', { ...expired, ok: true, usage: usageFixture() })
  expect(await f.metrics.read()).toMatchObject({ ok: false })
  expect(f.sent).toHaveLength(2)
})

it('keeps disabled and unpriced data absent; bounds and strips the wire projection', () => {
  const known = usageFixture()
  expect(readDeviceUsage({ ...known, paths: ['secret'] }, 'local')).toEqual(known)
  expect(Buffer.byteLength(JSON.stringify(known))).toBeLessThan(1800)
  const missing = { ...known, coverage: 'unavailable', stale: true, costUsd: undefined, asOfMs: undefined,
    providers: known.providers.map(p => ({ ...p, enabled: false, state: 'disabled', priced: false, asOfMs: undefined })) }
  expect(readDeviceUsage(missing, 'local')).not.toHaveProperty('costUsd')
  expect(readDeviceUsage(missing, 'local')?.coverage).toBe('unavailable')
  expect(readDeviceUsage({ ...known, providers: [...known.providers, known.providers[0]] }, 'local')).toBeUndefined()
  expect(readDeviceUsage({ ...known, machineName: '猫'.repeat(14) }, 'local')).toBeUndefined()
  expect(readDeviceUsage(known, 'remote')).toBeUndefined()
})

it.each([
  { costUsd: -1 }, { costUsd: Infinity }, { costUsd: NaN }, { costUsd: 1e10 },
  { asOfMs: undefined }, { coverage: 'unavailable' }, { stale: true },
  { generatedAtMs: 1 }, { windowEndMs: 1 }, { currency: 'EUR' },
])('rejects impossible or misleading measurements: %j', extra => {
  expect(readDeviceUsage({ ...usageFixture(), ...extra }, 'local')).toBeUndefined()
})

it('allows a partial estimate with unpriced sources and preserves oldest freshness', () => {
  const now = new Date(2026, 9, 6, 12).getTime(), u = usageFixture('local', now)
  u.coverage = 'partial'; u.asOfMs = now - 600000; u.stale = true
  u.providers[0].asOfMs = u.asOfMs
  u.providers[1] = { id: 'codex', enabled: true, state: 'partial', priced: false, asOfMs: now }
  expect(readDeviceUsage(u, 'local', now)).toEqual(u)
  expect(readDeviceUsage({ ...u, coverage: 'complete' }, 'local', now)).toBeUndefined()
})

it('handles send refusal and invalid app answers without reflecting private diagnostics', async () => {
  const metrics = new WindowMetrics({ send: () => false })
  metrics.ready('desk', 'local', { schema: 2 })
  expect(await metrics.read()).toMatchObject({ ok: false })
  metrics.ready('desk', 'local', { schema: 1 })
  expect(await metrics.read()).toMatchObject({ ok: false })
  const f = fixture(), p = f.metrics.read()
  f.answer({ ok: false, error: '/Users/private/transcript.jsonl' })
  expect(await p).toEqual({ ok: false, error: 'Local usage is unavailable.' })
})
