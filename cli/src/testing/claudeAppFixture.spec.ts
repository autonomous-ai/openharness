import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeStoreRoots } from '../cable/hosts/appPlaces.js'
import { claudeAppFixture } from './claudeAppFixture.js'

describe('claudeAppFixture', () => {
  const temps: string[] = []
  afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }) })

  it("refuses each root of the account's own store, and a folder inside one", () => {
    // Only the constructor runs on a real place: it writes nothing, so even a fixture that accepted one leaves no trace.
    const roots = claudeStoreRoots(process.platform, process.env, userInfo().homedir).map(({ root }) => root)
    expect(roots.length).toBeGreaterThan(0)
    for (const root of roots) {
      for (const place of [root, join(root, 'eval-account'), `${root}/`]) {
        expect(() => claudeAppFixture(place)).toThrow('the Claude app fixture never writes the real Claude app store')
      }
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
