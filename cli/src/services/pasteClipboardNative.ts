/** Clipboard subprocess ownership belongs to the paste component, including Linux's forked selection owner. */
import { errorKind } from '../lib/log.js'
import { spawn, type ChildProcess } from 'node:child_process'
import { release } from 'node:os'
import type { Writable } from 'node:stream'
import type { PasteClipboardResult } from '../core/api.js'
import { resolveBinaryOnPath } from '../lib/binaryOnPath.js'
import type { openPreparedPaste } from '../lib/pasteArtifact.js'
import { ownProcessGroup } from '../lib/windows/noWindow.js'

type File = ReturnType<typeof openPreparedPaste>
export interface ClipboardOwner {
  ready: Promise<PasteClipboardResult>
  settled: Promise<void>
  cancel(): void
}

export function isWsl(env: NodeJS.ProcessEnv = process.env, kernel = release()): boolean {
  return !!env.WSL_DISTRO_NAME || /microsoft/i.test(kernel)
}

/** No conversion or pathname reopen: the inherited descriptor supplies exactly the published PNG. */
export function macClipboardScript(privateBoard?: string): string {
  return `ObjC.import('Foundation'); ObjC.import('AppKit');
const handle = $.NSFileHandle.alloc.initWithFileDescriptorCloseOnDealloc(0, true);
const data = handle.readDataOfLength(8388609); handle.closeFile;
if (Number(data.length) < 1 || Number(data.length) > 8388608) throw Error('PASTE_IMAGE_LIMIT');
const board = ${privateBoard === undefined ? '$.NSPasteboard.generalPasteboard' : `$.NSPasteboard.pasteboardWithName($(${JSON.stringify(privateBoard)}))`};
if (typeof board.setDataForType !== 'function') throw Error('PASTE_CLIPBOARD_UNAVAILABLE');
board.clearContents;
if (!board.setDataForType(data, $('public.png'))) throw Error('PASTE_CLIPBOARD_FAILED');`
}

// The existing tied-process pattern, with clipboard-specific settlement: a selection owner can fork
// after readiness. Keep the watcher alive until its inherited pipes end, not merely launcher exit.
// The watcher keeps this process group owned even after its original leader exits.
const OWNER = '{ read -r _ <&3 || kill -KILL -$$; } </dev/null >/dev/null 2>&1 & exec 3<&-; exec "$0" "$@"'

export function startClipboardOwner(file: File, options: {
  platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; kernel?: string
  /** A private named board for native fixtures; production always leaves this unset. */
  privateBoard?: string
} = {}): ClipboardOwner {
  const platform = options.platform ?? process.platform, env = options.env ?? process.env
  let command: string | null = null, args: string[] = []
  if (platform === 'darwin') { command = '/usr/bin/osascript'; args = ['-l', 'JavaScript', '-e', macClipboardScript(options.privateBoard)] }
  else if (platform === 'linux' && !isWsl(env, options.kernel)) {
    if (env.WAYLAND_DISPLAY) { command = resolveBinaryOnPath('wl-copy', env); args = ['--type', 'image/png'] }
    else if (env.DISPLAY) { command = resolveBinaryOnPath('xclip', env); args = ['-selection', 'clipboard', '-t', 'image/png', '-i'] }
  }
  if (!command) {
    try { file.close() } catch {
      // Do not retry a possibly recycled descriptor or pretend its reservation was released.
      return { ready: Promise.resolve({ state: 'failed', reason: 'PASTE_CLIPBOARD_FD_CLOSE_FAILED' }),
        settled: new Promise<void>(() => {}), cancel() {} }
    }
    return { ready: Promise.resolve({ state: 'unavailable', reason: 'PASTE_CLIPBOARD_UNAVAILABLE' }), settled: Promise.resolve(), cancel() {} }
  }
  let answer!: (result: PasteClipboardResult) => void, finish!: () => void
  const ready = new Promise<PasteClipboardResult>((resolve) => { answer = resolve })
  const settled = new Promise<void>((resolve) => { finish = resolve })
  let child: ChildProcess | undefined, failure: string | undefined, ended = false, exited = false, stdoutEnded = false, stderrEnded = false
  let descriptorUnconfirmed = false, terminating = false, watcherReleased = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const kill = () => {
    if (ended || terminating || watcherReleased || !child?.pid) return
    terminating = true
    // The live watcher owns this group until its tie is released; no unrelated PID is selected.
    try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        failure = 'PASTE_CLIPBOARD_STOP_FAILED'; console.warn(`[paste] PASTE_CLIPBOARD_STOP_FAILED · ${errorKind(error)}`)
      }
    }
  }
  const cancel = () => { failure ??= 'PASTE_CANCELLED'; answer({ state: 'failed', reason: failure }); kill() }
  try {
    if (!file.current()) throw new Error('PASTE_INVALID_ARTIFACT')
    child = spawn('/bin/sh', ['-c', OWNER, command, ...args], {
      ...ownProcessGroup(platform), env, stdio: [file.descriptor, 'pipe', 'pipe', 'pipe'],
    })
  } catch {
    failure = 'PASTE_CLIPBOARD_FAILED'
  } finally {
    // This parent descriptor is closed once immediately after spawn; the child has its own copy.
    try { file.close() } catch { failure = 'PASTE_CLIPBOARD_FD_CLOSE_FAILED'; descriptorUnconfirmed = true }
  }
  if (!child) {
    answer({ state: 'failed', reason: failure! }); if (!descriptorUnconfirmed) finish()
    return { ready, settled, cancel() {} }
  }
  const owned = child, tie = owned.stdio?.[3] as Writable | undefined
  tie?.on('error', () => {})
  const releaseWatcher = () => {
    if (exited && stdoutEnded && stderrEnded && tie?.writable) { watcherReleased = true; tie.end('\n') }
  }
  let outputBytes = 0
  for (const [name, stream] of [['stdout', owned.stdout], ['stderr', owned.stderr]] as const) {
    if (!stream) { if (name === 'stdout') stdoutEnded = true; else stderrEnded = true; continue }
    stream.on('data', (bytes: Buffer) => {
      outputBytes += bytes.byteLength
      if (outputBytes > 64 * 1024) { failure = 'PASTE_CLIPBOARD_OUTPUT_LIMIT'; cancel() }
    })
    stream.once('end', () => { if (name === 'stdout') stdoutEnded = true; else stderrEnded = true; releaseWatcher() })
  }
  owned.once('error', () => { failure ??= 'PASTE_CLIPBOARD_FAILED'; answer({ state: 'failed', reason: failure }); kill() })
  owned.once('exit', (code) => {
    exited = true; clearTimeout(timer)
    if (code !== 0) failure ??= 'PASTE_CLIPBOARD_FAILED'
    answer(failure ? { state: 'failed', reason: failure } : { state: 'written' })
    releaseWatcher()
  })
  owned.once('close', () => {
    ended = true; clearTimeout(timer)
    answer({ state: 'failed', reason: failure ?? 'PASTE_CLIPBOARD_FAILED' })
    if (!descriptorUnconfirmed) finish()
  })
  timer = setTimeout(() => { failure = 'PASTE_CLIPBOARD_TIMEOUT'; cancel() }, 5_000)
  timer.unref()
  if (failure) cancel()
  return { ready, settled, cancel }
}
