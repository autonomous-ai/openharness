import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync, symlinkSync, renameSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const probe = vi.hoisted(() => ({ major: 1 as number | null, beforeProbe: undefined as (() => Promise<void>) | undefined, failSync: false, failRemove: false, beforeSync: undefined as (() => Promise<void>) | undefined, onStat: undefined as ((path: unknown) => void) | undefined }))
vi.mock('./launchControl.js', () => ({ opencodeMajorVersion: async () => { await probe.beforeProbe?.(); return probe.major } }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs,
    lstatSync: (...args: Parameters<typeof fs.lstatSync>) => { probe.onStat?.(args[0]); return fs.lstatSync(...args) },
    fsync: (fd: number, callback: (error: Error | null) => void) => { if (probe.failSync) queueMicrotask(() => callback(new Error('fixture sync failure'))); else if (probe.beforeSync) void probe.beforeSync().then(() => fs.fsync(fd, callback)); else fs.fsync(fd, callback) },
    unlinkSync: (file: string) => {
      if (probe.failRemove && file.endsWith('/plugin/launcher-register.js')) throw new Error('fixture removal failure')
      return fs.unlinkSync(file)
    },
  }
})
const roots: string[] = []
afterEach(() => {
  probe.major = 1; probe.beforeProbe = undefined; probe.failSync = false; probe.failRemove = false; probe.beforeSync = undefined; probe.onStat = undefined
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-hook-preparation-'))); roots.push(root)
  for (const name of ['HOME', 'ADAPTER_DATA_DIR', 'OPENCODE_CONFIG_DIR', 'OPENCODE_PLUGIN_DIR', 'OPENCODE_DATA_DIR', 'CODEX_HOME', 'HERMES_HOME', 'CURSOR_CONFIG_DIR']) {
    const path = join(root, name === 'OPENCODE_PLUGIN_DIR' ? 'plugin' : name); mkdirSync(path); vi.stubEnv(name, path)
  }
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.resetModules()
  const { installOpencodePlugin } = await import('./nativeHooks.js')
  const { OPENCODE_LEGACY_PLUGIN, OPENCODE_TUI_PLUGIN } = await import('./opencode/contract.js')
  return { root, install: installOpencodePlugin, legacy: OPENCODE_LEGACY_PLUGIN.file, tui: OPENCODE_TUI_PLUGIN.file }
}

it('preserves the legacy first-install TUI preparation while the version is absent', async () => {
  const { install, legacy, tui } = await fixture()
  probe.major = null
  expect(await install(4242)).toBe(true)
  expect(() => readFileSync(legacy)).toThrow()
  expect(readFileSync(tui, 'utf8')).toContain('4242')
  probe.major = 1
  expect(await install(4343)).toBe(true)
  expect(readFileSync(legacy, 'utf8')).toContain('4343')
})

it('holds an upgrade if removal fails and only acknowledges it after recovery', async () => {
  const { install, legacy } = await fixture()
  expect(await install(4242)).toBe(true)
  probe.major = 2; probe.failRemove = true
  expect(await install(4242)).toBe(false)
  expect(readFileSync(legacy, 'utf8')).toContain('MachineRegister')
  probe.failRemove = false
  expect(await install(4242)).toBe(true)
})

it('does not acknowledge either new or already-current hooks while durability is unavailable', async () => {
  const { install } = await fixture()
  expect(await install(4242)).toBe(true)
  probe.failSync = true
  expect(await install(4242)).toBe(false)
  expect(await install(4343)).toBe(false)
  probe.failSync = false
  expect(await install(4343)).toBe(true)
})

it.each([1, 2])('preserves an occupied plugin path before writing any other surface for v%s', async major => {
  const { install, legacy, tui } = await fixture()
  probe.major = major
  mkdirSync(dirname(legacy), { recursive: true })
  writeFileSync(legacy, 'export const ForeignPlugin = {}\n')
  expect(await install(4242)).toBe(false)
  expect(readFileSync(legacy, 'utf8')).toBe('export const ForeignPlugin = {}\n')
  expect(() => readFileSync(tui)).toThrow()
})

it('preserves an occupied TUI path and an existing legacy plugin on upgrade', async () => {
  const { install, legacy, tui } = await fixture()
  expect(await install(4242)).toBe(true)
  const before = readFileSync(legacy, 'utf8')
  writeFileSync(tui, 'export default { id: "foreign" }\n'); probe.major = 2
  expect(await install(4242)).toBe(false)
  expect(readFileSync(legacy, 'utf8')).toBe(before)
  expect(readFileSync(tui, 'utf8')).toBe('export default { id: "foreign" }\n')
})

it('rejects a stale executable snapshot before publishing hooks', async () => {
  const { install, legacy, tui } = await fixture()
  const snapshot = { command: '/fixture/opencode', identity: 'before-upgrade', major: 1, current: () => false }
  expect(await install(4242, snapshot)).toBe(false)
  expect(() => readFileSync(legacy)).toThrow()
  expect(() => readFileSync(tui)).toThrow()
})

it('does not join installation for a different executable identity on the same port', async () => {
  const { install } = await fixture()
  const first = install(4242, { command: '/fixture/one', identity: 'one', major: 1, current: () => true })
  const second = install(4242, { command: '/fixture/two', identity: 'two', major: 2, current: () => true })
  expect(await first).toBe(false)
  // The new executable waits for the old attempt to release its destinations,
  // then obtains its own fresh proof instead of joining the old publication.
  expect(await second).toBe(true)
})

it('keeps mixed foreign commands when refreshing Claude and Codex hooks', async () => {
  const { root } = await fixture()
  const { engineHooks } = await import('./hooks.js')
  const { command } = await import('./kit/notifyHooks.js')
  for (const engine of ['claude', 'codex'] as const) {
    const home = join(root, engine); mkdirSync(home)
    const file = join(home, engine === 'codex' ? 'hooks.json' : 'settings.json')
    const foreign = { type: 'command', command: 'foreign command', custom: { preserve: true } }
    writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [{ matcher: 'foreign matcher', marker: 'preserve', hooks: [
      foreign, { type: 'command', command: command(4343, engine, home) },
    ] }] }, keep: 42 }))
    expect(await engineHooks[engine].installIn(4242, home)).toBe(true)
    const after = JSON.parse(readFileSync(file, 'utf8'))
    expect(after.keep).toBe(42)
    expect(after.hooks.SessionStart[0]).toEqual({ matcher: 'foreign matcher', marker: 'preserve', hooks: [foreign] })
    expect(after.hooks.SessionStart[1].hooks[0].command).toContain('--port 4242')
  }
})

it('holds Codex before hook publication when its approval configuration is unconfirmed', async () => {
  const { root } = await fixture()
  const { engineHooks } = await import('./hooks.js')
  const home = join(root, 'CODEX_HOME'), file = join(home, 'hooks.json'), config = join(home, 'config.toml')
  const original = JSON.stringify({ keep: true })
  writeFileSync(file, original); writeFileSync(config, 'hooks = { state = {} }\n')
  expect(await engineHooks.codex.installIn(4242, home)).toBe(false)
  expect(readFileSync(file, 'utf8')).toBe(original)
  expect(readFileSync(config, 'utf8')).toBe('hooks = { state = {} }\n')
  writeFileSync(config, 'model = "fixture"\n')
  expect(await engineHooks.codex.installIn(4242, home)).toBe(true)
  expect(readFileSync(config, 'utf8')).toContain('trusted_hash')
})

it.each(['{malformed', '{"approvals":{}}'])('preserves Hermes configuration when approvals are unreadable: %s', async approvals => {
  const { root } = await fixture()
  const { installHermesHooks } = await import('./nativeHooks.js')
  const { HERMES_HOOK_SETTINGS: rule } = await import('./hermes/contract.js')
  const home = join(root, 'HERMES_HOME'), file = join(home, rule.homes.file), allowlist = join(home, rule.allowlist)
  writeFileSync(file, 'model: fixture\n'); writeFileSync(allowlist, approvals)
  expect(await installHermesHooks(4242, home)).toBe(false)
  expect(readFileSync(file, 'utf8')).toBe('model: fixture\n')
  expect(readFileSync(allowlist, 'utf8')).toBe(approvals)
  writeFileSync(allowlist, JSON.stringify({ approvals: [{ command: 'foreign', event: 'foreign' }], keep: 42 }))
  expect(await installHermesHooks(4242, home)).toBe(true)
  const after = JSON.parse(readFileSync(allowlist, 'utf8'))
  expect(after.keep).toBe(42)
  expect(after.approvals).toContainEqual({ command: 'foreign', event: 'foreign' })
})

it('preserves the rest of a Hermes document after a truncated or edited managed block', async () => {
  const { root } = await fixture()
  const { installHermesHooks } = await import('./nativeHooks.js')
  const { HERMES_HOOK_SETTINGS: rule } = await import('./hermes/contract.js')
  const home = join(root, 'HERMES_HOME'), file = join(home, rule.homes.file)
  for (const text of [
    `model: fixture\n${rule.begin}\nhooks:\n  foreign: keep\n`,
    `model: fixture\n${rule.begin}\nhooks:\n  foreign: keep\n${rule.end}\n`,
  ]) {
    writeFileSync(file, text)
    expect(await installHermesHooks(4242, home)).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(text)
  }
})

it('holds an upgrade whose legacy plugin is a shared alias', async () => {
  const { root, install, legacy, tui } = await fixture()
  expect(await install(4242)).toBe(true)
  const shared = join(root, 'shared-plugin.js'), previousTui = readFileSync(tui, 'utf8')
  renameSync(legacy, shared); symlinkSync(shared, legacy); probe.major = 2
  expect(await install(4343)).toBe(false)
  expect(realpathSync(legacy)).toBe(shared)
  expect(readFileSync(shared, 'utf8')).toContain('MachineRegister')
  expect(readFileSync(tui, 'utf8')).toBe(previousTui)
})

it('preserves foreign notify.mjs commands when adding managed hooks', async () => {
  const { root } = await fixture()
  const { engineHooks } = await import('./hooks.js')
  const home = join(root, 'CODEX_HOME'), file = join(home, 'hooks.json')
  const foreign = { type: 'command', command: 'node /project/notify.mjs' }
  writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [{ hooks: [foreign] }] } }))
  expect(await engineHooks.codex.installIn(4242, home)).toBe(true)
  expect(JSON.parse(readFileSync(file, 'utf8')).hooks.SessionStart[0]).toEqual({ hooks: [foreign] })
})

it.each(['description = """', 'a=[1 #', '[invalid', 'same = 1\nsame = 2'])('holds malformed TOML before publishing hooks: %s', async malformed => {
  const { root } = await fixture()
  const { engineHooks } = await import('./hooks.js')
  const home = join(root, 'CODEX_HOME'), file = join(home, 'hooks.json'), config = join(home, 'config.toml')
  writeFileSync(config, malformed)
  expect(await engineHooks.codex.installIn(4242, home)).toBe(false)
  expect(() => readFileSync(file)).toThrow()
  expect(readFileSync(config, 'utf8')).toBe(malformed)
})

it.each(['hooks: {foreign: [{command: "foreign"}]}\n', '"hooks": {}\n', "'hooks': {}\n", 'model: [unfinished'])('holds foreign or incomplete YAML: %s', async config => {
  const { root } = await fixture()
  const { installHermesHooks } = await import('./nativeHooks.js')
  const home = join(root, 'HERMES_HOME'), file = join(home, 'config.yaml')
  writeFileSync(file, config)
  expect(await installHermesHooks(4242, home)).toBe(false)
  expect(readFileSync(file, 'utf8')).toBe(config)
})

it.each(['codex', 'hermes'])('checks read-only %s approvals before writing hooks', async engine => {
  const { root } = await fixture()
  const home = join(root, engine === 'codex' ? 'CODEX_HOME' : 'HERMES_HOME')
  const config = join(home, engine === 'codex' ? 'config.toml' : 'shell-hooks-allowlist.json')
  const hookFile = join(home, engine === 'codex' ? 'hooks.json' : 'config.yaml')
  const original = engine === 'codex' ? '{}' : 'model: fixture\n'
  writeFileSync(hookFile, original)
  writeFileSync(config, engine === 'codex' ? 'model = "fixture"\n' : '{"approvals":[]}')
  chmodSync(config, 0o444)
  const { engineHooks } = await import('./hooks.js')
  const { installHermesHooks } = await import('./nativeHooks.js')
  expect(engine === 'codex' ? await engineHooks.codex.installIn(4242, home) : await installHermesHooks(4242, home)).toBe(false)
  expect(readFileSync(hookFile, 'utf8')).toBe(original)
})

it('preserves marker-like text inside a foreign YAML scalar', async () => {
  const { root } = await fixture()
  const { installHermesHooks } = await import('./nativeHooks.js')
  const { HERMES_HOOK_SETTINGS: rule } = await import('./hermes/contract.js')
  const home = join(root, 'HERMES_HOME'), file = join(home, 'config.yaml')
  const config = `description: "text\n  ${rule.begin}\n  hooks:\n    foreign: keep\n  ${rule.end}\n  end"\n`
  writeFileSync(file, config)
  expect(await installHermesHooks(4242, home)).toBe(true)
  expect(readFileSync(file, 'utf8')).toContain(config)
})

it('holds a large YAML structure before parsing or modifying it', async () => {
  const { root } = await fixture()
  const { installHermesHooks } = await import('./nativeHooks.js')
  const home = join(root, 'HERMES_HOME'), file = join(home, 'config.yaml')
  const config = Array.from({ length: 5000 }, (_, index) => `key${index}: value`).join('\n')
  writeFileSync(file, config)
  expect(await installHermesHooks(4242, home)).toBe(false)
  expect(readFileSync(file, 'utf8')).toBe(config)
})


it('installs every healthy Hermes profile beyond the asynchronous preparation pool capacity', async () => {
  const { root } = await fixture()
  const home = join(root, 'HERMES_HOME')
  writeFileSync(join(home, 'config.yaml'), 'model: fixture\n')
  for (let n = 0; n < 18; n++) {
    const profile = join(home, 'profiles', String(n)); mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'config.yaml'), 'model: fixture\n')
  }
  const { installHermesHooks } = await import('./nativeHooks.js')
  expect(await installHermesHooks(4242)).toBe(true)
  for (let n = 0; n < 18; n++) expect(readFileSync(join(home, 'profiles', String(n), 'config.yaml'), 'utf8')).toContain('--port 4242')
}, 20_000)


it('does not join hook preparation across a managed Node command change', async () => {
  const { root } = await fixture()
  const runtime = await import('../lib/nodeRuntime.js')
  const node = vi.spyOn(runtime, 'managedNodePath').mockReturnValue('/fixture/node-before')
  const { engineHooks } = await import('./hooks.js')
  const home = join(root, 'HOME'), file = join(home, 'settings.json')
  writeFileSync(file, '{}\n')
  let release!: () => void, started!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const syncing = new Promise<void>(resolve => { started = resolve })
  probe.beforeSync = () => { started(); return blocked }
  const first = engineHooks.claude.installIn(4242, home)
  await syncing
  node.mockReturnValue('/fixture/node-after')
  expect(await engineHooks.claude.installIn(4242, home)).toBe(false)
  release()
  expect(await first).toBe(false)
  expect(readFileSync(file, 'utf8')).toBe('{}\n')
  probe.beforeSync = undefined
  expect(await engineHooks.claude.installIn(4242, home)).toBe(true)
  expect(readFileSync(file, 'utf8')).toContain('/fixture/node-after')
  expect(readFileSync(file, 'utf8')).not.toContain('/fixture/node-before')
})


it.each([
  'node /foreign/*/notify.mjs --port 42 --data-dir /foreign',
  'node /foreign/notify.mjs\n--port 42 --data-dir /foreign',
  'node /foreign/notify.mjs --port 42 --data-dir /foreign?path',
])('preserves a foreign shell command during hook preparation: %s', async command => {
  const { root } = await fixture()
  const { engineHooks } = await import('./hooks.js')
  const home = join(root, 'HOME'), file = join(home, 'settings.json')
  const foreign = { hooks: [{ type: 'command', command }] }
  writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [foreign] } }))
  expect(await engineHooks.claude.installIn(4242, home)).toBe(true)
  expect(JSON.parse(readFileSync(file, 'utf8')).hooks.SessionStart[0]).toEqual(foreign)
})


it('does not credit a newer OpenCode installation to a revoked older caller', async () => {
  const { install } = await fixture()
  const control = await import('./launchControl.js')
  let release!: (major: number) => void, current = true
  vi.spyOn(control, 'opencodeMajorVersion').mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const first = install(4242, undefined, { current: () => current })
  let releaseDisk!: () => void
  const disk = new Promise<void>(resolve => { releaseDisk = resolve })
  const entered = vi.fn(async () => disk)
  probe.beforeSync = entered
  const second = install(4242)
  await vi.waitFor(() => expect(entered).toHaveBeenCalled())
  release(1)
  // The older caller has joined the newer preparation while still authorized.
  for (let n = 0; n < 80; n++) await Promise.resolve()
  current = false; probe.beforeSync = undefined; releaseDisk()
  expect(await second).toBe(true)
  expect(await first).toBe(false)
})

it('cannot extend the OpenCode deadline by stalling reservation reads', async () => {
  const { install, legacy, tui } = await fixture()
  let time = 0
  vi.spyOn(performance, 'now').mockImplementation(() => time)
  const fs = await import('node:fs')
  vi.spyOn(fs, 'fsync').mockImplementation((_fd, done) => { queueMicrotask(() => done(null)) })
  probe.onStat = path => { if (path === dirname(legacy)) time = 20 }
  expect(await install(4242, undefined, { timeoutMs: 10 })).toBe(false)
  expect(() => readFileSync(legacy)).toThrow()
  expect(() => readFileSync(tui)).toThrow()
})

it('rechecks the OpenCode deadline after final proof reads', async () => {
  const { install } = await fixture()
  let time = 0
  vi.spyOn(performance, 'now').mockImplementation(() => time)
  const files = await import('./kit/nativeHookFiles.js')
  vi.spyOn(files, 'runHookPreparation').mockImplementationOnce(async (_files, _work, options) => {
    options?.confirmed?.({ files: [], current: () => { time = 20; return true } })
    return true as never
  })
  expect(await install(4242, undefined, { timeoutMs: 10 })).toBe(false)
})

it('keeps the original route when following a newer OpenCode publisher', async () => {
  const { root, install } = await fixture()
  const a = join(root, 'route-a'), b = join(root, 'route-b'), alias = join(root, 'selected-config')
  mkdirSync(a); mkdirSync(b); symlinkSync(a, alias)
  const environment = { HOME: join(root, 'HOME'), OPENCODE_PLUGIN_DIR: join(alias, 'plugin') }
  const snapshot = { command: '/fixture/opencode', identity: 'same-executable', major: 2, current: () => true }
  let release!: () => void, began!: () => void
  const paused = new Promise<void>(done => { release = done }), started = new Promise<void>(done => { began = done })
  probe.beforeSync = async () => { probe.beforeSync = undefined; began(); await paused }
  const confirmed = vi.fn()
  const first = install(4242, snapshot, { environment, confirmed })
  try {
    await started
    unlinkSync(alias); symlinkSync(b, alias)
    expect(await install(4242, snapshot, { environment })).toBe(true)
  } finally { release() }
  expect(await first).toBe(false)
  expect(confirmed).not.toHaveBeenCalled()
})

it('cannot write through a route that changed during the version probe', async () => {
  const { root, install } = await fixture()
  const a = join(root, 'probe-a'), b = join(root, 'probe-b'), alias = join(root, 'probe-selected')
  mkdirSync(a); mkdirSync(b); symlinkSync(a, alias)
  const environment = { HOME: join(root, 'HOME'), OPENCODE_PLUGIN_DIR: join(alias, 'plugin') }
  let release!: () => void
  probe.beforeProbe = () => new Promise<void>(done => { release = done })
  const preparing = install(4242, undefined, { environment })
  unlinkSync(alias); symlinkSync(b, alias)
  release()
  expect(await preparing).toBe(false)
  expect(() => readFileSync(join(b, 'plugin/launcher-register.js'))).toThrow()
  expect(() => readFileSync(join(b, 'plugins/launcher-register/tui.js'))).toThrow()
})

it.each(['deadline', 'owner', 'executable'] as const)('checks %s after the last original-route verification', async reason => {
  const { install } = await fixture()
  let time = 0, owner = true, executable = true, verifications = 0
  vi.spyOn(performance, 'now').mockImplementation(() => time)
  const files = await import('./kit/nativeHookFiles.js'), capture = files.hookPreparationRoutes
  vi.spyOn(files, 'hookPreparationRoutes').mockImplementation(paths => {
    const original = capture(paths)
    return { ...original, verify: () => {
      original.verify()
      if (++verifications === 2) {
        if (reason === 'deadline') time = 20
        else if (reason === 'owner') owner = false
        else executable = false
      }
    } }
  })
  vi.spyOn(files, 'runHookPreparation').mockImplementationOnce(async (_files, _work, options) => {
    options?.confirmed?.({ files: [], current: () => true }); return true as never
  })
  const confirmed = vi.fn()
  expect(await install(4242, { command: '/fixture/opencode', identity: 'fixture', major: 2, current: () => executable },
    { timeoutMs: 10, current: () => owner, confirmed })).toBe(false)
  expect(confirmed).not.toHaveBeenCalled()
})


it.each(['direct', 'alias'] as const)('waits for startup maintenance before proving concurrent OpenCode launches through %s paths', async route => {
  const { root, install, tui } = await fixture()
  const alias = join(root, 'selected-config'); symlinkSync(root, alias)
  const environment = route === 'alias' ? { HOME: join(root, 'HOME'), OPENCODE_PLUGIN_DIR: join(alias, 'plugin') } : undefined
  probe.major = 2
  let release!: () => void, began!: () => void
  const disk = new Promise<void>(done => { release = done }), started = new Promise<void>(done => { began = done })
  probe.beforeSync = async () => { probe.beforeSync = undefined; began(); await disk }
  const maintenance = install(4242)
  await started
  const confirmed = vi.fn(), siblingConfirmed = vi.fn()
  let answered = false
  const snapshot = { command: '/fixture/opencode', identity: 'launch-executable', major: 2, current: () => true }
  const launch = install(4242, snapshot, { environment, confirmed }).finally(() => { answered = true })
  const sibling = install(4242, snapshot, { environment, confirmed: siblingConfirmed })
  try {
    for (let n = 0; n < 80; n++) await Promise.resolve()
    expect(answered).toBe(false)
    expect(confirmed).not.toHaveBeenCalled()
  } finally { release() }
  expect(await maintenance).toBe(false)
  expect(await launch).toBe(true)
  expect(await sibling).toBe(true)
  expect(siblingConfirmed).toHaveBeenCalledOnce()
  expect(siblingConfirmed.mock.calls[0][0].current()).toBe(true)
  expect(confirmed).toHaveBeenCalledOnce()
  expect(confirmed.mock.calls[0][0].current()).toBe(true)
  expect(readFileSync(tui, 'utf8')).toContain('4242')
})

it.each(['owner', 'executable', 'deadline'] as const)('keeps %s authority while waiting for startup maintenance', async reason => {
  const { install, tui } = await fixture()
  probe.major = 2
  let release!: () => void, began!: () => void, owner = true, executable = true
  const disk = new Promise<void>(done => { release = done }), started = new Promise<void>(done => { began = done })
  probe.beforeSync = async () => { probe.beforeSync = undefined; began(); await disk }
  const maintenance = install(4242)
  await started
  const confirmed = vi.fn()
  const launch = install(4242, { command: '/fixture/opencode', identity: 'launch-executable', major: 2, current: () => executable },
    { current: () => owner, confirmed, timeoutMs: reason === 'deadline' ? 30 : 5_000 })
  if (reason === 'owner') owner = false
  if (reason === 'executable') executable = false
  try {
    if (reason === 'deadline') expect(await launch).toBe(false)
  } finally { release() }
  expect(await launch).toBe(false)
  expect(await maintenance).toBe(false)
  expect(confirmed).not.toHaveBeenCalled()
  expect(() => readFileSync(tui)).toThrow()
})


it('bounds launch callers waiting for startup maintenance and recovers after overflow', async () => {
  const { install } = await fixture()
  probe.major = 2
  let release!: () => void, began!: () => void
  const disk = new Promise<void>(done => { release = done }), started = new Promise<void>(done => { began = done })
  probe.beforeSync = async () => { probe.beforeSync = undefined; began(); await disk }
  const maintenance = install(4242)
  await started
  const snapshot = { command: '/fixture/opencode', identity: 'launch-executable', major: 2, current: () => true }
  const launches = Array.from({ length: 15 }, () => install(4242, snapshot))
  let overflowReply: boolean | undefined
  const overflow = install(4242, snapshot).then(reply => { overflowReply = reply })
  try {
    await vi.waitFor(() => expect(overflowReply).toBe(false), { timeout: 500 })
  } finally { release(); await Promise.all([maintenance, ...launches, overflow]) }
  await overflow
  expect(await maintenance).toBe(false)
  expect(await Promise.all(launches)).toEqual(Array(15).fill(true))
  expect(await install(4242, snapshot)).toBe(true)
})
