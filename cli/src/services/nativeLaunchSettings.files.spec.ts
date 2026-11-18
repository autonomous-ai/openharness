/** Source/effect fences moved with optional policy. Final core use deliberately retains a committed snapshot. */
import { chmodSync, existsSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prepareNativeLaunchSettings } from './nativeLaunchSettings.js'
import { statusLineScript } from '../engines/kit/statusLine.js'
import type { LaunchSettingsInput } from '../engines/kit/launchSettingsWire.js'
import { createLocalNativeSetup } from './nativeSetup.js'
import { startEngineSetup } from './engineSetup.js'
const effects = vi.hoisted(() => ({ flushes: 0, onSync: undefined as ((fd: number) => void) | undefined,
  onStat: undefined as ((file: string) => void) | undefined, afterRead: undefined as (() => void) | undefined,
  afterProof: undefined as ((file: string) => void) | undefined,
  hold: undefined as ((fd: number, release: () => void) => void) | undefined,
  closed: undefined as ((fd: number) => void) | undefined,
  before: undefined as (() => void) | undefined, after: undefined as (() => void) | undefined }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, fsync: (fd: number, callback: (error: Error | null) => void) => fs.fsync(fd, error => {
    effects.flushes++; effects.onSync?.(fd)
    if (effects.hold) effects.hold(fd, () => callback(error)); else callback(error)
  }), closeSync: (fd: number) => { fs.closeSync(fd); effects.closed?.(fd) },
  lstatSync: (...args: Parameters<typeof fs.lstatSync>) => { effects.onStat?.(String(args[0])); return fs.lstatSync(...args) } }
})
vi.mock('../engines/kit/nativeHookFiles.js', async original => {
  const module = await original<typeof import('../engines/kit/nativeHookFiles.js')>()
  return { ...module, inspectHookFile: (...args: Parameters<typeof module.inspectHookFile>) => {
    const observed = module.inspectHookFile(...args)
    return { ...observed, verify: (...verify: Parameters<typeof observed.verify>) => {
      observed.verify(...verify)
      effects.afterProof?.(args[0])
      if (args[0].endsWith('statusline.mjs')) effects.afterRead?.()
    } }
  } }
})
vi.mock('../engines/kit/nativeHookPublication.js', async original => {
  const module = await original<typeof import('../engines/kit/nativeHookPublication.js')>()
  return { ...module, publishNativeFiles: async (...args: Parameters<typeof module.publishNativeFiles>) => {
    effects.before?.(); const result = await module.publishNativeFiles(...args); effects.after?.(); return result
  } }
})
let root: string, data: string, home: string, work: string, source: string, script: string
const bytes = '{"statusLine":{"type":"command","command":"echo own","padding":{"left":2}}}'
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'optional-owned-files-')); data = join(root, 'data'); home = join(root, 'home'); work = join(home, 'work')
  mkdirSync(data); mkdirSync(work, { recursive: true }); mkdirSync(join(home, '.claude')); mkdirSync(join(home, '.codex'))
  source = join(home, '.claude', 'settings.json'); script = join(data, 'statusline', 'statusline.mjs')
  writeFileSync(source, bytes)
  writeFileSync(join(data, 'agent-settings.json'), '{"machineId":"machine","accountId":"account","agentsStartAgents":true}')
  effects.flushes = 0; effects.onSync = undefined; effects.before = undefined; effects.after = undefined; effects.hold = undefined; effects.closed = undefined
  effects.onStat = undefined; effects.afterRead = undefined; effects.afterProof = undefined
})
afterEach(() => { effects.onSync = undefined; effects.before = undefined; effects.after = undefined; effects.hold = undefined; effects.closed = undefined; effects.onStat = undefined; effects.afterRead = undefined; effects.afterProof = undefined; vi.useRealTimers(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
const input = (engine: 'claude' | 'codex' = 'claude', extra: Partial<LaunchSettingsInput> = {}): LaunchSettingsInput => ({
  purpose: 'launchSettings', version: 2, engine, environment: { HOME: home }, cwd: work, runtimeNode: process.execPath,
  platform: 'darwin', gitBash: null, owner: { machineId: 'machine', accountId: 'account' }, ...extra,
})
const prepare = (given = input(), current = () => true, commit?: () => Promise<boolean>) => prepareNativeLaunchSettings(given, data, current, commit)
const existing = (text = statusLineScript()) => { mkdirSync(join(data, 'statusline')); writeFileSync(script, text) }

it.each(['writable', 'read-only'] as const)('read-only checkpoint verifies sources once after commit for a %s artifact', async mode => {
  existing(); if (mode === 'read-only') chmodSync(script, 0o400)
  const checks: string[] = []
  const result = await prepare(input(), () => true, async () => {
    effects.afterProof = file => { if (file === source) checks.push('source'); else if (file === script) checks.push('output') }
    return true
  })
  expect(result).not.toBeNull(); expect(effects.flushes).toBe(0)
  expect(checks.filter(check => check === 'source')).toHaveLength(1)
  expect(checks).toEqual(['output', 'source', 'output'])
})
it('read-only checkpoint refuses revoked admission before reading the output proof', async () => {
  existing(); let current = true, outputRead = false
  expect(await prepare(input(), () => current, async () => {
    current = false; effects.afterRead = () => { outputRead = true }; return true
  })).toBeNull()
  expect(outputRead).toBe(false); expect(effects.flushes).toBe(0)
})
it.each(['source bytes', 'same-byte source', 'source ancestor'] as const)('read-only checkpoint rejects %s changed during its output check', async kind => {
  existing(); let changed = false
  expect(await prepare(input(), () => true, async () => {
    effects.afterRead = () => {
      effects.afterRead = undefined; changed = true
      if (kind === 'source bytes') writeFileSync(source, '{}')
      else if (kind === 'same-byte source') { const replacement = join(root, 'replacement'); writeFileSync(replacement, bytes); renameSync(replacement, source) }
      else { renameSync(join(home, '.claude'), join(home, 'prior')); mkdirSync(join(home, '.claude')); writeFileSync(source, bytes) }
    }
    return true
  })).toBeNull()
  expect(changed).toBe(true); expect(effects.flushes).toBe(0)
})
it('read-only checkpoint rechecks admission after the output read', async () => {
  existing(); let current = true
  expect(await prepare(input(), () => current, async () => {
    effects.afterRead = () => { effects.afterRead = undefined; current = false }; return true
  })).toBeNull()
  expect(current).toBe(false); expect(effects.flushes).toBe(0)
})
it.each(['missing', 'different'] as const)('read-only checkpoint retains full source proof before publishing a %s artifact', async kind => {
  if (kind === 'different') existing('previous release')
  let sourceChecks = 0, observedEffect = false
  expect(await prepare(input(), () => true, async () => {
    effects.afterProof = file => { if (file === source) sourceChecks++ }
    effects.before = () => { observedEffect = true; expect(sourceChecks).toBe(1) }
    return true
  })).not.toBeNull()
  expect(observedEffect).toBe(true); expect(effects.flushes).toBeGreaterThan(0)
  expect(readFileSync(source, 'utf8')).toBe(bytes); expect(readFileSync(script, 'utf8')).toBe(statusLineScript())
})

it.each(['codex', 'claude'] as const)('retains %s instructions without a dummy output for settings-only behavior', async engine => {
  const result = await prepare(input(engine, { platform: 'win32' }))
  expect(result?.values.instructions).toContain('You are running in Harness')
  expect(result?.values.settings).toBeNull(); expect(existsSync(script)).toBe(false)
})
it.each(['claude', 'codex'] as const)('does not invent project sources without cwd for %s', async engine => {
  expect(await prepare(input(engine, { cwd: null }))).not.toBeNull()
})
it('preserves a Codex profile that is also the workspace source', async () => {
  const profile = join(work, '.codex'); mkdirSync(profile); writeFileSync(join(profile, 'config.toml'), 'developer_instructions = "Workspace wins."\n')
  const result = await prepare(input('codex', { environment: { HOME: home, CODEX_HOME: profile } }))
  expect(result?.values.instructions).toMatch(/^Workspace wins\./)
})
it('bounds the Codex ancestor list before reading files', async () => {
  expect(await prepare(input('codex', { cwd: join(home, ...Array.from({ length: 257 }, () => 'x')) }))).toBeNull()
})
it('rejects the combined optional source-byte budget', async () => {
  mkdirSync(join(work, '.claude'))
  for (const file of [join(data, 'agent-settings.json'), source, join(work, '.claude', 'settings.json')]) writeFileSync(file, 'x'.repeat(800_000))
  expect(await prepare()).toBeNull(); expect(existsSync(script)).toBe(false)
})
it('includes the existing artifact in the combined capture limit', async () => {
  writeFileSync(source, 'x'.repeat(1_000_000)); writeFileSync(join(data, 'agent-settings.json'), 'x'.repeat(1_000_000)); existing('x'.repeat(100_000))
  expect(await prepare()).toBeNull(); expect(readFileSync(script, 'utf8')).toHaveLength(100_000)
})
it.each(['old context', 'invalid context', 'cancelled'] as const)('omits %s before optional effects', async kind => {
  const given = input(); if (kind === 'old context') delete (given as { version?: number }).version
  if (kind === 'invalid context') given.runtimeNode = 'bad\0node'
  expect(await prepare(given, () => kind !== 'cancelled')).toBeNull(); expect(existsSync(script)).toBe(false)
})
it('does not publish an oversized optional value', async () => {
  writeFileSync(source, JSON.stringify({ statusLine: { type: 'command', command: 'x'.repeat(65_536) } }))
  expect(await prepare()).toBeNull(); expect(existsSync(script)).toBe(false)
})
it('reads identical regular read-only bytes without flushing or claiming new durability', async () => {
  existing(); chmodSync(script, 0o400)
  expect(await prepare()).not.toBeNull(); expect(effects.flushes).toBe(0)
  expect(readFileSync(script, 'utf8')).toBe(statusLineScript())
})
it.each(['missing', 'changed'] as const)('durably prepares a %s artifact and preserves user config bytes', async kind => {
  if (kind === 'changed') existing('old release')
  expect(await prepare()).not.toBeNull(); expect(effects.flushes).toBeGreaterThan(0)
  expect(readFileSync(script, 'utf8')).toBe(statusLineScript()); expect(readFileSync(source, 'utf8')).toBe(bytes)
})
it('accepts another publisher supplying the same artifact before acquiring its reservation', async () => {
  effects.before = () => { effects.before = undefined; existing() }
  expect(await prepare()).not.toBeNull(); expect(readFileSync(script, 'utf8')).toBe(statusLineScript())
})
it.each(['source', 'same-byte source', 'source ancestor', 'output', 'same-byte output', 'output ancestor', 'owner'] as const)(
  'rejects %s changes across the component commit wait', async change => {
    existing(); let current = true
    expect(await prepare(input(), () => current, async () => {
      if (change === 'source') writeFileSync(source, '{}')
      else if (change === 'same-byte source') { const other = join(root, 'replacement'); writeFileSync(other, bytes); renameSync(other, source) }
      else if (change === 'source ancestor') { renameSync(join(home, '.claude'), join(home, 'old')); mkdirSync(join(home, '.claude')); writeFileSync(source, bytes) }
      else if (change === 'output') writeFileSync(script, 'peer bytes')
      else if (change === 'same-byte output') { const other = join(root, 'replacement'); writeFileSync(other, statusLineScript()); renameSync(other, script) }
      else if (change === 'output ancestor') { renameSync(join(data, 'statusline'), join(data, 'old')); existing() }
      else current = false
      return true
    })).toBeNull()
  },
)
it.each(['staged', 'directory'] as const)('rejects source changes during %s fsync and retains cleanup', async phase => {
  let changed = false
  effects.onSync = fd => { if (fstatSync(fd).isDirectory() !== (phase === 'directory')) return
    effects.onSync = undefined; changed = true; writeFileSync(source, '{}') }
  expect(await prepare()).toBeNull(); expect(changed).toBe(true)
  expect(existsSync(script)).toBe(phase === 'directory')
})
it('checks sources again after publisher acknowledgement', async () => {
  effects.after = () => writeFileSync(source, '{}')
  expect(await prepare()).toBeNull(); expect(readFileSync(script, 'utf8')).toBe(statusLineScript())
})
it('rechecks worker admission after source filesystem reads', async () => {
  let current = true, observed = false
  const resolvedSource = realpathSync(source)
  expect(await prepare(input(), () => current, async () => {
    effects.onStat = file => { if (file === resolvedSource) { effects.onStat = undefined; observed = true; current = false } }
    return true
  })).toBeNull()
  expect(observed).toBe(true)
  expect(existsSync(script)).toBe(false)
})
it('rejects an output replaced after its first read-only check and before the final answer', async () => {
  existing()
  expect(await prepare(input(), () => true, async () => {
    effects.afterRead = () => { effects.afterRead = undefined; writeFileSync(script, 'replacement') }
    return true
  })).toBeNull()
  expect(readFileSync(script, 'utf8')).toBe('replacement')
})
it.each(['folder', 'leaf'] as const)('never follows a %s artifact alias into user files', async kind => {
  if (kind === 'folder') symlinkSync(join(home, '.claude'), join(data, 'statusline'))
  else { mkdirSync(join(data, 'statusline')); symlinkSync(source, script) }
  expect(await prepare()).toBeNull(); expect(readFileSync(source, 'utf8')).toBe(bytes)
})
it('allows a configured data-root alias while constraining its generated child paths', async () => {
  const alias = join(root, 'data-alias'); symlinkSync(data, alias)
  expect(await prepareNativeLaunchSettings(input(), alias, () => true)).not.toBeNull()
  expect(readFileSync(script, 'utf8')).toBe(statusLineScript())
})
it.each(['folder', 'leaf'] as const)('rejects a %s artifact alias inserted during the staged fsync', async kind => {
  let changed = false
  effects.onSync = fd => {
    if (fstatSync(fd).isDirectory()) return
    effects.onSync = undefined; changed = true
    if (kind === 'folder') { renameSync(join(data, 'statusline'), join(data, 'displaced')); symlinkSync(join(home, '.claude'), join(data, 'statusline')) }
    else symlinkSync(source, script)
  }
  expect(await prepare()).toBeNull(); expect(changed).toBe(true)
  expect(readFileSync(source, 'utf8')).toBe(bytes)
})
it('keeps future preparations live after the static artifact is removed', async () => {
  expect(await prepare()).not.toBeNull(); rmSync(script); expect(await prepare()).not.toBeNull()
  expect(readFileSync(script, 'utf8')).toBe(statusLineScript())
})

it('retains the artifact descriptor after reply timeout without starving required setup or duplicating publication', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const setup = createLocalNativeSetup(join(data, 'native-installations'))
  setup.downloading = vi.fn(async () => false)
  const service = startEngineSetup(join(data, 'native-installations'), setup)
  const request = (type: string, payload: Record<string, unknown>) => Promise.resolve(service.requests[type]!(payload, { local: true, owner: true }))
  let entered!: () => void, closed!: () => void, release!: () => void, owned = -1
  const holding = new Promise<void>(resolve => { entered = resolve }), finished = new Promise<void>(resolve => { closed = resolve })
  effects.hold = (fd, done) => { owned = fd; release = done; effects.hold = undefined; entered() }
  effects.closed = fd => { if (fd === owned) closed() }
  try {
    const first = await request('setup_files_prepare', { ...input(), request: 'first' })
    const pending = request('setup_files_commit', { ...first, purpose: 'launchSettings', version: 2, engine: 'claude', request: 'first', allowed: true })
    await holding
    await vi.advanceTimersByTimeAsync(5001)
    expect(await pending).toEqual({ files: null })
    expect(effects.flushes).toBe(1)
    expect(await request('setup_download', { engine: 'codex' })).toEqual({ downloading: false })
    expect(setup.downloading).toHaveBeenCalledOnce()
    const next = await request('setup_files_prepare', { ...input(), request: 'next' })
    expect(await request('setup_files_commit', { ...next, purpose: 'launchSettings', version: 2, engine: 'claude', request: 'next', allowed: true }))
      .toEqual({ files: null })
    expect(effects.flushes).toBe(1)
    expect(existsSync(script)).toBe(false)
  } finally {
    service.stop()
    release?.()
    if (owned !== -1) await finished
  }
  expect(readdirSync(join(data, 'statusline')).filter(file => file.startsWith('.harness-hook-'))).toEqual([])
})
