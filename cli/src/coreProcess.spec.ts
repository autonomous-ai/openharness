import { describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => [] as string[])
const home = vi.hoisted(() => ({ line: null as string | null }))
vi.mock('./core/main.js', () => ({ runCore: vi.fn((script: string) => { calls.push(`runCore ${script}`) }) }))
vi.mock('./lib/childLocale.js', () => ({ ensureUtf8Locale: vi.fn(() => { calls.push('ensureUtf8Locale') }) }))
vi.mock('./lib/launchers.js', () => ({ ensureHnLauncher: vi.fn((script: string) => { calls.push(`ensureHnLauncher ${script}`); return false }) }))
vi.mock('./lib/workingFolder.js', () => ({ enterHome: vi.fn(() => { calls.push('enterHome'); return home.line }) }))

const { startCoreProcess } = await import('./coreProcess.js')

describe('the core\'s process, however it is started', () => {
  it('enters the home, does what cli.ts does first for every command, then runs the core for the CLI it names', () => {
    calls.length = 0
    startCoreProcess('/home/me/.harness/cli/cli.js')
    expect(calls).toEqual(['enterHome', 'ensureUtf8Locale', 'ensureHnLauncher /home/me/.harness/cli/cli.js', 'runCore /home/me/.harness/cli/cli.js'])
  })

  it('says why the home could not be entered', () => {
    home.line = '[start] sentinel line'
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      startCoreProcess('/home/me/.harness/cli/cli.js')
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/ \[start\] sentinel line$/))
    } finally { log.mockRestore(); home.line = null }
  })
})
