import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findTuiBinary, opensClient, platformKey } from './index.js'

describe('harness tui launcher', () => {
  afterEach(() => { delete process.env.HARNESS_TUI_BIN })

  it('names the build for each platform a release publishes', () => {
    expect(platformKey('darwin', 'arm64')).toBe('darwin-arm64')
    expect(platformKey('darwin', 'x64')).toBe('darwin-x64')
    expect(platformKey('linux', 'x64')).toBe('linux-x64')
    expect(platformKey('linux', 'arm64')).toBe('linux-arm64')
    expect(platformKey('win32', 'x64')).toBeNull()
    expect(platformKey('linux', 'ia32')).toBeNull()
  })

  it('prefers HARNESS_TUI_BIN when it exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tui-bin-'))
    const bin = join(dir, 'harness-tui')
    writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 })
    process.env.HARNESS_TUI_BIN = bin
    expect(findTuiBinary()).toBe(bin)
  })

  it('signs in and starts the daemon only to open hn, not for a command to the hn already open', () => {
    expect(opensClient([])).toBe(true)
    expect(opensClient(['-L', 'work'])).toBe(true)
    expect(opensClient(['-Lwork', '-f', '/dev/null'])).toBe(true)
    expect(opensClient(['--port', '18999'])).toBe(true)
    expect(opensClient(['list-panes'])).toBe(false)
    expect(opensClient(['-L', 'work', 'send-keys', '-t', '1', 'ls', 'Enter'])).toBe(false)
    expect(opensClient(['-S', '/tmp/s', 'display', '-p', '#{pane_id}'])).toBe(false)
    expect(opensClient(['--', 'ls'])).toBe(false)
    for (const info of [['--help'], ['-h'], ['-V'], ['--version'], ['--keys'], ['--licenses']]) expect(opensClient(info)).toBe(false)
  })

  it('ignores a HARNESS_TUI_BIN that is not there', () => {
    process.env.HARNESS_TUI_BIN = '/nonexistent/harness-tui'
    expect(findTuiBinary()).not.toBe('/nonexistent/harness-tui')
  })
})
