import { describe, expect, it, vi } from 'vitest'
import { routedInvocation, shellLaunch } from './shellLaunch.js'
import { ENGINE_CLI_COMMANDS, PROCESS_ENGINES } from './lib/engineBin.js'
import { engineInstallRecipe } from './lib/engineInstall.js'
import { readFileSync } from 'node:fs'
const target = { networkId: 'test-grid', networkName: 'Test', baseUrl: 'http://127.0.0.1:19999/v1', apiKey: 'test-secret-never-on-argv', model: 'test/model' }
describe('shell model launch', () => {
  it.each(['codex', 'claude'] as const)('routes %s without changing native arguments or leaking its key', (engine) => {
    const args = ['task with spaces; $(do not execute)', '--unrelated=value']
    const launch = routedInvocation(engine, target, args, { PATH: '/bin', OPENAI_API_KEY: 'old-provider', ANTHROPIC_API_KEY: 'old-provider' })
    expect(launch.args.slice(-2)).toEqual(args)
    expect(launch.args.join(' ')).not.toContain(target.apiKey)
    expect(Object.values(launch.env)).toContain(target.apiKey)
    expect(Object.values(launch.env)).not.toContain('old-provider')
  })
  it('does not launch when the route disappears or credential lookup fails', async () => {
    const run = vi.fn(), error = vi.fn()
    for (const resolve of [vi.fn().mockResolvedValue(null), vi.fn().mockRejectedValue(new Error(target.apiKey))]) {
      expect(await shellLaunch(['codex', 'test', 'model', '--'], { resolve, run, error })).toBe(1)
    }
    expect(run).not.toHaveBeenCalled()
    expect(JSON.stringify(error.mock.calls)).not.toContain(target.apiKey)
  })
  it('preserves exit status and validates before looking up credentials', async () => {
    const resolve = vi.fn().mockResolvedValue(target), run = vi.fn().mockResolvedValue(23), error = vi.fn()
    expect(await shellLaunch(['codex','test','model','--','hello'], {resolve,run,error})).toBe(23)
    resolve.mockClear()
    expect(await shellLaunch(['terminal','test','model','--'], {resolve,run,error})).toBe(2)
    expect(await shellLaunch(['codex','test','bad\nmodel','--'], {resolve,run,error})).toBe(2)
    expect(resolve).not.toHaveBeenCalled()
  })
  it.each(PROCESS_ENGINES)('keeps %s native defaults and exact arguments when installing a missing agent', async (engine) => {
    const resolve = vi.fn(), run = vi.fn().mockResolvedValue(7), error = vi.fn()
    expect(await shellLaunch([engine,'--native','--','--model','chosen','a task; $(literal)'],{resolve,run,error})).toBe(7)
    expect(resolve).not.toHaveBeenCalled()
    expect(run.mock.calls[0][0]).toBe('/bin/sh')
    expect(run.mock.calls[0][1].slice(-3)).toEqual(['--model','chosen','a task; $(literal)'])
    expect(run.mock.calls[0][1][1]).toContain(engineInstallRecipe(engine)!.command)
    expect(error).not.toHaveBeenCalled()
  })
  it.each(PROCESS_ENGINES.filter(engine => engine !== 'codex' && engine !== 'claude'))('does not silently ignore a selected route for %s', async (engine) => {
    const resolve = vi.fn(), run = vi.fn(), error = vi.fn()
    expect(await shellLaunch([engine,'grid','model','--'],{resolve,run,error})).toBe(2)
    expect(resolve).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('cm default'))
  })
  it('exposes every supported unambiguous command in the shell helpers', () => {
    const helpers = readFileSync(new URL('../../tui/src/shell_integration.sh', import.meta.url), 'utf8')
    for (const engine of PROCESS_ENGINES) {
      expect(helpers).toContain(`function ${ENGINE_CLI_COMMANDS[engine]} { _hn_agent ${engine} "$@"; }`)
    }
    expect(helpers).not.toContain('function agent ')
  })
})
