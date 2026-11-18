import { describe, expect, it, vi } from 'vitest'
import { HARNESS_INSTRUCTIONS, renderLaunchSettings } from './nativeLaunchSettings.js'
import { joinedInstructions } from '../engines/kit/launchValues.js'
import type { LaunchSettingsInput } from '../engines/kit/launchSettingsWire.js'

type Captured = LaunchSettingsInput & { dataDir: string; sources: { file: string; content: string | null }[]; files: { file: string; directory: string; content: string | null }[] }
const prepare = (given: Captured) => renderLaunchSettings(given, given.dataDir, file => given.sources.find(source => source.file === file)?.content ?? null)
const saved = { machineId: 'machine', accountId: 'account', agentsStartAgents: true, pullRequestLine: true }
const input = (engine: 'claude' | 'codex', changes: Partial<Captured> = {}, settings = saved): Captured => ({
  purpose: 'launchSettings', version: 2, engine, environment: { HOME: '/fixture' }, cwd: null, dataDir: '/fixture/data',
  runtimeNode: '/fixture/node', platform: 'darwin', gitBash: null, owner: { machineId: 'machine', accountId: 'account' },
  sources: [{ file: '/fixture/data/agent-settings.json', content: JSON.stringify(settings) }, { file: '/fixture/.codex/config.toml', content: null }], files: [], ...changes,
})
const CODEX_TOLD = `${HARNESS_INSTRUCTIONS} Codex's sandbox cannot reach Harness: run each harness command outside it, with escalated permissions.`
describe('captured optional launch instructions', () => {
  it('preserves the captured Claude status line properties in its single declared output', async () => {
    const given = input('claude', { owner: { machineId: 'machine' },
      sources: [{ file: '/fixture/data/agent-settings.json', content: null },
        { file: '/fixture/.claude/settings.json', content: '{"statusLine":{"type":"command","command":"owner-status","padding":2}}' }],
      files: [{ file: '/fixture/data/statusline/statusline.mjs', directory: '/fixture/data/statusline', content: null }],
    })
    const prepared = await prepare(given)
    expect(prepared?.values.instructions).toBeNull()
    expect(JSON.parse(prepared!.values.settings!)).toMatchObject({ statusLine: { type: 'command', padding: 2,
      command: expect.stringContaining('--then') } })
    expect(prepared).not.toHaveProperty('files')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await prepare({ ...given, platform: 'win32' })).toEqual({ version: 2,
        values: { instructions: null, settings: null } })
    } finally { warn.mockRestore() }
  })
  it.each(['claude', 'codex'] as const)('keeps legacy %s instructions and never revives the saved PR branding flag', async engine => {
    const candidate = await prepare(input(engine))
    expect(candidate?.values.instructions).toBe(engine === 'claude' ? HARNESS_INSTRUCTIONS : CODEX_TOLD)
    expect(candidate?.values.instructions).not.toContain('pull request')
    expect(candidate).not.toHaveProperty('files')
    expect((await prepare(input(engine, {}, { ...saved, agentsStartAgents: false })))?.values.instructions).toBeNull()
  })
  it.each([null, { machineId: 'other', accountId: 'account' }, { machineId: 'machine', accountId: 'other' }])('applies no instructions for another owner or signed-out state', async owner => {
    expect((await prepare(input('codex', { owner })))?.values.instructions).toBeNull()
  })
  it('preserves and deduplicates the exact user Codex instruction', async () => {
    const given = input('codex')
    given.sources = [...given.sources.slice(0, 1), { file: '/fixture/.codex/config.toml', content: 'developer_instructions = "Keep mine."\n' }]
    expect((await prepare(given))?.values.instructions).toBe(`Keep mine.\n\n${CODEX_TOLD}`)
    given.sources = [...given.sources.slice(0, 1), { file: '/fixture/.codex/config.toml', content: `developer_instructions = ${JSON.stringify(CODEX_TOLD)}\n` }]
    expect((await prepare(given))?.values.instructions).toBeNull()
  })
  it('joins only appended prompts and preserves other engine arguments', () => {
    expect(joinedInstructions('claude', ['--system-prompt-snapshot', 'off', '--append-system-prompt', 'grid', '--agent', 'x', '--append-system-prompt', 'ours']))
      .toEqual(['--system-prompt-snapshot', 'off', '--agent', 'x', '--append-system-prompt', 'grid\n\nours'])
    expect(joinedInstructions('claude', ['--append-system-prompt'])).toEqual(['--append-system-prompt'])
    expect(joinedInstructions('codex', ['-c', 'a=1', '-c', 'a=2'])).toEqual(['-c', 'a=1', '-c', 'a=2'])
  })
})
