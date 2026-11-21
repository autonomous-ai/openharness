/**
 * One way to open an app's session by a link of the app's own (docs/specs/2026-11-15-device-host-adapter.md). More than
 * one app does it, so the parts they share live here once: the platform check, the session id's check before each
 * command, a rest's one link at a time, and the outcome. The link opens on macOS by `open`, on Linux by `xdg-open`
 * once the link's scheme has an app (docs/plans/2026-11-19-dial-linux-design.md § 1.6), and on Windows through Windows'
 * raise (windowsRaise.ts); elsewhere nothing runs.
 */
import { isAbsolute } from 'node:path'
import type { HostAdapter } from './adapter.js'
import { openPath } from './open.js'
import { RUN_TIMEOUT_MS, type OrcaDeps } from './orca.js'
import type { PaneSwitch } from './types.js'
import type { WindowsRaise } from './windowsRaise.js'

export type AppLinkDeps = Pick<OrcaDeps, 'run' | 'platform' | 'onPath'> & {
  inFront(): boolean
  /** The raw `HARNESS_OPEN_BIN` (open.ts openPath): on Linux it takes `xdg-open`'s place. */
  bin?: string
  /** Windows' way to open a link and bring its app forward, where macOS runs `open -b`; none elsewhere. */
  windows?: WindowsRaise
}

/** One app whose session opens by a link of the app's own. */
export interface AppLink {
  /** The form of a session id the link may name: checked again before every command. No `g` flag. */
  session: RegExp
  url(session: string): string
  /** The app's bundle id, so only that app receives the link (`open -b`): another app that registers the same scheme
   *  never gets it. Absent, macOS picks the scheme's app. Linux has none: the scheme's app gets it. */
  bundle?: string
  /** A tap's own way to bring the app forward once its link failed on macOS or Windows, answering whether the app came.
   *  Absent, or on Linux, a failed link answers false and the opener's fallback decides (open.ts). A rest never runs it. */
  forward?(): Promise<boolean>
}

/** A link's scheme, as a URL names it: what xdg-mime is asked about. */
const SCHEME = /^([a-z][a-z0-9+.-]{0,31}):/
/** The one answer of xdg-mime that names an app: a desktop entry's file name. */
const DESKTOP_FILE = /^[A-Za-z0-9._-]{1,128}\.desktop$/

/** Whether a scheme has an app: `app` once `read` has answered. */
interface SchemeApp { app?: boolean; read: Promise<boolean> }

export type AppLinkVerbs = Pick<HostAdapter, 'canFocus' | 'focus'> & Required<Pick<HostAdapter, 'canShow' | 'show'>>

export function createAppLink(deps: AppLinkDeps, link: AppLink): AppLinkVerbs {
  const windows = deps.windows
  // Windows sends a link to its app by the app's bundle, as macOS does: every path macOS takes, it takes too.
  const byBundle = deps.platform === 'darwin' || !!windows
  const linux = deps.platform === 'linux'
  const openBin = openPath(deps.bin)
  // Whether each scheme has an app on Linux: read at its first look and kept, and read again after an open that failed
  // (the app may have gone). `app` is set once the read has answered, so a look never waits on a command.
  const schemes = new Map<string, SchemeApp>()

  const appOf = (scheme: string): SchemeApp => {
    const kept = schemes.get(scheme)
    if (kept) return kept
    const entry: SchemeApp = { read: readApp(scheme).then((app) => (entry.app = app)) }
    schemes.set(scheme, entry)
    return entry
  }

  const readApp = async (scheme: string): Promise<boolean> => {
    const xdgMime = deps.onPath('xdg-mime')
    if (!xdgMime) return false
    const { code, stdout } = await deps.run(xdgMime, ['query', 'default', `x-scheme-handler/${scheme}`], RUN_TIMEOUT_MS)
    return code === 0 && DESKTOP_FILE.test(stdout.trim())
  }

  // [unread]: what a scheme whose read has not answered yet counts as.
  const canOpen = (session: string, unread: boolean): boolean => {
    if (byBundle) return true
    const scheme = linux ? SCHEME.exec(link.url(session))?.[1] : undefined
    return scheme !== undefined && (appOf(scheme).app ?? unread)
  }

  // The URL alone: xdg-open cannot name an app, so the scheme's app gets it.
  const opensOnLinux = async (url: string): Promise<boolean> => {
    const scheme = SCHEME.exec(url)?.[1]
    if (!scheme || !(await appOf(scheme).read)) return false
    const opener = deps.bin && isAbsolute(deps.bin) ? deps.bin : deps.onPath('xdg-open')
    if (!opener) return false
    if ((await deps.run(opener, [url], RUN_TIMEOUT_MS)).code === 0) return true
    schemes.delete(scheme)
    return false
  }

  // A rest's link at a time per agent, in a set of its own: a tap is not refused while a rest's link runs, nor a rest
  // while a tap runs, and two opens of one link do no harm.
  const showing = new Set<string>()

  const opens = async (session: string): Promise<boolean> => {
    const url = link.url(session)
    if (windows) return windows.link(url, link.bundle)
    if (linux) return opensOnLinux(url)
    return (await deps.run(openBin, link.bundle ? ['-b', link.bundle, url] : [url], RUN_TIMEOUT_MS)).code === 0
  }

  return {
    // On Linux the first look starts the read and answers yes: the tap's focus waits for the read (opensOnLinux), so a
    // first tap is not dropped while the read runs.
    canFocus: (pane) => canOpen(pane.id, true),
    async focus(pane) {
      if (!(byBundle || linux) || !link.session.test(pane.id)) return false
      if (await opens(pane.id)) return true
      return byBundle && link.forward ? link.forward() : false
    },
    // Asked at each look: the app may have left the front since the last one. A rest never waits on a command, so a
    // scheme not read yet answers no.
    canShow: (pane) => canOpen(pane.id, false) && deps.inFront(),
    // A rest of the dial shows the session in the app, which is already in front: a link that fails brings no app
    // forward, and its outcome is the swipe's own count.
    async show(pane, agentId): Promise<PaneSwitch> {
      if (!(byBundle || linux) || !link.session.test(pane.id)) return 'failed'
      if (showing.has(agentId)) return 'busy'
      showing.add(agentId)
      try {
        return (await opens(pane.id)) ? 'ok' : 'failed'
      } finally {
        showing.delete(agentId)
      }
    },
  }
}
