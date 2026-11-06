import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { accountKey, claudeReportPath, readClaudeReport } from './quotaReports.js'

let dataDir: string
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'quota-reports-')) })
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

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

describe('claudeReportPath', () => {
  it('names one file per Claude config folder, by the first 16 hex of its sha256', () => {
    const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)
    expect(claudeReportPath('/data', '/Users/me/.claude-work')).toBe(join('/data', 'quota', `claude-${hash('/Users/me/.claude-work')}.json`))
    // Unset and empty are both the default folder.
    expect(claudeReportPath('/data')).toBe(join('/data', 'quota', `claude-${hash('')}.json`))
    expect(claudeReportPath('/data', '')).toBe(claudeReportPath('/data'))
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

  it('is null with no report yet', () => {
    expect(readClaudeReport(dataDir)).toBeNull()
    expect(readClaudeReport(dataDir, '/fixture/never')).toBeNull()
  })

  it('keeps a report that has only one window', () => {
    write({ v: 1, at: 5, seven_day: { used_percentage: 0, resets_at: 9 } })
    expect(readClaudeReport(dataDir)).toEqual({ at: 5, seven_day: { used_percentage: 0, resets_at: 9 } })
  })

  it('drops a window that is not a measured percentage, and the report when no window is left', () => {
    write({ ...report, five_hour: { used_percentage: 101, resets_at: 1 } })
    expect(readClaudeReport(dataDir)).toEqual({ at: report.at, seven_day: report.seven_day })
    for (const window of [{ used_percentage: -1, resets_at: 1 }, { used_percentage: Number.NaN }, { used_percentage: '5', resets_at: 1 },
      { used_percentage: 5, resets_at: 'soon' }, { used_percentage: 5, resets_at: Number.POSITIVE_INFINITY }, null, 'full']) {
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
