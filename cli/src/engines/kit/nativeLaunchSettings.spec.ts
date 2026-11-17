import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prepareLaunchSettings } from './nativeLaunchSettings.js'
import { prepareNativeLaunchSettings } from '../../services/nativeLaunchSettings.js'
import type { LaunchSettingsInput } from './launchSettingsWire.js'
import type { NativeSetup } from './nativeSetup.js'

let root: string, dataDir: string, cwd: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'launch-settings-'))
  dataDir = join(root, 'data'); cwd = join(root, 'work')
  mkdirSync(dataDir); mkdirSync(cwd); mkdirSync(join(root, '.codex')); mkdirSync(join(root, '.claude'))
  writeFileSync(join(dataDir, 'agent-settings.json'), JSON.stringify({ machineId: 'machine', accountId: 'account', agentsStartAgents: true, pullRequestLine: true }))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
const options = () => ({ dataDir, runtimeNode: process.execPath, platform: 'darwin' as const, gitBash: null,
  owner: { machineId: 'machine', accountId: 'account' }, current: () => true })
const setup: Pick<NativeSetup, 'prepareFiles'> = { prepareFiles: async (input, _request, current) => prepareNativeLaunchSettings(input as LaunchSettingsInput, current) }

it('returns Codex instructions with no publication file and preserves the owner value', async () => {
  writeFileSync(join(root, '.codex', 'config.toml'), 'developer_instructions = "Keep mine."\n')
  const prepared = await prepareLaunchSettings('codex', { HOME: root }, cwd, setup, options())
  expect(prepared?.values.instructions).toMatch(/^Keep mine\.\n\nYou are running in Harness/)
  expect(prepared?.values.instructions).not.toContain('pull request')
  expect(prepared?.values.settings).toBeNull()
  expect(prepared?.current()).toBe(true)
  expect(existsSync(join(dataDir, 'statusline'))).toBe(false)
})

it('publishes exactly the selected Claude script and preserves nested statusLine settings', async () => {
  writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'echo owner', padding: 3, nested: { mine: true } }, permissions: { allow: [] } }))
  const prepared = await prepareLaunchSettings('claude', { HOME: root }, cwd, setup, options())
  expect(prepared?.current()).toBe(true)
  const settings = JSON.parse(prepared!.values.settings!)
  expect(Object.keys(settings)).toEqual(['statusLine'])
  expect(settings.statusLine).toMatchObject({ padding: 3, nested: { mine: true } })
  expect(settings.statusLine.command).toContain(join(dataDir, 'statusline', 'statusline.mjs'))
  expect(readFileSync(join(dataDir, 'statusline', 'statusline.mjs'), 'utf8')).toContain('rate_limits')
})

it.each(['source', 'owner'] as const)('omits optional values if %s changes while setup is answering', async change => {
  let current = true
  const prepareFiles = vi.fn(async (input, _request, active) => {
    const candidate = await prepareNativeLaunchSettings(input as LaunchSettingsInput, active)
    if (change === 'source') writeFileSync(join(dataDir, 'agent-settings.json'), '{}')
    else current = false
    return candidate
  })
  expect(await prepareLaunchSettings('claude', { HOME: root }, cwd, { prepareFiles }, { ...options(), current: () => current })).toBeNull()
  expect(existsSync(join(dataDir, 'statusline'))).toBe(false)
})

it('retains a final-use proof for both source and published script changes', async () => {
  const prepared = await prepareLaunchSettings('claude', { HOME: root }, cwd, setup, options())
  expect(prepared?.current()).toBe(true)
  writeFileSync(join(dataDir, 'statusline', 'statusline.mjs'), 'changed')
  expect(prepared?.current()).toBe(false)
})

it('keeps the engine launch independent of unavailable optional setup', async () => {
  expect(await prepareLaunchSettings('codex', { HOME: root }, cwd, {}, options())).toBeNull()
  expect(await prepareLaunchSettings('terminal', { HOME: root }, cwd, setup, options())).toBeNull()
})

it('returns Claude instructions without a dummy script when its own PowerShell status line is left alone', async () => {
  writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'pwsh -File mine.ps1' } }))
  const prepared = await prepareLaunchSettings('claude', { HOME: root }, cwd, setup, { ...options(), platform: 'win32' })
  expect(prepared?.values.instructions).toContain('You are running in Harness')
  expect(prepared?.values.settings).toBeNull()
  expect(prepared?.current()).toBe(true)
  expect(existsSync(join(dataDir, 'statusline'))).toBe(false)
})

it('invalidates prepared instructions when a captured ancestor config appears before argv use', async () => {
  const prepared = await prepareLaunchSettings('codex', { HOME: root }, cwd, setup, options())
  expect(prepared?.current()).toBe(true)
  mkdirSync(join(cwd, '.codex'))
  writeFileSync(join(cwd, '.codex', 'config.toml'), 'developer_instructions = "Workspace wins."\n')
  expect(prepared?.current()).toBe(false)
})

it('does not overwrite a script whose captured bytes changed while setup was preparing it', async () => {
  const script = join(dataDir, 'statusline', 'statusline.mjs')
  mkdirSync(join(dataDir, 'statusline')); writeFileSync(script, 'old')
  const prepareFiles = vi.fn(async (input, _request, current) => {
    const candidate = await prepareNativeLaunchSettings(input as LaunchSettingsInput, current)
    writeFileSync(script, 'new owner bytes')
    return candidate
  })
  expect(await prepareLaunchSettings('claude', { HOME: root }, cwd, { prepareFiles }, options())).toBeNull()
  expect(readFileSync(script, 'utf8')).toBe('new owner bytes')
})
