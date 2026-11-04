import { afterEach, describe, expect, it, vi } from 'vitest'
import { isWsl, writeImageToOsClipboard } from './osClipboard.js'

describe('writeImageToOsClipboard on Windows', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  // Claude Code takes an image on Alt+V there, so a replayed Ctrl+V attached nothing: the pasted path is what works.
  it('leaves the clipboard alone, so the saved file\'s path is pasted', async () => {
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }))
    expect(await writeImageToOsClipboard('C:\\p.png', new Uint8Array([1]))).toMatchObject({ state: 'unavailable' })
  })
})

describe('isWsl', () => {
  it('knows WSL by the distro WSL names, or by its kernel when that is unset', () => {
    expect(isWsl({ WSL_DISTRO_NAME: 'Ubuntu' }, '6.8.0-45-generic')).toBe(true)
    expect(isWsl({}, '5.15.167.4-microsoft-standard-WSL2')).toBe(true)
  })

  it('leaves a plain Linux machine alone', () => {
    expect(isWsl({}, '6.8.0-45-generic')).toBe(false)
  })
})
