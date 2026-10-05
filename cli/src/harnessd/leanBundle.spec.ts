import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LEAN_ENTRY, LEAN_RECENT_MS, folderFingerprint, leanFingerprint, processAlive, readLeanBundle, releaseLeanClaim, writeLeanBundle, type LeanBundle,
} from './leanBundle.js'

// The real file system, with a rename a test can step in front of (another master's, at the same moment),
// a read it can watch and a write it can fail (a disk that fills part-way).
const fsHooks = vi.hoisted(() => ({
  beforeRename: null as null | ((from: string, to: string) => void),
  onRead: null as null | ((path: string) => void),
  failWrite: null as null | ((path: string) => boolean),
  beforeLstat: null as null | ((path: string) => void),
}))
const renames = { set before(step: null | ((from: string, to: string) => void)) { fsHooks.beforeRename = step } }
vi.mock('node:fs', async (real) => {
  const fs = await real<typeof import('node:fs')>()
  return {
    ...fs,
    renameSync: (from: string, to: string) => {
      const step = fsHooks.beforeRename
      fsHooks.beforeRename = null
      step?.(from, to)
      fs.renameSync(from, to)
    },
    readFileSync: ((path: string, ...rest: unknown[]) => {
      fsHooks.onRead?.(String(path))
      return (fs.readFileSync as (...args: unknown[]) => unknown)(path, ...rest)
    }) as typeof fs.readFileSync,
    lstatSync: ((path: string, ...rest: unknown[]) => {
      fsHooks.beforeLstat?.(String(path))
      return (fs.lstatSync as (...args: unknown[]) => unknown)(path, ...rest)
    }) as typeof fs.lstatSync,
    writeFileSync: ((path: string, ...rest: unknown[]) => {
      if (fsHooks.failWrite?.(String(path))) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
      return (fs.writeFileSync as (...args: unknown[]) => unknown)(path, ...rest)
    }) as typeof fs.writeFileSync,
  }
})

// The writer the build uses (it cannot import TypeScript): what is read back here is what the release
// carries.
// @ts-expect-error — plain ESM with no declaration file, imported to hold the build to the runtime
const { LEAN_MARKER, leanBlock } = await import('../../scripts/lib/leanBlock.mjs') as {
  LEAN_MARKER: string
  leanBlock: (files: Record<string, string | Uint8Array>) => string
}

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const FILES = { [LEAN_ENTRY]: 'await import("./master-AB12.mjs")\n', 'master-AB12.mjs': 'console.log("the master — and only it")\n' }
const CLI = '#!/usr/bin/env node\nconsole.log("the whole CLI")\n/*! a dependency\'s notice */\n'
/** A block whose payload is [payload], as the build would write it if it wrote that. */
const blockOf = (payload: string): string => `\n${LEAN_MARKER}${sha256(payload)}:${brotliCompressSync(Buffer.from(payload)).toString('base64')}*/\n`

describe('the lean bundle cli.js carries', () => {
  it('is read back as the build wrote it, file by file, with the sha256 of the whole cli.js it came from', () => {
    const bundle = Buffer.from(CLI + leanBlock(FILES))
    const lean = readLeanBundle(bundle)!
    expect(Object.fromEntries([...lean.files].map(([name, code]) => [name, code.toString('utf8')]))).toEqual(FILES)
    expect(lean.sha256).toBe(sha256(JSON.stringify(FILES)))
    expect(lean.bundleSha256).toBe(sha256(bundle))
  })

  it('is none in a cli.js that carries none, or anything else that looks like its start', () => {
    expect(readLeanBundle(Buffer.from(CLI))).toBeNull()
    // The marker in the code, as a minified bundle folds the reader's own two pieces back together.
    expect(readLeanBundle(Buffer.from(`const marker = "${LEAN_MARKER}"; /* a comment */ console.log(marker)\n`))).toBeNull()
    expect(readLeanBundle(Buffer.from(`${CLI}${LEAN_MARKER}unterminated`))).toBeNull()
  })

  it('is none when it does not match its checksum, or cannot be unpacked', () => {
    const block = leanBlock(FILES)
    const [, sum, packed] = /:([0-9a-f]{64}):([^*]+)\*\//.exec(block)!
    expect(readLeanBundle(Buffer.from(CLI + block.replace(sum, sha256('something else'))))).toBeNull()
    expect(readLeanBundle(Buffer.from(CLI + block.replace(packed, Buffer.from('not brotli').toString('base64'))))).toBeNull()
    expect(readLeanBundle(Buffer.from(`${CLI}${LEAN_MARKER}not-a-sum:${packed}*/\n`))).toBeNull()
    expect(readLeanBundle(Buffer.from(`${CLI}${LEAN_MARKER}${sum}*/\n`))).toBeNull()
  })

  it('is none when its files are not files the master can start: no entry, a name that leaves the folder, not code', () => {
    expect(readLeanBundle(Buffer.from(CLI + blockOf('not json')))).toBeNull()
    expect(readLeanBundle(Buffer.from(CLI + blockOf('["a list"]')))).toBeNull()
    expect(readLeanBundle(Buffer.from(CLI + blockOf('null')))).toBeNull()
    expect(readLeanBundle(Buffer.from(CLI + leanBlock({ 'master-AB12.mjs': 'x' })))).toBeNull()
    for (const name of ['../escape.mjs', 'sub/dir.mjs', '.claim-1.mjs', 'not-a-module.js']) {
      expect(readLeanBundle(Buffer.from(CLI + leanBlock({ ...FILES, [name]: 'x' }))), name).toBeNull()
    }
    expect(readLeanBundle(Buffer.from(CLI + blockOf(JSON.stringify({ [LEAN_ENTRY]: 42 }))))).toBeNull()
  })
})

describe('writing the lean bundle out', () => {
  let dir: string
  beforeEach(() => { dir = join(mkdtempSync(join(tmpdir(), 'lean-')), 'lean') })
  afterEach(() => {
    fsHooks.beforeRename = null
    fsHooks.onRead = null
    fsHooks.failWrite = null
    fsHooks.beforeLstat = null
    rmSync(join(dir, '..'), { recursive: true, force: true })
  })
  /** A cleaner's clock, past the minute it leaves anything that just changed alone. */
  const later = () => Date.now() + LEAN_RECENT_MS + 1_000
  const lean = (files: Record<string, string> = FILES): LeanBundle => ({
    files: new Map(Object.entries(files).map(([name, code]) => [name, Buffer.from(code)])),
    sha256: sha256(JSON.stringify(files)),
    bundleSha256: 'b',
  })
  const folderOf = (bundle: LeanBundle): string => join(dir, bundle.sha256.slice(0, 16))
  const alive = (...pids: number[]) => (pid: number) => pids.includes(pid)

  it('writes its files into a folder of its own, for its owner alone, claimed by this master, and returns its entry', () => {
    const bundle = lean()
    const entry = writeLeanBundle(dir, bundle, { pid: 100, alive: alive(100) })
    expect(entry).toBe(join(folderOf(bundle), LEAN_ENTRY))
    expect(readdirSync(folderOf(bundle)).sort()).toEqual(['.claim-100', LEAN_ENTRY, 'master-AB12.mjs'])
    for (const [name, code] of Object.entries(FILES)) {
      expect(readFileSync(join(folderOf(bundle), name), 'utf8')).toBe(code)
      expect(statSync(join(folderOf(bundle), name)).mode & 0o777).toBe(0o600)
    }
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(folderOf(bundle)).mode & 0o777).toBe(0o700)
  })

  it('uses a folder that holds its bytes as it is, and replaces one that does not', () => {
    const bundle = lean()
    writeLeanBundle(dir, bundle, { pid: 100, alive: alive(100) })
    const written = statSync(join(folderOf(bundle), LEAN_ENTRY)).mtimeMs
    // Another master of the same build: the folder is shared, each claims it.
    writeLeanBundle(dir, bundle, { pid: 200, alive: alive(100, 200) })
    expect(statSync(join(folderOf(bundle), LEAN_ENTRY)).mtimeMs).toBe(written)
    expect(readdirSync(folderOf(bundle)).filter((name) => name.startsWith('.claim')).sort()).toEqual(['.claim-100', '.claim-200'])
    // Changed on disk, or a file gone: replaced whole, and the claims of masters gone with it.
    writeFileSync(join(folderOf(bundle), 'master-AB12.mjs'), 'changed on disk')
    writeLeanBundle(dir, bundle, { pid: 300, alive: alive(300) })
    expect(readFileSync(join(folderOf(bundle), 'master-AB12.mjs'), 'utf8')).toBe(FILES['master-AB12.mjs'])
    rmSync(join(folderOf(bundle), LEAN_ENTRY))
    writeLeanBundle(dir, bundle, { pid: 300, alive: alive(300) })
    expect(readdirSync(folderOf(bundle)).sort()).toEqual(['.claim-300', LEAN_ENTRY, 'master-AB12.mjs'])
    expect(readdirSync(dir)).toEqual([bundle.sha256.slice(0, 16)])
  })

  it('takes the folder another master of the same build wrote while it was writing its own', () => {
    // The two masters of a second `harness start`, at once: the folder appears between this master's
    // look and its rename, written by the other, and the rename fails over it.
    const bundle = lean()
    renames.before = () => { writeLeanBundle(dir, bundle, { pid: 100, alive: alive(100) }) }
    expect(writeLeanBundle(dir, bundle, { pid: 200, alive: alive(100, 200) })).toBe(join(folderOf(bundle), LEAN_ENTRY))
    expect(readdirSync(folderOf(bundle)).sort()).toEqual(['.claim-100', '.claim-200', LEAN_ENTRY, 'master-AB12.mjs'])
    // Its own write is gone: nothing but the one folder.
    expect(readdirSync(dir)).toEqual([bundle.sha256.slice(0, 16)])
  })

  it('says why its write could not be put in place, and leaves the next master to clear it', () => {
    const bundle = lean()
    renames.before = () => { throw Object.assign(new Error('EXDEV: the rename failed'), { code: 'EXDEV' }) }
    expect(() => writeLeanBundle(dir, bundle, { pid: 100, alive: alive(100) })).toThrow('EXDEV: the rename failed')
    expect(existsSync(folderOf(bundle))).toBe(false)
    writeLeanBundle(dir, bundle, { pid: 200, alive: alive(200) })
    expect(readdirSync(dir)).toEqual([bundle.sha256.slice(0, 16)])
  })

  it('removes every folder no live master claims, and every write a crash cut short, but never one a live master runs from', () => {
    const older = lean({ [LEAN_ENTRY]: 'older', 'master-OLD1.mjs': 'older' })
    const another = lean({ [LEAN_ENTRY]: 'another build', 'master-OTH1.mjs': 'another' })
    const unclaimed = lean({ [LEAN_ENTRY]: 'unclaimed' })
    writeLeanBundle(dir, older, { pid: 100, alive: alive(100) })
    writeLeanBundle(dir, another, { pid: 200, alive: alive(100, 200) })
    writeLeanBundle(dir, unclaimed, { pid: 250, alive: alive(100, 200, 250) })
    rmSync(join(folderOf(unclaimed), '.claim-250'))
    mkdirSync(join(dir, `${'c'.repeat(16)}.4242.tmp`))
    mkdirSync(join(dir, `${'d'.repeat(16)}.200.old`))
    writeFileSync(join(dir, 'notes.txt'), 'not a lean bundle')
    // This master (100) moves to a new build; 200 still runs from its own; nothing else is alive.
    const bundle = lean()
    writeLeanBundle(dir, bundle, { pid: 100, alive: alive(100, 200), now: later })
    expect(readdirSync(dir).sort()).toEqual([
      another.sha256.slice(0, 16), bundle.sha256.slice(0, 16), `${'d'.repeat(16)}.200.old`, 'notes.txt',
    ].sort())
    // Once that master is gone, its folder goes with the next master's start, and so does its scratch.
    writeLeanBundle(dir, bundle, { pid: 300, alive: alive(300), now: later })
    expect(readdirSync(dir).sort()).toEqual([bundle.sha256.slice(0, 16), 'notes.txt'])
    expect(readdirSync(folderOf(bundle)).filter((name) => name.startsWith('.claim'))).toEqual(['.claim-300'])
  })

  it('leaves what it cannot remove, and what it cannot read, for a later master', () => {
    const stuck = lean({ [LEAN_ENTRY]: 'stuck' })
    writeLeanBundle(dir, stuck, { pid: 100, alive: alive(100) })
    chmodSync(folderOf(stuck), 0o500)
    // Named like a folder, but a file: no claims to read in it, so it goes.
    writeFileSync(join(dir, 'e'.repeat(16)), 'not a folder')
    try {
      writeLeanBundle(dir, lean(), { pid: 200, alive: alive(200), now: later })
      expect(readdirSync(dir).sort()).toEqual([lean().sha256.slice(0, 16), stuck.sha256.slice(0, 16)].sort())
    } finally { chmodSync(folderOf(stuck), 0o700) }
  })

  it('leaves alone, for a minute, any folder or write that just changed: another master may be at it now', () => {
    const unclaimed = lean({ [LEAN_ENTRY]: 'unclaimed' })
    writeLeanBundle(dir, unclaimed, { pid: 250, alive: alive(250) })
    rmSync(join(folderOf(unclaimed), '.claim-250'))
    mkdirSync(join(dir, `${'c'.repeat(16)}.4242.tmp`))
    const bundle = lean()
    writeLeanBundle(dir, bundle, { pid: 100, alive: alive(100) })
    expect(readdirSync(dir).sort()).toEqual([`${'c'.repeat(16)}.4242.tmp`, bundle.sha256.slice(0, 16), unclaimed.sha256.slice(0, 16)].sort())
    writeLeanBundle(dir, bundle, { pid: 100, alive: alive(100), now: later })
    expect(readdirSync(dir)).toEqual([bundle.sha256.slice(0, 16)])
  })

  it('claims a folder before it checks its bytes, and claims its own write before it puts it in place', () => {
    // From the moment the bytes are found good there is no instant a cleaner could find the folder
    // unclaimed: not between a check and a claim, nor between a rename and a claim.
    const bundle = lean()
    let inScratch: string[] = []
    fsHooks.beforeRename = (from) => { inScratch = readdirSync(from) }
    writeLeanBundle(dir, bundle, { pid: 100, alive: alive(100) })
    expect(inScratch).toContain('.claim-100')
    const claimedWhenRead: boolean[] = []
    fsHooks.onRead = (path) => { if (path.startsWith(folderOf(bundle))) claimedWhenRead.push(existsSync(join(folderOf(bundle), '.claim-200'))) }
    writeLeanBundle(dir, bundle, { pid: 200, alive: alive(100, 200) })
    expect(claimedWhenRead.length).toBeGreaterThan(0)
    expect(claimedWhenRead.every(Boolean)).toBe(true)
  })

  it('keeps the claims of the live masters that run from a folder it replaces', () => {
    const bundle = lean()
    writeLeanBundle(dir, bundle, { pid: 100, alive: alive(100) })
    writeLeanBundle(dir, bundle, { pid: 200, alive: alive(100, 200) })
    writeFileSync(join(folderOf(bundle), 'master-AB12.mjs'), 'changed on disk')
    // 100 still runs from it; 200 is gone.
    writeLeanBundle(dir, bundle, { pid: 300, alive: alive(100, 300) })
    expect(readFileSync(join(folderOf(bundle), 'master-AB12.mjs'), 'utf8')).toBe(FILES['master-AB12.mjs'])
    expect(readdirSync(folderOf(bundle)).filter((name) => name.startsWith('.claim')).sort()).toEqual(['.claim-100', '.claim-300'])
  })

  it('takes a claim made before this computer started for a dead master\'s, whoever has its pid now', () => {
    const older = lean({ [LEAN_ENTRY]: 'older' })
    writeLeanBundle(dir, older, { pid: 100, alive: alive(100) })
    const bootedAt = Date.now() - 1_000
    utimesSync(join(folderOf(older), '.claim-100'), new Date('2026-01-01'), new Date('2026-01-01'))
    const bundle = lean()
    writeLeanBundle(dir, bundle, { pid: 300, alive: alive(100, 300), now: later, bootedAt })
    // pid 100 is alive again, but it is not the master that claimed the folder before the restart.
    expect(readdirSync(dir)).toEqual([bundle.sha256.slice(0, 16)])
    writeLeanBundle(dir, bundle, { pid: 100, alive: alive(100, 300), bootedAt })
    utimesSync(join(folderOf(bundle), '.claim-100'), new Date('2026-01-01'), new Date('2026-01-01'))
    writeLeanBundle(dir, bundle, { pid: 300, alive: alive(100, 300), bootedAt })
    expect(readdirSync(folderOf(bundle)).filter((name) => name.startsWith('.claim'))).toEqual(['.claim-300'])
  })

  it('takes in its stride a write another master clears while this one looks at it', () => {
    const gone = join(dir, `${'c'.repeat(16)}.4242.tmp`)
    mkdirSync(gone, { recursive: true })
    fsHooks.beforeLstat = (path) => { if (path === gone) rmSync(path, { recursive: true }) }
    const bundle = lean()
    writeLeanBundle(dir, bundle, { pid: 100, alive: alive(100) })
    expect(readdirSync(dir)).toEqual([bundle.sha256.slice(0, 16)])
  })

  it('removes its write when the disk fills part-way, and says why', () => {
    let writes = 0
    fsHooks.failWrite = () => ++writes === 3
    expect(() => writeLeanBundle(dir, lean(), { pid: 100, alive: alive(100) })).toThrow('ENOSPC')
    expect(readdirSync(dir)).toEqual([])
  })

  it('gives up a master\'s claim as it exits', () => {
    const entry = writeLeanBundle(dir, lean(), { pid: 100, alive: alive(100) })
    releaseLeanClaim(entry, 100)
    expect(readdirSync(folderOf(lean())).filter((name) => name.startsWith('.claim'))).toEqual([])
    releaseLeanClaim(entry, 100)
    releaseLeanClaim(join(dir, 'nowhere', LEAN_ENTRY))
  })

  it('says why when the folder cannot be written, and leaves nothing half-written in place', () => {
    writeFileSync(join(dir, '..', 'blocked'), 'a file where the folder would go')
    expect(() => writeLeanBundle(join(dir, '..', 'blocked'), lean())).toThrow()
    mkdirSync(dir)
    chmodSync(dir, 0o500)
    try {
      expect(() => writeLeanBundle(dir, lean(), { pid: 100, alive: alive(100) })).toThrow()
      expect(readdirSync(dir)).toEqual([])
    } finally { chmodSync(dir, 0o700) }
    expect(existsSync(folderOf(lean()))).toBe(false)
  })
})

describe('the fingerprint of a lean bundle', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lean-print-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const bundle = (): LeanBundle => readLeanBundle(Buffer.from(CLI + leanBlock(FILES)))!

  it('is the same for the bundle and the folder written from it, claims aside, and changes with any file', () => {
    const entry = writeLeanBundle(join(dir, 'lean'), bundle(), { pid: 100, alive: () => true })
    const folder = join(entry, '..')
    expect(folderFingerprint(folder)).toBe(leanFingerprint(bundle()))
    writeFileSync(join(folder, '.claim-200'), '')
    expect(folderFingerprint(folder)).toBe(leanFingerprint(bundle()))
    writeFileSync(join(folder, 'master-AB12.mjs'), 'changed')
    expect(folderFingerprint(folder)).not.toBe(leanFingerprint(bundle()))
  })

  it('is none for a folder with no entry, or one that cannot be read', () => {
    expect(folderFingerprint(join(dir, 'missing'))).toBeNull()
    writeFileSync(join(dir, 'master-AB12.mjs'), 'x')
    expect(folderFingerprint(dir)).toBeNull()
    writeFileSync(join(dir, LEAN_ENTRY), 'x')
    chmodSync(join(dir, LEAN_ENTRY), 0o000)
    try { expect(folderFingerprint(dir)).toBeNull() } finally { chmodSync(join(dir, LEAN_ENTRY), 0o600) }
  })
})

describe('whether a master is alive', () => {
  it('is yes for a running process, no for one that has exited', async () => {
    expect(processAlive(process.pid)).toBe(true)
    const child = spawn(process.execPath, ['-e', ''])
    await new Promise((done) => child.once('exit', done))
    expect(processAlive(child.pid!)).toBe(false)
  })

  it('is yes for one this user may not signal: a process of another user is still running', () => {
    // pid 1 is launchd or init, never this user's.
    expect(processAlive(1)).toBe(true)
  })
})
