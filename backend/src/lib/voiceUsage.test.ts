// What one transcribed clip adds to the day's voice totals (docs/plans/2026-11-23-dial-usage-counts-design.md,
// "What does voice cost?"): the dial's clips apart from the rest, and the account-day buckets over all of it.
import { describe, expect, it } from 'vitest'
import { VOICE_USAGE_METRICS, voiceIncrements, voiceSurface } from './voiceUsage.js'
import { PRODUCT_USAGE_METRICS } from '../types/productUsage.js'
import { DIAL_USAGE_METRICS } from '../types/dialUsage.js'

describe('voiceIncrements', () => {
  it('a first 30 s dial clip: one dial clip, its ms, one account-day, no edge', () => {
    expect(voiceIncrements('dial', 0, 30_000, 800)).toEqual([
      ['voice_dial_clips', 1], ['voice_dial_audio_ms', 30_000], ['voice_dial_transcribe_ms', 800], ['voice_account_days', 1],
    ])
  })

  it('a rest clip counts under rest and moves the same account buckets', () => {
    expect(voiceIncrements('rest', 0, 30_000, 800)).toEqual([
      ['voice_rest_clips', 1], ['voice_rest_audio_ms', 30_000], ['voice_rest_transcribe_ms', 800], ['voice_account_days', 1],
    ])
    expect(voiceIncrements('rest', 50_000, 20_000, 0)).toContainEqual(['voice_account_days_over_1m', 1])
  })

  it('50 s to 70 s crosses 1 min only', () => {
    expect(voiceIncrements('dial', 50_000, 20_000, 0)).toEqual([
      ['voice_dial_clips', 1], ['voice_dial_audio_ms', 20_000], ['voice_dial_transcribe_ms', 0], ['voice_account_days_over_1m', 1],
    ])
  })

  it('reaching an edge exactly crosses it, and a clip that starts on it does not cross it again', () => {
    expect(voiceIncrements('dial', 30_000, 30_000, 0)).toContainEqual(['voice_account_days_over_1m', 1])
    expect(voiceIncrements('dial', 60_000, 30_000, 0)).toEqual([
      ['voice_dial_clips', 1], ['voice_dial_audio_ms', 30_000], ['voice_dial_transcribe_ms', 0],
    ])
  })

  it('0 to 25 min crosses all three', () => {
    expect(voiceIncrements('rest', 0, 1_500_000, 2_000)).toEqual([
      ['voice_rest_clips', 1], ['voice_rest_audio_ms', 1_500_000], ['voice_rest_transcribe_ms', 2_000], ['voice_account_days', 1],
      ['voice_account_days_over_1m', 1], ['voice_account_days_over_5m', 1], ['voice_account_days_over_20m', 1],
    ])
  })

  it('past 20 min crosses none', () => {
    expect(voiceIncrements('rest', 1_250_000, 30_000, 500)).toEqual([
      ['voice_rest_clips', 1], ['voice_rest_audio_ms', 30_000], ['voice_rest_transcribe_ms', 500],
    ])
  })

  it('counts whole milliseconds, the audio rounded up as the quota charges it', () => {
    // The quota charges Math.ceil of the clip, so the next clip's start is this one's rounded end: rounding the
    // other way would let an edge fall between two clips and count for neither.
    expect(voiceIncrements('dial', 57_499, 2_500.4, 812.6)).toEqual([
      ['voice_dial_clips', 1], ['voice_dial_audio_ms', 2_501], ['voice_dial_transcribe_ms', 813], ['voice_account_days_over_1m', 1],
    ])
  })

  it('counts an empty clip as the 1 ms the quota charges, so an edge it reaches is not skipped', () => {
    expect(voiceIncrements('dial', 59_999, 0, 0)).toEqual([
      ['voice_dial_clips', 1], ['voice_dial_audio_ms', 1], ['voice_dial_transcribe_ms', 0], ['voice_account_days_over_1m', 1],
    ])
  })
})

describe('voiceSurface', () => {
  it('only the exact dial value is the dial', () => {
    expect(voiceSurface('dial')).toBe('dial')
    for (const value of [undefined, '', 'Dial', ' dial', 'dial ', 'phone', ['dial', 'dial'], ['dial'], 'dial, dial', 'd'.repeat(10_240)]) {
      expect(voiceSurface(value), String(value).slice(0, 40)).toBe('rest')
    }
  })
})

it('no voice name is one a client may report', () => {
  // Voice is counted at the route, never taken from a report: a client naming one is dropped as unknown.
  const reportable = new Set<string>([...PRODUCT_USAGE_METRICS, ...DIAL_USAGE_METRICS])
  expect(VOICE_USAGE_METRICS.filter(name => reportable.has(name))).toEqual([])
})
