// The dial's setup in the devices' own process: the skill in each home (dialHomeSetup.ts), then Claude Code's plugin
// (dialPluginSetup.ts), at the service's start, at each attach and at each open scan. The plugin reads from the homes'
// record whether a dial attached here once, the version that last set it up and the Orca homes it turned on. Harness's
// extension (vscodeExtensionSetup.ts), in VS Code and in Cursor, reads and saves each editor's version through it too,
// and Orca's own plugin its versions, so the record has one writer.
import type { ClaudeRun } from '../devices/claudePlugin.js'
import { readPluginHomes } from '../devices/dialSkillFiles.js'
import type { RolloutOwner } from './codexRolloutHome.js'
import { createDialHomeSetup, type DialHomeSetup, type DialHomeSetupDeps } from './dialHomeSetup.js'
import { createDialPluginSetup } from './dialPluginSetup.js'

export interface DialSetupDeps extends DialHomeSetupDeps {
  /** Claude Code as the daemon finds it, for this Claude Code home; [shell] as the plugin's setup asks it. */
  claude(home: string, shell: boolean): Promise<ClaudeRun | null>
  /** Orca's Claude Code homes from its last read (devices/orcaHomes.ts); answered: that read gave Orca's answer. */
  orcaClaude(): { homes: readonly string[]; answered: boolean }
  /** This CLI's version. */
  version: string
}

export interface DialSetup {
  started(): Promise<void>
  attached(): Promise<void>
  scanned(owners: Iterable<RolloutOwner>): Promise<void>
  vscode: DialHomeSetup['vscode']
  recordVscode: DialHomeSetup['recordVscode']
  cursor: DialHomeSetup['cursor']
  recordCursor: DialHomeSetup['recordCursor']
  orca: DialHomeSetup['orca']
  recordOrca: DialHomeSetup['recordOrca']
  recordOrcaHeld: DialHomeSetup['recordOrcaHeld']
}

export function createDialSetup(deps: DialSetupDeps): DialSetup {
  const homes = createDialHomeSetup(deps)
  const plugin = createDialPluginSetup({
    platform: deps.platform,
    version: deps.version,
    home: deps.claudeHome,
    claude: (shell) => deps.claude(deps.claudeHome, shell),
    claudeIn: deps.claude,
    orca: deps.orcaClaude,
    pluginHomes: () => homes.pluginHomes(),
    recordPluginHomes: (list) => homes.recordPluginHomes(list),
    enabledByCommand: () => readPluginHomes(deps.dataDir),
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
    vscode: () => homes.vscode(),
    recordVscode: (version) => homes.recordVscode(version),
    cursor: () => homes.cursor(),
    recordCursor: (version) => homes.recordCursor(version),
    orca: () => homes.orca(),
    recordOrca: (version) => homes.recordOrca(version),
    recordOrcaHeld: (version) => homes.recordOrcaHeld(version),
  }
}
