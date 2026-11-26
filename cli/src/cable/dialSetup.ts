// The dial's setup in the devices' own process: the skill in each home (dialHomeSetup.ts), then Claude Code's plugin
// (dialPluginSetup.ts), then Codex's in the Codex homes the skill setup serves (dialCodexPluginSetup.ts), at the service's
// start, at each attach and at each open scan. The plugin reads from the homes'
// record whether a dial attached here once, the version that last set it up and the Orca homes it turned on. Harness's
// extension (vscodeExtensionSetup.ts), in VS Code and in Cursor, reads and saves each editor's version through it too,
// and Orca's own plugin its versions, so the record has one writer.
import type { ClaudePluginSource, ClaudeRun } from '../devices/claudePlugin.js'
import { writePluginTrust } from '../devices/codexPluginTrust.js'
import { readPluginHomes } from '../devices/dialSkillFiles.js'
import type { RolloutOwner } from './codexRolloutHome.js'
import { CODEX_SETUP_COUNTS, createDialCodexPluginSetup } from './dialCodexPluginSetup.js'
import { createDialHomeSetup, type DialHomeSetup, type DialHomeSetupDeps } from './dialHomeSetup.js'
import { createDialPluginSetup } from './dialPluginSetup.js'
import { createEngineTally } from './engineTally.js'

export interface DialSetupDeps extends DialHomeSetupDeps {
  /** Claude Code's plugin asks it which Claude Code it may set up (devices/claudePlugin.ts). */
  platform: NodeJS.Platform
  /** Claude Code as the daemon finds it, for this Claude Code home; [shell] as the plugin's setup asks it. */
  claude(home: string, shell: boolean): Promise<ClaudeRun | null>
  /** Codex as the daemon finds it, pointed at this Codex home; [shell] as the Codex plugin's setup asks it. */
  codex(home: string, shell: boolean): Promise<ClaudeRun | null>
  /** Orca's Claude Code homes from its last read (devices/orcaHomes.ts); answered: that read gave Orca's answer. */
  orcaClaude(): { homes: readonly string[]; answered: boolean }
  /** The marketplace folder the plugins' installs and updates write, Claude Code's and Codex's, and what cli.js carries
   *  for it. */
  claudePlugin: ClaudePluginSource
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
    plugin: deps.claudePlugin,
    pluginHomes: () => homes.pluginHomes(),
    recordPluginHomes: (list) => homes.recordPluginHomes(list),
    enabledByCommand: () => readPluginHomes(deps.dataDir),
    wanted: () => homes.wanted('claude'),
    recorded: () => homes.plugin(),
    record: (version) => homes.recordPlugin(version),
    now: deps.now,
    count: (kind, reason) => deps.count('claude', kind, reason),
  })
  const codexCount = createEngineTally('[device] codex plugin', ['codex'], CODEX_SETUP_COUNTS, deps.log)
  const codexPlugin = createDialCodexPluginSetup({
    platform: deps.platform,
    version: deps.version,
    codex: deps.codex,
    plugin: deps.claudePlugin,
    homes: () => homes.codexHomes(),
    wanted: () => homes.wanted('codex'),
    recorded: () => homes.codexPlugin(),
    record: (home, version) => homes.recordCodexPlugin(home, version),
    trust: writePluginTrust,
    now: deps.now,
    count: (kind, reason) => codexCount('codex', kind, reason),
  })

  /** The homes first, so an attach records the dial before the plugins read it. A plugin this moment turned on has
   *  Claude Code's skill follow in the same moment, not a scan later. Codex's plugin last, over the Codex homes the
   *  skill setup serves after it. */
  const moment = async (homesStep: () => void, attached = false): Promise<void> => {
    homesStep()
    if (await plugin.pass(attached)) homes.scanned([])
    await codexPlugin.pass(attached)
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
