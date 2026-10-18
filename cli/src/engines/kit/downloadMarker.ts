/**
 * Desktop Harness downloading an engine beside a fresh computer's setup (desktop/lib/bootstrap/agent_prefetch.dart):
 * OpenCode with its curl recipe, Codex and Claude Code with one `npm install -g` into `~/.local`. While a download
 * runs, it names its process in `~/.harness/run/downloading-<engine>`, and the CLI tells the Desktop it waits for
 * downloads (`waitsForDownload`, backendSocket.ts), so the Desktop sends `agent_create` as soon as that marker is
 * there. A pane's shell waits for the download it names (lib/engineLaunch.ts `harness_wait_download`), but the
 * daemon's own launch preparation (engines/prepareNativeLaunch.ts) inspected the engine and installed it without
 * reading the marker. It probed an executable npm had linked and not yet finished and refused the launch as
 * ENGINE_CANNOT_RUN, with no installer of its own to hold it for; or it dispatched an installer of its own beside the
 * Desktop's npm, whose shell waits for the download only while no executable is there at all, takes a half-written
 * one for installed, and fails after ten minutes (ENGINE_INSTALL_FAILED). Failed agent starts from the Desktop went
 * from 6 to 25 on 2026-10-16, a sign-up surge of brand-new Macs.
 *
 * The same check as the pane's: a numeric pid in the marker, a live process with it, whose command line names the
 * download (`harness-download`, the Desktop's `downloadName`), so a stale marker whose pid now belongs to something
 * else is ignored. Cheap and bounded: a 32-byte read, a signal 0, and one `ps` of at most two seconds off the core's
 * thread, only while a marker with a live pid exists. Anything it cannot read is no download: today's behaviour.
 */
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { probeExecFile } from '../../lib/offThreadExec.js'
import type { AgentEngine } from '../types.js'

/** The download's own word for itself on its command line (agent_prefetch.dart `downloadName`). */
export const DOWNLOAD_NAME = 'harness-download'

/** A marker older than this is no longer waited for: the pane gives up on a download after ten minutes (it then
 *  says the engine is still downloading), and the daemon's launch then goes on as before, through its own
 *  installer, which waits for the same download in its shell and ends there. */
export const DOWNLOAD_HOLD_MS = 600_000

/** Whether Desktop Harness is downloading `engine` now. Never rejects. */
export async function engineDownloading(engine: AgentEngine, home: string = homedir(), now: () => number = Date.now): Promise<boolean> {
  const pid = await markedPid(join(home, '.harness', 'run', `downloading-${engine.replace(/[^a-z0-9-]/g, '')}`), now)
  if (pid === null) return false
  // As `kill -0`: a process of another user answers EPERM, which the pane's check reads as gone too.
  try { process.kill(pid, 0) } catch { return false }
  return (await commandLine(pid))?.includes(DOWNLOAD_NAME) ?? false
}

async function markedPid(file: string, now: () => number): Promise<number | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    // Non-blocking: a FIFO in the marker's place must not keep a thread waiting for a writer.
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK)
    const info = await handle.stat()
    if (!info.isFile() || info.size > 32 || now() - info.mtimeMs > DOWNLOAD_HOLD_MS) return null
    const bytes = Buffer.alloc(32)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    // The Desktop writes the pid alone; `$(cat …)` in the pane drops trailing newlines, and so does this.
    const text = bytes.subarray(0, bytesRead).toString('utf8').replace(/\n+$/, '')
    if (!/^[0-9]{1,10}$/.test(text)) return null
    const pid = Number(text)
    // 0 would ask about this process group, never a download.
    return pid > 0 ? pid : null
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** `ps -p <pid> -o command=`, as the pane asks it: the whole command line when it does not print to a terminal. */
function commandLine(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      probeExecFile(execFile)('ps', ['-p', String(pid), '-o', 'command='], { timeout: 2_000, killSignal: 'SIGKILL', maxBuffer: 1 << 20 },
        (error, stdout) => resolve(error ? null : stdout))
    } catch { resolve(null) }
  })
}
