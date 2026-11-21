/**
 * State files are written whole, through `atomicWriteFile` / `atomicWriteJson` in `secureState.ts`, never in
 * place: a crash or a full disk midway through `writeFile` left a half-written trust file that the next start
 * could not read (docs/plans/2026-11-19-atomic-state-writes-design.md). This guard keeps the modules that own
 * a state file from growing a write in place again. A write there that is not a state file says why on its
 * line or the line above: `// not a state file: <why>`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Modules under `cli/src` that own a state file. `lib/secureState.ts` is the helper and is not listed. */
const STATE_MODULES: readonly string[] = [
  'lib/registry.ts',
  'lib/e2ee/store.ts',
  'lib/e2ee/machinePeers.ts',
  'lib/e2ee/trustGroup.ts',
  'lib/e2ee/deviceLogStore.ts',
  'lib/e2ee/accountTrust.ts',
  'lib/authSession.ts',
  'lib/hookAuth.ts',
  'lib/commander.ts',
  'lib/daemonState.ts',
  'core/main.ts',
  'harnessd/master.ts',
  'masterProcess.ts',
  'device/machineList.ts',
  'lib/runtimeInstall.ts',
  'lib/engineLaunch.ts',
  'lib/windows/hermesLaunch.ts',
  'services/browserShim.ts',
  'lib/uninstall/deps.ts',
  'lib/hostTheme.ts',
  'lib/computerIdentity.ts',
  'lib/codexProfiles.ts',
  'lib/appModels.ts',
  'lib/localModels.ts',
  'lib/gridModels.ts',
  'lib/agentTokenUsage.ts',
  'lib/sessionGitHistory.ts',
  'lib/agentSettings.ts',
  'lib/daemonRecord.ts',
  'lib/hookRoutes.ts',
  'lib/machineMcp.ts',
  'lib/nodeMigration.ts',
  'lib/gridConfigDir.ts',
  'lib/apiInstructions.ts',
  'lib/selfUpdate.ts',
  'lib/signOut.ts',
  'lib/launchers.ts',
  'tui/launcher.ts',
  'lib/flash.ts',
  'lib/connectors/agents.ts',
  'lib/windows/installLayout.ts',
  'lib/windows/ptyInstall.ts',
  'lib/windows/ptyUpdate.ts',
  'lib/windows/cliVersions.ts',
  'services/windowNames.ts',
  'services/agentCleanup.ts',
  'services/sharedMachines.ts',
  'services/goals.ts',
  'services/agentBrowser/stateFile.ts',
  'messages/requestStore.ts',
  'messages/consentStore.ts',
  'messages/noticeStore.ts',
  'messages/rosterStore.ts',
  'messages/store.ts',
  'sharing/collaboration.ts',
  'sharing/grants.ts',
  'orchestrator/service.ts',
  'cloud/service.ts',
  'dsh/installed.ts',
  'dsh/viewerLedger.ts',
  'dsh/catalog.ts',
  'cable/noticeFile.ts',
  'cable/notifyMode.ts',
  'cable/dialPortVerdicts.ts',
  'cable/pets/store.ts',
  'engines/cursor/pendingTasks.ts',
  'engines/kit/windowsInstall.ts',
  'engines/kit/messagesHook.ts',
  'engines/kit/statusLine.ts',
  'engines/kit/hookSettings.ts',
  'agentClient/program.ts',
  'agentClient/ledger.ts',
  'gateway/productUsage.ts',
  'lib/autonomous-device/direct.ts',
  'lib/sessionCheckpoint.ts',
  'lib/stoppedAgents.ts',
  'lib/daemonSafeMode.ts',
]

// Every way to put bytes in a file by its name or an open descriptor: a write, an append, a stream, a truncate, a copy,
// and an open that empties or appends (`wx` creates a new file only; what fills it matches on its own).
const WRITE_IN_PLACE = new RegExp([
  /\bwriteFile(Sync)?\s*\(/,
  /\bappendFile(Sync)?\s*\(/,
  /\bcreateWriteStream\s*\(/,
  /\btruncateSync\s*\(|\.truncate\s*\(/,
  /\bcopyFile(Sync)?\s*\(/,
  /\bwriteSync\s*\(/,
  /\bopenSync\s*\([^)]*['"](w|a)(?!x)/,
].map((pattern) => pattern.source).join('|'))
const MARKER = 'not a state file:'

/** Every write in place outside a comment line, unless it or the line above is marked. */
function hits(source: string): Array<{ line: number; text: string }> {
  const lines = source.split('\n')
  const found: Array<{ line: number; text: string }> = []
  lines.forEach((text, index) => {
    const trimmed = text.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return
    if (!WRITE_IN_PLACE.test(text)) return
    if (text.includes(MARKER) || (lines[index - 1] ?? '').includes(MARKER)) return
    found.push({ line: index + 1, text: trimmed })
  })
  return found
}

describe('state writes guard', () => {
  it('finds a write in place', () => {
    expect(hits('writeFileSync(file, data)')).toHaveLength(1)
    expect(hits('await fs.promises.writeFile(file, data)')).toHaveLength(1)
    for (const write of ['appendFileSync(file, line)', 'await appendFile(file, line)', 'createWriteStream(file)',
      'truncateSync(file, 0)', 'await handle.truncate(0)', 'copyFileSync(from, file)', 'await copyFile(from, file)',
      "const fd = openSync(file, 'w')", "openSync(file, 'w+')", "openSync(file, 'a', 0o600)", 'writeSync(fd, data)',
    ]) expect(hits(write), write).toHaveLength(1)
    for (const other of ["openSync(file, 'r')", "openSync(lock, 'wx', 0o600)", 'ftruncateSync(fd, 0)', 'truncate(text, 60)']) {
      expect(hits(other), other).toEqual([])
    }
    expect(hits('// writeFileSync(file)')).toEqual([])
    expect(hits('writeFileSync(archive, bytes) // not a state file: a one-shot download')).toEqual([])
  })

  it('no listed module writes a state file outside the helper', () => {
    const found = STATE_MODULES.flatMap((module) =>
      hits(readFileSync(join(__dirname, '..', module), 'utf8')).map((hit) => `${module}:${hit.line}: ${hit.text}`),
    )
    expect(found).toEqual([])
  })
})
