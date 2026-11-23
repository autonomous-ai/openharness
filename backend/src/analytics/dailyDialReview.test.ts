import { describe, expect, it } from 'vitest'
import { DIAL_REVIEW_METRICS, dailyDialReview } from './dailyDialReview.js'
import { DIAL_USAGE_ENGINES, DIAL_USAGE_HOSTS, DIAL_USAGE_METRICS } from '../types/dialUsage.js'
import { VOICE_USAGE_METRICS } from '../lib/voiceUsage.js'

const DAY = 86_400_000
const now = new Date('2026-11-23T12:00:00Z')
/** The UTC day [n] days before today (2026-11-23): 1 is the last complete day. */
const ago = (n: number) => new Date(Date.parse('2026-11-23') - n * DAY)
const row = (n: number, metric: string, value: number) => ({ dayUtc: ago(n), metric, value })
type Review = ReturnType<typeof dailyDialReview>
const rowOf = (review: Review['outsideTeam'], section: string, name: string) =>
  review.find(s => s.name.startsWith(section))?.rows.find(r => r.name === name)

describe('dailyDialReview', () => {
  it('opens with the signed-in and hooked-engines limits', () => {
    const { limits } = dailyDialReview([], [], now)
    expect(limits[0]).toMatch(/^Signed-in computers only/)
    expect(limits[1]).toMatch(/hooked engines only/)
  })

  it('reads outside the team first and the team apart', () => {
    const review = dailyDialReview([row(1, 'dial_connected_installation_days', 6), row(1, 'staff:dial_connected_installation_days', 7),
      row(1, 'testing:dial_connected_installation_days', 2), row(1, 'health_cli_collector_days', 40),
      row(1, 'staff:health_cli_collector_days', 9)], [], now)
    expect(Object.keys(review).indexOf('outsideTeam')).toBeLessThan(Object.keys(review).indexOf('team'))
    expect(rowOf(review.outsideTeam, 'Who uses a dial', 'Connected (computer-days)')?.computers.day).toBe(6)
    expect(rowOf(review.team, 'Who uses a dial', 'Connected (computer-days)')?.computers.day).toBe(9)
    expect(review.coverage).toEqual({ day: 40, d7: 40, d28: 40 })
  })

  it('shows <5 under five computers, and on the events beside them', () => {
    const review = dailyDialReview([row(1, 'dial_engine_claude_installation_days', 3), row(1, 'dial_engine_claude_agents', 40),
      row(10, 'dial_engine_claude_installation_days', 5), row(10, 'dial_engine_claude_agents', 2)], [], now)
    expect(rowOf(review.outsideTeam, 'Engines shown', 'claude')).toEqual({ name: 'claude',
      computers: { day: '<5', d7: '<5', d28: 8 }, events: { day: '<5', d7: '<5', d28: 42 } })
  })

  it('adds seven and twenty-eight complete days, today left out', () => {
    const metric = 'dial_connected_installation_days'
    const review = dailyDialReview([row(0, metric, 100), row(1, metric, 5), row(7, metric, 5), row(8, metric, 5),
      row(28, metric, 5), row(29, metric, 100)], [], now)
    expect(rowOf(review.outsideTeam, 'Who uses a dial', 'Connected (computer-days)')?.computers).toEqual({ day: 5, d7: 10, d28: 20 })
  })

  it('derives the voice buckets and hides them under five', () => {
    const { voice } = dailyDialReview([row(1, 'voice_account_days', 20), row(1, 'voice_account_days_over_1m', 12),
      row(1, 'voice_account_days_over_5m', 5), row(1, 'voice_account_days_over_20m', 2)], [], now)
    expect(voice.outsideTeam.accountDays.label).toMatch(/all voice on the account, dial and the rest/i)
    const day = Object.fromEntries(['all', 'under1m', 'm1to5', 'm5to20', 'over20m']
      .map(k => [k, (voice.outsideTeam.accountDays as unknown as Record<string, { day: unknown }>)[k].day]))
    expect(day).toEqual({ all: 20, under1m: 8, m1to5: 7, m5to20: '<5', over20m: '<5' })
  })

  it('shows the dial\'s voice apart from the rest, each hidden under its own five, with the older-CLI note', () => {
    const { voice } = dailyDialReview([row(1, 'dial_voice_installation_days', 6), row(1, 'voice_dial_clips', 30),
      row(1, 'voice_dial_audio_ms', 90_000), row(1, 'voice_dial_transcribe_ms', 30_000), row(1, 'voice_account_days', 3),
      row(1, 'voice_rest_clips', 12), row(1, 'voice_rest_audio_ms', 600_000), row(1, 'voice_rest_transcribe_ms', 60_000),
      row(10, 'voice_account_days', 4), row(10, 'voice_rest_clips', 1)], [], now)
    expect(voice.outsideTeam.note).toBe('Voice from older CLIs counts as the rest until they update.')
    expect(voice.outsideTeam.dial).toEqual({ clips: { day: 30, d7: 30, d28: 30 }, audioMinutes: { day: 1.5, d7: 1.5, d28: 1.5 },
      transcribeMinutes: { day: 0.5, d7: 0.5, d28: 0.5 } })
    expect(voice.outsideTeam.rest).toEqual({ clips: { day: '<5', d7: '<5', d28: 13 }, audioMinutes: { day: '<5', d7: '<5', d28: 10 },
      transcribeMinutes: { day: '<5', d7: '<5', d28: 1 } })
  })

  it('labels the period flags and first use as distinct computers, connected as computer-days', () => {
    const review = dailyDialReview([row(1, 'dial_connected_installation_days', 9), row(1, 'dial_used_installation_days', 6),
      row(2, 'dial_used_installation_days', 6), row(2, 'dial_used_week_installations', 7), row(20, 'dial_used_28d_installations', 8),
      row(1, 'dial_first_use_installations', 5)], [], now)
    const who = review.outsideTeam.find(s => s.name === 'Who uses a dial')!.rows
    expect(who.map(r => r.name)).toEqual(['Connected (computer-days)',
      'Used (day: computers; 7 and 28 days: distinct computers)', 'First use ever (distinct computers)'])
    expect(who[1]!.computers).toEqual({ day: 6, d7: 7, d28: 8 })
    expect(review.limits.join(' ')).toMatch(/Monday week/)
  })

  it('never crosses engine, host or margin', () => {
    const rows = DIAL_REVIEW_METRICS.flatMap(metric => Array.from({ length: 28 }, (_, i) => row(i + 1, metric, 10)))
    const breakdowns = ['release:cli:0.6.84', 'platform:cli:linux'].flatMap(bucket => ['dial_used_installation_days', 'health_cli_collector_days']
      .map(metric => row(1, `breakdown:${bucket}:${metric}`, 30)))
    const review = dailyDialReview(rows, breakdowns, now)
    const engineOnly = DIAL_USAGE_ENGINES.filter(e => !(DIAL_USAGE_HOSTS as readonly string[]).includes(e))
    const hostOnly = DIAL_USAGE_HOSTS.filter(h => !(DIAL_USAGE_ENGINES as readonly string[]).includes(h))
    const names = [...review.outsideTeam, ...review.team].flatMap(s => s.rows.map(r => r.name))
    expect(names.length).toBeGreaterThan(100)
    for (const name of names) {
      const tokens = name.toLowerCase().split(/[^a-z0-9_]+/)
      const lists = [engineOnly.some(e => tokens.includes(e)), hostOnly.some(h => tokens.includes(h)),
        ['macos', 'linux', 'windows'].some(p => tokens.includes(p))].filter(Boolean)
      expect(lists.length, name).toBeLessThanOrEqual(1)
    }
    expect(review.margins).toEqual({ platform: [{ day: '2026-11-22', bucket: 'linux', computers: 30 }],
      release: [{ day: '2026-11-22', bucket: '0.6.84', computers: 30 }] })
  })

  it('leaves out a row with nothing', () => {
    const review = dailyDialReview([row(1, 'dial_engine_codex_installation_days', 6), row(1, 'dial_engine_codex_agents', 9)], [], now)
    expect(review.outsideTeam.map(s => s.name)).toEqual([expect.stringMatching(/^Engines shown/)])
    expect(review.outsideTeam[0]!.rows.map(r => r.name)).toEqual(['codex'])
    expect(review.team).toEqual([])
  })

  it('reads a return on its return day against the day L days earlier, outside the app apart', () => {
    // The gateway counts a return on day N+L, the day the computer is used again.
    const review = dailyDialReview([row(2, 'dial_used_installation_days', 6), row(1, 'dial_d1_returning_installations', 5),
      row(1, 'dial_used_installation_days', 9), row(2, 'dial_used_outside_app_installation_days', 5),
      row(1, 'dial_d1_returning_outside_app_installations', 5)], [], now)
    const rows = review.outsideTeam.find(s => s.name.startsWith('Return'))!.rows
    expect(rows.find(r => r.name === 'Used on day N (N+1 complete)')?.computers.day).toBe(6)
    expect(rows.find(r => r.name === 'Again on N+1')?.computers.day).toBe(5)
    expect(rows.find(r => r.name === 'Outside the app, again on N+1')?.computers.day).toBe(5)
  })

  it('rates an N+28 return against a used day 29 days back, and reads only the used days that far back', () => {
    const review = dailyDialReview([row(29, 'dial_used_installation_days', 6), row(1, 'dial_d28_returning_installations', 5),
      row(29, 'dial_used_outside_app_installation_days', 5), row(1, 'dial_d28_returning_outside_app_installations', 5),
      row(40, 'dial_d28_returning_installations', 7), row(40, 'dial_connected_installation_days', 9)], [], now)
    const section = review.outsideTeam.find(s => s.name.startsWith('Return'))!
    expect(section.rows.find(r => r.name === 'Used on day N (N+28 complete)')?.computers.day).toBe(6)
    expect(section.rows.find(r => r.name === 'Again on N+28')?.computers).toEqual({ day: 5, d7: 5, d28: 5 })
    expect(section.rows.find(r => r.name === 'Outside the app, again on N+28')?.computers.day).toBe(5)
    expect(review.outsideTeam.find(s => s.name === 'Who uses a dial')).toBeUndefined()
  })

  it('suppresses a margin under 20 collector observations', () => {
    const b = (bucket: string, metric: string, value: number) => row(1, `breakdown:${bucket}:${metric}`, value)
    const review = dailyDialReview([], [b('platform:cli:macos', 'health_cli_collector_days', 25), b('platform:cli:macos', 'dial_used_installation_days', 8),
      b('platform:cli:linux', 'health_cli_collector_days', 10), b('platform:cli:linux', 'dial_used_installation_days', 6),
      b('release:cli:0.6.84', 'health_cli_collector_days', 30), b('release:cli:0.6.84', 'dial_used_installation_days', 3)], now)
    expect(review.margins).toEqual({ platform: [{ day: '2026-11-22', bucket: 'macos', computers: 8 }],
      release: [{ day: '2026-11-22', bucket: '0.6.84', computers: '<5' }] })
  })

  it('reads every dial and voice name, the team\'s too', () => {
    for (const name of [...DIAL_USAGE_METRICS, ...VOICE_USAGE_METRICS, 'health_cli_collector_days']) {
      expect(DIAL_REVIEW_METRICS).toEqual(expect.arrayContaining([name, `staff:${name}`, `testing:${name}`]))
    }
  })
})
