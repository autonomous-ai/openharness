// Claude Code's harness-device plugin, set up from the devices' own process once a computer: installed the first time a
// pass finds Claude Code, then brought current once after each CLI update, and never installed again. A plugin the
// person uninstalled or turned off through /plugin is theirs, before the first pass or after it: the record says it was
// set up, so it is left removed. A pass that fails is tried again an hour later at the soonest, so a computer with no
// network does not run `claude` at every scan.
import { claudeDisable, claudeSetUp, claudeUpdate, type ClaudeDeps, type ClaudeRun, type ClaudeSetup } from '../devices/claudePlugin.js'
import type { SetupCount } from '../devices/dialSkillFiles.js'

export interface DialPluginSetupDeps {
  platform: NodeJS.Platform
  /** This CLI's version. */
  version: string
  /** Claude Code as the daemon finds it; [shell]: the login shell's PATH read anew for it, which starts that shell. */
  claude(shell: boolean): Promise<ClaudeRun | null>
  /** A dial attached here once, and `disable` has not removed Claude Code; read anew at each call. */
  wanted(): boolean
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

  async function run(wanted: boolean, attached: boolean): Promise<boolean> {
    const shell = attached || deps.now() - shellAt >= SHELL_MS
    if (shell) shellAt = deps.now()
    const found = await deps.claude(shell)
    // Not on this computer yet: asked again at the next pass, with nothing counted.
    if (!found) return false
    const claude = { run: found, platform: deps.platform }
    if (!wanted) return undo(claude)
    const done = deps.recorded() === undefined ? await claudeSetUp(claude) : await claudeUpdate(claude)
    if (!done.ok) return failed(done.step)
    // A `disable` that landed while the install or the update ran found nothing to undo yet: it is undone here, and
    // nothing recorded.
    if (!deps.wanted()) return undo(claude)
    recordAs(COUNTED[done.outcome])
    return done.outcome === 'installed' || done.outcome === 'updated'
  }

  return {
    async pass(attached = false) {
      // Windows has no dial to ring: no `claude` is looked for there.
      if (deps.platform === 'win32' || running) return false
      running = true
      try {
        // The in-memory checks first: wanted() reads dial-skill.json, which a scan with the plugin set up never reads.
        if (deps.recorded() === deps.version || deps.now() < retryAt) return false
        const wanted = deps.wanted()
        return wanted || undoOwed ? await run(wanted, attached) : false
      } catch {
        return failed('error')
      } finally {
        running = false
      }
    },
  }
}
