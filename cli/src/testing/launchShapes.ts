/**
 * The core's launch paths, wired as core/main.ts wires them, over a machine a spec chooses: create, every relaunch
 * (restart, resume, restore and fork share `relaunchOverrides`), retarget's check before it touches a pane and the
 * line it logs after, the socket's saved-API target, the variables a pane leaving a grid has cleared, and the
 * engines a model picker may offer a grid model to. For engines/launchShapes.golden.spec.ts, which pins what each
 * launch shape starts with and writes. The composition, not the spec, follows where each part of a launch is built
 * (docs/design/2026-10-08-launch-port.md).
 */
import { createLaunchHelpers, gridLaunchThrough } from '../core/agents/launch.js'
import { createAgentCreator, type CreateAgentDeps } from '../core/agents/create.js'
import { gridLaunchAnswerIn } from '../core/modelsLink.js'
import { ApiConnections } from '../lib/apiConnections.js'
import { prepareApiInstructions } from '../lib/apiInstructions.js'
import { apiTargetAnswer } from '../lib/apiModels.js'
import { writeGridConfigDir } from '../lib/gridConfigDir.js'
import { describeGridLaunch, gridCapableEngines, gridEnvVarNames, type GridLaunchMachine } from '../lib/gridLaunchWire.js'
import { validateLaunchOverrides, type LaunchOverrides, type LaunchOverridesDeps, type LaunchSource } from '../lib/launchOverrides.js'
import type { RegisteredSession } from '../lib/registry.js'
import type { AgentEngine } from '../engines/types.js'
import { gridLaunchRequestIn } from '../services/modelsProcess.js'
import { gridLaunchInProcess } from './gridLaunchInProcess.js'

export interface LaunchWorld {
  /** The data folder: saved APIs, and the config directories written for file-configured engines. */
  dataDir: string
  machine: () => GridLaunchMachine
  tmuxSupportsSessionEnv: () => Promise<boolean>
  /** A Codex `config.toml`, as the own-login provider reads it. */
  readCodexConfig: (path: string) => string | null
  /** What a launch records on its row once built. */
  setGridLaunch: (agentId: string, record: unknown) => void
}

/** What `create` needs besides the launch: the spec's stubs for the pane, the registry and the rest. */
export type CreateRest = Omit<CreateAgentDeps, 'gridLaunchMachine' | 'prepareApiTools' | 'buildGridLaunch'>

export function launchShapes(world: LaunchWorld) {
  const savedApis = new ApiConnections(world.dataDir)
  const prepareApiTools = (cwd: string | null | undefined, engine: string): void => {
    if (!cwd) return
    try { prepareApiInstructions(savedApis, cwd, engine) }
    catch { console.warn('[apis] Tool instructions could not be added. Saved connections remain available through harness api.') }
  }
  // The models service's side of the launch port: what its port answers the core with (services/models.ts), across
  // the process boundary as models in its own process is asked (core/modelsLink.ts → services/modelsProcess.ts),
  // the request and the answer each crossing as JSON and checked as the far side checks it, behind what the core
  // asks it through (core/agents/launch.ts `gridLaunchThrough`).
  const models = gridLaunchInProcess(savedApis)
  const wire = (value: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(value)) as Record<string, unknown>
  const gridLaunch = gridLaunchThrough(() => ({
    gridLaunch: async (request) => {
      const asked = gridLaunchRequestIn(wire(request))
      if (!asked) throw new Error('models could not read the launch it was asked for')
      const answer = gridLaunchAnswerIn(wire(await models(asked)))
      if (!answer) throw new Error('the core could not read the launch models built')
      return answer
    },
  }))
  const launchOverridesDeps: LaunchOverridesDeps = {
    machine: world.machine,
    gridLaunch,
    writeGridConfigDir,
    tmuxSupportsSessionEnv: world.tmuxSupportsSessionEnv,
    installCodexHooks: () => {},
    readCodexConfig: world.readCodexConfig,
  }
  const helpers = createLaunchHelpers({
    prepareApiTools, launchOverridesDeps,
    setGridLaunch: world.setGridLaunch as never, setTail: () => {},
  })
  return {
    create: (rest: CreateRest) => createAgentCreator({ ...rest, gridLaunchMachine: world.machine, buildGridLaunch: gridLaunch, prepareApiTools }),
    relaunch: (session: RegisteredSession, source?: LaunchSource) => helpers.relaunchOverrides(session, source),
    validate: (engine: AgentEngine, source: LaunchSource) => validateLaunchOverrides(launchOverridesDeps, engine, source),
    /** The line retarget logs once a move onto a grid succeeded. */
    retargetLine: (engine: AgentEngine, overrides: LaunchOverrides): string | null => overrides.gridLaunchRecord
      ? describeGridLaunch(engine, overrides.gridLaunchRecord.override, overrides.gridLaunchRecord.webSearch)
      : null,
    /** The socket's saved-API target: the launch, or the sentence the person reads. */
    apiTarget: async (connectionId: string, model: string) => {
      const answer = await apiTargetAnswer(savedApis, connectionId, model)
      if ('detail' in answer) throw new Error(answer.detail)
      return answer.target
    },
    leavingGrid: (engine: AgentEngine) => gridEnvVarNames(engine),
    gridCapable: () => gridCapableEngines(),
    apiTools: prepareApiTools,
  }
}
