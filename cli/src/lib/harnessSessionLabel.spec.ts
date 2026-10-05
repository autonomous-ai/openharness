import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { harnessPaneOwner, ownedHere } from './harnessSessionLabel.js'

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

  it('lets a daemon see its own panes and untagged ones, never another daemon\'s', () => {
    expect(ownedHere('aaaa', 'aaaa')).toBe(true)
    // Created by a build from before the tag: anyone's, as every pane used to be.
    expect(ownedHere('', 'aaaa')).toBe(true)
    expect(ownedHere('bbbb', 'aaaa')).toBe(false)
  })
})
