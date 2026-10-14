/** Production installer and NativeLaunch wiring, with private artifact/settings
 * files and a harmless shell engine. No native engine or daemon is started. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HookPreparationProof } from './kit/nativeHookFiles.js'

const disk = vi.hoisted(() => ({ pause: false, pending: [] as Array<() => void>, acknowledging: false, confirmationReads: 0 }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
    if (disk.acknowledging) disk.confirmationReads++
    return Reflect.apply(fs.lstatSync, fs, args)
  }, fsync: (fd: number, done: (error: Error | null) => void) => {
    if (disk.pause) disk.pending.push(() => fs.fsync(fd, done))
    else fs.fsync(fd, done)
  } }
})
// Observe the real producer/joiner acknowledgement boundary without replacing
// its reservations, publication, proof capture or final owner/deadline fences.
vi.mock('./kit/nativeHookFiles.js', async original => {
  const files = await original<typeof import('./kit/nativeHookFiles.js')>()
  return { ...files, runHookPreparation: (...[paths, work, options = {}]: Parameters<typeof files.runHookPreparation>) =>
    files.runHookPreparation(paths, work, { ...options, confirmed: proof => {
      disk.acknowledging = true
      try { options.confirmed?.(proof) } finally { disk.acknowledging = false }
    } }) }
})
let root: string, artifact: string, previousEntry: string
const header = '#!/usr/bin/env node\n// harness-native-hook-protocol:1\n// harness-native-hook-darwin:1\n'
function release() { disk.pause = false; for (const flush of disk.pending.splice(0)) flush() }
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-hook-activation-')))
  for (const name of ['package', 'home', 'config', 'bin']) mkdirSync(join(root, name), { mode: 0o700 })
  artifact = join(root, 'package/notify.mjs'); writeFileSync(artifact, header, { mode: 0o600 })
  previousEntry = process.argv[1]; process.argv[1] = join(root, 'package/cli.js')
  vi.stubEnv('HOME', join(root, 'home')); vi.stubEnv('SHELL', '/bin/sh')
  vi.stubEnv('CURSOR_HOME', join(root, 'home/cursor-data')); vi.stubEnv('CURSOR_DATA_DIR', '')
  vi.stubEnv('CURSOR_CONFIG_DIR', join(root, 'config')); vi.stubEnv('XDG_CONFIG_HOME', '')
  vi.stubEnv('PATH', `${join(root, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`)
  vi.stubEnv('ENV', ''); vi.stubEnv('BASH_ENV', '')
  const engine = join(root, 'bin/agent')
  writeFileSync(engine, '#!/bin/sh\nprintf "fixture help --force\\n"\n', { mode: 0o700 })
  vi.stubEnv('CURSOR_PATH', engine)
  vi.resetModules()
  disk.confirmationReads = 0
})
afterEach(() => {
  release(); process.argv[1] = previousEntry; vi.unstubAllEnvs(); vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

it.each(['default', 'captured'])('installs the generated path and response event in %s homes without changing foreign hooks', async choice => {
  const { installCursorHooks } = await import('./nativeHooks.js')
  const home = join(root, choice === 'default' ? 'config' : 'captured-config')
  mkdirSync(home, { recursive: true })
  const file = join(home, 'hooks.json'), foreign = { command: 'foreign-response', failClosed: true }
  writeFileSync(file, JSON.stringify({ custom: true, version: 7, hooks: { afterAgentResponse: [foreign] } }), { mode: 0o600 })
  const proofs: HookPreparationProof[] = []
  const options = { ...(choice === 'captured' ? { environment: { HOME: join(root, 'home'), CURSOR_CONFIG_DIR: home } } : {}),
    confirmed: (proof: HookPreparationProof) => proofs.push(proof) }
  expect(await installCursorHooks(19473, options)).toBe(true)
  const first = readFileSync(file, 'utf8'), settings = JSON.parse(first)
  expect(settings).toMatchObject({ custom: true, version: 7 })
  expect(Object.keys(settings.hooks).sort()).toEqual(['afterAgentResponse', 'beforeSubmitPrompt', 'preToolUse', 'sessionEnd', 'sessionStart', 'stop'])
  expect(settings.hooks.afterAgentResponse[0]).toEqual(foreign)
  expect(settings.hooks.afterAgentResponse[1]).toEqual({ command: expect.stringContaining(`'${artifact}'`), failClosed: false })
  for (const event of ['sessionStart', 'beforeSubmitPrompt', 'preToolUse', 'stop', 'sessionEnd']) {
    expect(settings.hooks[event]).toEqual([{ command: settings.hooks.afterAgentResponse[1].command, failClosed: false }])
  }
  expect(proofs).toHaveLength(1)
  expect(proofs[0].files.map(file => file.target).sort()).toEqual([artifact, file].sort())
  expect(proofs[0].current()).toBe(true)
  expect(await installCursorHooks(19473, options)).toBe(true)
  expect(readFileSync(file, 'utf8')).toBe(first)
})

it('holds an old artifact before changing settings, then succeeds after an update without reimporting', async () => {
  const { installCursorHooks } = await import('./nativeHooks.js')
  const { HookPreparationHeld } = await import('./kit/nativeHookFiles.js')
  const file = join(root, 'config/hooks.json'); writeFileSync(file, '{"foreign":true}')
  writeFileSync(artifact, '// former raw client')
  await expect(installCursorHooks(19473)).rejects.toThrow(HookPreparationHeld)
  expect(readFileSync(file, 'utf8')).toBe('{"foreign":true}')
  writeFileSync(artifact, header)
  expect(await installCursorHooks(19473)).toBe(true)
})

it('selects the current generated artifact after the legacy formatter captured another layout', async () => {
  const legacy = join(root, 'legacy')
  mkdirSync(legacy)
  writeFileSync(join(legacy, 'notify.mjs'), '// former raw compatibility client')
  process.argv[1] = join(legacy, 'cli.js')
  const { HOOK_SCRIPT } = await import('./kit/notifyHooks.js')
  expect(HOOK_SCRIPT).toBe(join(legacy, 'notify.mjs'))
  process.argv[1] = join(root, 'package/cli.js')
  const { installCursorHooks } = await import('./nativeHooks.js')
  expect(await installCursorHooks(19473)).toBe(true)
  const settings = JSON.parse(readFileSync(join(root, 'config/hooks.json'), 'utf8'))
  expect(settings.hooks.stop[0].command).toContain(`'${artifact}'`)
  expect(settings.hooks.stop[0].command).not.toContain(`'${HOOK_SCRIPT}'`)
})

it('revokes a changed artifact during settings flush without publication or acknowledgement', async () => {
  const { installCursorHooks } = await import('./nativeHooks.js')
  const file = join(root, 'config/hooks.json'); writeFileSync(file, '{"foreign":true}')
  const confirmed = vi.fn(), errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  disk.pause = true
  const pending = installCursorHooks(19473, { confirmed })
  await vi.waitFor(() => expect(disk.pending.length).toBeGreaterThan(0))
  writeFileSync(artifact, '// replaced with old client')
  release()
  expect(await pending).toBe(false)
  expect(confirmed).not.toHaveBeenCalled()
  expect(readFileSync(file, 'utf8')).toBe('{"foreign":true}')
  expect(errors).toHaveBeenCalled()
})

it('lets two homes prepare concurrently against one read-only artifact dependency', async () => {
  const { installCursorHooks } = await import('./nativeHooks.js')
  disk.pause = true
  const pending = ['first', 'second'].map(name => installCursorHooks(19473, {
    environment: { HOME: join(root, 'home'), CURSOR_CONFIG_DIR: join(root, name) },
  }))
  await vi.waitFor(() => expect(disk.pending).toHaveLength(2))
  release()
  expect(await Promise.all(pending)).toEqual([true, true])
})

it('does no filesystem work after the final producer or joining acknowledgement fence', async () => {
  const { installCursorHooks } = await import('./nativeHooks.js'), confirmed = vi.fn()
  disk.pause = true
  const producer = installCursorHooks(19473, { confirmed })
  await vi.waitFor(() => expect(disk.pending.length).toBeGreaterThan(0))
  const joining = installCursorHooks(19473, { confirmed })
  release()
  expect(await Promise.all([producer, joining])).toEqual([true, true])
  expect(confirmed).toHaveBeenCalledTimes(2)
  expect(disk.confirmationReads).toBe(0)
})

it('retains artifact authority in real launch preparation and the serialized post-rc guard', async () => {
  const { inspectNativeLaunch } = await import('./nativeLaunch.js')
  const { nativeLaunchGuard } = await import('./kit/nativeLaunchGuard.js')
  const prepared = await inspectNativeLaunch('cursor')
  if (!prepared.ok) throw Error(prepared.detail)
  expect(await prepared.launch.prepareHooks(19473, () => true)).toBe(true)
  expect(prepared.launch.proofs.flatMap(proof => proof.files).some(file => file.target === artifact)).toBe(true)
  expect(prepared.launch.ready?.()).toBe(true)
  const guard = nativeLaunchGuard(prepared.launch, process.execPath, 'printf held; exit 0')
  const run = () => execFileSync('/bin/sh', ['-c', guard + 'printf ready'], { encoding: 'utf8', timeout: 5000 })
  expect(run()).toBe('ready')
  writeFileSync(artifact, '// replaced after preparation')
  expect(prepared.launch.current()).toBe(false)
  expect(prepared.launch.ready?.()).toBe(false)
  expect(run()).toBe('held')
})

it('returns the startup controller while hook installation waits and contains a later artifact failure', async () => {
  const { installEngineHooks } = await import('../core/engines/hooks.js')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  disk.pause = true
  const startup = installEngineHooks(19473, { only: new Set(['cursor']), environment: {} })
  expect(startup.close).toBeTypeOf('function')
  let settled = false
  void startup.settled.then(() => { settled = true })
  await vi.waitFor(() => expect(disk.pending.length).toBeGreaterThan(0))
  expect(settled).toBe(false)
  writeFileSync(artifact, '// changed while startup remains ready')
  release(); await startup.settled; startup.close()
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('cursor install skipped'))
})
