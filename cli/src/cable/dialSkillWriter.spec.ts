/**
 * The devices' writer of the dial skill, in throwaway homes and a throwaway data folder each: the daemon's own and
 * adopted homes at the service's start, each Codex home the open scan finds a session in, and every copy it wrote taken
 * out again at a moment that reads Off. The person's ~/.claude and ~/.codex are never touched.
 */
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DIAL_PLUGIN_ID, DIAL_SKILL, removeSkill, writeSkill } from '../devices/dialSkill.js'
import { DIAL_SKILL_FILE, DIAL_SKILL_HOMES_FILE, MAX_HOMES, readAnswers, readHomes, writeAnswer, writeHomes, type DialSkillAnswers } from '../devices/dialSkillFiles.js'
import type { RolloutOwner } from './codexRolloutHome.js'
import { createDialSkillWriter, type DialSkillWriterDeps } from './dialSkillWriter.js'

const uid = process.getuid!()

const folders: string[] = []
const held: number[] = []
afterEach(() => {
  for (const fd of held.splice(0)) closeSync(fd)
  for (const dir of folders.splice(0)) {
    // A test made it read-only: open it again so it can be removed.
    if (existsSync(dir)) chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  }
})

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dial-writer-'))
  folders.push(dir)
  return dir
}

const skillFile = (home: string): string => join(home, 'skills', 'dial', 'SKILL.md')
const hasSkill = (home: string): boolean => existsSync(skillFile(home)) && readFileSync(skillFile(home), 'utf8') === DIAL_SKILL
/** A home's skills folder as the writer lists it, through its link. */
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

const sorted = (list: string[]): string[] => [...list].sort()
const counts = (claude: [number, number], codex: [number, number]): string =>
  `dial skill: claude wrote ${claude[0]} removed ${claude[1]}, codex wrote ${codex[0]} removed ${codex[1]}`

/** A writer over throwaway homes; `answers` reads the real dial-skill.json unless the test gives its own. Every call to
 *  it is counted. */
function rig(over: Partial<DialSkillWriterDeps> = {}) {
  const dataDir = over.dataDir ?? folder()
  const answers = over.answers ?? ((): DialSkillAnswers => readAnswers(dataDir))
  const lines: string[] = []
  const read = { answers: 0 }
  const deps: DialSkillWriterDeps = {
    platform: 'darwin',
    uid,
    claudeHome: folder(),
    codexHome: folder(),
    adopted: () => ({ claude: [], codex: [] }),
    log: (line) => lines.push(line),
    ...over,
    dataDir,
    answers: () => {
      read.answers++
      return answers()
    },
  }
  return { ...deps, lines, read, writer: createDialSkillWriter(deps) }
}

describe('the devices write the dial skill', () => {
  it('at start it writes the default, adopted and listed homes of an engine that is On', () => {
    const dataDir = folder()
    const [claudeAdopted, codexAdopted, claudeListed, codexListed] = [folder(), folder(), folder(), folder()]
    writeHomes(dataDir, { claude: [skillsAt(claudeListed)], codex: [skillsAt(codexListed)] })
    writeAnswer(dataDir, 'codex', true)
    const r = rig({ dataDir, adopted: () => ({ claude: [claudeAdopted], codex: [codexAdopted] }) })
    pluginOn(r.claudeHome)

    r.writer.started()

    for (const home of [r.claudeHome, claudeAdopted, claudeListed, r.codexHome, codexAdopted, codexListed]) expect(hasSkill(home)).toBe(true)
    const listed = readHomes(dataDir)
    expect(sorted(listed.claude)).toEqual(sorted([r.claudeHome, claudeAdopted, claudeListed].map(skillsOf)))
    expect(sorted(listed.codex)).toEqual(sorted([r.codexHome, codexAdopted, codexListed].map(skillsOf)))
    expect(r.lines).toEqual([counts([3, 0], [3, 0])])
  })

  it('a default home that is missing is not made: only the command makes one', () => {
    const r = rig({ answers: () => ({ codex: true }) })
    rmSync(r.codexHome, { recursive: true })

    r.writer.started()

    expect(existsSync(r.codexHome)).toBe(false)
    expect(r.lines).toEqual([])
  })

  it('Claude On needs the strict plugin entry', () => {
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
      expect(r.lines).toEqual([])
    }
    // A true entry, but the person turned Claude Code off in Harness Device.
    const off = rig({ answers: () => ({ claude: false }) })
    pluginOn(off.claudeHome)
    off.writer.started()
    expect(existsSync(join(off.claudeHome, 'skills'))).toBe(false)
    // The same entry with no answer is On.
    const on = rig()
    pluginOn(on.claudeHome)
    on.writer.started()
    expect(hasSkill(on.claudeHome)).toBe(true)
  })

  it('Codex with no answer is Off', () => {
    const other = folder()
    const r = rig({ answers: () => ({ claude: true }) })
    r.writer.started()
    r.writer.scanned([ownerIn(other)])
    expect(existsSync(join(r.codexHome, 'skills'))).toBe(false)
    expect(existsSync(join(other, 'skills'))).toBe(false)
    expect(r.lines).toEqual([])
  })

  it('a Codex owner in a new CODEX_HOME gets the skill, and its home is listed', () => {
    const [inTerminal, server] = [folder(), folder()]
    const r = rig({ answers: () => ({ codex: true }) })
    r.writer.started()
    r.lines.length = 0

    // Codex 0.167.1's app-server holds a terminal session's rollout with no terminal of its own.
    r.writer.scanned([ownerIn(inTerminal), ownerIn(server, null)])

    expect(hasSkill(inTerminal)).toBe(true)
    expect(hasSkill(server)).toBe(true)
    expect(sorted(readHomes(r.dataDir).codex)).toEqual(sorted([r.codexHome, inTerminal, server].map(skillsOf)))
    expect(r.lines).toEqual([counts([0, 0], [2, 0])])
  })

  it('a profile linked to another home\'s skills is one write', () => {
    const profile = folder()
    const r = rig({ answers: () => ({ codex: true }), adopted: () => ({ claude: [], codex: [profile] }) })
    const shared = skillsAt(r.codexHome)
    symlinkSync(shared, join(profile, 'skills'))

    r.writer.started()
    r.writer.scanned([ownerIn(profile)])

    expect(hasSkill(profile)).toBe(true)
    expect(readHomes(r.dataDir).codex).toEqual([shared])
    expect(r.lines).toEqual([counts([0, 0], [1, 0])])
  })

  it('Off at a moment removes the listed ones and empties the list', () => {
    // At the start: ours go from each listed folder, a person's stays.
    const [a, b, theirs] = [folder(), folder(), folder()]
    const dataDir = folder()
    const listed = [skillsAt(a), skillsAt(b), skillsAt(theirs)]
    writeSkill(listed[0])
    writeSkill(listed[1])
    mkdirSync(join(listed[2], 'dial'))
    writeFileSync(join(listed[2], 'dial', 'SKILL.md'), '---\nname: dial\n---\nMine.\n')
    writeHomes(dataDir, { claude: [], codex: listed })
    writeAnswer(dataDir, 'codex', false)
    const r = rig({ dataDir })

    r.writer.started()

    expect(existsSync(skillFile(a))).toBe(false)
    expect(existsSync(skillFile(b))).toBe(false)
    expect(readFileSync(skillFile(theirs), 'utf8')).toBe('---\nname: dial\n---\nMine.\n')
    expect(readHomes(dataDir).codex).toEqual([])
    expect(r.lines).toEqual([counts([0, 0], [0, 2])])

    // At a scan: Off, read for a new home, takes out what the start wrote.
    let codex = true
    const later = rig({ answers: () => ({ codex }) })
    later.writer.started()
    expect(hasSkill(later.codexHome)).toBe(true)
    codex = false
    const fresh = folder()
    later.writer.scanned([ownerIn(fresh)])
    expect(existsSync(skillFile(later.codexHome))).toBe(false)
    expect(existsSync(join(fresh, 'skills'))).toBe(false)
    expect(readHomes(later.dataDir).codex).toEqual([])
    expect(later.lines.at(-1)).toBe(counts([0, 0], [0, 1]))
  })

  it('the race: Off set between the write and the recheck removes the new one', () => {
    // The person turns Codex off the moment the skill lands: every read after that says Off.
    let off = false
    const r = rig({
      answers: () => {
        if (existsSync(skillFile(r.codexHome))) off = true
        return { codex: !off }
      },
    })

    r.writer.started()

    expect(existsSync(skillFile(r.codexHome))).toBe(false)
    expect(readHomes(r.dataDir).codex).toEqual([])
    expect(r.lines).toEqual([counts([0, 0], [1, 1])])
  })

  it('a known home costs no file work on the next scan', () => {
    const other = folder()
    const r = rig()
    writeAnswer(r.dataDir, 'codex', true)
    r.writer.started()
    r.writer.scanned([ownerIn(other)])
    expect(hasSkill(other)).toBe(true)
    rmSync(skillFile(other))
    const reads = r.read.answers
    const lines = r.lines.length

    r.writer.scanned([ownerIn(other)])

    expect(existsSync(skillFile(other))).toBe(false)
    expect(r.read.answers).toBe(reads)
    expect(r.lines.length).toBe(lines)
  })

  it('a home is not handled while Off', () => {
    const other = folder()
    let codex = false
    const r = rig({ answers: () => ({ codex }) })
    r.writer.started()
    r.writer.scanned([ownerIn(other)])
    expect(existsSync(join(other, 'skills'))).toBe(false)

    codex = true
    r.writer.scanned([ownerIn(other)])

    expect(hasSkill(other)).toBe(true)
  })

  describe('a changed dial-skill.json runs the start pass again', () => {
    /** Turn off as the command does it: Off saved first, then ours removed from the default home and every listed one. */
    const turnOff = (r: ReturnType<typeof rig>): void => {
      writeAnswer(r.dataDir, 'codex', false)
      for (const skills of [skillsOf(r.codexHome), ...readHomes(r.dataDir).codex]) removeSkill(skills)
    }

    it('Off then On before the next scan writes every home again, and a scan with the file untouched reads it no more', () => {
      const other = folder()
      const r = rig()
      writeAnswer(r.dataDir, 'codex', true)
      // Held open, so the file Turn on writes in the same millisecond cannot take its inode and read as unchanged.
      held.push(openSync(join(r.dataDir, DIAL_SKILL_FILE), 'r'))
      r.writer.started()
      r.writer.scanned([ownerIn(other)])
      turnOff(r)
      writeAnswer(r.dataDir, 'codex', true)
      r.lines.length = 0

      r.writer.scanned([ownerIn(other)])

      expect(hasSkill(r.codexHome)).toBe(true)
      expect(hasSkill(other)).toBe(true)
      expect(r.lines).toEqual([counts([0, 0], [2, 0])])

      const reads = r.read.answers
      r.writer.scanned([ownerIn(other)])
      expect(r.read.answers).toBe(reads)
    })

    it('a scan between Off and On empties the list, and the scan after On writes every home again', () => {
      const other = folder()
      const r = rig()
      writeAnswer(r.dataDir, 'codex', true)
      r.writer.started()
      r.writer.scanned([ownerIn(other)])
      turnOff(r)

      r.writer.scanned([ownerIn(other)])
      expect(readHomes(r.dataDir).codex).toEqual([])
      expect(existsSync(skillFile(other))).toBe(false)

      writeAnswer(r.dataDir, 'codex', true)
      r.lines.length = 0
      r.writer.scanned([ownerIn(other)])

      expect(hasSkill(r.codexHome)).toBe(true)
      expect(hasSkill(other)).toBe(true)
      expect(sorted(readHomes(r.dataDir).codex)).toEqual(sorted([r.codexHome, other].map(skillsOf)))
      expect(r.lines).toEqual([counts([0, 0], [2, 0])])
    })
  })

  /** [count] existing skills folders, each in a home of its own under one throwaway folder. */
  function listedFolders(count: number): string[] {
    const parent = folder()
    return Array.from({ length: count }, (_, i) => {
      mkdirSync(join(parent, `home-${i}`))
      return skillsAt(join(parent, `home-${i}`))
    })
  }

  it('a full list writes no new home, and says so once', () => {
    const dataDir = folder()
    writeHomes(dataDir, { claude: [], codex: listedFolders(MAX_HOMES) })
    const r = rig({ dataDir, answers: () => ({ codex: true }) })
    const fresh = folder()

    r.writer.started()
    r.writer.scanned([ownerIn(fresh)])
    r.writer.scanned([ownerIn(fresh)])

    expect(existsSync(skillFile(r.codexHome))).toBe(false)
    expect(existsSync(skillFile(fresh))).toBe(false)
    expect(readHomes(dataDir).codex.length).toBe(MAX_HOMES)
    expect(r.lines.filter((line) => line === 'dial skill: codex list full (64)')).toHaveLength(1)
  })

  it('refused paths give a reason and no path', () => {
    const r = rig({ answers: () => ({ codex: true }), uid: uid + 1 })
    const [someone, gone] = [folder(), folder()]
    rmSync(gone, { recursive: true })
    const owners = [
      { ...ownerIn(someone), record: join(someone, 'archived_sessions', '2026', '11', '16', 'rollout-a.jsonl') },
      ownerIn(join(r.dataDir, 'codex')),
      // Owned by this test's user, which is not the writer's.
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

  describe('a listed folder that is gone is dropped at each pass, and nothing is made again', () => {
    it('at the start pass', () => {
      const r = rig({ answers: () => ({ codex: true }) })
      const gone = folder()
      // The default home already listed: the pass lists nothing new.
      writeHomes(r.dataDir, { claude: [], codex: [skillsAt(gone), skillsAt(r.codexHome)] })
      rmSync(gone, { recursive: true })

      r.writer.started()

      expect(existsSync(gone)).toBe(false)
      expect(readHomes(r.dataDir).codex).toEqual([skillsOf(r.codexHome)])
    })

    it('at a scan that lists a new home', () => {
      const dataDir = folder()
      const listed = listedFolders(MAX_HOMES)
      writeHomes(dataDir, { claude: [], codex: listed })
      const r = rig({ dataDir, answers: () => ({ codex: true }) })
      r.writer.started()
      rmSync(join(listed[5], '..'), { recursive: true })
      const fresh = folder()

      r.writer.scanned([ownerIn(fresh)])

      expect(hasSkill(fresh)).toBe(true)
      expect(existsSync(listed[5])).toBe(false)
      const now = readHomes(dataDir).codex
      expect(now).toHaveLength(MAX_HOMES)
      expect(now).toContain(skillsOf(fresh))
      expect(now).not.toContain(listed[5])
    })
  })

  it('a listed folder that cannot be looked at now stays listed, unwritten', () => {
    const r = rig({ answers: () => ({ codex: true }) })
    const [shut, gone] = [folder(), folder()]
    const listed = [skillsAt(shut), skillsAt(gone)]
    writeHomes(r.dataDir, { claude: [], codex: listed })
    rmSync(gone, { recursive: true })
    // No search permission on the home: stat of its skills folder fails with EACCES, which says nothing of it being gone.
    chmodSync(shut, 0o600)

    r.writer.started()

    chmodSync(shut, 0o700)
    expect(readHomes(r.dataDir).codex).toEqual([listed[0], skillsOf(r.codexHome)])
    expect(existsSync(join(listed[0], 'dial'))).toBe(false)
  })

  it('a home whose listing cannot be saved keeps no skill', () => {
    const r = rig({ answers: () => ({ codex: true }) })
    chmodSync(r.dataDir, 0o500)
    const other = folder()

    r.writer.started()
    r.writer.scanned([ownerIn(other)])

    expect(existsSync(skillFile(r.codexHome))).toBe(false)
    expect(existsSync(skillFile(other))).toBe(false)
    expect(existsSync(join(r.dataDir, DIAL_SKILL_HOMES_FILE))).toBe(false)
  })

  it('on Windows nothing is written', () => {
    const other = folder()
    const r = rig({ platform: 'win32', answers: () => ({ claude: true, codex: true }) })
    pluginOn(r.claudeHome)

    r.writer.started()
    r.writer.scanned([ownerIn(other)])

    for (const home of [r.claudeHome, r.codexHome, other]) expect(existsSync(join(home, 'skills'))).toBe(false)
    expect(existsSync(join(r.dataDir, DIAL_SKILL_HOMES_FILE))).toBe(false)
    expect(r.lines).toEqual([])
    expect(r.read.answers).toBe(0)
  })
})
