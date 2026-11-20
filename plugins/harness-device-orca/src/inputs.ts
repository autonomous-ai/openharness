// What the loop reads of the world, so its tests can hand it their own. Nothing of `orca` is loaded here: the end to
// end test runs this file outside Orca.
import { execFile } from 'node:child_process'
import { watch as watchFolder, type FSWatcher } from 'node:fs'
import { request, type IncomingMessage, type RequestOptions } from 'node:http'
import { homedir } from 'node:os'
import { pipeAuth, pipeNonce, pipeProven } from './pipeAuth'

const AUTH_HEADER = 'x-harness-auth'
const PROOF_HEADER = 'x-harness-proof'

/** A file that is not there: not a string, so no launcher's stdout reads as it. */
export const MISSING = Symbol('missing')
/** MISSING, its stdout when it exited 0 inside the bounds, or null for any other end. */
export type Ran = typeof MISSING | string | null
export interface Answer { status: number; chunks: AsyncIterable<Uint8Array> }
/** Where the devices listen: their Unix socket, or on Windows their pipe and the token its requests and answers prove. */
export type Target = { socket: string } | { pipe: string; token: string }
export interface DialInputs {
  platform: string
  /** '' when there is none. */
  home: string
  path: string
  /** Run in `cwd`, which on Windows is also looked in for a bare `file` before `path`. */
  run(file: string, args: readonly string[], bounds: { path: string; cwd: string; timeoutMs: number; maxBytes: number; signal: AbortSignal }): Promise<Ran>
  /** POST `body` to `/` on the target. Null when it cannot connect, is aborted before the answer's head, or a pipe's
   *  answer does not prove the token. */
  connect(target: Target, body: string, signal: AbortSignal): Promise<Answer | null>
  /** POST `body` to `/` on the target, on a connection of its own. The answer's status, its body drained and dropped.
   *  Null when it cannot connect, is aborted before the answer's head, or a pipe's answer does not prove the token. */
  post(target: Target, body: string, signal: AbortSignal): Promise<number | null>
  /** `changed` gets the entry's name, or null where the platform gives none. `failed` is told once if the watch cannot
   *  start (before this returns) or stops on its own. Returns its close. */
  watch(folder: string, changed: (name: string | null) => void, failed: () => void): () => void
  /** Monotonic milliseconds. */
  now(): number
  after(ms: number, run: () => void): () => void
}

export function nodeInputs(): DialInputs {
  return {
    platform: process.platform,
    home: homeOrNone(),
    path: process.env.PATH ?? '',
    run(file, args, { path, cwd, timeoutMs, maxBytes, signal }) {
      return new Promise((settle) => {
        execFile(
          file,
          args,
          // A bare name is looked up in the child's PATH, so the given one decides which file runs. On Windows the
          // launcher is a console program: hidden, so no window flashes up at each look.
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
        const { options, proven } = endpoint(target)
        const req = request({ ...options, method: 'POST', path: '/', signal })
        // Before the head this settles null; after it, settling again does nothing and the chunks end instead.
        req.on('error', () => settle(null))
        req.on('response', (res) => {
          res.on('error', () => {})
          if (!proven(res)) return settle(dropped(res))
          settle({ status: res.statusCode ?? 0, chunks: untilEnd(res) })
        })
        req.end(body)
      })
    },
    post(target, body, signal) {
      return new Promise((settle) => {
        const { options, proven } = endpoint(target)
        // No shared agent: each message closes its own connection, so none is left open on the devices' socket.
        const req = request({ ...options, method: 'POST', path: '/', signal, agent: false })
        req.on('error', () => settle(null))
        req.on('response', (res) => {
          res.on('error', () => {})
          if (!proven(res)) return settle(dropped(res))
          res.resume()
          settle(res.statusCode ?? 0)
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
  }
}

// Over a pipe each request proves the token with a nonce of its own, and an answer that does not prove it back comes
// from whatever took the pipe's name.
function endpoint(target: Target): { options: RequestOptions; proven(res: IncomingMessage): boolean } {
  if ('socket' in target) return { options: { socketPath: target.socket }, proven: () => true }
  const { pipe, token } = target
  const nonce = pipeNonce(pipe)
  return {
    options: { socketPath: pipe, headers: { [AUTH_HEADER]: pipeAuth(token, nonce) } },
    proven: (res) => pipeProven(res.headers[PROOF_HEADER], token, nonce),
  }
}

// An answer without the proof is closed before a byte of its body is read.
function dropped(res: IncomingMessage): null {
  res.destroy()
  return null
}

// os.homedir() throws where neither HOME nor the account database names one.
function homeOrNone(): string {
  try {
    return homedir()
  } catch {
    return ''
  }
}

// An abort or a reset after the head ends the answer like its close: the loop reads both the same way.
async function* untilEnd(res: IncomingMessage): AsyncGenerator<Uint8Array> {
  try {
    for await (const chunk of res) yield chunk
  } catch {}
}
