import { afterEach, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import type { InlineRuntimeContext } from '../facets/inlineRuntime.js'
import { blankRuntimeState } from '../kit/runtime.js'

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: vi.fn((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error, stdout: string, stderr: string) => void
    const privateOutput = 'PRIVATE_NATIVE_OUTPUT /private/home/secret token=sentinel'
    callback(Object.assign(new Error(`Command failed: ${privateOutput}`), { stdout: privateOutput, stderr: privateOutput }), '', privateOutput)
    return {}
  }),
}))
afterEach(() => vi.restoreAllMocks())

it.each(['opencode', 'pi', 'kilo', 'devin', 'commandcode', 'cursor'] as const)('%s names a catalog failure without logging native error content', async engine => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const loads = { opencode: () => import('../opencode/profileReader.js'), pi: () => import('../pi/profileReader.js'),
    kilo: () => import('../kilo/profileReader.js'), devin: () => import('../devin/profileReader.js'),
    commandcode: () => import('../commandcode/profileReader.js'), cursor: () => import('../cursor/profileReader.js') }
  const module = await loads[engine]()
  const context = { session: { agentId: 'agent', sessionId: 'session', engine, cliVersion: null },
    state: blankRuntimeState(), refreshConfig: () => {} } as InlineRuntimeContext
  expect(await module.createRuntimeProfileReader().models!(context)).toEqual([])
  expect(execFile).toHaveBeenCalled()
  expect(warn.mock.calls).toEqual([[`[runtime-profile] ${engine.toUpperCase()}_CATALOG_UNAVAILABLE`]])
  expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE_NATIVE_OUTPUT')
})
