import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TMUX_SESSION_ENV_MIN, parseTmuxVersion, resetTmuxVersionCache, supportsSessionEnv, tmuxFeaturesOf, tmuxVersion,
} from './tmuxVersion.js'

// The fake tmux below is a /bin/sh script; whether its answer is kept, not how fast it came, is what is
// tested (testing/patientExecWithoutDeadline.ts).
vi.mock('./patientExec.js', async (importOriginal) =>
  (await import('../testing/patientExecWithoutDeadline.js')).withoutDeadline(await importOriginal()))

describe('parseTmuxVersion', () => {
  it('reads the shapes tmux -V actually prints', () => {
    expect(parseTmuxVersion('tmux 3.5a\n')).toEqual({ major: 3, minor: 5 })
    expect(parseTmuxVersion('tmux 3.2\n')).toEqual({ major: 3, minor: 2 })
    expect(parseTmuxVersion('tmux next-3.6\n')).toEqual({ major: 3, minor: 6 })
    expect(parseTmuxVersion('tmux openbsd-7.4\n')).toEqual({ major: 7, minor: 4 })
  })

  it('has no answer for a build that prints no number', () => {
    expect(parseTmuxVersion('tmux master\n')).toBeNull()
    expect(parseTmuxVersion('')).toBeNull()
  })
})

describe('supportsSessionEnv', () => {
  it('draws the line at the release that added new-session -e', () => {
    expect(TMUX_SESSION_ENV_MIN).toEqual({ major: 3, minor: 2 })
    expect(supportsSessionEnv({ major: 3, minor: 1 })).toBe(false)
    expect(supportsSessionEnv({ major: 2, minor: 9 })).toBe(false)
    expect(supportsSessionEnv({ major: 3, minor: 2 })).toBe(true)
    expect(supportsSessionEnv({ major: 3, minor: 10 })).toBe(true)
    expect(supportsSessionEnv({ major: 4, minor: 0 })).toBe(true)
  })

  it('treats an unreadable version as capable, so a working tmux is never refused on a guess', () => {
    expect(supportsSessionEnv(null)).toBe(true)
  })
})

describe('tmuxFeaturesOf', () => {
  it('answers each feature by the release that brought it', () => {
    const none = {
      resizeWindow: false, paneOptions: false, sendKeysHex: false, respawnEnv: false,
      captureTrailingSpaces: false, clientFlags: false, sessionEnv: false, controlNotifyGuard: false,
    }
    // RHEL and Rocky 8 ship 2.7, Debian 10 ships 2.8.
    expect(tmuxFeaturesOf({ major: 2, minor: 7 })).toEqual(none)
    expect(tmuxFeaturesOf({ major: 2, minor: 8 })).toEqual(none)
    expect(tmuxFeaturesOf({ major: 2, minor: 9 })).toEqual({ ...none, resizeWindow: true })
    // Ubuntu 20.04 ships 3.0a: pane options, but no client flags or session environment yet.
    const three = { ...none, resizeWindow: true, paneOptions: true, sendKeysHex: true, respawnEnv: true }
    expect(tmuxFeaturesOf({ major: 3, minor: 0 })).toEqual(three)
    expect(tmuxFeaturesOf({ major: 3, minor: 1 })).toEqual({ ...three, captureTrailingSpaces: true })
    const threeTwo = { ...three, captureTrailingSpaces: true, clientFlags: true, sessionEnv: true }
    expect(tmuxFeaturesOf({ major: 3, minor: 2 })).toEqual(threeTwo)
    // Ubuntu 24.04 ships 3.4, Fedora 3.5a: a notification can still reach a control client mid-attach.
    expect(tmuxFeaturesOf({ major: 3, minor: 6 })).toEqual(threeTwo)
    const all = { ...threeTwo, controlNotifyGuard: true }
    expect(tmuxFeaturesOf({ major: 3, minor: 7 })).toEqual(all)
    expect(tmuxFeaturesOf({ major: 4, minor: 0 })).toEqual(all)
    // A build that prints no number is newer than every release.
    expect(tmuxFeaturesOf(null)).toEqual(all)
  })
})

describe('tmuxVersion', () => {
  const originalPath = process.env.PATH
  let dir = ''
  afterEach(() => {
    resetTmuxVersionCache()
    process.env.PATH = originalPath
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })
  /** A tmux on PATH that counts its calls and answers `tmux 2.8`, or fails while [refuse] exists. */
  function fakeTmux() {
    dir = mkdtempSync(join(tmpdir(), 'tmux-version-'))
    const calls = join(dir, 'calls')
    const refuse = join(dir, 'refuse')
    writeFileSync(join(dir, 'tmux'), `#!/bin/sh\necho -V >> '${calls}'\n[ -f '${refuse}' ] && exit 1\necho 'tmux 2.8'\n`, { mode: 0o755 })
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`
    return { calls: () => readFileSync(calls, 'utf8').trim().split('\n').length, refuse }
  }

  it('asks tmux once, and keeps its answer', async () => {
    const tmux = fakeTmux()
    resetTmuxVersionCache()
    expect(await tmuxVersion()).toEqual({ major: 2, minor: 8 })
    expect(await tmuxVersion()).toEqual({ major: 2, minor: 8 })
    expect(tmux.calls()).toBe(1)
  })

  it('asks again after a tmux that could not be asked, rather than taking it for the newest for good', async () => {
    const tmux = fakeTmux()
    writeFileSync(tmux.refuse, '')
    resetTmuxVersionCache()
    expect(await tmuxVersion()).toBeNull()
    rmSync(tmux.refuse)
    expect(await tmuxVersion()).toEqual({ major: 2, minor: 8 })
    expect(await tmuxVersion()).toEqual({ major: 2, minor: 8 })
    expect(tmux.calls()).toBe(2)
  })
})
