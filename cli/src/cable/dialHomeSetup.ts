// The dial skill in every home an engine's sessions use, set up from the devices' own process once a dial has attached
// on this computer: before that no home is looked at. It writes the daemon's own and adopted homes at the service's
// start and at each attach, a default home made since at the next scan, and each Codex home the open scan finds a
// session in. Each skills folder it writes is in dial-setup.json, its own record, so a `disable` finds it, and a moment
// that reads the engine removed takes them out again itself, which catches up on a `disable` a write raced. A recorded
// folder is written once: after that only Harness's own file is brought current, and one the person removed stays so.
import { realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { claudePluginState, ownDirectory, refreshSkill, removeSkill, skillsFolderOf, writeSkill } from '../devices/dialSkill.js'
import { DIAL_SKILL_FILE, MAX_HOMES, listable, readSetup, readWritten, writeSetup, type DialEngine, type DialRemoved, type DialSetupRecord, type SetupCount } from '../devices/dialSkillFiles.js'
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
  /** A monotonic clock in ms. */
  now(): number
  /** One event in the day's tally; [reason] a fixed word, never a path. */
  count(engine: DialEngine, kind: SetupCount, reason?: string): void
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
/** What became of one home: written, found holding a skill, or left as the person made it (`done`); given none for a
 *  reason the next try would meet again (`refused`); or the engine read removed and was handled as off (`off`). */
type Outcome = 'done' | 'refused' | 'off'

const ENGINES: readonly DialEngine[] = ['claude', 'codex']
const OTHER: Record<DialEngine, DialEngine> = { claude: 'codex', codex: 'claude' }

/** Lines a run says once: the refused shape, a full list per engine, and each refused home, so the log stays bounded. */
const MAX_SAID = 2 * MAX_HOMES
/** A home that could not be written waits this long before a scan tries it again. */
const RETRY_MS = 3_600_000

export function createDialHomeSetup(deps: DialHomeSetupDeps): DialHomeSetup {
  const removedFile = join(deps.dataDir, DIAL_SKILL_FILE)
  const settingsFile = join(deps.claudeHome, 'settings.json')
  // lsof names a rollout by its real path, so the data dir is too: it can be reached through a link (macOS's /var is
  // /private/var).
  const realDataDir = realOr(deps.dataDir)
  const defaultHome: Record<DialEngine, string> = { claude: deps.claudeHome, codex: deps.codexHome }
  // The devices process is the record's one writer: it is read at the start and at an attach, and saved whole.
  let record: DialSetupRecord = { dial: false, homes: { claude: [], codex: [] } }
  /** Homes done while their engine was on: a scan passes them with a set lookup. */
  const handled: Record<DialEngine, Set<string>> = { claude: new Set(), codex: new Set() }
  /** Homes, and recorded folders, given no skill for a reason the next try would meet again (no skills folder, a full
   *  list, a write that failed), each with when: passed the same way, through a start or an attach too, until its own
   *  hour is up or an engine is turned off or on. */
  const refused = new Map<string, number>()
  /** Whether each engine was on at the last start pass. */
  let onBefore = ''
  /** Engines on at the last pass: a scan looks at their default home, and Codex's at its sessions' homes, without
   *  reading whether they still are, which only a changed stamp can change. */
  const onAtPass = new Set<DialEngine>()
  /** Recorded folders counted left removed in this run, by engine. */
  const leftCounted = new Set<string>()
  /** dial-skill.json as it was when each engine's removal was counted. */
  const removalCounted: Partial<Record<DialEngine, string>> = {}
  const said = new Set<string>()
  let stamp = ''

  /** Claude Code's plugin as last read: settings that say nothing (half written, edited by hand) change nothing, so a
   *  moment's bad file does not take the skill out. Off until a read says on. */
  let pluginOn = false

  /** Read only once a dial is recorded: a pass never runs before. */
  const on = (engine: DialEngine): boolean => {
    if (deps.removed()[engine] === true) return false
    if (engine === 'codex') return true
    const state = claudePluginState(settingsFile)
    if (state !== 'unknown') pluginOn = state === 'on'
    return pluginOn
  }

  /** A file's inode, size and time, so a rewrite is a new stamp whatever it holds. */
  const stampOf = (file: string): string => {
    try {
      const info = statSync(file)
      return `${info.ino} ${info.size} ${info.mtimeMs}`
    } catch {
      return 'missing'
    }
  }

  /** dial-skill.json and Claude Code's settings as of now: a removal then enable between two scans, or the plugin
   *  uninstalled through /plugin, is a new stamp. */
  const stampNow = (): string => `${stampOf(removedFile)} ${stampOf(settingsFile)}`

  const sayOnce = (key: string, line: string): void => {
    if (said.has(key) || said.size >= MAX_SAID) return
    said.add(key)
    deps.log(line)
  }

  /** A recorded folder the person emptied, counted once a run: every pass after leaves it so. */
  const leftRemoved = (engine: DialEngine, skills: string): void => {
    const key = `${engine} ${skills}`
    if (leftCounted.has(key) || leftCounted.size >= MAX_SAID) return
    leftCounted.add(key)
    deps.count(engine, 'left removed')
  }

  /** One file's result, in the pass's line and the day's tally. */
  const tally = (counts: Counts, engine: DialEngine, result: string): void => {
    if (result === 'written' || result === 'updated') counts[engine].wrote++
    else if (result === 'removed') counts[engine].removed++
    else if (result === 'failed') {
      counts[engine].failed++
      deps.count(engine, 'failed', 'write')
    }
    if (result === 'updated') deps.count(engine, 'updated')
  }

  /** The whole record, so the dial and the plugin's version stay beside the homes. */
  const save = (counts: Counts, engine: DialEngine): boolean => {
    if (writeSetup(deps.dataDir, record) === undefined) return true
    counts[engine].failed++
    deps.count(engine, 'failed', 'save')
    return false
  }

  /** Refused within its own hour; one whose hour is up leaves, and is tried again. */
  const isRefused = (key: string): boolean => {
    const at = refused.get(key)
    if (at === undefined) return false
    if (deps.now() - at < RETRY_MS) return true
    refused.delete(key)
    return false
  }

  /** A home is passed by the scans after while it is done, or refused until its hour is up. A full refused list makes
   *  room from the ones whose hour is up. */
  const settle = (engine: DialEngine, home: string, outcome: 'done' | 'refused'): void => {
    if (outcome === 'done') {
      if (handled[engine].size < MAX_HOMES) handled[engine].add(home)
      return
    }
    if (refused.size >= MAX_HOMES) for (const key of [...refused.keys()]) isRefused(key)
    if (refused.size < MAX_HOMES) refused.set(home, deps.now())
  }

  /** A recorded folder leaves the record only with its home, a throwaway one that is gone: a skills folder the person
   *  deleted in a home still there stays, so it is not made again. */
  const homeGone = (skills: string, state = ownDirectory(skills, deps.uid)): boolean =>
    state === 'missing' && ownDirectory(dirname(skills), deps.uid) === 'missing'

  /** The folders [engine]'s skill may be in: its record, the folders the command recorded and its default home's. */
  const foldersOf = (engine: DialEngine): Set<string | null> =>
    new Set([...record.homes[engine], ...readWritten(deps.dataDir)[engine], skillsFolderOf(defaultHome[engine], false, deps.uid)])

  /** Off: ours goes from every folder it may be in, the ones no record of this service holds too (the command wrote
   *  them, and a plugin uninstalled through /plugin runs no disable). After a disable only a recorded folder whose
   *  removal failed stays recorded, so a later disable still finds it. With the plugin off only what Harness took out
   *  leaves the record: a skill the person had deleted stays deleted once the plugin is back. A folder the other engine
   *  holds its skill in while on (~/.codex/skills linked to ~/.claude/skills) keeps it, and a disable only takes it from
   *  this engine's record. */
  const turnOff = (engine: DialEngine, counts: Counts): void => {
    onAtPass.delete(engine)
    handled[engine].clear()
    const removal = deps.removed()[engine] === true
    if (removal) {
      // Once a removal: another disable writes dial-skill.json again.
      const at = stampOf(removedFile)
      if (removalCounted[engine] !== at) {
        removalCounted[engine] = at
        deps.count(engine, 'left removed')
      }
    }
    const shared = on(OTHER[engine]) ? foldersOf(OTHER[engine]) : new Set()
    const results = new Map<string, string>()
    for (const skills of foldersOf(engine)) {
      if (skills === null || shared.has(skills)) continue
      const result = removeSkill(skills)
      tally(counts, engine, result)
      results.set(skills, result)
    }
    const kept = record.homes[engine].filter((skills) =>
      removal ? results.get(skills) === 'failed' : results.get(skills) !== 'removed')
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
    // Homes linked to one skills folder (an Orca profile's) are one write, recorded once. Recorded, it is only brought
    // current: a skill the person deleted stays deleted.
    if (found !== null && listed.includes(found)) {
      // Refused at the pass's look at the record: not tried again before its hour.
      if (isRefused(found)) return 'refused'
      const result = refreshSkill(found)
      tally(counts, engine, result)
      if (result === 'gone') leftRemoved(engine, found)
      if (result === 'failed') return 'refused'
      return result === 'updated' && !stillOn(engine, counts) ? 'off' : 'done'
    }
    // The person deleted the recorded skills folder itself: it is not made again.
    const deleted = found === null ? join(realOr(home), 'skills') : null
    if (deleted !== null && listed.includes(deleted)) {
      leftRemoved(engine, deleted)
      return 'done'
    }
    // A throwaway home that is gone makes room first; a record still full writes nothing, so every file Harness wrote
    // stays in it.
    record.homes[engine] = listed.filter((folder) => !homeGone(folder))
    if (record.homes[engine].length >= MAX_HOMES) {
      sayOnce(`full ${engine}`, `dial skill: ${engine} list full (${MAX_HOMES})`)
      deps.count(engine, 'failed', 'full')
      return 'refused'
    }
    // Made only now: a home the record has no room for gets no empty folder either.
    const skills = found ?? skillsFolderOf(home, true, deps.uid)
    if (!skills) {
      deps.count(engine, 'failed', 'write')
      return 'refused'
    }
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
    if (result === 'written') deps.count(engine, 'set up')
    return stillOn(engine, counts) ? 'done' : 'off'
  }

  /** Every home read anew: at the start, at an attach, and at a scan that finds the stamp changed. */
  const startPass = (counts: Counts): void => {
    // Taken before on is read, so a disable after it is a changed file at the next scan.
    stamp = stampNow()
    const wanted = { claude: on('claude'), codex: on('codex') }
    // A replug, or Claude Code saving another setting, does not try a refused home again before its hour; a removal, an
    // enable or the plugin turned on or off does.
    const onNow = `${wanted.claude} ${wanted.codex}`
    if (onNow !== onBefore) refused.clear()
    onBefore = onNow
    for (const engine of ENGINES) handled[engine].clear()
    onAtPass.clear()
    const adopted = deps.adopted()
    for (const engine of ENGINES) {
      if (!wanted[engine]) {
        turnOff(engine, counts)
        continue
      }
      onAtPass.add(engine)
      // A recorded folder is brought current, never written anew; one that cannot be looked at now stays, unwritten.
      let wrote = false
      const kept = record.homes[engine].filter((skills) => {
        const state = ownDirectory(skills, deps.uid)
        if (state === 'missing') {
          if (homeGone(skills, state)) return false
          leftRemoved(engine, skills)
          return true
        }
        if (state !== 'ok' || isRefused(skills)) return true
        const result = refreshSkill(skills)
        tally(counts, engine, result)
        if (result === 'gone') leftRemoved(engine, skills)
        if (result === 'failed') settle(engine, skills, 'refused')
        wrote ||= result === 'updated'
        return true
      })
      if (kept.length !== record.homes[engine].length) {
        record.homes[engine] = kept
        save(counts, engine)
      }
      if (wrote && !stillOn(engine, counts)) continue
      // Only the command makes a default home that is missing: the scans write it once it is there.
      for (const home of [defaultHome[engine], ...adopted[engine]]) {
        if (isRefused(home) || ownDirectory(home, deps.uid) !== 'ok') continue
        const outcome = writeHome(engine, home, counts)
        if (outcome === 'off') break
        settle(engine, home, outcome)
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
      // An engine installed since the pass: its default home is written once it is there.
      for (const engine of ENGINES) {
        const home = defaultHome[engine]
        if (!onAtPass.has(engine) || handled[engine].has(home) || isRefused(home) || ownDirectory(home, deps.uid) !== 'ok') continue
        const outcome = writeHome(engine, home, counts)
        if (outcome !== 'off') settle(engine, home, outcome)
      }
      // Codex only: Claude Code's sessions are read only under the default and adopted homes. Codex read off is passed
      // until a stamp changes: off, a home only has ours taken out again, which that read did.
      for (const owner of onAtPass.has('codex') ? owners : []) {
        if (!takesOwner(owner)) continue
        const home = rolloutHome(owner.record, realDataDir)
        if (home === null) {
          sayOnce('shape', 'dial skill: path refused (shape)')
          continue
        }
        if (handled.codex.has(home) || isRefused(home) || handled.codex.size >= MAX_HOMES) continue
        const state = ownDirectory(home, deps.uid)
        if (state !== 'ok') {
          sayOnce(home, `dial skill: path refused (${state})`)
          continue
        }
        const outcome = writeHome('codex', home, counts)
        if (outcome === 'off') break
        settle('codex', home, outcome)
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
