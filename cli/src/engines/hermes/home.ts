/**
 * WHICH HERMES HOME A SESSION LIVES IN.
 *
 * Hermes keeps history in ONE SQLite store per home — and a machine has more than one home. `hermes -p
 * <name>` runs against `~/.hermes/profiles/<name>`, with its own `config.yaml`, its own `auth.json` and
 * its own `state.db`. The daemon used to read `<HERMES_HOME>/state.db` everywhere, so a fleet of profile
 * agents streamed their terminals perfectly and then sat on "No activity yet" forever: the mirror polled
 * a database their sessions were not in, so no turn ever opened, nothing was ever recapped, and
 * `agent_recent` answered zero for the life of the agent (openharness#191).
 *
 * ⚠️ **THE SESSION ID IS THE ONLY EVIDENCE THAT NEEDS NO ASSUMPTION.** The obvious fix is to read
 * `HERMES_HOME` off the live process, the way `codexHomeProbe` reads `CODEX_HOME` — and that is done
 * below, because it is free when it works. But whether Hermes exports it for a `-p` session is the
 * engine's business and changes between versions, and a pane the daemon did not create may be gone by
 * the time anyone asks. A session id is unique and its row exists in exactly one store, so "which home
 * holds this session" is answerable by looking, at the cost of one indexed lookup per home, once per
 * agent — the answer is then filled onto the registry row and never asked again (see
 * `RegisteredSession.hermesHome`).
 *
 * Nothing here writes. Discovering a home does not create one, and a home with no `state.db` is not a
 * home yet — it is a profile whose first session has not started.
 */

import { readdirSync, realpathSync, statSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { env } from '../../config/env.js'
import { sqliteReadAll } from '../../lib/sqliteRead.js'
import type { AgentEngine } from '../types.js'

/** `YYYYMMDD_HHMMSS_<hex>` — the same shape `reader.ts` guards its queries with. */
const SESSION_ID_RE = /^[0-9]{8}_[0-9]{6}_[0-9a-fA-F]{4,16}$/
/** How long a homes listing is reused. A profile is created by hand, minutes apart; this is a `readdir`. */
const HOMES_TTL_MS = 30_000
/** A person with hundreds of profile folders has a different problem; this keeps the scan bounded. */
const MAX_PROFILES = 64

export function hermesDbPath(home: string): string {
  return join(home, 'state.db')
}

function canonical(path: string): string {
  try { return realpathSync(path) } catch { return path }
}

/** Same home, spelled differently (a symlinked `~`, a trailing slash). */
export function sameHermesHome(a: string, b: string): boolean {
  return canonical(a.replace(/\/+$/, '')) === canonical(b.replace(/\/+$/, ''))
}

let homesCache: { at: number; homes: string[] } | null = null

/**
 * Every home this machine has, the default first.
 *
 * A profile counts only once it has a `state.db`: before that there is nothing to read and nothing to
 * match a session against, and listing it would cost a failed query on every lookup.
 */
export async function listHermesHomes(defaultHome = env.HERMES_HOME): Promise<string[]> {
  const now = Date.now()
  if (homesCache && now - homesCache.at < HOMES_TTL_MS) return homesCache.homes
  const homes = [defaultHome]
  try {
    const entries = await readdir(join(defaultHome, 'profiles'), { withFileTypes: true })
    for (const entry of entries.slice(0, MAX_PROFILES)) {
      if (!entry.isDirectory()) continue
      const home = join(defaultHome, 'profiles', entry.name)
      try {
        if ((await stat(hermesDbPath(home))).isFile()) homes.push(home)
      } catch { /* a profile whose first session has not started */ }
    }
  } catch { /* no profiles folder — the single-home machine, which is most of them */ }
  homesCache = { at: now, homes }
  return homes
}

/**
 * Every home that has a `config.yaml` — the homes the hook installer has something to write to.
 *
 * A different question from `listHermesHomes`, and deliberately a different predicate: a profile is
 * ready to READ from once it has a `state.db` (a session has run in it) and ready to be HOOKED as soon
 * as it has a config, which is at creation. Synchronous because every hook installer is.
 */
export function hermesConfigHomes(defaultHome = env.HERMES_HOME): string[] {
  const homes = [defaultHome]
  let entries: string[] = []
  try { entries = readdirSync(join(defaultHome, 'profiles')) } catch { return homes }
  for (const name of entries.slice(0, MAX_PROFILES)) {
    const home = join(defaultHome, 'profiles', name)
    try {
      if (statSync(join(home, 'config.yaml')).isFile()) homes.push(home)
    } catch { /* not a profile folder, or no config yet */ }
  }
  return homes
}

/** Forget the listing — for a test, and for an installer that has just made a profile. */
export function forgetHermesHomes(): void {
  homesCache = null
}

/**
 * The home whose store holds `sessionId`, or null when no home does (yet).
 *
 * Read-only and indexed: `sessions.id` is the primary key, so this is a point lookup per home. The
 * default home is asked first, which is the answer on every machine that has only one.
 */
export async function findHermesHomeForSession(
  sessionId: string,
  homes?: string[],
): Promise<string | null> {
  if (!SESSION_ID_RE.test(sessionId)) return null
  for (const home of homes ?? await listHermesHomes()) {
    const result = await sqliteReadAll(
      hermesDbPath(home),
      'SELECT id FROM sessions WHERE id = ? LIMIT 1;',
      [sessionId],
      { maxBuffer: 1 << 16 },
    )
    if (result.ok && result.rows.length > 0) return home
  }
  return null
}

/**
 * The home a live `hermes` process was launched under, read off its environment — the free answer,
 * when the engine offers it. Contract copied from `codexHomeFromEnv`: a path when the process runs
 * under a non-default home, `null` when it runs under this machine's default (or says nothing), and
 * `undefined` from the probe when the process could not be read at all, which must never overwrite
 * what the registry already knows.
 */
export function hermesHomeFromEnv(
  engine: AgentEngine,
  processEnv: Record<string, string>,
  defaultHome = env.HERMES_HOME,
): string | null {
  if (engine !== 'hermes') return null
  const home = processEnv.HERMES_HOME
  if (!home || !isAbsolute(home) || home.length > 4096 || /[\x00-\x1f\x7f]/.test(home)) return null
  return sameHermesHome(home, defaultHome) ? null : home
}
