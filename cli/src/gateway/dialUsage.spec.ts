import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DIAL_USAGE_FILE, DIAL_USAGE_FILE_MAX_BYTES, DIAL_USAGE_MAX_COUNT } from '../lib/dialUsageContract.js'
import { cleanDialRecord, freshDialRecord, mergeDial, readDialFile, type DialAdd, type DialFileRead,
  type DialRecord } from './dialUsage.js'

const DAY = 86_400_000
// A Monday, and the first day of a 28-day period counted from 1970-01-05.
const TODAY = '2026-11-23'
const shift = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10)
/** The gateway's window: a calendar day within the last 35, [today] included. */
const within = (today: string) => (day: string): boolean => {
  const stamp = Date.parse(`${day}T00:00:00Z`)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(stamp) && shift(day, 0) === day
    && day <= today && day > shift(today, -35)
}
const fileOf = (days: DialFileRead['days'], series = 1): DialFileRead => ({ series, days })
/** A merge on the day before [closeBefore] closes, with the gateway's clock on [closeBefore]. */
const merge = (record: DialRecord, file: DialFileRead, closeBefore: string, desktopDays: string[] = []) =>
  mergeDial(record, file, { closeBefore, desktopDays, validDay: within(closeBefore) })
/** Each add as `<day> <name>`, summed: a name added twice for a day shows. */
const totals = (adds: DialAdd[], only?: RegExp): Record<string, number> => {
  const result: Record<string, number> = {}
  for (const { metric, day, value } of adds) if (!only || only.test(metric)) result[`${day} ${metric}`] = (result[`${day} ${metric}`] ?? 0) + value
  return result
}

describe('the devices\' file, read by the gateway', () => {
  let dir: string, path: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harness-dial-usage-')); path = join(dir, DIAL_USAGE_FILE) })
  afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }) })
  const write = (value: unknown): void => writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))

  it('reads only the vocabulary and logs nothing', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(level => vi.spyOn(console, level).mockImplementation(() => {}))
    write({ version: 1, series: 7, connectedBefore: true, usedBefore: true, days: {
      [TODAY]: { dial_connected_installation_days: 1, dial_open_ok: 3, dial_wait_none: 2,
        dial_not_a_name: 1, PRIVATE_PROJECT_CANARY: 5, constructor: 1, dial_connected_outside_app_installation_days: 1,
        dial_open_failed: 1.5, dial_voice_delivered: -1, dial_voice_failed: 0, dial_voice_held: DIAL_USAGE_MAX_COUNT + 1,
        dial_voice_cancelled: '3', dial_used_installation_days: 2 },
      [shift(TODAY, -1)]: [1],
      [shift(TODAY, -34)]: { dial_open_ok: 1 },
      [shift(TODAY, -35)]: { dial_open_ok: 1 },
      [shift(TODAY, 1)]: { dial_open_ok: 1 },
      '2026-02-30': { dial_open_ok: 1 },
      PRIVATE_PROJECT_CANARY: { dial_open_ok: 1 },
    } })
    const { mtimeMs, size } = statSync(path)
    expect(readDialFile(path, within(TODAY))).toEqual({
      read: { state: 'ok', file: { series: 7, days: {
        [TODAY]: { dial_connected_installation_days: 1, dial_open_ok: 3, dial_wait_none: 2 },
        [shift(TODAY, -34)]: { dial_open_ok: 1 },
      } } },
      stamp: { mtimeMs, size },
    })
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  it('too large, not JSON, another version: bad', () => {
    const bad = (value: unknown): void => { write(value); expect(readDialFile(path, within(TODAY)).read).toEqual({ state: 'bad' }) }
    bad({ version: 1, series: 1, days: {}, pad: 'x'.repeat(DIAL_USAGE_FILE_MAX_BYTES) })
    bad('{"version": 1, "series"')
    bad('[]')
    bad({ version: 2, series: 1, days: {} })
    bad({ version: 1, series: 1.5, days: {} })
    bad({ version: 1, series: 1, days: [] })
  })

  it('a file that is not JSON stays as the devices left it', () => {
    write('{"version": 1, "series"')
    // Read on two ticks: a cache read sets aside bytes that failed twice.
    expect(readDialFile(path, within(TODAY)).read).toEqual({ state: 'bad' })
    expect(readDialFile(path, within(TODAY)).read).toEqual({ state: 'bad' })
    expect(readFileSync(path, 'utf8')).toBe('{"version": 1, "series"')
    expect(existsSync(`${path}.unreadable`)).toBe(false)
  })

  it('no file: none; unchanged: same, unparsed', () => {
    expect(readDialFile(path, within(TODAY))).toEqual({ read: { state: 'none' } })
    // Whole seconds, so the stamp a write leaves can be put back exactly.
    const at = Date.parse(`${TODAY}T10:00:00Z`) / 1000
    write({ version: 1, series: 1, days: { [TODAY]: { dial_open_ok: 1 } } })
    utimesSync(path, at, at)
    const first = readDialFile(path, within(TODAY))
    expect(first.read).toEqual({ state: 'ok', file: { series: 1, days: { [TODAY]: { dial_open_ok: 1 } } } })
    write({ version: 1, series: 1, days: { [TODAY]: { dial_open_ok: 2 } } })
    utimesSync(path, at, at)
    expect(readDialFile(path, within(TODAY), first.stamp)).toEqual({ read: { state: 'same' }, stamp: first.stamp })
    utimesSync(path, at + 1, at + 1)
    expect(readDialFile(path, within(TODAY), first.stamp).read)
      .toEqual({ state: 'ok', file: { series: 1, days: { [TODAY]: { dial_open_ok: 2 } } } })
  })
})

describe('the gateway\'s merge of the dial\'s day', () => {
  it('a second merge of the same file adds nothing', () => {
    const file = fileOf({ [TODAY]: { dial_connected_installation_days: 1, dial_open_ok: 2 } })
    const one = merge(freshDialRecord(false), file, TODAY)
    expect(totals(one.adds)).toEqual({ [`${TODAY} dial_connected_installation_days`]: 1, [`${TODAY} dial_open_ok`]: 2 })
    expect(merge(one.record, file, TODAY).adds).toEqual([])
    // The gateway restarted: its record came back from its queue file.
    const restarted = cleanDialRecord(JSON.parse(JSON.stringify(one.record)), within(TODAY))
    expect(merge(restarted, file, TODAY).adds).toEqual([])
    expect(totals(merge(restarted, fileOf({ [TODAY]: { dial_connected_installation_days: 1, dial_open_ok: 5 } }), TODAY).adds))
      .toEqual({ [`${TODAY} dial_open_ok`]: 3 })
  })

  it('a new series adds its events again but no flag already sent', () => {
    const one = merge(freshDialRecord(false), fileOf({ [TODAY]: { dial_connected_installation_days: 1,
      dial_used_installation_days: 1, dial_open_ok: 4 } }, 1), TODAY)
    // The devices' file was made again: its counts start over.
    const again = fileOf({ [TODAY]: { dial_connected_installation_days: 1, dial_open_ok: 1, dial_voice_delivered: 2 } }, 2)
    const two = merge(one.record, again, TODAY)
    expect(totals(two.adds)).toEqual({ [`${TODAY} dial_open_ok`]: 1, [`${TODAY} dial_voice_delivered`]: 2 })
    expect(merge(two.record, again, TODAY).adds).toEqual([])
    // The day's use was sent from the first series, so its close still knows it.
    expect(totals(merge(two.record, again, shift(TODAY, 1)).adds, /^dial_used_outside_app_installation_days$/))
      .toEqual({ [`${TODAY} dial_used_outside_app_installation_days`]: 1 })
  })

  it('a new series keeps the open day\'s waits so far', () => {
    const one = merge(freshDialRecord(false), fileOf({ [TODAY]: { dial_connected_installation_days: 1, dial_wait_none: 2,
      dial_wait_elsewhere_under_30s: 1 } }, 1), TODAY)
    // The devices' file made again, twice, with the gateway restarted between: its waits start over each time.
    const two = merge(one.record, fileOf({ [TODAY]: { dial_connected_installation_days: 1, dial_wait_none: 1 } }, 2), TODAY)
    const restarted = cleanDialRecord(JSON.parse(JSON.stringify(two.record)), within(TODAY))
    const three = merge(restarted, fileOf({ [TODAY]: { dial_connected_installation_days: 1, dial_wait_none: 4 } }, 3), TODAY)
    expect(totals(merge(three.record, fileOf({ [TODAY]: { dial_connected_installation_days: 1, dial_wait_none: 4 } }, 3),
      shift(TODAY, 1)).adds, /^dial_wait_/)).toEqual({ [`${TODAY} dial_wait_unused_day_installation_days`]: 1,
      [`${TODAY} dial_wait_unused_day_none`]: 7, [`${TODAY} dial_wait_unused_day_elsewhere_under_30s`]: 1 })
  })

  it('a baseline adds nothing and closes what is past', () => {
    const past = shift(TODAY, -3)
    const day = { dial_connected_installation_days: 1, dial_used_installation_days: 1, dial_open_ok: 2 }
    const base = merge(freshDialRecord(true), fileOf({ [past]: day, [TODAY]: day }), TODAY)
    expect(base.adds).toEqual([])
    expect(base.record.baseline).toBe(false)
    const later = fileOf({ [past]: { ...day, dial_open_ok: 9 }, [TODAY]: { ...day, dial_open_ok: 5, dial_voice_delivered: 1 } })
    expect(totals(merge(base.record, later, TODAY).adds))
      .toEqual({ [`${TODAY} dial_open_ok`]: 3, [`${TODAY} dial_voice_delivered`]: 1 })
  })

  it('a day open at a baseline closes without a derivation', () => {
    const next = shift(TODAY, 1)
    const used = { dial_connected_installation_days: 1, dial_used_installation_days: 1 }
    const base = merge(freshDialRecord(true), fileOf({ [TODAY]: { ...used, dial_first_use_installations: 1,
      dial_wait_elsewhere_under_30s: 2 } }), TODAY)
    // What the day held before the baseline is never sent, not even as an outside-app twin, a period flag or a wait.
    const closed = merge(base.record, fileOf({ [TODAY]: { ...used, dial_first_use_installations: 1,
      dial_wait_elsewhere_under_30s: 2 }, [next]: used }), next)
    expect(totals(closed.adds)).toEqual({ [`${next} dial_connected_installation_days`]: 1,
      [`${next} dial_used_installation_days`]: 1 })
    // The next day is the baseline's first to derive, and it returns to no day before it.
    expect(totals(merge(closed.record, fileOf({ [next]: used }), shift(next, 1)).adds)).toEqual({
      [`${next} dial_connected_outside_app_installation_days`]: 1, [`${next} dial_used_outside_app_installation_days`]: 1,
      [`${next} dial_used_week_installations`]: 1, [`${next} dial_used_28d_installations`]: 1,
      [`${next} dial_used_outside_app_week_installations`]: 1, [`${next} dial_used_outside_app_28d_installations`]: 1,
    })
  })

  it('a count that went down adds nothing', () => {
    const one = merge(freshDialRecord(false), fileOf({ [TODAY]: { dial_open_ok: 5 } }), TODAY)
    const down = merge(one.record, fileOf({ [TODAY]: { dial_open_ok: 3 } }), TODAY)
    expect(down.adds).toEqual([])
    expect(totals(merge(down.record, fileOf({ [TODAY]: { dial_open_ok: 7 } }), TODAY).adds)).toEqual({ [`${TODAY} dial_open_ok`]: 2 })
  })

  it('outside-app twins only with no Desktop day in D−27..D', () => {
    const day = shift(TODAY, -1)
    const file = fileOf({ [day]: { dial_connected_installation_days: 1, dial_used_installation_days: 1,
      dial_first_use_installations: 1 } })
    const twins = (desktopDays: string[]) => totals(merge(freshDialRecord(false), file, TODAY, desktopDays).adds, /outside_app_(installation_days|installations)$/)
    const all = { [`${day} dial_connected_outside_app_installation_days`]: 1, [`${day} dial_used_outside_app_installation_days`]: 1,
      [`${day} dial_first_use_outside_app_installations`]: 1 }
    expect(twins([])).toEqual(all)
    expect(twins([shift(day, -28), shift(day, 1)])).toEqual(all)
    expect(twins([shift(day, -27)])).toEqual({})
    expect(twins([day])).toEqual({})
    expect(totals(merge(freshDialRecord(false), fileOf({ [day]: { dial_connected_installation_days: 1 } }), TODAY).adds, /outside_app/))
      .toEqual({ [`${day} dial_connected_outside_app_installation_days`]: 1 })
  })

  it('returns from D−1, D−7, D−28 go on D, outside by the earlier day', () => {
    const day = shift(TODAY, -1), used = { dial_used_installation_days: 1 }
    const file = fileOf({ [shift(day, -28)]: used, [shift(day, -7)]: used, [shift(day, -1)]: used, [day]: used })
    // Desktop opened on D−7: that day and the ones after are in the app, D−28 is outside it.
    expect(totals(merge(freshDialRecord(false), file, TODAY, [shift(day, -7)]).adds, /returning/)).toEqual({
      [`${day} dial_d1_returning_installations`]: 1,
      [`${day} dial_d7_returning_installations`]: 1,
      [`${day} dial_d28_returning_installations`]: 1,
      [`${day} dial_d28_returning_outside_app_installations`]: 1,
    })
  })

  it('waits go to the used or the unused day, with its flag', () => {
    const usedDay = shift(TODAY, -3), unusedDay = shift(TODAY, -2), noWait = shift(TODAY, -1)
    const file = fileOf({
      [usedDay]: { dial_connected_installation_days: 1, dial_used_installation_days: 1, dial_wait_dial_under_30s: 2,
        dial_wait_elsewhere_over_10m: 1, dial_wait_none: 1 },
      [unusedDay]: { dial_connected_installation_days: 1, dial_wait_elsewhere_30s_to_2m: 3, dial_wait_none: 2 },
      [noWait]: { dial_connected_installation_days: 1 },
    })
    const adds = merge(freshDialRecord(false), file, TODAY).adds
    expect(totals(adds, /^dial_wait_/)).toEqual({
      [`${usedDay} dial_wait_used_day_installation_days`]: 1, [`${usedDay} dial_wait_used_day_dial_under_30s`]: 2,
      [`${usedDay} dial_wait_used_day_elsewhere_over_10m`]: 1, [`${usedDay} dial_wait_used_day_none`]: 1,
      [`${unusedDay} dial_wait_unused_day_installation_days`]: 1, [`${unusedDay} dial_wait_unused_day_elsewhere_30s_to_2m`]: 3,
      [`${unusedDay} dial_wait_unused_day_none`]: 2,
    })
  })

  it('a closed day adds nothing more', () => {
    const day = shift(TODAY, -1)
    const one = merge(freshDialRecord(false), fileOf({ [day]: { dial_connected_installation_days: 1, dial_open_ok: 1 } }), TODAY)
    expect(totals(one.adds, /^dial_(connected_installation_days|open_ok)$/))
      .toEqual({ [`${day} dial_connected_installation_days`]: 1, [`${day} dial_open_ok`]: 1 })
    const changed = { [day]: { dial_connected_installation_days: 1, dial_used_installation_days: 1, dial_open_ok: 5, dial_wait_none: 1 } }
    expect(merge(one.record, fileOf(changed), TODAY).adds).toEqual([])
    expect(merge(one.record, fileOf(changed, 2), TODAY).adds).toEqual([])
  })

  it('sent holds only days not closed', () => {
    const counts = { dial_open_ok: 1 }
    const { record } = merge(freshDialRecord(false), fileOf({ [shift(TODAY, -2)]: counts, [shift(TODAY, -1)]: counts, [TODAY]: counts }), TODAY)
    expect(record.sent).toEqual({ [TODAY]: counts })
    expect(record.closedThrough).toBe(shift(TODAY, -1))
  })

  it('the period flags once a week and once a 28-day period', () => {
    // TODAY starts a week and a 28-day period: the Sunday before is in the last ones.
    const used = { dial_used_installation_days: 1 }
    const days = [shift(TODAY, -1), TODAY, shift(TODAY, 2), shift(TODAY, 7)]
    const one = merge(freshDialRecord(false), fileOf(Object.fromEntries(days.map(day => [day, used]))), shift(TODAY, 8))
    const flags = (adds: DialAdd[]) => totals(adds, /_(week|28d)_installations$/)
    expect(flags(one.adds)).toEqual({
      [`${shift(TODAY, -1)} dial_used_week_installations`]: 1, [`${shift(TODAY, -1)} dial_used_28d_installations`]: 1,
      [`${shift(TODAY, -1)} dial_used_outside_app_week_installations`]: 1, [`${shift(TODAY, -1)} dial_used_outside_app_28d_installations`]: 1,
      [`${TODAY} dial_used_week_installations`]: 1, [`${TODAY} dial_used_28d_installations`]: 1,
      [`${TODAY} dial_used_outside_app_week_installations`]: 1, [`${TODAY} dial_used_outside_app_28d_installations`]: 1,
      [`${shift(TODAY, 7)} dial_used_week_installations`]: 1, [`${shift(TODAY, 7)} dial_used_outside_app_week_installations`]: 1,
    })
    // After a restart of the gateway, a later day of that week and period adds no period flag.
    const restarted = cleanDialRecord(JSON.parse(JSON.stringify(one.record)), within(shift(TODAY, 9)))
    expect(flags(merge(restarted, fileOf({ [shift(TODAY, 8)]: used }), shift(TODAY, 9)).adds)).toEqual({})
  })

  it('a record read back keeps only what a record holds, and a clock set back reopens no day', () => {
    const ahead = shift(TODAY, 2)
    expect(cleanDialRecord({ series: 3, baseline: true, closedThrough: ahead, PRIVATE_PROJECT_CANARY: 'x',
      sent: { [TODAY]: { dial_open_ok: 2, dial_not_a_name: 1, dial_used_installation_days: 2 },
        [shift(TODAY, -40)]: { dial_open_ok: 1 }, PRIVATE_PROJECT_CANARY: { dial_open_ok: 1 } },
      earlierWaits: { [TODAY]: { dial_wait_none: 3, PRIVATE_PROJECT_CANARY: 1 }, [shift(TODAY, -40)]: { dial_wait_none: 1 } },
      usedDays: [TODAY, shift(TODAY, -40), 'PRIVATE_PROJECT_CANARY', TODAY, 5], usedOutsideDays: 'no' }, within(TODAY)))
      .toEqual({ series: 3, baseline: true, closedThrough: ahead, sent: { [TODAY]: { dial_open_ok: 2 } },
        earlierWaits: { [TODAY]: { dial_wait_none: 3 } }, usedDays: [TODAY], usedOutsideDays: [] })
    expect(cleanDialRecord(undefined, within(TODAY))).toEqual(freshDialRecord(false))
    expect(cleanDialRecord({ closedThrough: '2026-02-30', series: 1.5 }, within(TODAY))).toEqual(freshDialRecord(false))
    const { record } = merge(freshDialRecord(false), fileOf({ [TODAY]: { dial_open_ok: 1 } }), shift(TODAY, 1))
    expect(merge(record, fileOf({ [TODAY]: { dial_open_ok: 4 } }), TODAY).adds).toEqual([])
  })
})
