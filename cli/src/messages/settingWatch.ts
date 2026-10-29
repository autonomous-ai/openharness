/**
 * Hearing Agent Messages turned on again, while it is off (messages/service.ts). Off, the service runs no timer, so
 * nothing of it would read the setting again: it watches the one file the setting is kept in (lib/agentSettings.ts
 * `agent-settings.json`), the core's copy of the account's experiment. The core tells the service as well when it
 * writes a change (core/experiments.ts `createAgentSettingsSync`, `MessagesPort.settingsChanged`); a core from before
 * that does not, and an older `harness settings` that wrote the file itself, are heard only here.
 *
 * The file itself, not the data folder it is in: the daemon's log, the search index and the registry are written there
 * many times a second, and every write would wake this process for nothing. A write replaces the file (a rename over
 * it), which ends a watch on the one it replaced, so every event re-arms the watch on the path before it says the file
 * changed. A watch only follows the file from the event loop's next turn (its kernel registration is made then): a
 * write in the same turn would go unheard, found by its own test, so each watch says the file may have changed once
 * more, on that next turn, and the reader reads it again.
 *
 * A file that is not there is not watched, and not looked for: every switch is then at its default, and polling for
 * the file would be the timer off must not cost. The daemon's write tells the service; a `harness settings` that writes
 * the file for the first time is heard at the service's next request (`harness send` reads the switch) or the core's
 * next start. Where a watch cannot be had for another reason (no inotify watches left), or fails later, it falls back
 * to looking at the file's time every `POLL_MS`: degraded, still no backend and no pump.
 */
import { statSync, watch } from 'node:fs'

/** How often the fallback looks at the file, where it cannot be watched. */
export const POLL_MS = 2_000

/** What a watch gives back: closing it, and hearing it fail. */
export interface Watching {
  close(): void
  on(event: 'error', listener: (error: Error) => void): unknown
}

export interface SettingWatchDeps {
  watch?: (path: string, listener: () => void) => Watching
  poll?: (path: string, listener: () => void) => () => void
}

const watchPath = (path: string, listener: () => void): Watching => watch(path, { persistent: false }, listener)
/** The file as one look sees it: replaced (a rename), resized or written; null when it is not there or cannot be
 *  looked at (a failed look in a timer would end the process; the next look that succeeds says it may have changed). */
const look = (path: string): string | null => {
  try {
    const stats = statSync(path, { bigint: true, throwIfNoEntry: false })
    return stats ? `${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}` : null
  } catch {
    return null
  }
}
/** Its first look is taken now, not later off the main thread as `fs.watchFile` takes it: a write made before that
 *  later look was where it started, and never heard (found by its own test, every time on a busy machine). */
const pollPath = (path: string, listener: () => void): (() => void) => {
  let seen = look(path)
  const timer = setInterval(() => {
    const now = look(path)
    if (now === seen) return
    seen = now
    listener()
  }, POLL_MS)
  timer.unref()
  return () => clearInterval(timer)
}

/** Call [changed] whenever the file at [path] may have changed, until the returned function is called. */
export function watchSettingFile(path: string, changed: () => void, deps: SettingWatchDeps = {}): () => void {
  const watchOne = deps.watch ?? watchPath
  const poll = deps.poll ?? pollPath
  let watcher: Watching | null = null
  let stopPolling: (() => void) | null = null
  let stopped = false
  const arm = (): void => {
    try {
      const armed: Watching = watchOne(path, () => {
        if (stopped || watcher !== armed) return
        armed.close()
        arm()
        changed()
      })
      watcher = armed
      setImmediate(() => { if (!stopped && watcher === armed) changed() }).unref()
      // A watch that fails later (the folder gone) says the file may have changed, and is looked at by time from then.
      armed.on('error', () => {
        if (stopped || watcher !== armed) return
        armed.close()
        watcher = null
        stopPolling = poll(path, changed)
        changed()
      })
    } catch (error) {
      watcher = null
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') stopPolling = poll(path, changed)
    }
  }
  arm()
  return () => {
    stopped = true
    watcher?.close()
    watcher = null
    stopPolling?.()
    stopPolling = null
  }
}
