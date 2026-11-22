/**
 * The Codex app (docs/specs/2026-11-15-device-host-adapter.md): its chat opens by `codex://threads/<thread-id>`, the link
 * OpenAI documents for the app (developers.openai.com/codex/app/commands, "Deep links"), which brings the app forward
 * itself (appLink.ts): on macOS sent to the app by its bundle id, on Windows by Windows' raise (windowsRaise.ts), on
 * Linux to the scheme's app; either way for a session the scan's app says is the Codex app's. The thread id came from a
 * hook or a rollout's file name, so it is checked against its form before it reaches the link. A tap whose link failed
 * brings the app forward from here, on macOS and Windows by its bundle and on Linux by its window class through the
 * raise: a session only the open scan found has no bundle, process or app until its first hook (observed.ts), so the
 * opener alone could not bring the app (open.ts).
 */
import type { HostAdapter, Pane, Place } from './adapter.js'
import { createAppLink, type AppLinkDeps } from './appLink.js'
import { CODEX_THREAD } from './codexQueue.js'
import { APP_BUNDLES } from './hostDetect.js'
import type { LinuxRaise } from './linuxRaise.js'
import { openPath } from './open.js'
import { RUN_TIMEOUT_MS } from './orca.js'

export function createCodexAppAdapter(
  deps: AppLinkDeps & {
    log(line: string): void
    /** Brings a window forward on Linux; none elsewhere. */
    raise?: LinuxRaise['raise']
  },
): HostAdapter & Required<Pick<HostAdapter, 'canShow' | 'show'>> {
  const openBin = openPath(deps.bin)
  const raise = deps.raise
  // How the app comes forward without its link. On Linux only the raise can bring it, by the app's class alone: with
  // none, there is no forward.
  const bring = deps.platform !== 'linux'
    ? async () => deps.windows
      ? deps.windows.app(APP_BUNDLES.codex)
      : (await deps.run(openBin, ['-b', APP_BUNDLES.codex], RUN_TIMEOUT_MS)).code === 0
    : raise && (() => raise({ app: 'codex' }))
  return {
    id: 'codex',
    tap: 'instead',
    paneOf(place: Place): Pane | undefined {
      const thread = place.sessionId
      // The app decides, never a hint: a Codex session in another app has a thread id too, and its tap brings its own app.
      if (place.app !== 'codex' || place.engine !== 'codex' || !thread || !CODEX_THREAD.test(thread)) return undefined
      return { adapter: 'codex', id: thread }
    },
    ...createAppLink(deps, {
      session: CODEX_THREAD,
      url: (thread) => `codex://threads/${thread}`,
      bundle: APP_BUNDLES.codex,
      forward: bring && (() => {
        // The line the opener writes for every pane's fallback: which app only, never the thread.
        deps.log('[device] open · codex · fallback')
        return bring()
      }),
    }),
  }
}
