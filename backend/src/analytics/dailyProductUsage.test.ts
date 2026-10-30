import { expect, it } from 'vitest'
import { dailyProductUsage } from './dailyProductUsage.js'

it('keeps missing client coverage separate from zero and separates relay activity', () => {
  const report = dailyProductUsage([
    { dayUtc: new Date('2026-10-12'), metric: 'relay_turns_started', value: 10 },
    { dayUtc: new Date('2026-10-12'), metric: 'feedback_useful', value: 2 },
    { dayUtc: new Date('2026-10-12'), metric: 'd1_returning_work_installations', value: 1 },
    { dayUtc: new Date('2026-10-13'), metric: 'active_installation_days', value: 10 },
    { dayUtc: new Date('2026-10-13'), metric: 'working_installation_days', value: 4 },
    { dayUtc: new Date('2026-10-13'), metric: 'PRIVATE_CANARY', value: 1 },
  ], 2, new Date('2026-10-13T12:00:00Z'))
  expect(report.daily[0].workingComputers).toBeNull()
  expect(report.daily[1]).toMatchObject({ period: 'incomplete', activeComputers: 10, workingComputers: 4, workingPctOfActive: 40 })
  expect(report.previousCompleteWeek.returningPct).toBeNull()
  expect(JSON.stringify(report)).not.toContain('PRIVATE_CANARY')
})

it('reports the phone\'s debug and simulator opens beside its total, which still counts them', () => {
  const report = dailyProductUsage([
    { dayUtc: new Date('2026-10-13'), metric: 'relay_mobile_opens', value: 15104 },
    { dayUtc: new Date('2026-10-13'), metric: 'relay_mobile_debug_opens', value: 14760 },
  ], 1, new Date('2026-10-13T12:00:00Z'))
  expect(report.daily[0].counters).toMatchObject({ relay_mobile_opens: 15104, relay_mobile_debug_opens: 14760 })
})

it('uses the preceding complete week as the retention denominator, never this partial week', () => {
  const report = dailyProductUsage([
    { dayUtc: new Date('2026-09-28'), metric: 'weekly_working_installations', value: 10 },
    { dayUtc: new Date('2026-10-05'), metric: 'weekly_returning_installations', value: 6 },
    { dayUtc: new Date('2026-10-05'), metric: 'weekly_working_installations', value: 8 },
    { dayUtc: new Date('2026-10-12'), metric: 'weekly_returning_installations', value: 99 },
  ], 21, new Date('2026-10-13'))
  expect(report.previousCompleteWeek).toMatchObject({ starting: '2026-10-05', denominatorWeekStarting: '2026-09-28', priorWorkingComputers: 10, returnedWorkingComputers: 6, returningPct: 60 })
})

it('does not call cross-midnight unmatched turn counts success, or emit impossible percentages', () => {
  const report = dailyProductUsage([
    { dayUtc: new Date('2026-10-13'), metric: 'turns_ended', value: 3 },
    { dayUtc: new Date('2026-10-13'), metric: 'turns_interrupted', value: 1 },
    { dayUtc: new Date('2026-10-13'), metric: 'working_installation_days', value: 9 },
    { dayUtc: new Date('2026-10-13'), metric: 'active_installation_days', value: 1 },
  ], 1, new Date('2026-10-13'))
  expect(report.daily[0]).toMatchObject({ workingPctOfActive: null, interruptedPctOfObservedEnds: 25 })
  expect(report.daily[0]).not.toHaveProperty('successRate')
})
