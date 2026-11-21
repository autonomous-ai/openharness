import { fstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { publishNativeHookFiles } from './nativeHookPublication.js'
import type { NativeHookInput } from './nativeHookWire.js'
import * as nativeFiles from './nativeHookFiles.js'
import { HookScriptMissing } from './hookHeld.js'

const filesystem = vi.hoisted(() => ({ reads: undefined as Map<string, number> | undefined,
  total: undefined as Map<string, number> | undefined, onStat: undefined as ((path: string) => void) | undefined,
  onSync: undefined as ((fd: number) => void) | undefined }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
    const path = String(args[0])
    if (filesystem.reads) filesystem.reads.set(path, (filesystem.reads.get(path) ?? 0) + 1)
    if (filesystem.total) filesystem.total.set(path, (filesystem.total.get(path) ?? 0) + 1)
    filesystem.onStat?.(path)
    return fs.lstatSync(...args)
  }, fsync: (fd: number, callback: (error: Error | null) => void) => fs.fsync(fd, error => {
    try { filesystem.onSync?.(fd) } catch (cause) { callback(cause as Error); return }
    callback(error)
  }) }
})

let fixtureRoot: string, root: string, file: string
beforeEach(() => {
  // Keep the measured macOS flush workload at a fixed depth even when another suite changes TMPDIR.
  fixtureRoot = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'hook-publication-'))
  root = process.platform === 'darwin' ? join(fixtureRoot, 'profile', 'config') : fixtureRoot
  mkdirSync(root, { recursive: true })
  file = join(root, 'settings.json'); writeFileSync(file, '{}')
})
afterEach(() => { filesystem.reads = undefined; filesystem.total = undefined; filesystem.onStat = undefined; filesystem.onSync = undefined; rmSync(fixtureRoot, { recursive: true, force: true }) })
const prepared = (input: Pick<NativeHookInput, 'files'>) => ({ version: 1 as const, files: input.files.map((entry, index) => ({ index, content: `${entry.content ?? ''} prepared` })) })

it('names a missing shared candidate without publishing the profile', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    expect(await publishNativeHookFiles({ engine: 'claude', port: 1234, environment: { HOME: root } },
      [{ file }, { file: join(root, 'hook.mjs'), shared: true }],
      { prepareFiles: async () => ({ version: 1, files: [{ index: 0, content: 'prepared' }, { index: 1, content: null }] }) })).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('{}')
    expect(warn).toHaveBeenCalledWith('[hooks] NATIVE_HOOK_PREPARATION_HELD · the shared hook candidate is missing')
  } finally { warn.mockRestore() }
})

it.each(['unavailable', 'malformed', 'owner changed'] as const)('names a %s candidate refusal', async failure => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  let current = true
  try {
    expect(await publishNativeHookFiles({ engine: 'claude', port: 1234, environment: { HOME: root } }, [{ file }],
      { prepareFiles: async () => {
        if (failure === 'owner changed') current = false
        return failure === 'malformed' ? { version: 2, files: [] } as never : null
      } }, { current: () => current })).toBe(false)
    const reasons = { unavailable: 'the setup worker returned no candidate', malformed: 'the setup worker returned a malformed candidate',
      'owner changed': 'the hook owner changed during preparation' }
    expect(warn).toHaveBeenCalledWith(`[hooks] NATIVE_HOOK_PREPARATION_HELD · ${reasons[failure]}`)
    expect(readFileSync(file, 'utf8')).toBe('{}')
  } finally { warn.mockRestore() }
})

it.each([new Error('private fixture content'), new HookScriptMissing('/private/fixture/notify.mjs')])(
  'reports an unexpected or path-bearing preparation failure only by kind: %s', async failure => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await publishNativeHookFiles({ engine: 'claude', port: 1234, environment: { HOME: root } }, [{ file }],
        { prepareFiles: async () => { throw failure } })).toBe(false)
      expect(warn).toHaveBeenCalledWith(`[hooks] NATIVE_HOOK_PREPARATION_HELD · ${failure.name}`)
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private')
    } finally { warn.mockRestore() }
  })

it('bounds filesystem reads during a worker authority check for unchanged native files', async () => {
  const artifact = join(root, 'hook.mjs')
  writeFileSync(artifact, 'shared script')
  const confirmed = vi.fn()
  let activeReads: { profile: number; artifact: number } | undefined
  const total = filesystem.total = new Map<string, number>()
  expect(await publishNativeHookFiles({ engine: 'claude', port: 1234, environment: { HOME: root } },
    [{ file }, { file: artifact, shared: true }],
    { prepareFiles: async (input, _request, current) => {
      filesystem.reads = new Map()
      filesystem.total = undefined
      expect(current()).toBe(true)
      activeReads = { profile: filesystem.reads.get(realpathSync(file)) ?? 0, artifact: filesystem.reads.get(realpathSync(artifact)) ?? 0 }
      filesystem.reads = undefined
      filesystem.total = total
      return { version: 1, files: input.files.map((entry, index) => ({ index, content: entry.content })) }
    } },
    { confirmed })).toBe(true)
  expect(readFileSync(file, 'utf8')).toBe('{}')
  expect(readFileSync(artifact, 'utf8')).toBe('shared script')
  filesystem.total = undefined
  const ancestorReads = total.get(realpathSync(root)) ?? 0
  expect(confirmed.mock.calls[0][0].current()).toBe(true)
  // The 2026-11-17 launch profile found repeated proof walks. Count real leaf I/O,
  // independent of the temporary folder's depth, while retaining complete publication.
  expect(activeReads!.profile).toBeLessThanOrEqual(9)
  expect(activeReads!.artifact).toBeLessThanOrEqual(4)
  // On macOS this fixture owns a fixed depth under /tmp. The whole publisher
  // read this ancestor 1,021 times when every nested durability check walked the full profile proof.
  if (process.platform === 'darwin') expect(ancestorReads).toBeLessThanOrEqual(600)
})

it('composes the caller file guard with publisher-owned routes and shared proofs', async () => {
  const dependency = join(root, 'dependency'); writeFileSync(dependency, 'captured')
  const evidence = nativeFiles.inspectHookFile(dependency), confirmed = vi.fn()
  expect(await publishNativeHookFiles({ engine: 'claude', port: 1234, environment: { HOME: root } }, [{ file }],
    { prepareFiles: async input => { writeFileSync(dependency, 'newer'); return prepared(input) } },
    { verify: evidence.verify, confirmed })).toBe(false)
  expect(readFileSync(file, 'utf8')).toBe('{}')
  expect(confirmed).not.toHaveBeenCalled()
})

it.each(['profile bytes', 'profile ancestor', 'shared alias', 'owner'] as const)(
  'retains %s authority while the shared artifact file flush settles', async change => {
  const profile = join(root, 'profile'), artifact = join(root, 'hook.mjs'), other = join(root, 'other.mjs')
  mkdirSync(profile); const settings = join(profile, 'settings.json')
  writeFileSync(settings, 'profile'); writeFileSync(artifact, 'shared'); writeFileSync(other, 'foreign')
  const confirmed = vi.fn(); let current = true, changed = false
  filesystem.onSync = fd => {
    if (!fstatSync(fd).isFile()) return
    filesystem.onSync = undefined; changed = true
    if (change === 'profile bytes') writeFileSync(settings, 'newer')
    else if (change === 'profile ancestor') { renameSync(profile, join(root, 'displaced')); mkdirSync(profile); writeFileSync(settings, 'replacement') }
    else if (change === 'shared alias') { unlinkSync(artifact); symlinkSync(other, artifact) }
    else current = false
  }
  expect(await publishNativeHookFiles({ engine: 'claude', port: 1234, environment: { HOME: root } },
    [{ file: settings }, { file: artifact, shared: true }], { prepareFiles: async input => prepared(input) },
    { current: () => current, confirmed })).toBe(false)
  expect(changed).toBe(true)
  expect(readFileSync(settings, 'utf8')).toBe(change === 'profile bytes' ? 'newer' : change === 'profile ancestor' ? 'replacement' : 'profile')
  expect(readFileSync(artifact, 'utf8')).toBe(change === 'shared alias' ? 'foreign' : 'shared')
  expect(confirmed).not.toHaveBeenCalled()
})

it.runIf(process.platform !== 'win32')('refuses final acknowledgement after an ancestor moves during shared directory durability', async () => {
  const parent = join(root, 'parent'), child = join(parent, 'child'), artifact = join(child, 'hook.mjs')
  mkdirSync(child, { recursive: true }); writeFileSync(artifact, 'shared')
  const confirmed = vi.fn(); let moved = false
  filesystem.onSync = fd => {
    if (!fstatSync(fd).isDirectory()) return
    filesystem.onSync = undefined
    renameSync(parent, join(root, 'displaced')); mkdirSync(parent); renameSync(join(root, 'displaced', 'child'), child)
    moved = true
  }
  expect(await publishNativeHookFiles({ engine: 'claude', port: 1234, environment: { HOME: root } },
    [{ file }, { file: artifact, shared: true }], { prepareFiles: async input => prepared(input) }, { confirmed })).toBe(false)
  expect(moved).toBe(true)
  expect(readFileSync(file, 'utf8')).toBe('{}')
  expect(readFileSync(artifact, 'utf8')).toBe('shared prepared')
  expect(confirmed).not.toHaveBeenCalled()
})

it('gives no launch proof when an unchanged child moves through a replaced ancestor', async () => {
  const parent = join(root, 'parent'), child = join(parent, 'child'), nested = join(child, 'settings.json')
  mkdirSync(child, { recursive: true }); writeFileSync(nested, 'original')
  const original = nativeFiles.hookFileVersion(statSync(nested, { bigint: true })), confirmed = vi.fn()
  let replaced = false
  expect(await publishNativeHookFiles({ engine: 'claude', port: 1234, environment: { HOME: root } }, [{ file: nested }],
    { prepareFiles: async input => {
      filesystem.onStat = path => {
        if (path !== realpathSync(child)) return
        filesystem.onStat = undefined
        const displaced = join(root, 'displaced')
        renameSync(parent, displaced); mkdirSync(parent); renameSync(join(displaced, 'child'), child)
        replaced = true
      }
      return prepared(input)
    } }, { confirmed })).toBe(false)
  expect(replaced).toBe(true)
  expect(confirmed).not.toHaveBeenCalled()
  expect(readFileSync(nested, 'utf8')).toBe('original')
  expect(nativeFiles.hookFileVersion(statSync(nested, { bigint: true }))).toBe(original)
})

it.each(['owner', 'native input'] as const)('publishes nothing when %s changes while the worker prepares bytes', async change => {
  let current = true
  const setup = { prepareFiles: vi.fn(async (input: NativeHookInput) => {
    if (change === 'owner') current = false
    else writeFileSync(file, 'newer external data')
    return prepared(input)
  }) }
  const confirmed = vi.fn()
  expect(await publishNativeHookFiles({ engine: 'claude', port: 1234, environment: { HOME: root } }, [{ file }], setup, { current: () => current, confirmed })).toBe(false)
  expect(readFileSync(file, 'utf8')).toBe(change === 'owner' ? '{}' : 'newer external data')
  expect(confirmed).not.toHaveBeenCalled()
})

it('returns only proofs for the exact files the current caller authorized', async () => {
  const confirmed = vi.fn()
  expect(await publishNativeHookFiles({ engine: 'claude', port: 1234, environment: { HOME: root } }, [{ file }],
    { prepareFiles: async input => prepared(input) }, { confirmed })).toBe(true)
  expect(readFileSync(file, 'utf8')).toBe('{} prepared')
  const proof = confirmed.mock.calls[0][0]
  expect(proof.current()).toBe(true)
  writeFileSync(file, 'newer')
  expect(proof.current()).toBe(false)
})

it('keeps an unavailable or malformed worker from becoming an inline writer', async () => {
  const request = { engine: 'claude' as const, port: 1234, environment: { HOME: root } }
  expect(await publishNativeHookFiles(request, [{ file }], {})).toBe(false)
  expect(await publishNativeHookFiles(request, [{ file }], { prepareFiles: async () => null })).toBe(false)
  expect(await publishNativeHookFiles(request, [{ file }], { prepareFiles: async () => ({ version: 1, files: [{ index: 1, content: 'wrong file' }] }) })).toBe(false)
  expect(readFileSync(file, 'utf8')).toBe('{}')
})

it('shares identical artifact bytes across overlapping profiles and proves them to both callers', async () => {
  const second = join(root, 'other.json'), artifact = join(root, 'hook.mjs')
  writeFileSync(second, '{}')
  const request = { engine: 'claude' as const, port: 1234, environment: { HOME: root } }
  let entered = 0, release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const setup = { prepareFiles: async (input: NativeHookInput) => {
    if (++entered === 2) release()
    await waiting
    return { version: 1 as const, files: [{ index: 0, content: input.files[0].file }, { index: 1, content: 'shared script' }] }
  } }
  const confirmations = [vi.fn(), vi.fn()]
  expect(await Promise.all([file, second].map((profile, index) => publishNativeHookFiles(request,
    [{ file: profile }, { file: artifact, shared: true }], setup, { confirmed: confirmations[index] })))).toEqual([true, true])
  expect(readFileSync(file, 'utf8')).toBe(file)
  expect(readFileSync(second, 'utf8')).toBe(second)
  expect(readFileSync(artifact, 'utf8')).toBe('shared script')
  for (const confirmed of confirmations) expect(confirmed.mock.calls[0][0].current()).toBe(true)
  writeFileSync(artifact, 'changed outside Harness')
  for (const confirmed of confirmations) expect(confirmed.mock.calls[0][0].current()).toBe(false)
})

it('retains the shared proof when same-profile callers join one preparation', async () => {
  const artifact = join(root, 'hook.mjs')
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), waiting = new Promise<void>(resolve => { release = resolve })
  const prepareFiles = vi.fn(async () => {
    enter(); await waiting
    return { version: 1 as const, files: [{ index: 0, content: 'profile' }, { index: 1, content: 'shared script' }] }
  })
  const confirmations = [vi.fn(), vi.fn()]
  const request = (index: number) => publishNativeHookFiles({ engine: 'claude', port: 1234, environment: { HOME: root } },
    [{ file }, { file: artifact, shared: true }], { prepareFiles }, { identity: 'same-owner-input', confirmed: confirmations[index] })
  const first = request(0); await entered
  const second = request(1); release()
  expect(await Promise.all([first, second])).toEqual([true, true])
  expect(prepareFiles).toHaveBeenCalledOnce()
  writeFileSync(artifact, 'changed outside Harness')
  for (const confirmed of confirmations) expect(confirmed.mock.calls[0][0].current()).toBe(false)
})

it('rechecks each joining owner after shared artifact completion', async () => {
  const artifact = join(root, 'hook.mjs')
  let enter!: () => void, release!: () => void, joiningCurrent = true
  const entered = new Promise<void>(resolve => { enter = resolve }), waiting = new Promise<void>(resolve => { release = resolve })
  const prepareFiles = async () => {
    enter(); await waiting
    return { version: 1 as const, files: [{ index: 0, content: 'profile' }, { index: 1, content: 'shared script' }] }
  }
  const inspect = nativeFiles.inspectHookFile
  const intercepted = vi.spyOn(nativeFiles, 'inspectHookFile').mockImplementation((path, mode) => {
    const observed = inspect(path, mode)
    return path !== artifact ? observed : { ...observed, replace: async (...args: Parameters<typeof observed.replace>) => {
      const published = await observed.replace(...args)
      joiningCurrent = false
      return published
    } }
  })
  const joined = vi.fn()
  const request = (options = {}) => publishNativeHookFiles({ engine: 'claude', port: 1234, environment: { HOME: root } },
    [{ file }, { file: artifact, shared: true }], { prepareFiles }, { identity: 'shared-profile-owner', ...options })
  try {
    const first = request(); await entered
    const second = request({ current: () => joiningCurrent, confirmed: joined }); release()
    expect(await Promise.all([first, second])).toEqual([true, false])
    expect(readFileSync(file, 'utf8')).toBe('profile')
    expect(joined).not.toHaveBeenCalled()
  } finally { intercepted.mockRestore() }
})

it('cannot use a successful shared artifact to authorize an obsolete profile', async () => {
  const artifact = join(root, 'hook.mjs')
  let current = true
  const confirmed = vi.fn()
  const setup = { prepareFiles: async () => {
    current = false
    return { version: 1 as const, files: [{ index: 0, content: 'obsolete profile' }, { index: 1, content: 'shared script' }] }
  } }
  expect(await publishNativeHookFiles({ engine: 'claude', port: 1234, environment: { HOME: root } },
    [{ file }, { file: artifact, shared: true }], setup, { current: () => current, confirmed })).toBe(false)
  expect(readFileSync(file, 'utf8')).toBe('{}')
  expect(confirmed).not.toHaveBeenCalled()
})

it('does not publish a profile whose shared artifact preparation is incomplete', async () => {
  const confirmed = vi.fn()
  expect(await publishNativeHookFiles({ engine: 'claude', port: 1234, environment: { HOME: root } },
    [{ file }, { file: join(root, 'hook.mjs'), shared: true }], { prepareFiles: async () => ({ version: 1,
      files: [{ index: 0, content: 'profile using a missing script' }, { index: 1, content: null }] }) }, { confirmed })).toBe(false)
  expect(readFileSync(file, 'utf8')).toBe('{}')
  expect(confirmed).not.toHaveBeenCalled()
})

it.skipIf(process.platform === 'win32')('retains the original destination route when its alias changes during rendering', async () => {
  const original = join(root, 'original.json'), other = join(root, 'other.json')
  writeFileSync(original, 'original'); writeFileSync(other, 'other')
  unlinkSync(file); symlinkSync(original, file)
  expect(await publishNativeHookFiles({ engine: 'claude', port: 1234, environment: { HOME: root } }, [{ file }],
    { prepareFiles: async input => { unlinkSync(file); symlinkSync(other, file); return prepared(input) } })).toBe(false)
  expect(readFileSync(original, 'utf8')).toBe('original')
  expect(readFileSync(other, 'utf8')).toBe('other')
})

it('gives no launch proof for an incomplete pair and never rolls back over another writer', async () => {
  const other = join(root, 'other.json'); writeFileSync(other, 'before')
  const inspect = nativeFiles.inspectHookFile
  const intercepted = vi.spyOn(nativeFiles, 'inspectHookFile').mockImplementation((path, mode) => {
    const observed = inspect(path, mode)
    return path !== other ? observed : { ...observed, replace: async () => {
      writeFileSync(file, 'newer external edit')
      throw new nativeFiles.HookPreparationHeld('fixture publication failed')
    } }
  })
  const confirmed = vi.fn()
  try {
    expect(await publishNativeHookFiles({ engine: 'codex', port: 1234, environment: { HOME: root } }, [{ file }, { file: other }],
      { prepareFiles: async input => prepared(input) }, { confirmed })).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('newer external edit')
    expect(readFileSync(other, 'utf8')).toBe('before')
    expect(confirmed).not.toHaveBeenCalled()
  } finally { intercepted.mockRestore() }
})
