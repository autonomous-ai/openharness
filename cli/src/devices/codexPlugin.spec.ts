/**
 * The Codex plugin set up, brought current and removed through `codex plugin`, from Harness's marketplace folder,
 * against a fake `codex`: a recording run that answers as codex-cli 0.172.0 does and writes what it writes into a
 * throwaway Codex home. One real script on a throwaway PATH and HOME stands in for the binary `codexFound` and
 * `codexRunIn` find. The real `codex` and ~/.codex are never touched.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeAnswer, ClaudePluginFiles, ClaudeRun } from './claudePlugin.js'
import { pluginContentHash } from './codexPluginTrust.js'
import * as pluginFolder from './pluginFolder.js'
import { writeExecutable } from '../testing/executableFixture.js'
import {
  carriedCodexHash, codexFound, codexMarketplace, codexPluginState, codexRemove, codexRunIn, codexSetUp, codexUpdate,
  installedRoot, MIN_CODEX, type CodexInstallDeps,
} from './codexPlugin.js'

// A copy of the module, so a test can watch whether the marketplace folder was written.
vi.mock('./pluginFolder.js', async (original) => ({ ...await original<object>() }))

const onWindows = process.platform === 'win32'
const PLUGIN = 'harness-device@openharness'
const ADD = `plugin add ${PLUGIN} --json`
const REMOVE = `plugin remove ${PLUGIN}`
const OWN_GIT = '[marketplaces.openharness]\nsource_type = "git"\nsource = "https://github.com/autonomous-ai/openharness.git"\n'

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

const cleanup: Array<() => void> = []
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const step of cleanup.splice(0).reverse()) step()
})
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-codex-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A Codex home with [config] as its config.toml, or none. */
function codexHome(config?: string): string {
  const home = join(temp(), '.codex')
  mkdirSync(home)
  if (config !== undefined) writeFileSync(join(home, 'config.toml'), config)
  return home
}
const configOf = (home: string): string => readFileSync(join(home, 'config.toml'), 'utf8')

type Answer = Partial<ClaudeAnswer> | (() => Partial<ClaudeAnswer>)

/**
 * A `codex` for [home] that answers as codex-cli 0.172.0: `marketplace add` records the folder by its canonical path,
 * `plugin add` copies the marketplace's plugin into the cache, turns it on and prints its JSON; [answers] replace a call's
 * answer by its arguments.
 */
function fakeCodex(home: string, folder: string, answers: Record<string, Answer> = {}, version = MIN_CODEX) {
  const calls: string[] = []
  const timeouts: number[] = []
  const config = join(home, 'config.toml')
  const append = (text: string): void => writeFileSync(config, `${existsSync(config) ? readFileSync(config, 'utf8') : ''}${text}`)
  const table: Record<string, Answer> = {
    '--version': { stdout: `codex-cli ${version}\n` },
    [`plugin marketplace add ${folder}`]: () => {
      append(`[marketplaces.openharness]\nsource_type = "local"\nsource = ${JSON.stringify(realpathSync(folder))}\n`)
      return {}
    },
    [ADD]: () => {
      rmSync(installedRoot(home), { recursive: true, force: true })
      cpSync(join(folder, 'plugins', 'harness-device'), installedRoot(home), { recursive: true })
      if (!configOf(home).includes(`[plugins."${PLUGIN}"]`)) append(`[plugins."${PLUGIN}"]\nenabled = true\n`)
      return { stdout: JSON.stringify({ pluginId: PLUGIN, version: 'local', installedPath: installedRoot(home) }) }
    },
    ...answers,
  }
  const run: ClaudeRun = async (args, timeoutMs) => {
    calls.push(args.join(' '))
    timeouts.push(timeoutMs)
    const entry = table[args.join(' ')] ?? {}
    const answer = typeof entry === 'function' ? entry() : entry
    return { code: 0, stdout: '', stderr: '', ...answer }
  }
  return { run, calls, timeouts }
}

/** `<throwaway>/claude-marketplace`, not there yet. */
const marketplaceFolder = (): string => join(temp(), 'claude-marketplace')

const deps = (run: ClaudeRun | null, home: string, folder: string, files = FILES): CodexInstallDeps =>
  ({ run, home, folder, files, platform: process.platform })

const trusted = (home: string): Record<string, { trusted_hash?: string; trusted_content_hash?: string }> =>
  ((parseToml(configOf(home)) as { hooks?: { state?: object } }).hooks?.state ?? {}) as never

describe('codexSetUp', () => {
  it('writes the folder, adds it by its absolute path, installs the plugin and trusts the copy this CLI carries', async () => {
    const home = codexHome('model = "gpt-5"\n')
    const folder = marketplaceFolder()
    const codex = fakeCodex(home, folder)

    expect(await codexSetUp(deps(codex.run, home, folder))).toEqual({ ok: true, outcome: 'installed', trusted: true })

    expect(codex.calls).toEqual(['--version', `plugin marketplace add ${folder}`, ADD])
    for (const [path, text] of Object.entries(FILES.files)) expect(readFileSync(join(folder, path), 'utf8')).toBe(text)
    if (!onWindows) expect(statSync(join(folder, 'plugins/harness-device/hooks/codex-asked')).mode & 0o100).toBe(0o100)
    const expected = carriedCodexHash(FILES, process.platform)
    const state = trusted(home)
    expect(Object.keys(state).sort()).toEqual([`${PLUGIN}:hooks/codex.json:permission_request:0:0`, `${PLUGIN}:hooks/codex.json:pre_tool_use:0:0`])
    for (const record of Object.values(state)) expect(record.trusted_content_hash).toBe(expected)
    // The marketplace add and the plugin add 60 s, the version 15 s.
    expect(codex.timeouts).toEqual([15_000, 60_000, 60_000])
  })

  it('carriedCodexHash is the fingerprint of the copy Codex installs', async () => {
    const home = codexHome()
    const folder = marketplaceFolder()
    await codexSetUp(deps(fakeCodex(home, folder).run, home, folder))
    expect(carriedCodexHash(FILES, process.platform)).toBe(pluginContentHash(installedRoot(home)))
  })

  it('a plugin already on, installed before any record, is added again and trusted', async () => {
    const home = codexHome(`[plugins."${PLUGIN}"]\nenabled = true\n`)
    const folder = marketplaceFolder()
    const codex = fakeCodex(home, folder)
    expect(await codexSetUp(deps(codex.run, home, folder))).toEqual({ ok: true, outcome: 'installed', trusted: true })
    expect(codex.calls).toEqual(['--version', `plugin marketplace add ${folder}`, ADD])
  })

  it('one the person turned off is absent, and nothing is added', async () => {
    const home = codexHome(`[plugins."${PLUGIN}"]\nenabled = false\n`)
    const folder = marketplaceFolder()
    const codex = fakeCodex(home, folder)
    expect(await codexSetUp(deps(codex.run, home, folder))).toEqual({ ok: true, outcome: 'absent', trusted: false })
    expect(codex.calls).toEqual(['--version'])
  })

  it('below 0.172.0 nothing is set up, and a launcher Harness does not run is refused', async () => {
    const home = codexHome('model = "gpt-5"\n')
    const folder = marketplaceFolder()
    const old = fakeCodex(home, folder, {}, '0.171.9')
    expect(await codexSetUp(deps(old.run, home, folder))).toMatchObject({ ok: false, step: 'unsupported' })
    expect(old.calls).toEqual(['--version'])
    expect(existsSync(folder)).toBe(false)
    expect(configOf(home)).toBe('model = "gpt-5"\n')

    const refused = fakeCodex(home, folder, { '--version': { code: null, refused: true } })
    expect(await codexSetUp(deps(refused.run, home, folder))).toMatchObject({ ok: false, step: 'launcher' })
    expect(refused.calls).toEqual(['--version'])
    expect(await codexSetUp(deps(null, home, folder))).toMatchObject({ ok: false, step: 'unsupported' })
  })

  it.each([
    ['hangs', { code: null, timedOut: true }, 'timeout'],
    ['fails', { code: 1, stderr: 'Error: broken install\n' }, 'exit 1'],
  ] as const)('a codex whose --version %s is step launcher with its reason, never one too old', async (_, answer, reason) => {
    const home = codexHome('model = "gpt-5"\n')
    const folder = marketplaceFolder()
    const codex = fakeCodex(home, folder, { '--version': answer })
    expect(await codexSetUp(deps(codex.run, home, folder))).toMatchObject({ ok: false, step: 'launcher', reason })
    expect(codex.calls).toEqual(['--version'])
    expect(existsSync(folder)).toBe(false)
  })

  it('below 0.172.0 a home with its own marketplace is unsupported too', async () => {
    const home = codexHome(OWN_GIT)
    const folder = marketplaceFolder()
    const codex = fakeCodex(home, folder, {}, '0.171.9')
    expect(await codexSetUp(deps(codex.run, home, folder))).toMatchObject({ ok: false, step: 'unsupported' })
    expect(codex.calls).toEqual(['--version'])
  })

  it('a config.toml that cannot be parsed fails step config, with nothing run after --version', async () => {
    const home = codexHome('not = = toml\n')
    const folder = marketplaceFolder()
    const codex = fakeCodex(home, folder)
    expect(await codexSetUp(deps(codex.run, home, folder))).toMatchObject({ ok: false, step: 'config' })
    expect(codex.calls).toEqual(['--version'])
    expect(existsSync(folder)).toBe(false)
  })

  it('a folder that cannot be written fails with its code, nothing run after --version', async () => {
    const home = codexHome()
    const folder = marketplaceFolder()
    const codex = fakeCodex(home, folder)
    vi.spyOn(pluginFolder, 'ensurePluginFolder').mockReturnValue({ failed: 'EACCES' })
    expect(await codexSetUp(deps(codex.run, home, folder))).toMatchObject({ ok: false, step: 'folder', reason: 'EACCES' })
    expect(codex.calls).toEqual(['--version'])
  })

  it('a failed marketplace add is step marketplace', async () => {
    const home = codexHome()
    const folder = marketplaceFolder()
    const codex = fakeCodex(home, folder, { [`plugin marketplace add ${folder}`]: { code: 1, stderr: 'Error: refused\n' } })
    expect(await codexSetUp(deps(codex.run, home, folder))).toEqual({ ok: false, step: 'marketplace', error: 'Error: refused', reason: 'exit 1' })
    expect(codex.calls).toEqual(['--version', `plugin marketplace add ${folder}`])
  })

  it('a failed plugin add is step install, its reason a fixed word, and no trust is written', async () => {
    const home = codexHome()
    const folder = marketplaceFolder()
    const codex = fakeCodex(home, folder, { [ADD]: { code: 1, stderr: 'Error: no such plugin\n' } })
    expect(await codexSetUp(deps(codex.run, home, folder))).toEqual({ ok: false, step: 'install', error: 'Error: no such plugin', reason: 'exit 1' })
    expect(trusted(home)).toEqual({})
  })

  it.each([
    ['its JSON malformed', { stdout: 'installed\n' }],
    ['installed elsewhere', { stdout: JSON.stringify({ pluginId: PLUGIN, installedPath: join(tmpdir(), 'elsewhere') }) }],
  ])('a plugin add with %s is step install, and no trust is written', async (_, answer) => {
    const home = codexHome()
    const folder = marketplaceFolder()
    const codex = fakeCodex(home, folder, { [ADD]: answer })
    expect(await codexSetUp(deps(codex.run, home, folder))).toMatchObject({ ok: false, step: 'install' })
    expect(trusted(home)).toEqual({})
  })

  it('a config.toml that does not parse after the add fails step trust, with the kind as its reason', async () => {
    const home = codexHome()
    const folder = marketplaceFolder()
    const codex = fakeCodex(home, folder, {
      [ADD]: () => {
        cpSync(join(folder, 'plugins', 'harness-device'), installedRoot(home), { recursive: true })
        writeFileSync(join(home, 'config.toml'), 'broken = = \n')
        return { stdout: JSON.stringify({ installedPath: installedRoot(home) }) }
      },
    })
    expect(await codexSetUp(deps(codex.run, home, folder))).toMatchObject({ ok: false, step: 'trust', reason: 'unparsed' })
  })

  it('an installed copy that differs from the carried one is installed, and not trusted', async () => {
    const home = codexHome()
    const folder = marketplaceFolder()
    const codex = fakeCodex(home, folder, {
      [ADD]: () => {
        cpSync(join(folder, 'plugins', 'harness-device'), installedRoot(home), { recursive: true })
        writeFileSync(join(installedRoot(home), 'README.md'), 'edited\n')
        writeFileSync(join(home, 'config.toml'), `${configOf(home)}[plugins."${PLUGIN}"]\nenabled = true\n`)
        return { stdout: JSON.stringify({ installedPath: installedRoot(home) }) }
      },
    })
    expect(await codexSetUp(deps(codex.run, home, folder))).toEqual({ ok: true, outcome: 'installed', trusted: false })
    expect(trusted(home)).toEqual({})
  })
})

describe("a home whose openharness marketplace is the person's own", () => {
  it.each([
    ['from GitHub', OWN_GIT],
    ['another folder', `[marketplaces.openharness]\nsource_type = "local"\nsource = ${JSON.stringify(join(tmpdir(), 'openharness-clone'))}\n`],
    ['local with no source', '[marketplaces.openharness]\nsource_type = "local"\n'],
  ])('(%s) is skipped: nothing installed, nothing written', async (_, config) => {
    const home = codexHome(config)
    const folder = marketplaceFolder()
    const before = statSync(join(home, 'config.toml')).mtimeMs
    const written = vi.spyOn(pluginFolder, 'ensurePluginFolder')
    for (const step of [codexSetUp, codexUpdate]) {
      const codex = fakeCodex(home, folder)
      expect(await step(deps(codex.run, home, folder))).toEqual({ ok: true, outcome: 'own', trusted: false })
      expect(codex.calls).toEqual(['--version'])
    }
    expect(written).not.toHaveBeenCalled()
    expect(configOf(home)).toBe(config)
    expect(statSync(join(home, 'config.toml')).mtimeMs).toBe(before)
    expect(existsSync(join(home, 'plugins'))).toBe(false)
  })

  it.skipIf(onWindows)("Harness's own folder through a linked folder is Harness's", async () => {
    const real = temp()
    const linked = join(temp(), 'linked')
    symlinkSync(real, linked)
    const folder = join(linked, 'claude-marketplace')
    mkdirSync(folder)
    const home = codexHome(`[marketplaces.openharness]\nsource_type = "local"\nsource = ${JSON.stringify(realpathSync(folder))}\n`)
    expect(codexMarketplace(home, folder)).toBe('harness')
    const codex = fakeCodex(home, folder)
    expect(await codexSetUp(deps(codex.run, home, folder))).toEqual({ ok: true, outcome: 'installed', trusted: true })
    expect(codex.calls).toEqual(['--version', ADD])
  })
})

describe('codexMarketplace', () => {
  it('none for a missing config.toml or one without openharness, unknown for one that is not TOML', () => {
    const folder = marketplaceFolder()
    expect(codexMarketplace(codexHome(), folder)).toBe('none')
    expect(codexMarketplace(codexHome('[marketplaces.other]\nsource_type = "git"\nsource = "x"\n'), folder)).toBe('none')
    expect(codexMarketplace(codexHome('not = = toml\n'), folder)).toBe('unknown')
    expect(codexMarketplace(codexHome(OWN_GIT), folder)).toBe('own')
  })
})

describe('codexPluginState', () => {
  it("reads the plugin's table: on, off, absent, or unknown when it cannot be parsed", () => {
    expect(codexPluginState(codexHome())).toBe('absent')
    expect(codexPluginState(codexHome('model = "gpt-5"\n'))).toBe('absent')
    expect(codexPluginState(codexHome(`[plugins."${PLUGIN}"]\nenabled = true\n`))).toBe('on')
    expect(codexPluginState(codexHome(`[plugins."${PLUGIN}"]\nenabled = false\n`))).toBe('off')
    expect(codexPluginState(codexHome('not = = toml\n'))).toBe('unknown')
  })
})

describe('codexUpdate', () => {
  it('writes the folder again, adds the plugin again with no marketplace call, and trusts the new copy', async () => {
    const home = codexHome()
    const folder = marketplaceFolder()
    await codexSetUp(deps(fakeCodex(home, folder).run, home, folder))
    const changed = carried({ ...DEVICE, 'README.md': 'a new build\n' })
    const codex = fakeCodex(home, folder)

    expect(await codexUpdate(deps(codex.run, home, folder, changed))).toEqual({ ok: true, outcome: 'updated', trusted: true })

    expect(codex.calls).toEqual(['--version', ADD])
    expect(readFileSync(join(folder, 'plugins/harness-device/README.md'), 'utf8')).toBe('a new build\n')
    const expected = carriedCodexHash(changed, process.platform)
    expect(expected).not.toBe(carriedCodexHash(FILES, process.platform))
    for (const record of Object.values(trusted(home))) expect(record.trusted_content_hash).toBe(expected)
  })

  it('a plugin absent from config.toml is absent, nothing run after --version and no folder written', async () => {
    const home = codexHome('model = "gpt-5"\n')
    const folder = marketplaceFolder()
    const codex = fakeCodex(home, folder)
    expect(await codexUpdate(deps(codex.run, home, folder))).toEqual({ ok: true, outcome: 'absent', trusted: false })
    expect(codex.calls).toEqual(['--version'])
    expect(existsSync(folder)).toBe(false)
  })
})

describe('codexRemove', () => {
  it('removes a plugin that is there, with 15 s', async () => {
    const home = codexHome(`[plugins."${PLUGIN}"]\nenabled = true\n`)
    const codex = fakeCodex(home, marketplaceFolder())
    expect(await codexRemove({ run: codex.run, home, platform: process.platform })).toEqual({ ok: true })
    expect(codex.calls).toEqual(['--version', REMOVE])
    expect(codex.timeouts).toEqual([15_000, 15_000])
  })

  it('runs nothing for a plugin that is not there, or with no codex', async () => {
    const home = codexHome('model = "gpt-5"\n')
    const codex = fakeCodex(home, marketplaceFolder())
    expect(await codexRemove({ run: codex.run, home, platform: process.platform })).toEqual({ ok: true })
    expect(codex.calls).toEqual([])
    expect(await codexRemove({ run: null, home, platform: process.platform })).toEqual({ ok: true })
  })

  it('a failed remove is step remove, and below 0.172.0 nothing runs but --version', async () => {
    const home = codexHome(`[plugins."${PLUGIN}"]\nenabled = false\n`)
    const failing = fakeCodex(home, marketplaceFolder(), { [REMOVE]: { code: 1, stderr: 'Error: busy\n' } })
    expect(await codexRemove({ run: failing.run, home, platform: process.platform }))
      .toEqual({ ok: false, step: 'remove', error: 'Error: busy', reason: 'exit 1' })
    const old = fakeCodex(home, marketplaceFolder(), {}, '0.171.9')
    expect(await codexRemove({ run: old.run, home, platform: process.platform })).toMatchObject({ ok: false, step: 'unsupported' })
    expect(old.calls).toEqual(['--version'])
  })
})

describe('the codex binary', () => {
  /** A `codex` in bin/, another folder before it on PATH, that prints the Codex home it was handed and its PATH's first
   *  folder; PATH and HOME are a throwaway folder, so no `codex` of the developer's is found. */
  function codexOnPath(): { dir: string; bin: string } {
    const dir = temp()
    vi.stubEnv('HOME', dir)
    vi.stubEnv('CODEX_PATH', '')
    const bin = join(dir, 'bin')
    mkdirSync(join(dir, 'other'))
    mkdirSync(bin)
    writeExecutable(join(bin, 'codex'), '#!/bin/sh\necho "home: ${CODEX_HOME-none}"\necho "first: ${PATH%%:*}"\n')
    vi.stubEnv('PATH', [join(dir, 'other'), bin].join(delimiter))
    return { dir, bin }
  }

  it.skipIf(onWindows)('codexFound runs the codex the lookup finds, its folder first on PATH, CODEX_HOME naming the home', async () => {
    const { dir, bin } = codexOnPath()
    vi.stubEnv('CODEX_HOME', join(dir, 'other-home'))
    const home = join(dir, 'profile-a')
    for (const shell of [true, false]) {
      const run = await codexFound(home, shell)
      expect(await run!(['--version'], 15_000)).toEqual({ code: 0, stdout: `home: ${home}\nfirst: ${bin}\n`, stderr: '' })
    }
  })

  it.skipIf(onWindows)('codexRunIn hands the child CODEX_HOME, and the process keeps its own', async () => {
    const { dir } = codexOnPath()
    vi.stubEnv('CODEX_HOME', join(dir, 'other-home'))
    const home = join(dir, 'profile-a')
    expect(await codexRunIn(home)!(['--version'], 15_000)).toMatchObject({ code: 0, stdout: expect.stringContaining(`home: ${home}\n`) })
    expect(process.env.CODEX_HOME).toBe(join(dir, 'other-home'))
  })

  it('both are null when no codex is found', async () => {
    const dir = temp()
    vi.stubEnv('PATH', dir)
    vi.stubEnv('HOME', dir)
    vi.stubEnv('CODEX_PATH', '')
    expect(await codexFound(join(dir, '.codex'), false)).toBeNull()
    expect(codexRunIn(join(dir, '.codex'))).toBeNull()
  })
})

it('installedRoot is where Codex installs a plugin with no version from the openharness marketplace', () => {
  expect(installedRoot(join('h', '.codex'))).toBe(join('h', '.codex', 'plugins', 'cache', 'openharness', 'harness-device', 'local'))
})
