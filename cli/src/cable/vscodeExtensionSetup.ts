// Harness's VS Code extension, set up from the devices' own process once a computer, as Claude Code's plugin is
// (dialPluginSetup.ts): installed the first time a pass finds VS Code after a dial has attached here, brought current
// after each CLI update, and never installed again. One the person uninstalled in VS Code is theirs: the record says it
// was set up, so it is left removed; one `harness device vscode disable` removed is left alone too. A pass runs at the
// service's start, at each attach and an hour after a failed one (docs/plans/2026-11-17-dial-vscode-extension-design.md,
// "Set up once a computer"). VS Code's own record says whether the extension is on.
import type { DialRemoved, Read, SetupCount } from '../devices/dialSkillFiles.js'
import { buildVersion, vscodeDisable, vscodeEnable, vscodeStatus, type VscodeExtensionDeps } from '../devices/vscodeExtension.js'

export interface VscodeExtensionSetupDeps {
  /** VS Code as this computer has it, and its own `code`. */
  vscode: VscodeExtensionDeps
  /** dial-skill.json's removals, read anew at each call. */
  removed(): Read<DialRemoved>
  /** The dial setup's record (dialSetup.ts): whether a dial attached here once, and the version that last set the
   *  extension up or found it; undefined until it could be read. */
  recorded(): { dial: boolean; version?: string } | undefined
  /** false when the record could not be saved. */
  record(version: string): boolean
  after(ms: number, run: () => void): void
  /** One event in the day's tally; [reason] a fixed word, never a path. */
  count(kind: SetupCount, reason?: string): void
}

/** One pass at a time; never rejects. */
export interface VscodeExtensionSetup { pass(): Promise<void> }

const RETRY_MS = 3_600_000

export function createVscodeExtensionSetup(deps: VscodeExtensionSetupDeps): VscodeExtensionSetup {
  let running = false
  /** A failed pass's hour: an attach within it runs no `code`, so a computer whose VS Code cannot install is not asked
   *  again at every replug. */
  let waiting = false
  /** An uninstall that failed: tried again at the passes after its hour while the extension is removed, as nothing else
   *  would take out what this setup put in. */
  let undoOwed = false

  const failed = (reason: string): void => {
    deps.count('failed', reason)
    waiting = true
    deps.after(RETRY_MS, () => {
      waiting = false
      void setup.pass()
    })
  }

  /** This version saved as the one that set the extension up or found it; [kind] is counted once it is saved. */
  const recordAs = (version: string, kind?: SetupCount): void => {
    if (!deps.record(version)) failed('save')
    else if (kind) deps.count(kind)
  }

  /** What this setup put in taken out again, owed until it is done. */
  const undo = async (): Promise<void> => {
    undoOwed = true
    const change = await vscodeDisable(deps.vscode)
    if ('error' in change) return failed(change.error)
    undoOwed = false
  }

  const install = async (version: string, kind: SetupCount): Promise<void> => {
    const change = await vscodeEnable(deps.vscode)
    if ('error' in change) return failed(change.error)
    // A `disable` that landed while the install ran found nothing to uninstall yet: it is honoured here, and nothing
    // recorded. One not known is neither: a moment's read error never uninstalls an extension the person keeps, and the
    // next pass finds it current and records it.
    const removed = deps.removed()
    if (removed.vscode) return undo()
    if (!removed.unread) recordAs(version, kind)
  }

  const setup: VscodeExtensionSetup = {
    async pass() {
      // The devices' listener, which the extension talks to, does not exist on Windows.
      if (deps.vscode.platform === 'win32' || running || waiting) return
      running = true
      // Only a run of `code` is awaited: a pass that runs none ends at once, and does not turn away an attach's pass
      // that follows it in the same moment.
      try {
        const version = buildVersion(deps.vscode)
        const removed = deps.removed()
        const recorded = deps.recorded()
        if (version === null || removed.unread || recorded === undefined) return
        if (removed.vscode) {
          if (undoOwed) await undo()
          return
        }
        if (recorded.version === version) return
        const status = vscodeStatus(deps.vscode)
        // Not on this computer yet: looked for again at the next start or attach, with nothing recorded.
        if (status.state === 'absent') return
        if (status.state === 'on') {
          if (status.version === version) recordAs(version)
          else await install(version, 'updated')
          return
        }
        // Set up before and off now: the person uninstalled it, and it stays so. Counted once a version: recorded, the
        // passes after stop at the record.
        if (recorded.version !== undefined) return recordAs(version, 'left removed')
        // First set up only on a computer that has had a dial.
        if (recorded.dial) await install(version, 'set up')
      } catch {
        failed('error')
      } finally {
        running = false
      }
    },
  }
  return setup
}
