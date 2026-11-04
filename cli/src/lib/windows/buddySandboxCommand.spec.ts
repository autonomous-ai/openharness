import { describe, expect, it, vi } from 'vitest'
import { buddySandboxCommand, removeBuddySandbox } from './buddySandboxCommand.js'

function setup(over: Record<string, unknown> = {}) {
  const out: string[] = [], errors: string[] = []
  const runtime = { install: vi.fn(async () => 'installed' as const), uninstall: vi.fn(async () => {}) }
  const mark = vi.fn(), forget = vi.fn()
  return { out, errors, runtime, mark, forget,
    deps: { platform: 'win32' as NodeJS.Platform, team: () => false, home: () => '/h', binary: () => 'C:\\pty\\srt-win.exe', ready: () => false, mark, forget, runtime,
      out: (line: string) => out.push(line), err: (line: string) => errors.push(line), ...over } }
}

describe('harness buddy-sandbox', () => {
  it('installs with the closed places left out, and marks it only when that finished', async () => {
    const f = setup()
    expect(await buddySandboxCommand(['install'], f.deps)).toBe(0)
    const [srtWin, excludes] = f.runtime.install.mock.calls[0] as unknown as [string, string[]]
    expect(srtWin).toBe('C:\\pty\\srt-win.exe')
    expect(excludes).toEqual(expect.arrayContaining(['/h/.ssh', '/h/.aws', '/h/AppData/Roaming/Microsoft/Credentials', '/h/AppData/Local/Google/Chrome/User Data']))
    // The tools' own sign-ins stay readable to the tools, as on a Mac; its guard keeps them from the Buddy's own reads.
    expect(excludes).not.toContain('/h/AppData/Roaming/GitHub CLI')
    expect(excludes).not.toContain('/h/.kube')
    expect(f.mark).toHaveBeenCalled()
    expect(f.out.at(-1)).toContain('next start')
  })

  it('marks nothing when the person says no to Windows, or it fails', async () => {
    const no = setup()
    no.runtime.install.mockResolvedValueOnce('cancelled' as never)
    expect(await buddySandboxCommand(['install'], no.deps)).toBe(1)
    expect(no.mark).not.toHaveBeenCalled()
    expect(no.errors[0]).toContain('own folder')
    const broken = setup()
    broken.runtime.install.mockRejectedValueOnce(new Error('no fence'))
    expect(await buddySandboxCommand(['install'], broken.deps)).toBe(1)
    expect(broken.mark).not.toHaveBeenCalled()
    expect(broken.errors[0]).toContain('no fence')
  })

  it('never installs in a Team account, off Windows, or without the helper', async () => {
    for (const over of [{ team: () => true }, { platform: 'darwin' }, { binary: () => null }]) {
      const f = setup(over)
      expect(await buddySandboxCommand(['install'], f.deps)).toBe(1)
      expect(f.runtime.install).not.toHaveBeenCalled()
    }
  })

  it('says whether it is ready, and removes itself', async () => {
    const f = setup({ ready: () => true })
    expect(await buddySandboxCommand(['status'], f.deps)).toBe(0)
    expect(f.out).toEqual(['ready'])
    expect(await buddySandboxCommand(['uninstall'], f.deps)).toBe(0)
    expect(f.runtime.uninstall).toHaveBeenCalled()
    expect(f.forget).toHaveBeenCalled()
    expect(await buddySandboxCommand(['nope'], f.deps)).toBe(2)
  })

  it('leaves with Harness, asking Windows only when it was installed', async () => {
    const none = setup()
    expect(await removeBuddySandbox(none.deps)).toBe(false)
    expect(none.runtime.uninstall).not.toHaveBeenCalled()
    const installed = setup({ ready: () => true })
    expect(await removeBuddySandbox(installed.deps)).toBe(true)
    expect(installed.runtime.uninstall).toHaveBeenCalled()
    expect(installed.forget).toHaveBeenCalled()
  })
})
