/**
 * homePath with Windows paths: a root-relative value (`\data`) and a drive-relative one (`C:data`) are the home's too,
 * never the current drive's or folder's.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('node:path', async () => (await vi.importActual<typeof import('node:path')>('node:path')).win32)
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
})
