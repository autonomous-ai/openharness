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

import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { env } from '../../config/env.js'
import { HERMES_HISTORY_ID_RE, HERMES_HOMES, HERMES_PROFILE, HERMES_CONFIG_HOMES, hermesDbPath } from './contract.js'
import { forgetStoreHomes, listStoreHomes } from '../kit/storeHomes.js'
import { nativeHookHomes } from '../kit/nativeHookHomes.js'
import { profileFromEnv } from '../kit/processFacts.js'
import { sqliteReadAll } from '../../lib/sqliteRead.js'
import type { AgentEngine } from '../types.js'

/** `YYYYMMDD_HHMMSS_<hex>`, or an editor's (ACP) uuid — the shapes `reader.ts` reads history for. */
const SESSION_ID_RE = HERMES_HISTORY_ID_RE

export { hermesDbPath } from './contract.js'

function canonical(path: string): string {
  try { return realpathSync(path) } catch { return path }
}

/** Same home, spelled differently (a symlinked `~`, a trailing slash). */
export function sameHermesHome(a: string, b: string): boolean {
  return canonical(a.replace(/\/+$/, '')) === canonical(b.replace(/\/+$/, ''))
}

/**
 * Every home this machine has, the default first.
 *
 * A profile counts only once it has a `state.db`: before that there is nothing to read and nothing to
 * match a session against, and listing it would cost a failed query on every lookup. Declared (contract.ts) and
 * listed by the kit, whose one listing the hook server's admission shares.
 */
export async function listHermesHomes(defaultHome = env.HERMES_HOME): Promise<string[]> {
  return listStoreHomes(HERMES_HOMES, defaultHome)
}

/**
 * Every home that has a `config.yaml` — the homes the hook installer has something to write to.
 *
 * A different question from `listHermesHomes`, and deliberately a different predicate: a profile is
 * ready to READ from once it has a `state.db` (a session has run in it) and ready to be HOOKED as soon
 * as it has a config, which is at creation. Synchronous because every hook installer is.
 */
export function hermesConfigHomes(defaultHome = env.HERMES_HOME): string[] {
  return nativeHookHomes(HERMES_CONFIG_HOMES, defaultHome)
}

/** Forget the listing — for a test, and for an installer that has just made a profile. */
export function forgetHermesHomes(): void {
  forgetStoreHomes(HERMES_HOMES)
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
  return profileFromEnv(HERMES_PROFILE, processEnv, defaultHome)
}
