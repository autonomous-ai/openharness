/**
 * Which grid is a running agent on, as far as its command line says?
 *
 * The desktop app can point an agent at a grid when it is created (`gridLaunch.ts`), and can move an
 * existing one (`agent_retarget`). Both record the launch on the agent's row (`grid`), and that record
 * is the answer for every engine whose grid travels outside its command line: Claude Code, Hermes,
 * Grok and Copilot take it in their environment, OpenCode in the config file its environment names.
 * No process's environment is read, so an agent a person started by hand with a relay URL in their
 * own shell (`ANTHROPIC_BASE_URL=… claude`) shows its own login.
 *
 * Two engines carry their grid in argv, and only theirs is read back: Codex's provider block
 * (`-c model_providers.<id>.base_url=…` with its `-m`), and the extension `-e …/grid-provider.ts` a
 * launch hands Pi, with its `--model`. Each is read through the same knob `GRID_ENGINE_CONTRACTS`
 * writes, so the two must stay in step.
 *
 * **The key is never read.** What leaves here is the endpoint and the model, both of which the app
 * already knows because it chose them.
 */

import { readFile } from 'node:fs/promises'
import type { AgentEngine } from '../engines/types.js'
import { enginesDeclaring } from '../engines/discoveries.js'
import type { ApiConnections } from './apiConnections.js'
import { anthropicBaseUrl, relayBaseUrl } from './gridLaunchWire.js'

export type { GridAssignment } from './gridAssignmentWire.js'
import { GRID_CODEX_ENDPOINT as CODEX_BASE_URL, GRID_ARGV_MODEL as ARGV_MODEL, GRID_PI_MODEL as PI_ARGV_MODEL,
  GRID_PI_EXTENSION as PI_EXTENSION, piProviderExtensionIn, type GridAssignment, type GridAssignmentProcess,
  type GridAssignmentAnswer } from './gridAssignmentWire.js'
export { sameGridAssignment } from './gridAssignmentWire.js'

/**
 * Engines whose model was written into argv as `-m <model>`: Codex's discovery contract declares it
 * (`modelInArgv`). Codex omits the flag when no model was picked.
 */
const MODEL_IN_ARGV = new Set<AgentEngine>(enginesDeclaring('modelInArgv'))

/**
 * Endpoints of the APIs saved on this computer (`apiModels.ts`), in both forms an engine is handed
 * (`relayBaseUrl` and `anthropicBaseUrl`). An agent the person moved onto one of them was sent there
 * deliberately, so it reports that model like a grid agent does. Only added to: an agent left on an
 * API after its connection is removed is still on it.
 */
const apiBases = new Set<string>()

export function rememberApiBase(baseUrl: string): void {
  for (const form of [relayBaseUrl(baseUrl), anthropicBaseUrl(baseUrl)]) apiBases.add(form)
}

/** Every saved API's endpoint, so agents already running on one are recognised. */
export function rememberSavedApis(store: Pick<ApiConnections, 'list'>): void {
  try {
    for (const connection of store.list()) rememberApiBase(connection.baseUrl)
  } catch {
    // An unreadable store is reported where it is managed; recognising agents is best effort.
  }
}

/**
 * A base URL that is not a grid is not an assignment.
 *
 * An agent can be pointed somewhere else entirely — OpenRouter through `ori`, a corporate proxy, a
 * local llama server — and reporting those as "on a grid" would make the app offer to move an agent
 * away from a place the user deliberately sent it.
 */
function isGridUrl(value: string): boolean {
  if (apiBases.has(value.trim().replace(/\/+$/, ''))) return true
  try {
    // The relay always lives under `/relay`, whatever host serves it — that is the one part of the
    // shape the control plane and both CLIs agree on (`<grid>/relay` for Messages, `/relay/v1` for
    // OpenAI clients). Matching on the host would pin this to one deployment.
    return new URL(value).pathname.split('/').includes('relay')
  } catch {
    return false
  }
}

/** Classify a command line's provider block. Exported so a spec can pin the rules with no I/O. */
export function classifyGridAssignment(engine: AgentEngine, args: string): GridAssignment | null {
  const fromArgv = CODEX_BASE_URL.exec(args)
  const baseUrl = (fromArgv?.[1] ?? fromArgv?.[2])?.trim()
  if (!baseUrl || !isGridUrl(baseUrl)) return null
  const model = MODEL_IN_ARGV.has(engine) ? ARGV_MODEL.exec(args)?.[1] : undefined
  return { baseUrl, model: model || null }
}

/**
 * Pi's provider block, read out of the extension its command line hands it.
 *
 * Exported so a spec can drive the real read against the files a real launch writes.
 *
 * Every failure lands on null — an unreadable or rewritten extension is "we cannot tell", which the
 * caller already treats as "not on the grid you picked".
 */
export async function readPiGridAssignment(args: string): Promise<GridAssignment | null> {
  const model = PI_ARGV_MODEL.exec(args)
  const extension = PI_EXTENSION.exec(args)?.[1]
  if (!model || !extension) return null
  try {
    // The provider the extension registers, by the id `--model` names.
    const registered = piProviderExtensionIn(await readFile(extension, 'utf8'))
    if (registered?.id !== model[1]) return null
    const baseUrl = registered.provider.baseUrl
    if (typeof baseUrl !== 'string' || !isGridUrl(baseUrl)) return null
    return { baseUrl, model: model[2] }
  } catch {
    return null
  }
}

/** Pi's grid is in the file its argv names; every other engine's in the argv itself. */
async function assignmentOf(engine: AgentEngine, args: string): Promise<GridAssignment | null> {
  return engine === 'pi' ? await readPiGridAssignment(args) : classifyGridAssignment(engine, args)
}

/** One fresh classification per process per pass; this is deliberately not an assignment cache. */
export async function gridAssignments(processes: readonly GridAssignmentProcess[]): Promise<GridAssignmentAnswer[]> {
  return Promise.all(processes.map(async process => ({ key: process.key, assignment: await assignmentOf(process.engine, process.args) })))
}
