/**
 * `harness e2e plan` — the trigger's decision, printed: for each engine under test, the installed
 * version, the latest released one, and whether a run is due. The cron runner (autonomous-grid-cli,
 * e2e/run.sh) reads the JSON form and runs `harness e2e grid-switch` per engine it names.
 *
 * Env: E2E_VERSION_SOURCE=mock|npm (default mock until the npm reader is validated), E2E_ENGINES=codex,claude.
 */
import type { AgentEngine } from '../engines/types.js'
import { versionSourceFromEnv } from './versionSource.js'
import { InstalledCurrentVersion } from './currentVersion.js'
import { planMatrixRuns } from './trigger.js'

export async function planCommand(json: boolean): Promise<void> {
  const engines = (process.env.E2E_ENGINES ?? 'codex,claude').split(',').map((e) => e.trim() as AgentEngine).filter(Boolean)
  const plans = await planMatrixRuns(versionSourceFromEnv(), new InstalledCurrentVersion(), engines)
  if (json) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), plans }, null, 2))
    return
  }
  for (const p of plans) {
    console.log(`${p.engine.padEnd(8)} current=${String(p.current).padEnd(12)} latest=${String(p.latest).padEnd(12)} ${p.plan ? 'RUN' : 'skip'} (${p.reason})`)
  }
}
