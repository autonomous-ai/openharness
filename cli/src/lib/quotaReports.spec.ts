import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { accountKey, claudeReportKey, claudeReportPath, readClaudeReport } from './quotaReports.js'

let dataDir: string
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'quota-reports-')) })
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)

const write = (report: unknown, configDir?: string) => {
  mkdirSync(join(dataDir, 'quota'), { recursive: true })
  writeFileSync(claudeReportPath(dataDir, configDir), typeof report === 'string' ? report : JSON.stringify(report))
}

describe('accountKey', () => {
  it('matches the vector the desktop pins', () => {
    // ⚠️ A cross-language contract: desktop/test/usage_account_key_test.dart asserts these same two strings. If they
    // drift, every remote reading looks like a different account and the strip shows the same subscription twice.
    expect(accountKey('claude', 'acct-123')).toBe('85d2541574c31caa')
    expect(accountKey('codex', 'acct-123')).toBe('d9921dd1861038f4')
  })

  it('keeps the same id on two vendors apart', () => {
    expect(accountKey('claude', 'same')).not.toBe(accountKey('codex', 'same'))
  })
})

// The status line (hook/statusline.mjs) keys the file it writes by the same rule, from the CLAUDE_CONFIG_DIR of the
// person's own shell; the daemon reads it with whatever spelling its launch environment holds (#4252).
describe('claudeReportKey', () => {
  it('is the empty string for the default folder however it is written', () => {
    const home = join(dataDir, 'home')
    mkdirSync(join(home, '.claude'), { recursive: true })
    for (const dir of [undefined, '', '  ', join(home, '.claude'), join(home, '.claude') + sep, `${home}${sep}.${sep}.claude`]) {
      expect(claudeReportKey(dir, home), String(dir)).toBe('')
    }
    expect(claudeReportKey(join(home, '.claude-work'), home)).not.toBe('')
  })

  it('is the real absolute path of a moved folder, whatever its spelling', () => {
    const moved = join(dataDir, 'work')
    mkdirSync(moved)
    const real = realpathSync.native(moved)
    for (const dir of [moved, moved + sep, `${moved}${sep}..${sep}work`, ` ${moved} `]) expect(claudeReportKey(dir), dir).toBe(real)
    if (process.platform !== 'win32') {
      symlinkSync(moved, join(dataDir, 'link'))
      expect(claudeReportKey(join(dataDir, 'link'))).toBe(real)
    }
    // One not made yet is its absolute path.
    expect(claudeReportKey(join(dataDir, 'later') + sep)).toBe(join(dataDir, 'later'))
  })
})

describe('claudeReportPath', () => {
  it('names one file per Claude config folder, by the first 16 hex of the sha256 of its key', () => {
    expect(claudeReportPath('/data', '/Users/me/.claude-work')).toBe(join('/data', 'quota', `claude-${hash(resolve('/Users/me/.claude-work'))}.json`))
    // Unset, empty and the default folder however written are one report.
    expect(claudeReportPath('/data')).toBe(join('/data', 'quota', `claude-${hash('')}.json`))
    for (const dir of ['', join(homedir(), '.claude'), join(homedir(), '.claude') + sep]) expect(claudeReportPath('/data', dir), dir).toBe(claudeReportPath('/data'))
    expect(claudeReportPath('/data', '/Users/me/.claude-work/')).toBe(claudeReportPath('/data', '/Users/me/.claude-work'))
  })
})

describe('readClaudeReport', () => {
  const report = { v: 1, at: 1_762_480_000_000, five_hour: { used_percentage: 23.5, resets_at: 1_762_490_000 }, seven_day: { used_percentage: 41, resets_at: null } }

  it('reads what the status line wrote for that folder', () => {
    write(report)
    write({ ...report, five_hour: { used_percentage: 90, resets_at: 1 } }, '/fixture/work')
    expect(readClaudeReport(dataDir)).toEqual({ at: report.at, five_hour: report.five_hour, seven_day: report.seven_day })
    expect(readClaudeReport(dataDir, '')).toEqual(readClaudeReport(dataDir))
    expect(readClaudeReport(dataDir, '/fixture/work')?.five_hour).toEqual({ used_percentage: 90, resets_at: 1 })
  })

  it('reads a report an older status line wrote under the raw folder name, until one is written under its key', () => {
    const moved = join(dataDir, 'work')
    mkdirSync(moved)
    mkdirSync(join(dataDir, 'quota'), { recursive: true })
    writeFileSync(join(dataDir, 'quota', `claude-${hash(moved + sep)}.json`), JSON.stringify(report))
    expect(readClaudeReport(dataDir, moved + sep)?.five_hour).toEqual(report.five_hour)
    write({ ...report, five_hour: { used_percentage: 50, resets_at: null } }, moved)
    expect(readClaudeReport(dataDir, moved + sep)?.five_hour).toEqual({ used_percentage: 50, resets_at: null })
  })

  it('is null with no report yet', () => {
    expect(readClaudeReport(dataDir)).toBeNull()
    expect(readClaudeReport(dataDir, '/fixture/never')).toBeNull()
  })

  it('keeps a report that has only one window', () => {
    write({ v: 1, at: 5, seven_day: { used_percentage: 0, resets_at: 9 } })
    expect(readClaudeReport(dataDir)).toEqual({ at: 5, seven_day: { used_percentage: 0, resets_at: 9 } })
  })

  // Claude Code reports a window it ran past as more than 100 (finding 10, #4252): that is a used-up window, not a bad one.
  it('reads a percentage above 100 as 100', () => {
    write({ ...report, five_hour: { used_percentage: 103, resets_at: 1 } })
    expect(readClaudeReport(dataDir)?.five_hour).toEqual({ used_percentage: 100, resets_at: 1 })
  })

  it('drops a window that is not a measured percentage, and the report when no window is left', () => {
    write({ ...report, five_hour: { used_percentage: -1, resets_at: 1 } })
    expect(readClaudeReport(dataDir)).toEqual({ at: report.at, seven_day: report.seven_day })
    for (const window of [{ used_percentage: -1, resets_at: 1 }, { used_percentage: Number.NaN }, { used_percentage: '5', resets_at: 1 },
      { used_percentage: 5, resets_at: 'soon' }, null, 'full']) {
      write({ v: 1, at: 1, five_hour: window })
      expect(readClaudeReport(dataDir), JSON.stringify(window)).toBeNull()
    }
  })

  it('ignores anything that is not a version-1 report', () => {
    for (const text of ['{not json', 'null', '[]', '"text"', JSON.stringify({ ...report, v: 2 }), JSON.stringify({ ...report, v: undefined }),
      JSON.stringify({ ...report, at: 'yesterday' }), JSON.stringify({ ...report, at: null })]) {
      write(text)
      expect(readClaudeReport(dataDir), text).toBeNull()
    }
  })

  it('takes only the windows and when they were read, nothing else in the file', () => {
    write({ ...report, email: 'me@example.com', five_hour: { ...report.five_hour, extra: 'x' } })
    expect(readClaudeReport(dataDir)).toEqual({ at: report.at, five_hour: report.five_hour, seven_day: report.seven_day })
  })
})
