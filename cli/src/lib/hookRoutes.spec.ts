import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import { harnessPaneOwner } from './harnessSessionLabel.js'
import { hookRouteFile, publishHookRoute } from './hookRoutes.js'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) { chmodSync(root, 0o700); rmSync(root, { recursive: true, force: true }) }
})

function root(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hook-routes-')))
  roots.push(dir)
  return dir
}

describe('hook routes', () => {
  it('never stops a daemon when the routes path is a regular file', () => {
    // Found by QA on a quiet machine: the optional route's finally block threw ENOTDIR after its warning.
    const base = root()
    const dir = join(base, 'hook-routes')
    writeFileSync(dir, 'not a folder')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => publishHookRoute(join(base, 'data'), 18473, dir)).not.toThrow()
    expect(warn.mock.calls[0]?.[0]).toContain('could not record this daemon\'s hook route')
    expect(readFileSync(dir, 'utf8')).toBe('not a folder')
  })

  it('records a daemon under its pane tag, readable only by this user, and reads it back', () => {
    const base = root()
    const dir = join(base, 'hook-routes')
    const dataDir = join(base, 'data')
    mkdirSync(dataDir)
    publishHookRoute(dataDir, 18473, dir)
    const tag = harnessPaneOwner(dataDir)
    const file = hookRouteFile(tag, dir)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ dataDir, port: 18473 })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('keeps one record per data folder, so a dev daemon and the release one never overwrite each other', () => {
    const base = root()
    const dir = join(base, 'hook-routes')
    const release = join(base, 'release'), dev = join(base, 'dev')
    for (const folder of [release, dev]) mkdirSync(folder)
    publishHookRoute(release, 18473, dir)
    publishHookRoute(dev, 18500, dir)
    // A daemon that bound another port on its next start (the port fallback) replaces its own record.
    publishHookRoute(dev, 41234, dir)
    expect(JSON.parse(readFileSync(hookRouteFile(harnessPaneOwner(release), dir), 'utf8'))).toEqual({ dataDir: release, port: 18473 })
    expect(JSON.parse(readFileSync(hookRouteFile(harnessPaneOwner(dev), dir), 'utf8'))).toEqual({ dataDir: dev, port: 41234 })
  })

  it('records the data folder with its symlinks resolved, as the tag is computed', () => {
    const base = root()
    const real = join(base, 'real')
    mkdirSync(real)
    const link = join(base, 'link')
    symlinkSync(real, link)
    publishHookRoute(link, 18473, join(base, 'hook-routes'))
    expect(JSON.parse(readFileSync(hookRouteFile(harnessPaneOwner(link), join(base, 'hook-routes')), 'utf8'))).toEqual({ dataDir: real, port: 18473 })
  })

  // Root writes through any mode: there is no unwritable folder to show.
  it.skipIf(process.getuid?.() === 0)('never stops a daemon from starting: an unwritable folder is said out loud and left', () => {
    const base = root()
    chmodSync(base, 0o500)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => publishHookRoute(join(base, 'data'), 18473, join(base, 'hook-routes'))).not.toThrow()
    expect(warn.mock.calls[0]?.[0]).toContain('could not record this daemon\'s hook route')
  })

  it('tightens a folder others could write, which the hook would refuse', () => {
    const base = root()
    const dir = join(base, 'hook-routes')
    mkdirSync(join(base, 'data'))
    mkdirSync(dir)
    chmodSync(dir, 0o777)
    publishHookRoute(join(base, 'data'), 18473, dir)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('lives at the product root by default, shared by every daemon of this user', () => {
    // vitest.setup.ts moves it into the test's data folder; the default is the product root's.
    expect(env.HARNESS_HOOK_ROUTES_DIR).toBe(join(process.env.ADAPTER_DATA_DIR!, 'hook-routes'))
    const source = readFileSync(new URL('../config/env.ts', import.meta.url), 'utf8')
    expect(source).toContain("HARNESS_HOOK_ROUTES_DIR: text(join(adapterRootDir, 'hook-routes'))")
  })
})
