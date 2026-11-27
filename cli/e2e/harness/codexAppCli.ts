/**
 * The ChatGPT app's own Codex CLI and a PATH `codex` that cannot queue, as fakes under a daemon's root: the real app and
 * a real `codex` never run.
 *
 * A word to a session of the ChatGPT app goes through the app's own CLI, and any other through the `codex` on PATH
 * (cable/hosts/codexQueue.ts). Each fake notes its queue calls in a file of its own, so a test tells which one took the
 * words, and that they ran once.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fakeEngineShim, type IsolatedDaemon } from './daemon.js'

/** Where the app's CLI notes its queue calls, under the root. */
const APP_LEDGER = 'codex-app-queue'
/** Where the PATH `codex` notes the queue calls it refuses, under the root. */
const PATH_LEDGER = 'codex-path-queue'

/** Each line of [file], parsed; none when it was never written. */
const lines = (file: string): string[] => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []

/** Writes the app's CLI where [daemon]'s devices look for it (HARNESS_CODEX_APP_BIN), before the daemon starts. */
export function writeAppCodex(daemon: IsolatedDaemon): void {
  const bin = daemon.env.HARNESS_CODEX_APP_BIN ?? ''
  const inside = relative(daemon.root, bin)
  // Anywhere else could be the developer's own ChatGPT app.
  if (!isAbsolute(bin) || inside.startsWith('..') || isAbsolute(inside)) throw new Error(`the app's codex must be inside the daemon's root, not at ${bin}`)
  mkdirSync(dirname(bin), { recursive: true })
  writeFileSync(bin, fakeEngineShim('codex', { ...daemon.engineConfig, queueLedger: APP_LEDGER }), { mode: 0o755 })
}

/** The queue calls the app's CLI took, each `{ args, codexHome }`. */
export function appQueued(daemon: IsolatedDaemon): unknown[] {
  return lines(join(daemon.root, APP_LEDGER)).map((line) => JSON.parse(line) as unknown)
}

/** A `codex queue` exiting 127, as an older `codex` with no `queue` fails, noted first. The shim runs as CommonJS, so
 *  its `exit` ends it before the fake engine is loaded. */
const QUEUE_FAILS = (ledger: string) => `if (process.argv[2] === 'queue') {
  require('node:fs').appendFileSync(${JSON.stringify(ledger)}, 'queue\\n')
  process.exit(127)
}`

/** Writes over [daemon]'s own `codex` one whose queue fails, before the daemon starts. Every other call runs the fake
 *  engine as before. */
export function writePathCodexWhoseQueueFails(daemon: IsolatedDaemon): void {
  const [shebang, ...engine] = fakeEngineShim('codex', { ...daemon.engineConfig }).split('\n')
  writeFileSync(join(daemon.root, 'bin', 'codex'), [shebang, QUEUE_FAILS(join(daemon.root, PATH_LEDGER)), ...engine].join('\n'), { mode: 0o755 })
}

/** How many queue calls the PATH `codex` refused. */
export function pathQueueRuns(daemon: IsolatedDaemon): number {
  return lines(join(daemon.root, PATH_LEDGER)).length
}
