import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readPointer } from './installLayout.js'
import { PTY_PAYLOAD_FILES, PtyPayloadRefused, type PreparedPty } from './ptyPayload.js'
import {
  confirmPty, installPreparedPty, rejectedPtyVersions, restorePty, sweepAsideFiles, type PtyInstallFs,
} from './ptyInstall.js'

let root: string
let ptyRoot: string
let bin: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pty-install-'))
  ptyRoot = join(root, 'runtime', 'pty')
  bin = join(root, 'bin')
  // The machine as install.ps1 leaves it: 0.10.0 in use, its two bin files copied out of its folder.
  mkdirSync(join(ptyRoot, '0.10.0'), { recursive: true })
  for (const name of PTY_PAYLOAD_FILES) writeFileSync(join(ptyRoot, '0.10.0', name), `old ${name}`)
  writeFileSync(join(ptyRoot, 'current-pty'), '0.10.0\r\n')
  mkdirSync(bin)
  for (const name of ['harness.exe', 'harness-launch.exe']) writeFileSync(join(bin, name), `old ${name}`)
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

/** A staging folder as preparePtyPayload leaves it, holding [prefix] in front of each file name. */
function staged(prefix = 'new'): PreparedPty {
  const staging = join(ptyRoot, `.staging-1-${Math.random().toString(36).slice(2)}`)
  mkdirSync(staging)
  for (const name of PTY_PAYLOAD_FILES) writeFileSync(join(staging, name), `${prefix} ${name}`)
  return { version: '0.11.0', staging, protocol: 2, features: ['seed'] }
}

/** Every file under bin\ with its bytes, the marker, the pointer and the pty folder's entries. */
function snapshot() {
  return {
    bin: Object.fromEntries(readdirSync(bin).sort().map((n) => [n, readFileSync(join(bin, n), 'utf8')])),
    marker: existsSync(join(ptyRoot, 'pty-pending.json')),
    pointer: readFileSync(join(ptyRoot, 'current-pty'), 'utf8'),
    pty: readdirSync(ptyRoot).sort(),
  }
}

const sleepNever = () => {}
const realFs: PtyInstallFs = { rename: renameSync, link: linkSync, copyFile: copyFileSync, writeFile: writeFileSync, rm: rmSync, sleep: sleepNever }

/** The real calls, except that the [failAt]th rename, link, copy or write throws. Zero never fails; [calls] counts them. */
function faulty(failAt: number, base: PtyInstallFs = realFs) {
  let calls = 0
  const step = () => {
    if (++calls === failAt) throw Object.assign(new Error(`injected failure at call ${failAt}`), { code: 'EIO' })
  }
  const fs: PtyInstallFs = {
    ...base,
    rename: (a, b) => { step(); base.rename(a, b) },
    link: (a, b) => { step(); base.link(a, b) },
    copyFile: (a, b) => { step(); base.copyFile(a, b) },
    writeFile: (p, d) => { step(); base.writeFile(p, d) },
  }
  return { fs, calls: () => calls }
}

/** As Windows behaves while the old bin file runs: a new file cannot be renamed over it, though it can be renamed. */
const runningOldFiles: PtyInstallFs = {
  ...realFs,
  rename: (a, b) => {
    if (basename(a).includes('.new-') && existsSync(b)) throw Object.assign(new Error('in use'), { code: 'EPERM' })
    renameSync(a, b)
  },
}

/** The calls a successful install makes, in order. */
const STEPS = [
  'rename the staging folder to the version folder',
  'copy harness.exe to its temporary name',
  'link the old harness.exe aside',
  'rename the new harness.exe over it',
  'copy harness-launch.exe to its temporary name',
  'link the old harness-launch.exe aside',
  'rename the new harness-launch.exe over it',
  'write the marker to its temporary name',
  'rename the marker into place',
  'rename current-pty into place',
]

describe('installPreparedPty', () => {
  it('installs: folder, bin files, marker, pointer', () => {
    const prepared = staged()
    installPreparedPty(prepared, root, realFs)
    expect(existsSync(prepared.staging)).toBe(false)
    for (const name of PTY_PAYLOAD_FILES) expect(readFileSync(join(ptyRoot, '0.11.0', name), 'utf8')).toBe(`new ${name}`)
    expect(readFileSync(join(bin, 'harness.exe'), 'utf8')).toBe('new harness.exe')
    expect(readFileSync(join(bin, 'harness-launch.exe'), 'utf8')).toBe('new harness-launch.exe')
    const aside = readdirSync(bin).filter((n) => n !== 'harness.exe' && n !== 'harness-launch.exe').sort()
    expect(aside).toHaveLength(2)
    expect(aside[0]).toMatch(new RegExp(`^harness-launch\\.exe\\.old-${process.pid}-\\d+$`))
    expect(aside[1]).toMatch(new RegExp(`^harness\\.exe\\.old-${process.pid}-\\d+$`))
    expect(JSON.parse(readFileSync(join(ptyRoot, 'pty-pending.json'), 'utf8'))).toEqual({ version: '0.11.0', previous: '0.10.0' })
    expect(readPointer(ptyRoot, 'current-pty')).toBe('0.11.0')
    // No temporary file is left behind.
    expect(readdirSync(ptyRoot).sort()).toEqual(['0.10.0', '0.11.0', 'current-pty', 'pty-pending.json'])
  })

  it('puts a bin file in even when there was none before', () => {
    rmSync(join(bin, 'harness.exe'))
    installPreparedPty(staged(), root, realFs)
    expect(readFileSync(join(bin, 'harness.exe'), 'utf8')).toBe('new harness.exe')
  })

  it('makes exactly the calls the failure cases below cover', () => {
    const counter = faulty(0)
    installPreparedPty(staged(), root, counter.fs)
    expect(counter.calls()).toBe(STEPS.length)
  })

  describe('a failure at each step leaves the bin files, the marker and the pointer as they were', () => {
    it.each(STEPS.map((name, i) => [i + 1, name] as const))('call %i: %s', (failAt) => {
      const before = snapshot()
      const prepared = staged()
      expect(() => installPreparedPty(prepared, root, faulty(failAt).fs)).toThrow(PtyPayloadRefused)
      expect(snapshot()).toEqual(before)
      expect(existsSync(prepared.staging)).toBe(false)
    })
  })

  describe('while the old bin files run, Windows-style', () => {
    /** Each bin file now takes copy, link, a refused rename over it, a rename aside and a rename in. */
    const FALLBACK_STEPS = [
      'rename the staging folder to the version folder',
      'copy harness.exe', 'link harness.exe aside', 'rename over harness.exe (refused)', 'rename harness.exe aside', 'rename harness.exe in',
      'copy harness-launch.exe', 'link harness-launch.exe aside', 'rename over harness-launch.exe (refused)',
      'rename harness-launch.exe aside', 'rename harness-launch.exe in',
      'write the marker', 'rename the marker', 'rename current-pty',
    ]

    it('renames the old files aside instead, and the install completes', () => {
      const counter = faulty(0, runningOldFiles)
      installPreparedPty(staged(), root, counter.fs)
      expect(counter.calls()).toBe(FALLBACK_STEPS.length)
      expect(readFileSync(join(bin, 'harness.exe'), 'utf8')).toBe('new harness.exe')
      expect(readFileSync(join(bin, 'harness-launch.exe'), 'utf8')).toBe('new harness-launch.exe')
      expect(readPointer(ptyRoot, 'current-pty')).toBe('0.11.0')
      // The extra links went; one aside file per bin file holds the old bytes.
      const aside = readdirSync(bin).filter((n) => n.includes('.old-')).map((n) => readFileSync(join(bin, n), 'utf8')).sort()
      expect(aside).toEqual(['old harness-launch.exe', 'old harness.exe'])
    })

    it.each(FALLBACK_STEPS.map((name, i) => [i + 1, name] as const).filter(([, name]) => !name.endsWith('(refused)')))(
      'a failure at call %i (%s) is undone', (failAt) => {
        const before = snapshot()
        expect(() => installPreparedPty(staged(), root, faulty(failAt, runningOldFiles).fs)).toThrow(PtyPayloadRefused)
        expect(snapshot()).toEqual(before)
      },
    )

    it('restorePty puts the old files back the same way', () => {
      installPreparedPty(staged(), root, runningOldFiles)
      expect(restorePty(root, runningOldFiles)).toBe(true)
      expect(readFileSync(join(bin, 'harness.exe'), 'utf8')).toBe('old harness.exe')
      expect(readFileSync(join(bin, 'harness-launch.exe'), 'utf8')).toBe('old harness-launch.exe')
    })
  })

  it('an existing version folder is reused only when it matches', () => {
    mkdirSync(join(ptyRoot, '0.11.0'))
    for (const name of PTY_PAYLOAD_FILES) writeFileSync(join(ptyRoot, '0.11.0', name), `new ${name}`)
    const prepared = staged()
    installPreparedPty(prepared, root, realFs)
    expect(existsSync(prepared.staging)).toBe(false)
    expect(readPointer(ptyRoot, 'current-pty')).toBe('0.11.0')
    expect(readFileSync(join(bin, 'harness.exe'), 'utf8')).toBe('new harness.exe')
  })

  it('a reused version folder survives a later failure', () => {
    mkdirSync(join(ptyRoot, '0.11.0'))
    for (const name of PTY_PAYLOAD_FILES) writeFileSync(join(ptyRoot, '0.11.0', name), `new ${name}`)
    const before = snapshot()
    // The first call is now the copy of harness.exe: the reuse made no rename.
    expect(() => installPreparedPty(staged(), root, faulty(STEPS.length - 1).fs)).toThrow(PtyPayloadRefused)
    expect(snapshot()).toEqual(before)
    expect(readdirSync(join(ptyRoot, '0.11.0')).sort()).toEqual([...PTY_PAYLOAD_FILES].sort())
  })

  it('refused when it differs', () => {
    mkdirSync(join(ptyRoot, '0.11.0'))
    for (const name of PTY_PAYLOAD_FILES) writeFileSync(join(ptyRoot, '0.11.0', name), `other ${name}`)
    const before = snapshot()
    const prepared = staged()
    expect(() => installPreparedPty(prepared, root, realFs)).toThrow(PtyPayloadRefused)
    expect(snapshot()).toEqual(before)
    expect(existsSync(prepared.staging)).toBe(false)
    expect(readFileSync(join(ptyRoot, '0.11.0', 'harness.exe'), 'utf8')).toBe('other harness.exe')
  })

  it('refused when the existing folder lacks a file', () => {
    mkdirSync(join(ptyRoot, '0.11.0'))
    for (const name of PTY_PAYLOAD_FILES.slice(1)) writeFileSync(join(ptyRoot, '0.11.0', name), `new ${name}`)
    expect(() => installPreparedPty(staged(), root, realFs)).toThrow(PtyPayloadRefused)
    expect(readPointer(ptyRoot, 'current-pty')).toBe('0.10.0')
  })

  it('refused with no installed version to roll back to', () => {
    rmSync(join(ptyRoot, 'current-pty'))
    const prepared = staged()
    expect(() => installPreparedPty(prepared, root, realFs)).toThrow(PtyPayloadRefused)
    expect(existsSync(join(ptyRoot, 'current-pty'))).toBe(false)
    expect(existsSync(join(ptyRoot, '0.11.0'))).toBe(false)
    expect(existsSync(prepared.staging)).toBe(false)
  })
})

describe('restorePty', () => {
  it('restorePty puts the pointer and the bin files back, rejects the version, and keeps the folder', () => {
    installPreparedPty(staged(), root, realFs)
    expect(restorePty(root)).toBe(true)
    expect(readPointer(ptyRoot, 'current-pty')).toBe('0.10.0')
    expect(readFileSync(join(bin, 'harness.exe'), 'utf8')).toBe('old harness.exe')
    expect(readFileSync(join(bin, 'harness-launch.exe'), 'utf8')).toBe('old harness-launch.exe')
    expect(rejectedPtyVersions(root)).toEqual(['0.11.0'])
    expect(existsSync(join(ptyRoot, 'pty-pending.json'))).toBe(false)
    expect(readdirSync(join(ptyRoot, '0.11.0')).sort()).toEqual([...PTY_PAYLOAD_FILES].sort())
  })

  it('adds to the rejected list without repeating a version', () => {
    writeFileSync(join(ptyRoot, 'pty-rejected.json'), JSON.stringify(['0.9.0', '0.11.0']))
    installPreparedPty(staged(), root, realFs)
    restorePty(root)
    expect(rejectedPtyVersions(root)).toEqual(['0.9.0', '0.11.0'])
  })

  it('restorePty with no marker changes nothing', () => {
    const before = snapshot()
    expect(restorePty(root)).toBe(false)
    expect(snapshot()).toEqual(before)
    expect(rejectedPtyVersions(root)).toEqual([])
  })

  it('a marker that names a path outside pty\\ restores nothing', () => {
    writeFileSync(join(ptyRoot, 'pty-pending.json'), JSON.stringify({ version: '0.11.0', previous: '..' }))
    const before = snapshot()
    expect(restorePty(root)).toBe(false)
    expect(snapshot()).toEqual(before)
  })
})

describe('confirmPty', () => {
  it('confirmPty removes the marker', () => {
    installPreparedPty(staged(), root, realFs)
    confirmPty(root)
    expect(existsSync(join(ptyRoot, 'pty-pending.json'))).toBe(false)
    expect(readPointer(ptyRoot, 'current-pty')).toBe('0.11.0')
    expect(restorePty(root)).toBe(false)
  })
})

describe('rejectedPtyVersions', () => {
  it('is empty when the file is missing or malformed', () => {
    expect(rejectedPtyVersions(root)).toEqual([])
    writeFileSync(join(ptyRoot, 'pty-rejected.json'), '{not json')
    expect(rejectedPtyVersions(root)).toEqual([])
    writeFileSync(join(ptyRoot, 'pty-rejected.json'), JSON.stringify(['0.9.0', 7]))
    expect(rejectedPtyVersions(root)).toEqual(['0.9.0'])
  })
})

describe('sweepAsideFiles', () => {
  it('sweepAsideFiles deletes what it can', () => {
    for (const n of ['harness.exe.old-1-1', 'harness-launch.exe.old-1-2', '.harness.exe.old-3-4']) writeFileSync(join(bin, n), n)
    // A file still running cannot be deleted on Windows; the injected rm stands in for that here.
    const fs: PtyInstallFs = {
      ...realFs,
      rm: (p, o) => {
        if (p.endsWith('harness-launch.exe.old-1-2')) throw Object.assign(new Error('busy'), { code: 'EPERM' })
        rmSync(p, o)
      },
    }
    expect(sweepAsideFiles(root, fs)).toBe(1)
    expect(readdirSync(bin).sort()).toEqual(['harness-launch.exe', 'harness-launch.exe.old-1-2', 'harness.exe'])
    expect(sweepAsideFiles(root)).toBe(0)
    expect(readdirSync(bin).sort()).toEqual(['harness-launch.exe', 'harness.exe'])
  })

  it('is zero with no bin folder', () => {
    rmSync(bin, { recursive: true })
    expect(sweepAsideFiles(root)).toBe(0)
  })
})
