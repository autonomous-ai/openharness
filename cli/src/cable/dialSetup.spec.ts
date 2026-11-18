/**
 * The dial's setup in the devices' own process, its homes and its plugin together, over throwaway homes, a throwaway
 * data folder and a fake `claude` whose install, or enable in an Orca home, turns the plugin on in that home's settings,
 * as Claude Code's own does. The real `claude`, ~/.claude, ~/.codex and Orca's profiles are never touched.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClaudeRun } from '../devices/claudePlugin.js'
import { DIAL_PLUGIN_ID, DIAL_SKILL, removeSkill } from '../devices/dialSkill.js'
import { DIAL_SETUP_FILE, readRemoved, readSetup, writePluginHomes, writeRemoved, writeSetup } from '../devices/dialSkillFiles.js'
import type { RolloutOwner } from './codexRolloutHome.js'
import { createDialSetup, type DialSetupDeps } from './dialSetup.js'

const ADD = 'plugin marketplace add autonomous-ai/openharness --sparse .claude-plugin plugins'
const INSTALL = 'plugin install harness-device@openharness --scope user'
const UNINSTALL = 'plugin uninstall harness-device@openharness --scope user'
const ENABLE = 'plugin enable harness-device@openharness --scope user'
const HOUR = 3_600_000

const folders: string[] = []
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dial-setup-'))
  folders.push(dir)
  return dir
}

const skillFile = (home: string): string => join(home, 'skills', 'dial', 'SKILL.md')
const hasSkill = (home: string): boolean => existsSync(skillFile(home)) && readFileSync(skillFile(home), 'utf8') === DIAL_SKILL

/** A Codex session's rollout in [home], held open in a terminal. */
const ownerIn = (home: string): RolloutOwner =>
  ({ engine: 'codex', record: join(home, 'sessions', '2026', '11', '17', 'rollout-a.jsonl'), tty: '/dev/ttys003' })

/**
 * A `claude` 2.1.287 whose plugin is on while [claudeHome]'s settings say so: its install, enable and uninstall write
 * them, as Claude Code's do, and a /plugin uninstall is the test writing them. A call in [fail] exits 1.
 */
function fakeClaude(claudeHome: string) {
  const calls: string[] = []
  const fail: string[] = []
  const settings = join(claudeHome, 'settings.json')
  const on = (): boolean => existsSync(settings) && JSON.parse(readFileSync(settings, 'utf8')).enabledPlugins?.[DIAL_PLUGIN_ID] === true
  const answer = (stdout = '') => ({ code: 0, stdout, stderr: '' })
  const run: ClaudeRun = async (args) => {
    const call = args.join(' ')
    calls.push(call)
    if (fail.includes(call)) return { code: 1, stdout: '', stderr: 'Error: no network\n' }
    if (call === '--version') return answer('2.1.287 (Claude Code)\n')
    if (call === 'plugin list --json') return answer(JSON.stringify(on() ? [{ id: DIAL_PLUGIN_ID, scope: 'user', enabled: true, version: '16a92abfab3f' }] : []))
    if (call === 'plugin marketplace list --json') return answer('[]')
    if (call === INSTALL || call === ENABLE) writeFileSync(settings, JSON.stringify({ enabledPlugins: { [DIAL_PLUGIN_ID]: true } }))
    if (call === UNINSTALL) writeFileSync(settings, JSON.stringify({ enabledPlugins: {} }))
    return answer()
  }
  /** The calls that change something. */
  const writes = () => calls.filter((call) => !/^(--version|plugin (marketplace )?list --json)$/.test(call))
  return { run, calls, fail, writes }
}

/** A setup over throwaway homes on a computer that never had a dial; `found` says whether the lookup finds the fake, one
 *  for each Claude Code home it is asked for, and `orca` is Orca's last read. */
function rig() {
  const [dataDir, claudeHome, codexHome] = [folder(), folder(), folder()]
  const fakes = new Map<string, ReturnType<typeof fakeClaude>>()
  const fakeIn = (home: string): ReturnType<typeof fakeClaude> => {
    if (!fakes.has(home)) fakes.set(home, fakeClaude(home))
    return fakes.get(home)!
  }
  const fake = fakeIn(claudeHome)
  const state = { found: true, orca: { homes: [] as readonly string[], answered: true } }
  const looked: string[] = []
  /** Whether each lookup read the login shell's PATH. */
  const shells: boolean[] = []
  const counted: string[][] = []
  const clock = { at: 0 }
  const deps: DialSetupDeps = {
    dataDir,
    platform: 'darwin',
    uid: process.getuid!(),
    claudeHome,
    codexHome,
    adopted: () => ({ claude: [], codex: [] }),
    removed: () => readRemoved(dataDir),
    now: () => clock.at,
    count: (engine, kind, reason) => { counted.push(reason === undefined ? [engine, kind] : [engine, kind, reason]) },
    log: () => {},
    claude: async (home, shell) => {
      looked.push(home)
      shells.push(shell)
      return state.found ? fakeIn(home).run : null
    },
    orcaClaude: () => state.orca,
    version: '0.6.59',
  }
  return { dataDir, claudeHome, codexHome, fake, fakeIn, state, looked, shells, counted, clock, setup: createDialSetup(deps) }
}

describe('createDialSetup', () => {
  it('the first attach sets Codex\'s homes up and installs the plugin, and Claude Code\'s skill follows in the same moment', async () => {
    const r = rig()

    await r.setup.attached()

    expect(hasSkill(r.codexHome)).toBe(true)
    expect(r.fake.writes()).toEqual([ADD, INSTALL])
    expect(hasSkill(r.claudeHome)).toBe(true)
    expect(readSetup(r.dataDir)).toMatchObject({ dial: true, plugin: '0.6.59' })
    // The plugin goes into the Claude Code home whose settings the homes read.
    expect(r.looked).toEqual([r.claudeHome])
    // One Claude Code setup: the plugin's, which its skill follows.
    expect(r.counted).toEqual([['codex', 'set up'], ['claude', 'set up']])
  })

  it('a computer that never had a dial gets nothing, and claude is not looked for', async () => {
    const r = rig()

    await r.setup.started()
    await r.setup.scanned([ownerIn(folder())])

    for (const home of [r.claudeHome, r.codexHome]) expect(existsSync(join(home, 'skills'))).toBe(false)
    expect(existsSync(join(r.dataDir, DIAL_SETUP_FILE))).toBe(false)
    expect(r.looked).toEqual([])
  })

  it('claude appearing later is set up at the next scan', async () => {
    const r = rig()
    r.state.found = false
    await r.setup.attached()
    expect(r.looked).toHaveLength(1)
    expect(readSetup(r.dataDir).plugin).toBeUndefined()

    // Claude Code installed since: no hour waited, as nothing failed.
    r.state.found = true
    await r.setup.scanned([])

    expect(r.fake.writes()).toEqual([ADD, INSTALL])
    expect(hasSkill(r.claudeHome)).toBe(true)
    expect(readSetup(r.dataDir).plugin).toBe('0.6.59')
  })

  it('a plugin uninstalled through /plugin is not installed again, and its skill goes', async () => {
    const r = rig()
    await r.setup.attached()
    expect(hasSkill(r.claudeHome)).toBe(true)

    writeFileSync(join(r.claudeHome, 'settings.json'), JSON.stringify({ enabledPlugins: {} }))
    await r.setup.scanned([])
    await r.setup.attached()
    await r.setup.started()

    expect(existsSync(skillFile(r.claudeHome))).toBe(false)
    expect(r.fake.writes()).toEqual([ADD, INSTALL])
    expect(hasSkill(r.codexHome)).toBe(true)
  })

  it('disable, then a scan: nothing is written and nothing is run', async () => {
    const r = rig()
    const other = folder()
    await r.setup.attached()
    await r.setup.scanned([ownerIn(other)])
    // `harness device claude disable` and `harness device codex disable`, as the command leaves things: each removal
    // marked, the plugin uninstalled and every copy of the skill taken out.
    writeRemoved(r.dataDir, 'claude', true)
    writeRemoved(r.dataDir, 'codex', true)
    await r.fake.run(UNINSTALL.split(' '), 15_000)
    for (const home of [r.claudeHome, r.codexHome, other]) removeSkill(join(home, 'skills'))
    const [calls, looked] = [r.fake.calls.length, r.looked.length]

    await r.setup.scanned([ownerIn(other)])
    await r.setup.attached()
    await r.setup.scanned([ownerIn(other), ownerIn(folder())])

    for (const home of [r.claudeHome, r.codexHome, other]) expect(existsSync(skillFile(home))).toBe(false)
    expect(r.fake.calls).toHaveLength(calls)
    expect(r.looked).toHaveLength(looked)
  })

  it('enable after a removal: the next scan writes Codex\'s other homes again', async () => {
    const r = rig()
    const other = folder()
    await r.setup.attached()
    await r.setup.scanned([ownerIn(other)])
    writeRemoved(r.dataDir, 'codex', true)
    await r.setup.scanned([ownerIn(other)])
    expect(hasSkill(other)).toBe(false)
    expect(readSetup(r.dataDir).homes.codex).toEqual([])

    // `harness device codex enable`: the removal cleared.
    writeRemoved(r.dataDir, 'codex', false)
    await r.setup.scanned([ownerIn(other)])

    expect(hasSkill(r.codexHome)).toBe(true)
    expect(hasSkill(other)).toBe(true)
  })

  it('a failed install is tried again no sooner than an hour later', async () => {
    const r = rig()
    r.fake.fail.push(INSTALL)
    await r.setup.attached()
    expect(r.counted).toContainEqual(['claude', 'failed', 'install'])
    const calls = r.fake.calls.length

    // Neither an attach nor a scan within the hour runs `claude`.
    r.clock.at = HOUR / 2
    await r.setup.attached()
    r.clock.at = HOUR - 1
    await r.setup.scanned([])
    expect(r.fake.calls).toHaveLength(calls)

    r.fake.fail.length = 0
    r.clock.at = HOUR
    await r.setup.scanned([])

    expect(r.fake.writes().filter((call) => call === INSTALL)).toHaveLength(2)
    expect(hasSkill(r.claudeHome)).toBe(true)
    expect(readSetup(r.dataDir).plugin).toBe('0.6.59')
  })

  it('the Orca step uses the home setup\'s record and the command\'s', async () => {
    const r = rig()
    const [a, b, c] = [folder(), folder(), folder()].map((home) => realpathSync(home))
    // c turned on by an earlier run of the devices, b by `harness device claude enable`.
    writeSetup(r.dataDir, { dial: false, homes: { claude: [], codex: [] }, pluginHomes: [c] })
    writePluginHomes(r.dataDir, [b])
    r.state.orca = { homes: [a, b, c], answered: true }

    await r.setup.attached()

    // After the default home's install, which turned its plugin on: Orca homes follow it.
    expect(r.looked).toEqual([r.claudeHome, a])
    expect(r.fakeIn(a).writes()).toEqual([ENABLE])
    expect(readSetup(r.dataDir).pluginHomes).toEqual([c, a])
  })

  it('the VS Code extension\'s version is kept in the same record, beside the dial, the plugin and the homes', async () => {
    const r = rig()
    // Not read yet: nothing is known, so nothing is written over the record.
    expect(r.setup.vscode()).toBeUndefined()
    await r.setup.started()
    expect(r.setup.vscode()).toEqual({ dial: false })
    await r.setup.attached()

    expect(r.setup.recordVscode('0.6.60')).toBe(true)

    expect(r.setup.vscode()).toEqual({ dial: true, version: '0.6.60' })
    expect(readSetup(r.dataDir)).toMatchObject({ dial: true, plugin: '0.6.59', vscode: '0.6.60', homes: { codex: [expect.any(String)] } })
    // A version a read would drop is not saved, and the one before stays.
    expect(r.setup.recordVscode('0.6.61 beta')).toBe(false)
    expect(r.setup.vscode()).toEqual({ dial: true, version: '0.6.60' })
    expect(readSetup(r.dataDir).vscode).toBe('0.6.60')
  })

  it('a record that could not be read leaves the VS Code extension\'s part not known', async () => {
    const r = rig()
    const file = join(r.dataDir, DIAL_SETUP_FILE)
    writeFileSync(file, JSON.stringify({ dial: true, vscode: '0.6.60' }))
    // Stands for any read error: EACCES, EIO, EMFILE.
    chmodSync(file, 0o000)
    await r.setup.started()
    await r.setup.attached()
    expect(r.setup.vscode()).toBeUndefined()
  })

  it('an attach reads the login shell\'s PATH at once, and the scans between read it at most every ten minutes', async () => {
    const r = rig()
    r.state.found = false
    await r.setup.attached()
    r.clock.at = 60_000
    await r.setup.scanned([])
    r.clock.at = 120_000
    await r.setup.attached()
    r.clock.at = 120_000 + 600_000
    await r.setup.scanned([])

    expect(r.shells).toEqual([true, false, true, true])
  })
})
