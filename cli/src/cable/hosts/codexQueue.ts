/**
 * Puts the dial's words in a Codex thread's queue with `codex queue`: Codex runs them as the thread's next turn when it is
 * free, and they never touch its terminal, where a `y` or an Enter could answer an approval. The thread id came from a
 * hook and the text from the dial, so both are checked here, and `codex` runs with no shell: the text is one argument,
 * never a command line. Codex's output is never read, and this file logs nothing: Codex's own error text names the thread
 * and the home. A failure's reason travels in the result, for the one line the observed source writes.
 *
 * It runs the `codex` a launch would, under the environment a launch has: the daemon runs under launchd (or is started by
 * an app) and never read the person's shell profile, while a launch takes its PATH from the person's interactive shell.
 * The `codex` npm installs is `#!/usr/bin/env node`, and `env` exits 127 when no `node` is on PATH, which is the daemon's
 * normal case: every word a person spoke to Codex failed with exit 127
 * (docs/plans/2026-11-18-dial-chatgpt-pick-and-voice-design.md, cause 2). So the login shell's PATH is looked in first,
 * and the run's PATH puts it first too: the `node` it asks for comes from where `codex` came from.
 *
 * A session in the ChatGPT app runs the app's own Codex CLI, on macOS, when it is there: a native program of the app's
 * own version, which queues into the app's threads with no PATH, no node and no shell (the design's part B).
 */
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { binaryOnPath, resolveBinaryOnPath } from '../../lib/binaryOnPath.js'
import { engineBin } from '../../lib/engineBin.js'
import { loginShellEnvironment, oneShotParentEnv, warmLoginShellEnvironment } from '../../lib/loginShellEnv.js'
import { MAX_TEXT } from './orca.js'

// `--thread` also takes a session's name: only a thread id may reach it.
export const CODEX_THREAD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const QUEUE_TIMEOUT_MS = 10_000
/** How long one look for codex holds. The dial's list asks can() for each queue-able Codex row on every 1 s tick while a
 *  dial is connected, and a walk of a 63-folder PATH took 0.24 to 0.36 ms with codex on it and 0.7 ms without (this Mac,
 *  2026-11-15). A look is at most two walks, the login shell's PATH then the daemon's, after the app's two places for a
 *  session in the ChatGPT app: one walk took 0.35 ms at the median, and an app session's look with no app CLI and no
 *  codex on two 63-folder PATHs 0.70 ms; with the app's CLI there, 0.016 ms (this Mac, 2026-11-18, 1,000 looks each).
 *  A codex installed or removed is seen within it, with no restart. */
const BINARY_LOOK_MS = 30_000

/** Where the ChatGPT app keeps its own Codex CLI, inside the app. */
const APP_CODEX = join('ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex')

/** Why a send failed, as the log line names it: codex's exit code; 'no binary' when it is not there or could not
 *  start; 'refused' for a thread id or a text the queue will not run. */
export type CodexQueueFailure = `exit ${number}` | 'no binary' | 'refused'
/** Which codex a send chose, as the log names it: the ChatGPT app's own, or the one a launch would run. */
export type CodexRan = 'app' | 'path'
export type CodexQueueResult =
  | { outcome: 'queued' | 'timeout' | 'busy' }
  // Refused before any codex was chosen.
  | { outcome: 'failed'; reason: 'refused' }
  | { outcome: 'failed'; reason: Exclude<CodexQueueFailure, 'refused'>; ran: CodexRan }
/** Its exit code; 'not-started' when the binary could not start; 'unknown' for every other ending. */
export type CodexRunEnd = number | 'not-started' | 'unknown'

export interface CodexQueueDeps {
  /** [env] is the run's whole environment: `parentEnv()` already holds the daemon's. */
  run(file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<CodexRunEnd>
  /** The Codex Harness launches, where it is; null when it is not there. */
  binary(): string | null
  /** The ChatGPT app's own Codex CLI, where it can run; null when it is not there. Asked on macOS only. */
  appBinary(): string | null
  /** What a run starts from: the environment a launch has. */
  parentEnv(): NodeJS.ProcessEnv
  /** Starts the read of the login shell's environment. Never throws. */
  readLoginShell(): void
  platform: NodeJS.Platform
  home: string
  cwd: string
}

/** [isApp]: the session is the ChatGPT app's. */
export interface CodexQueue {
  can(isApp: boolean): boolean
  send(threadId: string, text: string, isApp: boolean): Promise<CodexQueueResult>
}

/**
 * Where the ChatGPT app's own Codex CLI may be, in order: the app in /Applications, then in ~/Applications, or the
 * absolute path HARNESS_CODEX_APP_BIN names, alone. That is for the end-to-end tests, as HARNESS_ORCA_APP_BIN is
 * (devices/orcaHomes.ts): /Applications is the computer's, whatever the home, so their harness points it at a fake
 * (e2e/harness/daemon.ts) and a daemon under test never runs the developer's app. A relative one is never looked up.
 */
export function appCodexCandidates(named: string | undefined, home: string): string[] {
  if (named && isAbsolute(named)) return [named]
  return [join('/Applications', APP_CODEX), join(home, 'Applications', APP_CODEX)]
}

export function codexQueueDeps(): Omit<CodexQueueDeps, 'home' | 'cwd'> {
  // The last look of each, on the monotonic clock: a wall clock set back would keep an old answer for as long.
  const looks = new Map<CodexRan, { at: number; path: string | null }>()
  const held = (which: CodexRan, look: () => string | null): string | null => {
    const now = performance.now()
    let last = looks.get(which)
    if (!last || now - last.at >= BINARY_LOOK_MS) looks.set(which, last = { at: now, path: look() })
    return last.path
  }
  return {
    run: (file, args, { cwd, env, timeoutMs }) => new Promise((resolve) => {
      // The timeout's kill waits for the process to exit, and one stuck where even SIGKILL waits would keep its thread
      // busy for good: the deadline answers by itself.
      const deadline = setTimeout(() => resolve('unknown'), timeoutMs)
      const end = (how: CodexRunEnd) => { clearTimeout(deadline); resolve(how) }
      try {
        const child = execFile(file, args, { cwd, env, timeout: timeoutMs, killSignal: 'SIGKILL' }, (error) => {
          if (error === null) end(0)
          else if (typeof error.code === 'number') end(error.code)
          // No pid: it never started (ENOENT, EACCES). With one, a signal or too much output ended it, maybe after it
          // queued: no definite failure.
          else end(child.pid === undefined ? 'not-started' : 'unknown')
        })
        // Nothing is piped to codex: one that read its stdin would wait out the deadline.
        child.stdin?.end()
      } catch {
        // An argument execFile refuses (a NUL) throws before any child.
        end('not-started')
      }
    }),
    // As a launch finds it: CODEX_PATH, else codex, on the login shell's PATH, then on the daemon's. A CODEX_PATH that
    // names a path is that path in both looks, so one that is gone finds nothing, as a launch would. A path that went
    // since its look does not start: a definite failure, so today's route answers.
    binary: () => held('path', () => {
      const name = engineBin('codex')
      return resolveBinaryOnPath(name, { PATH: loginShellEnvironment().PATH }) ?? resolveBinaryOnPath(name)
    }),
    // A file there that cannot run is passed over: it would not start.
    appBinary: () => held('app', () => appCodexCandidates(process.env.HARNESS_CODEX_APP_BIN, homedir()).find((path) => binaryOnPath(path)) ?? null),
    // PATH in the order codex was looked for. An empty segment is the folder the program runs in, the home folder, where
    // `env` would look for `node`: none is kept, from a side that has no PATH or from inside one, and with no segment
    // left there is no PATH, so the system's default is searched.
    parentEnv: () => ({
      ...oneShotParentEnv(),
      PATH: [loginShellEnvironment().PATH, process.env.PATH].flatMap((path) => (path ?? '').split(delimiter))
        .filter(Boolean).join(delimiter) || undefined,
    }),
    // A look taken before the read saw the daemon's PATH alone: it holds only until the read ends, and the app's with it,
    // so every look after the read is a fresh one. The read answers {} on every failure and never rejects.
    readLoginShell: () => { void warmLoginShellEnvironment().then(() => { looks.clear() }) },
    platform: process.platform,
  }
}

export function createCodexQueue(deps: CodexQueueDeps): CodexQueue {
  // Per thread, the words being queued: two transcripts queued at once could land out of order.
  const queueing = new Set<string>()
  let loginShellAsked = false
  const choose = (isApp: boolean): { file: string; ran: CodexRan } | null => {
    // Never on Windows: codex is a .cmd shim there, which runs only through a shell, and the text must never meet one.
    if (deps.platform === 'win32') return null
    // On first use, never at start: the interactive shell can take its 5 s, and a computer whose dial never meets a
    // Codex session never pays for it. Until it is read, the daemon's environment is used.
    if (!loginShellAsked) {
      loginShellAsked = true
      deps.readLoginShell()
    }
    // The ChatGPT app is macOS's alone.
    const app = isApp && deps.platform === 'darwin' ? deps.appBinary() : null
    if (app) return { file: app, ran: 'app' }
    const path = deps.binary()
    return path ? { file: path, ran: 'path' } : null
  }

  return {
    can: (isApp) => choose(isApp) !== null,
    async send(threadId, text, isApp) {
      if (!CODEX_THREAD.test(threadId) || text === '' || text.length > MAX_TEXT || text.includes('\0')) {
        return { outcome: 'failed', reason: 'refused' }
      }
      // Busy queues nothing: the dial asks again, never stacked behind.
      if (queueing.has(threadId)) return { outcome: 'busy' }
      const codex = choose(isApp)
      // The look for the other codex, the last one taken, found nothing.
      if (!codex) return { outcome: 'failed', reason: 'no binary', ran: 'path' }
      queueing.add(threadId)
      try {
        // The home folder, so no project's .codex/ config is read. Joined to its flag: a text that starts with -- is
        // never read as a flag. One run a send: an app codex that fails is never followed by the other, so the words
        // never run twice.
        const end = await deps.run(codex.file, ['queue', '--thread', threadId, `--message=${text}`],
          { cwd: deps.cwd, env: { ...deps.parentEnv(), CODEX_HOME: deps.home }, timeoutMs: QUEUE_TIMEOUT_MS })
        if (end === 0) return { outcome: 'queued' }
        if (typeof end === 'number') return { outcome: 'failed', reason: `exit ${end}`, ran: codex.ran }
        if (end === 'not-started') return { outcome: 'failed', reason: 'no binary', ran: codex.ran }
        // It may have queued: never a definite failure, so nothing is typed after it.
        return { outcome: 'timeout' }
      } finally {
        queueing.delete(threadId)
      }
    },
  }
}
