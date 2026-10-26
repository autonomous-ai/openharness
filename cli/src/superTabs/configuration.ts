import { createHash } from 'node:crypto'
import type { CoreApi } from '../core/api.js'
import { parseRuntimeProfile } from '../lib/runtimeProfileWire.js'
import { identifier, object } from './wire.js'

/** Use the same observed profile as the app. Unknown readings are not changes,
 * and a model's context size is never inferred from its name. */
export function configurationObservation(core: CoreApi, machineId: string, value: unknown) {
  const row = object(value), agent = object(row.agent), previous = object(agent.configuration)
  if (![row.tabId, agent.id, agent.harnessId].every(identifier) || agent.machineId !== machineId) return null
  if (agent.configurationVersion != null && !identifier(agent.configurationVersion)) return null
  const native = core.agents.byAgent(String(agent.harnessId))
  if (!native || !core.agents.terminalAvailable(native.agentId)) return null
  const profile = parseRuntimeProfile(core.agents.runtimeProfile(native))
  if (!profile || profile.sessionId !== native.agentId || profile.engine !== native.engine || profile.model.length > 200) return null
  const sameModel = previous.engine === native.engine && previous.model === profile.model
  // Claude Code never reports an effort it was launched with (--effort), so its reading falls back to 'auto': for the same
  // model, that is no news about a known effort. Builders started with opus high read as auto until 2026-10-27.
  const unread = profile.effort === 'auto' && sameModel && typeof previous.effort === 'string'
  const configuration = {
    engine: native.engine, model: profile.model, effort: unread ? previous.effort : profile.effort,
    contextWindow: sameModel && Number.isSafeInteger(previous.contextWindow) && Number(previous.contextWindow) > 0 ? previous.contextWindow : null,
    engineVersion: previous.engine === native.engine && typeof previous.engineVersion === 'string' ? previous.engineVersion : null,
  }
  if (Object.entries(configuration).every(([key, part]) => previous[key] === part)) return null
  const previousVersion = agent.configurationVersion ?? null
  const operationId = `configuration-${createHash('sha256').update(JSON.stringify([row.tabId, agent.id, previousVersion, configuration])).digest('hex')}`
  return {
    path: `/api/super-tabs/${row.tabId}/commands`,
    body: { operationId, asAgentId: agent.id,
      command: { type: 'agent.configuration', previousVersion, configuration } },
  }
}
