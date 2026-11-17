// The dial skill in every home an engine's sessions use, set up from the devices' own process once a dial has attached
// on this computer: before that no home is looked at. It writes the daemon's own and adopted homes at the service's
// start and at each attach, and each Codex home the open scan finds a session in. Each skills folder it writes is in
// dial-setup.json, its own record, so a `disable` finds it, and a moment that reads the engine removed takes them out
// again itself, which catches up on a `disable` a write raced.
import { realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ownDirectory, removeSkill, skillsFolderOf, skillWanted, writeSkill } from '../devices/dialSkill.js'
import { DIAL_SKILL_FILE, MAX_HOMES, listable, readSetup, readWritten, writeSetup, type DialEngine, type DialRemoved, type DialSetupRecord } from '../devices/dialSkillFiles.js'
import { rolloutHome, takesOwner, type RolloutOwner } from './codexRolloutHome.js'

export interface DialHomeSetupDeps {
  dataDir: string
  platform: NodeJS.Platform
  uid: number
  /** The daemon's own homes: dirname(env.CLAUDE_PROJECTS_DIR), env.CODEX_HOME. */
  claudeHome: string
  codexHome: string
  /** The adopted homes, read at each start pass (lib/engineHomes.ts movedEngineHomes). */
  adopted(): { claude: string[]; codex: string[] }
  /** dial-skill.json's removals, read anew at each call. */
  removed(): DialRemoved
  log(line: string): void
}

export interface DialHomeSetup {
  /** The devices service started. */
  started(): void
  /** The first dial of the fleet attached. */
  attached(): void
  /** The open scan read these owners. */
  scanned(owners: Iterable<RolloutOwner>): void
  /** A dial attached here once, and `disable` has not removed [engine]. */
  wanted(engine: DialEngine): boolean
  /** The CLI version that last set the plugin up or brought it current; undefined: never on this computer. */
  plugin(): string | undefined
  /** false when the record could not be saved. */
  recordPlugin(version: string): boolean
}

type Counts = Record<DialEngine, { wrote: number; removed: number; failed: number }>
/** What became of one home: written, or found holding a skill (`done`); given none for a reason the next scan would
 *  meet again (`refused`); or the engine read removed and was handled as off (`off`). */
type Outcome = 'done' | 'refused' | 'off'

const ENGINES: readonly DialEngine[] = ['claude', 'codex']
const OTHER: Record<DialEngine, DialEngine> = { claude: 'codex', codex: 'claude' }

/** Lines a run says once: the refused shape, a full list per engine, and each refused home, so the log stays bounded. */
const MAX_SAID = 2 * MAX_HOMES

export function createDialHomeSetup(deps: DialHomeSetupDeps): DialHomeSetup {
  const removedFile = join(deps.dataDir, DIAL_SKILL_FILE)
  const settingsFile = join(deps.claudeHome, 'settings.json')
  // lsof names a rollout by its real path, so the data dir is too: it can be reached through a link (macOS's /var is
  // /private/var).
  const realDataDir = realOr(deps.dataDir)
  const defaultHome: Record<DialEngine, string> = { claude: deps.claudeHome, codex: deps.codexHome }
  // The devices process is the record's one writer: it is read at the start and at an attach, and saved whole.
  let record: DialSetupRecord = { dial: false, homes: { claude: [], codex: [] } }
  /** Codex homes done while it was on: a scan passes them with a set lookup. Claude Code gets no home from the scan. */
  const handled = new Set<string>()
  /** Codex homes given no skill for a reason the next scan would meet again (no skills folder, a full list, a write
   *  that failed): passed the same way until the stamp changes. */
  const refused = new Set<string>()
  const said = new Set<string>()
  let stamp = ''

  /** Read only once a dial is recorded: a pass never runs before. */
  const on = (engine: DialEngine): boolean => skillWanted(engine, deps.removed()[engine] === true, settingsFile)

  /** dial-skill.json and Claude Code's settings as of now: a removal then enable between two scans, or the plugin
   *  uninstalled through /plugin, is a new stamp, whatever the files hold. */
  const stampNow = (): string => [removedFile, settingsFile].map((file) => {
    try {
      const info = statSync(file)
      return `${info.ino} ${info.size} ${info.mtimeMs}`
    } catch {
      return 'missing'
    }
  }).join(' ')

  const sayOnce = (key: string, line: string): void => {
    if (said.has(key) || said.size >= MAX_SAID) return
    said.add(key)
    deps.log(line)
  }

  /** One file's result, in the pass's counts. */
  const tally = (counts: Counts, engine: DialEngine, result: string): void => {
    if (result === 'written') counts[engine].wrote++
    else if (result === 'removed') counts[engine].removed++
    else if (result === 'failed') counts[engine].failed++
  }

  /** The whole record, so the dial and the plugin's version stay beside the homes. */
  const save = (counts: Counts, engine: DialEngine): boolean => {
    if (writeSetup(deps.dataDir, record) === undefined) return true
    counts[engine].failed++
    return false
  }

  /** The folders [engine]'s skill may be in: its record, the folders the command recorded and its default home's. */
  const foldersOf = (engine: DialEngine): Set<string | null> =>
    new Set([...record.homes[engine], ...readWritten(deps.dataDir)[engine], skillsFolderOf(defaultHome[engine], false, deps.uid)])

  /** Off: ours goes from every folder it may be in, the ones no record of this service holds too (the command wrote
   *  them, and a plugin uninstalled through /plugin runs no disable). Only a recorded folder whose removal failed stays
   *  recorded, so a later disable still finds it. A folder the other engine holds its skill in while on
   *  (~/.codex/skills linked to ~/.claude/skills) only leaves this engine's record. */
  const turnOff = (engine: DialEngine, counts: Counts): void => {
    if (engine === 'codex') handled.clear()
    const shared = on(OTHER[engine]) ? foldersOf(OTHER[engine]) : new Set()
    const failed = new Set<string>()
    for (const skills of foldersOf(engine)) {
      if (skills === null || shared.has(skills)) continue
      const result = removeSkill(skills)
      tally(counts, engine, result)
      if (result === 'failed') failed.add(skills)
    }
    const kept = record.homes[engine].filter((skills) => failed.has(skills))
    if (kept.length === record.homes[engine].length) return
    record.homes[engine] = kept
    save(counts, engine)
  }

  /** After a write: a disable between the read that let it in and the write removed from the folders as they stood,
   *  so what was written is taken out here instead. false: the engine read removed, and was handled as off. */
  const stillOn = (engine: DialEngine, counts: Counts): boolean => {
    if (on(engine)) return true
    turnOff(engine, counts)
    return false
  }

  /** One existing home. */
  const writeHome = (engine: DialEngine, home: string, counts: Counts): Outcome => {
    // Read before anything is made in the home: while off a home is not handled, and nothing goes into it.
    if (!on(engine)) {
      turnOff(engine, counts)
      return 'off'
    }
    const listed = record.homes[engine]
    const found = skillsFolderOf(home, false, deps.uid)
    // Homes linked to one skills folder (an Orca profile's) are one write, recorded once.
    if (found !== null && listed.includes(found)) {
      const result = writeSkill(found)
      tally(counts, engine, result)
      if (result === 'failed') return 'refused'
      return result === 'written' && !stillOn(engine, counts) ? 'off' : 'done'
    }
    // A throwaway home that is gone makes room first; a record still full writes nothing, so every file Harness wrote
    // stays in it.
    record.homes[engine] = listed.filter((folder) => ownDirectory(folder, deps.uid) !== 'missing')
    if (record.homes[engine].length >= MAX_HOMES) {
      sayOnce(`full ${engine}`, `dial skill: ${engine} list full (${MAX_HOMES})`)
      return 'refused'
    }
    // Made only now: a home the record has no room for gets no empty folder either.
    const skills = found ?? skillsFolderOf(home, true, deps.uid)
    if (!skills) return 'refused'
    // Through its link the folder can be one no record holds: written, it would be one a disable never finds.
    if (!listable(skills)) {
      sayOnce('shape', 'dial skill: path refused (shape)')
      return 'refused'
    }
    const result = writeSkill(skills)
    tally(counts, engine, result)
    if (result === 'failed') return 'refused'
    if (result === 'theirs') return 'done'
    record.homes[engine].push(skills)
    if (!save(counts, engine)) {
      record.homes[engine].pop()
      // Unrecorded, a disable would never find what this wrote. One already there may be the command's, which its own
      // disable finds.
      if (result === 'written') tally(counts, engine, removeSkill(skills))
      return 'refused'
    }
    return stillOn(engine, counts) ? 'done' : 'off'
  }

  /** Every home read anew: at the start, at an attach, and at a scan that finds the stamp changed. */
  const startPass = (counts: Counts): void => {
    // Taken before on is read, so a disable after it is a changed file at the next scan.
    stamp = stampNow()
    handled.clear()
    refused.clear()
    const adopted = deps.adopted()
    for (const engine of ENGINES) {
      if (!on(engine)) {
        turnOff(engine, counts)
        continue
      }
      // A recorded folder that no longer exists is dropped, never made again; one that cannot be looked at now stays,
      // unwritten.
      let wrote = false
      const kept = record.homes[engine].filter((skills) => {
        const state = ownDirectory(skills, deps.uid)
        if (state !== 'ok') return state !== 'missing'
        const result = writeSkill(skills)
        tally(counts, engine, result)
        wrote ||= result === 'written'
        return true
      })
      if (kept.length !== record.homes[engine].length) {
        record.homes[engine] = kept
        save(counts, engine)
      }
      if (wrote && !stillOn(engine, counts)) continue
      // Only the command makes a default home that is missing.
      for (const home of [defaultHome[engine], ...adopted[engine]]) {
        if (ownDirectory(home, deps.uid) === 'ok' && writeHome(engine, home, counts) === 'off') break
      }
    }
  }

  const report = (counts: Counts): void => {
    if (!ENGINES.some((engine) => counts[engine].wrote || counts[engine].removed || counts[engine].failed)) return
    deps.log(`dial skill: ${ENGINES.map((engine) => {
      const { wrote, removed, failed } = counts[engine]
      return `${engine} wrote ${wrote} removed ${removed} failed ${failed}`
    }).join(', ')}`)
  }

  const zero = (): Counts => ({ claude: { wrote: 0, removed: 0, failed: 0 }, codex: { wrote: 0, removed: 0, failed: 0 } })

  const pass = (): void => {
    const counts = zero()
    startPass(counts)
    report(counts)
  }

  return {
    started() {
      // The devices listener, which `harness device notify` rings, does not exist on Windows: a skill there would name
      // a command that cannot ring.
      if (deps.platform === 'win32') return
      record = readSetup(deps.dataDir)
      if (record.dial) pass()
    },

    attached() {
      if (deps.platform === 'win32') return
      record = readSetup(deps.dataDir)
      if (!record.dial) {
        // Saved before any home is touched: a home is written only on a computer that has had a dial.
        const next = { ...record, dial: true }
        if (writeSetup(deps.dataDir, next) !== undefined) {
          deps.log('dial setup: record not saved')
          return
        }
        record = next
      }
      pass()
    },

    scanned(owners) {
      if (deps.platform === 'win32' || !record.dial) return
      const counts = zero()
      // A removal or enable since, or the plugin turned on or off: every home is written again, or taken out, without
      // a restart.
      if (stampNow() !== stamp) startPass(counts)
      // Codex only: Claude Code's sessions are read only under the default and adopted homes, written at the start.
      for (const owner of owners) {
        if (!takesOwner(owner)) continue
        const home = rolloutHome(owner.record, realDataDir)
        if (home === null) {
          sayOnce('shape', 'dial skill: path refused (shape)')
          continue
        }
        if (handled.has(home) || refused.has(home) || handled.size >= MAX_HOMES) continue
        const state = ownDirectory(home, deps.uid)
        if (state !== 'ok') {
          sayOnce(home, `dial skill: path refused (${state})`)
          continue
        }
        const outcome = writeHome('codex', home, counts)
        if (outcome === 'off') break
        if (outcome === 'done') handled.add(home)
        else if (refused.size < MAX_HOMES) refused.add(home)
      }
      report(counts)
    },

    wanted: (engine) => record.dial && deps.removed()[engine] !== true,

    plugin: () => record.plugin,

    recordPlugin(version) {
      const next = { ...record, plugin: version }
      if (writeSetup(deps.dataDir, next) !== undefined) return false
      record = next
      return true
    },
  }
}

/** [path] through its links, or as it is when it cannot be resolved. */
function realOr(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
