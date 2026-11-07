import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { startUsage, startUsageInCore, USAGE_REQUESTS, type UsageDeps } from './usage.js'
import { emptyPorts } from '../core/api.js'
import { linkClaudeProfile, profileId } from '../lib/claudeProfiles.js'
import { linkCodexProfile } from '../lib/codexProfiles.js'
import { usageTarget } from '../lib/agentUsageWire.js'
import { accountKey, claudeReportPath } from '../lib/quotaReports.js'
import type { CodexRateLimits } from '../lib/codexRateLimits.js'
import { quotaOf, quotaUnknownReason } from '../superTabs/capacity.js'

const ASKER = { local: false, owner: true }
const NOW = Date.parse('2026-11-07T01:00:00Z')
const s = (iso: string) => Date.parse(iso) / 1000
const CODEX: CodexRateLimits = {
  ok: true, accountId: 'acct-codex',
  primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: s('2026-11-07T03:00:00Z') },
  secondary: { usedPercent: 7, windowDurationMins: 10_080, resetsAt: s('2026-11-12T00:00:00Z') },
}
const NO_REPORT = 'Claude Code has not reported its allowance on this machine yet: it does after its first reply in a session Harness started.'

let dataDir: string
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'usage-service-')) })
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

/** What the status line (hook/statusline.mjs) writes for [configDir]. */
function report(windows: Record<string, unknown>, configDir?: string, at = NOW - 60_000) {
  mkdirSync(join(dataDir, 'quota'), { recursive: true })
  writeFileSync(claudeReportPath(dataDir, configDir), JSON.stringify({ v: 1, at, ...windows }))
}

function usage(over: Partial<UsageDeps> = {}) {
  const deps: UsageDeps = { codex: vi.fn(async () => CODEX), now: () => NOW, env: {}, ...over }
  return { deps, requests: startUsage(fakeCore({ dataDir }), deps) }
}

describe('the usage service', () => {
  it('composes an explicit inline reader on the same bounded wire', async () => {
    const ports = emptyPorts()
    expect(Object.keys(startUsageInCore(fakeCore(), ports))).toEqual(['usage_read'])
    expect(await ports.usage!.read(usageTarget({ agentId: 'a', sessionId: '', engine: 'claude', transcriptPath: null, registeredAt: 1 })))
      .toEqual({ error: 'INVALID_USAGE_TARGET' })
    ports.usage!.stop()
  })
  it('answers exactly the request it declares', () => {
    expect(Object.keys(startUsage(fakeCore())).sort()).toEqual([...USAGE_REQUESTS].sort())
  })

  it('usage_read: Claude from its status-line report and Codex from its app-server, in the shape Desktop and the router read', async () => {
    report({ five_hour: { used_percentage: 23.5, resets_at: s('2026-11-07T04:00:00Z') }, seven_day: { used_percentage: 41, resets_at: null } })
    const { requests, deps } = usage()
    const reply = await requests.usage_read!({}, ASKER) as Record<string, unknown>
    expect(reply).toEqual({ providers: [
      { provider: 'claude', account: null, outcome: 'answered', httpStatus: 200, source: 'cli',
        body: { five_hour: { utilization: 23.5, resets_at: '2026-11-07T04:00:00.000Z' }, seven_day: { utilization: 41, resets_at: null } } },
      { provider: 'codex', account: accountKey('codex', 'acct-codex'), outcome: 'answered', httpStatus: 200, source: 'cli',
        body: { rate_limit: {
          primary_window: { used_percent: 42, limit_window_seconds: 18_000, reset_at: s('2026-11-07T03:00:00Z') },
          secondary_window: { used_percent: 7, limit_window_seconds: 604_800, reset_at: s('2026-11-12T00:00:00Z') },
        } } },
    ] })
    // The default accounts: the owner's own CODEX_HOME, nothing injected.
    expect(deps.codex).toHaveBeenCalledWith({ codexHome: undefined })
    // The router reads both, by the windows' own lengths.
    expect(quotaOf(reply, 'claude', false)).toMatchObject({ known: true, windows: [
      { name: '5-hour', usedPercent: 23.5, resetsAt: '2026-11-07T04:00:00.000Z' }, { name: 'weekly', usedPercent: 41, resetsAt: null }] })
    expect(quotaOf(reply, 'codex', false)).toMatchObject({ known: true, account: accountKey('codex', 'acct-codex'), windows: [
      { name: '5-hour', usedPercent: 42 }, { name: 'weekly', usedPercent: 7 }] })
  })

  it('usage_read: the default Claude account is the daemon\'s own CLAUDE_CONFIG_DIR, and a window Codex leaves out is left out', async () => {
    report({ seven_day: { used_percentage: 12, resets_at: null } }, '/fixture/claude-own')
    const { requests } = usage({ env: { CLAUDE_CONFIG_DIR: '/fixture/claude-own' },
      codex: async () => ({ ok: true, accountId: null, primary: null, secondary: { usedPercent: 3, windowDurationMins: null, resetsAt: null } }) })
    expect(await requests.usage_read!({}, ASKER)).toEqual({ providers: [
      expect.objectContaining({ provider: 'claude', body: { seven_day: { utilization: 12, resets_at: null } } }),
      expect.objectContaining({ provider: 'codex', account: null,
        body: { rate_limit: { secondary_window: { used_percent: 3, limit_window_seconds: null, reset_at: null } } } }),
    ] })
  })

  it('usage_read: an old report still answers, and a window whose reset has passed reads as unused', async () => {
    report({ five_hour: { used_percentage: 98, resets_at: s('2026-11-06T20:00:00Z') }, seven_day: { used_percentage: 60, resets_at: s('2026-11-10T00:00:00Z') } },
      undefined, NOW - 9 * 3_600_000)
    const reply = await usage().requests.usage_read!({}, ASKER) as { providers: Array<Record<string, unknown>> }
    expect(reply.providers[0]).toMatchObject({ outcome: 'answered',
      body: { five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: 60, resets_at: '2026-11-10T00:00:00.000Z' } } })
  })

  it('usage_read: no report yet is unreachable, with the reason the route shows', async () => {
    const reply = await usage().requests.usage_read!({}, ASKER) as Record<string, unknown>
    expect((reply.providers as unknown[])[0]).toEqual({ provider: 'claude', account: null, outcome: 'unreachable', source: 'cli', message: NO_REPORT })
    expect(quotaUnknownReason(reply, 'claude')).toBe(NO_REPORT)
  })

  it('usage_read: Codex signed out, not installed, or not answering, each said', async () => {
    const answer = async (codex: CodexRateLimits) => ((await usage({ codex: async () => codex }).requests.usage_read!({}, ASKER)) as { providers: unknown[] }).providers[1]
    expect(await answer({ ok: false, reason: 'signedOut' })).toEqual({ provider: 'codex', account: null, outcome: 'signedOut', source: 'cli' })
    expect(await answer({ ok: false, reason: 'missing' }))
      .toEqual({ provider: 'codex', account: null, outcome: 'unreachable', source: 'cli', message: 'Codex is not installed where this machine\'s daemon can start it.' })
    expect(await answer({ ok: false, reason: 'failed' }))
      .toEqual({ provider: 'codex', account: null, outcome: 'unreachable', source: 'cli', message: 'Codex did not answer when asked for its allowance on this machine.' })
  })

  it('usage_read: Codex is asked at most once per home every 3 minutes', async () => {
    let now = NOW
    const codex = vi.fn(async () => CODEX)
    const { requests } = usage({ codex, now: () => now })
    await requests.usage_read!({}, ASKER)
    now += 3 * 60_000 - 1
    await requests.usage_read!({}, ASKER)
    expect(codex).toHaveBeenCalledOnce()
    now += 1
    await requests.usage_read!({}, ASKER)
    expect(codex).toHaveBeenCalledTimes(2)
  })

  it('usage_read: a reading that fails is said, never thrown', async () => {
    const { requests } = usage({ codex: async () => { throw new Error('spawn failed') } })
    expect(await requests.usage_read!({}, ASKER)).toEqual({ error: 'USAGE_READ_FAILED' })
  })

  it('usage_read with an unknown profile id answers PROFILE_UNKNOWN', async () => {
    const { requests, deps } = usage()
    for (const profile of [{ engine: 'claude', id: 'nope' }, { engine: 'codex', id: 'nope' }, { engine: 'gemini', id: 'default' }, { engine: 'claude', id: 7 }]) {
      expect(await requests.usage_read!({ profile }, ASKER)).toEqual({ error: 'PROFILE_UNKNOWN' })
    }
    expect(deps.codex).not.toHaveBeenCalled()
  })

  it('usage_read for a profile is the owner\'s alone', async () => {
    const { requests, deps } = usage()
    expect(await requests.usage_read!({ profile: { engine: 'codex', id: 'default' } }, { local: false, owner: false }))
      .toEqual({ error: 'OWNER_REQUIRED' })
    expect(deps.codex).not.toHaveBeenCalled()
  })

  it('usage_read for a default profile reads that provider only, by either of its ids', async () => {
    const core = fakeCore({ dataDir })
    const codex = vi.fn(async () => CODEX)
    const requests = startUsage(core, { codex, now: () => NOW, env: {} })
    const providers = async (engine: 'claude' | 'codex', id: string) =>
      ((await requests.usage_read!({ profile: { engine, id } }, ASKER)) as { providers: Array<{ provider: string }> }).providers.map(p => p.provider)
    expect(await providers('claude', 'default')).toEqual(['claude'])
    expect(await providers('codex', 'default')).toEqual(['codex'])
    expect(await providers('claude', profileId(core.daemon.machineId(), 'claude', 'default'))).toEqual(['claude'])
    expect(await providers('codex', profileId(core.daemon.machineId(), 'codex', 'default'))).toEqual(['codex'])
    expect(codex.mock.calls).toEqual([[{ codexHome: undefined }]])
  })

  it('usage_read finds a Claude and a Codex profile by id, and reads each under its own folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-profile-'))
    try {
      const claude = join(dir, 'claude')
      const codexHome = join(dir, 'codex')
      mkdirSync(claude)
      mkdirSync(codexHome)
      const real = realpathSync(dir)
      expect(linkClaudeProfile(claude, 'machine-1')).toHaveProperty('profile')
      linkCodexProfile(codexHome)
      report({ five_hour: { used_percentage: 64, resets_at: null } }, claude)
      const codex = vi.fn(async () => CODEX)
      const { requests } = usage({ codex })
      expect(await requests.usage_read!({ profile: { engine: 'claude', id: profileId('machine-1', 'claude', join(real, 'claude')) } }, ASKER))
        .toEqual({ providers: [expect.objectContaining({ provider: 'claude', outcome: 'answered', body: { five_hour: { utilization: 64, resets_at: null } } })] })
      expect(await requests.usage_read!({ profile: { engine: 'codex', id: profileId('machine-1', 'codex', join(real, 'codex')) } }, ASKER))
        .toEqual({ providers: [expect.objectContaining({ provider: 'codex', outcome: 'answered' })] })
      expect(codex.mock.calls).toEqual([[{ codexHome: join(real, 'codex') }]])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
