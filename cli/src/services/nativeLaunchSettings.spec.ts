import { describe, expect, it, vi } from 'vitest'
import { HARNESS_INSTRUCTIONS, prepareNativeLaunchSettings } from './nativeLaunchSettings.js'
import { joinedInstructions } from '../engines/kit/launchValues.js'
import type { LaunchSettingsInput } from '../engines/kit/launchSettingsWire.js'

const saved = { machineId: 'machine', accountId: 'account', agentsStartAgents: true, pullRequestLine: true }
const input = (engine: 'claude' | 'codex', changes: Partial<LaunchSettingsInput> = {}, settings = saved): LaunchSettingsInput => ({
  purpose: 'launchSettings', engine, environment: { HOME: '/fixture' }, cwd: null, dataDir: '/fixture/data',
  runtimeNode: '/fixture/node', platform: 'darwin', gitBash: null, owner: { machineId: 'machine', accountId: 'account' },
  sources: [{ file: '/fixture/data/agent-settings.json', content: JSON.stringify(settings) }, { file: '/fixture/.codex/config.toml', content: null }], files: [], ...changes,
})
const CODEX_TOLD = `${HARNESS_INSTRUCTIONS} Codex's sandbox cannot reach Harness: run each harness command outside it, with escalated permissions.`
describe('captured optional launch instructions', () => {
  it('returns no values for invalid inputs or cancelled preparation, including cancellation after rendering', async () => {
    expect(await prepareNativeLaunchSettings(input('codex'), () => false)).toBeNull()
    expect(await prepareNativeLaunchSettings(input('codex', { sources: [{ file: '/fixture', content: 'invalid\0' }] }), () => true)).toBeNull()
    expect(await prepareNativeLaunchSettings(input('codex'), vi.fn().mockReturnValueOnce(true).mockReturnValue(false))).toBeNull()
  })
  it('preserves the captured Claude status line properties in its single declared output', async () => {
    const given = input('claude', { owner: { machineId: 'machine' },
      sources: [{ file: '/fixture/data/agent-settings.json', content: null },
        { file: '/fixture/.claude/settings.json', content: '{"statusLine":{"type":"command","command":"owner-status","padding":2}}' }],
      files: [{ file: '/fixture/data/statusline/statusline.mjs', directory: '/fixture/data/statusline', content: null }],
    })
    const prepared = await prepareNativeLaunchSettings(given, () => true)
    expect(prepared?.values.instructions).toBeNull()
    expect(JSON.parse(prepared!.values.settings!)).toMatchObject({ statusLine: { type: 'command', padding: 2,
      command: expect.stringContaining('--then') } })
    expect(prepared?.files).toEqual([{ index: 0, content: expect.stringContaining('rate_limits') }])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await prepareNativeLaunchSettings({ ...given, platform: 'win32' }, () => true)).toEqual({ version: 1,
        values: { instructions: null, settings: null }, files: [] })
    } finally { warn.mockRestore() }
  })
  it.each(['claude', 'codex'] as const)('keeps legacy %s instructions and never revives the saved PR branding flag', async engine => {
    const candidate = await prepareNativeLaunchSettings(input(engine), () => true)
    expect(candidate?.values.instructions).toBe(engine === 'claude' ? HARNESS_INSTRUCTIONS : CODEX_TOLD)
    expect(candidate?.values.instructions).not.toContain('pull request')
    expect(candidate?.files).toEqual([])
    expect((await prepareNativeLaunchSettings(input(engine, {}, { ...saved, agentsStartAgents: false }), () => true))?.values.instructions).toBeNull()
  })
  it.each([null, { machineId: 'other', accountId: 'account' }, { machineId: 'machine', accountId: 'other' }])('applies no instructions for another owner or signed-out state', async owner => {
    expect((await prepareNativeLaunchSettings(input('codex', { owner }), () => true))?.values.instructions).toBeNull()
  })
  it('preserves and deduplicates the exact user Codex instruction', async () => {
    const given = input('codex')
    given.sources = [...given.sources.slice(0, 1), { file: '/fixture/.codex/config.toml', content: 'developer_instructions = "Keep mine."\n' }]
    expect((await prepareNativeLaunchSettings(given, () => true))?.values.instructions).toBe(`Keep mine.\n\n${CODEX_TOLD}`)
    given.sources = [...given.sources.slice(0, 1), { file: '/fixture/.codex/config.toml', content: `developer_instructions = ${JSON.stringify(CODEX_TOLD)}\n` }]
    expect((await prepareNativeLaunchSettings(given, () => true))?.values.instructions).toBeNull()
  })
  it('refuses uncaptured source data instead of treating it as an absent config', async () => {
    await expect(prepareNativeLaunchSettings(input('codex', { sources: [] }), () => true)).rejects.toThrow('LAUNCH_SETTINGS_SOURCE_MISSING')
  })
  it('joins only appended prompts and preserves other engine arguments', () => {
    expect(joinedInstructions('claude', ['--system-prompt-snapshot', 'off', '--append-system-prompt', 'grid', '--agent', 'x', '--append-system-prompt', 'ours']))
      .toEqual(['--system-prompt-snapshot', 'off', '--agent', 'x', '--append-system-prompt', 'grid\n\nours'])
    expect(joinedInstructions('claude', ['--append-system-prompt'])).toEqual(['--append-system-prompt'])
    expect(joinedInstructions('codex', ['-c', 'a=1', '-c', 'a=2'])).toEqual(['-c', 'a=1', '-c', 'a=2'])
  })
})
