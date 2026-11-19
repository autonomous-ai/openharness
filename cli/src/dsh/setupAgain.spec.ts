// After Harness's folder moves, the Store sets each package up again: two at a time, a failure marked for the person's
// Update with one line and no detail, a package another process holds left for the Store's next start. The index, the
// manifests and the locks are real; only the setup (finishInstall) is played by the test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { env } from '../config/env.js'
import type { DshInstallResult } from './install.js'
import {
  dshInstallDir, dshRootDir, invalidateInstalledDsh, markSetup, readInstalledIndex, resolveInstalled, upsertInstalledRecord,
  writeInstalledIndex, type InstalledDsh, type InstalledDshRecord,
} from './installed.js'
import { lockDsh } from './lock.js'
import { SETUP_AGAIN_AT_ONCE, setupAgain, type SetupAgainDeps } from './setupAgain.js'

describe('setting harnesses up again after the move', () => {
  let root: string
  let saved: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-setup-again-')))
    saved = env.DSH_DIR
    env.DSH_DIR = join(root, 'dsh')
    invalidateInstalledDsh()
  })
  afterEach(() => {
    env.DSH_DIR = saved
    invalidateInstalledDsh()
    rmSync(root, { recursive: true, force: true })
  })

  /** A package in place at its folder, as the move left it: marked pending. */
  const pkg = (id: string, extra: Partial<InstalledDshRecord> = {}): InstalledDshRecord => {
    const dir = dshInstallDir(id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'harness.json'), JSON.stringify({ spec: 1, id, name: id.split('/')[1], engine: 'claude' }))
    return { id, dir, source: `https://example.com/${id}`, ref: null, commit: 'c1', linked: false, installedAt: 1, setup: 'pending', ...extra }
  }
  /** As finishInstall: a setup that ran writes back the record it was given, its mark included. */
  const ran = (resolved: InstalledDsh, error?: string): DshInstallResult => {
    const { manifest: _manifest, realDir: _realDir, ...record } = resolved
    upsertInstalledRecord(record)
    return error
      ? { ok: false, error, detail: `doctor failed · miss ${resolved.realDir}` }
      : { ok: true, installed: resolved, doctor: { ok: true, lines: [] }, setupLines: [] }
  }
  const deps = (over: Partial<SetupAgainDeps>): { deps: SetupAgainDeps; lines: string[] } => {
    const lines: string[] = []
    return {
      lines,
      deps: { records: readInstalledIndex, resolve: resolveInstalled, lock: lockDsh, finish: async (resolved) => ran(resolved),
        mark: markSetup, log: (line) => { lines.push(line) }, ...over },
    }
  }
  const marks = (): Array<[string, string | undefined]> => readInstalledIndex().map((row) => [row.id, row.setup])
  /** Every step between two setups is synchronous or a promise: one turn of the event loop runs them all. */
  const settle = (): Promise<void> => new Promise((done) => setImmediate(done))

  it('at most two setups run at once', async () => {
    const ids = ['acme/one', 'acme/two', 'acme/three', 'acme/four', 'acme/five']
    writeInstalledIndex(ids.map((id) => pkg(id)))
    const waiting: Array<() => void> = []
    let most = 0
    const finish = vi.fn((resolved: InstalledDsh) => new Promise<DshInstallResult>((resolve) => {
      waiting.push(() => resolve(ran(resolved)))
      most = Math.max(most, waiting.length)
    }))
    const run = setupAgain(deps({ finish }).deps)
    for (let left = ids.length; left > 0; left--) {
      await settle()
      expect(waiting).toHaveLength(Math.min(SETUP_AGAIN_AT_ONCE, left))
      waiting.shift()!()
    }
    expect(await run).toEqual({ done: 5, needsSetup: 0, busy: 0 })
    expect(SETUP_AGAIN_AT_ONCE).toBe(2)
    expect(most).toBe(2)
    // Each setup runs at the package's own folder.
    expect(finish.mock.calls.map(([resolved]) => resolved.realDir)).toEqual(ids.map(dshInstallDir))
    expect(readInstalledIndex()).toHaveLength(5)
    expect(readInstalledIndex().filter((row) => 'setup' in row)).toEqual([])
    // Every lock it took is let go.
    for (const id of ids) lockDsh(id)!()
  })

  it('a setup that fails marks needs-setup and logs one line', async () => {
    writeInstalledIndex([pkg('a/b')])
    const { deps: failing, lines } = deps({
      finish: async () => ({ ok: false, error: 'SETUP_FAILED', detail: `setup exited 1 · ${dshInstallDir('a/b')}/.venv: no space left` }),
    })
    expect(await setupAgain(failing)).toEqual({ done: 0, needsSetup: 1, busy: 0 })
    expect(marks()).toEqual([['a/b', 'needs-setup']])
    expect(lines).toEqual(['[dsh] a/b needs setup · SETUP_FAILED'])
  })

  // Left pending, a package whose setup threw would hold the old folder's bridge for good.
  const throwing: Array<[string, (boom: () => never) => Partial<SetupAgainDeps>]> = [
    ['its setup rejects', (boom) => ({ finish: async (resolved) => resolved.id === 'a/b' ? boom() : ran(resolved) })],
    ['it cannot be read', (boom) => ({ resolve: (record) => record.id === 'a/b' ? boom() : resolveInstalled(record) })],
    ['its lock cannot be taken', (boom) => ({ lock: (id) => id === 'a/b' ? boom() : lockDsh(id) })],
  ]
  for (const [when, over] of throwing) it(`a package is needs-setup with one line and no path when ${when}`, async () => {
    writeInstalledIndex([pkg('a/b'), pkg('a/c')])
    const boom = (): never => { throw new Error(`EACCES: permission denied, open '${dshInstallDir('a/b')}/.venv'`) }
    const { deps: threw, lines } = deps(over(boom))
    expect(await setupAgain(threw)).toEqual({ done: 1, needsSetup: 1, busy: 0 })
    expect(marks()).toEqual([['a/b', 'needs-setup'], ['a/c', undefined]])
    expect(lines).toEqual(['[dsh] a/b needs setup · SETUP_THREW'])
    // Every lock it took is let go.
    for (const id of ['a/b', 'a/c']) lockDsh(id)!()
  })

  it('a setup that ran clears the mark even when the doctor then complains', async () => {
    writeInstalledIndex([pkg('acme/doctor'), pkg('acme/viewer')])
    const finish = vi.fn(async (resolved: InstalledDsh) => ran(resolved, resolved.id === 'acme/doctor' ? 'DOCTOR_FAILED' : 'VIEWER_UNAVAILABLE'))
    const { deps: complaining, lines } = deps({ finish })
    expect(await setupAgain(complaining)).toEqual({ done: 2, needsSetup: 0, busy: 0 })
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ id: 'acme/doctor', realDir: dshInstallDir('acme/doctor') }),
      { source: 'https://example.com/acme/doctor' }, true)
    expect(marks()).toEqual([['acme/doctor', undefined], ['acme/viewer', undefined]])
    expect(lines).toEqual([])
  })

  it('a package that no longer loads is needs-setup', async () => {
    const gone = pkg('acme/gone')
    rmSync(gone.dir, { recursive: true })
    writeInstalledIndex([gone])
    const finish = vi.fn()
    const { deps: broken, lines } = deps({ finish })
    expect(await setupAgain(broken)).toEqual({ done: 0, needsSetup: 1, busy: 0 })
    expect(finish).not.toHaveBeenCalled()
    expect(marks()).toEqual([['acme/gone', 'needs-setup']])
    expect(lines).toEqual(['[dsh] acme/gone needs setup · BROKEN'])
  })

  it('a linked package waiting is set up again at its checkout: what its setup built there runs on Harness\'s Python, which moved', async () => {
    const checkout = join(root, 'checkout')
    mkdirSync(checkout)
    writeFileSync(join(checkout, 'harness.json'), JSON.stringify({ spec: 1, id: 'acme/linked', name: 'linked', engine: 'claude' }))
    const dir = dshInstallDir('acme/linked')
    mkdirSync(dirname(dir), { recursive: true })
    symlinkSync(checkout, dir)
    writeInstalledIndex([{ id: 'acme/linked', dir, source: checkout, ref: null, commit: null, linked: true, installedAt: 1, setup: 'pending' }])
    const finish = vi.fn(async (resolved: InstalledDsh) => ran(resolved))
    expect(await setupAgain(deps({ finish }).deps)).toEqual({ done: 1, needsSetup: 0, busy: 0 })
    expect(finish.mock.calls.map(([resolved]) => resolved.realDir)).toEqual([checkout])
    expect(marks()).toEqual([['acme/linked', undefined]])
  })

  it('one with no mark or needs-setup is not touched', async () => {
    writeInstalledIndex([pkg('acme/plain', { setup: undefined }), pkg('acme/failed', { setup: 'needs-setup' })])
    const before = readFileSync(join(dshRootDir(), 'installed.json'), 'utf8')
    const lock = vi.fn(lockDsh)
    const finish = vi.fn()
    const { deps: untouched, lines } = deps({ lock, finish })
    expect(await setupAgain(untouched)).toEqual({ done: 0, needsSetup: 0, busy: 0 })
    expect(lock).not.toHaveBeenCalled()
    expect(finish).not.toHaveBeenCalled()
    expect(readFileSync(join(dshRootDir(), 'installed.json'), 'utf8')).toBe(before)
    expect(lines).toEqual([])
  })

  it('a package another process holds stays pending, with no line', async () => {
    writeInstalledIndex([pkg('acme/held'), pkg('acme/free')])
    const release = lockDsh('acme/held')!
    try {
      const finish = vi.fn(async (resolved: InstalledDsh) => ran(resolved))
      const { deps: held, lines } = deps({ finish })
      expect(await setupAgain(held)).toEqual({ done: 1, needsSetup: 0, busy: 1 })
      expect(finish.mock.calls.map(([resolved]) => resolved.id)).toEqual(['acme/free'])
      expect(marks()).toEqual([['acme/free', undefined], ['acme/held', 'pending']])
      expect(lines).toEqual([])
    } finally { release() }
  })

  it('an update or a removal that ends while it waits keeps what it wrote', async () => {
    writeInstalledIndex([pkg('acme/a'), pkg('acme/b'), pkg('acme/c'), pkg('acme/d')])
    const finish = vi.fn(async (resolved: InstalledDsh) => {
      // While the first two run, the person's update of c commits (no mark, a new commit) and d is removed.
      if (resolved.id === 'acme/a') {
        writeInstalledIndex(readInstalledIndex().flatMap((row) => {
          if (row.id === 'acme/d') return []
          if (row.id !== 'acme/c') return [row]
          const { setup: _setup, ...updated } = row
          return [{ ...updated, commit: 'c2' }]
        }))
      }
      return ran(resolved)
    })
    expect(await setupAgain(deps({ finish }).deps)).toEqual({ done: 2, needsSetup: 0, busy: 0 })
    expect(finish.mock.calls.map(([resolved]) => resolved.id)).toEqual(['acme/a', 'acme/b'])
    expect(readInstalledIndex().map((row) => [row.id, row.commit, row.setup])).toEqual([
      ['acme/a', 'c1', undefined], ['acme/b', 'c1', undefined], ['acme/c', 'c2', undefined],
    ])
  })

  it('nothing pending runs nothing', async () => {
    const finish = vi.fn()
    const { deps: empty, lines } = deps({ finish })
    expect(await setupAgain(empty)).toEqual({ done: 0, needsSetup: 0, busy: 0 })
    expect(finish).not.toHaveBeenCalled()
    expect(lines).toEqual([])
  })
})
