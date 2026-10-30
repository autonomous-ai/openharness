import { expect, it, vi } from 'vitest'
import { cleanHealthState, createProductHealth } from './productHealth.js'

it('counts only explicit interactive intent and never serializes its identifiers', () => {
  let now = Date.parse('2026-10-01T12:00:00Z')
  const add = vi.fn(), health = createProductHealth(add, () => now, cleanHealthState(null, now))
  health.start('0.3.96')
  health.work('PRIVATE_RAW_TERMINAL')
  health.intent('PRIVATE_TOOL', 'tool'); health.work('PRIVATE_TOOL')
  health.intent('PRIVATE_MIXED', 'interactive'); health.intent('PRIVATE_MIXED', 'tool'); health.work('PRIVATE_MIXED')
  health.intent('PRIVATE_USER', 'interactive'); health.work('PRIVATE_USER')
  health.intent('PRIVATE_USER', 'interactive'); health.work('PRIVATE_USER')
  expect(add.mock.calls.filter(([k]) => k === 'health_cli_interactive_work_days')).toHaveLength(1)
  expect(add).toHaveBeenCalledWith('health_cli_unclassified_turns_started', undefined)
  expect(add).toHaveBeenCalledWith('health_cli_tool_turns_started', undefined)
  expect(add.mock.calls.filter(([k]) => k === 'health_cli_unclassified_turns_started')).toHaveLength(2)
  for (const lag of [1, 7, 28]) {
    now = Date.parse('2026-10-01T12:00:00Z') + lag * 86400000
    health.intent('PRIVATE_USER', 'interactive'); health.work('PRIVATE_USER')
    expect(add).toHaveBeenCalledWith(`health_cli_first_work_d${lag}_return`, '2026-10-01')
  }
  expect(JSON.stringify([health.snapshot(), add.mock.calls])).not.toContain('PRIVATE_')
  now += 40 * 86400000
  health.snapshot(); health.intent('PRIVATE_USER', 'interactive'); health.work('PRIVATE_USER')
  expect(add.mock.calls.filter(([k]) => k === 'health_cli_first_interactive_work')).toHaveLength(1)
})

it('samples once a tick, the shortest of which is 45 seconds, so the minute on average keeps its count', () => {
  let now = Date.parse('2026-10-01T12:00:00Z')
  const health = createProductHealth(vi.fn(), () => now, cleanHealthState(null, now))
  const sample = vi.fn(() => ({ rss: 1 }))
  health.sample(sample); now += 44_999; health.sample(sample)
  expect(sample).toHaveBeenCalledOnce()
  now += 1; health.sample(sample)
  expect(sample).toHaveBeenCalledTimes(2)
})

it('bounds RAM, expires unobserved intent, resets on a changed choice and samples at most once a tick', () => {
  let now = Date.parse('2026-10-01T12:00:00Z')
  const add = vi.fn(), health = createProductHealth(add, () => now, cleanHealthState(null, now))
  for (let i = 0; i < 1001; i++) health.intent(`intent-${i}`, 'interactive')
  expect(add).toHaveBeenCalledWith('health_cli_observation_overflow', undefined)
  now += 120001; health.work('intent-0')
  expect(add).toHaveBeenCalledWith('health_cli_unclassified_turns_started', undefined)
  health.reset(); health.intent('old', 'interactive'); health.clearObservations(); health.work('old')
  expect(health.snapshot().hasWorked).toBe(false)
  const sample = vi.fn(() => ({ rss: 900 * 1024 ** 2, cpuPercent: 35 }))
  health.sample(sample); health.sample(sample)
  expect(sample).toHaveBeenCalledOnce()
  expect(add).toHaveBeenCalledWith('health_cli_cpu_10pct_to_50pct', undefined)
  now += 60000; expect(() => health.sample(() => { throw Error('PRIVATE_ERROR') })).not.toThrow()
})

it('reports only completed observed weeks and a prior unclean run, without claiming a crash', () => {
  let now = Date.parse('2026-10-05T12:00:00Z')
  const add = vi.fn(), initial = cleanHealthState({ cleanExit: false, release: '0.3.95' }, now)
  const health = createProductHealth(add, () => now, initial)
  health.start('0.3.96'); health.start('0.3.96'); health.checkpoint()
  health.intent('a', 'interactive'); health.work('a')
  now += 86400000; health.intent('a', 'interactive'); health.work('a')
  now += 6 * 86400000; health.checkpoint(); health.checkpoint()
  expect(add.mock.calls.filter(([k]) => k === 'health_cli_unclean_restart')).toHaveLength(1)
  expect(add).toHaveBeenCalledWith('health_cli_week_worked_2to3days', '2026-10-05')
  health.stop(); expect(health.snapshot().cleanExit).toBe(true)
  const clean = cleanHealthState({ firstWork: '2026-02-30', workDays: ['PRIVATE', '2026-02-30', '2099-01-01'], release: 'PRIVATE', extra: 'PRIVATE' }, now)
  expect(clean.workDays).toEqual([]); expect(clean.firstWork).toBeNull()
  expect(JSON.stringify(clean)).not.toContain('PRIVATE')
})
