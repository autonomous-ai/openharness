import { isRecord, minuteCounts } from './observedHook.js'

/**
 * The app in front on this computer, as a dial watch says it (`dial_front`), checked and bounded here and then handed
 * to the devices process, which alone decides what the dial shows. Which app is in front is private: the core holds
 * none of it and logs none of it, so a frame costs one lookup and a token.
 */

/**
 * The devices' app ids (cable/hosts/hostDetect.ts, `claude` among them) and `none`, no listed app in front. Written out
 * rather than imported: the core loads none of the devices' code.
 */
export const FRONT_APPS: ReadonlySet<string> = new Set([
  'harness', 'orca', 'herdr', 'rex', 'zellij', 'kitty', 'wezterm', 'iterm', 'terminal-app', 'ghostty', 'vscode',
  'cursor', 'warp', 'terminal', 'claude', 'none',
])

/** Frames a connection may send a second: a person switches apps far slower, so more is a held key or a broken tool. */
export const FRONT_PER_SECOND = 10

export interface DialFrontDeps {
  /** Hand the app to the devices process; false when it is not there (the frame is dropped). */
  forward: (app: string) => boolean
  now: () => number
  log?: (line: string) => void
}

export function createDialFront(deps: DialFrontDeps) {
  const tally = minuteCounts(['refused', 'dropped'] as const,
    (lost) => `[devices] dial front in the last minute: ${lost.refused} refused, ${lost.dropped} dropped`, deps.log ?? console.warn)

  return {
    /** One connection's gate. Its bucket lives in this closure and goes with the connection: no table to bound or clean. */
    connection(): (payload: unknown) => void {
      let tokens = FRONT_PER_SECOND
      let at = deps.now()
      return (payload) => {
        const app = isRecord(payload) ? payload.app : undefined
        if (typeof app !== 'string' || !FRONT_APPS.has(app)) return tally('refused')
        const now = deps.now()
        // A clock that stepped back refills nothing, rather than owe the bucket the time it went back.
        tokens = Math.min(FRONT_PER_SECOND, tokens + Math.max(0, now - at) * FRONT_PER_SECOND / 1000)
        at = now
        if (tokens < 1) return tally('dropped')
        tokens -= 1
        if (!deps.forward(app)) tally('dropped')
      }
    },
  }
}
