import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeStoreRoots } from '../cable/hosts/appPlaces.js'
import { claudeAppFixture } from './claudeAppFixture.js'

const REFUSED = 'the Claude app fixture never writes the real Claude app store'
const realRoots = () => claudeStoreRoots(process.platform, process.env, userInfo().homedir).map(({ root }) => root)

// Only the constructor runs on a real place: it writes nothing, so even a fixture that accepted one leaves no trace.
describe('claudeAppFixture', () => {
  const temps: string[] = []
  afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }) })

  it("refuses each root of the account's own store, and a folder inside one", () => {
    const roots = realRoots()
    expect(roots.length).toBeGreaterThan(0)
    for (const root of roots) {
      for (const place of [root, join(root, 'eval-account'), `${root}/`]) expect(() => claudeAppFixture(place)).toThrow(REFUSED)
    }
  })

  // Their folders ignore case: another spelling is the same store.
  it.runIf(process.platform === 'darwin' || process.platform === 'win32')('refuses a root spelled in another case', () => {
    for (const root of realRoots()) expect(() => claudeAppFixture(root.toUpperCase())).toThrow(REFUSED)
  })

  it('refuses a root reached through a link to the home folder', () => {
    const temp = mkdtempSync(join(tmpdir(), 'claude-app-fixture-'))
    temps.push(temp)
    const home = userInfo().homedir
    // A junction on Windows, which needs no right to make; elsewhere the type is not read.
    const link = join(temp, 'home')
    symlinkSync(home, link, 'junction')
    try {
      for (const root of realRoots()) expect(() => claudeAppFixture(join(link, relative(home, root)))).toThrow(REFUSED)
    } finally {
      // The link alone, before its folder goes: nothing is ever removed through it.
      unlinkSync(link)
    }
  })

  // Linux finds its store from XDG_CONFIG_HOME (Windows from APPDATA and LOCALAPPDATA), which tier A empties before it
  // makes a fixture. Linux stands in for both here, the one OS whose paths this computer's path module reads.
  it('refuses the root of the env it was loaded with and the default root, whatever the env is now', async () => {
    const loaded = join(tmpdir(), 'eval-loaded-config')
    vi.stubEnv('XDG_CONFIG_HOME', loaded)
    vi.resetModules()
    const { claudeAppFixture: fresh } = await import('./claudeAppFixture.js')
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
    const roots = [join(loaded, 'Claude', 'claude-code-sessions'), join(userInfo().homedir, '.config', 'Claude', 'claude-code-sessions')]
    try {
      for (const now of ['', join(tmpdir(), 'eval-later-config')]) {
        vi.stubEnv('XDG_CONFIG_HOME', now)
        for (const root of roots) expect(() => fresh(root)).toThrow(REFUSED)
      }
    } finally {
      Object.defineProperty(process, 'platform', platform)
      vi.unstubAllEnvs()
    }
  })

  it('writes a temp store as the app does', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-app-fixture-'))
    temps.push(root)
    const store = claudeAppFixture(root)
    const path = store.write({ localId: 'local_eval-1', cliSessionId: 'cli-1', cwd: '/work/eval-a', title: 'Eval one' })
    const folder = store.org()
    expect(path).toBe(join(folder, 'local_eval-1.json'))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ sessionId: 'local_eval-1', cliSessionId: 'cli-1', cwd: '/work/eval-a', title: 'Eval one' })
    store.remove('local_eval-1')
    expect(readdirSync(folder)).toEqual(['deleted_eval-1'])
    expect(readFileSync(join(folder, 'deleted_eval-1'), 'utf8')).toHaveLength(13)
  })
})
