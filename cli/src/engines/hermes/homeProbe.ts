/**
 * Which Hermes home a live `hermes` process was launched under, read off its environment.
 *
 * The free half of the answer `home.ts` documents: when the engine exports `HERMES_HOME` for a
 * `hermes -p <name>` session, one cached `ps` names the home and the registry row is filled before any
 * store is opened. When it does not, this says nothing (`null`) and the session-id lookup answers
 * instead — which is why nothing here is load-bearing.
 *
 * Same three answers as `codexHomeProbe`: a path for a non-default home, `null` for the default or an
 * engine that said nothing, and `undefined` when the process could not be read at all, which must
 * never overwrite what the registry already knows.
 */

import type { AgentEngine } from '../types.js'
import { readProcessEnv } from '../../lib/processEnv.js'
import type { ProcessIdentity } from '../../lib/registry.js'
import { hermesHomeFromEnv } from './home.js'

export async function probeHermesHome(identity: ProcessIdentity, engine: AgentEngine): Promise<string | null | undefined> {
  if (engine !== 'hermes') return null
  const processEnv = await readProcessEnv(identity)
  if (!processEnv) return undefined
  return hermesHomeFromEnv(engine, processEnv)
}
