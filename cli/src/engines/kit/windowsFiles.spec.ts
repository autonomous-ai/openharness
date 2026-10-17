import { constants } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { journalFlushFlags, renameReplacing, unchangedFlushFlags } from './windowsFiles.js'

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

  it('gives up after its attempts with the last error', async () => {
    const rename = vi.fn(() => { throw held() })
    await expect(renameReplacing('a', 'b', { platform: 'win32', rename, wait: async () => {}, attempts: 4 })).rejects.toMatchObject({ code: 'EPERM' })
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

describe('flush flags', () => {
  it('reopens an unchanged file read-write on Windows, where only a writable handle flushes', () => {
    expect(unchangedFlushFlags(0o666, 'win32')).toBe(constants.O_RDWR)
    expect(unchangedFlushFlags(0o444, 'win32')).toBeNull()
    expect(journalFlushFlags('win32')).toBe(constants.O_RDWR)
  })

  it('keeps the POSIX read-only, no-follow open', () => {
    const posix = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    expect(unchangedFlushFlags(0o644, 'darwin')).toBe(posix)
    expect(unchangedFlushFlags(0o444, 'linux')).toBe(posix)
    expect(journalFlushFlags('darwin')).toBe(posix)
  })
})
