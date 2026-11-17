/**
 * Orca's account homes, from Orca's own CLI: `orca account list --json` lists the Claude Code and Codex accounts Orca
 * manages on this computer, each with the config folder (`home`) its sessions run in. The scan and the dial skill need
 * that folder alone. The same answer names each account's email and id: personal data, outside text the dial has no use
 * for. So only `home` is read: nothing else of the answer is kept or returned, and no log line names a home or any of it.
 * The `harness device` command and the devices service both import it (docs/plans/2026-11-17-new-user-onboarding-design.md).
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { resolveBinaryOnPath } from '../lib/binaryOnPath.js'
import { ownDirectory } from './dialSkill.js'
import { listable, MAX_HOMES } from './dialSkillFiles.js'

export interface OrcaHomes { claude: string[]; codex: string[] }
export type OrcaHomesFailure = 'no orca' | 'failed' | 'timed out' | 'unreadable'
export interface OrcaHomesRead { homes: OrcaHomes; failure?: OrcaHomesFailure }
export interface OrcaBinaryDeps {
  /** The first executable [name] on PATH that [accept] takes. */
  onPath(name: string, accept: (path: string) => boolean): string | null
  exists(path: string): boolean
  platform: NodeJS.Platform
}
export interface OrcaHomesDeps extends OrcaBinaryDeps {
  /** No shell, stdin closed. Resolves within timeoutMs whatever the child does; never rejects. `code` is null for a
   *  kill, a binary that could not start or output past maxBytes. */
  run(file: string, args: string[], opts: { timeoutMs: number; maxBytes: number }): Promise<{ code: number | null; stdout: string; timedOut: boolean }>
  uid: number
}

export const ORCA_HOMES_DEADLINE_MS = 5_000
/** Five accounts print about 5 KB: 50 times that is still read, and an answer past it is none of Orca's. */
export const ORCA_HOMES_MAX_BYTES = 256 * 1024
export const ORCA_HOMES_REFRESH_MS = 5 * 60_000

const APP_ORCA = '/Applications/Orca.app/Contents/Resources/bin/orca'
/** Where Orca installs its launcher: in the app on macOS, in `resources/bin` beside its binary on Linux. */
const LAUNCHER = /\/(?:Orca\.app\/Contents\/Resources|resources)\/bin\/orca$/

const none = (): OrcaHomes => ({ claude: [], codex: [] })

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Whether [path] is Orca's own launcher, by its real path: GNOME's screen reader is /usr/bin/orca, and run with Orca's
 *  arguments it ignores them and starts. */
function orcaLauncher(path: string): boolean {
  try {
    return LAUNCHER.test(realpathSync(path))
  } catch {
    return false
  }
}

/** Orca's CLI: its launcher on PATH, else, on macOS, the app's own. */
export function orcaBinary(deps: OrcaBinaryDeps): string | null {
  return deps.onPath('orca', orcaLauncher) ?? (deps.platform === 'darwin' && deps.exists(APP_ORCA) ? APP_ORCA : null)
}

/** This computer's real `orca`. */
export function orcaHomesDeps(): OrcaHomesDeps {
  return {
    run: (file, args, { timeoutMs, maxBytes }) => new Promise((resolve) => {
      let child: ChildProcess | undefined
      const chunks: Buffer[] = []
      let size = 0
      let done = false
      const end = (code: number | null, timedOut: boolean): void => {
        if (done) return
        done = true
        clearTimeout(deadline)
        resolve({ code, stdout: code === null ? '' : Buffer.concat(chunks).toString('utf8'), timedOut })
      }
      // Killed, and answered by itself: a child stuck where even SIGKILL waits, or a grandchild holding its stdout,
      // would otherwise keep the read past its deadline.
      const stop = (timedOut: boolean): void => {
        child?.kill('SIGKILL')
        child?.stdout?.destroy()
        end(null, timedOut)
      }
      const deadline = setTimeout(() => stop(true), timeoutMs)
      try {
        // stderr is never kept: it can name paths.
        child = spawn(file, args, { stdio: ['ignore', 'pipe', 'ignore'] })
      } catch {
        // A file or argument it refuses before starting (a NUL byte) throws rather than emits.
        end(null, false)
        return
      }
      // A binary that could not start: its close follows, and says nothing more.
      child.on('error', () => end(null, false))
      child.stdout?.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) stop(false)
        else chunks.push(chunk)
      })
      child.on('close', (code: number | null) => end(code, false))
    }),
    onPath: (name, accept) => resolveBinaryOnPath(name, process.env, accept),
    exists: existsSync,
    platform: process.platform,
    // A platform with no uid owns nothing, so no home is kept there.
    uid: process.getuid?.() ?? -1,
  }
}

/** One engine's homes: each a folder of this user's, named exactly (dialSkillFiles' `listable`, so the dial skill's
 *  list never drops one), once, and at most MAX_HOMES. The walk is bounded by the answer's own bound. */
function homesOf(engine: unknown, uid: number): string[] {
  const accounts = isObject(engine) ? engine.accounts : undefined
  if (!Array.isArray(accounts)) return []
  const homes = new Set<string>()
  for (const account of accounts) {
    if (homes.size === MAX_HOMES) break
    const home = isObject(account) ? account.home : undefined
    if (typeof home === 'string' && !homes.has(home) && listable(home) && ownDirectory(home, uid) === 'ok') homes.add(home)
  }
  return [...homes]
}

export async function readOrcaHomes(deps: OrcaHomesDeps): Promise<OrcaHomesRead> {
  const orca = orcaBinary(deps)
  if (orca === null) return { homes: none(), failure: 'no orca' }
  const { code, stdout, timedOut } = await deps.run(orca, ['account', 'list', '--json'], { timeoutMs: ORCA_HOMES_DEADLINE_MS, maxBytes: ORCA_HOMES_MAX_BYTES })
  if (timedOut) return { homes: none(), failure: 'timed out' }
  // An Orca too old to have `account list` exits 1.
  if (code !== 0) return { homes: none(), failure: 'failed' }
  let answer: unknown
  try {
    answer = JSON.parse(stdout)
  } catch {
    return { homes: none(), failure: 'unreadable' }
  }
  if (!isObject(answer) || answer.ok !== true || !isObject(answer.result)) return { homes: none(), failure: 'unreadable' }
  return { homes: { claude: homesOf(answer.result.claude, deps.uid), codex: homesOf(answer.result.codex, deps.uid) } }
}

export interface OrcaHomesCache {
  /** The last read's homes: none before the first read, and none after a failed one. */
  get(): OrcaHomes
  /** Whether the last read gave Orca's answer: false before the first read and after a failed one, whose none is not
   *  Orca listing none. */
  answered(): boolean
  /** Reads when there is no read yet or the last is ORCA_HOMES_REFRESH_MS old, and joins a read under way. Resolves
   *  true when the list changed. Never rejects. */
  refresh(): Promise<boolean>
}

const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((home, i) => home === b[i])

export function createOrcaHomesCache(deps: { read(): Promise<OrcaHomesRead>; now(): number; platform: NodeJS.Platform; log(line: string): void }): OrcaHomesCache {
  let homes = none()
  let answered = false
  let readAt: number | undefined
  let reading: Promise<boolean> | undefined

  // A read that throws is a failed one. What it threw is never said: it can name paths and emails.
  const read = async (): Promise<OrcaHomesRead> => {
    try {
      return await deps.read()
    } catch {
      return { homes: none(), failure: 'failed' }
    }
  }

  return {
    get: () => homes,
    answered: () => answered,
    refresh() {
      // Windows gives a folder no owner uid to check (ownDirectory), so no home could be kept: nothing is run for none.
      if (deps.platform === 'win32') return Promise.resolve(false)
      if (reading) return reading
      if (readAt !== undefined && deps.now() - readAt < ORCA_HOMES_REFRESH_MS) return Promise.resolve(false)
      reading = read().then((next) => {
        readAt = deps.now()
        reading = undefined
        const changed = !sameList(homes.claude, next.homes.claude) || !sameList(homes.codex, next.homes.codex)
        homes = next.homes
        answered = next.failure === undefined
        deps.log(next.failure === undefined
          ? `[observed] orca homes · ${homes.claude.length} claude · ${homes.codex.length} codex`
          : `[observed] orca homes · not read · ${next.failure}`)
        return changed
      })
      return reading
    },
  }
}
