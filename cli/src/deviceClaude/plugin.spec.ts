/**
 * Status, enable and disable against a fake `claude`: a recording ClaudeRun answers each call from a table, and one real
 * script on a throwaway PATH and HOME stands in for the binary `claudeRun` finds. The real `claude` and ~/.claude are
 * never touched.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDisable, claudeEnable, claudeRun, claudeStatus, type ClaudeRun } from './plugin.js'

type Answer = { code: number | null; stdout?: string; stderr?: string }

const USER_ON = { id: 'harness-device@openharness', scope: 'user', enabled: true, version: '0.1.0' }
const USER_OFF = { ...USER_ON, enabled: false }
const MARKETPLACE = [{ name: 'openharness', source: 'github', repo: 'autonomous-ai/openharness' }]

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
    const sentence = { ok: false, error: 'Claude Code 2.1.287 or later is needed.' }
    const old = fakeClaude({}, '2.1.286 (Claude Code)')
    expect(await claudeEnable({ run: old.run, platform: 'darwin' })).toEqual(sentence)
    expect(old.writes()).toEqual([])
    const windows = fakeClaude({}, '2.2.0 (Claude Code)')
    expect(await claudeEnable({ run: windows.run, platform: 'win32' })).toEqual(sentence)
    expect(windows.writes()).toEqual([])
    expect(await claudeEnable({ run: null, platform: 'darwin' })).toEqual(sentence)
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
    expect(await claudeEnable({ run: failing.run, platform: 'darwin' })).toEqual({ ok: false, error: 'Error: no network' })

    const silent = fakeClaude({ 'plugin list --json': list(USER_ON), 'plugin uninstall harness-device@openharness --scope user': { code: 2 } })
    expect(await claudeDisable({ run: silent.run, platform: 'darwin' })).toEqual({ ok: false, error: 'Claude Code did not answer.' })

    const timedOut = fakeClaude({ 'plugin marketplace add autonomous-ai/openharness --sparse .claude-plugin plugins': { code: null, stderr: '' } })
    expect(await claudeEnable({ run: timedOut.run, platform: 'darwin' })).toEqual({ ok: false, error: 'Claude Code did not answer.' })
    expect(timedOut.writes()).toEqual(['plugin marketplace add autonomous-ai/openharness --sparse .claude-plugin plugins'])
  })
})

describe('claudeRun', () => {
  function throwawayPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'harness-claude-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    vi.stubEnv('PATH', dir)
    vi.stubEnv('HOME', dir)
    return dir
  }

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

  it('is null when no claude is found', () => {
    throwawayPath()
    expect(claudeRun()).toBeNull()
  })
})
