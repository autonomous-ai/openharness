import { expect, it, vi } from 'vitest'
import { admission, quotaOf, quotaUnknownReason, readCapabilities, START_REQUIREMENTS, startRequirements } from './capacity.js'
const requirements = { memoryBytes: 100, diskBytes: 200, maxCpuPercent: 80, tools: ['git'], devices: ['/dev/test'], quotaRequired: false }
it('uses the destination filesystem and reports missing tools/devices without executing commands', async () => {
  const deps = { resources: vi.fn(async () => ({ cpuPercent: 25, memoryTotalBytes: 1000, memoryUsedBytes: 300 })),
    disk: vi.fn(async () => ({ freeBytes: 500, volume: 'volume', path: '/fixture/repo' })), tool: vi.fn(async () => ({ status: 'available' as const })), device: vi.fn(async () => true) }
  const capacity = await readCapabilities({ cwd: '/fixture/repo', tools: ['git'], devices: ['/dev/test'] }, deps)
  expect(deps.disk).toHaveBeenCalledWith('/fixture/repo', false)
  // Which engines this daemon launches with a model: a daemon without the field gets the switch after the start.
  expect(capacity).toMatchObject({ ok: true, launchModel: ['claude'] })
  expect(admission(capacity, { installed: true }, quotaOf({}, 'codex', false), requirements)).toMatchObject({ allowed: true, unknown: ['Subscription allowance is unknown for this account.'] })
  deps.disk.mockRejectedValueOnce(new Error('not mounted'))
  const missing = await readCapabilities({ cwd: '/fixture/repo', tools: [], devices: [] }, deps)
  expect(admission(missing, { installed: true }, quotaOf({}, 'codex', false), requirements)).toMatchObject({ allowed: false })
  expect(await readCapabilities({ cwd: '/fixture', tools: ['git; whoami'] }, deps)).toMatchObject({ error: 'INVALID_REQUEST' })
  expect(deps.tool).toHaveBeenCalledTimes(1)
})
it('names a Codex window by its length, so an account with only its weekly window reads as weekly', () => {
  const reading = (rate_limit: unknown) => ({ providers: [{ provider: 'codex', outcome: 'answered', httpStatus: 200, body: { rate_limit } }] })
  expect(quotaOf(reading({ primary_window: { used_percent: 19, reset_at: 9, limit_window_seconds: 604800 }, secondary_window: null }), 'codex', false).windows)
    .toEqual([{ usedPercent: 19, resetsAt: 9, name: 'weekly' }])
  expect(quotaOf(reading({ primary_window: { used_percent: 5, reset_at: 1, limit_window_seconds: 18000 }, secondary_window: { used_percent: 9, reset_at: 2, limit_window_seconds: 604800 } }), 'codex', false).windows)
    .toEqual([{ usedPercent: 5, resetsAt: 1, name: '5-hour' }, { usedPercent: 9, resetsAt: 2, name: 'weekly' }])
  // Two windows of one length keep the first; a length that is not a number falls back to the position.
  expect(quotaOf(reading({ primary_window: { used_percent: 5, limit_window_seconds: 604800 }, secondary_window: { used_percent: 9, limit_window_seconds: 604800 } }), 'codex', false).windows)
    .toEqual([{ usedPercent: 5, resetsAt: null, name: 'weekly' }])
  expect(quotaOf(reading({ primary_window: { used_percent: 5, limit_window_seconds: 'x' } }), 'codex', false).windows)
    .toEqual([{ usedPercent: 5, resetsAt: null, name: '5-hour' }])
})
it('keeps unknown quota distinct from unused quota and honors all limiting windows', () => {
  const input = { providers: [{ provider: 'codex', account: 'opaque', email: 'private@example.com', outcome: 'answered', httpStatus: 200,
    body: { rate_limit: { primary_window: { used_percent: 10, reset_at: 1000 }, secondary_window: { used_percent: 100, reset_at: 2000 } } } }] }
  const quota = quotaOf(input, 'codex', false)
  expect(quota).toEqual({ known: true, account: 'opaque', windows: [{ usedPercent: 10, resetsAt: 1000, name: '5-hour' }, { usedPercent: 100, resetsAt: 2000, name: 'weekly' }] })
  expect(quotaOf(input, 'codex', true)).toMatchObject({ known: false, account: null })
  const capacity = { resources: { cpuPercent: 95, memoryTotalBytes: 1000, memoryUsedBytes: 950, projectDiskFreeBytes: 10 }, tools: {}, devices: {} }
  const result = admission(capacity, { installed: true }, quota, requirements)
  expect(result.allowed).toBe(false)
  expect(result.reasons).toHaveLength(6)
  expect(admission({}, { installed: true, signedIn: false }, quotaOf({}, 'codex', false), requirements).reasons).not.toContain('The selected agent engine is not signed in on this machine.')
  expect(admission({}, {}, quotaOf({}, 'claude', false), { ...requirements, quotaRequired: true }).reasons).toContain('The requested subscription allowance could not be verified.')
})
it('distinguishes a missing tool from a failed probe and keeps the failure detail', async () => {
  const deps = { resources: vi.fn(async () => ({ cpuPercent: 10, memoryTotalBytes: 1000, memoryUsedBytes: 100 })),
    disk: vi.fn(async () => ({ freeBytes: 500, volume: 'volume', path: '/fixture/repo' })),
    tool: vi.fn(async () => ({ status: 'missing' as const })), device: vi.fn(async () => true) }
  const missing = await readCapabilities({ cwd: '/fixture/repo', tools: ['git'] }, deps)
  expect(admission(missing, { installed: true }, quotaOf({}, 'codex', false), { ...requirements, devices: [] }).reasons)
    .toContain('Required tool missing: git.')

  deps.tool.mockRejectedValueOnce(new Error('interactive shell timed out'))
  const unverified = await readCapabilities({ cwd: '/fixture/repo', tools: ['git'] }, deps)
  expect(unverified.tools).toEqual({})
  expect(unverified.toolProbeErrors).toEqual({ git: 'interactive shell timed out' })
  expect(admission(unverified, { installed: true }, quotaOf({}, 'codex', false), { ...requirements, devices: [] }).reasons)
    .toEqual(expect.arrayContaining([expect.stringMatching(/Required tool not verified: git.*interactive shell timed out/)]))
})
it('says how much memory is free and how much a start needs, in GiB', () => {
  const GiB = 1024 ** 3
  const capacity = { resources: { cpuPercent: 10, memoryTotalBytes: 32 * GiB, memoryUsedBytes: 32 * GiB - 1.85 * GiB, projectDiskFreeBytes: 500 }, tools: { git: true }, devices: {} }
  expect(admission(capacity, { installed: true }, quotaOf({}, 'codex', false), { ...requirements, memoryBytes: 2 * GiB, devices: [] }).reasons)
    .toEqual(['Not enough free memory: 1.8 GiB free, 2 GiB needed.'])
})

// Ken's MacBook Pro showed no Claude allowance while Claude agents ran there (2026-10-28). Every way the reading can fail
// now says why, in words that name no account, token or plan.
it('says why an allowance is unknown, for each way its reading fails', () => {
  const reply = (claude: Record<string, unknown>) => ({ providers: [{ provider: 'claude', account: 'k', ...claude }] })
  expect(quotaUnknownReason({}, 'claude', false)).toBe('The allowance reader on this machine did not answer.')
  expect(quotaUnknownReason({ error: 'USAGE_READ_FAILED' }, 'claude', false)).toBe('The allowance reader on this machine did not answer.')
  expect(quotaUnknownReason(reply({ outcome: 'signedOut' }), 'claude', false)).toBe('No subscription sign-in is stored on this machine.')
  expect(quotaUnknownReason(reply({ outcome: 'signedOut', message: 'Claude session expired — run claude to sign in again' }), 'claude', false))
    .toBe('The stored sign-in has expired; it renews the next time the engine runs here.')
  expect(quotaUnknownReason(reply({ outcome: 'unreachable' }), 'claude', false)).toBe('Anthropic could not be reached.')
  expect(quotaUnknownReason(reply({ outcome: 'answered', httpStatus: 429, body: { error: {} } }), 'claude', false))
    .toBe('Anthropic is limiting how often the allowance can be read.')
  expect(quotaUnknownReason(reply({ outcome: 'answered', httpStatus: 401 }), 'claude', false)).toBe('Anthropic refused the stored sign-in.')
  expect(quotaUnknownReason(reply({ outcome: 'answered', httpStatus: 403 }), 'claude', false)).toBe('Anthropic refused the stored sign-in.')
  expect(quotaUnknownReason(reply({ outcome: 'answered', httpStatus: 503 }), 'claude', false)).toBe('Anthropic answered with an error (HTTP 503).')
  expect(quotaUnknownReason(reply({ outcome: 'answered', httpStatus: 200, body: { five_hour: null } }), 'claude', false))
    .toBe('Anthropic answered without usage windows.')
  expect(quotaUnknownReason({ providers: [{ provider: 'codex', outcome: 'unreachable' }] }, 'codex', false)).toBe('OpenAI could not be reached.')
  // A Harness Team account spends its owner's subscription through the owner's relay; its own home holds no sign-in.
  expect(quotaUnknownReason({ providers: [{ provider: 'codex', outcome: 'signedOut' }] }, 'codex', true))
    .toBe("This account runs on its owner's subscription; its allowance is read on the owner's machine.")
  // A readable allowance has no reason.
  expect(quotaUnknownReason(reply({ outcome: 'answered', httpStatus: 200, body: { five_hour: { utilization: 5 } } }), 'claude', false)).toBeNull()
})
it('admits a Product Manager, Buddy or template start on a busy CPU, as a routed Builder start, while memory, disk and pressure still refuse (Diego, 10-30)', () => {
  const GiB = 1024 ** 3
  // What the backend sends for a PM and a Buddy (leadStart.ts LEAD_REQUIREMENTS, buddies.ts BUDDY_REQUIREMENTS).
  const pmOrBuddy = { memoryBytes: 2 * GiB, diskBytes: GiB, maxCpuPercent: 100, tools: ['git'], devices: [], quotaRequired: false }
  const busy = { resources: { cpuPercent: 91.4, memoryTotalBytes: 32 * GiB, memoryUsedBytes: 16 * GiB, projectDiskFreeBytes: 100 * GiB }, tools: { git: true }, devices: {} }
  for (const wanted of [pmOrBuddy, START_REQUIREMENTS, startRequirements({ tools: [], devices: [] })]) {
    expect(admission(busy, { installed: true }, quotaOf({}, 'claude', false), wanted)).toMatchObject({ allowed: true, reasons: [] })
    // An unknown CPU reading does not refuse either; memory, disk and critical pressure still do.
    expect(admission({ ...busy, resources: { ...busy.resources, cpuPercent: null } }, { installed: true }, quotaOf({}, 'claude', false), wanted).allowed).toBe(true)
    expect(admission({ ...busy, resources: { ...busy.resources, memoryUsedBytes: 31 * GiB } }, { installed: true }, quotaOf({}, 'claude', false), wanted).reasons)
      .toEqual([expect.stringMatching(/memory/i)])
    expect(admission({ ...busy, resources: { ...busy.resources, projectDiskFreeBytes: 1 } }, { installed: true }, quotaOf({}, 'claude', false), wanted).reasons)
      .toEqual([expect.stringMatching(/Project disk space/)])
    expect(admission({ ...busy, resources: { ...busy.resources, memoryPressure: 'critical' } }, { installed: true }, quotaOf({}, 'claude', false), wanted).reasons)
      .toEqual(['The machine reports critical memory pressure.'])
  }
})
