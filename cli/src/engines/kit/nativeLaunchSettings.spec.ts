import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareLaunchSettings } from './nativeLaunchSettings.js'
import { prepareNativeLaunchSettings } from '../../services/nativeLaunchSettings.js'
import type { LaunchSettingsInput } from './launchSettingsWire.js'
import type { NativeSetup } from './nativeSetup.js'
import { statusLineScript } from './statusLine.js'
import { launchSettingsArgs } from './launchValues.js'

const effects = vi.hoisted(() => ({ active: false, flushes: 0, writes: 0,
  beforePublish: undefined as (() => void) | undefined, afterPublish: undefined as (() => void) | undefined,
  onStat: undefined as ((file: unknown) => void) | undefined }))
vi.mock('./nativeHookPublication.js', async original => {
  const publication = await original<typeof import('./nativeHookPublication.js')>()
  return { ...publication, publishNativeFiles: async (...args: Parameters<typeof publication.publishNativeFiles>) => {
    effects.beforePublish?.()
    const result = await publication.publishNativeFiles(...args)
    effects.afterPublish?.()
    return result
  } }
})
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
    effects.onStat?.(args[0]); return fs.lstatSync(...args)
  }, fsync: (...args: Parameters<typeof fs.fsync>) => {
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
  effects.beforePublish = undefined; effects.afterPublish = undefined; effects.onStat = undefined
  root = mkdtempSync(join(tmpdir(), 'launch-settings-'))
  dataDir = join(root, 'data'); cwd = join(root, 'work')
  mkdirSync(dataDir); mkdirSync(cwd); mkdirSync(join(root, '.codex')); mkdirSync(join(root, '.claude'))
  writeFileSync(join(dataDir, 'agent-settings.json'), JSON.stringify({ machineId: 'machine', accountId: 'account', agentsStartAgents: true, pullRequestLine: true }))
})
afterEach(() => { effects.active = false; effects.beforePublish = undefined; effects.afterPublish = undefined; effects.onStat = undefined; rmSync(root, { recursive: true, force: true }) })
const options = () => ({ dataDir, runtimeNode: process.execPath, platform: 'darwin' as const, gitBash: null,
  owner: { machineId: 'machine', accountId: 'account' }, current: () => true, nativeCurrent: () => true })
const setup: Pick<NativeSetup, 'prepareFiles'> = { prepareFiles: async (input, _request, current) => prepareNativeLaunchSettings(input as LaunchSettingsInput, current) }

describe('one synchronous source-verification pass', () => {
  function sharedSources() {
    const shared = join(realpathSync(root), 'shared'), displaced = join(realpathSync(root), 'displaced')
    const folders = ['data', '.codex', 'work']
    for (const folder of folders) mkdirSync(join(shared, folder), { recursive: true })
    writeFileSync(join(shared, 'data', 'agent-settings.json'), '{}')
    const profile = join(shared, '.codex', 'config.toml')
    writeFileSync(profile, 'developer_instructions = "Keep mine."\n')
    return { shared, profile,
      capture: () => prepareLaunchSettings('codex', { HOME: shared }, join(shared, 'work'), setup,
        { ...options(), dataDir: join(shared, 'data') }),
      replaceAncestor: () => {
        renameSync(shared, displaced); mkdirSync(shared)
        // Move the children intact: every source leaf and child directory keeps its identity.
        for (const folder of folders) renameSync(join(displaced, folder), join(shared, folder))
      },
      aliasAncestor: () => { renameSync(shared, displaced); symlinkSync(displaced, shared) },
    }
  }

  it('reads a common directory provisionally once, then freshly for each source, with a new pass on every call', async () => {
    const fixture = sharedSources(), prepared = await fixture.capture()
    expect(prepared).not.toBeNull()
    let reads = 0
    effects.onStat = file => { if (file === fixture.shared) reads++ }
    expect(prepared!.current()).toBe(true)
    expect(reads).toBe(4) // One provisional walk plus the three uncached source snapshots.
    reads = 0
    expect(prepared!.current()).toBe(true)
    expect(reads).toBe(4)
    effects.onStat = undefined
    fixture.replaceAncestor()
    expect(prepared!.current()).toBe(false)
  })

  it.each(['replacement', 'alias', 'same-byte leaf'] as const)('rejects a %s after an earlier source has checked the common ancestor', async change => {
    const fixture = sharedSources(), prepared = await fixture.capture()
    expect(prepared).not.toBeNull()
    let changed = false
    effects.onStat = file => {
      if (file !== fixture.profile) return
      effects.onStat = undefined; changed = true
      if (change === 'replacement') fixture.replaceAncestor()
      else if (change === 'alias') fixture.aliasAncestor()
      else {
        const replacement = join(root, 'replacement.toml')
        writeFileSync(replacement, readFileSync(fixture.profile)); renameSync(replacement, fixture.profile)
      }
    }
    expect(prepared!.current()).toBe(false)
    expect(changed).toBe(true)
    expect(readFileSync(fixture.profile, 'utf8')).toBe('developer_instructions = "Keep mine."\n')
  })

  it('never retains an absent ancestor across passes or accepts an inserted alias', async () => {
    const fixture = sharedSources(), prepared = await fixture.capture()
    expect(prepared!.current()).toBe(true)
    const target = join(root, 'other-config'); mkdirSync(target)
    symlinkSync(target, join(fixture.shared, 'work', '.codex'))
    expect(prepared!.current()).toBe(false)
  })

  it('reads an existing common alias afresh in every source walk and snapshot', async () => {
    const fixture = sharedSources()
    fixture.aliasAncestor()
    const prepared = await fixture.capture()
    expect(prepared).not.toBeNull()
    let reads = 0
    effects.onStat = file => { if (file === fixture.shared) reads++ }
    expect(prepared!.current()).toBe(true)
    expect(reads).toBe(6)
  })

  it.each([false, true])('gives nested verification an independent pass and retains outer freshness (mutate=%s)', async mutate => {
    const fixture = sharedSources(), prepared = await fixture.capture()
    expect(prepared).not.toBeNull()
    let nested = false, nestedReads = 0, inside = false
    effects.onStat = file => {
      if (inside) { if (file === fixture.shared) nestedReads++; return }
      if (nested || file !== fixture.profile) return
      nested = true; inside = true
      expect(prepared!.current()).toBe(true)
      inside = false
      if (mutate) fixture.replaceAncestor()
    }
    expect(prepared!.current()).toBe(!mutate)
    expect(nested).toBe(true)
    expect(nestedReads).toBe(4)
  })

  it('falls back to fresh reads after 256 provisional directories without refusing valid sources', async () => {
    const branch = (name: string) => join(realpathSync(root), name, ...Array.from({ length: 90 }, () => 'd'))
    const data = branch('data'), home = branch('home'), workspace = branch('work')
    for (const directory of [data, home, workspace]) mkdirSync(directory, { recursive: true })
    mkdirSync(join(data, 'statusline')); writeFileSync(join(data, 'statusline', 'statusline.mjs'), statusLineScript())
    const prepared = await prepareLaunchSettings('claude', { HOME: root, CLAUDE_CONFIG_DIR: home }, workspace, setup,
      { ...options(), dataDir: data })
    expect(prepared).not.toBeNull()
    let reads = 0
    effects.onStat = file => { if (file === workspace) reads++ }
    expect(prepared!.current()).toBe(true)
    // This late directory is beyond the cap: both project sources walk and verify it freshly.
    expect(reads).toBe(4)
  })
})

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

it.each(['claude', 'codex'])('prepares %s without inventing project sources when cwd is absent', async engine => {
  const prepared = await prepareLaunchSettings(engine, { HOME: root }, null, setup, options())
  expect(prepared?.current()).toBe(true)
})

it('reads a Codex profile that is also the workspace source only once', async () => {
  const profile = join(cwd, '.codex'); mkdirSync(profile)
  writeFileSync(join(profile, 'config.toml'), 'developer_instructions = "Keep workspace."\n')
  const prepareFiles = vi.fn(setup.prepareFiles!)
  const prepared = await prepareLaunchSettings('codex', { HOME: root, CODEX_HOME: profile }, cwd, { prepareFiles }, options())
  expect(prepared?.values.instructions).toMatch(/^Keep workspace\./)
  expect((prepareFiles.mock.calls[0][0] as LaunchSettingsInput).sources.filter(source => source.file === join(profile, 'config.toml'))).toHaveLength(1)
})

it('bounds an arbitrarily deep Codex ancestor walk before reading or sending sources', async () => {
  const prepareFiles = vi.fn(setup.prepareFiles!)
  const deep = join(root, ...Array.from({ length: 257 }, () => 'x'))
  expect(await prepareLaunchSettings('codex', { HOME: root }, deep, { prepareFiles }, options())).toBeNull()
  expect(prepareFiles).not.toHaveBeenCalled()
})

it('refuses the combined source-byte budget even when each file is within its own limit', async () => {
  mkdirSync(join(cwd, '.claude'))
  for (const file of [join(dataDir, 'agent-settings.json'), join(root, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.json')]) {
    writeFileSync(file, 'x'.repeat(800_000))
  }
  const prepareFiles = vi.fn(setup.prepareFiles!)
  expect(await prepareLaunchSettings('claude', { HOME: root }, cwd, { prepareFiles }, options())).toBeNull()
  expect(prepareFiles).not.toHaveBeenCalled()
})

it('refuses invalid declarative inputs before asking setup', async () => {
  const prepareFiles = vi.fn(setup.prepareFiles!)
  expect(await prepareLaunchSettings('claude', { HOME: root }, cwd, { prepareFiles }, { ...options(), runtimeNode: 'invalid\0node' })).toBeNull()
  expect(prepareFiles).not.toHaveBeenCalled()
})

it('rechecks owner admission after the native and source filesystem proofs', async () => {
  let owner = true, nativeReads = 0
  const prepareFiles = vi.fn(setup.prepareFiles!)
  expect(await prepareLaunchSettings('claude', { HOME: root }, cwd, { prepareFiles }, { ...options(),
    current: () => owner, nativeCurrent: () => { if (++nativeReads === 2) owner = false; return true },
  })).toBeNull()
  expect(prepareFiles).not.toHaveBeenCalled()
})

it('keeps the publisher proof when another preparation has just supplied the exact candidate', async () => {
  const script = join(dataDir, 'statusline', 'statusline.mjs')
  effects.beforePublish = () => {
    effects.beforePublish = undefined
    mkdirSync(join(dataDir, 'statusline')); writeFileSync(script, statusLineScript())
  }
  const prepared = await prepareLaunchSettings('claude', { HOME: root }, cwd, setup, options())
  expect(prepared?.current()).toBe(true)
  expect(readFileSync(script, 'utf8')).toBe(statusLineScript())
  writeFileSync(script, 'replacement')
  expect(prepared?.current()).toBe(false)
})

it('omits the acknowledged result if a source changes after publication but before helper return', async () => {
  effects.afterPublish = () => writeFileSync(join(dataDir, 'agent-settings.json'), '{}')
  expect(await prepareLaunchSettings('claude', { HOME: root }, cwd, setup, options())).toBeNull()
  expect(readFileSync(join(dataDir, 'statusline', 'statusline.mjs'), 'utf8')).toBe(statusLineScript())
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
