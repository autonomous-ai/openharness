/**
 * Claude Code and Codex set up to ring the dial from its first attach (docs/plans/2026-11-17-dial-agents-always-on-design.md),
 * on the real daemon with a fake dial on the desk (harness/desk.ts), homes of the test's own and a fake Claude Code
 * recent enough for its plugin, whose `claude plugin` notes each call (harness/fakeEngine.mjs):
 * - the first attach, with no command run, installs Claude Code's plugin and writes the skill in both default homes;
 * - a Codex in another home gets the skill once the open scan sees the rollout it holds; a skill the person deletes stays
 *   deleted, `disable` removes every copy Harness wrote and leaves a person's own, and `enable` brings it back with no
 *   restart;
 * - the plugin uninstalled with Claude Code's own `claude plugin` is never installed again, and its skill goes;
 * - with a real Codex binary (E2E_REAL_CODEX), the app-server that holds its rollout gives its home.
 *
 * The daemon's `lsof` shows only files under the test's root: the open scan reads every `codex` on the computer, and
 * without it the daemon would see a Codex the developer runs and write into their real home.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { DIAL_PLUGIN_ID, DIAL_SKILL } from '../src/devices/dialSkill.js'
import { placeNode } from '../src/testing/placeNode.js'
import { SYSTEM_FOLDERS } from '../src/testing/testPath.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import type { FakeDial } from './harness/fakeDial.js'

// The run's bundle when there is one (E2E_BUNDLE), as the daemon runs. Run from the caller's folder, where a bare
// `--import tsx` would not resolve: tsx and the sources by their paths.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH
  ? [process.env.E2E_BUNDLE_PATH]
  : ['--import', pathToFileURL(createRequire(join(CLI_ROOT, 'package.json')).resolve('tsx')).href, join(CLI_ROOT, 'src', 'cli.ts')]

/**
 * Codex 0.167.1's app-server as the scan sees it: a process named `codex`, with no terminal, holding one rollout open.
 * Node 24 names its main thread MainThread, which on Linux is the `comm` the scan reads: it takes back `codex`. On macOS
 * `lsof -c` reads the name of the file the kernel ran, so the holder is a copy of Node named `codex`: a link to Node is
 * still `node` there.
 */
const HOLDER = `
if (process.platform === 'linux') process.title = 'codex'
require('node:fs').openSync(process.argv[1], 'r')
process.stdout.write('held\\n')
process.stdin.on('end', () => process.exit(0)).resume()
`

const skillOf = (home: string): string => join(home, 'skills', 'dial', 'SKILL.md')
const read = (file: string): string | null => existsSync(file) ? readFileSync(file, 'utf8') : null
const rollout = (folder: string): string => join(folder, `rollout-2026-11-16T00-00-00-${randomUUID()}.jsonl`)
const INSTALL = `plugin install ${DIAL_PLUGIN_ID} --scope user`

/** Each `claude plugin` call the daemon's fake Claude Code took, one line of its words. */
const pluginCalls = (d: IsolatedDaemon): string[] => read(join(d.root, 'claude-plugin-calls'))?.split('\n').filter(Boolean) ?? []
const setupRecord = (d: IsolatedDaemon): { dial?: boolean; plugin?: string; homes?: { claude: string[]; codex: string[] } } | null => {
  const text = read(join(d.dataDir, 'dial-setup.json'))
  return text === null ? null : JSON.parse(text)
}
/** The log's lines that hold [text]. */
const logLines = (d: IsolatedDaemon, text: string): string[] => d.log().split('\n').filter((line) => line.includes(text))
/** The setup's lines and the tally's say counts and fixed words, never a path. */
const noPathLogged = (d: IsolatedDaemon): void => {
  expect(logLines(d, 'dial s').filter((line) => line.includes(d.root))).toEqual([])
}

/** The open files `lsof` shows the daemon, asked as its open scan asks. */
const daemonLsof = (d: IsolatedDaemon, ...args: string[]): string[] =>
  execFileSync('lsof', ['-n', '-P', '-Fpn', ...args], { env: d.env }).toString().split('\n')
    .filter((line) => line.startsWith('n')).map((line) => line.slice(1))

/** Each process whose executable is under [folder]: `comm` is that path on macOS, /proc says it on Linux. */
function executablesUnder(folder: string): number[] {
  const under = (path: string): boolean => path.startsWith(`${folder}/`)
  if (process.platform === 'linux') {
    return readdirSync('/proc').filter((name) => /^\d+$/.test(name)).filter((pid) => {
      try { return under(readlinkSync(`/proc/${pid}/exe`)) } catch { return false }
    }).map(Number)
  }
  return execFileSync('ps', ['-axww', '-o', 'pid=,comm=']).toString().split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(.*)$/)).filter((match): match is RegExpMatchArray => !!match && under(match[2]))
    .map((match) => Number(match[1]))
}

describe('the dial set up from its first attach', () => {
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

  /** A daemon whose `lsof` shows only the test's own files, checked before anything is turned on. */
  const fresh = async (): Promise<{ d: IsolatedDaemon; desk: Desk }> => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' }, claudeVersion: '2.1.287' })
    daemon = d
    const system = SYSTEM_FOLDERS.map((folder) => join(folder, 'lsof')).find((file) => existsSync(file))
    if (!system) throw new Error('lsof is required: the daemon\'s open scan reads it')
    // First on the daemon's PATH, and the scan runs `lsof` by name (lib/processTable.ts). Only the field output (-F),
    // which is what the scan reads, is filtered: its `n` lines are the names.
    writeFileSync(join(d.root, 'bin', 'lsof'), `#!/bin/sh
case " $* " in
  *" -F"*) '${system}' "$@" | awk -v root='${d.root}/' 'substr($0, 1, 1) != "n" || index($0, "n" root) == 1' ;;
  *) exec '${system}' "$@" ;;
esac
`, { mode: 0o755 })
    // The daemon finds this one by name, or the check below reads the system's and proves nothing.
    expect(execFileSync('/bin/sh', ['-c', 'command -v lsof'], { env: d.env }).toString().trim()).toBe(join(d.root, 'bin', 'lsof'))
    const outside = daemonLsof(d, '-c', 'codex', '-c', 'Codex').filter((name) => !name.startsWith(`${d.root}/`))
    expect(outside, 'the daemon\'s lsof shows a file outside the test\'s root').toEqual([])
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    const theDesk = new Desk(file)
    desk = theDesk
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    await d.start()
    return { d, desk: theDesk }
  }
  const plugged = async (theDesk: Desk): Promise<FakeDial> => {
    const dial = await theDesk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    return dial
  }

  /** The real command from source, with the daemon's environment. */
  async function device(d: IsolatedDaemon, ...words: string[]): Promise<{ code: number | null; err: string }> {
    const child = spawn(process.execPath, [...CLI_ENTRY, 'device', ...words], { cwd: d.root, env: d.env, stdio: ['ignore', 'ignore', 'pipe'] })
    children.push(child)
    let err = ''
    child.stderr!.on('data', (chunk: Buffer) => { err += chunk.toString('utf8') })
    const code = await new Promise<number | null>((resolve) => child.once('close', resolve))
    return { code, err }
  }

  /** A `codex` that holds [file] open, made under [d]'s root; resolves once it holds it. */
  async function hold(d: IsolatedDaemon, file: string): Promise<void> {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '')
    const codex = join(d.root, 'holder', 'codex')
    if (!existsSync(codex)) {
      mkdirSync(dirname(codex), { recursive: true })
      placeNode(codex)
    }
    // A session of its own: no terminal, as the app-server's.
    const child = spawn(codex, ['-e', HOLDER, file], { env: d.env, stdio: ['pipe', 'pipe', 'ignore'], detached: true })
    children.push(child)
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once('data', () => resolve())
      child.once('exit', (code) => reject(new Error(`the holder exited (${code})`)))
    })
  }

  it('a dial\'s first attach sets Claude Code and Codex up, with no command run', async () => {
    const { d, desk } = await fresh()
    const claudeHome = dirname(d.env.CLAUDE_PROJECTS_DIR!)
    await plugged(desk)
    await until('Codex\'s skill', () => read(skillOf(d.env.CODEX_HOME!)) === DIAL_SKILL, 45_000, 100)
    // Written once the plugin is on: Claude Code's own settings say so.
    await until('Claude Code\'s skill', () => read(skillOf(claudeHome)) === DIAL_SKILL, 45_000, 100)
    expect(pluginCalls(d)).toContain(INSTALL)
    expect(setupRecord(d)).toMatchObject({ dial: true, plugin: expect.any(String) })
    await until('the day\'s tally', () => logLines(d, '[device] dial setup · day ').length > 0, 30_000, 50)
    noPathLogged(d)
  })

  it('a Codex in another home is set up once the scan sees it, and what the person removes stays removed', async () => {
    const { d, desk } = await fresh()
    const codexHome = d.env.CODEX_HOME!
    const other = join(d.root, 'codex-other'), mine = join(d.root, 'codex-mine'), old = join(d.root, 'codex-old')
    const theirs = '---\nname: dial\ndescription: my own\n---\n\nMine.\n'
    mkdirSync(dirname(skillOf(mine)), { recursive: true })
    writeFileSync(skillOf(mine), theirs)
    const day = ['sessions', '2026', '11', '16']
    await hold(d, rollout(join(other, ...day)))
    await hold(d, rollout(join(mine, ...day)))
    await hold(d, rollout(join(old, 'archived_sessions')))
    // What the scan will read: the three rollouts, each held.
    await until('the three rollouts held', () => daemonLsof(d, '-c', 'codex').filter((name) => name.includes('/rollout-')).length === 3, 30_000, 100)
    const recorded = (): string[] => [...setupRecord(d)?.homes?.codex ?? []].sort()
    const leftRemoved = (): number => logLines(d, '[device] dial setup · codex · left removed').length

    await plugged(desk)
    await until('the skill in the other home', () => read(skillOf(other)) === DIAL_SKILL, 45_000, 100)
    await until('both homes recorded', () => recorded().join() === [join(codexHome, 'skills'), join(other, 'skills')].sort().join(), 30_000, 50)
    // The attach's pass wrote the default home, the scan's the other: each pass reports once it is over, so every
    // owner the scan read was handled by then.
    await until('the scan\'s report', () => logLines(d, 'dial skill: ').filter((line) => /codex wrote [1-9]/.test(line)).length >= 2, 30_000, 50)
    expect(read(skillOf(mine))).toBe(theirs)
    expect(existsSync(join(old, 'skills'))).toBe(false)

    // The person deletes the other home's skill: the next attach finds it gone and leaves it so.
    rmSync(join(other, 'skills', 'dial'), { recursive: true })
    await desk.unplug('E2E-A')
    await plugged(desk)
    await until('the deleted skill counted', () => leftRemoved() >= 1, 30_000, 50)
    expect(existsSync(skillOf(other))).toBe(false)

    // Taken before the disable: a scan may read the removal before the next attach does.
    const before = leftRemoved()
    expect(await device(d, 'codex', 'disable')).toMatchObject({ code: 0, err: '' })
    expect(existsSync(skillOf(codexHome))).toBe(false)
    expect(existsSync(skillOf(other))).toBe(false)
    expect(read(skillOf(mine))).toBe(theirs)
    expect(JSON.parse(readFileSync(join(d.dataDir, 'dial-skill.json'), 'utf8'))).toEqual({ removed: { codex: true } })

    // Plugged in again: the removal is read (counted once, by this attach or a scan before it), and nothing is written.
    await desk.unplug('E2E-A')
    await plugged(desk)
    await until('the removal read', () => leftRemoved() > before && recorded().length === 0, 30_000, 50)
    expect(existsSync(skillOf(codexHome))).toBe(false)
    expect(existsSync(skillOf(other))).toBe(false)

    // Enabled, and an attach runs a scan: the same daemon, never restarted.
    expect(await device(d, 'codex', 'enable')).toMatchObject({ code: 0, err: '' })
    expect(read(skillOf(codexHome))).toBe(DIAL_SKILL)
    await desk.unplug('E2E-A')
    await plugged(desk)
    await until('the skill in the other home again', () => read(skillOf(other)) === DIAL_SKILL, 45_000, 100)
    expect(read(skillOf(mine))).toBe(theirs)
    noPathLogged(d)
  })

  it('Claude Code\'s plugin uninstalled with claude plugin stays uninstalled, and its skill goes', async () => {
    const { d, desk } = await fresh()
    const claudeHome = dirname(d.env.CLAUDE_PROJECTS_DIR!)
    await plugged(desk)
    await until('Claude Code\'s skill', () => read(skillOf(claudeHome)) === DIAL_SKILL, 45_000, 100)
    await until('the plugin recorded', () => !!setupRecord(d)?.plugin, 30_000, 50)

    // As the person would, from a shell whose Claude Code home is the daemon's.
    execFileSync(join(d.root, 'bin', 'claude'), ['plugin', 'uninstall', DIAL_PLUGIN_ID, '--scope', 'user'],
      { env: { ...d.env, CLAUDE_CONFIG_DIR: claudeHome }, stdio: 'ignore' })
    await desk.unplug('E2E-A')
    await plugged(desk)
    await until('Claude Code\'s skill gone', () => !existsSync(skillOf(claudeHome)), 45_000, 100)
    expect(pluginCalls(d).filter((call) => call === INSTALL)).toEqual([INSTALL])
    noPathLogged(d)
  })

  it.runIf(!!process.env.E2E_REAL_CODEX)('a real Codex app-server\'s rollout gives its home', async () => {
    const codex = process.env.E2E_REAL_CODEX!
    const { d, desk } = await fresh()
    const home = join(d.root, 'codex-real'), work = join(d.root, 'work'), sessions = join(home, 'sessions')
    mkdirSync(home, { recursive: true })
    mkdirSync(work, { recursive: true })
    // No login and no model: the provider is a port where nothing listens.
    writeFileSync(join(home, 'config.toml'), `model_provider = "probe"

[model_providers.probe]
name = "probe"
base_url = "http://127.0.0.1:9/v1"
env_key = "PROBE_KEY"

[projects."${work}"]
trust_level = "trusted"
`)
    // A tmux server of the test's own, its socket under the root, and nothing of the developer's in the pane.
    const tmuxEnv = { HOME: join(d.root, 'home'), CODEX_HOME: home, PATH: d.tmux.env.PATH!, PROBE_KEY: 'none', TMUX_TMPDIR: d.root }
    const tmux = (...args: string[]): string => execFileSync('tmux', ['-L', 'dialskill', '-f', '/dev/null', ...args], { env: tmuxEnv }).toString()
    // Read before its server goes, and printed when the case fails.
    let screen = ''
    onTestFailed(() => { console.log(`---- the Codex pane\n${screen}`) })
    try {
      tmux('new-session', '-d', '-s', 'codex', '-x', '200', '-y', '50', '-c', work, codex)
      // Its composer, `›` at a line's start, is drawn once Codex takes input; the banner comes before it.
      const composer = (): string[] => tmux('capture-pane', '-p', '-t', 'codex').split('\n').filter((line) => line.startsWith('› '))
      await until('Codex\'s composer', () => composer().length > 0, 30_000, 200)
      tmux('send-keys', '-t', 'codex', '-l', 'hi')
      await until('hi in the composer', () => composer().includes('› hi'), 10_000, 100)
      // Codex can read an Enter that follows typed keys closely as part of a paste, and keep `hi` in the composer: it
      // is pressed again while nothing is held, at most every 3 s.
      let entered = 0
      const held = await until('a rollout held under the Codex home', () => {
        if (Date.now() - entered >= 3_000) {
          tmux('send-keys', '-t', 'codex', 'Enter')
          entered = Date.now()
        }
        let pid = 0
        for (const line of execFileSync('lsof', ['-n', '-P', '-Fpn', '-c', 'codex', '-c', 'Codex'], { env: d.env }).toString().split('\n')) {
          if (line.startsWith('p')) pid = Number(line.slice(1))
          else if (line.startsWith(`n${sessions}/`) && /\/rollout-[^/]*\.jsonl$/.test(line)) return pid
        }
        return null
      }, 60_000, 250)
      const args = execFileSync('ps', ['-ww', '-o', 'args=', '-p', String(held)]).toString()
      console.log(`the rollout's holder is an app-server: ${args.includes('app-server') ? 'yes' : 'no'}`)

      await plugged(desk)
      await until('the skill in the real Codex\'s home', () => read(skillOf(home)) === DIAL_SKILL, 45_000, 100)
      noPathLogged(d)
    } finally {
      try { screen = tmux('capture-pane', '-p', '-t', 'codex') } catch { /* gone */ }
      try { tmux('kill-server') } catch { /* already gone */ }
      // Codex's managed app-server runs from its home's packages/ and outlives the pane.
      for (const pid of executablesUnder(home)) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
      try {
        await until('Codex\'s processes to end', () => executablesUnder(home).length === 0, 5_000, 100)
      } catch {
        for (const pid of executablesUnder(home)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
      }
      await until('no process left under the Codex home', () => executablesUnder(home).length === 0, 5_000, 100)
    }
  })
})
