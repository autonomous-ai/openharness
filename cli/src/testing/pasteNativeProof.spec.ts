import { describe, expect, it, vi } from 'vitest'
import { captureClipboardGroup, captureProcess, cleanupPasteFixture, processGone, terminateProcess } from './pasteNativeProof.js'

const stat = (pid: number, start = '30', group = 10) => `${pid} (fixture with (parentheses)) S 1 ${group} ${Array(16).fill('0').join(' ')} ${start} 0 0`
const missing = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }

describe('private paste native proof', () => {
  it('treats only native absence or a changed start identity as gone', () => {
    const owner = captureProcess(11, () => stat(11))
    expect(processGone(owner, () => stat(11))).toBe(false)
    expect(processGone(owner, () => stat(11, '31'))).toBe(true)
    expect(processGone(owner, missing)).toBe(true)
    expect(processGone(owner, () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })).toBe(true)
    for (const code of ['EACCES', 'EPERM', 'ETIMEDOUT']) {
      expect(() => processGone(owner, () => { throw Object.assign(new Error(code), { code }) })).toThrow(code)
    }
    expect(() => processGone(owner, () => 'unreadable')).toThrow('PASTE_NATIVE_INVALID_PROCESS_IDENTITY')
  })

  it('captures only bounded members of the recorded own process group', () => {
    const marker = stat(10, '20')
    expect(captureClipboardGroup(marker, '11 10\n12 10\n13 99', pid => stat(pid))).toEqual([
      { pid: 11, start: '30' }, { pid: 12, start: '30' },
    ])
    expect(() => captureClipboardGroup(stat(10, '20', 9), '11 10\n12 10', pid => stat(pid))).toThrow('PASTE_NATIVE_NOT_OWN_GROUP')
    expect(() => captureClipboardGroup(marker, '11 10', pid => stat(pid))).toThrow('PASTE_NATIVE_SELECTION_OWNER_NOT_CAPTURED')
    expect(() => captureClipboardGroup(marker, '11 10\n12 10', pid => stat(pid, '19'))).toThrow('PASTE_NATIVE_PROCESS_IDENTITY_CHANGED')
    expect(() => captureClipboardGroup(marker, '11 10\n12 10', pid => stat(pid, '30', 99))).toThrow('PASTE_NATIVE_PROCESS_IDENTITY_CHANGED')
    expect(() => captureClipboardGroup(marker, Array.from({ length: 9 }, (_, i) => `${11 + i} 10`).join('\n'), pid => stat(pid))).toThrow('PASTE_NATIVE_GROUP_LIMIT')
  })

  it('never signals a recycled or unverified PID', () => {
    const kill = vi.fn(), owner = { pid: 11, start: '30' }
    terminateProcess(owner, () => stat(11, '31'), kill)
    terminateProcess(owner, missing, kill)
    expect(kill).not.toHaveBeenCalled()
    expect(() => terminateProcess(owner, () => { throw new Error('unreadable') }, kill)).toThrow('unreadable')
    expect(kill).not.toHaveBeenCalled()
    terminateProcess(owner, () => stat(11), kill)
    expect(kill).toHaveBeenCalledExactlyOnceWith(11)
  })

  it('attempts every owned teardown despite earlier rejection and reports every failure', async () => {
    const calls: string[] = []
    const cleanup = cleanupPasteFixture([
      ['owner settlement', async () => { calls.push('owner'); throw new Error('held') }],
      ['worker exit', async () => { calls.push('worker'); throw new Error('unreadable') }],
      ['private display', () => { calls.push('display') }],
      ['private root', () => { calls.push('root') }],
    ])
    await expect(cleanup).rejects.toMatchObject({ message: 'PASTE_NATIVE_CLEANUP_FAILED', errors: [
      { message: 'owner settlement' }, { message: 'worker exit' },
    ] })
    expect(calls).toEqual(['owner', 'worker', 'display', 'root'])
    await expect(cleanupPasteFixture([['done', () => {}]])).resolves.toBeUndefined()
  })
})
