import { describe, expect, it, vi } from 'vitest'
import { routedInvocation, shellLaunch } from './shellLaunch.js'
import { ENGINE_CLI_COMMANDS, PROCESS_ENGINES } from './lib/engineBin.js'
import { engineInstallRecipe } from './lib/engineInstall.js'
import { readFileSync } from 'node:fs'
const target = { networkId: 'test-grid', networkName: 'Test', baseUrl: 'http://127.0.0.1:19999/v1', apiKey: 'test-secret-never-on-argv', model: 'test/model' }
/** A config writer that keeps the files in memory and names a directory under /grid-config. */
function memoryWriter() {
  const written = new Map<string, Array<{ name: string; content: string }>>()
  const writeConfig = vi.fn(async (key: string, files: readonly { name: string; content: string }[]) => {
    written.set(key, [...files])
    return `/grid-config/${key}`
  })
  return { written, writeConfig }
}
describe('shell model launch', () => {
  it.each(['codex', 'claude'] as const)('routes %s without changing native arguments or leaking its key', async (engine) => {
    const args = ['task with spaces; $(do not execute)', '--unrelated=value']
    const { writeConfig } = memoryWriter()
    const launch = await routedInvocation(engine, target, args, { PATH: '/bin', OPENAI_API_KEY: 'old-provider', ANTHROPIC_API_KEY: 'old-provider' }, writeConfig)
    expect(launch.args.slice(-2)).toEqual(args)
    expect(launch.args.join(' ')).not.toContain(target.apiKey)
    expect(Object.values(launch.env)).toContain(target.apiKey)
    expect(Object.values(launch.env)).not.toContain('old-provider')
  })
  it('gives Codex on a grid model its card from a directory Harness owns, the key never in it', async () => {
    const { written, writeConfig } = memoryWriter()
    const launch = await routedInvocation('codex', target, ['hello'], { PATH: '/bin' }, writeConfig)
    const [key, files] = [...written.entries()][0]
    const at = launch.args.indexOf(`model_catalog_json="/grid-config/${key}/model-catalog.json"`)
    expect(launch.args[at - 1]).toBe('-c')
    expect(launch.args.slice(-1)).toEqual(['hello'])
    const card = JSON.parse(files[0].content).models[0]
    expect(card).toMatchObject({ slug: 'test/model', supports_search_tool: true })
    expect(files[0].content).not.toContain(target.apiKey)
    // The same route writes the same directory again.
    await routedInvocation('codex', target, [], { PATH: '/bin' }, writeConfig)
    expect(written.size).toBe(1)
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
    const { writeConfig } = memoryWriter()
    expect(await shellLaunch(['codex','test','model','--','hello'], {resolve,run,error,writeConfig})).toBe(23)
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
  it('runs Codex typed at a prompt on the screen Harness chose for it, and Claude Code as the person set it up', async () => {
    const resolve = vi.fn().mockResolvedValue(target), run = vi.fn().mockResolvedValue(0), error = vi.fn()
    const { writeConfig } = memoryWriter()
    const binaryAt = (call: unknown[]) => (call[1] as string[]).indexOf('harness-shell-agent') + 2
    await shellLaunch(['codex','--native','--','resume','sess-1'], {resolve,run,error,writeConfig})
    const native = run.mock.calls[0]
    expect((native[1] as string[]).slice(binaryAt(native))).toEqual(['-c','tui.fullscreen_transcript=false','resume','sess-1'])
    await shellLaunch(['codex','test','model','--','hello'], {resolve,run,error,writeConfig})
    expect((run.mock.calls[1][1] as string[]).slice(-3)).toEqual(['-c','tui.fullscreen_transcript=false','hello'])
    vi.stubEnv('CLAUDE_CODE_NO_FLICKER', '0')
    try {
      await shellLaunch(['claude','--native','--'], {resolve,run,error})
      await shellLaunch(['claude','test','model','--'], {resolve,run,error})
    } finally { vi.unstubAllEnvs() }
    for (const call of run.mock.calls.slice(2)) {
      expect(call[2]).toMatchObject({ CLAUDE_CODE_NO_FLICKER: '0' })
      expect(call[2]).not.toHaveProperty('CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN')
    }
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
