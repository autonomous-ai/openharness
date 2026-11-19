// Harness Device's plugin for Orca, set up from the devices' own process with no click, as Harness's extension is in VS
// Code and Cursor (vscodeExtensionSetup.ts, its model): a menu row a person must find left most dials without the
// plugin their Orca features need. It is installed the first time a pass finds a running Orca after a dial has attached
// here, brought current after each CLI update, and never installed again once the person removed it, by `harness device
// orca disable`, an uninstall in Orca or a disable in Orca. orcaSetUp approves only the access Diego agreed to; a
// plugin that asks for more is held, recorded as orcaHeld so Orca is not asked again until the next CLI. A pass runs at
// the service's start, at each attach, when Orca settles in front (Orca is often not running at the first two) and an
// hour after a failed one (docs/plans/2026-11-19-device-orca-default-on-design.md, "The devices' pass"). It logs
// nothing: the tally counts each result with a fixed word.
import type { DialRemoved, Read, SetupCount } from '../devices/dialSkillFiles.js'
import { carriedVersion, orcaRemove, orcaSetUp, type OrcaPluginDeps, type OrcaRemove, type OrcaSetUp } from '../devices/orcaPlugin.js'

export interface OrcaPluginSetupDeps {
  platform: NodeJS.Platform
  /** The carried orca-plugin.json's version; null in a run from the sources. */
  version(): string | null
  /** orcaSetUp(plugin, { force: false }). */
  setUp(): Promise<OrcaSetUp>
  /** orcaRemove(plugin). */
  remove(): Promise<OrcaRemove>
  /** dial-skill.json's removals, read anew at each call. */
  removed(): Read<DialRemoved>
  /** dial-skill.json's orcaConnected (0.1.9's click, or an enable), read anew. */
  connected(): Read<{ connected: boolean }>
  /** dialSetup's orca(): whether a dial attached here once, the version that last set the plugin up or found it
   *  removed, and the version held for asking more access; undefined until it could be read. */
  recorded(): { dial: boolean; version?: string; held?: string } | undefined
  /** false when the record could not be saved. */
  record(version: string): boolean
  /** As record(), for the held version. */
  recordHeld(version: string): boolean
  after(ms: number, run: () => void): void
  /** One event in the day's tally; [reason] a fixed word. */
  count(kind: SetupCount, reason?: string): void
}

/** One pass at a time, and one asked meanwhile runs once after it; never rejects. */
export interface OrcaPluginSetup { pass(): Promise<void> }

const RETRY_MS = 3_600_000

export function createOrcaPluginSetup(deps: OrcaPluginSetupDeps): OrcaPluginSetup {
  let running = false
  /** A pass asked while one runs: Orca may have come up while that one waited for `orca status`, and its settle is not
   *  lost, so the running pass runs once more. */
  let again = false
  /** An hour after a failed pass, or an Orca too old: an attach or a settle within it runs no Orca CLI, so an Orca that
   *  cannot take the plugin is not asked again each time it comes to the front. */
  let waiting = false
  /** An uninstall owed: one that failed, or a `disable` during an install past its deadline; tried at the passes after
   *  while the plugin is removed, as nothing else would take out what this setup put in. */
  let undoOwed = false

  /** That hour; [retry]: a pass at its end. */
  const wait = (retry: boolean): void => {
    waiting = true
    deps.after(RETRY_MS, () => {
      waiting = false
      if (retry) void setup.pass()
    })
  }

  const failed = (reason: string): void => {
    deps.count('failed', reason)
    wait(true)
  }

  /** This version saved as the one that set the plugin up or found it removed; [kind] is counted once it is saved. */
  const recordAs = (version: string, kind?: SetupCount): void => {
    if (!deps.record(version)) failed('save')
    else if (kind) deps.count(kind)
  }

  /** What this setup put in taken out again, owed until it is done. */
  const undo = async (): Promise<void> => {
    undoOwed = true
    const change = await deps.remove()
    if (!('error' in change)) undoOwed = false
    // Orca quit: still owed, with nothing counted and no hour, so the next attach or settle takes it out. It is held in
    // memory only: a restart before then forgets it.
    else if (change.error !== 'not-running') failed(change.error)
  }

  const setup: OrcaPluginSetup = {
    async pass() {
      // The devices' listener, which the plugin talks to, does not exist on Windows.
      if (deps.platform === 'win32' || waiting) return
      if (running) {
        again = true
        return
      }
      running = true
      try {
        const version = deps.version()
        if (version === null) return
        const recorded = deps.recorded()
        if (recorded === undefined) return
        // A removal this setup owes is taken out while the plugin stays removed, whatever the record says.
        if (undoOwed && deps.removed().orca) return await undo()
        // Set up, found removed or held at this version: Orca is not asked again until the next CLI, and no file is read,
        // as a pass runs each time Orca comes to the front. A removal since was `disable`'s, which uninstalls it itself.
        if (recorded.version === version || recorded.held === version) return
        // First set up only on a computer that has had a dial, or an `enable`; one set up before is still brought
        // current. orcaConnected is read only where it decides, so a computer with no dial reads the file once a settle;
        // one unread reads as not connected.
        if (recorded.version === undefined && !recorded.dial && !deps.connected().connected) return
        const removed = deps.removed()
        if (removed.unread || removed.orca) return
        const result = await deps.setUp()
        switch (result.orca) {
          case 'on': {
            // A `disable` that landed while Orca installed found nothing to uninstall yet: it is honoured here, and
            // nothing recorded. One not known is neither: a moment's read error never uninstalls a plugin the person
            // keeps, and the next pass finds it current and records it.
            const now = deps.removed()
            if (now.orca) return await undo()
            if (!now.unread) recordAs(version, result.did)
            return
          }
          // Set up before and removed in Orca now: the person's, and it stays so. Counted once a version: recorded, the
          // passes after stop at the record.
          case 'off': return recordAs(version, 'left removed')
          // Held, never recorded as the version: it does not count as set up before, so a later CLI whose pinned access
          // covers it still installs it.
          case 'held':
            if (!deps.recordHeld(version)) return failed('save')
            return deps.count('failed', 'access')
          case 'absent':
            // Not running: passed again at the next start, attach or settle. Too old, or an entry that is the person's
            // to mend: Orca's CLI is not run again at each settle, nor at the hour's end, which would run it each hour
            // while that lasts; the first settle after the hour asks again.
            if (result.error !== 'not-running') wait(false)
            return
          case 'failed':
            // A `disable` that landed while Orca ran past its deadline found nothing to uninstall, and Orca may still
            // install it: owed, and taken out at the hour's pass.
            if (deps.removed().orca) undoOwed = true
            return failed(result.error)
        }
      } catch {
        failed('error')
      } finally {
        running = false
        if (again) {
          again = false
          await setup.pass()
        }
      }
    },
  }
  return setup
}

/** The Orca half of the deps, on the real orcaSetUp, orcaRemove and carriedVersion. */
export function orcaPluginParts(plugin: OrcaPluginDeps): Pick<OrcaPluginSetupDeps, 'platform' | 'version' | 'setUp' | 'remove'> {
  // The files the build inlined stay as they are while the process runs: parsed at the first pass, not at each settle.
  let version: string | null | undefined
  return {
    platform: plugin.platform,
    version: () => version === undefined ? version = carriedVersion(plugin) : version,
    setUp: () => orcaSetUp(plugin, { force: false }),
    remove: () => orcaRemove(plugin),
  }
}
