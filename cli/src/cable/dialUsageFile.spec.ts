import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DIAL_FILE_METRICS, DIAL_USAGE_DAYS, DIAL_USAGE_FILE, DIAL_USAGE_FILE_MAX_BYTES, DIAL_USAGE_FILE_VERSION,
  DIAL_USAGE_MAX_COUNT,
} from '../lib/dialUsageContract.js'
import { DIAL_USAGE_WRITE_MS, DialUsageFile, type DialUsageFileDeps } from './dialUsageFile.js'

// Pass-through, recording where each rename lands: one rename onto the file is one write.
const renames = vi.hoisted(() => [] as string[])
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      renames.push(String(args[1]))
      return actual.renameSync(...args)
    },
  }
})

const DAY = 86_400_000
// Early December, so the 35 days reach back into November and a 2026-11-31 rolls over into them.
const NOW = Date.parse('2026-12-10T10:00:00.000Z')
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const TODAY = dayOf(NOW)

interface Saved {
  version: number
  series: number
  connectedBefore: boolean
  usedBefore: boolean
  days: Record<string, Record<string, unknown>>
}

// Every folder made and every line said, so the last test can check no line names a path or what a file says.
const folders: string[] = []
const said: string[] = []

const aFile = () => {
  const folder = mkdtempSync(join(tmpdir(), 'dial-usage-'))
  folders.push(folder)
  return join(folder, DIAL_USAGE_FILE)
}

const open = (file: string, over: Partial<DialUsageFileDeps> = {}) => {
  const logs: string[] = []
  const usage = new DialUsageFile({
    file,
    now: () => Date.now(),
    after: (ms, run) => {
      const timer = setTimeout(run, ms)
      return () => clearTimeout(timer)
    },
    signedIn: () => true,
    hadDial: () => false,
    log: (line) => { logs.push(line); said.push(line) },
    ...over,
  })
  return { usage, logs }
}

const saved = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Saved
const writesTo = (file: string) => renames.filter((to) => to === file).length
const flush = () => vi.advanceTimersByTime(DIAL_USAGE_WRITE_MS)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  renames.length = 0
})
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true })
})

// A file this build wrote: a day earlier, with both marks spent.
const GOOD = {
  version: DIAL_USAGE_FILE_VERSION, series: NOW - DAY, connectedBefore: true, usedBefore: true,
  days: { [TODAY]: { dial_open_ok: 2 } },
}
const goodWith = (over: Record<string, unknown>) => JSON.stringify({ ...GOOD, ...over })

const WHOLE: Array<[string, string, string]> = [
  ['long', 'one byte over the cap', JSON.stringify(GOOD).padEnd(DIAL_USAGE_FILE_MAX_BYTES + 1, ' ')],
  ['json', 'torn', '{"version'],
  ['json', 'empty', ''],
  ['version', 'version 2', goodWith({ version: 2 })],
  ['version', 'no version', goodWith({ version: undefined })],
  ['shape', 'a list', '[]'],
  ['shape', 'null', 'null'],
  ['shape', 'no series', goodWith({ series: undefined })],
  ['shape', 'a series of 0', goodWith({ series: 0 })],
  ['shape', 'a fractional series', goodWith({ series: 1.5 })],
  ['shape', 'a series that is a string', goodWith({ series: String(NOW) })],
  ['shape', 'a mark that is a number', goodWith({ connectedBefore: 1 })],
  ['shape', 'no usedBefore', goodWith({ usedBefore: undefined })],
  ['shape', 'no days', goodWith({ days: undefined })],
  ['shape', 'days that are a list', goodWith({ days: [] })],
]

describe("the devices' dial-usage.json", () => {
  it('one write for many adds, DIAL_USAGE_WRITE_MS after the first', () => {
    const file = aFile()
    const { usage } = open(file)
    usage.add('dial_voice_delivered')
    vi.advanceTimersByTime(2_000)
    usage.add('dial_voice_delivered')
    usage.add('dial_open_ok')
    vi.advanceTimersByTime(DIAL_USAGE_WRITE_MS - 2_001)
    expect(existsSync(file)).toBe(false)
    vi.advanceTimersByTime(1)
    expect(writesTo(file)).toBe(1)
    expect(saved(file).days).toEqual({ [TODAY]: { dial_voice_delivered: 2, dial_open_ok: 1 } })
    usage.add('dial_open_ok')
    vi.advanceTimersByTime(DIAL_USAGE_WRITE_MS - 1)
    expect(writesTo(file)).toBe(1)
    vi.advanceTimersByTime(1)
    expect(writesTo(file)).toBe(2)
    expect(saved(file).days).toEqual({ [TODAY]: { dial_voice_delivered: 2, dial_open_ok: 2 } })
  })

  it('a flag stays 1; a count stops at DIAL_USAGE_MAX_COUNT', () => {
    const file = aFile()
    const { usage } = open(file)
    usage.add('dial_used_installation_days')
    usage.add('dial_used_installation_days', 3)
    usage.add('dial_voice_delivered', DIAL_USAGE_MAX_COUNT - 1)
    usage.add('dial_voice_delivered', 5)
    flush()
    expect(saved(file).days).toEqual({
      [TODAY]: { dial_used_installation_days: 1, dial_voice_delivered: DIAL_USAGE_MAX_COUNT },
    })
    // Nothing changes, so nothing waits to be written: a use counted at every turn of the dial costs no write.
    usage.add('dial_used_installation_days')
    usage.add('dial_voice_delivered')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('counts nothing signed out, and firstEver stays unspent', () => {
    const file = aFile()
    let signedIn = false
    const { usage } = open(file, { signedIn: () => signedIn })
    usage.add('dial_connected_installation_days')
    expect(usage.firstEver('connected')).toBe(false)
    expect(usage.firstEver('used')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    flush()
    expect(existsSync(file)).toBe(false)
    signedIn = true
    expect(usage.firstEver('connected')).toBe(true)
    expect(usage.firstEver('used')).toBe(true)
  })

  it('unreached says what firstEver would, and spends nothing', () => {
    let signedIn = false
    const { usage } = open(aFile(), { signedIn: () => signedIn })
    expect(usage.unreached('connected')).toBe(false)
    signedIn = true
    expect(usage.unreached('connected')).toBe(true)
    expect(usage.unreached('connected')).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(usage.firstEver('connected')).toBe(true)
    expect(usage.unreached('connected')).toBe(false)
    expect(usage.unreached('used')).toBe(true)
  })

  it('firstEver is true once, and stays false after a reload', () => {
    const file = aFile()
    const first = open(file)
    expect(first.usage.firstEver('connected')).toBe(true)
    expect(first.usage.firstEver('connected')).toBe(false)
    expect(first.usage.firstEver('used')).toBe(true)
    expect(first.usage.firstEver('used')).toBe(false)
    first.usage.close()
    const next = open(file)
    expect(next.usage.firstEver('connected')).toBe(false)
    expect(next.usage.firstEver('used')).toBe(false)
    // The marks outlive the days they were spent on.
    vi.setSystemTime(NOW + (DIAL_USAGE_DAYS + 5) * DAY)
    const later = open(file)
    expect(later.usage.firstEver('connected')).toBe(false)
    expect(later.usage.firstEver('used')).toBe(false)
  })

  it('keeps 35 UTC days and the newest under the cap', () => {
    const file = aFile()
    const { usage } = open(file)
    for (let n = 0; n < DIAL_USAGE_DAYS + 2; n++) {
      vi.setSystemTime(NOW + n * DAY)
      usage.add('dial_used_installation_days')
      flush()
    }
    expect(Object.keys(saved(file).days).sort())
      .toEqual(Array.from({ length: DIAL_USAGE_DAYS }, (_, n) => dayOf(NOW + (n + 2) * DAY)))

    // Every name every day is more than the cap holds: the oldest days are left out, only as many as needed.
    const capped = aFile()
    const full = open(capped)
    for (let n = 0; n < DIAL_USAGE_DAYS; n++) {
      vi.setSystemTime(NOW + n * DAY)
      for (const metric of DIAL_FILE_METRICS) full.usage.add(metric)
      flush()
    }
    const text = readFileSync(capped, 'utf8')
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(DIAL_USAGE_FILE_MAX_BYTES)
    const { days, ...head } = JSON.parse(text) as Saved
    const kept = Object.keys(days).sort()
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(DIAL_USAGE_DAYS)
    const first = DIAL_USAGE_DAYS - kept.length
    expect(kept).toEqual(Array.from({ length: kept.length }, (_, n) => dayOf(NOW + (first + n) * DAY)))
    const older = { [dayOf(NOW + (first - 1) * DAY)]: days[kept[0]], ...days }
    expect(Buffer.byteLength(`${JSON.stringify({ ...head, days: older })}\n`)).toBeGreaterThan(DIAL_USAGE_FILE_MAX_BYTES)
  })

  it('reads itself back: series, counts, marks', () => {
    const file = aFile()
    const first = open(file)
    expect(first.usage.firstEver('connected')).toBe(true)
    first.usage.add('dial_connected_installation_days')
    first.usage.add('dial_voice_delivered', 2)
    first.usage.close()
    const written = saved(file)
    expect(written).toEqual({
      version: DIAL_USAGE_FILE_VERSION, series: NOW, connectedBefore: true, usedBefore: false,
      days: { [TODAY]: { dial_connected_installation_days: 1, dial_voice_delivered: 2 } },
    })

    vi.advanceTimersByTime(60_000)
    // A file read back keeps its own marks: hadDial is for a new one only.
    const hadDial = vi.fn(() => true)
    const next = open(file, { hadDial })
    next.usage.add('dial_voice_delivered')
    next.usage.add('dial_connected_installation_days')
    expect(next.usage.firstEver('connected')).toBe(false)
    expect(next.usage.firstEver('used')).toBe(true)
    next.usage.close()
    expect(hadDial).not.toHaveBeenCalled()
    expect(next.logs).toEqual([])
    expect(saved(file)).toEqual({
      ...written, usedBefore: true,
      days: { [TODAY]: { dial_connected_installation_days: 1, dial_voice_delivered: 3 } },
    })
  })

  it('a new file takes its marks from hadDial', () => {
    const had = aFile()
    const before = open(had, { hadDial: () => true })
    expect(before.usage.firstEver('connected')).toBe(false)
    expect(before.usage.firstEver('used')).toBe(false)
    before.usage.add('dial_connected_installation_days')
    before.usage.close()
    expect(saved(had)).toEqual({
      version: DIAL_USAGE_FILE_VERSION, series: NOW, connectedBefore: true, usedBefore: true,
      days: { [TODAY]: { dial_connected_installation_days: 1 } },
    })

    const fresh = open(aFile(), { hadDial: () => false })
    expect(fresh.usage.firstEver('connected')).toBe(true)
    expect(fresh.usage.firstEver('used')).toBe(true)
  })

  it.each(WHOLE)('drops another shape whole with one word: %s (%s)', (word, _what, text) => {
    const file = aFile()
    writeFileSync(file, text)
    const { usage, logs } = open(file)
    expect(logs).toEqual([`[device] usage · dropped · ${word}`])
    usage.add('dial_open_ok')
    usage.close()
    // A new series, its marks from hadDial, its counts from nothing.
    expect(saved(file)).toEqual({
      version: DIAL_USAGE_FILE_VERSION, series: NOW, connectedBefore: false, usedBefore: false,
      days: { [TODAY]: { dial_open_ok: 1 } },
    })
  })

  it('reads a file at the cap', () => {
    const file = aFile()
    writeFileSync(file, JSON.stringify(GOOD).padEnd(DIAL_USAGE_FILE_MAX_BYTES, ' '))
    const { usage, logs } = open(file)
    usage.add('dial_open_ok')
    usage.close()
    expect(logs).toEqual([])
    expect(saved(file)).toEqual({ ...GOOD, days: { [TODAY]: { dial_open_ok: 3 } } })
  })

  it('drops bad names or values one by one', () => {
    const file = aFile()
    const yesterday = dayOf(NOW - DAY)
    const oldest = dayOf(NOW - (DIAL_USAGE_DAYS - 1) * DAY)
    writeFileSync(file, JSON.stringify({
      ...GOOD, usedBefore: false, extra: 'another build',
      days: {
        [TODAY]: {
          dial_open_ok: 3, dial_voice_delivered: DIAL_USAGE_MAX_COUNT, dial_used_installation_days: 1,
          dial_bogus: 1, ['__proto__']: 1, ui_desktop_opens: 1,
          // The gateway's, never the file's.
          dial_connected_outside_app_installation_days: 1,
          dial_voice_failed_no_turn: 1.5, dial_voice_cancelled: -1, dial_voice_held: 0,
          dial_open_failed: DIAL_USAGE_MAX_COUNT + 1, dial_open_host_orca_ok: '3', dial_open_host_orca_failed: null,
          // A flag is one computer: 2 is no count this build writes.
          dial_connected_installation_days: 2,
        },
        [oldest]: { dial_open_ok: 1 },
        [yesterday]: { dial_bogus: 1 },
        [dayOf(NOW - DIAL_USAGE_DAYS * DAY)]: { dial_open_ok: 1 },
        [dayOf(NOW + DAY)]: { dial_open_ok: 1 },
        '2026-11-31': { dial_open_ok: 1 },
        '2026-12-9': { dial_open_ok: 1 },
        yesterday: { dial_open_ok: 1 },
        [dayOf(NOW - 2 * DAY)]: 7,
        [dayOf(NOW - 3 * DAY)]: [1],
      },
    }))
    const { usage, logs } = open(file)
    expect(usage.firstEver('connected')).toBe(false)
    usage.add('dial_open_ok')
    usage.close()
    expect(logs).toEqual([])
    expect(saved(file)).toStrictEqual({
      version: DIAL_USAGE_FILE_VERSION, series: NOW - DAY, connectedBefore: true, usedBefore: false,
      days: {
        [TODAY]: { dial_open_ok: 4, dial_voice_delivered: DIAL_USAGE_MAX_COUNT, dial_used_installation_days: 1 },
        [oldest]: { dial_open_ok: 1 },
      },
    })
  })

  // Nothing was read to judge (a folder there, EACCES, EMFILE, a Windows scanner's EBUSY): it may hold days the gateway
  // has not sent yet.
  it('never writes over an unreadable file', () => {
    const file = aFile()
    mkdirSync(file)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { usage, logs } = open(file)
    expect(warn).toHaveBeenCalledWith(`[state] ${DIAL_USAGE_FILE} could not be read (EISDIR); left as it is, read again next time.`)
    usage.add('dial_open_ok')
    flush()
    usage.add('dial_voice_delivered')
    usage.close()
    expect(logs).toEqual([])
    expect(writesTo(file)).toBe(0)
    expect(readdirSync(dirname(file))).toEqual([DIAL_USAGE_FILE])
  })

  // One read that failed (EMFILE, a scanner's EBUSY) must not mute the whole run.
  it('a file unreadable at the start is read again at the next write, what this run counted added to it', () => {
    const file = aFile()
    mkdirSync(file)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { usage, logs } = open(file)
    // Its marks are not known until it is read: no first is spent on a guess.
    expect(usage.firstEver('used')).toBe(false)
    usage.add('dial_open_ok')
    usage.add('dial_used_installation_days')
    rmSync(file, { recursive: true })
    const before = { ...GOOD, usedBefore: false, days: { [TODAY]: { dial_open_ok: 2, dial_used_installation_days: 1 } } }
    writeFileSync(file, JSON.stringify(before))
    flush()
    expect(saved(file)).toEqual({ ...before, days: { [TODAY]: { dial_open_ok: 3, dial_used_installation_days: 1 } } })
    expect(usage.firstEver('used')).toBe(true)
    expect(logs).toEqual([])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('never writes over a file this account cannot read', () => {
    const file = aFile()
    writeFileSync(file, JSON.stringify(GOOD), { mode: 0o600 })
    const before = readFileSync(file, 'utf8')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    chmodSync(file, 0o000)
    const { usage } = open(file)
    usage.add('dial_open_ok')
    flush()
    usage.close()
    chmodSync(file, 0o600)
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('close writes what waits, then nothing', () => {
    const file = aFile()
    const { usage } = open(file)
    usage.add('dial_open_ok')
    usage.close()
    expect(vi.getTimerCount()).toBe(0)
    const written = readFileSync(file, 'utf8')
    expect(JSON.parse(written).days).toEqual({ [TODAY]: { dial_open_ok: 1 } })
    // The stop's own endings (its detach) change nothing, and a first use spent now would never be saved.
    usage.add('dial_open_ok')
    expect(usage.firstEver('used')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    flush()
    expect(readFileSync(file, 'utf8')).toBe(written)
    expect(writesTo(file)).toBe(1)

    const idle = aFile()
    open(idle).usage.close()
    expect(existsSync(idle)).toBe(false)
  })

  it('a failed write says its kind only, and the next change tries again', () => {
    const file = aFile()
    const { usage, logs } = open(file)
    mkdirSync(file)
    usage.add('dial_open_ok')
    flush()
    expect(logs).toEqual(['[device] usage · not saved · EISDIR'])
    rmSync(file, { recursive: true })
    usage.add('dial_voice_delivered')
    flush()
    expect(saved(file).days).toEqual({ [TODAY]: { dial_open_ok: 1, dial_voice_delivered: 1 } })
  })

  it('a stop after a failed write writes what it holds', () => {
    const file = aFile()
    const { usage } = open(file)
    mkdirSync(file)
    usage.add('dial_open_ok')
    flush()
    rmSync(file, { recursive: true })
    usage.close()
    expect(saved(file).days).toEqual({ [TODAY]: { dial_open_ok: 1 } })
  })

  it('holds fixed names and numbers only', () => {
    const file = aFile()
    writeFileSync(file, JSON.stringify({
      ...GOOD, machine: 'Mac mini', days: { [TODAY]: { dial_open_ok: 1, 'Mac mini': 1, dial_engine_claude_agents: 'api' } },
    }))
    const { usage } = open(file)
    for (const metric of DIAL_FILE_METRICS) usage.add(metric)
    usage.close()
    const written = saved(file)
    expect(Object.keys(written)).toEqual(['version', 'series', 'connectedBefore', 'usedBefore', 'days'])
    for (const counts of Object.values(written.days)) {
      for (const [metric, n] of Object.entries(counts)) {
        expect(DIAL_FILE_METRICS).toContain(metric)
        expect(typeof n).toBe('number')
      }
    }
  })

  it('no line holds the path or what a file says', () => {
    expect(said.length).toBeGreaterThan(0)
    for (const line of said) {
      for (const folder of folders) expect(line).not.toContain(folder)
      expect(line).not.toContain('another build')
      expect(line).not.toContain('Mac mini')
    }
  })
})
