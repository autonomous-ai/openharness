import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { APP_IDS, UNKNOWN_APP } from '../cable/hosts/hostDetect.js'
import { ENGINES } from '../engines/types.js'
import { composeNotice, isNoticeResult, noticeKind } from './dialNotice.js'
import {
  DIAL_DERIVED_METRICS, DIAL_DEVICE_METRICS, DIAL_FILE_METRICS, DIAL_FLAG_METRICS, DIAL_NOTICE_KINDS,
  DIAL_NOTICE_RESULTS, DIAL_USAGE_ENGINES, DIAL_USAGE_HOSTS, DIAL_USAGE_MARGIN_METRICS, DIAL_USAGE_MAX_COUNT, DIAL_USAGE_METRICS, DIAL_VOICE_SURFACE,
  DIAL_VOICE_SURFACE_HEADER, DIAL_WAIT_RAW_METRICS,
} from './dialUsageContract.js'
import { PRODUCT_USAGE_METRICS } from './productUsageContract.js'

describe('the dial usage vocabulary', () => {
  it('names every engine the daemon knows, then other', () =>
    expect(DIAL_USAGE_ENGINES).toEqual([...ENGINES, 'other']))

  it('names every dial host, the unknown app as other', () =>
    expect([...DIAL_USAGE_HOSTS].sort()).toEqual(
      APP_IDS.map((id) => id === UNKNOWN_APP ? 'other' : id.replaceAll('-', '_')).sort()))

  it('every name is unique, at most 64 characters, starts with dial_, and is no product usage name', () => {
    const all: readonly string[] = [...DIAL_DEVICE_METRICS, ...DIAL_WAIT_RAW_METRICS, ...DIAL_DERIVED_METRICS]
    expect(new Set(all).size).toBe(all.length)
    const product = new Set<string>(PRODUCT_USAGE_METRICS)
    for (const name of all) {
      expect(name.length).toBeLessThanOrEqual(64)
      expect(name).toMatch(/^dial_[a-z0-9_]+$/)
      expect(product.has(name)).toBe(false)
    }
  })

  it('the file holds the devices\' names and the waits; a report, the devices\' names and the gateway\'s', () => {
    expect([...DIAL_FILE_METRICS].sort()).toEqual([...DIAL_DEVICE_METRICS, ...DIAL_WAIT_RAW_METRICS].sort())
    expect([...DIAL_USAGE_METRICS].sort()).toEqual([...DIAL_DEVICE_METRICS, ...DIAL_DERIVED_METRICS].sort())
    const usage = new Set<string>(DIAL_USAGE_METRICS)
    const file = new Set<string>(DIAL_FILE_METRICS)
    expect(DIAL_WAIT_RAW_METRICS.filter((m) => usage.has(m))).toEqual([])
    expect(DIAL_DERIVED_METRICS.filter((m) => file.has(m))).toEqual([])
  })

  it('a flag is a computer count by its name', () => {
    const named = [...new Set<string>([...DIAL_FILE_METRICS, ...DIAL_USAGE_METRICS])]
      .filter((m) => /_installation(s|_days)$/.test(m)).sort()
    expect([...DIAL_FLAG_METRICS].sort()).toEqual(named)
    const flags = new Set<string>(DIAL_FLAG_METRICS)
    for (const margin of DIAL_USAGE_MARGIN_METRICS) expect(flags.has(margin)).toBe(true)
  })

  // The names sent to the PM for the value from the dial: each count with its computer flag, sent as it comes, and the
  // period flags the gateway derives as a day closes.
  it('names the value from the dial', () => {
    const device = new Set<string>(DIAL_DEVICE_METRICS)
    expect(device.has('dial_value_installation_days')).toBe(true)
    for (const count of ['ring_answered_2m', 'ring_answered_10m', 'ring_away_answered_2m', 'ring_away_answered_10m',
      'done_away_prompted_10m']) {
      expect(device.has(`dial_value_${count}`), count).toBe(true)
      expect(device.has(`dial_value_${count}_installation_days`), count).toBe(true)
    }
    expect(DIAL_DERIVED_METRICS).toEqual(expect.arrayContaining(['dial_value_week_installations', 'dial_value_28d_installations']))
  })

  // The names sent to the PM for the dial skill's use (docs/plans/2026-11-26-dial-skill-usage-design.md).
  it('names the dial skill\'s use: eighteen names, six of them computer flags', () => {
    expect(DIAL_DEVICE_METRICS.filter((m) => /^dial_(skill|notice)_/.test(m)).sort()).toEqual([
      'dial_skill_claude_installation_days', 'dial_skill_codex_installation_days', 'dial_notice_installation_days',
      'dial_notice_claude', 'dial_notice_codex', 'dial_notice_other', 'dial_notice_claude_installation_days',
      'dial_notice_codex_installation_days', 'dial_notice_other_installation_days', 'dial_notice_shown',
      'dial_notice_no_dial', 'dial_notice_limited', 'dial_notice_proceeding', 'dial_notice_waiting', 'dial_notice_plain',
      'dial_notice_answered_10m', 'dial_notice_present', 'dial_notice_present_answered_10m',
    ].sort())
    expect(DIAL_FLAG_METRICS.filter((m) => /^dial_(skill|notice)_/.test(m)).sort()).toEqual([
      'dial_skill_claude_installation_days', 'dial_skill_codex_installation_days', 'dial_notice_installation_days',
      'dial_notice_claude_installation_days', 'dial_notice_codex_installation_days', 'dial_notice_other_installation_days',
    ].sort())
  })

  // The contract imports nothing, so this pins its words to the devices' own.
  it('names a notice\'s answers and kinds as lib/dialNotice.ts does', () => {
    expect(DIAL_NOTICE_RESULTS).toHaveLength(3)
    for (const result of DIAL_NOTICE_RESULTS) expect(isNoticeResult(result.replaceAll('_', ' ')), result).toBe(true)
    expect(DIAL_NOTICE_KINDS).toHaveLength(3)
    for (const kind of DIAL_NOTICE_KINDS) {
      expect(noticeKind(composeNotice('q', 's', kind === 'plain' ? undefined : kind)), kind).toBe(kind)
    }
  })

  it('a report of the 64 longest names at DIAL_USAGE_MAX_COUNT fits the backend\'s 8 KiB body', () => {
    const counters = Object.fromEntries([...DIAL_USAGE_METRICS].sort((a, b) => b.length - a.length).slice(0, 64)
      .map((m) => [m, DIAL_USAGE_MAX_COUNT]))
    const report = {
      schemaVersion: 1, revision: 2 ** 31, id: randomUUID(), day: '2026-11-23',
      context: { surface: 'cli', release: '10.10.100', platform: 'windows', channel: 'production' }, counters,
    }
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(8192)
  })

  it('imports nothing, so the backend\'s copy is the same file', () =>
    expect(readFileSync(new URL('./dialUsageContract.ts', import.meta.url), 'utf8')).not.toMatch(/^import /m))

  it('marks the dial\'s voice with one fixed lower-case header and value', () => {
    expect(DIAL_VOICE_SURFACE_HEADER).toBe('x-harness-voice-surface')
    expect(DIAL_VOICE_SURFACE).toBe('dial')
  })
})
