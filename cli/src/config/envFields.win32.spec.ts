/**
 * homePath with Windows paths: a root-relative value (`\data`) and a drive-relative one (`C:data`) are the home's too,
 * never the current drive's or folder's. node:path is Windows' here, as on a Windows host: a caller that builds posix
 * paths there (forbiddenDirs' posix cases) hands homePath its path module and gets posix paths, as on both Windows
 * runners it did not (windows.yml run 44827687986: '/tmp/c' fenced as 'C:\tmp\c').
 */
import { describe, expect, it, vi } from 'vitest'

const { posix, win32 } = await vi.importActual<typeof import('node:path')>('node:path')
vi.mock('node:path', async () => {
  const { win32: windows } = await vi.importActual<typeof import('node:path')>('node:path')
  return { ...windows, default: windows }
})
const { homePath } = await import('./envFields.js')

const HOME = 'C:\\Users\\me'

describe('a Harness folder or file override, with Windows paths', () => {
  it('is under the home: relative, root-relative on the home\'s drive, and drive-relative on it', () => {
    expect(homePath('data', HOME)).toBe('C:\\Users\\me\\data')
    expect(homePath('\\data', HOME)).toBe('C:\\data')
    expect(homePath('C:data', HOME)).toBe('C:\\Users\\me\\data')
  })

  it('is an absolute value exactly as written, and an empty one stays empty', () => {
    expect(homePath('D:\\data', HOME)).toBe('D:\\data')
    expect(homePath('D:\\data\\', HOME)).toBe('D:\\data\\')
    expect(homePath('\\\\server\\share\\data', HOME)).toBe('\\\\server\\share\\data')
    expect(homePath('', HOME)).toBe('')
  })

  it('is read by the path module its caller gives, not this host\'s', () => {
    expect(homePath('/tmp/c', '/h', posix)).toBe('/tmp/c')
    expect(homePath('data', '/h', posix)).toBe('/h/data')
    expect(homePath('\\data', HOME, win32)).toBe('C:\\data')
  })
})
