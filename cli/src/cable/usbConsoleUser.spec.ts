import { describe, expect, it, vi } from 'vitest'
import { isUsbConsoleUser } from './usbConsoleUser.js'

describe('physical USB ownership', () => {
  it('allows the active macOS account and excludes a daemon left in another login', () => {
    const consoleUid = () => 501
    expect(isUsbConsoleUser({ platform: 'darwin', uid: 501, consoleUid })).toBe(true)
    expect(isUsbConsoleUser({ platform: 'darwin', uid: 502, consoleUid })).toBe(false)
    expect(isUsbConsoleUser({ platform: 'darwin', uid: 0, consoleUid })).toBe(false)
  })

  it('releases the port at the login window or when console ownership cannot be read', () => {
    expect(isUsbConsoleUser({ platform: 'darwin', uid: 501, consoleUid: () => 0 })).toBe(false)
    expect(isUsbConsoleUser({ platform: 'darwin', uid: 0, consoleUid: () => 0 })).toBe(false)
    expect(isUsbConsoleUser({ platform: 'darwin', uid: 501, consoleUid: () => { throw new Error('unavailable') } })).toBe(false)
  })

  it('does not require a desktop login on Linux', () => {
    const consoleUid = vi.fn(() => { throw new Error('no macOS console') })
    expect(isUsbConsoleUser({ platform: 'linux', uid: 1000, consoleUid })).toBe(true)
    expect(consoleUid).not.toHaveBeenCalled()
  })
})
