/**
 * The containment check with Windows paths, which `relative()` answers with backslashes (`..\Windows`): checked for
 * `../` alone, every folder on the home's drive counted as inside the home.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('node:path', async () => (await vi.importActual<typeof import('node:path')>('node:path')).win32)
const { staysInside, within } = await import('./pathContainment.js')

describe('within, with Windows paths', () => {
  it('keeps a folder out of a root it is not under: on the same drive, a sibling, and on another drive', () => {
    expect(within('C:\\Users\\d', 'C:\\Windows\\System32')).toBe(false)
    expect(within('C:\\Users\\d', 'C:\\Users\\dee')).toBe(false)
    expect(within('C:\\Users\\d', 'D:\\Users\\d')).toBe(false)
  })

  it('lets the root itself and what is under it in, a name that only starts with two dots too', () => {
    expect(within('C:\\Users\\d', 'C:\\Users\\d')).toBe(true)
    expect(within('C:\\Users\\d', 'C:\\Users\\d\\code\\app')).toBe(true)
    expect(within('C:\\Users\\d', 'C:\\Users\\d\\..notes')).toBe(true)
  })
})

describe('staysInside', () => {
  it('reads a relative path as climbing out with either separator, and nothing else', () => {
    expect(staysInside('..')).toBe(false)
    expect(staysInside('..\\Windows')).toBe(false)
    expect(staysInside('../etc')).toBe(false)
    expect(staysInside('C:\\Windows')).toBe(false)
    expect(staysInside('')).toBe(true)
    expect(staysInside('code\\app')).toBe(true)
    expect(staysInside('..notes')).toBe(true)
  })
})
