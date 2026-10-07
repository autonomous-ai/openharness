/**
 * The orchestrator, an experiment: a Director agent that plans a project and specialist agents that do its
 * tasks (orchestrator/service.ts). Moved out of the socket as it was (docs/design/2026-10-06-core-boundary-next.md,
 * step 8, "move only"): what the socket gave it, it now gets from the core's API, in this process
 * (`HARNESSD_SERVICES=none`) or in its own (services/orchestratorProcess.ts).
 * - The apps' and the agents' `orchestrator` requests, for an owner alone, as the socket answered them.
 * - What an agent is to a project (`roleOf`), asked at every turn's end: "no role", without building the
 *   service, on a machine with no saved project (`hasSavedProjects`), as the socket answered it.
 * - The frames the apps are sent, which an open service reads its Directors' turns from; one not yet built
 *   reads none, as before.
 * - Its turns, delivered through the core (`core.turns.deliver`), and what became of each.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CoreApi, CorePorts, ServiceRequests } from '../core/api.js'
import { isHiddenBuiltin } from '../dsh/builtinIds.js'
import { listInstalledDsh } from '../dsh/installed.js'
import { ENGINES, type AgentEngine } from '../engines/types.js'
import { supportsFirstPrompt } from '../lib/engineLaunch.js'
import { probeEngines } from '../lib/engineProbe.js'
import { OrchestratorError } from '../orchestrator/model.js'
import { shellQuote } from '../orchestrator/prompts.js'
import { hasSavedProjects, OrchestratorService } from '../orchestrator/service.js'
import { orchestratorRequest } from '../orchestrator/wire.js'

/** The request the orchestrator answers, declared in core/api.ts for the core to route. */
export { ORCHESTRATOR_REQUESTS } from '../core/api.js'

export interface OrchestratorOptions {
  /** Where its projects' workspaces are made. */
  workspaceDir?: string
  /** Which engines are installed here; swapped in tests for one that runs nothing. */
  probe?: typeof probeEngines
  /** The installed harnesses it offers its Directors. */
  installed?: typeof listInstalledDsh
  /** How a request is answered; swapped in tests for one that fails outright. */
  request?: typeof orchestratorRequest
}

export function startOrchestrator(core: CoreApi, ports: CorePorts, options: OrchestratorOptions = {}): ServiceRequests {
  const stateDir = join(core.dataDir, 'orchestrator')
  const probe = options.probe ?? probeEngines
  const installed = options.installed ?? listInstalledDsh
  const request = options.request ?? orchestratorRequest
  let service: OrchestratorService | null = null
  let saved: boolean | null = null
  const build = (): OrchestratorService => service ??= new OrchestratorService({
    stateDir,
    workspaceDir: options.workspaceDir ?? join(homedir(), 'harnesses', 'orchestrated'),
    command: `${core.daemon.command} orchestrator --port ${core.daemon.port} --machine ${shellQuote(core.daemon.machineId())}`,
    catalog: () => installed().filter(d => d.manifest.kind !== 'viewer' && !isHiddenBuiltin(d) && !!d.manifest.engine && supportsFirstPrompt(d.manifest.engine)).map(d => ({
      id: d.id, name: d.manifest.name, description: d.manifest.description ?? '', engine: d.manifest.engine!, viewer: !!d.manifest.viewer,
    })),
    supportsEngine: engine => ENGINES.includes(engine as AgentEngine) && supportsFirstPrompt(engine as AgentEngine),
    create: async input => {
      const available = await probe([input.engine])
      if (!available.some(e => e.engine === input.engine && e.installed)) throw new OrchestratorError('ENGINE_NOT_INSTALLED', `${input.engine} must be installed before starting this specialist.`)
      const result = await core.agents.create(input)
      if (!result.ok) throw new OrchestratorError(result.error, result.detail ?? result.error)
      return { agentId: result.agentId }
    },
    send: (id, text, deliveryId) => {
      if (!core.agents.resolve(id)) throw new OrchestratorError('AGENT_UNAVAILABLE', 'The agent is not available to receive a message.')
      core.turns.deliver(id, text, deliveryId ?? '')
    },
    // In its own process the core's answer cannot wait: not taken back here, and one the core did take back
    // is then heard rejected (`cancelled`), which the project reads as failed (`delivery` below).
    cancelDelivery: id => core.turns.cancelDelivery(id),
    cancel: id => core.turns.stop(id),
    agent: id => {
      const agent = core.agents.resolve(id)
      if (!agent) return null
      const context = core.agents.dsh(agent)
      return { viewerUrl: context?.viewerUrl, viewerName: context?.viewerName, error: agent.launch?.state === 'failed' ? agent.launch.detail ?? agent.launch.error : null }
    },
    changed: (id, revision) => core.clients.windows({ type: 'orchestrator_changed', payload: { id, revision } }),
  })
  const stopHearing = core.turns.onDelivery((event) => service?.delivery(event))
  ports.orchestrator = {
    roleOf: (agentId) => {
      if (!service && !(saved ??= hasSavedProjects(stateDir))) return null
      return build().roleOf(agentId)
    },
    // Only an open service reads frames: ordinary sessions make no project state and no disk work.
    frame: (frame) => service?.ingest(frame),
    stop: () => {
      stopHearing()
      service?.stop()
    },
  }
  return {
    orchestrator: (payload, asker) => {
      // A paired owner can run the machine's orchestrator; observers and device sessions cannot.
      if (!asker.owner) return { error: 'OWNER_REQUIRED' }
      return request(build(), payload).catch(() => ({ error: 'ORCHESTRATOR_FAILED' }))
    },
  }
}
