import { createHash, randomUUID } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CoreApi } from '../core/api.js'
import { readPrivateStateFile, secureStateDirectory, syncStateDirectory } from '../lib/secureState.js'
import { parseRuntimeProfile } from '../lib/runtimeProfileWire.js'
import { handoffIntentHash } from '../lib/handoffAuthority.js'
import { validateHandoff } from '../lib/handoffValidation.js'
import { identifier, object } from './wire.js'

interface Replacement { machineId: string; previousHarnessId: string; harnessId: string; changeId: string; cwd: string; engine: string }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const folder = (core: CoreApi) => join(core.dataDir, 'super-tabs', 'replacements')
const valid = (row: Replacement) => [row.machineId, row.previousHarnessId, row.harnessId, row.changeId, row.engine].every(identifier)
  && row.changeId.length >= 16 && row.changeId.length <= 96 && row.previousHarnessId !== row.harnessId && typeof row.cwd === 'string' && !!row.cwd

/** The UI reports only a completed launch. Persist its native identities before answering, so a
 * disconnected UI or restarted Swarm host does not strand the member on the stopped terminal. */
export async function recordReplacement(core: CoreApi, payload: Record<string, unknown>): Promise<void> {
  const previousHarnessId = String(payload.agentId ?? ''), harnessId = String(payload.replacementId ?? '')
  const row: Replacement = { machineId: core.daemon.machineId(), previousHarnessId, harnessId,
    changeId: String(payload.changeId ?? ''), engine: String(payload.targetEngine ?? ''), cwd: '' }
  if (![row.machineId, previousHarnessId, harnessId, row.changeId, row.engine].every(identifier)
    || row.changeId.length < 16 || row.changeId.length > 96 || previousHarnessId === harnessId) throw new Error('Invalid agent replacement.')
  const source = await core.conversations.resolve(previousHarnessId), target = await core.conversations.resolve(harnessId)
  if (!source || source.active !== false && !source.resumeOnly || !source.cwd || !target || target.resumeOnly || target.agentId !== harnessId
    || source.agentId !== previousHarnessId || target.cwd !== source.cwd || target.engine !== row.engine) throw new Error('The switched conversations changed.')
  row.cwd = source.cwd
  const dir = folder(core)
  mkdirSync(dir, { recursive: true, mode: 0o700 }); secureStateDirectory(dir)
  const file = join(dir, `${digest([row.machineId, row.changeId])}.json`)
  if (existsSync(file)) {
    if (readPrivateStateFile(file, 16_384) !== JSON.stringify(row)) throw new Error('This replacement intent already names another terminal.')
    syncStateDirectory(dir)
    return
  }
  const temporary = `${file}.${randomUUID()}.next`
  try {
    writeFileSync(temporary, JSON.stringify(row), { mode: 0o600, flush: true, flag: 'wx' })
    try { linkSync(temporary, file) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || readPrivateStateFile(file, 16_384) !== JSON.stringify(row)) throw error
    }
    syncStateDirectory(dir)
  } finally { if (existsSync(temporary)) unlinkSync(temporary) }
}

/** Read only private daemon receipts, never a project's editable handoff markdown. The exact
 * successful creation ID joins an old committed handoff to its replacement; a folder match alone
 * used to leave Launch Builder unassignable after Change agent on 2026-10-22. */
async function candidates(core: CoreApi, machineId: string): Promise<Replacement[]> {
  const result: Replacement[] = []
  const read = (dir: string, max: number, accept: (raw: Record<string, unknown>) => void) => {
    if (!existsSync(dir)) return
    secureStateDirectory(dir, false)
    const names = readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
    if (names.length > 4096) throw new Error('Reconcile the agent replacement receipts before continuing.')
    for (const name of names) {
      try { accept(object(JSON.parse(readPrivateStateFile(join(dir, name), max)))) } catch { /* Partial or invalid evidence never adopts a terminal. */ }
    }
  }
  read(folder(core), 16_384, raw => {
    const row = raw as unknown as Replacement
    if (valid(row) && row.machineId === machineId) result.push(row)
  })
  read(join(core.dataDir, 'handoff-receipts'), 20 * 1024 * 1024, raw => {
    if (raw.version !== 1 || raw.committed !== true) return
    const prepared = raw.prepared as Parameters<typeof validateHandoff>[0]
    validateHandoff(prepared)
    if (raw.fingerprint !== handoffIntentHash(prepared)) return
    // Creation status belongs to the core, and is consulted below only for roster members.
    result.push({ machineId, previousHarnessId: prepared.request.agentId, harnessId: '', changeId: prepared.request.changeId,
      cwd: prepared.project.cwd, engine: prepared.request.targetEngine })
  })
  return result
}

export async function replacementObservations(core: CoreApi, machineId: string, rows: unknown[]) {
  // Healthy members need no recovery or disk scan. In particular, do not reread every historical
  // handoff and its transcript on a machine with live Swarm members every five seconds.
  rows = rows.filter(value => {
    const row = object(value), agent = object(row.agent)
    return identifier(row.tabId) && identifier(agent.id) && identifier(agent.harnessId) && agent.machineId === machineId
      && row.stopRequested !== true && agent.workDecision !== 'stop' && !core.agents.byAgent(String(agent.harnessId))
  })
  if (!rows.length) return []
  const reports = await candidates(core, machineId)
  const observations: Array<{ path: string; body: Record<string, unknown> }> = []
  for (const value of rows) {
    const row = object(value), agent = object(row.agent)
    if (!identifier(row.tabId) || !identifier(agent.id) || !identifier(agent.harnessId)
      || agent.machineId !== machineId || row.stopRequested === true || agent.workDecision === 'stop') continue
    const matches: Array<{ report: Replacement; target: NonNullable<ReturnType<CoreApi['agents']['byAgent']>> }> = []
    for (const report of reports.filter(r => r.previousHarnessId === agent.harnessId)) {
      if (!await core.agents.stopped?.(report.previousHarnessId)) continue
      const receipt = await core.agents.creationStatus?.(report.changeId)
      if (receipt?.state !== 'created' || receipt.creationId !== report.changeId || report.harnessId && receipt.agentId !== report.harnessId) continue
      const target = core.agents.byAgent(receipt.agentId)
      if (!target || target.resumeOnly || target.agentId === report.previousHarnessId || target.cwd !== report.cwd
        || target.engine !== report.engine || !core.agents.terminalAvailable(target.agentId)) continue
      matches.push({ report, target })
    }
    if (new Set(matches.map(m => m.target.agentId)).size !== 1) continue
    const { report, target } = matches[0]
    const profile = parseRuntimeProfile(core.agents.runtimeProfile(target))
    const known = profile?.sessionId === target.agentId && profile.engine === target.engine
    const configuration = { engine: target.engine, model: known ? profile.model : null, effort: known ? profile.effort : null,
      contextWindow: null, engineVersion: null }
    const command = { type: 'agent.rebind', agentId: agent.id, machineId, projectId: agent.projectId ?? 'lead',
      previousHarnessId: agent.harnessId, harnessId: target.agentId, configuration }
    observations.push({ path: `/api/super-tabs/${row.tabId}/commands`, body: {
      operationId: `replacement-${digest([row.tabId, agent.id, report.changeId, target.agentId])}`, asAgentId: agent.id, command } })
  }
  return observations
}
