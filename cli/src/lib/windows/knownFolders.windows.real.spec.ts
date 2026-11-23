// Where the connections upload fence learns Windows' AppData folders (knownFolders.ts), against the real cmd.exe,
// chcp.com, reg.exe and registry: Windows' own folder is found with no variable, both keys come back from one cmd.exe run
// under an environment that names nothing, and a letter outside ASCII is read as it was written. Windows only; the
// Windows workflow runs it with src/lib/windows:
//   cd cli && npx vitest run src/lib/windows/knownFolders.windows.real.spec.ts
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { folderValues, KNOWN_FOLDERS_TIMEOUT_MS, readAppDataFolders, RegFailure, regQuery } from './knownFolders.js'
import { systemRoot } from './powershell.js'

afterEach(() => vi.unstubAllEnvs())

/** Whether `a` and `b` are one folder, by the file system's identity rather than their spelling. */
function sameFolder(a: string, b: string): boolean {
  const [x, y] = [statSync(a, { bigint: true }), statSync(b, { bigint: true })]
  return x.dev === y.dev && x.ino === y.ino
}

;(process.platform === 'win32' ? describe : describe.skip)('Windows\' AppData folders, from the real registry', () => {
  it('finds Windows\' own folder through the file system', () => {
    const real = vi.fn((path: string) => realpathSync.native(path))
    const root = systemRoot(real)
    expect(root.toLowerCase()).toBe(process.env.SystemRoot?.toLowerCase())
    // It came from the file system, not from the fallback after a throw.
    expect(real.mock.results).toEqual([{ type: 'return', value: expect.stringMatching(/^[A-Za-z]:\\/) }])
    for (const tool of ['cmd.exe', 'chcp.com', 'reg.exe']) expect(existsSync(join(root, 'System32', tool)), tool).toBe(true)
  })

  it('reads both keys in one cmd.exe run by full paths, under an environment that names nothing', () => {
    const [appData, localAppData] = [process.env.APPDATA!, process.env.LOCALAPPDATA!]
    for (const name of ['PATH', 'SystemRoot', 'windir', 'ComSpec', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE']) vi.stubEnv(name, 'Z:\\none')
    const folders = readAppDataFolders(userInfo().homedir)
    expect(folders.failure).toBeUndefined()
    expect(folders.roaming).not.toEqual([])
    expect(folders.local).not.toEqual([])
    expect(folders.roaming.some(folder => sameFolder(folder, appData)), folders.roaming.join(';')).toBe(true)
    expect(folders.local.some(folder => sameFolder(folder, localAppData)), folders.local.join(';')).toBe(true)
  })

  it('reads back a value with ö exactly as it was written', () => {
    // A key of its own: the real User Shell Folders is never written.
    const scratch = `HKCU\\Software\\HarnessKnownFoldersTest-${randomUUID()}`
    const key = `${scratch}\\User Shell Folders`
    try {
      for (const [name, type, data] of [['AppData', 'REG_EXPAND_SZ', '%USERPROFILE%\\Redirect\\Roaming'], ['Local AppData', 'REG_SZ', 'D:\\Redirect ö\\Local'], ['Desktop', 'REG_SZ', 'x']] as const) {
        expect(spawnSync('reg.exe', ['add', key, '/v', name, '/t', type, '/d', data, '/f'], { encoding: 'utf8' }).status, name).toBe(0)
      }
      const [answer] = regQuery([key])
      expect(answer).toBeInstanceOf(Buffer)
      expect(folderValues(answer as Buffer)).toEqual({ roaming: '%USERPROFILE%\\Redirect\\Roaming', local: 'D:\\Redirect ö\\Local', unreadable: { roaming: false, local: false } })
    } finally {
      spawnSync('reg.exe', ['delete', scratch, '/f'])
    }
  })

  it('names a key that is not there as a failure', () => {
    const answers = regQuery([`HKCU\\Software\\HarnessKnownFoldersTest-${randomUUID()}`])
    expect(answers).toHaveLength(1)
    expect(answers[0]).toBeInstanceOf(RegFailure)
    expect((answers[0] as RegFailure).message).toBe('reg.exe could not read a key')
  })

  it('takes the time the pull request reports', () => {
    const times = Array.from({ length: 5 }, () => {
      const start = performance.now()
      expect(readAppDataFolders(userInfo().homedir).failure).toBeUndefined()
      return performance.now() - start
    }).sort((a, b) => a - b)
    const [median, slowest] = [Math.round(times[2]!), Math.round(times[4]!)]
    console.log(`known folders: ${median} ms a read (median of 5), ${slowest} ms the slowest`)
    // The bound the code itself keeps on the run, with room for a loaded runner.
    expect(slowest).toBeLessThan(2 * KNOWN_FOLDERS_TIMEOUT_MS)
  })
})
