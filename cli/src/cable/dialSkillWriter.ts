// The dial skill in every home an engine's sessions use, written from the devices' own process. The command writes the
// default home at Turn on; this writes the daemon's own and adopted homes as the service starts, and each Codex home the
// open scan finds a session in. Each skills folder it writes is listed in dial-skill-homes.json, so a Turn off finds it,
// and a moment that reads Off takes them out again itself, which catches up on a Turn off a write raced.
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { ownDirectory, removeSkill, skillOn, skillsFolderOf, writeSkill } from '../devices/dialSkill.js'
import { DIAL_SKILL_FILE, MAX_HOMES, listable, readHomes, readWritten, writeHomes, type DialEngine, type DialSkillAnswers, type DialSkillHomes } from '../devices/dialSkillFiles.js'
import { rolloutHome, takesOwner, type RolloutOwner } from './codexRolloutHome.js'

export interface DialSkillWriterDeps {
  dataDir: string
  platform: NodeJS.Platform
  uid: number
  /** The daemon's own homes: dirname(env.CLAUDE_PROJECTS_DIR), env.CODEX_HOME. */
  claudeHome: string
  codexHome: string
  /** The adopted homes, read at each start pass (lib/engineHomes.ts movedEngineHomes). */
  adopted(): { claude: string[]; codex: string[] }
  /** dial-skill.json, read anew at each call. */
  answers(): DialSkillAnswers
  log(line: string): void
}

export interface DialSkillWriter {
  /** The devices service started. */
  started(): void
  /** The open scan read these owners. */
  scanned(owners: Iterable<RolloutOwner>): void
}

type Counts = Record<DialEngine, { wrote: number; removed: number }>
/** What became of one home: written, or found holding a skill (`done`); given none for a reason the next scan would
 *  meet again (`refused`); or the engine read Off and was handled as Off (`off`). */
type Outcome = 'done' | 'refused' | 'off'

const ENGINES: readonly DialEngine[] = ['claude', 'codex']
const OTHER: Record<DialEngine, DialEngine> = { claude: 'codex', codex: 'claude' }

/** Lines a run says once: the refused shape, a full list per engine, and each refused home, so the log stays bounded. */
const MAX_SAID = 2 * MAX_HOMES

export function createDialSkillWriter(deps: DialSkillWriterDeps): DialSkillWriter {
  const answersFile = join(deps.dataDir, DIAL_SKILL_FILE)
  const settingsFile = join(deps.claudeHome, 'settings.json')
  const defaultHome: Record<DialEngine, string> = { claude: deps.claudeHome, codex: deps.codexHome }
  let listed: DialSkillHomes = { claude: [], codex: [] }
  /** Codex homes done while it was On: a scan passes them with a set lookup. Claude Code gets no home from the scan. */
  const handled = new Set<string>()
  /** Codex homes given no skill for a reason the next scan would meet again (no skills folder, a full list, a write
   *  that failed): passed the same way until the stamp changes. */
  const refused = new Set<string>()
  const said = new Set<string>()
  let stamp = ''

  const on = (engine: DialEngine): boolean => skillOn(engine, deps.answers()[engine], settingsFile)

  /** dial-skill.json and Claude Code's settings as of now: a Turn off then a Turn on between two scans, or the plugin
   *  uninstalled through /plugin, is a new stamp, whatever the files hold. */
  const stampNow = (): string => [answersFile, settingsFile].map((file) => {
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

  const save = (): boolean => writeHomes(deps.dataDir, listed) === undefined

  /** The folders [engine]'s skill may be in: its list, the folders the command recorded and its default home's. */
  const foldersOf = (engine: DialEngine): Set<string | null> =>
    new Set([...listed[engine], ...readWritten(deps.dataDir)[engine], skillsFolderOf(defaultHome[engine], false, deps.uid)])

  /** Off: ours goes from every folder it may be in, the ones no list holds too (the command wrote them, and a plugin
   *  uninstalled through /plugin runs no Turn off). Only a listed folder whose removal failed stays listed, so a later
   *  Turn off still finds it. A folder the other engine holds its skill in while On (~/.codex/skills linked to
   *  ~/.claude/skills) only leaves this engine's list. */
  const turnOff = (engine: DialEngine, counts: Counts): void => {
    if (engine === 'codex') handled.clear()
    const shared = on(OTHER[engine]) ? foldersOf(OTHER[engine]) : new Set()
    const failed = new Set<string>()
    for (const skills of foldersOf(engine)) {
      if (skills === null || shared.has(skills)) continue
      const result = removeSkill(skills)
      if (result === 'removed') counts[engine].removed++
      if (result === 'failed') failed.add(skills)
    }
    const kept = listed[engine].filter((skills) => failed.has(skills))
    if (kept.length === listed[engine].length) return
    listed[engine] = kept
    save()
  }

  /** After a write: a Turn off between the read that let it in and the write removed from the folders as they stood,
   *  so what was written is taken out here instead. false: the engine read Off, and was handled as Off. */
  const stillOn = (engine: DialEngine, counts: Counts): boolean => {
    if (on(engine)) return true
    turnOff(engine, counts)
    return false
  }

  /** One existing home. */
  const writeHome = (engine: DialEngine, home: string, counts: Counts): Outcome => {
    // Read before anything is made in the home: while Off a home is not handled, and nothing goes into it.
    if (!on(engine)) {
      turnOff(engine, counts)
      return 'off'
    }
    const skills = skillsFolderOf(home, true, deps.uid)
    if (!skills) return 'refused'
    // Through its link the folder can be one no list holds: written, it would be one a Turn off never finds.
    if (!listable(skills)) {
      sayOnce('shape', 'dial skill: path refused (shape)')
      return 'refused'
    }
    // Homes linked to one skills folder (an Orca profile's) are one write, listed once.
    if (listed[engine].includes(skills)) {
      const result = writeSkill(skills)
      if (result === 'written') counts[engine].wrote++
      if (result === 'failed') return 'refused'
      return result === 'written' && !stillOn(engine, counts) ? 'off' : 'done'
    }
    // A throwaway home that is gone makes room first; a list still full writes nothing, so every file Harness wrote
    // stays in it.
    listed[engine] = listed[engine].filter((folder) => ownDirectory(folder, deps.uid) !== 'missing')
    if (listed[engine].length >= MAX_HOMES) {
      sayOnce(`full ${engine}`, `dial skill: ${engine} list full (${MAX_HOMES})`)
      return 'refused'
    }
    const result = writeSkill(skills)
    if (result === 'written') counts[engine].wrote++
    if (result === 'failed') return 'refused'
    if (result === 'theirs') return 'done'
    listed[engine].push(skills)
    if (!save()) {
      listed[engine].pop()
      // Unlisted, a Turn off would never find what this wrote. One already there may be the command's, which its own
      // Turn off finds.
      if (result === 'written' && removeSkill(skills) === 'removed') counts[engine].removed++
      return 'refused'
    }
    return stillOn(engine, counts) ? 'done' : 'off'
  }

  const startPass = (counts: Counts): void => {
    listed = readHomes(deps.dataDir)
    const adopted = deps.adopted()
    for (const engine of ENGINES) {
      if (!on(engine)) {
        turnOff(engine, counts)
        continue
      }
      // A listed folder that no longer exists is dropped, never made again; one that cannot be looked at now stays,
      // unwritten.
      let wrote = false
      const kept = listed[engine].filter((skills) => {
        const state = ownDirectory(skills, deps.uid)
        if (state === 'ok' && writeSkill(skills) === 'written') {
          counts[engine].wrote++
          wrote = true
        }
        return state !== 'missing'
      })
      if (kept.length !== listed[engine].length) {
        listed[engine] = kept
        save()
      }
      if (wrote && !stillOn(engine, counts)) continue
      // Only the command makes a default home that is missing.
      for (const home of [defaultHome[engine], ...adopted[engine]]) {
        if (ownDirectory(home, deps.uid) === 'ok' && writeHome(engine, home, counts) === 'off') break
      }
    }
  }

  const report = (counts: Counts): void => {
    if (!ENGINES.some((engine) => counts[engine].wrote || counts[engine].removed)) return
    deps.log(`dial skill: ${ENGINES.map((engine) => `${engine} wrote ${counts[engine].wrote} removed ${counts[engine].removed}`).join(', ')}`)
  }

  const zero = (): Counts => ({ claude: { wrote: 0, removed: 0 }, codex: { wrote: 0, removed: 0 } })

  return {
    started() {
      // The devices listener, which `harness device notify` rings, does not exist on Windows: a skill there would name
      // a command that cannot ring.
      if (deps.platform === 'win32') return
      const counts = zero()
      // Taken before On is read, so a Turn off after it is a changed file at the next scan.
      stamp = stampNow()
      startPass(counts)
      report(counts)
    },

    scanned(owners) {
      if (deps.platform === 'win32') return
      const counts = zero()
      const now = stampNow()
      if (now !== stamp) {
        // Turned off or on since: every home is written again, or taken out, without a restart.
        stamp = now
        handled.clear()
        refused.clear()
        startPass(counts)
      }
      // Codex only: Claude Code's sessions are read only under the default and adopted homes, written at the start.
      for (const owner of owners) {
        if (!takesOwner(owner)) continue
        const home = rolloutHome(owner.record, deps.dataDir)
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
  }
}
