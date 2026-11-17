// The dial's setup in the devices' own process: the skill in each home (dialHomeSetup.ts), then Claude Code's plugin
// (dialPluginSetup.ts), at the service's start, at each attach and at each open scan. The plugin reads from the homes'
// record whether a dial attached here once and the version that last set it up, so the record has one writer.
import type { ClaudeRun } from '../devices/claudePlugin.js'
import type { RolloutOwner } from './codexRolloutHome.js'
import { createDialHomeSetup, type DialHomeSetupDeps } from './dialHomeSetup.js'
import { createDialPluginSetup } from './dialPluginSetup.js'

export interface DialSetupDeps extends DialHomeSetupDeps {
  /** Claude Code as the daemon finds it, for this Claude Code home; [shell] as the plugin's setup asks it. */
  claude(home: string, shell: boolean): Promise<ClaudeRun | null>
  /** This CLI's version. */
  version: string
}

export interface DialSetup {
  started(): Promise<void>
  attached(): Promise<void>
  scanned(owners: Iterable<RolloutOwner>): Promise<void>
}

export function createDialSetup(deps: DialSetupDeps): DialSetup {
  const homes = createDialHomeSetup(deps)
  const plugin = createDialPluginSetup({
    platform: deps.platform,
    version: deps.version,
    claude: (shell) => deps.claude(deps.claudeHome, shell),
    wanted: () => homes.wanted('claude'),
    recorded: () => homes.plugin(),
    record: (version) => homes.recordPlugin(version),
    now: deps.now,
    count: (kind, reason) => deps.count('claude', kind, reason),
  })

  /** The homes first, so an attach records the dial before the plugin reads it. A plugin this moment turned on has
   *  Claude Code's skill follow in the same moment, not a scan later. */
  const moment = async (homesStep: () => void, attached = false): Promise<void> => {
    homesStep()
    if (await plugin.pass(attached)) homes.scanned([])
  }

  return {
    started: () => moment(() => homes.started()),
    attached: () => moment(() => homes.attached(), true),
    scanned: (owners) => moment(() => homes.scanned(owners)),
  }
}
