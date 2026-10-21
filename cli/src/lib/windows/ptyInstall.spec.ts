import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
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
function staged(prefix = 'new', version = '0.11.0'): PreparedPty {
  const staging = join(ptyRoot, `.staging-1-${Math.random().toString(36).slice(2)}`)
  mkdirSync(staging)
  for (const name of PTY_PAYLOAD_FILES) writeFileSync(join(staging, name), `${prefix} ${name}`)
  return { version, staging, protocol: 2, features: ['seed'] }
}

/** Every file under bin\ with its bytes, the marker, the pointer and the pty folder's entries. With [ignoreAside],
 *  the `.old-` files are left out: an undo while a new file runs leaves it aside, for the sweep. */
function snapshot(ignoreAside = false) {
  return {
    bin: Object.fromEntries(readdirSync(bin).filter((n) => !ignoreAside || !n.includes('.old-')).sort()
      .map((n) => [n, readFileSync(join(bin, n), 'utf8')])),
    marker: existsSync(join(ptyRoot, 'pty-pending.json')),
    pointer: readFileSync(join(ptyRoot, 'current-pty'), 'utf8'),
    pty: readdirSync(ptyRoot).sort(),
  }
}

const realFs: PtyInstallFs = { rename: renameSync, link: linkSync, copyFile: copyFileSync, writeFile: writeFileSync, rm: rmSync, sleep: () => {} }
const err = (code: string, message = `injected ${code}`) => Object.assign(new Error(message), { code })

/** The calls made, by kind, and the calls that change files, numbered. [failAt] (from 1) throws EIO instead. */
function faulty(failAt: number, base: PtyInstallFs = realFs) {
  let calls = 0
  const log: string[] = []
  // A call that throws is logged with " !failed" after it.
  const step = (entry: string, call: () => void) => {
    log.push(entry)
    try {
      if (++calls === failAt) throw err('EIO', `injected failure at call ${failAt}`)
      call()
    } catch (error) {
      log[log.length - 1] += ' !failed'
      throw error
    }
  }
  const rel = (p: string) => p.slice(root.length + 1)
  const fs: PtyInstallFs = {
    ...base,
    rename: (a, b) => step(`rename ${rel(a)} -> ${rel(b)}`, () => base.rename(a, b)),
    link: (a, b) => step(`link ${rel(a)} -> ${rel(b)}`, () => base.link(a, b)),
    copyFile: (a, b) => step(`copy ${rel(a)} -> ${rel(b)}`, () => base.copyFile(a, b)),
    writeFile: (p, d) => step(`write ${rel(p)}`, () => base.writeFile(p, d)),
    rm: (p, o) => { log.push(`rm ${rel(p)}`); base.rm(p, o) },
    sleep: (ms) => { log.push(`sleep ${ms}`); base.sleep(ms) },
  }
  return { fs, calls: () => calls, log }
}

/** As Windows behaves while every bin file runs: nothing can be renamed over it, though it can be renamed. */
const running: PtyInstallFs = {
  ...realFs,
  rename: (a, b) => {
    if (dirname(b) === bin && existsSync(b)) throw err('EPERM', 'in use')
    renameSync(a, b)
  },
}

/** Each rename of a bin file aside that succeeded is followed at once by a rename in of its replacement (which may
 *  fail), with no other call and no sleep between them. */
function expectPairsAdjacent(log: string[]): void {
  log.forEach((entry, i) => {
    const aside = /^rename (bin[\\/][^ ]+) -> bin[\\/][^ ]+\.old-\d+-\d+$/.exec(entry)
    if (!aside) return
    expect(log[i + 1], `after "${entry}"`).toMatch(new RegExp(`^rename .+ -> ${aside[1].replace(/[\\.]/g, '\\$&')}( !failed)?$`))
  })
}

/** The calls a successful install makes when nothing runs, in order; [fatal] says whether a failure there aborts. */
const STEPS: Array<[string, boolean]> = [
  ['rename the staging folder to the version folder', true],
  ['copy harness.exe to its temporary name', true],
  ['link the old harness.exe aside', false],
  ['rename the new harness.exe over it', true],
  ['copy harness-launch.exe to its temporary name', true],
  ['link the old harness-launch.exe aside', false],
  ['rename the new harness-launch.exe over it', true],
  ['write the marker to its temporary name', true],
  ['rename the marker into place', true],
  ['rename current-pty into place', true],
]

describe('installPreparedPty', () => {
  it('installs: folder, bin files, marker, pointer', () => {
    const prepared = staged()
    expect(installPreparedPty(prepared, root, realFs)).toBe(true)
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
    it.each(STEPS.map(([name, fatal], i) => [i + 1, name, fatal] as const).filter(([, , fatal]) => fatal))(
      'call %i: %s', (failAt) => {
        const before = snapshot()
        const prepared = staged()
        const error = (() => { try { installPreparedPty(prepared, root, faulty(failAt).fs) } catch (e) { return e } })()
        // An fs failure is rethrown as it was, not as a refusal: it is not the payload's fault.
        expect(error).toMatchObject({ code: 'EIO' })
        expect(error).not.toBeInstanceOf(PtyPayloadRefused)
        expect(snapshot()).toEqual(before)
        expect(existsSync(prepared.staging)).toBe(false)
      },
    )
  })

  it('a link that fails (FAT, or a running image) falls back to the rename-aside pair', () => {
    for (const failAt of [3, 6]) {
      rmSync(join(ptyRoot, '0.11.0'), { recursive: true, force: true })
      rmSync(join(ptyRoot, 'pty-pending.json'), { force: true })
      writeFileSync(join(ptyRoot, 'current-pty'), '0.10.0\r\n')
      const counter = faulty(failAt)
      expect(installPreparedPty(staged(), root, counter.fs)).toBe(true)
      expect(readFileSync(join(bin, 'harness.exe'), 'utf8')).toBe('new harness.exe')
      expect(readFileSync(join(bin, 'harness-launch.exe'), 'utf8')).toBe('new harness-launch.exe')
      expectPairsAdjacent(counter.log)
      expect(counter.log.some((e) => /^rename bin.harness(-launch)?\.exe -> .+\.old-/.test(e))).toBe(true)
    }
  })

  describe('while the old bin files run, Windows-style', () => {
    /** Each bin file now takes copy, link, a refused rename over it, a rename aside and a rename in. */
    const FALLBACK_STEPS: Array<[string, 'fatal' | 'falls back' | 'refused']> = [
      ['rename the staging folder to the version folder', 'fatal'],
      ['copy harness.exe', 'fatal'], ['link harness.exe aside', 'falls back'], ['rename over harness.exe', 'refused'],
      ['rename harness.exe aside', 'fatal'], ['rename harness.exe in', 'fatal'],
      ['copy harness-launch.exe', 'fatal'], ['link harness-launch.exe aside', 'falls back'],
      ['rename over harness-launch.exe', 'refused'], ['rename harness-launch.exe aside', 'fatal'],
      ['rename harness-launch.exe in', 'fatal'],
      ['write the marker', 'fatal'], ['rename the marker', 'fatal'], ['rename current-pty', 'fatal'],
    ]

    it('renames the old files aside instead, as adjacent pairs, and the install completes', () => {
      const counter = faulty(0, running)
      installPreparedPty(staged(), root, counter.fs)
      expect(counter.calls()).toBe(FALLBACK_STEPS.length)
      expectPairsAdjacent(counter.log)
      expect(counter.log.some((e) => e.startsWith('sleep'))).toBe(false)
      expect(readFileSync(join(bin, 'harness.exe'), 'utf8')).toBe('new harness.exe')
      expect(readFileSync(join(bin, 'harness-launch.exe'), 'utf8')).toBe('new harness-launch.exe')
      expect(readPointer(ptyRoot, 'current-pty')).toBe('0.11.0')
      // The extra links went; one aside file per bin file holds the old bytes.
      const aside = readdirSync(bin).filter((n) => n.includes('.old-')).map((n) => readFileSync(join(bin, n), 'utf8')).sort()
      expect(aside).toEqual(['old harness-launch.exe', 'old harness.exe'])
    })

    it.each(FALLBACK_STEPS.map(([name, kind], i) => [i + 1, name, kind] as const).filter(([, , kind]) => kind === 'fatal'))(
      'a failure at call %i (%s) is undone, the undo going through the same pairs', (failAt) => {
        const before = snapshot()
        const counter = faulty(failAt, running)
        expect(() => installPreparedPty(staged(), root, counter.fs)).toThrow('injected failure')
        expect(snapshot(true)).toEqual(before)
        expectPairsAdjacent(counter.log)
      },
    )

    it('a rename-in refused for a moment puts the old file back, waits with it in place, and tries the pair again', () => {
      let refusals = 1
      const fs: PtyInstallFs = {
        ...running,
        rename: (a, b) => {
          if (basename(a).includes('.new-') && basename(b) === 'harness.exe' && !existsSync(b) && refusals-- > 0) {
            throw err('EBUSY', 'held by a scan')
          }
          running.rename(a, b)
        },
      }
      const counter = faulty(0, fs)
      installPreparedPty(staged(), root, counter.fs)
      expect(readFileSync(join(bin, 'harness.exe'), 'utf8')).toBe('new harness.exe')
      const firstAside = counter.log.findIndex((e) => /^rename bin.harness\.exe -> .+\.old-/.test(e))
      // aside, refused rename-in, put back, sleep, then the pair again.
      expect(counter.log.slice(firstAside + 2, firstAside + 4)).toEqual([
        expect.stringMatching(/^rename .+\.old-\d+-\d+ -> bin.harness\.exe$/), expect.stringMatching(/^sleep /),
      ])
      expectPairsAdjacent(counter.log)
    })

    it('a put-back that fails once is retried, and the path is never left missing', () => {
      let putBackFailures = 1
      const fs: PtyInstallFs = {
        ...running,
        rename: (a, b) => {
          if (basename(a).includes('.new-') && basename(b) === 'harness.exe' && !existsSync(b)) throw err('EIO', 'disk error')
          if (basename(a).startsWith('harness.exe.old-') && putBackFailures-- > 0) throw err('EBUSY', 'held')
          running.rename(a, b)
        },
      }
      const before = snapshot()
      expect(() => installPreparedPty(staged(), root, fs)).toThrow('disk error')
      expect(snapshot(true)).toEqual(before)
    })

    it('a put-back that keeps failing leaves the undo to restore the file', () => {
      let putBackFailures = 5
      const fs: PtyInstallFs = {
        ...running,
        rename: (a, b) => {
          if (basename(a).includes('.new-') && basename(b) === 'harness-launch.exe' && !existsSync(b)) throw err('EIO', 'disk error')
          if (basename(a).startsWith('harness-launch.exe.old-') && putBackFailures-- > 0) throw err('EBUSY', 'held')
          running.rename(a, b)
        },
      }
      const before = snapshot()
      const error = (() => { try { installPreparedPty(staged(), root, fs) } catch (e) { return e } })()
      // The put-back failure is thrown, with the rename-in failure behind it.
      expect(error).toMatchObject({ code: 'EBUSY', message: 'held', cause: { code: 'EIO', message: 'disk error' } })
      expect(snapshot(true)).toEqual(before)
    })

    /** During a restore: harness.exe's rename-in fails, and the next [putBackFailures] renames of its aside file too. */
    function restoreFailing(putBackFailures: number): PtyInstallFs {
      return {
        ...running,
        rename: (a, b) => {
          if (basename(a).includes('.new-') && basename(b) === 'harness.exe' && !existsSync(b)) throw err('EIO', 'disk error')
          if (basename(a).startsWith('harness.exe.old-') && basename(b) === 'harness.exe' && putBackFailures-- > 0) throw err('EBUSY', 'held')
          running.rename(a, b)
        },
      }
    }

    it('a restore whose rename-in and every put-back fail has the undo put the current file back, and says kept', () => {
      installPreparedPty(staged(), root, running)
      // putBack's five attempts all fail; the undo's rename then succeeds.
      expect(restorePty(root, restoreFailing(5))).toEqual({ found: true, pointer: true, restored: ['harness-launch.exe'], kept: ['harness.exe'], missing: [] })
      expect(readFileSync(join(bin, 'harness.exe'), 'utf8')).toBe('new harness.exe')
      expect(readFileSync(join(bin, 'harness-launch.exe'), 'utf8')).toBe('old harness-launch.exe')
    })

    it('a restore that can put nothing back reports the path missing, not kept', () => {
      installPreparedPty(staged(), root, running)
      expect(restorePty(root, restoreFailing(Infinity))).toEqual({ found: true, pointer: true, restored: ['harness-launch.exe'], kept: [], missing: ['harness.exe'] })
      expect(existsSync(join(bin, 'harness.exe'))).toBe(false)
      // Its bytes are still there, under an aside name.
      expect(readdirSync(bin).some((n) => n.startsWith('harness.exe.old-') && readFileSync(join(bin, n), 'utf8') === 'new harness.exe')).toBe(true)
    })

    it('restorePty puts the old files back the same way', () => {
      installPreparedPty(staged(), root, running)
      expect(restorePty(root, running)).toEqual({ found: true, pointer: true, restored: ['harness.exe', 'harness-launch.exe'], kept: [], missing: [] })
      expect(readFileSync(join(bin, 'harness.exe'), 'utf8')).toBe('old harness.exe')
      expect(readFileSync(join(bin, 'harness-launch.exe'), 'utf8')).toBe('old harness-launch.exe')
    })
  })

  it('an existing version folder is reused only when it matches', () => {
    mkdirSync(join(ptyRoot, '0.11.0'))
    for (const name of PTY_PAYLOAD_FILES) writeFileSync(join(ptyRoot, '0.11.0', name), `new ${name}`)
    const prepared = staged()
    expect(installPreparedPty(prepared, root, realFs)).toBe(true)
    expect(existsSync(prepared.staging)).toBe(false)
    expect(readPointer(ptyRoot, 'current-pty')).toBe('0.11.0')
    expect(readFileSync(join(bin, 'harness.exe'), 'utf8')).toBe('new harness.exe')
  })

  it('a reused version folder survives a later failure', () => {
    mkdirSync(join(ptyRoot, '0.11.0'))
    for (const name of PTY_PAYLOAD_FILES) writeFileSync(join(ptyRoot, '0.11.0', name), `new ${name}`)
    const before = snapshot()
    // The reuse makes no rename, so the last call (the pointer) is one earlier.
    expect(() => installPreparedPty(staged(), root, faulty(STEPS.length - 1).fs)).toThrow('injected failure')
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

  it('refuses a version launch.ts could not read', () => {
    for (const version of ['0.11.0-beta', 'v0.11.0', '..', '']) {
      const before = snapshot()
      expect(() => installPreparedPty(staged('new', version), root, realFs)).toThrow(PtyPayloadRefused)
      expect(snapshot()).toEqual(before)
    }
  })

  it('a plain error, not a refusal, with no installed version to roll back to', () => {
    rmSync(join(ptyRoot, 'current-pty'))
    const prepared = staged()
    const error = (() => { try { installPreparedPty(prepared, root, realFs) } catch (e) { return e } })()
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(PtyPayloadRefused)
    expect(existsSync(join(ptyRoot, 'current-pty'))).toBe(false)
    expect(existsSync(join(ptyRoot, '0.11.0'))).toBe(false)
    expect(existsSync(prepared.staging)).toBe(false)
  })

  it('a plain error, changing nothing, while a version is still on probation', () => {
    writeFileSync(join(ptyRoot, 'pty-pending.json'), JSON.stringify({ version: '0.10.0', previous: '0.9.0' }))
    const before = snapshot()
    const error = (() => { try { installPreparedPty(staged(), root, realFs) } catch (e) { return e } })()
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(PtyPayloadRefused)
    expect(snapshot()).toEqual(before)
  })

  it('returns false and only drops the staging folder when current-pty already names the version', () => {
    writeFileSync(join(ptyRoot, 'current-pty'), '0.11.0\r\n')
    const before = snapshot()
    const prepared = staged()
    expect(installPreparedPty(prepared, root, realFs)).toBe(false)
    expect(snapshot()).toEqual(before)
    expect(existsSync(prepared.staging)).toBe(false)
  })

  it('a staging folder that will not delete does not replace the real error', () => {
    mkdirSync(join(ptyRoot, '0.11.0'))
    for (const name of PTY_PAYLOAD_FILES) writeFileSync(join(ptyRoot, '0.11.0', name), `other ${name}`)
    const fs: PtyInstallFs = { ...realFs, rm: (p, o) => { if (p.includes('.staging-')) throw err('EBUSY'); rmSync(p, o) } }
    expect(() => installPreparedPty(staged(), root, fs)).toThrow(PtyPayloadRefused)
  })
})

describe('restorePty', () => {
  it('restorePty puts the pointer and the bin files back, rejects the version, and keeps the folder', () => {
    installPreparedPty(staged(), root, realFs)
    expect(restorePty(root)).toEqual({ found: true, pointer: true, restored: ['harness.exe', 'harness-launch.exe'], kept: [], missing: [] })
    expect(readPointer(ptyRoot, 'current-pty')).toBe('0.10.0')
    expect(readFileSync(join(bin, 'harness.exe'), 'utf8')).toBe('old harness.exe')
    expect(readFileSync(join(bin, 'harness-launch.exe'), 'utf8')).toBe('old harness-launch.exe')
    expect(rejectedPtyVersions(root)).toEqual(['0.11.0'])
    expect(existsSync(join(ptyRoot, 'pty-pending.json'))).toBe(false)
    expect(readdirSync(join(ptyRoot, '0.11.0')).sort()).toEqual([...PTY_PAYLOAD_FILES].sort())
  })

  it('keeps the current bin file for one the previous version lacks', () => {
    installPreparedPty(staged(), root, realFs)
    rmSync(join(ptyRoot, '0.10.0', 'harness-launch.exe'))
    expect(restorePty(root)).toEqual({ found: true, pointer: true, restored: ['harness.exe'], kept: ['harness-launch.exe'], missing: [] })
    expect(readPointer(ptyRoot, 'current-pty')).toBe('0.10.0')
    expect(readFileSync(join(bin, 'harness.exe'), 'utf8')).toBe('old harness.exe')
    expect(readFileSync(join(bin, 'harness-launch.exe'), 'utf8')).toBe('new harness-launch.exe')
    expect(rejectedPtyVersions(root)).toEqual(['0.11.0'])
    expect(existsSync(join(ptyRoot, 'pty-pending.json'))).toBe(false)
  })

  it('with the previous folder gone, rejects the version and leaves the pointer and bin files', () => {
    installPreparedPty(staged(), root, realFs)
    rmSync(join(ptyRoot, '0.10.0'), { recursive: true })
    expect(restorePty(root)).toEqual({ found: true, pointer: false, restored: [], kept: ['harness.exe', 'harness-launch.exe'], missing: [] })
    expect(readPointer(ptyRoot, 'current-pty')).toBe('0.11.0')
    expect(readFileSync(join(bin, 'harness.exe'), 'utf8')).toBe('new harness.exe')
    expect(rejectedPtyVersions(root)).toEqual(['0.11.0'])
    expect(existsSync(join(ptyRoot, 'pty-pending.json'))).toBe(false)
    // Nothing is left to try again.
    expect(restorePty(root).found).toBe(false)
  })

  it('records the rejection before it touches the bin files', () => {
    installPreparedPty(staged(), root, realFs)
    const counter = faulty(0)
    restorePty(root, counter.fs)
    const record = counter.log.findIndex((e) => e.includes('pty-rejected.json'))
    const firstBin = counter.log.findIndex((e) => /bin[\\/]/.test(e))
    expect(record).toBeGreaterThanOrEqual(0)
    expect(record).toBeLessThan(firstBin)
  })

  it('a bin file Windows will not take is kept, and the restore still completes', () => {
    installPreparedPty(staged(), root, realFs)
    const fs: PtyInstallFs = { ...realFs, copyFile: () => { throw err('EIO') } }
    expect(restorePty(root, fs)).toEqual({ found: true, pointer: true, restored: [], kept: ['harness.exe', 'harness-launch.exe'], missing: [] })
    expect(existsSync(join(ptyRoot, 'pty-pending.json'))).toBe(false)
  })

  it('adds to the rejected list without repeating a version', () => {
    writeFileSync(join(ptyRoot, 'pty-rejected.json'), JSON.stringify(['0.9.0', '0.11.0']))
    installPreparedPty(staged(), root, realFs)
    restorePty(root)
    expect(rejectedPtyVersions(root)).toEqual(['0.9.0', '0.11.0'])
  })

  it('restorePty with no marker changes nothing', () => {
    const before = snapshot()
    expect(restorePty(root).found).toBe(false)
    expect(snapshot()).toEqual(before)
    expect(rejectedPtyVersions(root)).toEqual([])
  })

  it('a marker that names a path outside pty\\ restores nothing', () => {
    writeFileSync(join(ptyRoot, 'pty-pending.json'), JSON.stringify({ version: '0.11.0', previous: '..' }))
    const before = snapshot()
    expect(restorePty(root).found).toBe(false)
    expect(snapshot()).toEqual(before)
  })
})

describe('confirmPty', () => {
  it('confirmPty removes the marker', () => {
    installPreparedPty(staged(), root, realFs)
    confirmPty(root)
    expect(existsSync(join(ptyRoot, 'pty-pending.json'))).toBe(false)
    expect(readPointer(ptyRoot, 'current-pty')).toBe('0.11.0')
    expect(restorePty(root).found).toBe(false)
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
    const leftovers = ['harness.exe.old-1-1', 'harness-launch.exe.old-1-2', '.harness.exe.old-3-4', '.harness.exe.new-5-6', 'harness.exe~RF1a2b.TMP']
    for (const n of leftovers) writeFileSync(join(bin, n), n)
    // A file still running cannot be deleted on Windows; the injected rm stands in for that here.
    const fs: PtyInstallFs = {
      ...realFs,
      rm: (p, o) => {
        if (p.endsWith('harness-launch.exe.old-1-2')) throw err('EPERM', 'busy')
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
