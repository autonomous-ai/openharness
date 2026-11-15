/** Core's declaration of the launch evidence models may classify: argument fragments alone. No keys, and no environment, cross this port. */
import { ENGINES, type AgentEngine } from '../engines/types.js'
import type { GridLaunchOverride } from './gridLaunchWire.js'

export interface GridAssignment { baseUrl: string; model: string | null }
export interface GridAssignmentProcess { key: string; engine: AgentEngine; args: string }
export interface GridAssignmentAnswer { key: string; assignment: GridAssignment | null }

/**
 * Engines whose grid is in no command line: a launch hands it over their environment (Claude Code, Hermes, Grok,
 * Copilot) or a config file an environment variable names (OpenCode). No process's environment is read, so the
 * launch record Harness wrote on the row (`grid`) says where they are.
 */
const GRID_OUTSIDE_ARGV = new Set<AgentEngine>(['claude', 'hermes', 'grok', 'copilot', 'opencode'])
const PROCESS_MEMBERS = new Set(['key', 'engine', 'args'])

export const GRID_CODEX_ENDPOINT = /model_providers\.[A-Za-z0-9_-]+\.base_url=(?:"([^"]+)"|(\S+))/
export const GRID_ARGV_MODEL = /(?:^|\s)-m\s+(\S+)/
export const GRID_PI_MODEL = /(?:^|\s)--model\s+([A-Za-z0-9_-]+)\/(\S+)/
/** `-e <dir>/grid-provider.ts`, the extension a grid launch hands Pi (lib/gridLaunch.ts `piProviderExtension`). */
export const GRID_PI_EXTENSION = /(?:^|\s)-e\s+(\S*\/grid-provider\.ts)(?=\s|$)/

/** The provider id and block a grid-provider extension registers; null for any other source. */
export function piProviderExtensionIn(source: string): { id: string; provider: Record<string, unknown> } | null {
  const block = /pi\.registerProvider\(("[^"]+"), (\{[\s\S]*\})\)\s*\}\s*$/.exec(source)
  if (!block) return null
  try {
    const id: unknown = JSON.parse(block[1]), provider: unknown = JSON.parse(block[2])
    return typeof id === 'string' && !!provider && typeof provider === 'object' ? { id, provider: provider as Record<string, unknown> } : null
  } catch { return null }
}

/**
 * The launch markers a command line holds: a provider block with its `-m`, or Pi's `-e …/grid-provider.ts` with its
 * `--model`. Null when it holds none, and always for an engine whose grid is in no command line.
 */
export function gridAssignmentProcess(key: string, engine: AgentEngine, args: string): GridAssignmentProcess | null {
  if (GRID_OUTSIDE_ARGV.has(engine)) return null
  const extension = engine === 'pi' ? GRID_PI_EXTENSION.exec(args) : null
  const provider = engine === 'pi' ? null : GRID_CODEX_ENDPOINT.exec(args)
  if (!(extension || provider)) return null
  // Never forward the command line: it may carry a prompt, token or unrelated tool arguments.
  const model = engine === 'pi' ? GRID_PI_MODEL.exec(args)?.[0].trim() : engine === 'codex' ? GRID_ARGV_MODEL.exec(args)?.[0] : undefined
  return { key, engine, args: [provider?.[0], extension?.[0].trim(), model].filter(Boolean).join(' ') }
}

/**
 * What a command line says of its process's grid: the markers to classify, null for a command line that names none
 * (a vendor login), and undefined where its absence is no finding. That is an engine whose grid is in no command line,
 * and Pi, whose launch before its extension (#1318) named its grid nowhere in argv and stays unknown until relaunched.
 */
export function gridAssignmentEvidence(key: string, engine: AgentEngine, args: string): GridAssignmentProcess | null | undefined {
  return gridAssignmentProcess(key, engine, args) ?? (GRID_OUTSIDE_ARGV.has(engine) || engine === 'pi' ? undefined : null)
}

/**
 * The grid a launch on [override] (its launch record's) puts its engine on, as the row keeps it (`grid`). Every
 * relaunch writes it with the process it starts: no process is read back for an engine whose grid is in no command
 * line, so nothing else would correct the row. Null for a launch on the engine's own login.
 */
export function launchedGrid(override: GridLaunchOverride | null | undefined): GridAssignment | null {
  return override ? { baseUrl: override.baseUrl, model: override.model ?? null } : null
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export function gridAssignmentProcessesIn(value: unknown): GridAssignmentProcess[] | null {
  if (!Array.isArray(value) || value.length > 4096) return null
  const out: GridAssignmentProcess[] = []
  for (const row of value) {
    if (!record(row) || Object.keys(row).some(name => !PROCESS_MEMBERS.has(name)) || typeof row.key !== 'string'
      || typeof row.engine !== 'string' || !ENGINES.includes(row.engine as AgentEngine) || typeof row.args !== 'string') return null
    const process = gridAssignmentProcess(row.key, row.engine as AgentEngine, row.args)
    if (!process || out.some(previous => previous.key === row.key)) return null
    out.push(process)
  }
  return out
}

export function gridAssignmentAnswersIn(value: unknown, processes: readonly GridAssignmentProcess[]): GridAssignmentAnswer[] | null {
  if (!Array.isArray(value) || value.length !== processes.length) return null
  const keys = new Set(processes.map(process => process.key))
  const out: GridAssignmentAnswer[] = []
  for (const row of value) {
    if (!record(row) || typeof row.key !== 'string' || !keys.delete(row.key)) return null
    const a = row.assignment
    if (a !== null && (!record(a) || typeof a.baseUrl !== 'string' || !(a.model === null || typeof a.model === 'string'))) return null
    out.push({ key: row.key, assignment: a === null ? null : { baseUrl: a.baseUrl as string, model: a.model as string | null } })
  }
  return out
}

export function sameGridAssignment(a: GridAssignment | null, b: GridAssignment | null): boolean {
  if (a === null || b === null) return a === b
  return a.baseUrl === b.baseUrl && (a.model ?? null) === (b.model ?? null)
}
