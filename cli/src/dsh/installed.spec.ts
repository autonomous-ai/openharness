// What is installed on this machine: the index file, each record resolved to its manifest, the short
// cache in front of both, and finding a harness by an id it went by before (`formerly`).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env } from '../config/env.js'
import {
  dshInstallDir, dshRootDir, installedDsh, invalidateInstalledDsh, isBrokenDsh, listDshState, listInstalledDsh,
  readInstalledIndex, removeInstalledRecord, resolveInstalled, upsertInstalledRecord, writeInstalledIndex,
  type InstalledDshRecord,
} from './installed.js'

describe('the installed index', () => {
  let root: string
  let saved: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-installed-')))
    saved = env.DSH_DIR
    env.DSH_DIR = join(root, 'dsh')
    invalidateInstalledDsh()
  })
  afterEach(() => {
    vi.useRealTimers()
    env.DSH_DIR = saved
    invalidateInstalledDsh()
    rmSync(root, { recursive: true, force: true })
  })

  const record = (id: string, extra: Partial<InstalledDshRecord> = {}): InstalledDshRecord => ({
    id, dir: dshInstallDir(id), source: `https://example.com/${id}`, ref: null, commit: null, linked: false, installedAt: 1, ...extra,
  })
  const pkg = (id: string, manifest: Record<string, unknown> = {}): InstalledDshRecord => {
    const dir = dshInstallDir(id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'harness.json'), JSON.stringify({ spec: 1, id, name: id.split('/')[1], engine: 'claude', ...manifest }))
    return record(id)
  }
  const indexFile = (): string => join(dshRootDir(), 'installed.json')

  it('lives under DSH_DIR, one directory per owner/name', () => {
    expect(dshRootDir()).toBe(join(root, 'dsh'))
    expect(dshInstallDir('acme/thing')).toBe(join(root, 'dsh', 'acme', 'thing'))
  })

  it('reads as empty when the file is missing, not JSON, or not a list, and keeps only well-formed rows', () => {
    expect(readInstalledIndex()).toEqual([])
    mkdirSync(dshRootDir(), { recursive: true })
    writeFileSync(indexFile(), '{nope')
    expect(readInstalledIndex()).toEqual([])
    writeFileSync(indexFile(), JSON.stringify({ id: 'acme/thing' }))
    expect(readInstalledIndex()).toEqual([])
    const good = record('acme/good', { ref: 'main', commit: 'abc' })
    writeFileSync(indexFile(), JSON.stringify([
      null, 'acme/thing', 7,
      good,
      { ...record('acme/x'), id: '../../etc' },
      { ...record('acme/x'), dir: '' },
      { ...record('acme/x'), source: 1 },
      { ...record('acme/x'), ref: 2 },
      { ...record('acme/x'), commit: false },
      { ...record('acme/x'), linked: 'no' },
      { ...record('acme/x'), installedAt: 'today' },
    ]))
    expect(readInstalledIndex()).toEqual([good])
  })

  it('writes the index privately, sorted by id, one row per id', () => {
    upsertInstalledRecord(record('zeta/one'))
    upsertInstalledRecord(record('alpha/one'))
    upsertInstalledRecord(record('zeta/one', { ref: 'v2' }))
    expect(readInstalledIndex().map((row) => `${row.id}@${row.ref}`)).toEqual(['alpha/one@null', 'zeta/one@v2'])
    expect(statSync(indexFile()).mode & 0o777).toBe(0o600)
    expect(readFileSync(indexFile(), 'utf8').endsWith('\n')).toBe(true)
  })

  it('removes a row and says whether there was one', () => {
    writeInstalledIndex([record('acme/a'), record('acme/b')])
    expect(removeInstalledRecord('acme/a')).toBe(true)
    expect(readInstalledIndex().map((row) => row.id)).toEqual(['acme/b'])
    const before = readFileSync(indexFile(), 'utf8')
    expect(removeInstalledRecord('acme/a')).toBe(false)
    expect(readFileSync(indexFile(), 'utf8')).toBe(before)
  })

  it('resolves a record to its manifest through a link, or says why it is broken', () => {
    const checkout = join(root, 'checkout')
    mkdirSync(checkout)
    writeFileSync(join(checkout, 'harness.json'), JSON.stringify({ spec: 1, id: 'acme/linked', name: 'Linked', engine: 'codex' }))
    mkdirSync(join(root, 'dsh', 'acme'), { recursive: true })
    symlinkSync(checkout, dshInstallDir('acme/linked'))
    const linked = resolveInstalled(record('acme/linked', { linked: true }))
    expect(isBrokenDsh(linked)).toBe(false)
    expect(!isBrokenDsh(linked) && linked.realDir).toBe(checkout)

    expect(resolveInstalled(record('acme/gone'))).toMatchObject({ error: `${dshInstallDir('acme/gone')} is missing` })
    symlinkSync(join(root, 'nowhere'), dshInstallDir('acme/dangling'))
    expect(resolveInstalled(record('acme/dangling'))).toMatchObject({ error: `${dshInstallDir('acme/dangling')} is missing` })
    mkdirSync(dshInstallDir('acme/empty'))
    expect((resolveInstalled(record('acme/empty')) as { error: string }).error).toMatch(/^no harness\.json in /)
    pkg('acme/renamed', { id: 'acme/other' })
    expect(resolveInstalled(record('acme/renamed'))).toMatchObject({ error: 'manifest id acme/other does not match the installed id acme/renamed' })
  })

  it('lists what loads and, separately, what is broken, from a cache an install or removal clears', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    writeInstalledIndex([pkg('acme/ok'), record('acme/broken')])
    const state = listDshState()
    expect(state.installed.map((dsh) => dsh.id)).toEqual(['acme/ok'])
    expect(state.broken.map((row) => [row.id, row.error])).toEqual([['acme/broken', `${dshInstallDir('acme/broken')} is missing`]])
    expect(listInstalledDsh()).toBe(state.installed)

    // Within two seconds the disk is not read again; after them, or after an invalidation, it is.
    writeInstalledIndex([])
    vi.setSystemTime(1_001_999)
    expect(listInstalledDsh().map((dsh) => dsh.id)).toEqual(['acme/ok'])
    vi.setSystemTime(1_002_000)
    expect(listInstalledDsh()).toEqual([])
    writeInstalledIndex([pkg('acme/ok')])
    expect(listInstalledDsh()).toEqual([])
    invalidateInstalledDsh()
    expect(listInstalledDsh().map((dsh) => dsh.id)).toEqual(['acme/ok'])
    upsertInstalledRecord(pkg('acme/more'))
    expect(listInstalledDsh().map((dsh) => dsh.id)).toEqual(['acme/more', 'acme/ok'])
    removeInstalledRecord('acme/more')
    expect(listInstalledDsh().map((dsh) => dsh.id)).toEqual(['acme/ok'])
  })

  it('finds a harness by its own id first, then by an id it went by before', () => {
    writeInstalledIndex([
      pkg('acme/solid', { formerly: ['acme/workshop', 'acme/cad'] }),
      pkg('acme/cad'),
      pkg('acme/plain'),
    ])
    expect(installedDsh('acme/solid')?.id).toBe('acme/solid')
    expect(installedDsh('acme/workshop')?.id).toBe('acme/solid')
    // a package still installed under the old id is that package, not the one that took its name
    expect(installedDsh('acme/cad')?.id).toBe('acme/cad')
    expect(installedDsh('acme/nobody')).toBeUndefined()
  })
})
