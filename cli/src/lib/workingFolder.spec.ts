import { afterEach, describe, expect, it, vi } from 'vitest'
import { enterHome } from './workingFolder.js'

const failing = (code: string, folder: string) => Object.assign(new Error(`${code}: chdir '${folder}'`), { code })

describe('the folder the master and the core work in', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('enters the home', () => {
    const chdir = vi.fn()
    expect(enterHome({ home: () => '/Users/someone', chdir, platform: 'darwin' })).toBeNull()
    expect(chdir.mock.calls).toEqual([['/Users/someone']])
  })

  it('falls back to the root of the home\'s filesystem, and names the kind, never the folder', () => {
    const chdir = vi.fn((folder: string) => { if (folder !== '/') throw failing('ENOENT', folder) })
    const line = enterHome({ home: () => '/home/sentinel-person', chdir, platform: 'linux' })
    expect(chdir.mock.calls.map(([folder]) => folder)).toEqual(['/home/sentinel-person', '/'])
    expect(line).toMatch(/^\[start\] /)
    expect(line).toContain('ENOENT')
    expect(line).not.toContain('sentinel-person')
  })

  it('on Windows, the root of the home\'s drive', () => {
    const chdir = vi.fn((folder: string) => { if (folder !== 'D:\\') throw failing('EPERM', folder) })
    const line = enterHome({ home: () => 'D:\\Users\\sentinel-person', chdir, platform: 'win32' })
    expect(chdir.mock.calls.map(([folder]) => folder)).toEqual(['D:\\Users\\sentinel-person', 'D:\\'])
    expect(line).toContain('EPERM')
    expect(line).not.toContain('sentinel-person')
  })

  it('with no home to read, the root: / elsewhere, the system drive on Windows', () => {
    const home = () => { throw failing('ENOENT', 'uv_os_homedir') }
    const elsewhere = vi.fn()
    expect(enterHome({ home, chdir: elsewhere, platform: 'linux' })).toContain('ENOENT')
    expect(elsewhere.mock.calls).toEqual([['/']])
    vi.stubEnv('SystemDrive', 'E:')
    const windows = vi.fn()
    expect(enterHome({ home, chdir: windows, platform: 'win32' })).toContain('ENOENT')
    expect(windows.mock.calls).toEqual([['E:\\']])
  })

  it('stays where it is and says so when the root cannot be entered either, and never throws', () => {
    const chdir = vi.fn((folder: string) => { throw failing(folder === '/' ? 'EACCES' : 'ENOENT', folder) })
    const line = enterHome({ home: () => '/home/sentinel-person', chdir, platform: 'darwin' })
    expect(chdir.mock.calls.map(([folder]) => folder)).toEqual(['/home/sentinel-person', '/'])
    expect(line).toContain('ENOENT')
    expect(line).toContain('EACCES')
    expect(line).not.toContain('sentinel-person')
    expect(line).toMatch(/staying in the start folder$/)
  })
})
