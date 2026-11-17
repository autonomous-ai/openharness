import { expect, it } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import { captureSessionBinding } from './sessionBinding.js'

const session = (): RegisteredSession => ({ agentId: 'agent', sessionId: 'session', engine: 'claude', active: true,
  registeredAt: 1, boundAt: 2, transcriptPath: '/fixture/session.jsonl', tmuxPane: '%1', primaryRuntimeKey: 'tmux\0%1',
  runtimes: [{ backend: 'tmux', paneId: '%1' }], processIdentity: { pid: 7, executable: '/fixture/claude', startMarker: 'born' },
} as RegisteredSession)

// The old API's scalar equality is a compatibility oracle, independent of the new comparison mechanism.
const previous = (s: RegisteredSession | undefined): string => s ? JSON.stringify([
  s.agentId, s.sessionId, s.engine, s.active, s.registeredAt, s.boundAt, s.transcriptPath, s.tmuxPane,
  s.primaryRuntimeKey, s.runtimes, s.processIdentity, s.identityHold, s.evidenceRevision,
]) : ''

it('keeps a missing binding distinct from an available session', () => {
  expect(captureSessionBinding(undefined)(undefined)).toBe(true)
  expect(captureSessionBinding(undefined)(session())).toBe(false)
  expect(captureSessionBinding(session())(undefined)).toBe(false)
})

it.each([
  ['agentId', 'another'], ['sessionId', 'rotated'], ['engine', 'codex'], ['active', false], ['registeredAt', 9],
  ['boundAt', 9], ['transcriptPath', '/fixture/another.jsonl'], ['tmuxPane', '%2'], ['primaryRuntimeKey', 'tmux\0%2'],
  ['identityHold', 'changed'], ['evidenceRevision', 1],
] as const)('retains the captured %s even when the original row is mutated', (key, value) => {
  const row = session(), before = previous(row), same = captureSessionBinding(row)
  Object.assign(row, { [key]: value })
  expect(same(row)).toBe(false)
  expect(same(row)).toBe(previous(row) === before)
})

it.each(['runtime', 'process'] as const)('retains nested %s evidence across mutation of an aliased object', kind => {
  const row = session(), copied = { ...row }, before = previous(row), same = captureSessionBinding(row)
  if (kind === 'runtime') copied.runtimes[0].paneId = '%2'
  else copied.processIdentity!.startMarker = 'reused pid'
  expect(same(row)).toBe(false)
  expect(same(copied)).toBe(previous(copied) === before)
})

it('accepts a newly allocated equal binding and ignores nonbinding display changes', () => {
  const row = session(), same = captureSessionBinding(row)
  expect(same({ ...structuredClone(row), title: 'renamed', touchedAt: 99 })).toBe(true)
})

it('preserves JSON member order and additional nested facts', () => {
  const row = session(), same = captureSessionBinding(row)
  const reordered = { ...row, processIdentity: { executable: '/fixture/claude', pid: 7, startMarker: 'born' } }
  expect(same(reordered)).toBe(previous(row) === previous(reordered))
  const extended = { ...row, processIdentity: { ...row.processIdentity!, startTicks: 1 } }
  expect(same(extended)).toBe(false)
})

it.each([undefined, null, NaN, Infinity, -Infinity])('preserves JSON null equivalence for scalar %s', value => {
  const row = { ...session(), boundAt: value } as RegisteredSession
  const same = captureSessionBinding(row)
  for (const next of [undefined, null, NaN, Infinity, -Infinity, 0, -0, 2]) {
    const current = { ...row, boundAt: next } as RegisteredSession
    expect(same(current)).toBe(previous(row) === previous(current))
  }
})

it('preserves absent/null nested equivalence and signed zero equality', () => {
  const row = { ...session(), runtimes: undefined, processIdentity: undefined, registeredAt: -0 } as unknown as RegisteredSession
  const current = { ...row, runtimes: null, processIdentity: null, registeredAt: 0 } as unknown as RegisteredSession
  expect(captureSessionBinding(row)(current)).toBe(previous(row) === previous(current))
})
