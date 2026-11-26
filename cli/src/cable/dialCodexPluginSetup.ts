// Codex's harness-device plugin, set up from the devices' own process in each Codex home the dial setup serves:
// installed the first time a pass finds Codex there, brought current once after each CLI update, and left as the person
// left it where they removed or turned it off. Each home waits its own hour after a failure, so one that fails does not
// run `codex` at every scan while the others go on. A home whose `openharness` marketplace is the person's own gets
// nothing (devices/codexPlugin.ts), and one Harness set up whose marketplace became theirs since leaves the record, so
// `disable` takes nothing out of it.
//
// Codex runs the plugin's hooks unasked only while their trust records hold the installed folder's fingerprint, and
// Codex may reinstall that folder at its start, so each pass re-checks every home set up at this version: two stats, and
// the records written again only when one changed, and only for a folder that is still the copy this CLI carries. A
// folder that differs is left for Codex to ask the person about, said once until it matches again.
import { existsSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ClaudePluginFiles, ClaudePluginSource, ClaudeRun } from '../devices/claudePlugin.js'
import { carriedCodexHash, codexMarketplace, codexPluginState, codexRemove, codexSetUp, codexUpdate, installedRoot, type CodexFailure } from '../devices/codexPlugin.js'
import type { TrustWrite } from '../devices/codexPluginTrust.js'
import { listable, MAX_HOMES, SETUP_COUNTS } from '../devices/dialSkillFiles.js'

/** What a day's tally counts of the Codex plugin's setup: what Claude Code's counts, a folder left for Codex to ask
 *  about, and a home whose marketplace is the person's own. */
export const CODEX_SETUP_COUNTS = [...SETUP_COUNTS, 'untrusted', 'skipped'] as const
export type CodexSetupCount = typeof CODEX_SETUP_COUNTS[number]

export interface DialCodexPluginSetupDeps {
  platform: NodeJS.Platform
  /** This CLI's version. */
  version: string
  /** Codex as the daemon finds it, pointed at [home]; [shell]: the login shell's PATH read anew for it, which starts that
   *  shell. */
  codex(home: string, shell: boolean): Promise<ClaudeRun | null>
  /** The marketplace folder Claude Code's plugin comes from too, and what cli.js carries for it. */
  plugin: ClaudePluginSource
  /** The Codex homes the skill setup's last pass handled while Codex was on; empty while it is removed. */
  homes(): readonly string[]
  /** A dial attached here once, and `disable` has not removed Codex; read anew at each call. undefined: not known
   *  (dial-skill.json could not be read), and nothing is installed, recorded or undone on it. */
  wanted(): boolean | undefined
  /** dial-setup.json's codexPlugin: a home's real path to the CLI version that last set the plugin up there. */
  recorded(): Readonly<Record<string, string>>
  /** [version] null removes [home]'s entry. false when it could not be saved, or the record holds MAX_HOMES homes and
   *  not [home]. */
  record(home: string, version: string | null): boolean
  /** The plugin at [root] trusted in [home]'s config.toml, only when its fingerprint is [expected]
   *  (devices/codexPluginTrust.ts writePluginTrust). */
  trust(home: string, root: string, expected: string): TrustWrite
  now(): number
  count(kind: CodexSetupCount, reason?: string): void
}

/** One pass at a time; never rejects. [attached]: a dial attached this moment. */
export interface DialCodexPluginSetup { pass(attached?: boolean): Promise<void> }

const RETRY_MS = 3_600_000
/** As Claude Code's plugin setup: a computer with a dial and no Codex looks for it at every scan, so the login shell's
 *  PATH is read for it this often at most, and at once when a dial attaches. */
const SHELL_MS = 600_000
/** Homes said once a process to have the person's own marketplace, at most: the served list comes and goes (a start
 *  pass lists no scanned home until the next scan), so it is not what bounds them. */
const MAX_SAID = 2 * MAX_HOMES
const COUNTED = { installed: 'set up', updated: 'updated', absent: 'left removed' } as const
/** What a home's step leaves its pass: the next home; the step stopped, as there is no `codex` or it is too old; or the
 *  pass ended, as Codex is no longer wanted or that is not known, so nothing more is installed or trusted. */
type Next = 'go' | 'stop' | 'end'

export function createDialCodexPluginSetup(deps: DialCodexPluginSetupDeps): DialCodexPluginSetup {
  let running = false
  let shellAt = -Infinity
  /** The homes as last listed, and those by real path. */
  let listed: readonly string[] = []
  let served: string[] = []
  /** The carried copy's fingerprint, worked out once a process; null in a run from the sources, which carries none. */
  let carried: string | null | undefined
  /** When each home last failed, or was found gone or the person's own: each waits its own hour. */
  const waitFrom = new Map<string, number>()
  /** When `codex` last answered older than MIN_CODEX: one binary serves every home, so none runs it within that hour. */
  let tooOldAt = -Infinity
  /** Each recorded home's installed folder and config.toml as last checked; it leaves with the home's entry. */
  const stamps = new Map<string, string>()
  /** Recorded homes whose folder was said to differ from the carried copy, until it matches again. */
  const differs = new Set<string>()
  /** Homes said to have the person's own marketplace. */
  const own = new Set<string>()
  let fullSaid = false
  /** Homes a `disable` that landed during their install left the plugin in, as its removal failed: removed at the passes
   *  after their hour while Codex is not wanted, as nothing else would take out what this setup put in. */
  const owed = new Set<string>()

  const wait = (home: string): void => {
    // Only hours not yet up are kept, so the map holds no more homes than can fail within one.
    for (const [other, at] of waitFrom) if (deps.now() - at >= RETRY_MS) waitFrom.delete(other)
    waitFrom.set(home, deps.now())
  }
  const waiting = (home: string): boolean => {
    const at = waitFrom.get(home)
    return at !== undefined && deps.now() - at < RETRY_MS
  }
  /** A fixed word, never Codex's own line, which can name the home's folder. */
  const failed = (home: string, reason: string): void => {
    deps.count('failed', reason)
    wait(home)
  }
  /** A Codex older than MIN_CODEX is no failure: nothing is counted for it, and it stops the step, asked again after its
   *  hour. */
  const stepFailed = (home: string, failure: CodexFailure): Next => {
    if (failure.step === 'unsupported') {
      tooOldAt = deps.now()
      return 'stop'
    }
    failed(home, failure.step === 'trust' ? `trust ${failure.reason}` : failure.step)
    return 'go'
  }
  const tooOld = (): boolean => deps.now() - tooOldAt < RETRY_MS

  const trusted = (home: string, matched: boolean): void => {
    if (matched) differs.delete(home)
    else if (!differs.has(home)) {
      differs.add(home)
      deps.count('untrusted', 'differs')
    }
  }

  /** [home]'s entry dropped, as it is gone or its marketplace is the person's own; the home then waits its hour. */
  const drop = (home: string): void => {
    stamps.delete(home)
    differs.delete(home)
    if (Object.hasOwn(deps.recorded(), home) && !deps.record(home, null)) failed(home, 'record')
    else wait(home)
  }

  const skipOwn = (home: string): void => {
    if (!own.has(home) && own.size < MAX_SAID) {
      own.add(home)
      deps.count('skipped', 'own marketplace')
    }
    drop(home)
  }

  /** Whether the record has room for one more home: gone homes leave a full one first. */
  const room = (): boolean => {
    if (Object.keys(deps.recorded()).length < MAX_HOMES) return true
    for (const home of Object.keys(deps.recorded())) if (!existsSync(home)) drop(home)
    return Object.keys(deps.recorded()).length < MAX_HOMES
  }

  const stampOf = (home: string): string => `${statOf(installedRoot(home))} ${statOf(join(home, 'config.toml'))}`

  /** Whether a lookup reads the login shell's PATH: at once at an attach, else at most every SHELL_MS. */
  const shellNow = (attached: boolean): boolean => {
    const shell = attached || deps.now() - shellAt >= SHELL_MS
    if (shell) shellAt = deps.now()
    return shell
  }

  /** The listed homes by real path, worked out again only when the list changed: each once, and only what a record may
   *  hold. One that does not resolve is not there to set up. */
  function serve(): void {
    const homes = deps.homes()
    if (homes.length === listed.length && homes.every((home, at) => home === listed[at])) return
    listed = [...homes]
    const real = new Set<string>()
    for (const home of homes) {
      const path = realPath(home)
      if (path !== null && listable(path)) real.add(path)
    }
    served = [...real]
  }

  /** [work] with Codex pointed at [home]; no `codex` stops the step with nothing counted, so it is asked again at the next
   *  pass. A throw fails that home alone. */
  async function withCodex(home: string, lookup: (home: string) => Promise<ClaudeRun | null>, work: (run: ClaudeRun) => Promise<Next>): Promise<Next> {
    try {
      const run = await lookup(home)
      return run ? await work(run) : 'stop'
    } catch {
      failed(home, 'error')
      return 'go'
    }
  }

  async function undo(home: string, run: ClaudeRun): Promise<Next> {
    const removed = await codexRemove({ run, home, platform: deps.platform })
    if (removed.ok) {
      owed.delete(home)
      return 'go'
    }
    owed.add(home)
    return stepFailed(home, removed)
  }

  async function undoStep(lookup: (home: string) => Promise<ClaudeRun | null>): Promise<void> {
    const due = [...owed].filter((home) => !waiting(home))
    if (!due.length || tooOld()) return
    const wanted = deps.wanted()
    // Wanted again: such a home is set up as any other, and nothing is owed.
    if (wanted === true) owed.clear()
    if (wanted !== false) return
    for (const home of due) {
      // Its marketplace became the person's own since: a plugin there is theirs, and nothing is owed.
      if (codexMarketplace(home, deps.plugin.folder) === 'own') {
        owed.delete(home)
        skipOwn(home)
        continue
      }
      if (await withCodex(home, lookup, (run) => undo(home, run)) !== 'go') return
    }
  }

  async function setUp(home: string, run: ClaudeRun, files: ClaudePluginFiles): Promise<Next> {
    const install = { run, home, platform: deps.platform, folder: deps.plugin.folder, files }
    const done = Object.hasOwn(deps.recorded(), home) ? await codexUpdate(install) : await codexSetUp(install)
    if (!done.ok) return stepFailed(home, done)
    if (done.outcome === 'own') {
      skipOwn(home)
      return 'go'
    }
    // A `disable` that landed while the install or the update ran found nothing to take out here yet: it is taken out
    // now, and nothing recorded. One not known is neither: a moment's read error never removes a plugin the person keeps.
    // Either ends the pass, as the next home would be set up for a dial no longer known to want it.
    const still = deps.wanted()
    if (still === false && done.outcome !== 'absent') await undo(home, run)
    if (still !== true) return 'end'
    if (!deps.record(home, deps.version)) {
      failed(home, 'record')
      return 'go'
    }
    deps.count(COUNTED[done.outcome])
    if (done.outcome !== 'absent') trusted(home, done.trusted)
    stamps.set(home, stampOf(home))
    return 'go'
  }

  /** false when the pass ended there, and nothing is re-checked. */
  async function setUpStep(lookup: (home: string) => Promise<ClaudeRun | null>): Promise<boolean> {
    // In memory first: wanted() reads dial-skill.json, which a scan with every home current never reads.
    const recorded = deps.recorded()
    const due = served.filter((home) => recorded[home] !== deps.version && !waiting(home))
    if (!due.length || tooOld() || deps.wanted() !== true) return true
    // The carried copy's fingerprint was worked out from it, so this build carries it.
    const files = deps.plugin.files()!
    for (const home of due) {
      if (!existsSync(home)) {
        drop(home)
        continue
      }
      // Installed and not recorded, the plugin would be set up again at each pass, and `disable` would leave it there.
      if (!Object.hasOwn(deps.recorded(), home) && !room()) {
        if (!fullSaid) deps.count('failed', 'full')
        fullSaid = true
        wait(home)
        continue
      }
      const next = await withCodex(home, lookup, (run) => setUp(home, run, files))
      if (next !== 'go') return next === 'stop'
    }
    return true
  }

  /** Each home set up at this version and out of its hour, re-checked by two stats, and trusted again only when one
   *  changed. A file edited in place may change neither and is not seen here: Codex refuses that folder itself. */
  function recheck(expected: string): void {
    const recorded = deps.recorded()
    for (const home of served) {
      if (recorded[home] !== deps.version || waiting(home)) continue
      const stamp = stampOf(home)
      if (stamp === stamps.get(home)) continue
      const root = installedRoot(home)
      if (!existsSync(root)) {
        // Nothing installed to trust: the person removed it, or the home is gone, which leaves the record.
        if (existsSync(home)) stamps.set(home, stamp)
        else drop(home)
        continue
      }
      const marketplace = codexMarketplace(home, deps.plugin.folder)
      if (marketplace === 'own') {
        skipOwn(home)
        continue
      }
      // Only a plugin on is Harness's to trust: one the person turned off or removed, or a config.toml that cannot be
      // read, is left as it is until a stat changes again, and a folder said to differ is said again once it is back on.
      if (marketplace === 'unknown' || codexPluginState(home) !== 'on') {
        differs.delete(home)
        stamps.set(home, stamp)
        continue
      }
      const trust = deps.trust(home, root, expected)
      if (!trust.ok && trust.kind !== 'differs') {
        // Checked again after its hour, whatever the stats say then.
        stamps.delete(home)
        failed(home, `trust ${trust.kind}`)
        continue
      }
      trusted(home, trust.ok)
      // Taken again, as the write changed config.toml.
      stamps.set(home, stampOf(home))
    }
  }

  return {
    async pass(attached = false) {
      if (running) return
      running = true
      // One answer a pass, so each home's lookup reads the login shell's PATH alike.
      let shell: boolean | undefined
      const lookup = (home: string): Promise<ClaudeRun | null> => deps.codex(home, shell ??= shellNow(attached))
      try {
        await undoStep(lookup)
        serve()
        if (!served.length) return
        if (carried === undefined) {
          const files = deps.plugin.files()
          carried = files && carriedCodexHash(files, deps.platform)
        }
        // A run from the sources carries no plugin: nothing is set up, trusted or counted.
        if (carried === null) return
        if (await setUpStep(lookup)) recheck(carried)
      } catch {
        deps.count('failed', 'error')
      } finally {
        running = false
      }
    },
  }
}

/** What a change of [path] changes: its device, inode, size and time; one that is missing or cannot be read is a word
 *  of its own. */
function statOf(path: string): string {
  try {
    const stats = statSync(path, { throwIfNoEntry: false })
    return stats ? `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}` : 'none'
  } catch {
    return 'unread'
  }
}

/** [path] through its links; null when it does not resolve. */
function realPath(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}
