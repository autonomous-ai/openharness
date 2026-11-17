/**
 * Orca's account homes on the dial (docs/plans/2026-11-17-new-user-onboarding-design.md, "C. Orca homes"), on the real
 * daemon with a fake dial on the desk (harness/desk.ts) and a fake `orca` (harness/fakeOrca.ts) that lists homes of the
 * test's own:
 * - Claude Code in an Orca account's home, where Harness put no hooks, is found by the open scan and named from that
 *   home's process record;
 * - with a dial attached, an Orca account's Codex home gets the dial skill, with no command run;
 * - with a dial attached, Claude Code's plugin is turned on in each Orca account's home and recorded, once: one the person
 *   turned off stays off; `harness device claude disable` turns every home off and `enable` turns them on again;
 * - with no answer from Orca, the default home's sessions are listed as before.
 * No log line names an account's home or email.
 *
 * The daemon's `lsof` shows only files under the test's root, as in deviceDialSkill.e2e.ts: with a dial attached, the
 * open scan would otherwise see a Codex the developer runs and write into their real home.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { DIAL_PLUGIN_ID, DIAL_SKILL } from '../src/devices/dialSkill.js'
import { SYSTEM_FOLDERS } from '../src/testing/testPath.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { FakeOrca } from './harness/fakeOrca.js'
import { Outside } from './harness/outsideAgent.js'

/** The open scan's report of the one session it found: counts and its time, nothing else. */
const FOUND_ONE = /\[observed\] scan · 1 found · \d+ app known · \d+ named · \d+ ms/

// The run's bundle when there is one (E2E_BUNDLE), as the daemon runs, as in deviceDialSkill.e2e.ts.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH
  ? [process.env.E2E_BUNDLE_PATH]
  : ['--import', pathToFileURL(createRequire(join(CLI_ROOT, 'package.json')).resolve('tsx')).href, join(CLI_ROOT, 'src', 'cli.ts')]
const INSTALL = `plugin install ${DIAL_PLUGIN_ID} --scope user`
const ENABLE = `plugin enable ${DIAL_PLUGIN_ID} --scope user`

/**
 * An Orca account's Claude Code home, as Orca makes one: its `projects` and `plugins` links to the default home's, its
 * settings and sessions its own.
 */
function orcaClaudeHome(d: IsolatedDaemon, name = 'orca-claude'): string {
  const home = join(d.root, name)
  const plugins = join(dirname(d.env.CLAUDE_PROJECTS_DIR!), 'plugins')
  mkdirSync(home, { recursive: true })
  mkdirSync(plugins, { recursive: true })
  symlinkSync(d.env.CLAUDE_PROJECTS_DIR!, join(home, 'projects'))
  symlinkSync(plugins, join(home, 'plugins'))
  return home
}

const read = (file: string): string | null => existsSync(file) ? readFileSync(file, 'utf8') : null
/** Each `claude plugin` call the daemon's fake Claude Code and the command's took, one line of its words. */
const pluginCalls = (d: IsolatedDaemon): string[] => read(join(d.root, 'claude-plugin-calls'))?.split('\n').filter(Boolean) ?? []
const setupRecord = (d: IsolatedDaemon): { plugin?: string; pluginHomes?: string[] } | null => {
  const text = read(join(d.dataDir, 'dial-setup.json'))
  return text === null ? null : JSON.parse(text)
}
/** Whether the plugin is on in [claudeHome]'s user settings, Claude Code's own record. */
const pluginOn = (claudeHome: string): boolean =>
  JSON.parse(read(join(claudeHome, 'settings.json')) ?? '{}').enabledPlugins?.[DIAL_PLUGIN_ID] === true
/** Whether the plugin is installed in [claudeHome]'s `plugins`, as the fake Claude Code keeps it. */
const pluginInstalled = (claudeHome: string): boolean =>
  JSON.parse(read(join(claudeHome, 'plugins', 'fake-plugin-state.json')) ?? '{"installed":[]}').installed.includes(DIAL_PLUGIN_ID)

/**
 * A turn, so its conversation is on disk: the scan lists only a session with one. No hook of Harness's runs in an Orca
 * home, so the turn's end is read in its transcript, which the link puts in the default home's projects folder.
 */
async function turn(d: IsolatedDaemon, engine: Outside): Promise<void> {
  engine.type('before the dial')
  const projects = d.env.CLAUDE_PROJECTS_DIR!
  await until('its answer in its transcript', () => readdirSync(projects, { recursive: true }).map(String)
    .filter((path) => path.endsWith(`${engine.sessionId}.jsonl`))
    .some((path) => readFileSync(join(projects, path), 'utf8').includes('"type":"assistant"')), 30_000, 100)
}

describe('Orca\'s account homes on the dial', () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  const outside: Outside[] = []
  const children: ChildProcess[] = []
  afterEach(async () => {
    for (const engine of outside.splice(0)) await engine.close()
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await desk?.close()
    await daemon?.close()
    daemon = undefined
    desk = undefined
  })

  /** A daemon whose `lsof` shows only the test's own files, checked before anything is turned on. [claudeVersion]: its
   *  fake Claude Code's, one recent enough for the plugin. */
  const fresh = async (before: (d: IsolatedDaemon) => void = () => {}, claudeVersion?: string): Promise<{ d: IsolatedDaemon; desk: Desk }> => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' }, claudeVersion })
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
    // The daemon finds this one by name, or the filter proves nothing.
    expect(execFileSync('/bin/sh', ['-c', 'command -v lsof'], { env: d.env }).toString().trim()).toBe(join(d.root, 'bin', 'lsof'))
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    const theDesk = new Desk(file)
    desk = theDesk
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    before(d)
    await d.start()
    return { d, desk: theDesk }
  }
  const plugged = async (theDesk: Desk): Promise<FakeDial> => {
    const dial = await theDesk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    return dial
  }
  /** The real command, with the daemon's environment and its Claude Code home, as the person would run it. */
  async function device(d: IsolatedDaemon, words: string[]): Promise<{ code: number | null; err: string }> {
    const env = { ...d.env, CLAUDE_CONFIG_DIR: dirname(d.env.CLAUDE_PROJECTS_DIR!) }
    const child = spawn(process.execPath, [...CLI_ENTRY, 'device', ...words], { cwd: d.root, env, stdio: ['ignore', 'ignore', 'pipe'] })
    children.push(child)
    let err = ''
    child.stderr!.on('data', (chunk: Buffer) => { err += chunk.toString('utf8') })
    const code = await new Promise<number | null>((resolve) => child.once('close', resolve))
    return { code, err }
  }
  /**
   * Two Orca accounts' Claude Code homes, listed by the fake `orca`, and a dial plugged in: each home's plugin on.
   * [unplugged] runs on the started daemon before the dial comes.
   */
  type OrcaPlugins = { d: IsolatedDaemon; desk: Desk; a: string; b: string }
  const orcaPluginsOn = async (unplugged?: (d: IsolatedDaemon, b: string) => Promise<void>): Promise<OrcaPlugins> => {
    let a = '', b = ''
    const { d, desk } = await fresh((d) => {
      a = orcaClaudeHome(d, 'orca-a')
      b = orcaClaudeHome(d, 'orca-b')
      FakeOrca.install(d).accounts({ claude: [a, b] })
    }, '2.1.287')
    await unplugged?.(d, b)
    await plugged(desk)
    await until('the plugin on in both Orca homes', () => pluginOn(a) && pluginOn(b), 45_000, 100)
    await until('both Orca homes recorded', () => [...setupRecord(d)?.pluginHomes ?? []].sort().join() === [a, b].join(), 30_000, 50)
    return { d, desk, a, b }
  }
  /** Its row on the dial, once one is sent. */
  const listed = (dial: FakeDial, engine: Outside, what: string, test: (row: DialMessage) => boolean = () => true): Promise<DialMessage> =>
    dial.next((m) => m.t === 'agent' && m.id === engine.id && test(m), 45_000, what)

  it('Claude Code in an Orca account\'s home is found by the scan', async () => {
    let home = ''
    const { d, desk } = await fresh((d) => {
      home = orcaClaudeHome(d)
      FakeOrca.install(d).accounts({ claude: [home] })
    })
    // No dial yet, so no devices process, and no hook of Harness's in that home: only the scan can find it.
    const engine = await Outside.startIn(d, 'in-orca-home', home, {})
    outside.push(engine)
    await turn(d, engine)
    const dial = await plugged(desk)
    expect(await listed(dial, engine, 'the agent in the Orca home listed')).toMatchObject({ name: 'in-orca-home', engine: 'claude' })
    const log = d.log()
    expect(log).toContain('[observed] orca homes · 1 claude · 0 codex')
    expect(log).toMatch(FOUND_ONE)
    expect(log).not.toContain('example.invalid')
    expect(log).not.toContain(home)
  })

  it('the name the person gave it is read from that home\'s record', async () => {
    let home = ''
    const { d, desk } = await fresh((d) => {
      home = orcaClaudeHome(d)
      FakeOrca.install(d).accounts({ claude: [home] })
    })
    const engine = await Outside.startIn(d, 'in-orca-home', home, {})
    outside.push(engine)
    await turn(d, engine)
    engine.named(d, 'Tho 7f3a91c2', 'user')
    const dial = await plugged(desk)
    await listed(dial, engine, 'the agent by the name it was given', (row) => row.name === 'Tho 7f3a91c2')
    expect(d.log()).not.toContain('7f3a91c2')
  })

  it('with a dial attached, an Orca Codex home gets the dial skill', async () => {
    let home = ''
    const { d, desk } = await fresh((d) => {
      home = join(d.root, 'orca-codex')
      mkdirSync(home, { recursive: true })
      FakeOrca.install(d).accounts({ codex: [home] })
    })
    // No command run: the dial's first attach sets Codex up (docs/plans/2026-11-17-dial-agents-always-on-design.md).
    await plugged(desk)
    const skill = join(home, 'skills', 'dial', 'SKILL.md')
    await until('the skill in the Orca Codex home', () => existsSync(skill) && readFileSync(skill, 'utf8') === DIAL_SKILL, 45_000, 100)
    expect(d.log()).toContain('[observed] orca homes · 0 claude · 1 codex')
    expect(d.log()).not.toContain('example.invalid')
    expect(d.log()).not.toContain(home)
  })

  it('with no answer from Orca the default home\'s sessions are listed as before', async () => {
    // The harness's own `orca`, which exits 1 for everything.
    const { d, desk } = await fresh()
    const engine = await Outside.start(d, 'in-default-home', { TERM_PROGRAM: 'ghostty' })
    outside.push(engine)
    await turn(d, engine)
    const dial = await plugged(desk)
    expect(await listed(dial, engine, 'the agent in the default home listed')).toMatchObject({ name: 'in-default-home', engine: 'claude' })
    const log = d.log()
    expect(log).toContain('[observed] orca homes · not read · failed')
    expect(log).toMatch(FOUND_ONE)
  })

  it('with a dial attached, the plugin is turned on in each Orca account\'s home and recorded', async () => {
    const { d, a, b } = await orcaPluginsOn()
    const claudeHome = dirname(d.env.CLAUDE_PROJECTS_DIR!)
    // The default home's install first: an Orca home's plugin is its files.
    expect(pluginOn(claudeHome)).toBe(true)
    expect(pluginCalls(d).filter((call) => call === INSTALL)).toEqual([INSTALL])
    expect(pluginCalls(d).filter((call) => call === ENABLE)).toEqual([ENABLE, ENABLE])
    expect(pluginCalls(d).indexOf(INSTALL)).toBeLessThan(pluginCalls(d).indexOf(ENABLE))
    const log = d.log()
    expect(log).toContain('[observed] orca homes · 2 claude · 0 codex')
    expect(log).not.toContain('example.invalid')
    expect(log).not.toContain(a)
    expect(log).not.toContain(b)
  })

  it('a home the person turned off stays off', async () => {
    // A session in the other account, where Harness put no hooks, so only a scan lists it, and only once its first turn
    // is on disk. Started before the dial: the scan's look at the processes is kept up to 5 s, and one started after the
    // attach's scan may be missing from the replug's; a pane opened after an unplug took the dial's pseudo-terminal.
    let engine: Outside | undefined
    const { d, desk, a, b } = await orcaPluginsOn(async (started, home) => {
      engine = await Outside.startIn(started, 'in-orca-home', home, {})
      outside.push(engine)
    })
    // As /plugin would, in that account's Claude Code.
    execFileSync(d.env.CLAUDE_PATH!, ['plugin', 'disable', DIAL_PLUGIN_ID, '--scope', 'user'], { env: { ...d.env, CLAUDE_CONFIG_DIR: a }, stdio: 'ignore' })
    expect(pluginOn(a)).toBe(false)
    const calls = pluginCalls(d).length
    await turn(d, engine!)
    const scans = (): number => d.log().split('\n').filter((line) => FOUND_ONE.test(line)).length
    await desk.unplug('E2E-A')
    const before = scans()
    await plugged(desk)
    // Its line comes once that scan's pass has run, and the attach's before it.
    await until('the attach\'s scan', () => scans() > before, 45_000, 100)
    expect(pluginOn(a)).toBe(false)
    expect(pluginOn(b)).toBe(true)
    expect(pluginCalls(d).slice(calls).filter((call) => call === ENABLE)).toEqual([])
  })

  it('disable turns every home off, and enable turns them on again', async () => {
    const { d, a, b } = await orcaPluginsOn()
    const claudeHome = dirname(d.env.CLAUDE_PROJECTS_DIR!)
    // The command's PATH is the daemon's: it asks the same fake `orca`.
    expect(await device(d, ['claude', 'disable'])).toMatchObject({ code: 0, err: '' })
    expect([pluginOn(a), pluginOn(b), pluginOn(claudeHome)]).toEqual([false, false, false])
    expect(pluginInstalled(claudeHome)).toBe(false)

    expect(await device(d, ['claude', 'enable'])).toMatchObject({ code: 0, err: '' })
    expect([pluginOn(a), pluginOn(b), pluginOn(claudeHome)]).toEqual([true, true, true])
    expect(d.log()).not.toContain(a)
  })
})
