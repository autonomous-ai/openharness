/**
 * Status, enable, disable and update against a fake `claude`: a recording ClaudeRun answers each call from a table, and
 * one real script on a throwaway PATH and HOME stands in for the binary `claudeRun`, `claudeRunIn` and `claudeFound` find. The real
 * `claude` and ~/.claude are never touched.
 */
import * as childProcess from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import * as engineBin from '../lib/engineBin.js'
import {
  carriedClaudePlugin, claudeDisable, claudeEnable, claudeFound, claudeHomeDisable, claudeHomeEnable, claudeRun, claudeRunIn, claudeSetUp,
  claudeStatus, claudeRunner, claudeUpdate, failureReason, failureWords, type ClaudeInstallDeps, type ClaudePluginFiles, type ClaudeRun,
} from './claudePlugin.js'
import { writeExecutable } from '../testing/executableFixture.js'

// A copy of the module, so a test can watch whether the lookup that starts the login shell ran.
vi.mock('../lib/engineBin.js', async (original) => ({ ...await original<object>() }))
// A copy of the module, so a test can watch what the runner starts on Windows.
vi.mock('node:child_process', async (original) => ({ ...await original<object>() }))

type Answer = { code: number | null; stdout?: string; stderr?: string }

const USER_ON = { id: 'harness-device@openharness', scope: 'user', enabled: true, version: '0.1.0' }
const USER_OFF = { ...USER_ON, enabled: false }
const MARKETPLACE = [{ name: 'openharness', source: 'github', repo: 'autonomous-ai/openharness' }]
const UNLISTED = 'Claude Code did not list its plugins.'
/** The add of the marketplace folder, by its absolute path, as Claude Code takes a local one on every OS. */
const add = (folder: string): string => `plugin marketplace add ${folder}`
const INSTALL = 'plugin install harness-device@openharness --scope user'
/** What cli.js carries, cut to the marketplace's own file and the one executable. */
const FILES: ClaudePluginFiles = {
  files: { '.claude-plugin/marketplace.json': '{"name":"openharness"}\n', 'plugins/harness-device/hooks/asked': '#!/bin/sh\n' },
  executable: ['plugins/harness-device/hooks/asked'],
}

/** A `claude` that answers by its arguments and records each call with the time it was given. */
function fakeClaude(answers: Record<string, Answer>, version = '2.1.287 (Claude Code)') {
  const calls: Array<{ args: string; timeoutMs: number }> = []
  const table: Record<string, Answer> = {
    '--version': { code: 0, stdout: `${version}\n` },
    'plugin list --json': { code: 0, stdout: '[]' },
    'plugin marketplace list --json': { code: 0, stdout: '[]' },
    ...answers,
  }
  const run: ClaudeRun = async (args, timeoutMs) => {
    calls.push({ args: args.join(' '), timeoutMs })
    const answer = table[args.join(' ')] ?? { code: 0 }
    return { code: answer.code, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' }
  }
  /** The calls that change something: the reads are not what a test of enable or disable is about. */
  const writes = () => calls.map((call) => call.args).filter((args) => !/^(--version|plugin (marketplace )?list --json)$/.test(args))
  return { run, calls, writes }
}

const list = (...entries: unknown[]): Answer => ({ code: 0, stdout: JSON.stringify(entries) })

const cleanup: Array<() => void> = []
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const step of cleanup.splice(0).reverse()) step()
})

/** `<throwaway>/claude-marketplace`, not there yet. */
function marketplaceFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-data-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'claude-marketplace')
}

/** What an install or an update is handed: [run], and the marketplace to write into a throwaway folder. */
function installing(run: ClaudeRun | null, platform: NodeJS.Platform = 'darwin', folder = marketplaceFolder()): ClaudeInstallDeps {
  return { run, platform, folder, files: FILES }
}

/** [folder]'s parent made read-only until the test ends: the folder cannot be written there. */
function readOnlyParent(folder: string): void {
  chmodSync(dirname(folder), 0o500)
  cleanup.push(() => chmodSync(dirname(folder), 0o700))
}

describe('claudeStatus', () => {
  it('status with no claude', async () => {
    expect(await claudeStatus({ run: null, platform: 'darwin' }))
      .toEqual({ supported: false, installed: false, enabled: false, claudeVersion: null })
  })

  it('2.1.286 is not supported, 2.1.287 and 2.10.0 are', async () => {
    const supported = async (version: string) =>
      (await claudeStatus({ run: fakeClaude({}, version).run, platform: 'darwin' })).supported
    expect(await supported('2.1.286 (Claude Code)')).toBe(false)
    expect(await supported('2.1.287 (Claude Code)')).toBe(true)
    expect(await supported('2.10.0 (Claude Code)')).toBe(true)
    expect(await claudeStatus({ run: fakeClaude({}, '2.10.0 (Claude Code)').run, platform: 'linux' }))
      .toMatchObject({ supported: true, claudeVersion: '2.10.0' })
  })

  it('an unreadable version is null and not supported', async () => {
    expect(await claudeStatus({ run: fakeClaude({}, 'Claude Code').run, platform: 'darwin' }))
      .toMatchObject({ supported: false, claudeVersion: null })
  })

  it('Windows takes the plugin from 2.1.287, as a Mac does', async () => {
    const supported = async (version: string) =>
      (await claudeStatus({ run: fakeClaude({}, version).run, platform: 'win32' })).supported
    expect(await supported('2.1.286 (Claude Code)')).toBe(false)
    expect(await supported('2.1.287 (Claude Code)')).toBe(true)
  })

  it('status reads installed and enabled from the user-scope entry and ignores a project-scope one', async () => {
    const project = { ...USER_ON, scope: 'project' }
    const status = (answer: Answer) => claudeStatus({ run: fakeClaude({ 'plugin list --json': answer }).run, platform: 'darwin' })
    expect(await status(list(project))).toMatchObject({ installed: false, enabled: false })
    expect(await status(list(project, USER_OFF))).toMatchObject({ installed: true, enabled: false })
    expect(await status(list({ ...USER_OFF, scope: 'project', enabled: true }, USER_ON)))
      .toEqual({ supported: true, installed: true, enabled: true, claudeVersion: '2.1.287' })
    expect(await status(list({ ...USER_ON, id: 'harness@openharness' }))).toMatchObject({ installed: false })
    expect(await status({ code: 0, stdout: 'not json' })).toMatchObject({ installed: false, enabled: false })
  })
})

/** Whether [folder] holds FILES, `hooks/asked` 0700 off Windows, where modes are Windows' own. */
function holdsFiles(folder: string): void {
  for (const [key, text] of Object.entries(FILES.files)) expect(readFileSync(join(folder, key), 'utf8')).toBe(text)
  if (process.platform !== 'win32') expect(statSync(join(folder, 'plugins/harness-device/hooks/asked')).mode & 0o777).toBe(0o700)
}

describe('claudeEnable', () => {
  // No git and no GitHub: Claude Code reads a local marketplace in place. A path relative to where the call runs could
  // be kept as it was given, so it is the folder's absolute path, on Windows too (`C:\...`).
  it('the first install writes the folder and adds it by its absolute path', async () => {
    for (const [act, done] of [[claudeEnable, { ok: true }], [claudeSetUp, { ok: true, outcome: 'installed' }]] as const) {
      const claude = fakeClaude({})
      const deps = installing(claude.run)
      expect(await act(deps)).toEqual(done)
      expect(claude.writes()).toEqual([add(deps.folder), INSTALL])
      expect(claude.calls.some((call) => /autonomous-ai\/openharness|--sparse/.test(call.args))).toBe(false)
      holdsFiles(deps.folder)
    }
  })

  // A marketplace from GitHub is the person's: removing it would uninstall every plugin from it, their own harness too.
  it('with openharness there, from GitHub or from the folder, nothing is added and nothing removed', async () => {
    for (const marketplace of [MARKETPLACE[0], { name: 'openharness', source: 'directory', path: '/data/claude-marketplace' }]) {
      const folder = marketplaceFolder()
      const claude = fakeClaude({ 'plugin marketplace list --json': list(marketplace) })
      let written = false
      const run: ClaudeRun = async (args, timeoutMs) => {
        if (args.join(' ') === INSTALL) written = existsSync(join(folder, '.claude-plugin/marketplace.json'))
        return claude.run(args, timeoutMs)
      }
      expect(await claudeEnable(installing(run, 'darwin', folder))).toEqual({ ok: true })
      expect(claude.writes()).toEqual([INSTALL])
      expect(claude.calls.some((call) => call.args.startsWith('plugin marketplace remove'))).toBe(false)
      expect(written).toBe(true)
    }
  })

  it('a folder that cannot be written stops the install, with its code', async () => {
    const claude = fakeClaude({})
    const deps = installing(claude.run)
    readOnlyParent(deps.folder)
    expect(await claudeEnable(deps))
      .toEqual({ ok: false, step: 'folder', reason: 'EACCES', error: "Harness could not write Claude Code's plugin folder." })
    expect(claude.writes()).toEqual([])
  })

  it('a failed add gives its first line and why, in a fixed word', async () => {
    const folder = marketplaceFolder()
    const claude = fakeClaude({ [add(folder)]: { code: 1, stderr: "\nMarketplace 'openharness' is already added from a different source\n  at add\n" } })
    expect(await claudeEnable(installing(claude.run, 'darwin', folder))).toEqual({
      ok: false, step: 'marketplace', reason: 'exists', error: "Marketplace 'openharness' is already added from a different source",
    })
  })

  it('enable with the marketplace there only installs', async () => {
    const claude = fakeClaude({ 'plugin marketplace list --json': list(...MARKETPLACE) })
    expect(await claudeEnable(installing(claude.run, 'linux'))).toEqual({ ok: true })
    expect(claude.writes()).toEqual(['plugin install harness-device@openharness --scope user'])
  })

  // A clone made before harness-device was in the marketplace does not list it, and the install says it is not found.
  it('enable with a stale marketplace clone updates it once and installs again', async () => {
    const install = 'plugin install harness-device@openharness --scope user'
    const notFound = { code: 1, stderr: 'Plugin "harness-device" not found in marketplace "openharness"\n' }
    const claude = fakeClaude({ 'plugin marketplace list --json': list(...MARKETPLACE), [install]: notFound })
    let updated = false
    const run: ClaudeRun = async (args, timeoutMs) => {
      const answer = await claude.run(args, timeoutMs)
      if (args.join(' ') === 'plugin marketplace update openharness') updated = true
      return args.join(' ') === install && updated ? { code: 0, stdout: '', stderr: '' } : answer
    }
    expect(await claudeEnable(installing(run, 'darwin'))).toEqual({ ok: true })
    expect(claude.writes()).toEqual([install, 'plugin marketplace update openharness', install])
    // It pulls from GitHub, as the add and the install fetch: the time a fetch gets.
    expect(claude.calls.find((call) => call.args === 'plugin marketplace update openharness')?.timeoutMs).toBe(60_000)
  })

  it('an install that fails after the update gives its line, and a failed update gives its own', async () => {
    const install = 'plugin install harness-device@openharness --scope user'
    const stale = fakeClaude({
      'plugin marketplace list --json': list(...MARKETPLACE),
      [install]: { code: 1, stderr: 'Error: not found\n' },
    })
    expect(await claudeEnable(installing(stale.run, 'darwin')))
      .toEqual({ ok: false, error: 'Error: not found', step: 'install', reason: 'exit 1' })
    expect(stale.writes()).toEqual([install, 'plugin marketplace update openharness', install])

    const offline = fakeClaude({
      'plugin marketplace list --json': list(...MARKETPLACE),
      [install]: { code: 1, stderr: 'Error: not found\n' },
      'plugin marketplace update openharness': { code: 1, stderr: 'Error: no network\n' },
    })
    expect(await claudeEnable(installing(offline.run, 'darwin')))
      .toEqual({ ok: false, error: 'Error: no network', step: 'marketplace', reason: 'exit 1' })
    expect(offline.writes()).toEqual([install, 'plugin marketplace update openharness'])
  })

  it('an install that fails just after the marketplace add is not tried again: the marketplace is new', async () => {
    const claude = fakeClaude({ [INSTALL]: { code: 1, stderr: 'Error: no network\n' } })
    const deps = installing(claude.run, 'darwin')
    expect(await claudeEnable(deps))
      .toEqual({ ok: false, error: 'Error: no network', step: 'install', reason: 'exit 1' })
    expect(claude.writes()).toEqual([add(deps.folder), INSTALL])
  })

  it('enable when installed but off runs plugin enable', async () => {
    const claude = fakeClaude({ 'plugin list --json': list(USER_OFF) })
    expect(await claudeEnable(installing(claude.run, 'darwin'))).toEqual({ ok: true })
    expect(claude.writes()).toEqual(['plugin enable harness-device@openharness --scope user'])
  })

  it('enable twice runs nothing the second time', async () => {
    let installed = false
    const claude = fakeClaude({})
    const run: ClaudeRun = async (args, timeoutMs) => {
      const answer = await claude.run(args, timeoutMs)
      if (args.join(' ') === 'plugin install harness-device@openharness --scope user') installed = true
      if (args.join(' ') === 'plugin list --json' && installed) return { ...answer, stdout: JSON.stringify([USER_ON]) }
      return answer
    }
    expect(await claudeEnable(installing(run, 'darwin'))).toEqual({ ok: true })
    const first = claude.writes().length
    expect(await claudeEnable(installing(run, 'darwin'))).toEqual({ ok: true })
    expect(claude.writes().length).toBe(first)
  })

  it('enable when unsupported runs nothing and gives the sentence', async () => {
    const sentence = { ok: false, error: 'Claude Code 2.1.287 or later is needed.', step: 'unsupported' }
    const old = fakeClaude({}, '2.1.286 (Claude Code)')
    expect(await claudeEnable(installing(old.run, 'darwin'))).toEqual(sentence)
    expect(old.writes()).toEqual([])
    expect(await claudeEnable(installing(null, 'darwin'))).toEqual(sentence)
  })

  // A Claude Code the devices find on their own, every hour at most: an old one is asked one thing, not three.
  it('enable with an old Claude Code asks its version and nothing else', async () => {
    const claude = fakeClaude({}, '2.1.286 (Claude Code)')
    expect(await claudeEnable(installing(claude.run, 'darwin')))
      .toEqual({ ok: false, error: 'Claude Code 2.1.287 or later is needed.', step: 'unsupported' })
    expect(claude.calls.map((call) => call.args)).toEqual(['--version'])
  })
})

describe('claudeSetUp', () => {
  // `harness device claude enable` turns an entry that is off back on; the devices' own setup leaves it the person's.
  it('a plugin already on is current, and one turned off is absent, and nothing is run for either', async () => {
    for (const [entry, outcome] of [[USER_ON, 'current'], [USER_OFF, 'absent']] as const) {
      const claude = fakeClaude({ 'plugin list --json': list(entry) })
      expect(await claudeSetUp(installing(claude.run, 'darwin'))).toEqual({ ok: true, outcome })
      expect(claude.writes()).toEqual([])
    }
  })

  it('with an old Claude Code it asks its version and nothing else', async () => {
    const claude = fakeClaude({}, '2.1.286 (Claude Code)')
    expect(await claudeSetUp(installing(claude.run, 'darwin')))
      .toEqual({ ok: false, error: 'Claude Code 2.1.287 or later is needed.', step: 'unsupported' })
    expect(claude.calls.map((call) => call.args)).toEqual(['--version'])
  })
})

describe('claudeDisable', () => {
  it('disable uninstalls and leaves the marketplace', async () => {
    const claude = fakeClaude({ 'plugin list --json': list(USER_OFF) })
    expect(await claudeDisable({ run: claude.run, platform: 'darwin' })).toEqual({ ok: true })
    expect(claude.writes()).toEqual(['plugin uninstall harness-device@openharness --scope user'])
  })

  it('disable when not installed runs nothing', async () => {
    const claude = fakeClaude({ 'plugin list --json': list({ ...USER_ON, scope: 'project' }) })
    expect(await claudeDisable({ run: claude.run, platform: 'darwin' })).toEqual({ ok: true })
    expect(claude.writes()).toEqual([])
    expect(await claudeDisable({ run: null, platform: 'darwin' })).toEqual({ ok: true })
  })
})

// An Orca account's home shares `plugins/` with the default home: only its own settings are ever changed there.
describe('claudeHomeEnable', () => {
  const enable = 'plugin enable harness-device@openharness --scope user'

  it('turns the plugin on in that home with enable alone', async () => {
    const claude = fakeClaude({ 'plugin list --json': list(USER_OFF) })
    expect(await claudeHomeEnable({ run: claude.run, platform: 'darwin' })).toEqual({ ok: true })
    expect(claude.calls.map((call) => call.args)).toEqual(['--version', 'plugin list --json', enable])
    expect(claude.calls.find((call) => call.args === enable)?.timeoutMs).toBe(15_000)
  })

  it('one already on runs nothing more', async () => {
    const claude = fakeClaude({ 'plugin list --json': list(USER_ON) })
    expect(await claudeHomeEnable({ run: claude.run, platform: 'linux' })).toEqual({ ok: true })
    expect(claude.calls.map((call) => call.args)).toEqual(['--version', 'plugin list --json'])
  })

  it('not listed there, it still runs enable, and a failure is the first line Claude Code wrote, step enable', async () => {
    const unlisted = fakeClaude({ 'plugin list --json': list({ ...USER_ON, scope: 'project' }) })
    expect(await claudeHomeEnable({ run: unlisted.run, platform: 'darwin' })).toEqual({ ok: true })
    expect(unlisted.writes()).toEqual([enable])

    const failing = fakeClaude({ [enable]: { code: 1, stderr: '\nError: plugin not found\n  at enable\n' } })
    expect(await claudeHomeEnable({ run: failing.run, platform: 'darwin' }))
      .toEqual({ ok: false, error: 'Error: plugin not found', step: 'enable', reason: 'exit 1' })
    expect(failing.writes()).toEqual([enable])
  })

  it('a list that cannot be read is step list', async () => {
    const claude = fakeClaude({ 'plugin list --json': { code: 1, stderr: 'Error: settings locked\n' } })
    expect(await claudeHomeEnable({ run: claude.run, platform: 'darwin' }))
      .toEqual({ ok: false, error: 'Error: settings locked', step: 'list', reason: 'exit 1' })
    expect(claude.writes()).toEqual([])
  })

  it('an old Claude Code is unsupported and asked nothing more', async () => {
    const unsupported = { ok: false, error: 'Claude Code 2.1.287 or later is needed.', step: 'unsupported' }
    const old = fakeClaude({}, '2.1.286 (Claude Code)')
    expect(await claudeHomeEnable({ run: old.run, platform: 'darwin' })).toEqual(unsupported)
    expect(old.calls.map((call) => call.args)).toEqual(['--version'])
    expect(await claudeHomeEnable({ run: null, platform: 'darwin' })).toEqual(unsupported)
  })
})

describe('claudeHomeDisable', () => {
  const disable = 'plugin disable harness-device@openharness --scope user'

  it('turns the plugin off and never uninstalls it', async () => {
    const claude = fakeClaude({ 'plugin list --json': list(USER_ON) })
    expect(await claudeHomeDisable({ run: claude.run, platform: 'darwin' })).toEqual({ ok: true })
    expect(claude.writes()).toEqual([disable])
    expect(claude.calls.find((call) => call.args === disable)?.timeoutMs).toBe(15_000)
  })

  it('an entry not listed or already off runs nothing', async () => {
    for (const plugins of [list(), list(USER_OFF), list({ ...USER_ON, scope: 'project' })]) {
      const claude = fakeClaude({ 'plugin list --json': plugins })
      expect(await claudeHomeDisable({ run: claude.run, platform: 'darwin' })).toEqual({ ok: true })
      expect(claude.writes()).toEqual([])
    }
  })

  it('a failure is the first line Claude Code wrote, step disable', async () => {
    const claude = fakeClaude({ 'plugin list --json': list(USER_ON), [disable]: { code: 1, stderr: 'Error: settings locked\n' } })
    expect(await claudeHomeDisable({ run: claude.run, platform: 'darwin' }))
      .toEqual({ ok: false, error: 'Error: settings locked', step: 'disable', reason: 'exit 1' })
  })

  it('a list that cannot be read is step list and runs nothing', async () => {
    const claude = fakeClaude({ 'plugin list --json': { code: null } })
    expect(await claudeHomeDisable({ run: claude.run, platform: 'darwin' })).toEqual({ ok: false, error: UNLISTED, step: 'list', reason: 'no answer' })
    expect(claude.writes()).toEqual([])
  })

  it('no claude is ok and runs nothing', async () => {
    expect(await claudeHomeDisable({ run: null, platform: 'darwin' })).toEqual({ ok: true })
  })
})

describe('claudeUpdate', () => {
  const update = 'plugin update harness-device@openharness --scope user'

  /** `plugin list --json` gives the plugin at [before] until `plugin update` has run, and at [after] from then on. */
  function updating(before: string, after: string, answers: Record<string, Answer> = {}) {
    const claude = fakeClaude({ 'plugin list --json': list({ ...USER_ON, version: before }), ...answers })
    let updated = false
    const run: ClaudeRun = async (args, timeoutMs) => {
      const answer = await claude.run(args, timeoutMs)
      if (args.join(' ') === update && answer.code === 0) updated = true
      if (args.join(' ') !== 'plugin list --json' || !updated) return answer
      return { code: 0, stdout: JSON.stringify([{ ...USER_ON, version: after }]), stderr: '' }
    }
    return { ...claude, run }
  }

  it('update pulls the marketplace, then the plugin, and is updated when its version changed', async () => {
    const claude = updating('16a92abfab3f', '9f2c1d0e7a4b')
    const result = await claudeUpdate(installing(claude.run, 'darwin'))
    expect(claude.writes()).toEqual(['plugin marketplace update openharness', update])
    expect(result).toEqual({ ok: true, outcome: 'updated' })
    // Both pull from GitHub: the time a fetch gets.
    expect(claude.calls.filter((call) => claude.writes().includes(call.args)).map((call) => call.timeoutMs)).toEqual([60_000, 60_000])
  })

  it('update with the same version after is current', async () => {
    const claude = updating('16a92abfab3f', '16a92abfab3f')
    expect(await claudeUpdate(installing(claude.run, 'linux'))).toEqual({ ok: true, outcome: 'current' })
    expect(claude.writes()).toEqual(['plugin marketplace update openharness', update])
  })

  it('update of a plugin the person uninstalled or disabled runs nothing: absent', async () => {
    for (const plugins of [list(), list(USER_OFF), list({ ...USER_ON, scope: 'project' })]) {
      const claude = fakeClaude({ 'plugin list --json': plugins })
      expect(await claudeUpdate(installing(claude.run, 'darwin'))).toEqual({ ok: true, outcome: 'absent' })
      expect(claude.writes()).toEqual([])
    }
  })

  it('an update whose list after it cannot be read is a failure, not updated', async () => {
    const claude = fakeClaude({ 'plugin list --json': list(USER_ON) })
    let updated = false
    const run: ClaudeRun = async (args, timeoutMs) => {
      if (args.join(' ') === update) updated = true
      if (args.join(' ') === 'plugin list --json' && updated) return { code: null, stdout: '', stderr: '' }
      return claude.run(args, timeoutMs)
    }
    expect(await claudeUpdate(installing(run, 'darwin'))).toEqual({ ok: false, error: UNLISTED, step: 'list', reason: 'no answer' })
  })

  // A marketplace from the folder is read again by `marketplace update`: the folder must hold this build's plugin then.
  it('the update writes the folder before marketplace update', async () => {
    const folder = marketplaceFolder()
    const claude = updating('16a92abfab3f', '9f2c1d0e7a4b')
    let written = false
    const run: ClaudeRun = async (args, timeoutMs) => {
      if (args.join(' ') === 'plugin marketplace update openharness') written = existsSync(join(folder, '.claude-plugin/marketplace.json'))
      return claude.run(args, timeoutMs)
    }
    expect(await claudeUpdate(installing(run, 'darwin', folder))).toEqual({ ok: true, outcome: 'updated' })
    expect(written).toBe(true)
    holdsFiles(folder)
  })

  // A marketplace from GitHub never reads the folder: its update goes on, and the write's failure is counted beside it.
  it('an update whose folder cannot be written still updates, and gives the code', async () => {
    const claude = updating('16a92abfab3f', '9f2c1d0e7a4b')
    const deps = installing(claude.run)
    readOnlyParent(deps.folder)
    expect(await claudeUpdate(deps)).toEqual({ ok: true, outcome: 'updated', folderFailed: 'EACCES' })
    expect(claude.writes()).toEqual(['plugin marketplace update openharness', update])
  })

  // Counted updated only for a version seen to change: a plugin gone from the list after it changed nothing seen.
  it('an update after which the plugin is not listed is current, not updated', async () => {
    const claude = fakeClaude({ 'plugin list --json': list(USER_ON) })
    let updated = false
    const run: ClaudeRun = async (args, timeoutMs) => {
      if (args.join(' ') === update) updated = true
      if (args.join(' ') === 'plugin list --json' && updated) return { code: 0, stdout: '[]', stderr: '' }
      return claude.run(args, timeoutMs)
    }
    expect(await claudeUpdate(installing(run, 'darwin'))).toEqual({ ok: true, outcome: 'current' })
  })

  it('update with an old Claude Code, or none, asks its version and nothing else', async () => {
    const claude = fakeClaude({ 'plugin list --json': list(USER_ON) }, '2.1.286 (Claude Code)')
    const unsupported = { ok: false, error: 'Claude Code 2.1.287 or later is needed.', step: 'unsupported' }
    expect(await claudeUpdate(installing(claude.run, 'darwin'))).toEqual(unsupported)
    expect(claude.calls.map((call) => call.args)).toEqual(['--version'])
    expect(await claudeUpdate(installing(null, 'darwin'))).toEqual(unsupported)
  })
})

describe('a list that cannot be read', () => {
  // One that failed, ran out of time or is not JSON says nothing of the plugin: it is never read as none.
  const unreadable: Array<[Answer, string, string]> = [
    [{ code: 1, stderr: 'Error: settings locked\n' }, 'Error: settings locked', 'exit 1'],
    [{ code: null }, UNLISTED, 'no answer'],
    [{ code: 0, stdout: 'Loading plugins…\n[' }, UNLISTED, 'not json'],
  ]

  it('setup, update, disable and enable fail with step list, and change nothing', async () => {
    for (const [answer, error, reason] of unreadable) {
      for (const act of [claudeSetUp, claudeUpdate, claudeDisable, claudeEnable]) {
        const claude = fakeClaude({ 'plugin list --json': answer })
        expect(await act(installing(claude.run, 'darwin'))).toEqual({ ok: false, error, step: 'list', reason })
        expect(claude.writes()).toEqual([])
      }
    }
  })
})

// On Windows `claude` on PATH can be the Claude desktop app's Claude.exe: its `--version` names no Claude Code, and any
// other call opens its window (Review Focus 4).
describe('the Claude desktop app on Windows', () => {
  const app = () => fakeClaude({ 'plugin list --json': list(USER_ON) }, 'Claude 1.4.0')

  it('is not supported, and enable answers unsupported after its one --version', async () => {
    const status = app()
    expect(await claudeStatus({ run: status.run, platform: 'win32' }))
      .toEqual({ supported: false, installed: false, enabled: false, claudeVersion: null })
    expect(status.calls.map((call) => call.args)).toEqual(['--version'])
    for (const step of [claudeEnable, claudeSetUp, claudeUpdate, claudeHomeEnable]) {
      const claude = app()
      expect(await step(installing(claude.run, 'win32')))
        .toEqual({ ok: false, error: 'Claude Code 2.1.287 or later is needed.', step: 'unsupported' })
      expect(claude.calls.map((call) => call.args)).toEqual(['--version'])
    }
  })

  it('a disable asks its --version and nothing more: there is no plugin of Claude Code\'s to take out', async () => {
    for (const step of [claudeDisable, claudeHomeDisable]) {
      const claude = app()
      expect(await step({ run: claude.run, platform: 'win32' })).toEqual({ ok: true })
      expect(claude.calls.map((call) => call.args)).toEqual(['--version'])
    }
  })

  // A kill, a failed start or an exit not 0 is no answer, which says nothing of what runs: a disable is a failure, so
  // an undo the devices owe stays owed, and the status reads the list as on a Mac.
  it('a --version with no answer is no answer, not the app', async () => {
    const unanswered: Array<[Answer, string, string]> = [
      [{ code: null }, 'Claude Code did not answer.', 'no answer'], [{ code: 1, stderr: 'Error: busy\n' }, 'Error: busy', 'exit 1'],
    ]
    for (const [answer, error, reason] of unanswered) {
      for (const step of [claudeDisable, claudeHomeDisable]) {
        const claude = fakeClaude({ '--version': answer, 'plugin list --json': list(USER_ON) })
        expect(await step({ run: claude.run, platform: 'win32' })).toEqual({ ok: false, error, step: 'list', reason })
        expect(claude.calls.map((call) => call.args)).toEqual(['--version'])
      }
      const status = fakeClaude({ '--version': answer, 'plugin list --json': list(USER_ON) })
      expect(await claudeStatus({ run: status.run, platform: 'win32' }))
        .toEqual({ supported: false, installed: true, enabled: true, claudeVersion: null })
    }
  })

  it('Claude Code itself is asked as on a Mac', async () => {
    const claude = fakeClaude({ 'plugin list --json': list(USER_ON) }, '2.1.300 (Claude Code)')
    expect(await claudeDisable({ run: claude.run, platform: 'win32' })).toEqual({ ok: true })
    expect(claude.writes()).toEqual(['plugin uninstall harness-device@openharness --scope user'])
  })
})

// On Windows a batch file that is no npm shim is never run (claudeRunner): nothing ran, which the devices count by its
// own word rather than as a Claude Code that is too old or failed.
describe('a claude launcher Harness does not run', () => {
  it('fails at step launcher, asked nothing after its --version', async () => {
    for (const act of [claudeEnable, claudeSetUp, claudeUpdate, claudeHomeEnable, claudeDisable, claudeHomeDisable]) {
      const asked: string[] = []
      const run: ClaudeRun = async (args) => {
        asked.push(args.join(' '))
        return { code: null, stdout: '', stderr: '', refused: true }
      }
      expect(await act(installing(run, 'win32'))).toEqual({ ok: false, error: 'Harness cannot run this claude launcher.', step: 'launcher' })
      expect(asked).toEqual(['--version'])
    }
  })
})

describe('calls to claude', () => {
  it('the install waits 60 s and the list 15 s', async () => {
    const claude = fakeClaude({ 'plugin list --json': list() })
    const deps = installing(claude.run, 'darwin')
    await claudeEnable(deps)
    const timeouts = Object.fromEntries(claude.calls.map((call) => [call.args, call.timeoutMs]))
    expect(timeouts).toEqual({
      '--version': 15_000,
      'plugin list --json': 15_000,
      'plugin marketplace list --json': 15_000,
      [add(deps.folder)]: 60_000,
      [INSTALL]: 60_000,
    })
    const off = fakeClaude({ 'plugin list --json': list(USER_OFF) })
    await claudeEnable(installing(off.run, 'darwin'))
    await claudeDisable({ run: off.run, platform: 'darwin' })
    expect(off.calls.filter((call) => /^plugin (enable|uninstall) /.test(call.args)).map((call) => call.timeoutMs))
      .toEqual([15_000, 15_000])
  })

  it('a failed call gives one line', async () => {
    const failing = fakeClaude({
      'plugin install harness-device@openharness --scope user': { code: 1, stderr: '\nError: no network\n  at fetch\n' },
    })
    expect(await claudeEnable(installing(failing.run, 'darwin')))
      .toEqual({ ok: false, error: 'Error: no network', step: 'install', reason: 'exit 1' })

    const silent = fakeClaude({ 'plugin list --json': list(USER_ON), 'plugin uninstall harness-device@openharness --scope user': { code: 2 } })
    expect(await claudeDisable({ run: silent.run, platform: 'darwin' }))
      .toEqual({ ok: false, error: 'Claude Code did not answer.', step: 'uninstall', reason: 'exit 2' })

    const folder = marketplaceFolder()
    const unanswered = fakeClaude({ [add(folder)]: { code: null, stderr: '' } })
    expect(await claudeEnable(installing(unanswered.run, 'darwin', folder)))
      .toEqual({ ok: false, error: 'Claude Code did not answer.', step: 'marketplace', reason: 'no answer' })
    expect(unanswered.writes()).toEqual([add(folder)])
  })

  // The devices log why a step failed in a fixed word, never in Claude Code's own line, which can name a path.
  it('a failed call says why in a fixed word', () => {
    const reason = (stderr: string, code: number | null = 1) => failureReason({ code, stdout: '', stderr })
    expect(reason('xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools), missing xcrun at: /Library/Developer/CommandLineTools/usr/bin/xcrun\n'))
      .toBe('no xcode tools')
    // git only as the program that did not run: a spawn's, a shell's, cmd.exe's and Bun's on Windows.
    for (const line of [
      'Error: spawn git ENOENT\n', 'Error: spawn /usr/bin/git ENOENT\n', "'git' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n",
      'bash: git: command not found\n', 'zsh: command not found: git\n', "ENOENT: Command 'git' not found or is in an unsafe location\n",
    ]) expect(reason(line), line).toBe('no git')
    // `openharness.git` names the repository, not git itself, and a line that only says git and not found names no git
    // that failed to run.
    expect(reason("fatal: repository 'https://github.com/autonomous-ai/openharness.git/' not found\n", 128)).toBe('exit 128')
    expect(reason("Error: ENOENT: no such file or directory, open '/x/openharness/.git/HEAD'\n")).toBe('exit 1')
    expect(reason('Plugin "harness-device" not found in marketplace "openharness" (git source)\n')).toBe('exit 1')
    expect(reason("fatal: unable to access 'https://github.com/a/b/': Could not resolve host: github.com\n")).toBe('network')
    // SSL and TLS as words, not inside one.
    expect(reason('SSL certificate problem: unable to get local issuer certificate\n')).toBe('network')
    expect(reason('Error: TLS connection was closed\n')).toBe('network')
    expect(reason("Error: cannot read '/Users/x/classless/plugin.json'\n")).toBe('exit 1')
    expect(reason("Marketplace 'openharness' is already added from a different source\n")).toBe('exists')
    expect(reason("Marketplace 'openharness' already exists\n")).toBe('exists')
    // A file that already exists is no marketplace that does.
    expect(reason("Error: EEXIST: file already exists, mkdir '/Users/x/.claude/plugins/marketplaces/openharness'\n")).toBe('exit 1')
    expect(reason("Failed to add marketplace: EEXIST: file already exists, mkdir '/x'\n")).toBe('exit 1')
    expect(reason('Error: github.com not found\n')).toBe('exit 1')
    expect(failureReason({ code: null, stdout: '', stderr: '', timedOut: true })).toBe('timeout')
    expect(failureReason({ code: null, stdout: '', stderr: '' })).toBe('no answer')

    expect(failureWords({ ok: false, error: 'x', step: 'marketplace', reason: 'network' })).toBe('marketplace · network')
    expect(failureWords({ ok: false, error: 'x', step: 'unsupported' })).toBe('unsupported')
  })

  // The devices count a failure by its step, a fixed word, never by Claude Code's own line.
  it('a failure names its step', async () => {
    const failed = (stderr: string) => ({ code: 1, stderr })
    const step = async (answers: Record<string, Answer>, act: typeof claudeEnable | typeof claudeUpdate = claudeEnable, folder = marketplaceFolder()) => {
      const result = await act(installing(fakeClaude(answers).run, 'darwin', folder))
      return result.ok ? null : result.step
    }
    const folder = marketplaceFolder()
    expect(await step({ [add(folder)]: failed('Error: a\n') }, claudeEnable, folder)).toBe('marketplace')
    expect(await step({ 'plugin install harness-device@openharness --scope user': failed('Error: b\n') })).toBe('install')
    expect(await step({ 'plugin list --json': list(USER_OFF), 'plugin enable harness-device@openharness --scope user': failed('Error: c\n') }))
      .toBe('enable')
    expect(await step({ 'plugin list --json': list(USER_ON), 'plugin uninstall harness-device@openharness --scope user': failed('Error: d\n') }, claudeDisable))
      .toBe('uninstall')
    expect(await step({ 'plugin list --json': list(USER_ON), 'plugin marketplace update openharness': failed('Error: e\n') }, claudeUpdate))
      .toBe('marketplace')
    expect(await step({ 'plugin list --json': list(USER_ON), 'plugin update harness-device@openharness --scope user': failed('Error: f\n') }, claudeUpdate))
      .toBe('update')
  })
})

/** A throwaway folder as PATH and HOME: no `claude` of the developer's is ever found. */
function throwawayPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-claude-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  vi.stubEnv('PATH', dir)
  vi.stubEnv('HOME', dir)
  return dir
}

describe('claudeRun', () => {
  it('runs the claude on PATH and gives its code and output', async () => {
    const dir = throwawayPath()
    const script = join(dir, 'claude')
    writeExecutable(script, '#!/bin/sh\necho "args: $*"\necho "warned" >&2\nexit 3\n')
    const run = claudeRun()
    expect(run).not.toBeNull()
    expect(await run!(['plugin', 'list', '--json'], 15_000))
      .toEqual({ code: 3, stdout: 'args: plugin list --json\n', stderr: 'warned\n' })
  })

  it('a call past its time ends with no code', async () => {
    const dir = throwawayPath()
    const script = join(dir, 'claude')
    writeFileSync(script, '#!/bin/sh\nexec /bin/sleep 30\n')
    chmodSync(script, 0o755)
    expect(await claudeRun()!(['--version'], 200)).toMatchObject({ code: null, timedOut: true })
  })

  // A `claude` that does not end on TERM (a shell trapping it, a node stuck in a synchronous call) ends at its time too.
  it('a call past its time ends though claude ignores TERM', async () => {
    const dir = throwawayPath()
    const script = join(dir, 'claude')
    writeFileSync(script, "#!/bin/sh\ntrap '' TERM\n/bin/sleep 5\n")
    chmodSync(script, 0o755)
    const started = Date.now()
    // A second for the shell to set its trap before the time runs out, however slow the computer is to start it.
    expect(await claudeRun()!(['--version'], 1_000)).toMatchObject({ code: null, timedOut: true })
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  // A claude stuck where even SIGKILL waits never closes: the setup must not wait with it, as orcaHomes' run does not.
  it('a call past its time ends though claude never closes after the kill', async () => {
    const kill = vi.fn(() => true)
    vi.spyOn(childProcess, 'execFile').mockImplementation((() => ({ stdin: { end: () => {} }, kill })) as never)
    expect(await claudeRunner('/nowhere/claude', {}, 'darwin')(['--version'], 200)).toEqual({ code: null, stdout: '', stderr: '', timedOut: true })
    expect(kill).toHaveBeenCalledWith('SIGKILL')
  })

  // execFile throws rather than emits for a start the system refuses at once (ENOTDIR, EINVAL): its time must not be
  // left to fire on a child that never was, which would throw in a timer and end the process (on Windows, the core's).
  it('a start that throws is no answer, and leaves no time running', async () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    vi.spyOn(childProcess, 'execFile').mockImplementation((() => { throw Object.assign(new Error('spawn ENOTDIR'), { code: 'ENOTDIR' }) }) as never)
    const ran = claudeRunner('/nowhere/claude', {}, 'darwin')(['--version'], 200)
    expect(() => vi.advanceTimersByTime(200)).not.toThrow()
    expect(await ran).toEqual({ code: null, stdout: '', stderr: '' })
  })

  it('is null when no claude is found', () => {
    throwawayPath()
    expect(claudeRun()).toBeNull()
  })
})

// The build defines __CLAUDE_PLUGIN__ (scripts/lib/claudePluginBundle.mjs); vitest runs the sources, which have none.
it('from the sources no plugin is carried', () => {
  expect(carriedClaudePlugin()).toBeNull()
})

describe('claudeFound', () => {
  /**
   * A `claude` in bin/, with another folder before it on PATH, that prints its arguments, the Claude Code home it was
   * handed and the first folder of its PATH: an npm install's `#!/usr/bin/env node` finds the node beside it there.
   */
  function claudeOnPath(): { dir: string; bin: string } {
    const dir = throwawayPath()
    const bin = join(dir, 'bin')
    mkdirSync(join(dir, 'other'))
    mkdirSync(bin)
    const script = join(bin, 'claude')
    writeExecutable(script, '#!/bin/sh\necho "args: $*"\necho "home: ${CLAUDE_CONFIG_DIR-none}"\necho "first: ${PATH%%:*}"\n')
    vi.stubEnv('PATH', [join(dir, 'other'), bin].join(delimiter))
    return { dir, bin }
  }

  it('claudeFound runs the claude the lookup finds, its folder first on PATH, CLAUDE_CONFIG_DIR naming the home', async () => {
    const { dir, bin } = claudeOnPath()
    const home = join(dir, 'profile-a')
    for (const shell of [true, false]) {
      const run = await claudeFound(home, shell)
      expect(run).not.toBeNull()
      expect(await run!(['plugin', 'list', '--json'], 15_000))
        .toEqual({ code: 0, stdout: `args: plugin list --json\nhome: ${home}\nfirst: ${bin}\n`, stderr: '' })
    }
  })

  // The scans between two reads of the login shell's PATH: a `claude` installed since, where its installer puts it, is
  // found with no shell started.
  it('claudeFound without the shell finds a claude in the folder its installer uses, and starts no login shell', async () => {
    const dir = throwawayPath()
    const lookup = vi.spyOn(engineBin, 'agentCommandOwnershipSnapshotAsync')
    expect(await claudeFound(join(dir, '.claude'), false)).toBeNull()
    mkdirSync(join(dir, '.local', 'bin'), { recursive: true })
    const script = join(dir, '.local', 'bin', 'claude')
    writeExecutable(script, '#!/bin/sh\necho "args: $*"\n')

    const run = await claudeFound(join(dir, '.claude'), false)

    expect(await run!(['--version'], 15_000)).toMatchObject({ code: 0, stdout: 'args: --version\n' })
    expect(lookup).not.toHaveBeenCalled()
    await claudeFound(join(dir, '.claude'), true)
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  // The daemon started from a shell with an Orca profile's CLAUDE_CONFIG_DIR: the plugin goes into the home asked for.
  it('claudeFound with ~/.claude as the home passes no CLAUDE_CONFIG_DIR, though the process has one', async () => {
    const { dir, bin } = claudeOnPath()
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(dir, 'profile-b'))
    const run = await claudeFound(join(dir, '.claude'), true)
    expect(await run!(['--version'], 15_000)).toEqual({ code: 0, stdout: `args: --version\nhome: none\nfirst: ${bin}\n`, stderr: '' })
  })

  it('claudeFound is null when no claude is found', async () => {
    const dir = throwawayPath()
    expect(await claudeFound(join(dir, '.claude'), true)).toBeNull()
    expect(await claudeFound(join(dir, '.claude'), false)).toBeNull()
  })
})

describe('claudeRunIn', () => {
  // The command run inside an Orca terminal has that account's CLAUDE_CONFIG_DIR: the child names the home asked for,
  // and the process keeps its own for every other call it makes.
  it('the child gets CLAUDE_CONFIG_DIR and process.env does not', async () => {
    const dir = throwawayPath()
    const script = join(dir, 'claude')
    writeExecutable(script, '#!/bin/sh\necho "home: ${CLAUDE_CONFIG_DIR-none}"\n')
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(dir, 'profile-b'))
    const home = join(dir, 'profile-a')

    const run = claudeRunIn(home)

    expect(await run!(['--version'], 15_000)).toEqual({ code: 0, stdout: `home: ${home}\n`, stderr: '' })
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(join(dir, 'profile-b'))
  })

  // The command run inside an Orca terminal turns the plugin on or off in ~/.claude too: Claude Code's own default, which
  // it reads with no CLAUDE_CONFIG_DIR.
  it('with ~/.claude as the home the child gets no CLAUDE_CONFIG_DIR, though the process has one', async () => {
    const dir = throwawayPath()
    const script = join(dir, 'claude')
    writeExecutable(script, '#!/bin/sh\necho "home: ${CLAUDE_CONFIG_DIR-none}"\n')
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(dir, 'profile-b'))

    const run = claudeRunIn(join(dir, '.claude'))

    expect(await run!(['--version'], 15_000)).toEqual({ code: 0, stdout: 'home: none\n', stderr: '' })
  })

  it('is null when no claude is found', () => {
    const dir = throwawayPath()
    expect(claudeRunIn(join(dir, 'profile-a'))).toBeNull()
  })
})

/** This process as Windows until the test ends: the lookup and the runner read process.platform. */
function asWindows(): void {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  cleanup.push(() => Object.defineProperty(process, 'platform', platform))
}

describe('claudeRunner on Windows', () => {
  /** Claude Code as npm installs it on Windows, its shim the real one's form, and a node.exe in another PATH folder. */
  function npmClaude() {
    const dir = throwawayPath()
    const npm = join(dir, 'npm'), nodeDir = join(dir, 'nodejs')
    const script = join(npm, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    mkdirSync(dirname(script), { recursive: true })
    mkdirSync(nodeDir)
    writeFileSync(script, '')
    const node = join(nodeDir, 'node.exe')
    writeFileSync(node, '')
    const shim = join(npm, 'claude.cmd')
    writeFileSync(shim, readFileSync(join(import.meta.dirname, '..', 'lib', 'windows', 'fixtures', 'npm-codex.cmd'), 'utf8')
      .replace('@openai\\codex\\bin\\codex.js', '@anthropic-ai\\claude-code\\cli.js'))
    return { shim, node, script, env: { PATH: `${nodeDir};${npm}` } }
  }

  it('starts the program the shim runs, hidden, with no shell', async () => {
    const { shim, node, script, env } = npmClaude()
    const started = vi.spyOn(childProcess, 'execFile').mockImplementation(((_file: string, _args: string[], _options: object,
      done: (error: null, stdout: string, stderr: string) => void) => {
      done(null, '2.1.300 (Claude Code)\n', '')
      return { stdin: { end: () => {} } }
    }) as never)

    expect(await claudeRunner(shim, env, 'win32')(['--version'], 15_000)).toEqual({ code: 0, stdout: '2.1.300 (Claude Code)\n', stderr: '' })

    expect(started).toHaveBeenCalledOnce()
    const [file, args, options] = started.mock.calls[0] as unknown as [string, string[], Record<string, unknown>]
    expect([file, args]).toEqual([node, [script, '--version']])
    expect(options).toMatchObject({ windowsHide: true })
    expect(options.shell).toBeUndefined()
    expect(options.detached).toBeUndefined()
  })

  it('a batch file it does not know is refused, and nothing is started', async () => {
    const dir = throwawayPath()
    const batch = join(dir, 'claude.cmd')
    writeFileSync(batch, '@echo off\r\nstart calc %*\r\n')
    const started = vi.spyOn(childProcess, 'execFile')
    expect(await claudeRunner(batch, undefined, 'win32')(['--version'], 15_000)).toEqual({ code: null, stdout: '', stderr: '', refused: true })
    expect(started).not.toHaveBeenCalled()
  })
})

// The paths are this Mac's, so only the choice of lookup is shown here; claudePlugin.windows.real.spec.ts runs it on
// Windows itself.
describe('the lookup on Windows', () => {
  it('every lookup finds claude.exe in the profile\'s .local\\bin, off PATH, with no shell\'s PATH read', async () => {
    const dir = throwawayPath()
    mkdirSync(join(dir, '.local', 'bin'), { recursive: true })
    writeExecutable(join(dir, '.local', 'bin', 'claude.exe'), '#!/bin/sh\necho "args: $*"\n')
    const lookup = vi.spyOn(engineBin, 'agentCommandOwnershipSnapshotAsync')
    asWindows()

    const runs = [await claudeFound(join(dir, '.claude'), false), await claudeFound(join(dir, '.claude'), true), claudeRun(),
      claudeRunIn(join(dir, 'profile-a'))]

    expect(runs.map((run) => run !== null)).toEqual([true, true, true, true])
    for (const run of runs) expect(await run!(['--version'], 15_000)).toMatchObject({ code: 0, stdout: 'args: --version\n' })
    expect(lookup).not.toHaveBeenCalled()
  })
})
