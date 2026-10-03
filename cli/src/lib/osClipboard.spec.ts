import { describe, expect, it } from 'vitest'
import { isWsl } from './osClipboard.js'

describe('isWsl', () => {
  it('knows WSL by the distro WSL names, or by its kernel when that is unset', () => {
    expect(isWsl({ WSL_DISTRO_NAME: 'Ubuntu' }, '6.8.0-45-generic')).toBe(true)
    expect(isWsl({}, '5.15.167.4-microsoft-standard-WSL2')).toBe(true)
  })

  it('leaves a plain Linux machine alone', () => {
    expect(isWsl({}, '6.8.0-45-generic')).toBe(false)
  })
})
