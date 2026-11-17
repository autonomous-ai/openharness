/**
 * Guests' harnesses, as shared machines builds them (docs/plans/2026-10-19-guest-machine-sharing-plan.md):
 * a guest's own OS account, made on their first harness (lib/guestAccounts.ts), the owner's shared folders,
 * and the pane's command (lib/guestPaneCommand.ts). The engine runs on the guest's own sign-in: nothing spends
 * the owner's subscription (anh Dee, 2026-11-07). The core opens the pane (core/agents/guestCreate.ts).
 *
 * What sharing says is kept true on each read of it (`sync`): a guest no longer named keeps none of the
 * owner's folders; every guest still named has exactly the folders the owner shares.
 */
import { isAbsolute, resolve, sep } from 'node:path'
import type { GuestLaunch, GuestLaunchInput } from '../core/api.js'
import { GuestHelperError, guestUserFor, type GuestAccounts, type SharedFolder } from '../lib/guestAccounts.js'
import type { GuestHelperState } from '../lib/guestHelperInstall.js'
import { GUEST_LAUNCH_ENGINES, type GuestLaunchEngine } from '../lib/guestEngines.js'
import { guestPaneCommand } from '../lib/guestPaneCommand.js'

export interface GuestLaunchesDeps {
  /** The guests' accounts; only what a launch and a share change read (lib/guestAccounts.ts, or the
   *  Windows setup client's adapter, lib/windows/windowsGuestAccounts.ts). */
  accounts: Pick<GuestAccounts, 'ensureGuest' | 'shareFolders' | 'guests'>
  /** Whether the owner turned guest access on here: the helper installed, current and allowed. */
  helperState: () => Promise<GuestHelperState>
  /** The owner's folders shared with every guest, as the owner last set them. */
  folders?: () => SharedFolder[]
  helperPath?: string
  lang?: string
  /** The platform the pane is made on; `process.platform` when absent. Windows makes it on the guest's own host. */
  platform?: NodeJS.Platform
  log?: (line: string) => void
}

export interface GuestLaunches {
  launch(input: GuestLaunchInput): Promise<GuestLaunch>
  /**
   * Makes sharing so: [still] says whether the machine is still shared with an address, and [shared] lists the
   * addresses it may be shared with (the policy's and the backend's members). A guest it no longer names loses
   * the owner's folders; every guest it names has the folders the owner shares.
   */
  sync(still: (email: string) => boolean, shared: readonly string[]): Promise<void>
}

const HELPER_REQUIRED: Record<Exclude<GuestHelperState, 'ready'>, string> = {
  missing: 'The owner of this computer hasn\'t finished turning on sharing yet.',
  outdated: 'The owner of this computer needs to turn sharing back on after an update.',
  'not-authorized': 'The owner of this computer needs to turn sharing back on.',
}

/** Whether [path] (resolved) is [folder] or inside it. */
const within = (path: string, folder: string): boolean => {
  const root = resolve(folder)
  return path === root || path.startsWith(`${root}${sep}`)
}

export function createGuestLaunches(deps: GuestLaunchesDeps): GuestLaunches {
  const log = deps.log ?? (() => {})
  const platforms = deps.platform ?? process.platform
  const folders = deps.folders ?? (() => [])
  // One share at a time: two at once would each read the helper's record of a guest's folders before the
  // other wrote it, and leave entries neither meant.
  let sharing: Promise<unknown> = Promise.resolve()
  const share = (user: string, owned: readonly SharedFolder[]): Promise<void> => {
    const next = sharing.then(() => deps.accounts.shareFolders(user, owned))
    sharing = next.catch(() => {})
    return next
  }

  return {
    async launch({ email, engine, bypassPermission, prompt, cwd, permissionFlags }) {
      const guest = email.trim().toLowerCase()
      if (!guest) return { ok: false, error: 'NOT_YOUR_HARNESS', detail: 'This computer does not know whom it is shared with here.' }
      if (!GUEST_LAUNCH_ENGINES.includes(engine)) {
        return { ok: false, error: 'GUEST_ENGINE_UNSUPPORTED', detail: 'You can start Claude Code or Codex on this computer.' }
      }
      const state = await deps.helperState()
      if (state !== 'ready') return { ok: false, error: 'GUEST_HELPER_REQUIRED', detail: HELPER_REQUIRED[state] }
      let account
      try {
        account = await deps.accounts.ensureGuest(guest)
      } catch (error) {
        const failed = error instanceof GuestHelperError ? error : new GuestHelperError('GUEST_HELPER_FAILED', 'The guest helper failed.')
        return { ok: false, error: failed.code, detail: failed.message }
      }
      // It starts in a folder the owner shares when it asks for one, and in its own workspace otherwise: a
      // folder from an older client, or one of the owner's that is not shared, is not where it runs.
      const shared = folders()
      const start = cwd && isAbsolute(cwd) ? resolve(cwd) : null
      const folder = start ? shared.find((f) => within(start, f.path)) : undefined
      try {
        await share(account.user, shared)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        log(`could not share folders with ${account.user}: ${detail}`)
        if (folder) return { ok: false, error: 'GUEST_FOLDER_UNAVAILABLE', detail: `That folder could not be shared with you: ${detail}` }
      }
      const where = folder && start ? start : account.workspace
      const command = guestPaneCommand({
        account, engine: engine as GuestLaunchEngine, bypassPermission, cwd: where, platform: platforms,
        ...(permissionFlags ? { permissionFlags } : {}),
        ...(prompt ? { prompt } : {}), ...(deps.lang ? { lang: deps.lang } : {}), ...(deps.helperPath ? { helperPath: deps.helperPath } : {}),
      })
      log(`launch · ${engine} · ${account.user}`)
      // Windows: the pane is made by the guest's own host, whose panes already run as the guest (lib/windows/).
      return { ok: true, workspace: where, argv: command.argv, env: command.env,
        ...(platforms === 'win32' ? { guestHostUser: account.user } : {}) }
    },
    async sync(still, shared) {
      const accounts = deps.accounts.guests()
      if (accounts.length === 0 || await deps.helperState() !== 'ready') return
      const named = new Set(shared.filter(still).map(guestUserFor))
      const owned = folders()
      for (const user of accounts) {
        await share(user, named.has(user) ? owned : [])
          .catch((error: unknown) => log(`could not share folders with ${user}: ${error instanceof Error ? error.message : String(error)}`))
      }
    },
  }
}
