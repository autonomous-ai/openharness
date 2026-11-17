/**
 * The dial skill in each home, from the devices' own process, in throwaway homes and a throwaway data folder each:
 * nothing before a dial attached on this computer once; then the daemon's own and adopted homes at the service's start
 * and at each attach, each Codex home the open scan finds a session in, and every copy it wrote taken out again once
 * `disable` removed that engine. The person's ~/.claude and ~/.codex are never touched.
 */
import * as fs from 'node:fs'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DIAL_PLUGIN_ID, DIAL_SKILL, removeSkill, writeSkill } from '../devices/dialSkill.js'
import { DIAL_SETUP_FILE, DIAL_SKILL_FILE, MAX_HOMES, readRemoved, readSetup, writeRemoved, writeSetup, type DialRemoved, type DialSkillHomes } from '../devices/dialSkillFiles.js'
import type { RolloutOwner } from './codexRolloutHome.js'
import { createDialHomeSetup, type DialHomeSetupDeps } from './dialHomeSetup.js'

// A copy of the module, so a test can watch the file calls a scan makes.
vi.mock('node:fs', async (original) => ({ ...await original<object>() }))

const uid = process.getuid!()

const folders: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of folders.splice(0)) {
    // A test made it read-only: open it again so it can be removed.
    if (existsSync(dir)) chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  }
})

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dial-homes-'))
  folders.push(dir)
  return dir
}

const skillFile = (home: string): string => join(home, 'skills', 'dial', 'SKILL.md')
const hasSkill = (home: string): boolean => existsSync(skillFile(home)) && readFileSync(skillFile(home), 'utf8') === DIAL_SKILL
/** The skill file 0.6.58 wrote, its marker line the old one. */
const OLD_SKILL = '---\nname: dial\ndescription: older\n# Written by Harness. Turn off the agent in Harness Device to remove it.\n---\n\nOlder.\n'
const oldSkillIn = (skills: string): void => {
  mkdirSync(join(skills, 'dial'), { recursive: true })
  writeFileSync(join(skills, 'dial', 'SKILL.md'), OLD_SKILL)
}
/** A home's skills folder as the record holds it, through its link. */
const skillsOf = (home: string): string => realpathSync(join(home, 'skills'))
/** A home with a real, empty skills folder, resolved. */
function skillsAt(home = folder()): string {
  mkdirSync(join(home, 'skills'), { mode: 0o700 })
  return skillsOf(home)
}

/** A Codex session's rollout in [home], held open in a terminal unless [tty] says otherwise. */
const ownerIn = (home: string, tty: string | null = '/dev/ttys003'): RolloutOwner =>
  ({ engine: 'codex', record: join(home, 'sessions', '2026', '11', '16', 'rollout-a.jsonl'), tty })

const pluginOn = (claudeHome: string): void =>
  writeFileSync(join(claudeHome, 'settings.json'), JSON.stringify({ enabledPlugins: { [DIAL_PLUGIN_ID]: true } }))

/** A dial attached on this computer once, with [homes] recorded. */
const dialOnce = (dataDir: string, homes: DialSkillHomes = { claude: [], codex: [] }): void => {
  writeSetup(dataDir, { dial: true, homes })
}

const sorted = (list: string[]): string[] => [...list].sort()
/** The pass's line: wrote, removed and failed per engine, failed 0 unless given. */
const counts = (claude: [number, number, number?], codex: [number, number, number?]): string =>
  `dial skill: claude wrote ${claude[0]} removed ${claude[1]} failed ${claude[2] ?? 0}, codex wrote ${codex[0]} removed ${codex[1]} failed ${codex[2] ?? 0}`

/** Every synchronous file call from here on, by name and first argument, until the test ends. */
function fileCalls(): [string, unknown][] {
  const calls: [string, unknown][] = []
  const module = fs as unknown as Record<string, (...args: unknown[]) => unknown>
  for (const [name, real] of Object.entries(module)) {
    if (typeof real !== 'function' || !name.endsWith('Sync')) continue
    vi.spyOn(module, name).mockImplementation((...args) => {
      calls.push([name, args[0]])
      return real(...args)
    })
  }
  return calls
}

/** A setup over throwaway homes, on a computer a dial attached on once unless [dial] is false or the test gives its own
 *  data dir, whose record it writes itself. `removed` reads the real dial-skill.json unless the test gives its own;
 *  every call to it is counted. The day's tally is `counted`, and `clock.at` the monotonic clock. */
function rig(over: Partial<DialHomeSetupDeps> = {}, dial = true) {
  const dataDir = over.dataDir ?? folder()
  if (!over.dataDir && dial) dialOnce(dataDir)
  const removed = over.removed ?? ((): DialRemoved => readRemoved(dataDir))
  const lines: string[] = []
  const counted: string[][] = []
  const clock = { at: 0 }
  const read = { removed: 0 }
  const deps: DialHomeSetupDeps = {
    platform: 'darwin',
    uid,
    claudeHome: folder(),
    codexHome: folder(),
    adopted: () => ({ claude: [], codex: [] }),
    log: (line) => lines.push(line),
    now: () => clock.at,
    count: (engine, kind, reason) => { counted.push(reason === undefined ? [engine, kind] : [engine, kind, reason]) },
    ...over,
    dataDir,
    removed: () => {
      read.removed++
      return removed()
    },
  }
  return { ...deps, lines, counted, clock, read, writer: createDialHomeSetup(deps) }
}

describe('a computer that never had a dial', () => {
  it('gets nothing: a start and a scan write no skill and no record', () => {
    const other = folder()
    const r = rig({}, false)
    pluginOn(r.claudeHome)

    r.writer.started()
    r.writer.scanned([ownerIn(other)])

    for (const home of [r.claudeHome, r.codexHome, other]) expect(existsSync(join(home, 'skills'))).toBe(false)
    expect(existsSync(join(r.dataDir, DIAL_SETUP_FILE))).toBe(false)
    expect(r.read.removed).toBe(0)
    expect(r.lines).toEqual([])
  })

  it('the first attach records the dial, then writes Codex\'s default and adopted homes, with no answer anywhere', () => {
    const [adopted, other] = [folder(), folder()]
    const r = rig({ adopted: () => ({ claude: [], codex: [adopted] }) }, false)
    r.writer.started()

    r.writer.attached()

    expect(hasSkill(r.codexHome)).toBe(true)
    expect(hasSkill(adopted)).toBe(true)
    expect(readSetup(r.dataDir)).toEqual({ dial: true, homes: { claude: [], codex: [skillsOf(r.codexHome), skillsOf(adopted)] } })
    expect(r.lines).toEqual([counts([0, 0], [2, 0])])

    // The scans after it set up too.
    r.writer.scanned([ownerIn(other)])
    expect(hasSkill(other)).toBe(true)
  })

  it('a record that cannot be saved at the first attach writes nothing', () => {
    const other = folder()
    const r = rig({}, false)
    chmodSync(r.dataDir, 0o500)

    r.writer.attached()
    r.writer.scanned([ownerIn(other)])

    for (const home of [r.codexHome, other]) expect(existsSync(join(home, 'skills'))).toBe(false)
    expect(existsSync(join(r.dataDir, DIAL_SETUP_FILE))).toBe(false)
    expect(r.lines).toEqual(['dial setup: record not saved'])
  })
})

describe('the devices set the dial skill up', () => {
  it('once a dial attached, a start sets up with no dial attached', () => {
    const r = rig({}, false)
    writeFileSync(join(r.dataDir, DIAL_SETUP_FILE), '{"dial":true}')

    r.writer.started()

    expect(hasSkill(r.codexHome)).toBe(true)
  })

  it('the old menu\'s false is not a removal, and its homes list is not read', () => {
    const oldListed = folder()
    const r = rig()
    writeFileSync(join(r.dataDir, DIAL_SKILL_FILE), '{"codex":false}')
    writeFileSync(join(r.dataDir, 'dial-skill-homes.json'), JSON.stringify({ claude: [], codex: [skillsAt(oldListed)] }))

    r.writer.started()

    expect(hasSkill(r.codexHome)).toBe(true)
    expect(existsSync(join(oldListed, 'skills', 'dial'))).toBe(false)
    expect(readSetup(r.dataDir).homes.codex).toEqual([skillsOf(r.codexHome)])
  })

  it('at start it writes the default and adopted homes of an engine that is on, and brings its recorded ones current', () => {
    const dataDir = folder()
    const [claudeAdopted, codexAdopted, claudeListed, codexListed] = [folder(), folder(), folder(), folder()]
    const recorded = { claude: [skillsAt(claudeListed)], codex: [skillsAt(codexListed)] }
    for (const skills of [...recorded.claude, ...recorded.codex]) oldSkillIn(skills)
    dialOnce(dataDir, recorded)
    const r = rig({ dataDir, adopted: () => ({ claude: [claudeAdopted], codex: [codexAdopted] }) })
    pluginOn(r.claudeHome)

    r.writer.started()

    for (const home of [r.claudeHome, claudeAdopted, claudeListed, r.codexHome, codexAdopted, codexListed]) expect(hasSkill(home)).toBe(true)
    const listed = readSetup(dataDir).homes
    expect(sorted(listed.claude)).toEqual(sorted([r.claudeHome, claudeAdopted, claudeListed].map(skillsOf)))
    expect(sorted(listed.codex)).toEqual(sorted([r.codexHome, codexAdopted, codexListed].map(skillsOf)))
    expect(r.lines).toEqual([counts([3, 0], [3, 0])])
    expect(r.counted).toEqual([
      ['claude', 'updated'], ['claude', 'set up'], ['claude', 'set up'],
      ['codex', 'updated'], ['codex', 'set up'], ['codex', 'set up'],
    ])
  })

  it('a default home that is missing is not made: only the command makes one', () => {
    const r = rig()
    rmSync(r.codexHome, { recursive: true })

    r.writer.started()

    expect(existsSync(r.codexHome)).toBe(false)
    expect(r.lines).toEqual([])
  })

  it('Claude Code on needs the strict plugin entry', () => {
    const settings = [
      undefined,
      { enabledPlugins: {} },
      { enabledPlugins: { [DIAL_PLUGIN_ID]: 'true' } },
    ]
    for (const entry of settings) {
      const r = rig()
      if (entry) writeFileSync(join(r.claudeHome, 'settings.json'), JSON.stringify(entry))
      r.writer.started()
      expect(existsSync(join(r.claudeHome, 'skills'))).toBe(false)
      expect(r.lines).toEqual([counts([0, 0], [1, 0])])
    }
    // A true entry, but the person removed Claude Code with `disable`.
    const removed = rig({ removed: () => ({ claude: true }) })
    pluginOn(removed.claudeHome)
    removed.writer.started()
    expect(existsSync(join(removed.claudeHome, 'skills'))).toBe(false)
    // The same entry with nothing removed is on.
    const on = rig()
    pluginOn(on.claudeHome)
    on.writer.started()
    expect(hasSkill(on.claudeHome)).toBe(true)
  })

  it('Claude Code\'s homes are written only while its plugin is on', () => {
    const r = rig()
    r.writer.started()
    expect(existsSync(join(r.claudeHome, 'skills'))).toBe(false)

    pluginOn(r.claudeHome)
    r.writer.scanned([])

    expect(hasSkill(r.claudeHome)).toBe(true)
    expect(readSetup(r.dataDir).homes.claude).toEqual([skillsOf(r.claudeHome)])
  })

  it('a Codex owner in a new CODEX_HOME gets the skill, and its home is recorded', () => {
    const [inTerminal, server] = [folder(), folder()]
    const r = rig()
    r.writer.started()
    r.lines.length = 0

    // Codex 0.167.1's app-server holds a terminal session's rollout with no terminal of its own.
    r.writer.scanned([ownerIn(inTerminal), ownerIn(server, null)])

    expect(hasSkill(inTerminal)).toBe(true)
    expect(hasSkill(server)).toBe(true)
    expect(sorted(readSetup(r.dataDir).homes.codex)).toEqual(sorted([r.codexHome, inTerminal, server].map(skillsOf)))
    expect(r.lines).toEqual([counts([0, 0], [2, 0])])
  })

  it('a profile linked to another home\'s skills is one write', () => {
    const profile = folder()
    const r = rig({ adopted: () => ({ claude: [], codex: [profile] }) })
    const shared = skillsAt(r.codexHome)
    symlinkSync(shared, join(profile, 'skills'))

    r.writer.started()
    r.writer.scanned([ownerIn(profile)])

    expect(hasSkill(profile)).toBe(true)
    expect(readSetup(r.dataDir).homes.codex).toEqual([shared])
    expect(r.lines).toEqual([counts([0, 0], [1, 0])])
  })

  it('disable\'s removal takes the skill out of every recorded home and empties that engine\'s record', () => {
    // At the start: ours go from each recorded folder, a person's stays.
    const [a, b, theirs] = [folder(), folder(), folder()]
    const dataDir = folder()
    const listed = [skillsAt(a), skillsAt(b), skillsAt(theirs)]
    writeSkill(listed[0])
    writeSkill(listed[1])
    mkdirSync(join(listed[2], 'dial'))
    writeFileSync(join(listed[2], 'dial', 'SKILL.md'), '---\nname: dial\n---\nMine.\n')
    writeSetup(dataDir, { dial: true, plugin: '0.6.59', homes: { claude: [], codex: listed } })
    writeRemoved(dataDir, 'codex', true)
    const r = rig({ dataDir })

    r.writer.started()

    expect(existsSync(skillFile(a))).toBe(false)
    expect(existsSync(skillFile(b))).toBe(false)
    expect(readFileSync(skillFile(theirs), 'utf8')).toBe('---\nname: dial\n---\nMine.\n')
    expect(readSetup(dataDir)).toEqual({ dial: true, plugin: '0.6.59', homes: { claude: [], codex: [] } })
    expect(r.lines).toEqual([counts([0, 0], [0, 2])])

    // At a scan: the removal, read for a new home, takes out what the start wrote.
    let removed = false
    const later = rig({ removed: () => (removed ? { codex: true } : {}) })
    later.writer.started()
    expect(hasSkill(later.codexHome)).toBe(true)
    removed = true
    const fresh = folder()
    later.writer.scanned([ownerIn(fresh)])
    expect(existsSync(skillFile(later.codexHome))).toBe(false)
    expect(existsSync(join(fresh, 'skills'))).toBe(false)
    expect(readSetup(later.dataDir).homes.codex).toEqual([])
    expect(later.lines.at(-1)).toBe(counts([0, 0], [0, 1]))
  })

  it('a skills folder both engines share keeps the skill until both are removed', () => {
    const r = rig()
    pluginOn(r.claudeHome)
    // Codex's skills linked to Claude Code's, as a person may link them.
    const shared = skillsAt(r.claudeHome)
    symlinkSync(shared, join(r.codexHome, 'skills'))
    r.writer.started()
    expect(readSetup(r.dataDir).homes).toEqual({ claude: [shared], codex: [shared] })

    // Codex removed: the folder leaves Codex's record, and Claude Code keeps its skill.
    writeRemoved(r.dataDir, 'codex', true)
    r.writer.scanned([])
    expect(hasSkill(r.claudeHome)).toBe(true)
    expect(readSetup(r.dataDir).homes).toEqual({ claude: [shared], codex: [] })

    // Claude Code removed too: the last one takes it.
    writeRemoved(r.dataDir, 'claude', true)
    r.writer.scanned([])
    expect(existsSync(join(shared, 'dial'))).toBe(false)
    expect(readSetup(r.dataDir).homes).toEqual({ claude: [], codex: [] })
  })

  it('off takes ours from the default home and the command\'s folders too, which no record of its own holds', () => {
    // The command wrote both at enable; the plugin was then uninstalled through /plugin, which runs no disable.
    const r = rig()
    const recorded = folder()
    writeSkill(skillsAt(r.claudeHome))
    writeSkill(skillsAt(recorded))
    writeRemoved(r.dataDir, 'claude', false, [skillsOf(recorded)])

    r.writer.started()

    expect(existsSync(join(r.claudeHome, 'skills', 'dial'))).toBe(false)
    expect(existsSync(join(recorded, 'skills', 'dial'))).toBe(false)
    expect(r.lines).toEqual([counts([0, 2], [1, 0])])
  })

  it('the plugin uninstalled through /plugin takes the skill at the next scan', () => {
    const r = rig()
    pluginOn(r.claudeHome)
    r.writer.started()
    expect(hasSkill(r.claudeHome)).toBe(true)

    // Claude Code writes its settings again, without the entry; dial-skill.json is untouched.
    writeFileSync(join(r.claudeHome, 'settings.json'), JSON.stringify({ enabledPlugins: {} }))
    r.writer.scanned([])

    expect(existsSync(skillFile(r.claudeHome))).toBe(false)
    expect(readSetup(r.dataDir).homes.claude).toEqual([])
  })

  it('the race: a removal between the write and the recheck takes the new one out', () => {
    // The person runs disable the moment the skill lands: every read after that says removed.
    let removed = false
    const r = rig({
      removed: () => {
        if (existsSync(skillFile(r.codexHome))) removed = true
        return removed ? { codex: true } : {}
      },
    })

    r.writer.started()

    expect(existsSync(skillFile(r.codexHome))).toBe(false)
    expect(readSetup(r.dataDir).homes.codex).toEqual([])
    expect(r.lines).toEqual([counts([0, 0], [1, 1])])
  })

  it('the race: a removal while the start pass brings a recorded folder current takes it out', () => {
    const listedHome = folder()
    let removed = false
    const r = rig({
      removed: () => {
        if (hasSkill(listedHome)) removed = true
        return removed ? { codex: true } : {}
      },
    })
    // No default home: the recorded folder is the pass's one write.
    rmSync(r.codexHome, { recursive: true })
    oldSkillIn(skillsAt(listedHome))
    dialOnce(r.dataDir, { claude: [], codex: [skillsOf(listedHome)] })

    r.writer.started()

    expect(existsSync(skillFile(listedHome))).toBe(false)
    expect(readSetup(r.dataDir).homes.codex).toEqual([])
  })

  it('the race: a removal while a scan brings a recorded home current takes it out', () => {
    const other = folder()
    let armed = false
    let removed = false
    const r = rig({
      removed: () => {
        if (armed && hasSkill(other)) removed = true
        return removed ? { codex: true } : {}
      },
    })
    writeSkill(skillsAt(other))
    dialOnce(r.dataDir, { claude: [], codex: [skillsOf(other)] })
    r.writer.started()
    // 0.6.58's command wrote its file there since: the scan brings it current, and the person runs disable the moment
    // it lands.
    writeFileSync(skillFile(other), OLD_SKILL)
    armed = true

    r.writer.scanned([ownerIn(other)])

    expect(existsSync(skillFile(other))).toBe(false)
    expect(readSetup(r.dataDir).homes.codex).toEqual([])
  })

  it('a scan with every home handled does no file work but the two stamps', () => {
    const other = folder()
    const r = rig()
    pluginOn(r.claudeHome)
    r.writer.started()
    r.writer.scanned([ownerIn(other)])
    expect(hasSkill(other)).toBe(true)
    const reads = r.read.removed
    const [lines, counted] = [r.lines.length, r.counted.length]
    const calls = fileCalls()

    r.writer.scanned([ownerIn(other)])

    expect(calls).toEqual([['statSync', join(r.dataDir, DIAL_SKILL_FILE)], ['statSync', join(r.claudeHome, 'settings.json')]])
    expect(r.read.removed).toBe(reads)
    expect([r.lines.length, r.counted.length]).toEqual([lines, counted])

    // While a default home is missing, one stat for it besides.
    const later = rig()
    rmSync(later.codexHome, { recursive: true })
    later.writer.started()
    calls.length = 0

    later.writer.scanned([])

    expect(calls).toEqual([
      ['statSync', join(later.dataDir, DIAL_SKILL_FILE)], ['statSync', join(later.claudeHome, 'settings.json')], ['statSync', later.codexHome],
    ])

    // An engine a scan read removed is looked at no more until a stamp changes, its open sessions' homes included.
    let removed = false
    const off = rig({ removed: () => (removed ? { codex: true } : {}) })
    const open = folder()
    off.writer.started()
    removed = true
    off.writer.scanned([ownerIn(open)])
    calls.length = 0
    const offReads = off.read.removed

    off.writer.scanned([ownerIn(open)])

    expect(calls).toEqual([['statSync', join(off.dataDir, DIAL_SKILL_FILE)], ['statSync', join(off.claudeHome, 'settings.json')]])
    expect(off.read.removed).toBe(offReads)
  })

  it('a home is not handled while its engine is removed', () => {
    const other = folder()
    const r = rig()
    writeRemoved(r.dataDir, 'codex', true)
    r.writer.started()
    r.writer.scanned([ownerIn(other)])
    expect(existsSync(join(other, 'skills'))).toBe(false)

    // enable clears the removal in dial-skill.json.
    writeRemoved(r.dataDir, 'codex', false)
    r.writer.scanned([ownerIn(other)])

    expect(hasSkill(other)).toBe(true)
  })

  describe('a changed dial-skill.json runs the start pass again', () => {
    /** disable as the command does it: the removal saved first, then ours taken from the default home and every
     *  recorded one. */
    const disable = (r: ReturnType<typeof rig>): void => {
      writeRemoved(r.dataDir, 'codex', true)
      for (const skills of [skillsOf(r.codexHome), ...readSetup(r.dataDir).homes.codex]) removeSkill(skills)
    }

    /** enable as the command does it: the removal cleared, then the skill written into the default home and every
     *  folder the record holds. */
    const enable = (r: ReturnType<typeof rig>): void => {
      writeRemoved(r.dataDir, 'codex', false)
      for (const skills of [skillsOf(r.codexHome), ...readSetup(r.dataDir).homes.codex]) writeSkill(skills)
    }

    it('a removal then enable before the next scan leaves every home as enable wrote it, and a scan with the file untouched reads it no more', () => {
      const other = folder()
      const r = rig()
      r.writer.started()
      r.writer.scanned([ownerIn(other)])
      disable(r)
      enable(r)
      r.lines.length = 0
      r.counted.length = 0

      r.writer.scanned([ownerIn(other)])

      expect(hasSkill(r.codexHome)).toBe(true)
      expect(hasSkill(other)).toBe(true)
      expect(r.lines).toEqual([])
      expect(r.counted).toEqual([])

      const reads = r.read.removed
      r.writer.scanned([ownerIn(other)])
      expect(r.read.removed).toBe(reads)
    })

    it('once the removal is cleared in dial-skill.json, the next scan writes that engine\'s homes again', () => {
      const other = folder()
      const r = rig()
      r.writer.started()
      r.writer.scanned([ownerIn(other)])
      disable(r)

      // A scan between the removal and enable empties the record.
      r.writer.scanned([ownerIn(other)])
      expect(readSetup(r.dataDir).homes.codex).toEqual([])
      expect(existsSync(skillFile(other))).toBe(false)

      writeRemoved(r.dataDir, 'codex', false)
      r.lines.length = 0
      r.counted.length = 0
      r.writer.scanned([ownerIn(other)])

      expect(hasSkill(r.codexHome)).toBe(true)
      expect(hasSkill(other)).toBe(true)
      expect(sorted(readSetup(r.dataDir).homes.codex)).toEqual(sorted([r.codexHome, other].map(skillsOf)))
      expect(r.lines).toEqual([counts([0, 0], [2, 0])])
      expect(r.counted).toEqual([['codex', 'set up'], ['codex', 'set up']])
    })
  })

  it('an engine disable removed counts left removed once, until dial-skill.json changes', () => {
    const other = folder()
    const r = rig()
    writeRemoved(r.dataDir, 'codex', true)

    r.writer.started()
    r.writer.attached()
    r.writer.scanned([ownerIn(other)])
    r.writer.scanned([ownerIn(other)])
    expect(r.counted).toEqual([['codex', 'left removed']])

    // A second disable writes the file again.
    writeRemoved(r.dataDir, 'codex', true)
    r.writer.scanned([])
    expect(r.counted).toEqual([['codex', 'left removed'], ['codex', 'left removed']])
  })

  /** [count] existing skills folders, each in a home of its own under one throwaway folder. */
  function listedFolders(count: number): string[] {
    const parent = folder()
    return Array.from({ length: count }, (_, i) => {
      mkdirSync(join(parent, `home-${i}`))
      return skillsAt(join(parent, `home-${i}`))
    })
  }

  it('a full record writes no new home, and says so once', () => {
    const dataDir = folder()
    dialOnce(dataDir, { claude: [], codex: listedFolders(MAX_HOMES) })
    const r = rig({ dataDir })
    const fresh = folder()

    r.writer.started()
    r.writer.scanned([ownerIn(fresh)])
    r.writer.scanned([ownerIn(fresh)])

    // Not even an empty skills folder.
    expect(existsSync(join(r.codexHome, 'skills'))).toBe(false)
    expect(existsSync(join(fresh, 'skills'))).toBe(false)
    expect(readSetup(dataDir).homes.codex.length).toBe(MAX_HOMES)
    expect(r.lines.filter((line) => line === 'dial skill: codex list full (64)')).toHaveLength(1)
    // Each try: the default home at the start, the new one at the first scan; the second scan tries nothing.
    expect(r.counted.filter(([, kind]) => kind === 'failed')).toEqual([['codex', 'failed', 'full'], ['codex', 'failed', 'full']])
  })

  it('a skills folder the person deleted makes no room in a full record', () => {
    const dataDir = folder()
    const listed = listedFolders(MAX_HOMES)
    dialOnce(dataDir, { claude: [], codex: listed })
    const r = rig({ dataDir })
    r.writer.started()
    // Its home stays.
    rmSync(listed[5], { recursive: true })
    const fresh = folder()

    r.writer.scanned([ownerIn(fresh)])

    expect(existsSync(join(fresh, 'skills'))).toBe(false)
    expect(existsSync(listed[5])).toBe(false)
    expect(readSetup(dataDir).homes.codex).toEqual(listed)
  })

  it('a refused home costs no file work on the next scan, until dial-skill.json changes', () => {
    const r = rig()
    // No skills folder to be had: a file in its place.
    const noFolder = folder()
    writeFileSync(join(noFolder, 'skills'), 'mine')
    // A write that fails: a dial folder that takes no file.
    const shut = folder()
    mkdirSync(join(skillsAt(shut), 'dial'))
    chmodSync(join(shut, 'skills', 'dial'), 0o500)
    const owners = [ownerIn(noFolder), ownerIn(shut)]
    r.writer.started()
    r.writer.scanned(owners)
    const reads = r.read.removed

    r.writer.scanned(owners)
    expect(r.read.removed).toBe(reads)
    // Each tried once: the default home set up, then the two that could not be written.
    expect(r.counted).toEqual([['codex', 'set up'], ['codex', 'failed', 'write'], ['codex', 'failed', 'write']])

    // enable writes dial-skill.json: each is tried once more.
    chmodSync(join(shut, 'skills', 'dial'), 0o700)
    writeRemoved(r.dataDir, 'codex', false)
    r.writer.scanned(owners)
    expect(hasSkill(shut)).toBe(true)

    // A full record refuses a new home the same way.
    const dataDir = folder()
    dialOnce(dataDir, { claude: [], codex: listedFolders(MAX_HOMES) })
    const full = rig({ dataDir })
    const fresh = folder()
    full.writer.started()
    full.writer.scanned([ownerIn(fresh)])
    const fullReads = full.read.removed
    full.writer.scanned([ownerIn(fresh)])
    expect(full.read.removed).toBe(fullReads)
  })

  it('refused paths give a reason and no path', () => {
    const r = rig({ uid: uid + 1 })
    const [someone, gone] = [folder(), folder()]
    rmSync(gone, { recursive: true })
    const owners = [
      { ...ownerIn(someone), record: join(someone, 'archived_sessions', '2026', '11', '16', 'rollout-a.jsonl') },
      // By its real path, as lsof names it.
      ownerIn(join(realpathSync(r.dataDir), 'codex')),
      // Owned by this test's user, which is not the setup's.
      ownerIn(someone),
      ownerIn(gone),
    ]

    r.writer.started()
    r.writer.scanned(owners)
    r.writer.scanned(owners)

    expect(r.lines).toEqual(['dial skill: path refused (shape)', 'dial skill: path refused (owner)', 'dial skill: path refused (missing)'])
    expect(r.lines.join('\n')).not.toContain('/')
    expect(existsSync(join(someone, 'skills'))).toBe(false)
    expect(existsSync(gone)).toBe(false)
  })

  it('a rollout in the data dir by its real path gives no home', () => {
    // lsof names a file by its real path, and the data dir can be reached through a link (macOS's /var is /private/var).
    const real = folder()
    const dataDir = join(folder(), 'data')
    symlinkSync(real, dataDir)
    dialOnce(dataDir)
    const r = rig({ dataDir })
    const inData = join(realpathSync(real), 'codex')
    mkdirSync(inData)

    r.writer.started()
    r.writer.scanned([ownerIn(inData)])

    expect(existsSync(join(inData, 'skills'))).toBe(false)
    expect(r.lines).toContain('dial skill: path refused (shape)')
  })

  describe('a recorded folder that is gone is dropped at each pass, and nothing is made again', () => {
    it('at the start pass', () => {
      const r = rig()
      const gone = folder()
      // The default home already recorded: the pass records nothing new.
      dialOnce(r.dataDir, { claude: [], codex: [skillsAt(gone), skillsAt(r.codexHome)] })
      rmSync(gone, { recursive: true })

      r.writer.started()

      expect(existsSync(gone)).toBe(false)
      expect(readSetup(r.dataDir).homes.codex).toEqual([skillsOf(r.codexHome)])
    })

    it('at a scan that records a new home', () => {
      const dataDir = folder()
      const listed = listedFolders(MAX_HOMES)
      dialOnce(dataDir, { claude: [], codex: listed })
      const r = rig({ dataDir })
      r.writer.started()
      rmSync(join(listed[5], '..'), { recursive: true })
      const fresh = folder()

      r.writer.scanned([ownerIn(fresh)])

      expect(hasSkill(fresh)).toBe(true)
      expect(existsSync(listed[5])).toBe(false)
      const now = readSetup(dataDir).homes.codex
      expect(now).toHaveLength(MAX_HOMES)
      expect(now).toContain(skillsOf(fresh))
      expect(now).not.toContain(listed[5])
    })
  })

  it('a recorded folder that cannot be looked at now stays recorded, unwritten', () => {
    const r = rig()
    const [shut, gone] = [folder(), folder()]
    const listed = [skillsAt(shut), skillsAt(gone)]
    dialOnce(r.dataDir, { claude: [], codex: listed })
    rmSync(gone, { recursive: true })
    // No search permission on the home: stat of its skills folder fails with EACCES, which says nothing of it being gone.
    chmodSync(shut, 0o600)

    r.writer.started()

    chmodSync(shut, 0o700)
    expect(readSetup(r.dataDir).homes.codex).toEqual([listed[0], skillsOf(r.codexHome)])
    expect(existsSync(join(listed[0], 'dial'))).toBe(false)
  })

  it('a home whose skills folder no record could hold gets no skill', () => {
    // U+0085 is a control character the record refuses: written, the skill would be one a disable never finds.
    const codexHome = join(folder(), 'co\u0085dex')
    mkdirSync(codexHome)
    const r = rig({ codexHome })

    r.writer.started()

    expect(existsSync(join(codexHome, 'skills', 'dial'))).toBe(false)
    expect(readSetup(r.dataDir).homes.codex).toEqual([])
    expect(r.lines).toEqual(['dial skill: path refused (shape)'])
  })

  it('a home whose record cannot be saved keeps no skill', () => {
    const r = rig()
    chmodSync(r.dataDir, 0o500)
    const other = folder()

    r.writer.started()
    r.writer.scanned([ownerIn(other)])

    expect(existsSync(skillFile(r.codexHome))).toBe(false)
    expect(existsSync(skillFile(other))).toBe(false)
    expect(readSetup(r.dataDir)).toEqual({ dial: true, homes: { claude: [], codex: [] } })
  })

  it('a home whose record cannot be saved keeps a skill this pass did not write', () => {
    // The command wrote the default home's at enable, and its own disable finds it.
    const r = rig()
    writeSkill(skillsAt(r.codexHome))
    chmodSync(r.dataDir, 0o500)

    r.writer.started()

    expect(hasSkill(r.codexHome)).toBe(true)
  })

  it('a write, a removal or a record that fails is counted, with no path', () => {
    // A dial folder that takes no file.
    const r = rig()
    mkdirSync(join(skillsAt(r.codexHome), 'dial'))
    chmodSync(join(r.codexHome, 'skills', 'dial'), 0o500)
    r.writer.started()
    expect(r.lines).toEqual([counts([0, 0], [0, 0, 1])])
    expect(r.counted).toEqual([['codex', 'failed', 'write']])

    // Removed, and ours in a recorded folder that lets nothing go.
    const stuck = folder()
    const dataDir = folder()
    writeSkill(skillsAt(stuck))
    chmodSync(join(stuck, 'skills', 'dial'), 0o500)
    dialOnce(dataDir, { claude: [], codex: [skillsOf(stuck)] })
    const off = rig({ dataDir, removed: () => ({ codex: true }) })
    off.writer.started()
    chmodSync(join(stuck, 'skills', 'dial'), 0o700)
    expect(off.lines).toEqual([counts([0, 0], [0, 0, 1])])
    expect(off.counted).toEqual([['codex', 'left removed'], ['codex', 'failed', 'write']])

    // A record that cannot be saved: what was written goes again.
    const unsaved = rig()
    chmodSync(unsaved.dataDir, 0o500)
    unsaved.writer.started()
    expect(unsaved.lines).toEqual([counts([0, 0], [1, 1, 1])])
    expect(unsaved.counted).toEqual([['codex', 'failed', 'save']])

    expect([...r.lines, ...off.lines, ...unsaved.lines].join('\n')).not.toContain('/')
  })

  it('on Windows nothing is written', () => {
    // A dial attached here once: a start and a scan write nothing.
    const other = folder()
    const r = rig({ platform: 'win32' })
    pluginOn(r.claudeHome)

    r.writer.started()
    r.writer.scanned([ownerIn(other)])

    for (const home of [r.claudeHome, r.codexHome, other]) expect(existsSync(join(home, 'skills'))).toBe(false)
    expect(readSetup(r.dataDir).homes).toEqual({ claude: [], codex: [] })
    expect(r.lines).toEqual([])
    expect(r.read.removed).toBe(0)

    // Never one: an attach records nothing.
    const first = rig({ platform: 'win32' }, false)
    first.writer.attached()
    expect(existsSync(join(first.dataDir, DIAL_SETUP_FILE))).toBe(false)
    expect(existsSync(join(first.codexHome, 'skills'))).toBe(false)
  })
})

describe('what the person removed stays removed, and Harness\'s own is kept current', () => {
  it('a recorded home whose skill was deleted is not written again: at a start, an attach and a scan', () => {
    const r = rig()
    const home = folder()
    writeSkill(skillsAt(r.codexHome))
    writeSkill(skillsAt(home))
    const listed = [skillsOf(r.codexHome), skillsOf(home)]
    dialOnce(r.dataDir, { claude: [], codex: listed })
    rmSync(skillFile(home))

    r.writer.started()
    r.writer.attached()
    r.writer.scanned([ownerIn(home)])

    expect(existsSync(skillFile(home))).toBe(false)
    expect(readSetup(r.dataDir).homes.codex).toEqual(listed)
    expect(r.counted).toEqual([['codex', 'left removed']])
    expect(r.lines).toEqual([])
  })

  it('a recorded home whose skills folder was deleted is not made again while its home is there', () => {
    const r = rig()
    const other = folder()
    const listed = [skillsAt(r.codexHome), skillsAt(other)]
    dialOnce(r.dataDir, { claude: [], codex: listed })
    for (const home of [r.codexHome, other]) rmSync(join(home, 'skills'), { recursive: true })

    r.writer.started()
    r.writer.attached()
    r.writer.scanned([ownerIn(other)])

    for (const home of [r.codexHome, other]) expect(existsSync(join(home, 'skills'))).toBe(false)
    expect(readSetup(r.dataDir).homes.codex).toEqual(listed)
    expect(r.counted).toEqual([['codex', 'left removed'], ['codex', 'left removed']])
  })

  it('a recorded folder whose home is gone leaves the record, and that home made again is a new home', () => {
    const r = rig()
    const home = folder()
    writeSkill(skillsAt(home))
    const listed = skillsOf(home)
    dialOnce(r.dataDir, { claude: [], codex: [listed] })
    rmSync(home, { recursive: true })

    r.writer.started()
    expect(readSetup(r.dataDir).homes.codex).toEqual([skillsOf(r.codexHome)])

    mkdirSync(home)
    r.writer.scanned([ownerIn(home)])

    expect(hasSkill(home)).toBe(true)
    expect(readSetup(r.dataDir).homes.codex).toEqual([skillsOf(r.codexHome), listed])
    expect(r.counted).toEqual([['codex', 'set up'], ['codex', 'set up']])
  })

  it('0.6.58\'s file, the old marker line, in a recorded home is written again', () => {
    const r = rig()
    oldSkillIn(skillsAt(r.codexHome))
    dialOnce(r.dataDir, { claude: [], codex: [skillsOf(r.codexHome)] })

    r.writer.started()

    expect(hasSkill(r.codexHome)).toBe(true)
    expect(r.counted).toEqual([['codex', 'updated']])
    expect(r.lines).toEqual([counts([0, 0], [1, 0])])
  })

  it('a new home counts set up; one already holding DIAL_SKILL is recorded and counts nothing', () => {
    const r = rig()
    const holding = folder()
    writeSkill(skillsAt(holding))

    r.writer.started()
    r.writer.scanned([ownerIn(holding)])

    expect(readSetup(r.dataDir).homes.codex).toEqual([skillsOf(r.codexHome), skillsOf(holding)])
    expect(r.counted).toEqual([['codex', 'set up']])
  })

  it('a Codex default home that appears after the start is written at the next scan', () => {
    const r = rig()
    rmSync(r.codexHome, { recursive: true })
    r.writer.started()
    expect(existsSync(r.codexHome)).toBe(false)

    // Codex installed since.
    mkdirSync(r.codexHome)
    r.writer.scanned([])

    expect(hasSkill(r.codexHome)).toBe(true)
    expect(readSetup(r.dataDir).homes.codex).toEqual([skillsOf(r.codexHome)])
    expect(r.counted).toEqual([['codex', 'set up']])
  })

  it('a home that could not be written is tried again no sooner than an hour later', () => {
    const r = rig()
    // A dial folder that takes no file.
    const dial = join(skillsAt(r.codexHome), 'dial')
    mkdirSync(dial)
    chmodSync(dial, 0o500)
    r.writer.started()
    expect(r.counted).toEqual([['codex', 'failed', 'write']])
    chmodSync(dial, 0o700)

    // Its sessions are in the scan too: neither the default home's look nor the owners' tries it before the hour.
    r.clock.at = 3_599_999
    r.writer.scanned([ownerIn(r.codexHome)])
    expect(existsSync(skillFile(r.codexHome))).toBe(false)

    r.clock.at = 3_600_000
    r.writer.scanned([ownerIn(r.codexHome)])
    expect(hasSkill(r.codexHome)).toBe(true)
    expect(r.counted).toEqual([['codex', 'failed', 'write'], ['codex', 'set up']])
  })

  it('a home that could not be written waits out its hour through an attach', () => {
    const r = rig()
    // A dial folder that takes no file.
    const dial = join(skillsAt(r.codexHome), 'dial')
    mkdirSync(dial)
    chmodSync(dial, 0o500)
    r.writer.attached()
    // A replug two minutes later neither tries it nor counts it again.
    r.clock.at = 120_000
    r.writer.attached()
    chmodSync(dial, 0o700)
    expect(r.counted).toEqual([['codex', 'failed', 'write']])

    r.clock.at = 3_600_000
    r.writer.scanned([])
    expect(hasSkill(r.codexHome)).toBe(true)
    expect(r.counted).toEqual([['codex', 'failed', 'write'], ['codex', 'set up']])
  })

  it('a recorded folder whose skill cannot be brought current waits out its hour through an attach', () => {
    const r = rig()
    const listedHome = folder()
    // No default home: the recorded folder is the pass's one write.
    rmSync(r.codexHome, { recursive: true })
    const skills = skillsAt(listedHome)
    oldSkillIn(skills)
    dialOnce(r.dataDir, { claude: [], codex: [skills] })
    // A dial folder that takes no new file.
    chmodSync(join(skills, 'dial'), 0o500)
    r.writer.attached()
    r.clock.at = 120_000
    r.writer.attached()
    chmodSync(join(skills, 'dial'), 0o700)
    expect(r.counted).toEqual([['codex', 'failed', 'write']])

    r.clock.at = 3_600_000
    r.writer.attached()
    expect(hasSkill(listedHome)).toBe(true)
    expect(r.counted).toEqual([['codex', 'failed', 'write'], ['codex', 'updated']])
  })
})

describe('the record the plugin\'s setup reads', () => {
  it('the plugin\'s version is saved beside the dial and the homes, and a home recorded later keeps it', () => {
    const other = folder()
    const r = rig()
    r.writer.started()
    expect(r.writer.plugin()).toBeUndefined()

    expect(r.writer.recordPlugin('0.6.59')).toBe(true)

    expect(r.writer.plugin()).toBe('0.6.59')
    expect(readSetup(r.dataDir)).toEqual({ dial: true, plugin: '0.6.59', homes: { claude: [], codex: [skillsOf(r.codexHome)] } })
    r.writer.scanned([ownerIn(other)])
    expect(readSetup(r.dataDir)).toEqual({ dial: true, plugin: '0.6.59', homes: { claude: [], codex: [skillsOf(r.codexHome), skillsOf(other)] } })

    // The next start reads it back.
    const again = rig({ dataDir: r.dataDir, codexHome: r.codexHome })
    again.writer.started()
    expect(again.writer.plugin()).toBe('0.6.59')

    // Not saved: false, and the version saved stays the one read.
    chmodSync(r.dataDir, 0o500)
    expect(r.writer.recordPlugin('0.6.60')).toBe(false)
    expect(r.writer.plugin()).toBe('0.6.59')
  })

  it('wanted: not before a dial, not after disable', () => {
    const r = rig({}, false)
    r.writer.started()
    expect(r.writer.wanted('codex')).toBe(false)
    expect(r.writer.wanted('claude')).toBe(false)

    r.writer.attached()

    expect(r.writer.wanted('codex')).toBe(true)
    // With no plugin on yet: the plugin's own setup is what is wanted.
    expect(r.writer.wanted('claude')).toBe(true)

    writeRemoved(r.dataDir, 'claude', true)
    expect(r.writer.wanted('claude')).toBe(false)
    expect(r.writer.wanted('codex')).toBe(true)
  })
})
