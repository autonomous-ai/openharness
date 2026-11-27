import * as fs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

// What Node answers on Windows 11 (Node 24, 2026-11-11) for the Claude desktop app's alias: lstat a link, readlink the
// app's program in its package folder under WindowsApps.
const links = new Map<string, string>()
vi.mock('node:fs', async (original) => ({
  ...await original<typeof fs>(),
  lstatSync: vi.fn((path: string) => ({ isSymbolicLink: () => links.has(path) })),
  readlinkSync: vi.fn((path: string) => {
    const target = links.get(path)
    if (target === undefined) throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' })
    return target
  }),
}))
afterEach(() => links.clear())

const ALIAS = 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\claude.exe'
const DESKTOP = 'C:\\Program Files\\WindowsApps\\Claude_5.1231.2.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe'

describe('storeAppAlias', () => {
  it('names the program a Store app\'s alias starts, and nothing for any other file or link', async () => {
    const { storeAppAlias } = await import('./storeAppAlias.js')
    links.set(ALIAS, DESKTOP)
    links.set('C:\\tools\\codex.exe', 'D:\\elsewhere\\codex.exe')
    expect(storeAppAlias(ALIAS)).toBe(DESKTOP)
    expect(storeAppAlias('C:\\tools\\codex.exe')).toBeNull()
    expect(storeAppAlias('C:\\Users\\u\\.local\\bin\\claude.exe')).toBeNull()
  })

  it('passes every file elsewhere than Windows, and on Windows all but an alias', async () => {
    const { notStoreAppAlias } = await import('./storeAppAlias.js')
    links.set(ALIAS, DESKTOP)
    expect(notStoreAppAlias(ALIAS, 'win32')).toBe(false)
    expect(notStoreAppAlias('C:\\Users\\u\\.local\\bin\\claude.exe', 'win32')).toBe(true)
    expect(notStoreAppAlias(ALIAS, 'darwin')).toBe(true)
  })
})
