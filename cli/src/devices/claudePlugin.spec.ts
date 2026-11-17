/**
 * Status, enable, disable and update against a fake `claude`: a recording ClaudeRun answers each call from a table, and
 * one real script on a throwaway PATH and HOME stands in for the binary `claudeRun` and `claudeFound` find. The real
 * `claude` and ~/.claude are never touched.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as engineBin from '../lib/engineBin.js'
import { claudeDisable, claudeEnable, claudeFound, claudeRun, claudeSetUp, claudeStatus, claudeUpdate, type ClaudeRun } from './claudePlugin.js'

// A copy of the module, so a test can watch whether the lookup that starts the login shell ran.
vi.mock('../lib/engineBin.js', async (original) => ({ ...await original<object>() }))

type Answer = { code: number | null; stdout?: string; stderr?: string }

const USER_ON = { id: 'harness-device@openharness', scope: 'user', enabled: true, version: '0.1.0' }
const USER_OFF = { ...USER_ON, enabled: false }
const MARKETPLACE = [{ name: 'openharness', source: 'github', repo: 'autonomous-ai/openharness' }]
const UNLISTED = 'Claude Code did not list its plugins.'

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

  it('Windows is not supported at any version', async () => {
    expect(await claudeStatus({ run: fakeClaude({}, '9.0.0 (Claude Code)').run, platform: 'win32' }))
      .toMatchObject({ supported: false, claudeVersion: '9.0.0' })
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

describe('claudeEnable', () => {
  it('enable adds the marketplace, then installs', async () => {
    const claude = fakeClaude({})
    expect(await claudeEnable({ run: claude.run, platform: 'darwin' })).toEqual({ ok: true })
    expect(claude.writes()).toEqual([
      'plugin marketplace add autonomous-ai/openharness --sparse .claude-plugin plugins',
      'plugin install harness-device@openharness --scope user',
    ])
  })

  it('enable with the marketplace there only installs', async () => {
    const claude = fakeClaude({ 'plugin marketplace list --json': list(...MARKETPLACE) })
    expect(await claudeEnable({ run: claude.run, platform: 'linux' })).toEqual({ ok: true })
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
    expect(await claudeEnable({ run, platform: 'darwin' })).toEqual({ ok: true })
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
    expect(await claudeEnable({ run: stale.run, platform: 'darwin' }))
      .toEqual({ ok: false, error: 'Error: not found', step: 'install' })
    expect(stale.writes()).toEqual([install, 'plugin marketplace update openharness', install])

    const offline = fakeClaude({
      'plugin marketplace list --json': list(...MARKETPLACE),
      [install]: { code: 1, stderr: 'Error: not found\n' },
      'plugin marketplace update openharness': { code: 1, stderr: 'Error: no network\n' },
    })
    expect(await claudeEnable({ run: offline.run, platform: 'darwin' }))
      .toEqual({ ok: false, error: 'Error: no network', step: 'marketplace' })
    expect(offline.writes()).toEqual([install, 'plugin marketplace update openharness'])
  })

  it('an install that fails just after the marketplace add is not tried again: the clone is new', async () => {
    const install = 'plugin install harness-device@openharness --scope user'
    const claude = fakeClaude({ [install]: { code: 1, stderr: 'Error: no network\n' } })
    expect(await claudeEnable({ run: claude.run, platform: 'darwin' }))
      .toEqual({ ok: false, error: 'Error: no network', step: 'install' })
    expect(claude.writes()).toEqual(['plugin marketplace add autonomous-ai/openharness --sparse .claude-plugin plugins', install])
  })

  it('enable when installed but off runs plugin enable', async () => {
    const claude = fakeClaude({ 'plugin list --json': list(USER_OFF) })
    expect(await claudeEnable({ run: claude.run, platform: 'darwin' })).toEqual({ ok: true })
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
    expect(await claudeEnable({ run, platform: 'darwin' })).toEqual({ ok: true })
    const first = claude.writes().length
    expect(await claudeEnable({ run, platform: 'darwin' })).toEqual({ ok: true })
    expect(claude.writes().length).toBe(first)
  })

  it('enable when unsupported runs nothing and gives the sentence', async () => {
    const sentence = { ok: false, error: 'Claude Code 2.1.287 or later is needed.', step: 'unsupported' }
    const old = fakeClaude({}, '2.1.286 (Claude Code)')
    expect(await claudeEnable({ run: old.run, platform: 'darwin' })).toEqual(sentence)
    expect(old.writes()).toEqual([])
    const windows = fakeClaude({}, '2.2.0 (Claude Code)')
    expect(await claudeEnable({ run: windows.run, platform: 'win32' })).toEqual(sentence)
    expect(windows.writes()).toEqual([])
    expect(await claudeEnable({ run: null, platform: 'darwin' })).toEqual(sentence)
  })

  // A Claude Code the devices find on their own, every hour at most: an old one is asked one thing, not three.
  it('enable with an old Claude Code asks its version and nothing else', async () => {
    const claude = fakeClaude({}, '2.1.286 (Claude Code)')
    expect(await claudeEnable({ run: claude.run, platform: 'darwin' }))
      .toEqual({ ok: false, error: 'Claude Code 2.1.287 or later is needed.', step: 'unsupported' })
    expect(claude.calls.map((call) => call.args)).toEqual(['--version'])
  })
})

describe('claudeSetUp', () => {
  it('a plugin not there yet is installed, as enable installs it', async () => {
    const claude = fakeClaude({})
    expect(await claudeSetUp({ run: claude.run, platform: 'darwin' })).toEqual({ ok: true, outcome: 'installed' })
    expect(claude.writes()).toEqual([
      'plugin marketplace add autonomous-ai/openharness --sparse .claude-plugin plugins',
      'plugin install harness-device@openharness --scope user',
    ])
  })

  // `harness device claude enable` turns an entry that is off back on; the devices' own setup leaves it the person's.
  it('a plugin already on is current, and one turned off is absent, and nothing is run for either', async () => {
    for (const [entry, outcome] of [[USER_ON, 'current'], [USER_OFF, 'absent']] as const) {
      const claude = fakeClaude({ 'plugin list --json': list(entry) })
      expect(await claudeSetUp({ run: claude.run, platform: 'darwin' })).toEqual({ ok: true, outcome })
      expect(claude.writes()).toEqual([])
    }
  })

  it('with an old Claude Code it asks its version and nothing else', async () => {
    const claude = fakeClaude({}, '2.1.286 (Claude Code)')
    expect(await claudeSetUp({ run: claude.run, platform: 'darwin' }))
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
    const result = await claudeUpdate({ run: claude.run, platform: 'darwin' })
    expect(claude.writes()).toEqual(['plugin marketplace update openharness', update])
    expect(result).toEqual({ ok: true, outcome: 'updated' })
    // Both pull from GitHub: the time a fetch gets.
    expect(claude.calls.filter((call) => claude.writes().includes(call.args)).map((call) => call.timeoutMs)).toEqual([60_000, 60_000])
  })

  it('update with the same version after is current', async () => {
    const claude = updating('16a92abfab3f', '16a92abfab3f')
    expect(await claudeUpdate({ run: claude.run, platform: 'linux' })).toEqual({ ok: true, outcome: 'current' })
    expect(claude.writes()).toEqual(['plugin marketplace update openharness', update])
  })

  it('update of a plugin the person uninstalled or disabled runs nothing: absent', async () => {
    for (const plugins of [list(), list(USER_OFF), list({ ...USER_ON, scope: 'project' })]) {
      const claude = fakeClaude({ 'plugin list --json': plugins })
      expect(await claudeUpdate({ run: claude.run, platform: 'darwin' })).toEqual({ ok: true, outcome: 'absent' })
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
    expect(await claudeUpdate({ run, platform: 'darwin' })).toEqual({ ok: false, error: UNLISTED, step: 'list' })
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
    expect(await claudeUpdate({ run, platform: 'darwin' })).toEqual({ ok: true, outcome: 'current' })
  })

  it('update with an old Claude Code, or none, asks its version and nothing else', async () => {
    const claude = fakeClaude({ 'plugin list --json': list(USER_ON) }, '2.1.286 (Claude Code)')
    const unsupported = { ok: false, error: 'Claude Code 2.1.287 or later is needed.', step: 'unsupported' }
    expect(await claudeUpdate({ run: claude.run, platform: 'darwin' })).toEqual(unsupported)
    expect(claude.calls.map((call) => call.args)).toEqual(['--version'])
    expect(await claudeUpdate({ run: null, platform: 'darwin' })).toEqual(unsupported)
  })
})

describe('a list that cannot be read', () => {
  // One that failed, ran out of time or is not JSON says nothing of the plugin: it is never read as none.
  const unreadable: Array<[Answer, string]> = [
    [{ code: 1, stderr: 'Error: settings locked\n' }, 'Error: settings locked'],
    [{ code: null }, UNLISTED],
    [{ code: 0, stdout: 'Loading plugins…\n[' }, UNLISTED],
  ]

  it('setup, update, disable and enable fail with step list, and change nothing', async () => {
    for (const [answer, error] of unreadable) {
      for (const act of [claudeSetUp, claudeUpdate, claudeDisable, claudeEnable]) {
        const claude = fakeClaude({ 'plugin list --json': answer })
        expect(await act({ run: claude.run, platform: 'darwin' })).toEqual({ ok: false, error, step: 'list' })
        expect(claude.writes()).toEqual([])
      }
    }
  })
})

describe('calls to claude', () => {
  it('the install waits 60 s and the list 15 s', async () => {
    const claude = fakeClaude({ 'plugin list --json': list() })
    await claudeEnable({ run: claude.run, platform: 'darwin' })
    const timeouts = Object.fromEntries(claude.calls.map((call) => [call.args, call.timeoutMs]))
    expect(timeouts).toEqual({
      '--version': 15_000,
      'plugin list --json': 15_000,
      'plugin marketplace list --json': 15_000,
      'plugin marketplace add autonomous-ai/openharness --sparse .claude-plugin plugins': 60_000,
      'plugin install harness-device@openharness --scope user': 60_000,
    })
    const off = fakeClaude({ 'plugin list --json': list(USER_OFF) })
    await claudeEnable({ run: off.run, platform: 'darwin' })
    await claudeDisable({ run: off.run, platform: 'darwin' })
    expect(off.calls.filter((call) => /^plugin (enable|uninstall) /.test(call.args)).map((call) => call.timeoutMs))
      .toEqual([15_000, 15_000])
  })

  it('a failed call gives one line', async () => {
    const failing = fakeClaude({
      'plugin install harness-device@openharness --scope user': { code: 1, stderr: '\nError: no network\n  at fetch\n' },
    })
    expect(await claudeEnable({ run: failing.run, platform: 'darwin' }))
      .toEqual({ ok: false, error: 'Error: no network', step: 'install' })

    const silent = fakeClaude({ 'plugin list --json': list(USER_ON), 'plugin uninstall harness-device@openharness --scope user': { code: 2 } })
    expect(await claudeDisable({ run: silent.run, platform: 'darwin' }))
      .toEqual({ ok: false, error: 'Claude Code did not answer.', step: 'uninstall' })

    const timedOut = fakeClaude({ 'plugin marketplace add autonomous-ai/openharness --sparse .claude-plugin plugins': { code: null, stderr: '' } })
    expect(await claudeEnable({ run: timedOut.run, platform: 'darwin' }))
      .toEqual({ ok: false, error: 'Claude Code did not answer.', step: 'marketplace' })
    expect(timedOut.writes()).toEqual(['plugin marketplace add autonomous-ai/openharness --sparse .claude-plugin plugins'])
  })

  // The devices count a failure by its step, a fixed word, never by Claude Code's own line.
  it('a failure names its step', async () => {
    const failed = (stderr: string) => ({ code: 1, stderr })
    const step = async (answers: Record<string, Answer>, act: typeof claudeEnable | typeof claudeUpdate = claudeEnable) => {
      const result = await act({ run: fakeClaude(answers).run, platform: 'darwin' })
      return result.ok ? null : result.step
    }
    expect(await step({ 'plugin marketplace add autonomous-ai/openharness --sparse .claude-plugin plugins': failed('Error: a\n') }))
      .toBe('marketplace')
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
    writeFileSync(script, '#!/bin/sh\necho "args: $*"\necho "warned" >&2\nexit 3\n')
    chmodSync(script, 0o755)
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
    expect(await claudeRun()!(['--version'], 200)).toMatchObject({ code: null })
  })

  // A `claude` that does not end on TERM (a shell trapping it, a node stuck in a synchronous call) ends at its time too.
  it('a call past its time ends though claude ignores TERM', async () => {
    const dir = throwawayPath()
    const script = join(dir, 'claude')
    writeFileSync(script, "#!/bin/sh\ntrap '' TERM\n/bin/sleep 5\n")
    chmodSync(script, 0o755)
    const started = Date.now()
    // A second for the shell to set its trap before the time runs out, however slow the computer is to start it.
    expect(await claudeRun()!(['--version'], 1_000)).toMatchObject({ code: null })
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  it('is null when no claude is found', () => {
    throwawayPath()
    expect(claudeRun()).toBeNull()
  })
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
    writeFileSync(script, '#!/bin/sh\necho "args: $*"\necho "home: ${CLAUDE_CONFIG_DIR-none}"\necho "first: ${PATH%%:*}"\n')
    chmodSync(script, 0o755)
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
    writeFileSync(script, '#!/bin/sh\necho "args: $*"\n')
    chmodSync(script, 0o755)

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
