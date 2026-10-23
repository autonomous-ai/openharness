import { expect, it, vi } from 'vitest'
import { admission, quotaOf, readCapabilities } from './capacity.js'
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
