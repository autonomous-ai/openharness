import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { harnessPaneOwner, ownedHere, ownerCommand, paneOwnerFormat, paneOwnerOf } from './harnessSessionLabel.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('which daemon a pane belongs to', () => {
  it('is one tag per data folder: the same for one daemon every time, another for a daemon beside it', () => {
    const root = mkdtempSync(join(tmpdir(), 'pane-owner-'))
    dirs.push(root)
    const release = join(root, 'release')
    const dev = join(root, 'dev')
    mkdirSync(release)
    mkdirSync(dev)
    expect(harnessPaneOwner(release)).toMatch(/^[0-9a-f]{16}$/)
    expect(harnessPaneOwner(release)).toBe(harnessPaneOwner(`${release}/`))
    expect(harnessPaneOwner(dev)).not.toBe(harnessPaneOwner(release))
  })

  it('is the same before the data folder exists as after, and through a symlink to it', () => {
    // A first start computes it before anything creates the folder; macOS's temporary folders sit
    // behind a symlink (`/var` is `/private/var`). A tag that changed between the two would hide a
    // daemon's own panes from it after its first restart.
    const root = mkdtempSync(join(tmpdir(), 'pane-owner-'))
    dirs.push(root)
    const data = join(root, 'later', 'data')
    const before = harnessPaneOwner(data)
    mkdirSync(data, { recursive: true })
    expect(harnessPaneOwner(data)).toBe(before)
    const link = join(root, 'link')
    symlinkSync(join(root, 'later'), link)
    expect(harnessPaneOwner(join(link, 'data'))).toBe(before)
    expect(harnessPaneOwner(join(link, 'data', 'not-yet'))).toBe(harnessPaneOwner(join(data, 'not-yet')))
  })

  it('lets a daemon see the panes it tagged wherever they moved, untagged ones only in its sessions, never another daemon\'s', () => {
    expect(ownedHere('aaaa', 'harness-claude-1', 'aaaa')).toBe(true)
    // The person renamed its session, or joined the pane into a window of their own: still its pane.
    expect(ownedHere('aaaa', 'my-claude-work', 'aaaa')).toBe(true)
    // Created by a build from before the tag: in a session Harness named, as every pane used to be; never
    // in a session the person opened by hand (autonomous-harness-desktop#6).
    expect(ownedHere('', 'harness-codex-2', 'aaaa')).toBe(true)
    expect(ownedHere('', 'my-shell', 'aaaa')).toBe(false)
    // Another daemon's, in whatever session.
    expect(ownedHere('bbbb', 'harness-claude-1', 'aaaa')).toBe(false)
    expect(ownedHere('bbbb', 'my-claude-work', 'aaaa')).toBe(false)
  })
})

// tmux before 3.0 (Debian 10's 2.8, RHEL 8's 2.7) has no pane options, and a window option stays behind
// with its window when the person moves the pane. The pane's start command goes with it.
describe('the tag on a tmux before 3.0', () => {
  it('rides the start command through env, which execs the real command at once', () => {
    expect(ownerCommand('0123456789abcdef', ['/bin/zsh', '-lic', 'exec "$@"', 'claude']))
      .toEqual(['/usr/bin/env', 'HARNESS_DAEMON=0123456789abcdef', '/bin/zsh', '-lic', 'exec "$@"', 'claude'])
  })

  it('is read from the pane option where there is one, and from the start command then the window before', () => {
    expect(paneOwnerFormat(true)).toBe('#{@harness_daemon}')
    // tmux 2.x cannot cut a substring out of a format: the start command comes back cut to the prefix
    // and a tag's length, never whole (it can hold the `|` and newlines a listing is split on).
    expect(paneOwnerFormat(false))
      .toBe('#{?#{m:/usr/bin/env HARNESS_DAEMON=*,#{pane_start_command}},#{=44:pane_start_command},#{@harness_daemon}}')
  })

  it('takes the tag out of a start command, and any other field as the tag itself', () => {
    expect(paneOwnerOf('/usr/bin/env HARNESS_DAEMON=0123456789abcdef')).toBe('0123456789abcdef')
    // The window's tag, a pane option, or nobody's.
    expect(paneOwnerOf('0123456789abcdef')).toBe('0123456789abcdef')
    expect(paneOwnerOf('')).toBe('')
  })
})
