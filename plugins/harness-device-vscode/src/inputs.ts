// What the loop reads of the world, so its tests can hand it their own. Nothing of `vscode` is loaded here: the end to
// end test runs this file outside VS Code. VS Code 1.75's extension host is Node 16: nothing newer is used.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { watch as watchFolder, type FSWatcher } from 'node:fs'
import { request, type IncomingMessage } from 'node:http'
import { homedir } from 'node:os'
import { AUTH_HEADER, PROOF_HEADER, pipeAuth, pipeNonce, pipeProven } from './pipeAuth'

/** A file that is not there: not a string, so no launcher's stdout reads as it. */
export const MISSING = Symbol('missing')
/** MISSING, its stdout when it exited 0 inside the bounds, or null for any other end. */
export type Ran = typeof MISSING | string | null
export interface Answer { status: number; chunks: AsyncIterable<Uint8Array> }
/** Where the devices listen: their Unix socket, or on Windows their pipe and the token each request there proves. */
export type Target = { socket: string } | { pipe: string; token: string }
export interface LoopInputs {
  platform: string
  /** '' when there is none. */
  home: string
  path: string
  /** Run in `cwd`, which on Windows is also looked in for a bare `file` before `path`. */
  run(file: string, args: readonly string[], bounds: { path: string; cwd: string; timeoutMs: number; maxBytes: number; signal: AbortSignal }): Promise<Ran>
  /** POST `body` to `/` on the target and hold its answer open. Null when it cannot connect, a pipe's answer does not
   *  prove the token, or it is aborted before the head. */
  connect(target: Target, body: string, signal: AbortSignal): Promise<Answer | null>
  /** POST `body` to `/` on a connection of its own, `Connection: close`, no keep-alive agent; the status, its body read
   *  to the end, or null, as for a pipe's answer that does not prove the token. */
  post(target: Target, body: string, signal: AbortSignal): Promise<number | null>
  /** `changed` gets the entry's name, or null where the platform gives none. `failed` is told once if the watch cannot
   *  start (before this returns) or stops on its own. Returns its close. */
  watch(folder: string, changed: (name: string | null) => void, failed: () => void): () => void
  /** Monotonic milliseconds. */
  now(): number
  after(ms: number, run: () => void): () => void
  /** The window's id, made once per activation: a random UUID. */
  windowId: string
}

export function nodeInputs(): LoopInputs {
  return {
    platform: process.platform,
    home: homeOrNone(),
    path: process.env.PATH ?? '',
    run(file, args, { path, cwd, timeoutMs, maxBytes, signal }) {
      return new Promise((settle) => {
        execFile(
          file,
          args,
          // A bare name is looked up in the child's PATH, so the given one decides which file runs. Hidden: on Windows
          // a console program started by the extension host, which has no console, would flash one up.
          { cwd, env: { ...process.env, PATH: path }, timeout: timeoutMs, maxBuffer: maxBytes, killSignal: 'SIGKILL', signal, windowsHide: true },
          (error, stdout) => {
            if (!error) settle(stdout)
            else settle((error as NodeJS.ErrnoException).code === 'ENOENT' ? MISSING : null)
          }
        )
      })
    },
    connect(target, body, signal) {
      return new Promise((settle) => {
        const { socketPath, headers, proven } = route(target)
        const req = request({ socketPath, method: 'POST', path: '/', headers, signal })
        // Before the head this settles null; after it, settling again does nothing and the chunks end instead.
        req.on('error', () => settle(null))
        req.on('response', (res) => {
          res.on('error', () => {})
          if (!proven(res)) return dropped(res, settle)
          settle({ status: res.statusCode ?? 0, chunks: untilEnd(res) })
        })
        req.end(body)
      })
    },
    post(target, body, signal) {
      return new Promise((settle) => {
        const { socketPath, headers, proven } = route(target)
        // No agent: the connection is this message's alone, so it never holds one of the listener's slots after it.
        const req = request({ socketPath, method: 'POST', path: '/', agent: false, headers: { ...headers, Connection: 'close' }, signal })
        req.on('error', () => settle(null))
        req.on('response', (res) => {
          // 'close' comes after 'end', so it settles null only for an answer cut short.
          res.on('error', () => settle(null))
          if (!proven(res)) return dropped(res, settle)
          res.on('end', () => settle(res.statusCode ?? null))
          res.on('close', () => settle(null))
          res.resume()
        })
        req.end(body)
      })
    },
    watch(folder, changed, failed) {
      let watcher: FSWatcher
      try {
        watcher = watchFolder(folder, (_event, name) => changed(name))
      } catch {
        failed()
        return () => {}
      }
      watcher.on('error', () => {
        watcher.close()
        failed()
      })
      return () => watcher.close()
    },
    now: () => performance.now(),
    after(ms, run) {
      const timer = setTimeout(run, ms)
      timer.unref()
      return () => clearTimeout(timer)
    },
    windowId: randomUUID(),
  }
}

// os.homedir() throws where neither HOME nor the account database names one.
function homeOrNone(): string {
  try {
    return homedir()
  } catch {
    return ''
  }
}

// A request's way in, and its check of the answer. Only this account reaches the socket's folder; a pipe's name proves
// nothing, so a request there carries the token's auth and its answer must carry the proof.
function route(target: Target): { socketPath: string; headers: Record<string, string>; proven(res: IncomingMessage): boolean } {
  if ('socket' in target) return { socketPath: target.socket, headers: {}, proven: () => true }
  const { pipe, token } = target
  const nonce = pipeNonce(pipe)
  return {
    socketPath: pipe,
    headers: { [AUTH_HEADER]: pipeAuth(token, nonce) },
    proven: (res) => pipeProven(res.headers[PROOF_HEADER], token, nonce),
  }
}

// An answer that does not prove the token is not the devices': closed before a byte of its body is read.
function dropped(res: IncomingMessage, settle: (value: null) => void): void {
  res.destroy()
  settle(null)
}

// An abort or a reset after the head ends the answer like its close: the loop reads both the same way.
async function* untilEnd(res: IncomingMessage): AsyncGenerator<Uint8Array> {
  try {
    for await (const chunk of res) yield chunk
  } catch {}
}
