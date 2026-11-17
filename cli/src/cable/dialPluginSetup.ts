// Claude Code's harness-device plugin, set up from the devices' own process once a computer: installed the first time a
// pass finds Claude Code, then brought current once after each CLI update, and never installed again. A plugin the
// person uninstalled through /plugin is theirs: the record says it was set up, so it is left removed. A pass that fails
// is tried again an hour later at the soonest, so a computer with no network does not run `claude` at every scan.
import { claudeDisable, claudeEnable, claudeUpdate, type ClaudeRun } from '../devices/claudePlugin.js'
import type { SetupCount } from '../devices/dialSkillFiles.js'

export interface DialPluginSetupDeps {
  platform: NodeJS.Platform
  /** This CLI's version. */
  version: string
  claude(): Promise<ClaudeRun | null>
  /** A dial attached here once, and `disable` has not removed Claude Code; read anew at each call. */
  wanted(): boolean
  recorded(): string | undefined
  record(version: string): boolean
  now(): number
  count(kind: SetupCount, reason?: string): void
}

/** One pass at a time; never rejects. true: this pass installed, enabled or updated the plugin. */
export interface DialPluginSetup { pass(): Promise<boolean> }

const RETRY_MS = 3_600_000

export function createDialPluginSetup(deps: DialPluginSetupDeps): DialPluginSetup {
  let running = false
  let retryAt = -Infinity

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

  async function run(): Promise<boolean> {
    const found = await deps.claude()
    // Not on this computer yet: asked again at the next pass, with nothing counted.
    if (!found) return false
    const claude = { run: found, platform: deps.platform }
    if (deps.recorded() === undefined) {
      const enabled = await claudeEnable(claude)
      if (!enabled.ok) return failed(enabled.step)
      // A `disable` that landed while the install ran found nothing to uninstall yet: it is taken out here.
      if (!deps.wanted()) {
        const disabled = await claudeDisable(claude)
        return disabled.ok ? false : failed(disabled.step)
      }
      recordAs('set up')
      return true
    }
    const update = await claudeUpdate(claude)
    if (!update.ok) return failed(update.step)
    recordAs(update.outcome === 'updated' ? 'updated' : update.outcome === 'absent' ? 'left removed' : undefined)
    return update.outcome === 'updated'
  }

  return {
    async pass() {
      // Windows has no dial to ring: no `claude` is looked for there.
      if (deps.platform === 'win32' || running) return false
      running = true
      try {
        // The in-memory checks first: wanted() reads dial-skill.json, which a scan with the plugin set up never reads.
        if (deps.recorded() === deps.version || deps.now() < retryAt || !deps.wanted()) return false
        return await run()
      } catch {
        return failed('error')
      } finally {
        running = false
      }
    },
  }
}
