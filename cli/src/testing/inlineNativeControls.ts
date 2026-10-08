/** The core's native-control broker with the engines' own controls in process, for unit hosts. */
import { createNativeControls, type NativeControlsDeps } from '../core/engines/nativeControls.js'
import { nativeControlFor } from '../engines/nativeControls.js'
import { createNativeControl, type CodexNativeDeps } from '../engines/codex/nativeControl.js'
import { sessionCodexHome } from '../lib/engineHomes.js'
import { argvTokens, processRows } from '../lib/tmux.js'

export function inlineNativeControls(over: Partial<NativeControlsDeps> = {}) {
  return createNativeControls({ call: async () => ({ error: 'SERVICE_UNAVAILABLE' }), handles: () => false, inline: nativeControlFor,
    rows: processRows, home: session => sessionCodexHome(session), argv: argvTokens, ...over })
}

/**
 * Codex's control and the core's broker composed in one process over injected connections, as the former
 * lib/codexSessionLifecycle.ts and CodexActivityReader were: their recorded cases run against this.
 */
export function composedCodex(deps: Pick<CodexNativeDeps, 'connect'> & Partial<Omit<CodexNativeDeps, 'connect'>> & Pick<NativeControlsDeps, 'rows'>) {
  const now = deps.now ?? (() => performance.now())
  const control = createNativeControl({ connect: deps.connect, daemonIdentity: deps.daemonIdentity ?? (async () => null), now })
  const core = inlineNativeControls({ inline: () => control, rows: deps.rows, now })
  return { read: core.activity, stop: core.stop, close: core.close }
}
