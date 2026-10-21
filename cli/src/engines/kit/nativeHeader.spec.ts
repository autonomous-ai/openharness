// A Codex rollout's first record names the folder its session started in. On Windows that folder is a drive path: the
// header check took only a POSIX path as absolute, so every Windows Codex SessionStart was held ("the native rollout
// header is invalid") and no Codex pane bound its conversation (B4.15, the Windows VM).
import { describe, expect, it } from 'vitest'
import { sessionStoreContracts } from '../sessionStoreContracts.js'
import { nativeSessionMeta } from './nativeHeader.js'

const first = sessionStoreContracts.codex.first!
const header = (cwd: string) => JSON.stringify({ type: 'session_meta', payload: { id: '01a14b33-0000-7000-8000-000000000001', cwd, source: 'cli' } })

describe('a Codex rollout header', () => {
  it('names a session folder on a Windows drive', () => {
    expect(nativeSessionMeta(header('C:\\work\\b4\\proj'), first, 'win32'))
      .toEqual({ id: '01a14b33-0000-7000-8000-000000000001', isSubagent: false, parentThreadId: null, cwd: 'C:\\work\\b4\\proj' })
  })

  it('still takes only an absolute folder of the platform it is read on', () => {
    expect(nativeSessionMeta(header('/Users/a/proj'), first, 'darwin').cwd).toBe('/Users/a/proj')
    expect(nativeSessionMeta(header('d:/work/proj'), first, 'win32').cwd).toBe('d:/work/proj')
    // On Windows only a drive path: a UNC share, a rooted path with no drive, a POSIX path and a \\?\ path are refused.
    for (const [cwd, platform] of [['C:\\work\\proj', 'linux'], ['work\\proj', 'win32'], ['proj', 'darwin'],
      ['\\\\srv\\share\\p', 'win32'], ['\\p', 'win32'], ['/p', 'win32'], ['\\\\?\\C:\\p', 'win32'], ['C:p', 'win32']] as const) {
      expect(() => nativeSessionMeta(header(cwd), first, platform)).toThrow('the native rollout header is invalid')
    }
  })
})
