import { describe, expect, it } from 'vitest'
import { reflectionMessageId } from '../superTabs/costs/reflection.js'
import { reflectionDue } from './routingReflection.js'

const utc = (day: number, hour: number, minute = 0) => Date.UTC(2026, 9, day, hour, minute)

describe('when the nightly routing reflection is due', () => {
  it('is due from 23:00 to 23:59 in Vietnam for a project with no digest zone, for that local date', () => {
    expect(reflectionDue({}, utc(30, 16, 0))).toBe('2026-10-30')
    expect(reflectionDue({}, utc(30, 16, 59))).toBe('2026-10-30')
    expect(reflectionDue({}, utc(30, 15, 59))).toBeNull()
    // Midnight in Vietnam is the next day: a pass that missed 23:xx does not report a day late.
    expect(reflectionDue({}, utc(30, 17, 0))).toBeNull()
  })

  it('follows the project digest time zone', () => {
    const berlin = { digest: { time: '08:00', timeZone: 'Europe/Berlin' } }
    expect(reflectionDue(berlin, utc(30, 22, 30))).toBe('2026-10-30')
    expect(reflectionDue(berlin, utc(30, 16, 30))).toBeNull()
  })

  it('falls back to Vietnam for a zone this runtime does not know', () => {
    expect(reflectionDue({ digest: { time: '08:00', timeZone: 'Mars/Olympus' } }, utc(30, 16, 30))).toBe('2026-10-30')
  })

  it('posts one report a project a local date', () => {
    expect(reflectionMessageId('tab', 'p1', '2026-10-30')).toBe(reflectionMessageId('tab', 'p1', '2026-10-30'))
    expect(reflectionMessageId('tab', 'p1', '2026-10-30')).not.toBe(reflectionMessageId('tab', 'p1', '2026-10-31'))
    expect(reflectionMessageId('tab', 'p1', '2026-10-30')).not.toBe(reflectionMessageId('tab', 'p2', '2026-10-30'))
  })
})
