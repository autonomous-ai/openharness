import { describe, expect, it, vi } from 'vitest'
import { isWsl, writeWindowsClipboard } from './osClipboard.js'

describe('writeWindowsClipboard', () => {
  it('names the file as an input, never in the script, and is written when PowerShell succeeds', async () => {
    const run = vi.fn(async () => ({ status: 0, stdout: '', stderr: '' }))
    expect(await writeWindowsClipboard('C:\\Users\\a b\\p\'aste.png', run)).toEqual({ state: 'written' })
    const [script, inputs] = run.mock.calls[0] as unknown as [string, Record<string, string>]
    expect(inputs).toEqual({ HARNESS_PASTE_IMAGE: 'C:\\Users\\a b\\p\'aste.png' })
    expect(script).not.toContain('aste.png')
    expect(script).toContain('SetDataObject')
  })

  it('says why when the clipboard could not be written', async () => {
    expect(await writeWindowsClipboard('C:\\p.png', async () => ({ status: 1, stdout: '', stderr: 'requested clipboard operation did not succeed' })))
      .toEqual({ state: 'failed', reason: 'requested clipboard operation did not succeed' })
    expect(await writeWindowsClipboard('C:\\p.png', async () => ({ status: null, stdout: '', stderr: '' })))
      .toEqual({ state: 'failed', reason: 'PowerShell could not write the clipboard' })
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
