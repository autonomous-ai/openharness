import { describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => [] as string[])
vi.mock('./core/main.js', () => ({ runCore: vi.fn((script: string) => { calls.push(`runCore ${script}`) }) }))
vi.mock('./lib/childLocale.js', () => ({ ensureUtf8Locale: vi.fn(() => { calls.push('ensureUtf8Locale') }) }))
vi.mock('./lib/launchers.js', () => ({ ensureHnLauncher: vi.fn((script: string) => { calls.push(`ensureHnLauncher ${script}`); return false }) }))

const { startCoreProcess } = await import('./coreProcess.js')

describe('the core\'s process, however it is started', () => {
  it('does what cli.ts does first for every command, then runs the core for the CLI it names', () => {
    startCoreProcess('/home/me/.harness/cli/cli.js')
    expect(calls).toEqual(['ensureUtf8Locale', 'ensureHnLauncher /home/me/.harness/cli/cli.js', 'runCore /home/me/.harness/cli/cli.js'])
  })
})
