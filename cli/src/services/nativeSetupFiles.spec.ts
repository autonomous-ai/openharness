import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import { prepareNativeHookFiles } from './nativeSetupFiles.js'
import { createLocalNativeSetup } from './nativeSetup.js'
import type { NativeHookInput, NativeHookCandidate } from '../engines/kit/nativeHookWire.js'
import type { AgentEngine } from '../engines/types.js'
import * as windows from '../engines/kit/windowsFiles.js'
import * as script from '../engines/kit/hookScript.js'
import { HookScriptMissing } from '../engines/kit/hookHeld.js'

// These are candidate-byte fixtures, including POSIX Messages; platform cases below select their runner explicitly.
beforeEach(() => vi.spyOn(windows, 'hostPlatform').mockReturnValue('linux'))
afterEach(() => vi.restoreAllMocks())

function captured(engine: AgentEngine): NativeHookInput {
  const home = join(env.ADAPTER_DATA_DIR, `render-${engine}`)
  const names = engine === 'claude' ? [join(home, 'settings.json'), join(env.HARNESS_AGENT_MESSAGES_DIR, 'hook.mjs')]
    : engine === 'codex' ? [join(home, 'hooks.json'), join(home, 'config.toml'), join(home, 'rules', 'harness.rules'), join(env.HARNESS_AGENT_MESSAGES_DIR, 'hook.mjs')]
    : engine === 'hermes' ? [join(home, 'config.yaml'), join(home, 'shell-hooks-allowlist.json')]
    : engine === 'opencode' ? [join(home, 'plugin', 'launcher-register.js'), join(home, 'plugins', 'launcher-register', 'tui.js')]
    : [join(home, 'configuration')]
  return { engine, port: 1234, environment: { HOME: env.ADAPTER_DATA_DIR, CLAUDE_CONFIG_DIR: home, CODEX_HOME: home, HERMES_HOME: home },
    files: names.map(file => ({ file, directory: dirname(file), content: null, mode: 0o600 })),
    ...(engine === 'amp' ? { directories: [{ path: env.AMP_SESSIONS_DIR, mode: 0o700 }] } : {}),
    ...(engine === 'hermes' ? { createMissing: true } : {}),
  }
}
const withCandidate = (input: NativeHookInput, candidate: NativeHookCandidate): NativeHookInput => ({ ...input,
  files: input.files.map((file, index) => ({ ...file, content: candidate.files[index].content })),
})

it.each(['claude', 'codex', 'agy', 'commandcode', 'copilot', 'cursor', 'devin', 'grok', 'amp', 'kilo', 'pi'] as const)
  ('renders complete %s candidates through the local worker composition, with stable bytes and no native writes', async engine => {
    const input = captured(engine), setup = createLocalNativeSetup(env.ADAPTER_DATA_DIR)
    const result = await setup.prepareFiles!(input, 'render', () => true)
    expect(result).not.toBeNull()
    expect(result!.files).toHaveLength(input.files.length)
    expect(result!.files[0].content).toMatch(/notify\.mjs|harnessFetch/)
    expect(result!.files.every((file, index) => file.index === index && typeof file.content === 'string')).toBe(true)
    expect(await setup.prepareFiles!(withCandidate(input, result!), 'unchanged', () => true)).toEqual(result)
    expect(input.files.every(file => file.content === null && !existsSync(file.file))).toBe(true)
  })

it('prepares OpenCode version changes atomically in memory and never removes another author’s plugin', async () => {
  const input = { ...captured('opencode'), major: 1 }
  const legacy = await prepareNativeHookFiles(input, () => true)
  expect(legacy!.files[0].content).toContain('export const MachineRegister')
  expect(legacy!.files[1].content).toContain('OpenCode 2 TUI')
  const modern = await prepareNativeHookFiles({ ...withCandidate(input, legacy!), major: 2 }, () => true)
  expect(modern!.files[0].content).toBeNull()
  expect(modern!.files[1].content).toBe(legacy!.files[1].content)
  const foreign = { ...input, major: 2, files: input.files.map((file, index) => ({ ...file, content: index ? null : '// authored elsewhere\n' })) }
  expect(await prepareNativeHookFiles(foreign, () => true)).toBeNull()
  expect(foreign.files[0].content).toBe('// authored elsewhere\n')
  expect(input.files.every(file => !existsSync(file.file))).toBe(true)
})

it.each(['linux', 'win32'] as const)('renders Hermes command approvals for %s while preserving the native configuration', async platform => {
  vi.spyOn(windows, 'hostPlatform').mockReturnValue(platform)
  const input = captured('hermes')
  const result = await prepareNativeHookFiles(input, () => true)
  expect(result!.files[0].content).toContain('on_session_start:')
  expect(result!.files[0].content).toContain('notify.mjs')
  expect(JSON.parse(result!.files[1].content!).approvals).toEqual(expect.arrayContaining([
    expect.objectContaining({ event: 'on_session_start', command: expect.stringContaining('--engine hermes') }),
  ]))
  const recorded = await prepareNativeHookFiles({ ...withCandidate(input, result!), keepsRecord: true }, () => true)
  if (platform === 'win32') expect(recorded).toEqual(result)
  else expect(recorded!.files[0].content).not.toContain('on_session_start:')
  expect(input.files.every(file => !existsSync(file.file))).toBe(true)
})

it('keeps Hermes TUI hooks and alias targets unchanged when cleanup cannot own them', async () => {
  const input = captured('hermes')
  input.files = input.files.map((file, index) => ({ ...file, content: index ? null : 'display:\n  interface: TUI\n' }))
  const tui = await prepareNativeHookFiles({ ...input, keepsRecord: true }, () => true)
  expect(tui!.files[0].content).toContain('on_session_start:')
  expect(await prepareNativeHookFiles({ ...withCandidate(input, tui!), remove: true }, () => true)).toEqual(tui)
  const normal = await prepareNativeHookFiles(captured('hermes'), () => true)
  const alias = withCandidate(captured('hermes'), normal!)
  alias.files = alias.files.map(file => ({ ...file, alias: true }))
  expect(await prepareNativeHookFiles({ ...alias, remove: true }, () => true)).toEqual(normal)
})

it('holds incomplete Hermes configuration, unsupported engines, and work whose owner changes after rendering', async () => {
  expect(await prepareNativeHookFiles({ ...captured('hermes'), createMissing: false }, () => true)).toBeNull()
  expect(await prepareNativeHookFiles(captured('terminal'), () => true)).toBeNull()
  const current = vi.fn(() => true)
  const candidate = await import('./hookCandidates.js'), original = candidate.createHookCandidates
  vi.spyOn(candidate, 'createHookCandidates').mockImplementation((input, owner) => {
    const result = original(input, owner), run = result.files.run
    result.files.run = async (...args) => { const value = await run(...args); current.mockReturnValue(false); return value }
    return result
  })
  expect(await prepareNativeHookFiles(captured('grok'), current)).toBeNull()
})

it('reports unavailable notify artifacts as the named missing-script refusal', async () => {
  vi.spyOn(script, 'requireHookScript').mockImplementation(() => { throw new HookScriptMissing('/fixture/notify.mjs') })
  vi.spyOn(script, 'missingHookScript').mockReturnValue('/fixture/notify.mjs')
  await expect(prepareNativeHookFiles(captured('hermes'), () => true)).rejects.toBeInstanceOf(HookScriptMissing)
})

it('renders Claude configuration and Messages bytes without creating native files or claiming installation', async () => {
  const home = join(env.ADAPTER_DATA_DIR, 'candidate-only'), file = join(home, 'settings.json')
  const input = { engine: 'claude' as const, port: 1234,
    environment: { HOME: env.ADAPTER_DATA_DIR, CLAUDE_CONFIG_DIR: home },
    files: [{ file, directory: home, content: '{"model":"keep-me"}', mode: 0o600 },
      { file: join(env.HARNESS_AGENT_MESSAGES_DIR, 'hook.mjs'), directory: env.HARNESS_AGENT_MESSAGES_DIR, content: null, mode: 0o700 }] }
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    const result = await prepareNativeHookFiles(input, () => true)
    expect(JSON.parse(result!.files[0].content!)).toMatchObject({ model: 'keep-me', hooks: { SessionStart: expect.any(Array) } })
    expect(result!.files[1].content).toContain('Agent Messages')
    expect(existsSync(file)).toBe(false)
    expect(log).not.toHaveBeenCalled()
    expect(await prepareNativeHookFiles(input, () => false)).toBeNull()
    expect(await prepareNativeHookFiles({ ...input, files: [{ ...input.files[0], content: '{broken' }, input.files[1]] }, () => true)).toBeNull()
    expect(existsSync(file)).toBe(false)
  } finally { log.mockRestore() }
})
