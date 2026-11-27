/**
 * The dial setup's Codex plugin pass against a fake `codex` in each throwaway Codex home: a run that answers as
 * codex-cli 0.172.0 does (codexPlugin.spec.ts's), writing what Codex writes into that home, with a fake clock and the
 * trust writer watched. The real `codex` and ~/.codex are never touched.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeAnswer, ClaudePluginFiles, ClaudeRun } from '../devices/claudePlugin.js'
import * as codexPlugin from '../devices/codexPlugin.js'
import { carriedCodexHash, type CodexRun, installedRoot, MIN_CODEX } from '../devices/codexPlugin.js'
import { readConfigText, writePluginTrust } from '../devices/codexPluginTrust.js'
import { MAX_HOMES } from '../devices/dialSkillFiles.js'
import { CODEX_SETUP_COUNTS, createDialCodexPluginSetup, type DialCodexPluginSetupDeps } from './dialCodexPluginSetup.js'

// A copy of the module, so a test can watch what the pass asks of it.
vi.mock('../devices/codexPlugin.js', async (original) => ({ ...await original<object>() }))

const PLUGIN = 'harness-device@openharness'
const ADD = `plugin add ${PLUGIN} --json`
const REMOVE = `plugin remove ${PLUGIN}`
const OWN_GIT = '[marketplaces.openharness]\nsource_type = "git"\nsource = "https://github.com/autonomous-ai/openharness.git"\n'
const HOUR = 3_600_000
const VERSION = '0.6.59'

/** The device plugin as Codex installs it (codexPluginTrust.spec.ts's tree), under the marketplace folder's path. */
const DEVICE: Readonly<Record<string, string>> = {
  '.codex-plugin/plugin.json': '{"name":"harness-device","hooks":"./hooks/codex.json"}\n',
  'hooks/codex.json': '{"hooks":{"PermissionRequest":[{"matcher":"*","hooks":[{"type":"command","command":"fixture permission","onFailure":"continue","timeout":5}]}],"PreToolUse":[{"matcher":"request_user_input","hooks":[{"type":"command","command":"fixture question","onFailure":"continue","timeout":5}]}]}}\n',
  'hooks/codex-asked': '#!/bin/sh\nexit 0\n',
  'README.md': 'fixture\n',
}
const carried = (device: Readonly<Record<string, string>> = DEVICE): ClaudePluginFiles => ({
  files: {
    '.claude-plugin/marketplace.json': '{"name":"openharness","plugins":[{"name":"harness-device","source":"./plugins/harness-device"}]}\n',
    ...Object.fromEntries(Object.entries(device).map(([path, text]) => [`plugins/harness-device/${path}`, text])),
  },
  executable: ['plugins/harness-device/hooks/codex-asked'],
})
const FILES = carried()
const EXPECTED = carriedCodexHash(FILES, process.platform)

const folders: string[] = []
/** Folders a spec made unreadable, made readable again before they are removed. */
const locked: string[] = []
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const dir of locked.splice(0)) chmodSync(dir, 0o700)
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dial-codex-'))
  folders.push(dir)
  return realpathSync(dir)
}

/** A Codex home, by its real path, with [config] as its config.toml, or none. */
function codexHome(config?: string): string {
  const home = join(temp(), '.codex')
  mkdirSync(home)
  if (config !== undefined) writeFileSync(join(home, 'config.toml'), config)
  return home
}
const configFile = (home: string): string => join(home, 'config.toml')
const configOf = (home: string): string => readFileSync(configFile(home), 'utf8')
/** The trust records' fingerprints in [home]'s config.toml, by key. */
const contentHashes = (home: string): unknown[] => {
  const state = (parseToml(configOf(home)) as { hooks?: { state?: Record<string, { trusted_content_hash?: unknown }> } }).hooks?.state ?? {}
  return Object.keys(state).sort().map((key) => state[key].trusted_content_hash)
}
/** [home]'s config.toml without its trust records, as another writer could leave it. */
const withoutTrust = (home: string): void => {
  const text = configOf(home)
  writeFileSync(configFile(home), text.slice(0, text.indexOf('[hooks.state')))
}

let tick = 0
/** A new time on the installed folder, as Codex's own reinstall or a file added by hand gives it. */
const touch = (home: string): void => {
  const at = new Date(Date.UTC(2020, 0, 1) + ++tick * 1000)
  utimesSync(installedRoot(home), at, at)
}

interface FakeOptions {
  /** Read at each `--version`, so a spec can change it. */
  version?: string
  /** Calls that exit 1, with a line naming the home as Codex's own does. */
  fail?: string[]
  /** Sees each call before it is answered. */
  on?: (call: string) => void
  /** Changes the copy `plugin add` made, as a marketplace that is not the carried copy would. */
  installed?: (root: string) => void
  /** What `plugin add` prints in place of its JSON, its copy made. */
  printed?: string
}

/**
 * A `codex` for [home] that answers as codex-cli 0.172.0: `marketplace add` records the folder by its canonical path,
 * `plugin add` copies the marketplace's plugin into the cache, turns it on and prints its JSON, `plugin remove` takes
 * both out again.
 */
function fakeCodex(home: string, folder: string, options: FakeOptions = {}) {
  const { fail = [], on, installed, printed } = options
  const calls: string[] = []
  const append = (text: string): void => writeFileSync(configFile(home), `${existsSync(configFile(home)) ? configOf(home) : ''}${text}`)
  const answer = (stdout = ''): ClaudeAnswer => ({ code: 0, stdout, stderr: '' })
  const run: ClaudeRun = async (args) => {
    const call = args.join(' ')
    calls.push(call)
    on?.(call)
    if (fail.includes(call)) return { code: 1, stdout: '', stderr: `Error: ${home}/config.toml is read-only\n` }
    if (call === '--version') return answer(`codex-cli ${options.version ?? MIN_CODEX}\n`)
    if (call === `plugin marketplace add ${folder}`) {
      append(`[marketplaces.openharness]\nsource_type = "local"\nsource = ${JSON.stringify(realpathSync(folder))}\n`)
    }
    if (call === ADD) {
      rmSync(installedRoot(home), { recursive: true, force: true })
      cpSync(join(folder, 'plugins', 'harness-device'), installedRoot(home), { recursive: true })
      installed?.(installedRoot(home))
      if (!configOf(home).includes(`[plugins."${PLUGIN}"]`)) append(`[plugins."${PLUGIN}"]\nenabled = true\n`)
      return answer(printed ?? JSON.stringify({ pluginId: PLUGIN, version: 'local', installedPath: installedRoot(home) }))
    }
    if (call === REMOVE) {
      rmSync(installedRoot(home), { recursive: true, force: true })
      writeFileSync(configFile(home), configOf(home).replace(`[plugins."${PLUGIN}"]\nenabled = true\n`, ''))
    }
    return answer()
  }
  return { run, calls }
}

type Counted = [string] | [string, string]

/** A pass over throwaway Codex homes: Codex found in each, wanted, this CLI carrying the fixture copy, and a record that
 *  refuses a 65th home as dialHomeSetup's does. */
function rig(over: Partial<DialCodexPluginSetupDeps> = {}) {
  const marketplace = join(temp(), 'claude-marketplace')
  const state = {
    homes: [] as string[],
    wanted: true as boolean | undefined,
    recorded: {} as Record<string, string>,
    saves: true,
    now: 0,
    /** What cli.js carries: null in a run from the sources. */
    files: FILES as ClaudePluginFiles | null,
    found: true,
  }
  const options = new Map<string, FakeOptions>()
  const fakes = new Map<string, ReturnType<typeof fakeCodex>>()
  /** [home]'s `codex`, made at its first use with that home's options. */
  const fake = (home: string): ReturnType<typeof fakeCodex> => {
    let codex = fakes.get(home)
    if (!codex) fakes.set(home, codex = fakeCodex(home, marketplace, options.get(home)))
    return codex
  }
  const looked: string[] = []
  const shells: boolean[] = []
  const counted: Counted[] = []
  const records: Array<[string, string | null]> = []
  const trust = vi.fn<DialCodexPluginSetupDeps['trust']>((home, root, expected) => writePluginTrust(home, root, expected))
  const wanted = vi.fn(() => state.wanted)
  const deps: DialCodexPluginSetupDeps = {
    platform: process.platform,
    version: VERSION,
    codex: async (home, shell) => {
      looked.push(home)
      shells.push(shell)
      return state.found ? fake(home).run : null
    },
    plugin: { folder: marketplace, files: () => state.files },
    homes: () => state.homes,
    wanted,
    recorded: () => state.recorded,
    record: (home, version) => {
      records.push([home, version])
      if (!state.saves) return false
      const next = { ...state.recorded }
      if (version === null) delete next[home]
      else if (!Object.hasOwn(next, home) && Object.keys(next).length >= MAX_HOMES) return false
      else next[home] = version
      state.recorded = next
      return true
    },
    trust,
    now: () => state.now,
    count: (kind, reason) => { counted.push(reason === undefined ? [kind] : [kind, reason]) },
    ...over,
  }
  /** Another devices process over the same record, as after a CLI update. */
  const make = (more: Partial<DialCodexPluginSetupDeps> = {}) => createDialCodexPluginSetup({ ...deps, ...more })
  return { setup: make(), make, state, options, fake, looked, shells, counted, records, trust, wanted, marketplace }
}

describe('createDialCodexPluginSetup', () => {
  it('counts what the plugin setup counts, then untrusted and skipped', () => {
    expect(CODEX_SETUP_COUNTS).toEqual(['set up', 'updated', 'failed', 'left removed', 'untrusted', 'skipped'])
  })

  it('installs once into each home it serves, by real path, and records this version for each', async () => {
    const r = rig()
    const a = codexHome(), b = codexHome()
    const link = join(temp(), 'b')
    symlinkSync(b, link, 'junction')
    r.state.homes = [a, b, a, link]
    await r.setup.pass()
    expect(r.looked).toEqual([a, b])
    for (const home of [a, b]) expect(r.fake(home).calls).toEqual(['--version', `plugin marketplace add ${r.marketplace}`, ADD])
    expect(r.state.recorded).toEqual({ [a]: VERSION, [b]: VERSION })
    expect(r.counted).toEqual([['set up'], ['set up']])

    await r.setup.pass()
    expect(r.looked).toEqual([a, b])
  })

  it('trust is written after the install and again after an update', async () => {
    const r = rig()
    const home = codexHome('model = "gpt-5"\n')
    r.state.homes = [home]
    await r.setup.pass()
    expect(contentHashes(home)).toEqual([EXPECTED, EXPECTED])

    // A CLI update carrying a changed file: another process, at another version.
    const changed = carried({ ...DEVICE, 'README.md': 'fixture, updated\n' })
    await r.make({ version: '0.6.60', plugin: { folder: r.marketplace, files: () => changed } }).pass()
    expect(r.fake(home).calls).toEqual(['--version', `plugin marketplace add ${r.marketplace}`, ADD, '--version', ADD])
    const updated = carriedCodexHash(changed, process.platform)
    expect(updated).not.toBe(EXPECTED)
    expect(contentHashes(home)).toEqual([updated, updated])
    expect(r.state.recorded).toEqual({ [home]: '0.6.60' })
    expect(r.counted).toEqual([['set up'], ['updated']])
  })

  it('a pass with every home current runs no codex and computes no fingerprint while neither stat changed', async () => {
    const r = rig()
    const hashed = vi.spyOn(codexPlugin, 'carriedCodexHash')
    r.state.homes = [codexHome(), codexHome()]
    await r.setup.pass()
    expect(r.looked).toHaveLength(2)
    r.wanted.mockClear()
    r.trust.mockClear()

    await r.setup.pass()
    await r.setup.pass()
    expect(r.looked).toHaveLength(2)
    expect(r.wanted).not.toHaveBeenCalled()
    expect(r.trust).not.toHaveBeenCalled()
    // The carried copy's, once a process.
    expect(hashed).toHaveBeenCalledTimes(1)
  })

  it('the re-check writes trust again for a folder that matches', async () => {
    const r = rig()
    const home = codexHome()
    r.state.homes = [home]
    await r.setup.pass()
    r.trust.mockClear()
    withoutTrust(home)
    expect(contentHashes(home)).toEqual([])

    await r.setup.pass()
    expect(r.trust).toHaveBeenCalledTimes(1)
    expect(contentHashes(home)).toEqual([EXPECTED, EXPECTED])
    expect(r.looked).toHaveLength(1)
    expect(r.counted).toEqual([['set up']])
  })

  it('the re-check after Codex reinstalled the same copy', async () => {
    const r = rig()
    const home = codexHome()
    r.state.homes = [home]
    await r.setup.pass()
    r.trust.mockClear()
    rmSync(installedRoot(home), { recursive: true, force: true })
    cpSync(join(r.marketplace, 'plugins', 'harness-device'), installedRoot(home), { recursive: true })
    writeFileSync(configFile(home), configOf(home).replaceAll(EXPECTED, `sha256:${'0'.repeat(64)}`))

    await r.setup.pass()
    expect(r.trust).toHaveBeenCalledTimes(1)
    expect(contentHashes(home)).toEqual([EXPECTED, EXPECTED])
    expect(r.looked).toHaveLength(1)
  })

  it('a change to config.toml right after an install\'s trust write is checked', async () => {
    const r = rig()
    const home = codexHome()
    r.state.homes = [home]
    // Another writer drops the records while the pass reads dial-skill.json after the install.
    let added = false
    r.options.set(home, { on: (call) => { if (call === ADD) added = true } })
    r.wanted.mockImplementation(() => {
      if (added) withoutTrust(home)
      added = false
      return r.state.wanted
    })
    await r.setup.pass()
    await r.setup.pass()
    expect(contentHashes(home)).toEqual([EXPECTED, EXPECTED])
  })

  /** A rig whose re-check runs [then] once, right after the trust write, while [racing]. */
  function racing(then: (home: string, root: string) => void) {
    const race = { on: false }
    const trust = vi.fn<DialCodexPluginSetupDeps['trust']>((home, root, expected) => {
      const wrote = writePluginTrust(home, root, expected)
      if (race.on) then(home, root)
      race.on = false
      return wrote
    })
    return { ...rig({ trust }), race }
  }

  it('a change to config.toml right after a re-check\'s write is checked at the next pass', async () => {
    const r = racing((home) => withoutTrust(home))
    const home = codexHome()
    r.state.homes = [home]
    await r.setup.pass()
    withoutTrust(home)
    r.race.on = true
    await r.setup.pass()
    await r.setup.pass()
    expect(contentHashes(home)).toEqual([EXPECTED, EXPECTED])
  })

  it('a change to the installed folder right after a re-check\'s fingerprint is checked at the next pass', async () => {
    // Codex reinstalls another copy just after the folder was fingerprinted.
    const r = racing((home, root) => {
      writeFileSync(join(root, 'README.md'), 'fixture, edited\n')
      touch(home)
    })
    const home = codexHome()
    r.state.homes = [home]
    await r.setup.pass()
    touch(home)
    r.race.on = true
    await r.setup.pass()
    await r.setup.pass()
    expect(r.counted).toEqual([['set up'], ['untrusted', 'differs']])
  })

  it('a folder that differs is never trusted, and said once', async () => {
    const r = rig()
    const home = codexHome()
    r.state.homes = [home]
    await r.setup.pass()
    r.trust.mockClear()
    const config = configOf(home)
    const readme = join(installedRoot(home), 'README.md')
    writeFileSync(readme, 'fixture, edited\n')
    for (let at = 0; at < 3; at++) {
      touch(home)
      await r.setup.pass()
    }
    expect(r.trust).toHaveBeenCalledTimes(3)
    expect(configOf(home)).toBe(config)
    expect(r.counted).toEqual([['set up'], ['untrusted', 'differs']])

    // Put back: trusted again, so a later edit is said again.
    writeFileSync(readme, 'fixture\n')
    touch(home)
    await r.setup.pass()
    expect(r.trust.mock.results.at(-1)?.value).toEqual({ ok: true, changed: false })
    writeFileSync(readme, 'fixture, edited again\n')
    touch(home)
    await r.setup.pass()
    expect(r.counted).toEqual([['set up'], ['untrusted', 'differs'], ['untrusted', 'differs']])
    expect(r.looked).toHaveLength(1)
  })

  it('a copy Codex installs that is not the carried one is set up untrusted, and said once', async () => {
    const r = rig()
    const home = codexHome()
    r.state.homes = [home]
    // As a GitHub `main` holds the plugin's tests beside it.
    r.options.set(home, { installed: (root) => {
      mkdirSync(join(root, 'test'))
      writeFileSync(join(root, 'test', 'case.mjs'), 'test\n')
    } })
    await r.setup.pass()
    expect(contentHashes(home)).toEqual([])
    expect(r.state.recorded).toEqual({ [home]: VERSION })
    expect(r.counted).toEqual([['set up'], ['untrusted', 'differs']])
    r.trust.mockClear()

    touch(home)
    await r.setup.pass()
    expect(r.trust).toHaveBeenCalledTimes(1)
    expect(contentHashes(home)).toEqual([])
    expect(r.counted).toEqual([['set up'], ['untrusted', 'differs']])
  })

  it('a home whose openharness marketplace is the person\'s own is skipped: nothing installed, nothing written, said once', async () => {
    const r = rig()
    const own = codexHome(OWN_GIT), other = codexHome()
    const before = configOf(own)
    const mtime = statSync(configFile(own)).mtimeMs
    r.state.homes = [own, other]
    for (let at = 0; at < 3; at++) {
      r.state.now = at * HOUR
      await r.setup.pass()
    }
    expect(r.fake(own).calls).toEqual(['--version', '--version', '--version'])
    expect(r.records.filter(([home]) => home === own)).toEqual([])
    expect(r.trust.mock.calls.filter(([home]) => home === own)).toEqual([])
    expect(configOf(own)).toBe(before)
    expect(statSync(configFile(own)).mtimeMs).toBe(mtime)
    expect(existsSync(join(own, 'plugins'))).toBe(false)
    expect(r.counted).toEqual([['skipped', 'own marketplace'], ['set up']])
    expect(r.state.recorded).toEqual({ [other]: VERSION })
  })

  it('a recorded home whose marketplace became the person\'s own is skipped from then on and leaves the record', async () => {
    const r = rig()
    const home = codexHome()
    r.state.homes = [home]
    await r.setup.pass()
    r.trust.mockClear()
    // The person removed Harness's marketplace and added GitHub's.
    writeFileSync(configFile(home), configOf(home).replace(/\[marketplaces\.openharness\][^[]*/, OWN_GIT))
    const asked = vi.spyOn(codexPlugin, 'codexHomeState')

    await r.setup.pass()
    expect(asked).toHaveBeenCalledWith(home, r.marketplace)
    expect(r.trust).not.toHaveBeenCalled()
    expect(r.records).toEqual([[home, VERSION], [home, null]])
    expect(r.state.recorded).toEqual({})
    expect(r.counted).toEqual([['set up'], ['skipped', 'own marketplace']])
    expect(r.fake(home).calls).toEqual(['--version', `plugin marketplace add ${r.marketplace}`, ADD])

    r.state.now = HOUR - 1
    await r.setup.pass()
    r.state.now = 2 * HOUR
    await r.setup.pass()
    expect(r.fake(home).calls).toEqual(['--version', `plugin marketplace add ${r.marketplace}`, ADD, '--version'])
    expect(r.counted).toEqual([['set up'], ['skipped', 'own marketplace']])
    expect(r.state.recorded).toEqual({})
  })

  it('no 65th home is installed into', async () => {
    const r = rig()
    const full = Array.from({ length: MAX_HOMES }, () => codexHome())
    r.state.recorded = Object.fromEntries(full.map((home) => [home, VERSION]))
    const extra = codexHome()
    r.state.homes = [extra]
    await r.setup.pass()
    expect(r.looked).toEqual([])
    expect(r.counted).toEqual([['failed', 'full']])
    expect(r.records).toEqual([])

    // Once a process.
    r.state.now = HOUR
    await r.setup.pass()
    expect(r.looked).toEqual([])
    expect(r.counted).toEqual([['failed', 'full']])

    // A recorded home that is gone leaves the record first.
    rmSync(full[0], { recursive: true, force: true })
    r.state.now = 2 * HOUR
    await r.setup.pass()
    expect(r.records).toEqual([[full[0], null], [extra, VERSION]])
    expect(r.fake(extra).calls).toEqual(['--version', `plugin marketplace add ${r.marketplace}`, ADD])
    expect(r.counted).toEqual([['failed', 'full'], ['set up']])
  })

  it('a record that is not saved after an install is failed · record, and set up again after its hour', async () => {
    const r = rig()
    const home = codexHome()
    r.state.homes = [home]
    r.state.saves = false
    await r.setup.pass()
    expect(r.counted).toEqual([['failed', 'record']])
    expect(r.state.recorded).toEqual({})

    r.state.now = HOUR - 1
    await r.setup.pass()
    expect(r.looked).toHaveLength(1)

    r.state.saves = true
    r.state.now = HOUR
    await r.setup.pass()
    expect(r.fake(home).calls).toEqual(['--version', `plugin marketplace add ${r.marketplace}`, ADD, '--version', ADD])
    expect(r.state.recorded).toEqual({ [home]: VERSION })
    expect(r.counted).toEqual([['failed', 'record'], ['set up']])
  })

  it('a re-check whose write fails says its kind and waits its hour', async () => {
    let changing = false
    let reads = 0
    // A config.toml another writer changes at each read, while [changing].
    const trust = vi.fn<DialCodexPluginSetupDeps['trust']>((home, root, expected) => writePluginTrust(home, root, expected,
      changing ? { read: (file) => `${readConfigText(file)}# ${reads++}\n`, replace: () => { throw new Error('not reached') } } : undefined))
    const r = rig({ trust })
    const home = codexHome()
    r.state.homes = [home]
    await r.setup.pass()
    trust.mockClear()
    changing = true
    withoutTrust(home)
    await r.setup.pass()
    expect(trust).toHaveBeenCalledTimes(1)
    expect(r.counted).toEqual([['set up'], ['failed', 'trust · changed']])
    expect(contentHashes(home)).toEqual([])
    // Fixed words alone: no path, no text of the file.
    for (const word of r.counted.flat()) expect(word).toMatch(/^[a-z0-9 ·]+$/)

    touch(home)
    r.state.now = HOUR - 1
    await r.setup.pass()
    expect(trust).toHaveBeenCalledTimes(1)

    changing = false
    r.state.now = HOUR
    await r.setup.pass()
    expect(trust).toHaveBeenCalledTimes(2)
    expect(contentHashes(home)).toEqual([EXPECTED, EXPECTED])
    expect(r.counted).toEqual([['set up'], ['failed', 'trust · changed']])
    expect(r.looked).toHaveLength(1)
  })

  it('a home the person removed the plugin from stays removed', async () => {
    const r = rig()
    // Removed from config.toml, its cached copy left behind.
    const home = codexHome('model = "gpt-5"\n')
    for (const [path, text] of Object.entries(DEVICE)) {
      mkdirSync(join(installedRoot(home), path, '..'), { recursive: true })
      writeFileSync(join(installedRoot(home), path), text)
    }
    r.state.homes = [home]
    r.state.recorded = { [home]: '0.6.58' }
    await r.setup.pass()
    expect(r.fake(home).calls).toEqual(['--version'])
    expect(r.counted).toEqual([['left removed']])
    expect(r.state.recorded).toEqual({ [home]: VERSION })

    const config = configOf(home)
    rmSync(installedRoot(home), { recursive: true, force: true })
    await r.setup.pass()
    expect(r.trust).not.toHaveBeenCalled()
    expect(configOf(home)).toBe(config)
    expect(r.fake(home).calls).toEqual(['--version'])
    expect(r.counted).toEqual([['left removed']])
  })

  it('the re-check leaves a plugin the person turned off alone: no trust written, no differs said', async () => {
    const r = rig()
    const home = codexHome()
    r.state.homes = [home]
    await r.setup.pass()
    // Turned off in Codex, and its trust records dropped by another writer.
    writeFileSync(configFile(home), configOf(home).replace(`[plugins."${PLUGIN}"]\nenabled = true\n`, `[plugins."${PLUGIN}"]\nenabled = false\n`))
    withoutTrust(home)
    const config = configOf(home)
    r.trust.mockClear()
    await r.setup.pass()
    writeFileSync(join(installedRoot(home), 'README.md'), 'fixture, edited\n')
    touch(home)
    await r.setup.pass()
    expect(configOf(home)).toBe(config)
    expect(r.trust).not.toHaveBeenCalled()
    expect(r.counted).toEqual([['set up']])
  })

  it('a config.toml removed with the installed folder left is no failure: nothing to trust there', async () => {
    const r = rig()
    const home = codexHome()
    r.state.homes = [home]
    await r.setup.pass()
    rmSync(configFile(home))
    r.trust.mockClear()
    for (let at = 1; at <= 2; at++) {
      r.state.now = at * HOUR
      await r.setup.pass()
    }
    expect(r.trust).not.toHaveBeenCalled()
    expect(r.counted).toEqual([['set up']])
    expect(existsSync(configFile(home))).toBe(false)
  })

  it('a disable that lands during the install takes it out again and records nothing', async () => {
    const r = rig()
    const home = codexHome()
    r.state.homes = [home]
    r.options.set(home, { on: (call) => { if (call === ADD) r.state.wanted = false } })
    await r.setup.pass()
    expect(r.fake(home).calls).toEqual(['--version', `plugin marketplace add ${r.marketplace}`, ADD, '--version', REMOVE])
    expect(r.state.recorded).toEqual({})
    expect(r.counted).toEqual([])
    expect(existsSync(installedRoot(home))).toBe(false)
  })

  it('a disable that lands during an install whose check then fails takes it out again and records nothing', async () => {
    const r = rig()
    const home = codexHome()
    r.state.homes = [home]
    r.options.set(home, { printed: 'installed\n', on: (call) => { if (call === ADD) r.state.wanted = false } })
    await r.setup.pass()
    expect(r.fake(home).calls).toEqual(['--version', `plugin marketplace add ${r.marketplace}`, ADD, '--version', REMOVE])
    expect(r.state.recorded).toEqual({})
    expect(r.counted).toEqual([])
    expect(existsSync(installedRoot(home))).toBe(false)
  })

  it('a disable that lands during one home\'s install ends the pass: no other home is run', async () => {
    const r = rig()
    const a = codexHome(), b = codexHome()
    r.state.homes = [a, b]
    r.options.set(a, { on: (call) => { if (call === ADD) r.state.wanted = false } })
    await r.setup.pass()
    expect(r.looked).toEqual([a])
    expect(r.fake(a).calls).toEqual(['--version', `plugin marketplace add ${r.marketplace}`, ADD, '--version', REMOVE])
    expect(r.state.recorded).toEqual({})
  })

  it('a dial-skill.json that cannot be read after an install ends the pass: no other home is run or re-checked', async () => {
    const r = rig()
    const current = codexHome()
    r.state.homes = [current]
    await r.setup.pass()
    withoutTrust(current)
    r.trust.mockClear()
    const a = codexHome(), b = codexHome()
    r.state.homes = [current, a, b]
    r.options.set(a, { on: (call) => { if (call === ADD) r.state.wanted = undefined } })
    await r.setup.pass()
    expect(r.looked).toEqual([current, a])
    expect(r.trust).not.toHaveBeenCalled()
    expect(contentHashes(current)).toEqual([])
  })

  /** A home whose `disable` landed during its install, and whose removal failed: owed, its hour started at 0. */
  async function owing() {
    const r = rig()
    const home = codexHome()
    const fail = [REMOVE]
    let adds = 0
    r.state.homes = [home]
    r.options.set(home, { fail, on: (call) => { if (call === ADD && adds++ === 0) r.state.wanted = false } })
    await r.setup.pass()
    expect(r.counted).toEqual([['failed', 'remove · exit 1']])
    return { ...r, home, fail }
  }

  it('a removal after a disable that fails is owed, and tried again after its hour while Codex is not wanted', async () => {
    const r = await owing()
    const tried = ['--version', `plugin marketplace add ${r.marketplace}`, ADD, '--version', REMOVE]
    expect(r.fake(r.home).calls).toEqual(tried)

    r.state.now = HOUR - 1
    await r.setup.pass()
    expect(r.fake(r.home).calls).toEqual(tried)

    r.fail.pop()
    r.state.now = HOUR
    await r.setup.pass()
    expect(r.fake(r.home).calls).toEqual([...tried, '--version', REMOVE])
    expect(existsSync(installedRoot(r.home))).toBe(false)
    expect(r.state.recorded).toEqual({})
    expect(r.counted).toEqual([['failed', 'remove · exit 1']])

    // Nothing owed any more.
    r.state.now = 3 * HOUR
    await r.setup.pass()
    expect(r.fake(r.home).calls).toEqual([...tried, '--version', REMOVE])
  })

  it('an owed removal in a home whose marketplace became the person\'s own removes nothing there, and is owed no more', async () => {
    const r = await owing()
    const calls = [...r.fake(r.home).calls]
    // The person removed Harness's marketplace and added GitHub's; the plugin there is theirs now.
    writeFileSync(configFile(r.home), configOf(r.home).replace(/\[marketplaces\.openharness\][^[]*/, OWN_GIT))
    const config = configOf(r.home)
    r.fail.pop()
    r.state.now = HOUR
    await r.setup.pass()
    r.state.now = 3 * HOUR
    await r.setup.pass()
    expect(r.fake(r.home).calls).toEqual(calls)
    expect(configOf(r.home)).toBe(config)
    expect(r.counted).toEqual([['failed', 'remove · exit 1'], ['skipped', 'own marketplace']])
  })

  it('an owed removal is owed no more once Codex is wanted again', async () => {
    const r = await owing()
    // `enable` ran: the home is set up as any other.
    r.state.wanted = true
    r.state.now = HOUR
    await r.setup.pass()
    expect(r.state.recorded).toEqual({ [r.home]: VERSION })
    expect(r.counted).toEqual([['failed', 'remove · exit 1'], ['set up']])

    // A later `disable` takes the plugin out of each recorded home itself.
    r.state.wanted = false
    const calls = [...r.fake(r.home).calls]
    r.state.now = 3 * HOUR
    await r.setup.pass()
    expect(r.fake(r.home).calls).toEqual(calls)
  })

  it('an owed removal waits while dial-skill.json cannot be read', async () => {
    const r = await owing()
    const calls = [...r.fake(r.home).calls]
    r.state.wanted = undefined
    r.state.now = HOUR
    await r.setup.pass()
    expect(r.fake(r.home).calls).toEqual(calls)
  })

  it('no codex for an owed removal: nothing counted, and tried at the next pass', async () => {
    const r = await owing()
    const calls = [...r.fake(r.home).calls]
    r.fail.pop()
    r.state.found = false
    r.state.now = HOUR
    await r.setup.pass()
    expect(r.counted).toEqual([['failed', 'remove · exit 1']])

    r.state.found = true
    r.state.now = HOUR + 1
    await r.setup.pass()
    expect(r.fake(r.home).calls).toEqual([...calls, '--version', REMOVE])
    expect(r.counted).toEqual([['failed', 'remove · exit 1']])
  })

  it('not wanted: nothing installed or removed', async () => {
    const r = rig()
    const fresh = codexHome(), old = codexHome(`[plugins."${PLUGIN}"]\nenabled = true\n`)
    r.state.homes = [fresh, old]
    r.state.recorded = { [old]: '0.6.58' }
    r.state.wanted = false
    await r.setup.pass()
    expect(r.looked).toEqual([])
    expect(r.counted).toEqual([])
    expect(r.state.recorded).toEqual({ [old]: '0.6.58' })
  })

  it('wanted unknown: nothing', async () => {
    const r = rig()
    r.state.homes = [codexHome()]
    r.state.wanted = undefined
    await r.setup.pass()
    expect(r.looked).toEqual([])
    expect(r.counted).toEqual([])
    expect(r.records).toEqual([])
  })

  it('a dial-skill.json that cannot be read after the install: nothing undone or recorded', async () => {
    const r = rig()
    const home = codexHome()
    r.state.homes = [home]
    r.options.set(home, { on: (call) => { if (call === ADD) r.state.wanted = undefined } })
    await r.setup.pass()
    expect(r.fake(home).calls).toEqual(['--version', `plugin marketplace add ${r.marketplace}`, ADD])
    expect(r.records).toEqual([])
    expect(r.counted).toEqual([])
  })

  it('Codex removed (homes() empty): no re-check', async () => {
    const r = rig()
    const home = codexHome()
    r.state.homes = [home]
    await r.setup.pass()
    r.trust.mockClear()
    r.state.homes = []
    withoutTrust(home)
    await r.setup.pass()
    expect(r.trust).not.toHaveBeenCalled()
    expect(contentHashes(home)).toEqual([])
  })

  it('below 0.172.0: no plugin, no trust, no record, nothing counted; asked again after its hour', async () => {
    const r = rig()
    const home = codexHome('model = "gpt-5"\n')
    r.state.homes = [home]
    r.options.set(home, { version: '0.171.9' })
    await r.setup.pass()
    expect(r.fake(home).calls).toEqual(['--version'])
    expect(r.counted).toEqual([])
    expect(r.records).toEqual([])
    expect(configOf(home)).toBe('model = "gpt-5"\n')
    expect(existsSync(join(home, 'plugins'))).toBe(false)

    r.state.now = HOUR - 1
    await r.setup.pass()
    expect(r.fake(home).calls).toEqual(['--version'])
    r.state.now = HOUR
    await r.setup.pass()
    expect(r.fake(home).calls).toEqual(['--version', '--version'])
    expect(r.counted).toEqual([])
  })

  it('below 0.172.0, one codex serves every home: asked once an hour, not once a home', async () => {
    const r = rig()
    const a = codexHome(), b = codexHome()
    r.state.homes = [a, b]
    for (const home of [a, b]) r.options.set(home, { version: '0.171.9' })
    await r.setup.pass()
    r.state.now = HOUR - 1
    await r.setup.pass()
    expect(r.looked).toEqual([a])
    expect(r.fake(a).calls).toEqual(['--version'])

    r.state.now = HOUR
    await r.setup.pass()
    expect(r.looked).toEqual([a, a])
    expect(r.counted).toEqual([])
    expect(r.records).toEqual([])
  })

  it('below 0.172.0, owed removals stop at the first home: one codex serves every home', async () => {
    const r = rig()
    const a = codexHome(), b = codexHome()
    const codex: FakeOptions = { fail: [REMOVE], on: (call) => { if (call === ADD) r.state.wanted = false } }
    for (const home of [a, b]) r.options.set(home, codex)
    r.state.homes = [a]
    await r.setup.pass()
    // Within a's hour, b is set up, and its removal fails as well: both owed.
    r.state.wanted = true
    r.state.homes = [a, b]
    r.state.now = 1
    await r.setup.pass()
    expect(r.counted).toEqual([['failed', 'remove · exit 1'], ['failed', 'remove · exit 1']])

    codex.version = '0.171.9'
    r.state.now = HOUR + 1
    await r.setup.pass()
    expect(r.looked).toEqual([a, b, a])
    expect(r.fake(a).calls.at(-1)).toBe('--version')
  })

  // vitest and `npm run dev` run the sources, whose cli.js carries no plugin: nothing to install or trust from.
  it('a run from the sources (files() null): no codex run, no re-check, nothing counted', async () => {
    const r = rig()
    const fresh = codexHome(), recorded = codexHome()
    r.state.homes = [fresh, recorded]
    r.state.recorded = { [recorded]: VERSION }
    r.state.files = null
    await r.setup.pass()
    expect(r.looked).toEqual([])
    expect(r.trust).not.toHaveBeenCalled()
    expect(r.counted).toEqual([])
    expect(existsSync(r.marketplace)).toBe(false)
  })

  it('a failed step waits its own hour, and another home goes on', async () => {
    const r = rig()
    const a = codexHome(), b = codexHome()
    r.state.homes = [a, b]
    r.options.set(a, { fail: [`plugin marketplace add ${r.marketplace}`] })
    await r.setup.pass()
    expect(r.counted).toEqual([['failed', 'marketplace · exit 1'], ['set up']])
    expect(r.state.recorded).toEqual({ [b]: VERSION })

    r.state.now = HOUR - 1
    await r.setup.pass()
    expect(r.fake(a).calls).toEqual(['--version', `plugin marketplace add ${r.marketplace}`])

    r.state.now = HOUR
    await r.setup.pass()
    expect(r.fake(a).calls).toEqual(['--version', `plugin marketplace add ${r.marketplace}`, '--version', `plugin marketplace add ${r.marketplace}`])
    expect(r.counted).toEqual([['failed', 'marketplace · exit 1'], ['set up'], ['failed', 'marketplace · exit 1']])
  })

  it('a failed trust write at the install is failed · trust · its kind, and recorded: the re-check tries again after its hour, never the add', async () => {
    const r = rig()
    const home = codexHome()
    r.state.homes = [home]
    // The hooks.state table as an inline table: no edit of it is safe.
    r.options.set(home, { installed: () => writeFileSync(configFile(home), `${configOf(home)}[hooks]\nstate = {}\n`) })
    await r.setup.pass()
    expect(r.counted).toEqual([['failed', 'trust · unsafe']])
    expect(r.state.recorded).toEqual({ [home]: VERSION })

    r.state.now = HOUR
    await r.setup.pass()
    expect(r.fake(home).calls).toEqual(['--version', `plugin marketplace add ${r.marketplace}`, ADD])
    expect(r.trust).toHaveBeenCalledTimes(1)
    expect(r.counted).toEqual([['failed', 'trust · unsafe'], ['failed', 'trust · unsafe']])
  })

  it('a plugin add whose answer is not JSON is failed · install · not json and recorded, never added again: the re-check trusts it after its hour', async () => {
    const r = rig()
    const home = codexHome()
    r.state.homes = [home]
    r.options.set(home, { printed: 'installed\n' })
    await r.setup.pass()
    const calls = ['--version', `plugin marketplace add ${r.marketplace}`, ADD]
    expect(r.fake(home).calls).toEqual(calls)
    expect(r.state.recorded).toEqual({ [home]: VERSION })
    expect(r.counted).toEqual([['failed', 'install · not json']])
    expect(contentHashes(home)).toEqual([])

    r.state.now = HOUR - 1
    await r.setup.pass()
    expect(r.trust).not.toHaveBeenCalled()

    r.state.now = HOUR
    await r.setup.pass()
    expect(r.fake(home).calls).toEqual(calls)
    expect(contentHashes(home)).toEqual([EXPECTED, EXPECTED])
    expect(r.counted).toEqual([['failed', 'install · not json']])
  })

  it('no codex: nothing run, nothing counted, and set up once it is there', async () => {
    const r = rig()
    const home = codexHome()
    r.state.homes = [home]
    r.state.found = false
    await r.setup.pass()
    expect(r.counted).toEqual([])
    expect(r.records).toEqual([])

    r.state.found = true
    await r.setup.pass()
    expect(r.counted).toEqual([['set up']])
  })

  it('a recorded home that is gone leaves the record', async () => {
    const r = rig()
    const current = codexHome(), older = codexHome()
    r.state.homes = [current, older]
    await r.setup.pass()
    r.trust.mockClear()
    r.state.recorded = { ...r.state.recorded, [older]: '0.6.58' }
    rmSync(current, { recursive: true, force: true })
    rmSync(older, { recursive: true, force: true })

    await r.setup.pass()
    expect(r.state.recorded).toEqual({})
    expect(r.looked).toEqual([current, older])
    expect(r.trust).not.toHaveBeenCalled()
    expect(r.counted).toEqual([['set up'], ['set up']])
  })

  it('a gone home whose entry cannot be dropped is failed · record, and dropped after its hour', async () => {
    const r = rig()
    const home = codexHome()
    r.state.homes = [home]
    await r.setup.pass()
    rmSync(home, { recursive: true, force: true })
    r.state.saves = false
    await r.setup.pass()
    expect(r.counted).toEqual([['set up'], ['failed', 'record']])
    expect(r.state.recorded).toEqual({ [home]: VERSION })

    r.state.saves = true
    r.state.now = HOUR - 1
    await r.setup.pass()
    expect(r.state.recorded).toEqual({ [home]: VERSION })
    r.state.now = HOUR
    await r.setup.pass()
    expect(r.state.recorded).toEqual({})
    expect(r.counted).toEqual([['set up'], ['failed', 'record']])
  })

  it('a home that is not there, or whose real path no record could hold, is not run', async () => {
    const r = rig()
    const homes = [join(temp(), '.codex')]
    if (process.platform !== 'win32') {
      const odd = join(temp(), 'co\ndex')
      mkdirSync(odd)
      homes.push(odd)
    }
    r.state.homes = homes
    await r.setup.pass()
    expect(r.looked).toEqual([])
    expect(r.wanted).not.toHaveBeenCalled()
    expect(r.counted).toEqual([])
  })

  // A start pass lists the default and adopted homes alone, and a scan lists its homes again a minute later.
  it('a home that leaves the list and comes back keeps its hour, and is said once', async () => {
    const r = rig()
    const own = codexHome(OWN_GIT), failing = codexHome()
    r.options.set(failing, { fail: [ADD] })
    r.state.homes = [own, failing]
    await r.setup.pass()
    expect(r.counted).toEqual([['skipped', 'own marketplace'], ['failed', 'install · exit 1']])

    r.state.homes = []
    r.state.now = 60_000
    await r.setup.pass()
    r.state.homes = [own, failing]
    r.state.now = 120_000
    await r.setup.pass()
    expect(r.looked).toEqual([own, failing])

    r.state.now = HOUR
    await r.setup.pass()
    expect(r.looked).toEqual([own, failing, own, failing])
    expect(r.counted).toEqual([['skipped', 'own marketplace'], ['failed', 'install · exit 1'], ['failed', 'install · exit 1']])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an installed folder that cannot be looked at is no error', async () => {
    const r = rig()
    const home = codexHome()
    r.state.homes = [home]
    await r.setup.pass()
    r.trust.mockClear()
    chmodSync(join(home, 'plugins'), 0o000)
    locked.push(join(home, 'plugins'))
    await r.setup.pass()
    await r.setup.pass()
    expect(r.trust).not.toHaveBeenCalled()
    expect(r.counted).toEqual([['set up']])
  })

  // A computer with a dial and no Codex looks at every scan: a login shell that fails is started, and logged, once in ten
  // minutes at most, and at once when a dial attaches.
  it('the login shell\'s PATH is read at an attach, else at most every 10 minutes', async () => {
    const r = rig()
    r.state.homes = [codexHome()]
    r.state.found = false
    const at = async (ms: number, attached?: boolean): Promise<void> => {
      r.state.now = ms
      await r.setup.pass(attached)
    }
    const TEN_MINUTES = 600_000
    await at(0)
    await at(60_000)
    await at(TEN_MINUTES - 2)
    await at(TEN_MINUTES - 1, true)
    await at(TEN_MINUTES)
    await at(2 * TEN_MINUTES - 2)
    await at(2 * TEN_MINUTES - 1)
    expect(r.shells).toEqual([true, false, false, true, false, false, true])
  })

  it('a pass asks the login shell once for all its homes', async () => {
    const r = rig()
    r.state.homes = [codexHome(), codexHome()]
    await r.setup.pass(true)
    expect(r.shells).toEqual([true, true])
  })

  it('two passes at once run one install', async () => {
    const r = rig()
    const home = codexHome()
    r.state.homes = [home]
    await Promise.all([r.setup.pass(), r.setup.pass()])
    expect(r.fake(home).calls).toEqual(['--version', `plugin marketplace add ${r.marketplace}`, ADD])
  })

  // One pass asked each due home's --version with its 15 s bound: 16 minutes with 64 homes on a hanging Codex.
  it('64 homes with a --version that never answers end the pass after one bound', async () => {
    vi.useFakeTimers()
    const bin = join(temp(), 'codex')
    writeFileSync(bin, '')
    const calls: string[] = []
    const hanging: CodexRun = Object.assign((args: string[], timeoutMs: number) => {
      calls.push(args.join(' '))
      return new Promise<ClaudeAnswer>((resolve) => setTimeout(() => resolve({ code: null, stdout: '', stderr: '', timedOut: true }), timeoutMs))
    }, { bin })
    const r = rig({ codex: async () => hanging })
    r.state.homes = Array.from({ length: MAX_HOMES }, () => codexHome())
    let settled = false
    void r.setup.pass().then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(settled).toBe(true)
    expect(calls).toEqual(['--version'])
    expect(r.counted).toEqual(Array.from({ length: MAX_HOMES }, () => ['failed', 'launcher · timeout']))
  })

  it('a lookup that throws is failed · error for that home alone, which waits its hour', async () => {
    const r = rig()
    const a = codexHome(), b = codexHome()
    const looked: string[] = []
    const setup = r.make({ codex: async (home) => {
      looked.push(home)
      if (home === a) throw new Error(home)
      return r.fake(home).run
    } })
    r.state.homes = [a, b]
    await expect(setup.pass()).resolves.toBeUndefined()
    expect(r.counted).toEqual([['failed', 'error'], ['set up']])
    r.state.now = HOUR - 1
    await setup.pass()
    expect(looked).toEqual([a, b])
  })

  it('a pass whose homes cannot be listed is failed · error, and does not reject', async () => {
    const r = rig({ homes: () => { throw new Error('homes') } })
    await expect(r.setup.pass()).resolves.toBeUndefined()
    expect(r.counted).toEqual([['failed', 'error']])
  })
})
