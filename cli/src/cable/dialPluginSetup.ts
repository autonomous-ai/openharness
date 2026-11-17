// Claude Code's harness-device plugin, set up from the devices' own process once a computer: installed the first time a
// pass finds Claude Code, then brought current once after each CLI update, and never installed again. A plugin the
// person uninstalled or turned off through /plugin is theirs, before the first pass or after it: the record says it was
// set up, so it is left removed. A pass that fails is tried again an hour later at the soonest, so a computer with no
// network does not run `claude` at every scan.
//
// Orca runs Claude Code under its own account homes, whose `plugins/` is linked to the default home's: the files are
// there already, so only each home's entry is turned on, once, and the home recorded by its real path. One the person
// turned off since stays off. Orca's homes follow the default home: only while its plugin reads on there, as one turned
// off or removed there said no for every home, and a removal takes the files they all name.
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { claudeDisable, claudeHomeDisable, claudeHomeEnable, claudeSetUp, claudeUpdate, type ClaudeDeps, type ClaudeRun, type ClaudeSetup } from '../devices/claudePlugin.js'
import { claudePluginState } from '../devices/dialSkill.js'
import { listable, MAX_HOMES, type Read, type SetupCount } from '../devices/dialSkillFiles.js'

export interface DialPluginSetupDeps {
  platform: NodeJS.Platform
  /** This CLI's version. */
  version: string
  /** The default home, whose settings Orca's homes follow, and which is never run as one of them. */
  home: string
  /** Claude Code as the daemon finds it; [shell]: the login shell's PATH read anew for it, which starts that shell. */
  claude(shell: boolean): Promise<ClaudeRun | null>
  /** Claude Code found as claude() is, pointed at [home]. */
  claudeIn(home: string, shell: boolean): Promise<ClaudeRun | null>
  /** Orca's Claude Code homes from its last read, a new list at each read; answered: that read gave Orca's answer. */
  orca(): { homes: readonly string[]; answered: boolean }
  /** dial-setup.json's Orca homes, by real path, and its writer: false when it could not be saved. */
  pluginHomes(): readonly string[]
  recordPluginHomes(homes: string[]): boolean
  /** dial-skill.json's: the Orca homes `harness device claude enable` turned the plugin on in. */
  enabledByCommand(): Read<{ homes: string[] }>
  /** A dial attached here once, and `disable` has not removed Claude Code; read anew at each call. undefined: not known
   *  (dial-skill.json could not be read), and nothing is installed, recorded or undone on it. */
  wanted(): boolean | undefined
  recorded(): string | undefined
  record(version: string): boolean
  now(): number
  count(kind: SetupCount, reason?: string): void
}

/** One pass at a time; never rejects. true: this pass installed or updated the plugin. [attached]: a dial attached this
 *  moment. */
export interface DialPluginSetup { pass(attached?: boolean): Promise<boolean> }

const RETRY_MS = 3_600_000
/** A computer with a dial and no Claude Code looks for it at every scan: the login shell's PATH is read for it this often
 *  at most, and at once when a dial attaches, so a login shell that fails is not started, and logged, at each scan. */
const SHELL_MS = 600_000
/** What a pass that did its work counts: a plugin found as it should be counts nothing. */
const COUNTED: Record<Extract<ClaudeSetup, { ok: true }>['outcome'], SetupCount | undefined> =
  { installed: 'set up', updated: 'updated', absent: 'left removed', current: undefined }

export function createDialPluginSetup(deps: DialPluginSetupDeps): DialPluginSetup {
  let running = false
  let retryAt = -Infinity
  let shellAt = -Infinity
  /** An undo that failed: tried again at the passes after its hour while Claude Code is not wanted, as nothing else
   *  would take out what this setup put in. */
  let undoOwed = false
  /** Orca's list as last worked out, and its homes by real path. */
  let orcaList: readonly string[] | undefined
  let orcaHomes: string[] = []
  /** The listed homes found in the command's own list, until Orca's list changes: one there would otherwise be due at
   *  each scan, and cost it a read of dial-skill.json and the default home's settings. */
  let byCommand = new Set<string>()
  /** When each listed Orca home last failed: each waits its own hour. */
  const failedAt = new Map<string, number>()

  const failed = (reason: string): false => {
    deps.count('failed', reason)
    retryAt = deps.now() + RETRY_MS
    return false
  }

  /** This CLI's version saved as the one that set the plugin up; [kind] is counted once it is saved. */
  const recordAs = (kind?: SetupCount): void => {
    if (!deps.record(deps.version)) failed('save')
    else if (kind) deps.count(kind)
  }

  /** What this setup put in taken out again, owed until it is done. */
  const undo = async (claude: ClaudeDeps): Promise<false> => {
    const disabled = await claudeDisable(claude)
    undoOwed = !disabled.ok
    return disabled.ok ? false : failed(disabled.step)
  }

  /** Whether a lookup reads the login shell's PATH: at once at an attach, else at most every SHELL_MS. */
  const shellNow = (attached: boolean): boolean => {
    const shell = attached || deps.now() - shellAt >= SHELL_MS
    if (shell) shellAt = deps.now()
    return shell
  }

  async function run(wanted: boolean, shell: () => boolean): Promise<boolean> {
    const found = await deps.claude(shell())
    // Not on this computer yet: asked again at the next pass, with nothing counted.
    if (!found) return false
    const claude = { run: found, platform: deps.platform }
    if (!wanted) return undo(claude)
    const done = deps.recorded() === undefined ? await claudeSetUp(claude) : await claudeUpdate(claude)
    if (!done.ok) return failed(done.step)
    // A `disable` that landed while the install or the update ran found nothing to undo yet: it is undone here, and
    // nothing recorded. One not known is neither: a moment's read error never uninstalls a plugin the person keeps, and
    // the next pass finds it current and records it.
    const still = deps.wanted()
    if (still === false) return undo(claude)
    if (still === undefined) return false
    recordAs(COUNTED[done.outcome])
    return done.outcome === 'installed' || done.outcome === 'updated'
  }

  /** The default home's own step, passed while its version is current or within its hour. */
  async function defaultStep(shell: () => boolean): Promise<boolean> {
    // The in-memory checks first: wanted() reads dial-skill.json, which a scan with the plugin set up never reads.
    if (deps.recorded() === deps.version || deps.now() < retryAt) return false
    const wanted = deps.wanted()
    if (wanted === undefined) return false
    return wanted || undoOwed ? await run(wanted, shell) : false
  }

  /** Orca's homes by real path: each once, the default home left out, and only what a record may hold, so a home turned
   *  on is one it can record. One that does not resolve is not there to run in. */
  const listOrca = (homes: readonly string[]): string[] => {
    const own = realPath(deps.home) ?? deps.home
    const real = new Set<string>()
    for (const home of homes) {
      const path = realPath(home)
      if (path !== null && path !== own && listable(path)) real.add(path)
    }
    return [...real]
  }

  const waiting = (home: string): boolean => {
    const at = failedAt.get(home)
    return at !== undefined && deps.now() - at < RETRY_MS
  }

  /** A fixed word, never Claude Code's own line, which names the home's folder. */
  const homeFailed = (home: string, reason: string): void => {
    deps.count('failed', reason)
    failedAt.set(home, deps.now())
  }

  async function orcaStep(shell: () => boolean): Promise<void> {
    const orca = deps.orca()
    // Worked out once a read, and the hours kept for listed homes alone, so they are bounded by the list.
    if (orca.homes !== orcaList) {
      orcaList = orca.homes
      orcaHomes = listOrca(orca.homes)
      byCommand = new Set()
      for (const home of failedAt.keys()) if (!orcaHomes.includes(home)) failedAt.delete(home)
      // Only Orca's answer drops a home: a failed read lists none, and the next answer would turn on again a home the
      // person turned off.
      const kept = deps.pluginHomes().filter((home) => orcaHomes.includes(home))
      if (orca.answered && kept.length < deps.pluginHomes().length && !deps.recordPluginHomes(kept)) deps.count('failed', 'save')
    }
    // In memory: a scan with every home recorded reads no file and runs no `claude`.
    const due = orcaHomes.filter((home) => !deps.pluginHomes().includes(home) && !byCommand.has(home) && !waiting(home))
    if (!due.length) return
    if (deps.recorded() === undefined || deps.wanted() !== true || claudePluginState(join(deps.home, 'settings.json')) !== 'on') return
    // The command's own list, so dial-setup.json keeps its one writer.
    const command = deps.enabledByCommand()
    if (command.unread) return
    for (const home of due) {
      if (command.homes.includes(home)) {
        byCommand.add(home)
        continue
      }
      // Turned on and not recorded, a home the person turns off afterwards would be turned on again.
      if (deps.pluginHomes().length >= MAX_HOMES) {
        homeFailed(home, 'full')
        continue
      }
      const found = await deps.claudeIn(home, shell())
      // Not found: asked again at the next pass, with nothing counted.
      if (!found) return
      const claude = { run: found, platform: deps.platform }
      const done = await claudeHomeEnable(claude)
      if (!done.ok) {
        homeFailed(home, done.step)
        continue
      }
      // A `disable` that landed during the enable found this home still off: it is turned off here, and nothing
      // recorded. One left on by a turn-off that failed stays quiet, as the removal mark keeps its hook and mod so. One
      // not known is neither: the next pass finds it on and records it.
      const still = deps.wanted()
      if (still === false) {
        const off = await claudeHomeDisable(claude)
        if (!off.ok) deps.count('failed', off.step)
      }
      if (still !== true) return
      if (!deps.recordPluginHomes([...deps.pluginHomes(), home])) homeFailed(home, 'save')
    }
  }

  return {
    async pass(attached = false) {
      // Windows has no dial to ring: no `claude` is looked for there.
      if (deps.platform === 'win32' || running) return false
      running = true
      // One answer a pass, so each Orca home's lookup reads the login shell's PATH as the default home's does.
      let shell: boolean | undefined
      const lookup = (): boolean => shell ??= shellNow(attached)
      try {
        // The default home first: an Orca home's plugin is its files.
        const changed = await defaultStep(lookup)
        await orcaStep(lookup)
        return changed
      } catch {
        return failed('error')
      } finally {
        running = false
      }
    },
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
