// The dial skill in every home an engine's sessions use, written from the devices' own process. The command writes the
// default home at Turn on; this writes the daemon's own and adopted homes as the service starts, and each Codex home the
// open scan finds a session in. Each skills folder it writes is listed in dial-skill-homes.json, so a Turn off finds it,
// and a moment that reads Off takes them out again itself, which catches up on a Turn off a write raced.
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { claudePluginState, ownDirectory, removeSkill, skillsFolderOf, writeSkill } from '../devices/dialSkill.js'
import { DIAL_SKILL_FILE, MAX_HOMES, readHomes, writeHomes, type DialEngine, type DialSkillAnswers, type DialSkillHomes } from '../devices/dialSkillFiles.js'
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

const ENGINES: readonly DialEngine[] = ['claude', 'codex']

/** Lines a run says once: the refused shape, a full list per engine, and each refused home, so the log stays bounded. */
const MAX_SAID = 2 * MAX_HOMES

export function createDialSkillWriter(deps: DialSkillWriterDeps): DialSkillWriter {
  const answersFile = join(deps.dataDir, DIAL_SKILL_FILE)
  const defaultHome: Record<DialEngine, string> = { claude: deps.claudeHome, codex: deps.codexHome }
  let listed: DialSkillHomes = { claude: [], codex: [] }
  /** Homes written, found ours or found the person's while the engine was On: a scan passes them with a set lookup. */
  const handled: Record<DialEngine, Set<string>> = { claude: new Set(), codex: new Set() }
  const said = new Set<string>()
  let stamp = ''

  const on = (engine: DialEngine): boolean => {
    const answer = deps.answers()[engine]
    // Claude Code's own record is read too, so a plugin turned on before this file existed brings the skill, and one
    // uninstalled through /plugin takes it away.
    return engine === 'codex' ? answer === true : answer !== false && claudePluginState(join(deps.claudeHome, 'settings.json')) === 'on'
  }

  /** dial-skill.json as of now: a Turn off then a Turn on between two scans is a new file, whatever it holds. */
  const stampNow = (): string => {
    try {
      const info = statSync(answersFile)
      return `${info.ino} ${info.size} ${info.mtimeMs}`
    } catch {
      return 'missing'
    }
  }

  const sayOnce = (key: string, line: string): void => {
    if (said.has(key) || said.size >= MAX_SAID) return
    said.add(key)
    deps.log(line)
  }

  const save = (): boolean => writeHomes(deps.dataDir, listed) === undefined

  const handle = (engine: DialEngine, home: string): void => {
    if (handled[engine].size < MAX_HOMES) handled[engine].add(home)
  }

  /** Off: ours goes from every listed folder, and only a folder whose removal failed stays listed, so a later Turn
   *  off still finds it. */
  const turnOff = (engine: DialEngine, counts: Counts): void => {
    handled[engine].clear()
    if (!listed[engine].length) return
    listed[engine] = listed[engine].filter((skills) => {
      const result = removeSkill(skills)
      if (result === 'removed') counts[engine].removed++
      return result === 'failed'
    })
    save()
  }

  /** One existing home. false: the engine read Off, and was handled as Off. */
  const writeHome = (engine: DialEngine, home: string, counts: Counts): boolean => {
    // Read before anything is made in the home: while Off a home is not handled, and nothing goes into it.
    if (!on(engine)) {
      turnOff(engine, counts)
      return false
    }
    const skills = skillsFolderOf(home, true, deps.uid)
    if (!skills) return true
    // Homes linked to one skills folder (an Orca profile's) are one write, listed once.
    if (listed[engine].includes(skills)) {
      const result = writeSkill(skills)
      if (result === 'written') counts[engine].wrote++
      if (result !== 'failed') handle(engine, home)
      return true
    }
    // A throwaway home that is gone makes room first; a list still full writes nothing, so every file Harness wrote
    // stays in it.
    listed[engine] = listed[engine].filter((folder) => ownDirectory(folder, deps.uid) !== 'missing')
    if (listed[engine].length >= MAX_HOMES) {
      sayOnce(`full ${engine}`, `dial skill: ${engine} list full (${MAX_HOMES})`)
      return true
    }
    const result = writeSkill(skills)
    if (result === 'written') counts[engine].wrote++
    if (result === 'failed') return true
    handle(engine, home)
    if (result === 'theirs') return true
    listed[engine].push(skills)
    if (!save()) {
      // Unlisted, a Turn off would never find it.
      listed[engine].pop()
      if (removeSkill(skills) === 'removed') counts[engine].removed++
      return true
    }
    // A Turn off between the read that let this write in and the listing removed from the list as it stood: this one
    // is taken out here instead.
    if (on(engine)) return true
    turnOff(engine, counts)
    return false
  }

  const startPass = (counts: Counts): void => {
    listed = readHomes(deps.dataDir)
    const adopted = deps.adopted()
    for (const engine of ENGINES) {
      if (!on(engine)) {
        turnOff(engine, counts)
        continue
      }
      // A listed folder that no longer exists is dropped, never made again.
      const kept = listed[engine].filter((skills) => {
        const state = ownDirectory(skills, deps.uid)
        if (state === 'ok' && writeSkill(skills) === 'written') counts[engine].wrote++
        return state !== 'missing'
      })
      if (kept.length !== listed[engine].length) {
        listed[engine] = kept
        save()
      }
      // Only the command makes a default home that is missing.
      for (const home of [defaultHome[engine], ...adopted[engine]]) {
        if (ownDirectory(home, deps.uid) === 'ok' && !writeHome(engine, home, counts)) break
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
        for (const engine of ENGINES) handled[engine].clear()
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
        if (handled.codex.has(home) || handled.codex.size >= MAX_HOMES) continue
        const state = ownDirectory(home, deps.uid)
        if (state !== 'ok') {
          sayOnce(home, `dial skill: path refused (${state})`)
          continue
        }
        if (!writeHome('codex', home, counts)) break
      }
      report(counts)
    },
  }
}
