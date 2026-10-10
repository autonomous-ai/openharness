/**
 * Memory: what the agents on this machine remember, for the owner's Memories panes on their other machines
 * (store/agents/memories), and the About You profile and its on/off choice from them. An experiment
 * (core/api.ts `EXPERIMENTS`): its own process, started at the first request, nothing loaded before.
 *
 * - `memory_snapshot`: this machine's memories, agents, About You and activity, as the Memories package's
 *   `mem snapshot --json` reads them.
 * - `memory_about_put` `{ text, gen }`: another machine's About You, written here with that build's number
 *   (`mem about write --gen`); the package refuses one older than what is here, and refreshes this
 *   machine's agents' copies when delivery is on.
 * - `memory_deliver` `{ on, choiceAt }`: the person's on/off choice from another machine, applied with its
 *   own time (`mem deliver on|off --choice-at`); the package ignores one older than the choice here.
 *
 * The daemon never reads an agent's memory itself and loads no package code: it runs the package's own
 * command, as the package's pane does, so there is one reader of those folders and one writer of About
 * You. Each run is bounded in time and output. Only the owner may ask: a device or an observer may not.
 */
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { CoreApi, ServiceRequests } from '../core/api.js'
import { MEMORIES_ID } from '../dsh/builtinIds.js'
import { installedDsh } from '../dsh/installed.js'

/** The requests memory answers for the apps, declared in core/api.ts for the core to route. */
export { MEMORY_REQUESTS } from '../core/api.js'

/** The bridge drops a frame past 8 MB; `mem snapshot` keeps itself under 4 MB. */
const MAX_OUTPUT = 8 * 1024 * 1024
/** Under the core's 30 s wait for a routed answer: a slow run is told as this service's failure, with its
 *  reason, not as the service being down. */
const TIMEOUT_MS = 25_000
const MAX_ABOUT = 64 * 1024
/** `node:sqlite`, which the package reads the session index with, and `--disable-warning`. */
const NODE_MAJOR = 22

export interface MemoryDeps {
  /** The installed Memories package's folder, or null when it is not installed here. */
  packageDir(): string | null
  /** Run the package's `mem` with these arguments (and this standard input): its output, or an error. */
  run(dir: string, args: string[], input?: string): Promise<{ stdout: string }>
}

/** What `mem` is run with: this process's environment without the daemon's own credentials. */
export function memEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('HARNESSD_')))
}

export function runMem(dir: string, args: string[], input?: string, node: string = process.versions.node, timeoutMs: number = TIMEOUT_MS): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    if (Number(node.split('.')[0]) < NODE_MAJOR) { reject(new Error(`Memories needs Node ${NODE_MAJOR} or newer; this Harness runs on ${node}.`)); return }
    // This process's own Node: the one Harness ships, which has the built-in SQLite the package reads the
    // session index with. Its experimental warning would only reach the log.
    const child = execFile(process.execPath, ['--disable-warning=ExperimentalWarning', join(dir, 'toolchain', 'mem.mjs'), ...args],
      { cwd: dir, timeout: timeoutMs, maxBuffer: MAX_OUTPUT, env: memEnv() },
      (error, stdout, stderr) => {
        if (!error) { resolve({ stdout }); return }
        // `mem deliver` exits 1 when one agent's file could not be written (a linked folder, say) and still
        // prints what it did for every agent: that answer is the truth, not a failure of the whole request.
        if (stdout.trim().startsWith('{')) { try { JSON.parse(stdout); resolve({ stdout }); return } catch { /* not an answer */ } }
        const said = String(stderr).trim().split('\n').slice(-1)[0]
        reject(new Error((said || `mem stopped (${error.killed ? 'too slow' : `exit ${error.code ?? 'unknown'}`})`).slice(0, 300)))
      })
    child.stdin?.end(input ?? '')
  })
}

const DEFAULTS: MemoryDeps = {
  packageDir: () => installedDsh(MEMORIES_ID)?.dir ?? null,
  run: runMem,
}

const failed = (error: unknown): Record<string, unknown> =>
  ({ error: 'MEMORY_FAILED', detail: error instanceof Error ? error.message : String(error) })

export function startMemory(_core: CoreApi, deps: MemoryDeps = DEFAULTS): ServiceRequests {
  // Writes one at a time: two machines' panes can send a choice or a profile at the same moment, and each
  // run reads and rewrites the same files. In order, "never older over newer" holds; side by side, an older
  // choice could land last. Snapshots asked for together share one read.
  // `mem` below never rejects (a failure is an answer), so the chain never breaks.
  let writes: Promise<unknown> = Promise.resolve()
  const queued = <T>(work: () => Promise<T>): Promise<T> => {
    const result = writes.then(work)
    writes = result
    return result
  }
  let reading: Promise<Record<string, unknown>> | null = null
  const mem = async (args: string[], input?: string): Promise<Record<string, unknown>> => {
    const dir = deps.packageDir()
    if (!dir) return { error: 'MEMORIES_NOT_INSTALLED', detail: 'Memories is not installed on this machine.' }
    try {
      const { stdout } = await deps.run(dir, args, input)
      return { ok: true, value: JSON.parse(stdout) as unknown }
    } catch (error) { return failed(error) }
  }
  return {
    memory_snapshot: async (_payload, asker) => {
      if (!asker.owner) return { error: 'OWNER_REQUIRED' }
      reading ??= mem(['snapshot', '--json']).finally(() => { reading = null })
      const answer = await reading
      return answer.ok ? { snapshot: answer.value } : answer
    },
    memory_about_put: async (payload, asker) => {
      if (!asker.owner) return { error: 'OWNER_REQUIRED' }
      const text = typeof payload.text === 'string' ? payload.text : ''
      const gen = payload.gen
      if (!text.trim() || text.length > MAX_ABOUT) return { error: 'INVALID_MEMORY', detail: 'memory_about_put needs About You text under 64 KB' }
      if (!Number.isSafeInteger(gen)) return { error: 'INVALID_MEMORY', detail: 'memory_about_put needs the build number (gen)' }
      const answer = await queued(() => mem(['about', 'write', '--gen', String(gen), '--json'], text))
      // `written: false`: a newer About You was already here, and stays.
      return answer.ok ? { ok: true, written: Boolean((answer.value as { written?: unknown }).written) } : answer
    },
    memory_deliver: async (payload, asker) => {
      if (!asker.owner) return { error: 'OWNER_REQUIRED' }
      if (typeof payload.on !== 'boolean' || !Number.isSafeInteger(payload.choiceAt) || (payload.choiceAt as number) < 1) {
        return { error: 'INVALID_MEMORY', detail: 'memory_deliver needs on and the time it was chosen (choiceAt)' }
      }
      const answer = await queued(() => mem(['deliver', payload.on ? 'on' : 'off', '--choice-at', String(payload.choiceAt), '--json']))
      return answer.ok ? { ok: true, delivery: answer.value } : answer
    },
  }
}
