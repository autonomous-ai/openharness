/** The core's native-control broker with the engines' own controls in process, for unit hosts. */
import { readFile } from 'node:fs/promises'
import { createNativeControls, type NativeControlsDeps } from '../core/engines/nativeControls.js'
import { nativeControlFor } from '../engines/nativeControls.js'
import { createNativeControl, type CodexNativeDeps } from '../engines/codex/nativeControl.js'
import { launch as codexLaunch } from '../engines/codex/launch.js'
import { sessionCodexHome } from '../lib/engineHomes.js'
import { argvTokens, processRows } from '../lib/tmux.js'

export function inlineNativeControls(over: Partial<NativeControlsDeps> = {}) {
  return createNativeControls({ call: async () => ({ error: 'SERVICE_UNAVAILABLE' }), servers: { codex: codexLaunch.sharedServer! },
    handles: () => false, inline: nativeControlFor, rows: processRows, home: session => sessionCodexHome(session), argv: argvTokens,
    readFile: path => readFile(path, 'utf8'), log: () => {}, ...over })
}

/**
 * Codex's control and the core's broker composed in one process over injected connections and files, as the
 * former lib/codexSessionLifecycle.ts and CodexActivityReader were: their recorded cases run against this.
 */
export function composedCodex(deps: Pick<CodexNativeDeps, 'connect'> & Partial<Pick<CodexNativeDeps, 'now'>> & Pick<NativeControlsDeps, 'rows'>
  & { daemonIdentity?(home: string): Promise<{ pid: number; processStartTime: string } | null> }) {
  const now = deps.now ?? (() => performance.now())
  const control = createNativeControl({ connect: deps.connect, now })
  // The server's record, as the former code's injected reader gave it: none is the file's absence.
  const readFile = async (path: string) => {
    const identity = await deps.daemonIdentity?.(path.slice(0, -codexLaunch.sharedServer!.pidFile.length - 1)) ?? null
    if (!identity) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return JSON.stringify(identity)
  }
  const core = inlineNativeControls({ inline: () => control, rows: deps.rows, now, readFile })
  return { read: core.activity, stop: core.stop, close: core.close }
}
