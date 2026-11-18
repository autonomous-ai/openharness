import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareLaunchSettings } from './nativeLaunchSettings.js'
import { prepareNativeLaunchSettings } from '../../services/nativeLaunchSettings.js'
import type { LaunchSettingsInput } from './launchSettingsWire.js'
import type { NativeSetup } from './nativeSetup.js'
import { statusLineScript } from './statusLine.js'
import { launchSettingsArgs } from './launchValues.js'

const effects = vi.hoisted(() => ({ active: false, flushes: 0, writes: 0 }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, fsync: (...args: Parameters<typeof fs.fsync>) => {
    if (effects.active) effects.flushes++
    return fs.fsync(...args)
  }, writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
    if (effects.active) effects.writes++
    return fs.writeFileSync(...args)
  } }
})

let root: string, dataDir: string, cwd: string
beforeEach(() => {
  effects.active = false; effects.flushes = 0; effects.writes = 0
  root = mkdtempSync(join(tmpdir(), 'launch-settings-'))
  dataDir = join(root, 'data'); cwd = join(root, 'work')
  mkdirSync(dataDir); mkdirSync(cwd); mkdirSync(join(root, '.codex')); mkdirSync(join(root, '.claude'))
  writeFileSync(join(dataDir, 'agent-settings.json'), JSON.stringify({ machineId: 'machine', accountId: 'account', agentsStartAgents: true, pullRequestLine: true }))
})
afterEach(() => { effects.active = false; rmSync(root, { recursive: true, force: true }) })
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


describe('read-existing optional artifact', () => {
  const existing = (content = statusLineScript()) => {
    const directory = join(dataDir, 'statusline'), script = join(directory, 'statusline.mjs')
    mkdirSync(directory); writeFileSync(script, content, { mode: 0o600 })
    return script
  }
  const prepare = () => prepareLaunchSettings('claude', { HOME: root }, cwd, setup, options())

  it('uses a freshly verified identical output without another publication or flush', async () => {
    const first = await prepare()
    expect(first?.current()).toBe(true)
    effects.active = true
    const second = await prepare()
    effects.active = false
    expect(second?.values).toEqual(first?.values)
    expect(second?.current()).toBe(true)
    expect(first?.current()).toBe(true)
    expect(effects).toMatchObject({ writes: 0, flushes: 0 })
  })

  it('reads an identical pre-existing read-only script without claiming publication', async () => {
    const script = existing(); chmodSync(script, 0o400)
    effects.active = true
    const prepared = await prepare()
    effects.active = false
    expect(prepared?.current()).toBe(true)
    expect(readFileSync(script, 'utf8')).toBe(statusLineScript())
    expect(effects).toMatchObject({ writes: 0, flushes: 0 })
  })

  it('omits values after a same-byte output replacement during the worker wait', async () => {
    const script = existing(), replacement = join(dataDir, 'replacement.mjs')
    const prepareFiles: NonNullable<NativeSetup['prepareFiles']> = async (input, request, current) => {
      const candidate = await setup.prepareFiles!(input, request, current)
      writeFileSync(replacement, statusLineScript(), { mode: 0o600 }); renameSync(replacement, script)
      return candidate
    }
    expect(await prepareLaunchSettings('claude', { HOME: root }, cwd, { prepareFiles }, options())).toBeNull()
    expect(readFileSync(script, 'utf8')).toBe(statusLineScript())
  })

  it.each(['source', 'output', 'same-byte output', 'ancestor', 'owner'] as const)(
    'omits optional final arguments when the retained %s changes', async change => {
      const script = existing(); let current = true
      const prepared = await prepareLaunchSettings('claude', { HOME: root }, cwd, setup, { ...options(), current: () => current })
      expect(prepared?.current()).toBe(true)
      if (change === 'source') writeFileSync(join(dataDir, 'agent-settings.json'), '{}')
      else if (change === 'output') writeFileSync(script, 'changed')
      else if (change === 'same-byte output') {
        const replacement = join(dataDir, 'replacement.mjs')
        writeFileSync(replacement, statusLineScript()); renameSync(replacement, script)
      } else if (change === 'ancestor') {
        renameSync(join(dataDir, 'statusline'), join(dataDir, 'displaced')); existing()
      } else current = false
      expect(prepared?.current()).toBe(false)
      const base = ['--settings', '{"hooks":{"keep":[]}}', '--append-system-prompt', 'keep']
      expect(launchSettingsArgs('claude', base, prepared)).toEqual(base)
    })

  it('recreates a later missing script through durable indexed publication', async () => {
    const script = existing(), retained = await prepare()
    expect(retained?.current()).toBe(true)
    rmSync(script); expect(retained?.current()).toBe(false)
    effects.active = true
    const recreated = await prepare()
    effects.active = false
    expect(recreated?.current()).toBe(true)
    expect(readFileSync(script, 'utf8')).toBe(statusLineScript())
    expect(effects.writes).toBeGreaterThan(0)
    expect(effects.flushes).toBeGreaterThan(0)
  })

  it('publishes different captured bytes through the existing durable path', async () => {
    const script = existing('old release')
    effects.active = true
    const prepared = await prepare()
    effects.active = false
    expect(prepared?.current()).toBe(true)
    expect(readFileSync(script, 'utf8')).toBe(statusLineScript())
    expect(effects.writes).toBeGreaterThan(0)
    expect(effects.flushes).toBeGreaterThan(0)
  })
})
