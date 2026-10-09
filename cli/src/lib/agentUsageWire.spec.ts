import { expect, it } from 'vitest'
import { usageSnapshot, usageTarget, usageTargetKey, validUsage, validUsageTarget } from './agentUsageWire.js'

const target = usageTarget({ agentId: 'a', sessionId: 's', engine: 'claude', transcriptPath: '/fixture/a', registeredAt: 1 })
const at = '2026-10-01T00:00:00Z'
it('accepts only bounded full read identities', () => {
  expect(validUsageTarget(target)).toBe(true)
  expect(validUsageTarget({ ...target, engine: 'opencode', transcriptPath: null })).toBe(true)
  expect(validUsageTarget({ ...target, forkedFrom: { agentId: 'parent', name: 'Parent' }, codexHome: '/profile', cwd: '/cwd' })).toBe(true)
  for (const value of [null, [], {}, ...Object.entries({ agentId: '', sessionId: '', engine: 'hermes', transcriptPath: 'relative', cwd: 'relative',
    codexHome: 'relative', registeredAt: -1, forkedFrom: { agentId: 4 } }).map(([key, value]) => ({ ...target, [key]: value })),
    { ...target, transcriptPath: null }, { ...target, agentId: 'x'.repeat(4097) }, { ...target, cwd: '/bad\0path' }]) expect(validUsageTarget(value), JSON.stringify(value)).toBe(false)
  for (const changed of [{ agentId: 'b' }, { sessionId: 'new' }, { engine: 'codex' }, { transcriptPath: '/other' }, { cwd: '/other' },
    { codexHome: '/profile' }, { registeredAt: 2 }, { forkedFrom: { agentId: 'parent', name: 'Parent' } }]) {
    expect(usageTargetKey({ ...target, ...changed } as typeof target)).not.toBe(usageTargetKey(target))
  }
})

it('copies aggregates only and rejects malformed or oversized values', () => {
  const value = { totalTokens: 42, updatedAt: at, inputTokens: 20, outputTokens: 22, cachedTokens: 10,
    output: { linesAdded: 3, linesRemoved: null, pullRequestsCreated: 1 },
    work: { current: [{ cwd: '/fixture', at }], locations: [{ cwd: '/fixture', at }],
      pullRequests: [{ url: 'https://github.com/example/project/pull/4', cwd: null, at }], uncertain: true, truncated: false } }
  expect(validUsage(null)).toBe(true)
  expect(usageSnapshot(null)).toBeNull()
  expect(validUsage(value)).toBe(true)
  expect(usageSnapshot(value)).toEqual(value)
  expect(usageSnapshot(value)?.work?.current).not.toBe(value.work.current)
  expect(usageSnapshot({ totalTokens: null, updatedAt: at })).toEqual({ totalTokens: null, updatedAt: at })
  expect(usageSnapshot({ ...value, ledger: 'private' } as typeof value)).not.toHaveProperty('ledger')
  for (const bad of [[], {}, { ...value, totalTokens: -1 }, { ...value, inputTokens: Infinity }, { ...value, updatedAt: 'invalid' },
    { ...value, output: { ...value.output, linesAdded: -1 } }, { ...value, output: null }, { ...value, work: null },
    { ...value, work: { ...value.work, current: new Array(129).fill(value.work.current[0]) } },
    { ...value, work: { ...value.work, locations: [{ cwd: 'relative', at }] } },
    { ...value, work: { ...value.work, uncertain: 1 } }, { ...value, work: { ...value.work, truncated: 1 } },
    { ...value, work: { ...value.work, locations: Array.from({ length: 128 }, () => ({ cwd: '/' + 'x'.repeat(4095), at })) } },
    { ...value, work: { ...value.work, pullRequests: [{ url: 'https://github.com/' + 'x'.repeat(4096) + '/project/pull/1', cwd: null, at }] } },
    { ...value, work: { ...value.work, pullRequests: [{ url: 'file:///secret', cwd: null, at }] } },
    { ...value, work: { ...value.work, pullRequests: [{ url: value.work.pullRequests[0].url, cwd: 'relative', at }] } }]) expect(validUsage(bad)).toBe(false)
})
