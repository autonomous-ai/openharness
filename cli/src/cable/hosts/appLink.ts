/**
 * One way to open an app's session by a link of the app's own (docs/specs/2026-11-15-device-host-adapter.md). More than
 * one app does it, so the parts they share live here once: the macOS check, the session id's check before each command,
 * a rest's one link at a time, and the outcome. The link and `open` are macOS's, so elsewhere nothing runs.
 */
import type { HostAdapter } from './adapter.js'
import { OPEN } from './open.js'
import { RUN_TIMEOUT_MS, type OrcaDeps } from './orca.js'
import type { PaneSwitch } from './types.js'

export type AppLinkDeps = Pick<OrcaDeps, 'run' | 'platform'> & { inFront(): boolean }

/** One app whose session opens by a link of the app's own. */
export interface AppLink {
  /** The form of a session id the link may name: checked again before every command. No `g` flag. */
  session: RegExp
  url(session: string): string
  /** The app's bundle id, so only that app receives the link (`open -b`): another app that registers the same scheme
   *  never gets it. Absent, macOS picks the scheme's app. */
  bundle?: string
  /** A tap's own way to bring the app forward once its link failed, answering whether the app came. Absent, a failed
   *  link answers false and the opener's fallback decides (open.ts). A rest never runs it. */
  forward?(): Promise<boolean>
}

export type AppLinkVerbs = Pick<HostAdapter, 'canFocus' | 'focus'> & Required<Pick<HostAdapter, 'canShow' | 'show'>>

export function createAppLink(deps: AppLinkDeps, link: AppLink): AppLinkVerbs {
  const mac = deps.platform === 'darwin'
  // A rest's link at a time per agent, in a set of its own: a tap is not refused while a rest's link runs, nor a rest
  // while a tap runs, and two opens of one link do no harm.
  const showing = new Set<string>()

  const opens = async (session: string): Promise<boolean> => {
    const url = link.url(session)
    return (await deps.run(OPEN, link.bundle ? ['-b', link.bundle, url] : [url], RUN_TIMEOUT_MS)).code === 0
  }

  return {
    canFocus: () => mac,
    async focus(pane) {
      if (!mac || !link.session.test(pane.id)) return false
      if (await opens(pane.id)) return true
      return link.forward ? link.forward() : false
    },
    // Asked at each look: the app may have left the front since the last one.
    canShow: () => mac && deps.inFront(),
    // A rest of the dial shows the session in the app, which is already in front: a link that fails brings no app
    // forward, and its outcome is the swipe's own count.
    async show(pane, agentId): Promise<PaneSwitch> {
      if (!mac || !link.session.test(pane.id)) return 'failed'
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
