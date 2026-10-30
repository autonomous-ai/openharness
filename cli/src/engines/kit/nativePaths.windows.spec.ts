// NativePaths on Windows paths, on any OS: the file system is a fixture of what Node's lstat answers on NTFS
// (the Windows VM, 2026-10-16: files 0o100666, folders 0o40666, uid 0, a junction reported as a symbolic link).
import * as fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IdentityReadUnavailable } from './identityScan.js'
import { NativeEvidenceBudget } from './nativeEvidence.js'
import { NativePaths } from './nativePaths.js'

vi.mock('node:fs', async (original) => ({ ...await original<typeof fs>(), lstatSync: vi.fn(), readlinkSync: vi.fn() }))

type Kind = 'dir' | 'file' | 'link'
const tree = new Map<string, { kind: Kind; ino: number; target?: string }>([
  ['C:\\', { kind: 'dir', ino: 1 }],
  ['C:\\Users', { kind: 'dir', ino: 2 }],
  ['C:\\Users\\u', { kind: 'dir', ino: 3 }],
  ['C:\\Users\\u\\.claude', { kind: 'dir', ino: 4 }],
  ['C:\\Users\\u\\.claude\\settings.json', { kind: 'file', ino: 5 }],
  ['C:\\Users\\u\\dotfiles', { kind: 'link', ino: 6, target: 'D:\\dotfiles\\' }],
])
const stat = (kind: Kind, ino: number) => ({
  dev: 7n, ino: BigInt(ino), mode: kind === 'dir' ? 0o40666n : 0o100666n, uid: 0n, size: 0n, mtimeNs: 1n, ctimeNs: 1n,
  isDirectory: () => kind === 'dir', isFile: () => kind === 'file', isSymbolicLink: () => kind === 'link',
})
beforeEach(() => {
  vi.mocked(fs.lstatSync).mockImplementation(((path: string) => {
    const node = tree.get(String(path))
    if (!node) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    return stat(node.kind, node.ino)
  }) as never)
  vi.mocked(fs.readlinkSync).mockImplementation(((path: string) => tree.get(String(path))!.target!) as never)
})
afterEach(() => { vi.mocked(fs.lstatSync).mockReset(); vi.mocked(fs.readlinkSync).mockReset() })
const paths = () => new NativePaths(new NativeEvidenceBudget(), 'win32')

describe('NativePaths on Windows', () => {
  it('walks a drive path component by component from its root', () => {
    const walker = paths()
    expect(walker.resolveSync('C:\\Users\\u\\.claude\\settings.json')?.path).toBe('C:\\Users\\u\\.claude\\settings.json')
    expect(walker.snapshot().map((fact) => fact.path)).toEqual(['C:\\', 'C:\\Users', 'C:\\Users\\u', 'C:\\Users\\u\\.claude', 'C:\\Users\\u\\.claude\\settings.json'])
  })

  it('reads a lower-case drive and forward slashes as the same path', () => {
    expect(paths().resolveSync('c:/Users/u/.claude/settings.json')?.path).toBe('C:\\Users\\u\\.claude\\settings.json')
  })

  it('reports a missing leaf as absent when absence is allowed', () => {
    const walker = paths()
    expect(walker.resolveSync('C:\\Users\\u\\.claude\\hooks.json', true)).toBeNull()
    expect(walker.absentLeaf('C:\\Users\\u\\.claude\\hooks.json')).toBe(true)
    expect(() => paths().resolveSync('C:\\Users\\u\\.claude\\hooks.json')).toThrow(IdentityReadUnavailable)
  })

  it('refuses a link or junction on the way instead of following it', () => {
    expect(() => paths().resolveSync('C:\\Users\\u\\dotfiles\\settings.json', true)).toThrow(/reparse point/)
    expect(fs.readlinkSync).toHaveBeenCalledTimes(1)
  })

  it.each(['\\\\server\\share\\settings.json', '\\\\?\\C:\\Users\\u', 'C:relative\\settings.json', '/Users/u/.claude',
    '\\\\.\\C:\\Users\\u', '\\Users\\u\\.claude', 'C:\\Users\\u\\.claude\\settings.json:stream', 'C:\\Users\\u\\.claude\\settings.json::$DATA'])(
    'refuses a path that is not on a drive: %s', (path) => {
      expect(() => paths().resolveSync(path, true)).toThrow(IdentityReadUnavailable)
    })

  it('stops a membership walk at the drive root', () => {
    const walker = paths()
    walker.resolveSync('C:\\Users\\u\\.claude\\settings.json')
    expect(walker.within('C:\\Users\\u\\.claude\\settings.json', [stat('dir', 99) as never])).toBe(false)
    expect(walker.within('C:\\Users\\u\\.claude\\settings.json', [stat('dir', 3) as never])).toBe(true)
  })

  it('resolves . and .. lexically and stops .. at the drive root', () => {
    expect(paths().resolveSync('C:\\Users\\.\\u\\..\\u\\.claude')?.path).toBe('C:\\Users\\u\\.claude')
    expect(paths().resolveSync('C:\\..\\..\\Users')?.path).toBe('C:\\Users')
    expect(paths().resolveSync('C:\\..')?.path).toBe('C:\\')
  })

  it('retains the route outside a removed subtree and re-verifies only that', () => {
    const walker = paths()
    walker.resolveSync('C:\\Users\\u\\.claude\\settings.json')
    const verify = walker.retainOutside('C:\\Users\\u\\.claude')
    const removed = tree.get('C:\\Users\\u\\.claude\\settings.json')!
    tree.delete('C:\\Users\\u\\.claude\\settings.json')
    try { expect(() => verify()).not.toThrow() } finally { tree.set('C:\\Users\\u\\.claude\\settings.json', removed) }
    const ancestor = tree.get('C:\\Users\\u')!
    tree.set('C:\\Users\\u', { kind: 'dir', ino: 42 })
    try { expect(() => verify()).toThrow(/changed/) } finally { tree.set('C:\\Users\\u', ancestor) }
  })

  it('does not take a step across a link as proof of membership', () => {
    const walker = paths()
    expect(() => walker.resolveSync('C:\\Users\\u\\dotfiles\\settings.json', true)).toThrow(/reparse point/)
    expect(() => walker.within('C:\\Users\\u\\dotfiles\\settings.json', [stat('dir', 99) as never])).toThrow(IdentityReadUnavailable)
  })
})
