// A Member's or crew member's folder on a Windows machine (task #4698): git runs with no window, ever (docs/windows-rules.md).
// The host is a hidden process, so a console program it starts without windowsHide opens a console of its own and flashes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => [] as Array<Record<string, unknown>>)
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  execFile: (_file: string, _args: string[], options: Record<string, unknown>, done: (error: Error | null, out: { stdout: string; stderr: string }) => void) => {
    calls.push(options)
    done(null, { stdout: '', stderr: '' })
  },
}))
const { pruneBranches } = await import('./crewFolders.js')

describe('a crew folder\'s git on Windows', () => {
  const platform = process.platform
  beforeEach(() => { calls.length = 0; Object.defineProperty(process, 'platform', { value: 'win32' }) })
  afterEach(() => { Object.defineProperty(process, 'platform', { value: platform }) })

  it('runs every git call hidden and never detached', async () => {
    await pruneBranches('C:\\Users\\dev\\harnesses\\worktrees\\project\\member')
    expect(calls.length).toBeGreaterThan(0)
    for (const options of calls) {
      expect(options.windowsHide).toBe(true)
      expect(options.detached).toBeUndefined()
    }
  })
})
