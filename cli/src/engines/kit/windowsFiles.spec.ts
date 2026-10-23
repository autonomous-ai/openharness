import { constants } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { posix, win32 } from 'node:path'
import { HookPreparationHeld } from './nativeHookFiles.js'
import { isRoot, journalFlushFlags, renameReplacing, unchangedFlushFlags } from './windowsFiles.js'

const held = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })

describe('renameReplacing', () => {
  it('retries a Windows rename onto a file another process has open, then lands', async () => {
    let calls = 0
    const rename = vi.fn(() => { if (++calls < 3) throw held() })
    const waits: number[] = []
    await renameReplacing('a.tmp', 'settings.json', { platform: 'win32', rename, wait: async (ms) => { waits.push(ms) } })
    expect(rename).toHaveBeenCalledTimes(3)
    expect(waits).toEqual([25, 50])
  })

  it.each(['EPERM', 'EBUSY', 'EACCES'])('gives up after its attempts on %s with a reason a person can read, not the errno', async (code) => {
    const rename = vi.fn(() => { throw Object.assign(new Error(`${code}: rename`), { code }) })
    const refusal = renameReplacing('a', 'b', { platform: 'win32', rename, wait: async () => {}, attempts: 4 })
    await expect(refusal).rejects.toThrow(HookPreparationHeld)
    await expect(refusal).rejects.toThrow('Hook preparation is waiting: the settings file is open in another program')
    expect(rename).toHaveBeenCalledTimes(4)
  })

  it('never retries off Windows, or for an error a held file does not cause', async () => {
    const posix = vi.fn(() => { throw held() })
    await expect(renameReplacing('a', 'b', { platform: 'darwin', rename: posix, wait: async () => {} })).rejects.toMatchObject({ code: 'EPERM' })
    expect(posix).toHaveBeenCalledTimes(1)
    const missing = vi.fn(() => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }) })
    await expect(renameReplacing('a', 'b', { platform: 'win32', rename: missing, wait: async () => {} })).rejects.toMatchObject({ code: 'ENOENT' })
    expect(missing).toHaveBeenCalledTimes(1)
  })

  it('asks its owner before each retry', async () => {
    const rename = vi.fn(() => { throw held() })
    const check = vi.fn(() => { throw new Error('the preparation expired') })
    await expect(renameReplacing('a', 'b', { platform: 'win32', rename, wait: async () => {}, check })).rejects.toThrow('the preparation expired')
    expect(rename).toHaveBeenCalledTimes(1)
  })
})

describe('renameReplacing, more', () => {
  it.each(['EBUSY', 'EACCES'])('retries %s as a held target', async (code) => {
    let calls = 0
    const rename = vi.fn(() => { if (++calls < 2) throw Object.assign(new Error(code), { code }) })
    await renameReplacing('a', 'b', { platform: 'win32', rename, wait: async () => {} })
    expect(rename).toHaveBeenCalledTimes(2)
  })

  it('checks after the wait, so a revoke during the wait stops the rename', async () => {
    let expired = false
    const rename = vi.fn(() => { throw held() })
    const check = () => { if (expired) throw new Error('revoked') }
    await expect(renameReplacing('a', 'b', { platform: 'win32', rename, wait: async () => { expired = true }, check })).rejects.toThrow('revoked')
    expect(rename).toHaveBeenCalledTimes(1)
  })
})

describe('isRoot', () => {
  it('knows a Windows drive or share root, and a POSIX root', () => {
    expect(isRoot('C:\\', win32)).toBe(true)
    expect(isRoot('Z:\\', win32)).toBe(true)
    expect(isRoot('\\\\server\\share\\', win32)).toBe(true)
    expect(isRoot('C:\\Users', win32)).toBe(false)
    expect(isRoot('/', posix)).toBe(true)
    expect(isRoot('/home', posix)).toBe(false)
  })
})

describe('flush flags', () => {
  it('does not reopen an unchanged file on Windows, where a writable open changes ctime', () => {
    expect(unchangedFlushFlags(0o666, 'win32')).toBeNull()
    expect(unchangedFlushFlags(0o444, 'win32')).toBeNull()
    expect(journalFlushFlags('win32')).toBeNull()
  })

  it('keeps the POSIX read-only, no-follow open', () => {
    const posix = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    expect(unchangedFlushFlags(0o644, 'darwin')).toBe(posix)
    expect(unchangedFlushFlags(0o444, 'linux')).toBe(posix)
    expect(journalFlushFlags('darwin')).toBe(posix)
  })
})
