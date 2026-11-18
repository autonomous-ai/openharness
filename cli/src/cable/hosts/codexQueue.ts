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
 */
import { execFile } from 'node:child_process'
import { delimiter } from 'node:path'
import { resolveBinaryOnPath } from '../../lib/binaryOnPath.js'
import { engineBin } from '../../lib/engineBin.js'
import { loginShellEnvironment, oneShotParentEnv, warmLoginShellEnvironment } from '../../lib/loginShellEnv.js'
import { MAX_TEXT } from './orca.js'

// `--thread` also takes a session's name: only a thread id may reach it.
export const CODEX_THREAD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const QUEUE_TIMEOUT_MS = 10_000
/** How long one look for codex holds. The dial's list asks can() for each queue-able Codex row on every 1 s tick while a
 *  dial is connected, and a walk of a 63-folder PATH took 0.24 to 0.36 ms with codex on it and 0.7 ms without (this Mac,
 *  2026-11-15). A look is at most two walks, the login shell's PATH then the daemon's. A codex installed or removed is
 *  seen within it, with no restart. */
const BINARY_LOOK_MS = 30_000

/** Why a send failed, as the log line names it: codex's exit code; 'no binary' when it is not there or could not
 *  start; 'refused' for a thread id or a text the queue will not run. */
export type CodexQueueFailure = `exit ${number}` | 'no binary' | 'refused'
export type CodexQueueResult =
  | { outcome: 'queued' | 'timeout' | 'busy' }
  | { outcome: 'failed'; reason: CodexQueueFailure }
/** Its exit code; 'not-started' when the binary could not start; 'unknown' for every other ending. */
export type CodexRunEnd = number | 'not-started' | 'unknown'

export interface CodexQueueDeps {
  run(file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<CodexRunEnd>
  /** The Codex Harness launches, where it is; null when it is not there. */
  binary(): string | null
  /** What a run starts from: the environment a launch has. */
  parentEnv(): NodeJS.ProcessEnv
  /** Starts the read of the login shell's environment. Never throws. */
  readLoginShell(): void
  platform: NodeJS.Platform
  home: string
  cwd: string
}

export interface CodexQueue { can(): boolean; send(threadId: string, text: string): Promise<CodexQueueResult> }

export function codexQueueDeps(): Omit<CodexQueueDeps, 'home' | 'cwd'> {
  // The last look, on the monotonic clock: a wall clock set back would keep an old answer for as long.
  let looked: { at: number; path: string | null } | undefined
  return {
    run: (file, args, { cwd, env, timeoutMs }) => new Promise((resolve) => {
      // The timeout's kill waits for the process to exit, and one stuck where even SIGKILL waits would keep its thread
      // busy for good: the deadline answers by itself.
      const deadline = setTimeout(() => resolve('unknown'), timeoutMs)
      const end = (how: CodexRunEnd) => { clearTimeout(deadline); resolve(how) }
      try {
        const child = execFile(file, args, { cwd, env: { ...process.env, ...env }, timeout: timeoutMs, killSignal: 'SIGKILL' }, (error) => {
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
    binary: () => {
      const now = performance.now()
      if (!looked || now - looked.at >= BINARY_LOOK_MS) {
        const name = engineBin('codex')
        looked = { at: now, path: resolveBinaryOnPath(name, { PATH: loginShellEnvironment().PATH }) ?? resolveBinaryOnPath(name) }
      }
      return looked.path
    },
    // PATH in the order codex was looked for. An empty segment is the folder the program runs in, the home folder, where
    // `env` would look for `node`: a side that has none adds none, and with neither there is no PATH, so the system's
    // default is searched.
    parentEnv: () => ({
      ...oneShotParentEnv(),
      PATH: [loginShellEnvironment().PATH, process.env.PATH].filter(Boolean).join(delimiter) || undefined,
    }),
    // A look taken before the read saw the daemon's PATH alone: it holds only until the read ends. The read answers {}
    // on every failure and never rejects.
    readLoginShell: () => { void warmLoginShellEnvironment().then(() => { looked = undefined }) },
    platform: process.platform,
  }
}

export function createCodexQueue(deps: CodexQueueDeps): CodexQueue {
  // Per thread, the words being queued: two transcripts queued at once could land out of order.
  const queueing = new Set<string>()
  let loginShellAsked = false
  const binary = (): string | null => {
    // Never on Windows: codex is a .cmd shim there, which runs only through a shell, and the text must never meet one.
    if (deps.platform === 'win32') return null
    // On first use, never at start: the interactive shell can take its 5 s, and a computer whose dial never meets a
    // Codex session never pays for it. Until it is read, the daemon's environment is used.
    if (!loginShellAsked) {
      loginShellAsked = true
      deps.readLoginShell()
    }
    return deps.binary()
  }

  return {
    can: () => binary() !== null,
    async send(threadId, text) {
      if (!CODEX_THREAD.test(threadId) || text === '' || text.length > MAX_TEXT || text.includes('\0')) {
        return { outcome: 'failed', reason: 'refused' }
      }
      // Busy queues nothing: the dial asks again, never stacked behind.
      if (queueing.has(threadId)) return { outcome: 'busy' }
      const codex = binary()
      if (!codex) return { outcome: 'failed', reason: 'no binary' }
      queueing.add(threadId)
      try {
        // The home folder, so no project's .codex/ config is read. Joined to its flag: a text that starts with -- is
        // never read as a flag.
        const end = await deps.run(codex, ['queue', '--thread', threadId, `--message=${text}`],
          { cwd: deps.cwd, env: { ...deps.parentEnv(), CODEX_HOME: deps.home }, timeoutMs: QUEUE_TIMEOUT_MS })
        if (end === 0) return { outcome: 'queued' }
        if (typeof end === 'number') return { outcome: 'failed', reason: `exit ${end}` }
        if (end === 'not-started') return { outcome: 'failed', reason: 'no binary' }
        // It may have queued: never a definite failure, so nothing is typed after it.
        return { outcome: 'timeout' }
      } finally {
        queueing.delete(threadId)
      }
    },
  }
}
