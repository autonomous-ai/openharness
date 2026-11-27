/**
 * The plugin's SessionStart hooks hand a session the dial's line (docs/plans/2026-11-26-needs-you-right-design.md,
 * Part 4), from what the devices' own setup carries: the real daemon with a fake dial on the desk sets Claude Code and
 * Codex up on the first attach, as deviceDialSkill.e2e.ts does, and the test runs the carried `hooks/hooks.json` and
 * `hooks/codex.json` SessionStart commands as the engines run them, through `/bin/sh -c` with the hook's input on stdin.
 * The fake engines run no plugin's hooks. The launcher in the test's home runs the file's bundle:
 * - Claude Code's hook prints the line with Harness's skill in the session's home and the plugin on, and nothing after
 *   `harness device claude disable`;
 * - Codex's prints it with Harness's skill in the Codex home and the plugin on there, and nothing after
 *   `harness device codex disable`;
 * - a session in the data folder, where Harness's own one-shots run (the voice router's), gets nothing.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { harnessPath, thisComputer } from '../src/config/harnessHome.js'
import { startOutput } from '../src/deviceClaude/start.js'
import { DIAL_PLUGIN_ID } from '../src/devices/dialSkill.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import { fileBundle } from './harness/fileBundle.js'

// The daemons and the commands on a build: from the sources the CLI carries no plugin to set up.
const bundle = fileBundle()

type Engine = 'claude' | 'codex'
type Run = { code: number | null; stdout: string; stderr: string }

const skillOf = (home: string): string => join(home, 'skills', 'dial', 'SKILL.md')
/** The plugin folder the setup carries, in Harness's marketplace folder for the daemon's home. */
const carried = (d: IsolatedDaemon): string =>
  join(harnessPath('claude-marketplace', d.env.HOME!, process.platform, thisComputer(d.env)), 'plugins', 'harness-device')
/** The daemon's Claude Code home, which a Claude Code session hands its hooks as CLAUDE_CONFIG_DIR. */
const claudeHomeOf = (d: IsolatedDaemon): string => dirname(d.env.CLAUDE_PROJECTS_DIR!)
const quiet: Run = { code: 0, stdout: '', stderr: '' }

describe('the carried SessionStart hooks print the dial\'s line', () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  const children: ChildProcess[] = []
  afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await desk?.close()
    await daemon?.close()
    daemon = undefined
    desk = undefined
  })

  /** A daemon with a fake dial's port, started, and a dial plugged in and shown its first list: the first attach. */
  const attached = async (): Promise<IsolatedDaemon> => {
    const d = await IsolatedDaemon.create({ scriptPath: bundle.path, env: { CABLE_DISABLE: 'false' }, claudeVersion: '2.1.287' })
    daemon = d
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    const theDesk = new Desk(file)
    desk = theDesk
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    await d.start()
    const dial = await theDesk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    launcher(d)
    return d
  }

  /** `~/.local/bin/harness` as the installer leaves it, where the hooks look first: the file's bundle. */
  function launcher(d: IsolatedDaemon): void {
    const bin = join(d.env.HOME!, '.local', 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'harness'), `#!/bin/sh\nexec '${process.execPath}' '${bundle.path}' "$@"\n`, { mode: 0o755 })
  }

  /** A child's exit and its output, with [stdin] written whole. */
  function run(file: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, stdin = ''): Promise<Run> {
    const child = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(child)
    let stdout = '', stderr = ''
    child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const done = new Promise<Run>((resolve) => child.once('close', (code) => resolve({ code, stdout, stderr })))
    child.stdin!.end(stdin)
    return done
  }

  /** The carried manifest's SessionStart command for [engine], run as the engine runs it: Claude Code puts the plugin's
   *  folder in place of `${CLAUDE_PLUGIN_ROOT}` and hands CLAUDE_CONFIG_DIR, Codex sets PLUGIN_ROOT. The input's `cwd`
   *  is [cwd], a project folder outside the data folder by default. */
  async function sessionStart(d: IsolatedDaemon, engine: Engine, cwd = join(d.projectsDir, 'work')): Promise<Run> {
    const root = carried(d)
    const manifest = JSON.parse(readFileSync(join(root, 'hooks', engine === 'claude' ? 'hooks.json' : 'codex.json'), 'utf8')) as
      { hooks: { SessionStart: { hooks: { command: string }[] }[] } }
    const command = manifest.hooks.SessionStart[0]!.hooks[0]!.command
    mkdirSync(cwd, { recursive: true })
    const input = { session_id: randomUUID(), transcript_path: join(d.root, 'transcript.jsonl'), cwd, hook_event_name: 'SessionStart',
      source: 'startup', ...(engine === 'codex' ? { model: 'probe-model', permission_mode: 'default' } : {}) }
    return engine === 'claude'
      ? run('/bin/sh', ['-c', command.replaceAll('${CLAUDE_PLUGIN_ROOT}', root)], { ...d.env, CLAUDE_CONFIG_DIR: claudeHomeOf(d) }, cwd, JSON.stringify(input))
      : run('/bin/sh', ['-c', command], { ...d.env, PLUGIN_ROOT: root }, cwd, JSON.stringify(input))
  }

  /** The real command from the file's bundle, as the person runs it, from a shell whose engine homes are the daemon's. */
  const device = (d: IsolatedDaemon, words: string[]): Promise<Run> =>
    run(process.execPath, [bundle.path, 'device', ...words], { ...d.env, CLAUDE_CONFIG_DIR: claudeHomeOf(d) }, d.root)

  /** Codex set up as a Codex the plugin supports leaves it: Harness's skill in its home, and the plugin's table on in
   *  its config.toml. The fake Codex is older than MIN_CODEX, so the setup writes no table: the test writes it. */
  async function codexReady(d: IsolatedDaemon): Promise<void> {
    const codexHome = d.env.CODEX_HOME!
    await until('Codex\'s skill', () => existsSync(skillOf(codexHome)), 45_000, 100)
    await until('the carried Codex hook', () => existsSync(join(carried(d), 'hooks', 'codex-start')), 45_000, 100)
    writeFileSync(join(codexHome, 'config.toml'), `[plugins."${DIAL_PLUGIN_ID}"]\nenabled = true\n`)
  }

  it('after the first attach the carried Claude Code hook prints the line, and after claude disable nothing', async () => {
    const d = await attached()
    const claudeHome = claudeHomeOf(d)
    await until('Claude Code\'s skill', () => existsSync(skillOf(claudeHome)), 45_000, 100)
    await until('the carried Claude Code hook', () => existsSync(join(carried(d), 'hooks', 'start')), 45_000, 100)
    // The plugin as `claude plugin install` leaves it: its entry in the user settings (as harness/inOrca.ts writes it).
    const settings = join(claudeHome, 'settings.json')
    const current = JSON.parse(readFileSync(settings, 'utf8')) as { enabledPlugins?: Record<string, boolean> }
    writeFileSync(settings, JSON.stringify({ ...current, enabledPlugins: { ...current.enabledPlugins, [DIAL_PLUGIN_ID]: true } }))

    expect(await sessionStart(d, 'claude')).toEqual({ code: 0, stdout: `${startOutput()}\n`, stderr: '' })
    expect(await device(d, ['claude', 'disable'])).toMatchObject({ code: 0, stderr: '' })
    expect(await sessionStart(d, 'claude')).toEqual(quiet)
  })

  it('the carried Codex hook prints the line with Harness\'s skill in the Codex home and the plugin on there, and after codex disable nothing', async () => {
    const d = await attached()
    await codexReady(d)

    expect(await sessionStart(d, 'codex')).toEqual({ code: 0, stdout: `${startOutput()}\n`, stderr: '' })
    expect(await device(d, ['codex', 'disable'])).toMatchObject({ code: 0, stderr: '' })
    expect(await sessionStart(d, 'codex')).toEqual(quiet)
  })

  it('the carried Codex hook prints nothing for Harness\'s own one-shot, a session in the data folder', async () => {
    const d = await attached()
    await codexReady(d)

    // Where voiceRouter.ts runs its one-shots, under the person's Codex home.
    expect(await sessionStart(d, 'codex', join(d.dataDir, 'voice-route-scratch'))).toEqual(quiet)
    // The same home and hook give a project's session the line: the data folder alone kept it from the one-shot.
    expect(await sessionStart(d, 'codex')).toEqual({ code: 0, stdout: `${startOutput()}\n`, stderr: '' })
  })
})
