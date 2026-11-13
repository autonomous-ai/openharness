import type { AgentEngine } from '../engines/types.js'
import {
  agentAliasOwner,
  agentCommandOwnershipSnapshot,
  PROCESS_ENGINES,
  type AgentCommandOwnershipSnapshot,
} from './engineBin.js'
import { probeGatewayRuntime } from './gatewayRuntime.js'
import { gridAssignmentEvidence, type GridAssignment, type GridAssignmentProcess } from './gridAssignmentWire.js'
import { readProcessEnv } from './processEnv.js'
import { probeProfileHome } from '../engines/discoveries.js'
import { probeHermesHome, probeHermesHomeDerived, probeHermesSandbox } from '../engines/identities.js'
import { probeDsh } from '../dsh/probe.js'
import type { TerminalBackend } from './terminalBackend.js'
import {
  ambiguousAgentProcess,
  engineProcessMatchScore,
  enrichProcessRows,
  hermesGatewaysUnder,
  launchArgs,
  processRows,
  processTreePids,
  resumeSessionId,
  type ProcessRow,
} from './processTable.js'
import { processIdentityKey, processIdentityOf, sameProcessIdentity, terminalInstanceId, terminalPlacementKey, terminalRouteKey } from './terminalRuntime.js'
import type {
  ProcessIdentity,
  TerminalInventoryResult,
  TerminalRootObservation,
  TerminalRuntimeRef,
} from './terminalTypes.js'

export { processRows } from './processTable.js'

export interface DiscoveredTerminalAgent {
  engine: AgentEngine
  cwd: string
  processIdentity: ProcessIdentity
  args: string
  resumeSessionId: string | null
  runtimes: TerminalRuntimeRef[]
  primaryRuntimeKey: string
  /**
   * 'ori' when this engine process is pointed at an OpenRouter endpoint (`ori claude` and friends).
   * undefined = the probe could not read the process; the registry then keeps whatever it already knew,
   * rather than downgrading a gateway agent to a vendor one on one failed read.
   *
   * Deliberately NOT a property of the terminal: the probe reads the engine's own env and argv, not
   * anything the pane says about itself.
   */
  gateway?: 'ori' | null
  /**
   * The grid this engine process is pointed at, read from the same environment. null = a vendor login
   * while undefined means the process or models could not be read and preserves the last assignment.
   *
   * Backend-agnostic for the same reason `gateway` is: it is a fact about the process, not the pane.
   */
  grid?: GridAssignment | null
  /**
   * Processes a row may hold in this one's place: its ancestors inside its pane, root included, nearest first (a
   * wrapper Harness bound that `exec`ed into another name and started this engine below it, #4259), then the
   * processes under it an older build recorded as this pane's engine (Hermes' shared gateway, processTable.ts
   * `hermesGatewaysUnder`). A row holding one of them is this agent, re-recorded to this process, not one it replaces.
   */
  formerProcesses?: ProcessIdentity[]
  /** Sanitized launch markers; classified after the binding pass, never awaited by it. */
  gridProcess?: GridAssignmentProcess
  /**
   * Codex only: the CODEX_HOME profile the process was launched under, when it is not this machine's
   * default. null = the default profile (or not Codex); undefined = the probe could not read the
   * process, and the registry keeps what it already knows. See `probeProfileHome` (engines/discoveries.ts).
   */
  codexHome?: string | null
  /**
   * Hermes only: the home the process runs under (`hermes -p <name>` → `~/.hermes/profiles/<name>`, or
   * one under a `HOME` of its own), at the daemon's path of it, when it is not this machine's default.
   * Same three answers as `codexHome`. The registry also finds this by looking the session up in each
   * store (`engines/hermes/home.ts`), which is the answer that needs no cooperation from the engine —
   * this is the free one, from a read the discovery pass makes anyway.
   */
  hermesHome?: string | null
  /**
   * Hermes only: `hermesHome` is one Harness worked out (from the process's `HOME`, or the daemon's path of
   * a home a sandbox named), not the value of its own `HERMES_HOME`. A relaunch does not export it
   * (registry.ts RegisteredSession.hermesHomeDerived).
   */
  hermesHomeDerived?: true
  /**
   * Hermes only, a process in another mount namespace (a sandbox, Linux): its folder as it names it, the one
   * Hermes writes, for comparisons with what Hermes wrote; `cwd` is then the daemon's path of that folder.
   * 'unseen': its home or folder has no path in the daemon's view, and `cwd` stays the pane's.
   */
  sandbox?: { cwd: string } | 'unseen'
  /**
   * The domain-specific harness this process was launched as, read off its `HARNESS_DSH`. null = a
   * plain engine; undefined = the probe could not read the process, and the registry keeps what it
   * already knows. See `src/dsh/probe.ts`.
   */
  dsh?: string | null
}

export interface TerminalTargetProbe {
  instanceId: string
  result: TerminalInventoryResult
}

export interface TerminalAgentProbe {
  processTableAvailable: boolean
  targets: TerminalTargetProbe[]
  agents: DiscoveredTerminalAgent[]
  ambiguousPlacements: Set<string>
  /** Every process in each pane's tree in this snapshot, by `terminalPlacementKey`; none when no table was read. */
  paneProcesses?: ReadonlyMap<string, readonly ProcessIdentity[]>
}

interface RootOwner {
  agent: Omit<DiscoveredTerminalAgent, 'runtimes' | 'primaryRuntimeKey'> | null
  depth: number
  ambiguous: boolean
  /** Each row the walk visited, in walk order, whatever the pane holds. */
  processes: ProcessRow[]
  /** The chosen engine's parents inside the pane, nearest first, the root last; none without an agent. */
  ancestors: ProcessIdentity[]
}

function childrenByParent(rows: readonly ProcessRow[]): Map<number, ProcessRow[]> {
  const children = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    const list = children.get(row.parentPid) ?? []
    list.push(row)
    children.set(row.parentPid, list)
  }
  return children
}

/**
 * The daemon's own processes (its one-shot engines, a daemon run inside a pane), never agents. A pane's root is never
 * one of them, even below the daemon: on Windows the PTY host the daemon started keeps the daemon as its parent
 * (Windows does not reparent), so every engine in every pane read as the daemon's and none was found, after a host
 * crash or on the first start of a machine, until the daemon restarted (the Windows VM E2E, 2026-10-15). A tmux server
 * daemonizes, so on Unix no pane root is ever below the daemon.
 */
function daemonDescendants(children: ReadonlyMap<number, readonly ProcessRow[]>, daemonPid: number, paneRoots: ReadonlySet<number>): Set<number> {
  const excluded = new Set<number>()
  const queue = [daemonPid]
  while (queue.length) {
    const pid = queue.shift()!
    if (excluded.has(pid)) continue
    excluded.add(pid)
    for (const child of children.get(pid) ?? []) if (!paneRoots.has(child.pid)) queue.push(child.pid)
  }
  return excluded
}

function rootOwner(
  root: TerminalRootObservation,
  byPid: ReadonlyMap<number, ProcessRow>,
  children: ReadonlyMap<number, readonly ProcessRow[]>,
  excluded: ReadonlySet<number>,
  ownership: AgentCommandOwnershipSnapshot,
  hintedEngine?: AgentEngine,
): RootOwner {
  const queue: Array<{ pid: number; depth: number }> = [{ pid: root.rootPid, depth: 0 }]
  const matches: Array<{ row: ProcessRow; engine: AgentEngine; depth: number; score: number }> = []
  const processes: ProcessRow[] = []
  const seen = new Set<number>()
  let unresolvedAliasDepth = Number.POSITIVE_INFINITY

  while (queue.length) {
    const current = queue.shift()!
    // Windows never re-parents a process and reuses pids, so a root's parent pid can name its own descendant: without
    // this the walk had no end, in the core, on every pass (#4268).
    if (seen.has(current.pid)) continue
    seen.add(current.pid)
    const row = byPid.get(current.pid)
    if (row) processes.push(row)
    if (row && !excluded.has(row.pid)) {
      for (const engine of PROCESS_ENGINES) {
        const score = engineProcessMatchScore(row, engine, ownership)
        if (score > 0) matches.push({ row, engine, depth: current.depth, score })
      }
      if (ambiguousAgentProcess(row, ownership)) {
        const aliasOwner = agentAliasOwner([row.imageFileKey, row.entrypointFileKey], ownership)
        if (aliasOwner === 'unknown' && (hintedEngine === 'cursor' || hintedEngine === 'grok')) {
          matches.push({ row, engine: hintedEngine, depth: current.depth, score: 1 })
        } else {
          unresolvedAliasDepth = Math.min(unresolvedAliasDepth, current.depth)
        }
      }
    }
    for (const child of children.get(current.pid) ?? []) queue.push({ pid: child.pid, depth: current.depth + 1 })
  }

  if (!matches.length) {
    return { agent: null, depth: Number.POSITIVE_INFINITY, ambiguous: Number.isFinite(unresolvedAliasDepth), processes, ancestors: [] }
  }
  const shallowest = Math.min(...matches.map((match) => match.depth))
  if (unresolvedAliasDepth <= shallowest) return { agent: null, depth: shallowest, ambiguous: true, processes, ancestors: [] }
  const atDepth = matches.filter((match) => match.depth === shallowest)
  const strongest = Math.max(...atDepth.map((match) => match.score))
  const finalists = atDepth.filter((match) => match.score === strongest)
  const unique = new Map(finalists.map((match) => [`${match.row.pid}:${match.engine}`, match]))
  if (unique.size !== 1) return { agent: null, depth: shallowest, ambiguous: true, processes, ancestors: [] }

  const [{ row, engine }] = [...unique.values()]
  // The engine is `shallowest` steps below the root, so that many parents end at the root; a parent the table lacks
  // (it exited between reads) ends the chain there.
  const ancestors: ProcessIdentity[] = []
  for (let parent = byPid.get(row.parentPid); parent && ancestors.length < shallowest; parent = byPid.get(parent.parentPid)) {
    ancestors.push(processIdentityOf(parent))
  }
  return {
    depth: shallowest,
    ambiguous: false,
    processes,
    ancestors,
    agent: {
      engine,
      cwd: root.cwd,
      processIdentity: processIdentityOf(row),
      args: row.args,
      resumeSessionId: resumeSessionId(engine, row.args),
    },
  }
}

function runtimeRank(runtime: TerminalRuntimeRef, backendOrder: readonly string[]): number {
  const backend = backendOrder.indexOf(runtime.backend)
  return backend < 0 ? Number.MAX_SAFE_INTEGER : backend
}

/** Pure process-authoritative merge used by fixtures and the live coordinator. */
export function discoverTerminalAgentsFromSnapshot(
  roots: readonly TerminalRootObservation[],
  rows: readonly ProcessRow[],
  daemonPid: number,
  backendOrder: readonly string[],
  hints: ReadonlyMap<string, AgentEngine> = new Map(),
  ownership?: AgentCommandOwnershipSnapshot,
): { agents: DiscoveredTerminalAgent[]; ambiguousPlacements: Set<string>; paneProcesses: Map<string, ProcessIdentity[]> } {
  // Every pane belongs to this same snapshot. Build the process indexes once per scan, rather
  // than copying the whole machine's process table for every persistent pane. Keep them local:
  // the next scan must see exits, execs and PID reuse without retaining stale process identities.
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const children = childrenByParent(rows)
  const excluded = daemonDescendants(children, daemonPid, new Set(roots.map((root) => root.rootPid)))
  const grouped = new Map<string, {
    agent: Omit<DiscoveredTerminalAgent, 'runtimes' | 'primaryRuntimeKey'>
    observations: Array<{ runtime: TerminalRuntimeRef; depth: number; cwd: string; ancestors: ProcessIdentity[] }>
  }>()
  const ambiguousPlacements = new Set<string>()
  const paneProcesses = new Map<string, ProcessIdentity[]>()

  for (const root of roots) {
    // Which engine owns each command on PATH, read only once a pane is there to own: walking PATH for every
    // engine was most of an idle core's CPU, every pass, with no pane at all (#3880).
    ownership ??= agentCommandOwnershipSnapshot()
    const owner = rootOwner(root, byPid, children, excluded, ownership, hints.get(terminalRouteKey(root.runtime)))
    paneProcesses.set(terminalPlacementKey(root.runtime), owner.processes)
    if (owner.ambiguous) {
      ambiguousPlacements.add(terminalPlacementKey(root.runtime))
      continue
    }
    if (!owner.agent) continue
    const key = processIdentityKey(owner.agent.engine, owner.agent.processIdentity)
    const group = grouped.get(key) ?? { agent: owner.agent, observations: [] }
    group.observations.push({ runtime: root.runtime, depth: owner.depth, cwd: root.cwd, ancestors: owner.ancestors })
    grouped.set(key, group)
  }

  const agents = [...grouped.values()].map(({ agent, observations }): DiscoveredTerminalAgent => {
    const byPlacement = new Map<string, (typeof observations)[number]>()
    for (const observation of observations) byPlacement.set(terminalPlacementKey(observation.runtime), observation)
    // Every pane that sees this engine sees the same parent chain, each to its own root: the union is the longest.
    const former = new Map<number, ProcessIdentity>()
    for (const observation of observations) {
      for (const ancestor of observation.ancestors) if (!former.has(ancestor.pid)) former.set(ancestor.pid, ancestor)
    }
    const ordered = [...byPlacement.values()].sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth
      const ar = runtimeRank(a.runtime, backendOrder)
      const br = runtimeRank(b.runtime, backendOrder)
      if (ar !== br) return ar - br
      return terminalPlacementKey(a.runtime).localeCompare(terminalPlacementKey(b.runtime))
    })
    return {
      ...agent,
      cwd: ordered[0].cwd,
      runtimes: ordered.map((observation) => observation.runtime),
      primaryRuntimeKey: terminalRouteKey(ordered[0].runtime),
      ...(former.size ? { formerProcesses: [...former.values()] } : {}),
    }
  })
  return { agents, ambiguousPlacements, paneProcesses }
}

/** Whether the last pass saw a pane: the next one then reads the process table beside the panes. */
let panesLastPass = false

/** Probe all targets independently while reading the OS process table at most once. */
export async function probeTerminalAgents(
  backends: readonly TerminalBackend[],
  backendOrder: readonly string[],
  daemonPid = process.pid,
  hints: ReadonlyMap<string, AgentEngine> = new Map(),
): Promise<TerminalAgentProbe> {
  // The process table is read only for the panes' trees. With no pane (a daemon at rest) it is not read at all:
  // `ps` over the whole machine, every 5 s, found nothing to look under (#3880). While there are panes, and for a
  // pass someone waits on (a hint: an engine starting in a pane), it is still read beside them, as fast as before.
  const beside = hints.size || panesLastPass ? processRows() : undefined
  const targets = await Promise.all(backends.map(async (backend): Promise<TerminalTargetProbe> => ({
    instanceId: backend.instanceId,
    result: await backend.inventory().catch(() => ({ state: 'unavailable' as const, reason: 'terminal inventory failed' })),
  })))
  const roots = targets.flatMap((target) => target.result.state === 'available' ? target.result.roots : [])
  panesLastPass = roots.length > 0
  const rows = beside || roots.length ? await (beside ?? processRows()) : []
  if (!rows) return { processTableAvailable: false, targets, agents: [], ambiguousPlacements: new Set() }
  const enrichedRows = await enrichProcessRows(rows, processTreePids(rows, roots.map((root) => root.rootPid)))
  const discovered = discoverTerminalAgentsFromSnapshot(
    roots,
    enrichedRows,
    daemonPid,
    backendOrder,
    hints,
  )
  // Which endpoint each agent's engine talks to. Cached per live process, so this is one read per agent
  // for its whole life rather than one per pass — and a failed read leaves `gateway` undefined rather
  // than false. Runs for every backend: the probe reads the process, not the pane.
  await Promise.all(discovered.agents.map(async (agent) => {
    const runtime = await probeGatewayRuntime(agent.processIdentity, agent.args)
    agent.gateway = runtime.kind
    // Only the marker read is core work. Models classifies it after reconciliation, without blocking binding.
    // Read from how it was launched, which for Pi is its launcher's command line (tmux.ts `launchArgs`).
    const row = enrichedRows.find((candidate) => sameProcessIdentity(candidate, agent.processIdentity))
    const evidence = gridAssignmentEvidence('', agent.engine, await readProcessEnv(agent.processIdentity),
      row ? launchArgs(enrichedRows, row) : agent.args)
    if (evidence) agent.gridProcess = evidence
    else if (evidence === null) agent.grid = null
    // And, for Codex, the profile it runs under — a fact about the process the row cannot otherwise learn.
    agent.codexHome = await probeProfileHome(agent.processIdentity, agent.engine)
    // Hermes's declared profile is read eagerly from the same verified process environment.
    agent.hermesHome = await probeHermesHome(agent.processIdentity, agent.engine)
    if (agent.hermesHome && await probeHermesHomeDerived(agent.processIdentity, agent.engine)) agent.hermesHomeDerived = true
    // A sandboxed Hermes names its folder in its own view: the row gets the daemon's path of it, which outlives the
    // sandbox, and the agent keeps the one Hermes writes, to compare with what Hermes wrote.
    const sandbox = await probeHermesSandbox(agent.processIdentity, agent.engine)
    if (sandbox === 'unseen') agent.sandbox = sandbox
    else if (sandbox) {
      agent.sandbox = { cwd: sandbox.cwd }
      agent.cwd = sandbox.hostCwd
    }
    // And the DSH it was created as — same read, so a pane the daemon did not create is labelled too.
    agent.dsh = await probeDsh(agent.processIdentity)
    if (agent.engine === 'hermes') {
      const gateways = hermesGatewaysUnder(enrichedRows, agent.processIdentity)
      if (gateways.length) agent.formerProcesses = [...agent.formerProcesses ?? [], ...gateways]
    }
  }))
  return { processTableAvailable: true, targets, ...discovered }
}

export function targetForRuntime(probe: TerminalAgentProbe, runtime: TerminalRuntimeRef): TerminalTargetProbe | undefined {
  return probe.targets.find((target) => target.instanceId === terminalInstanceId(runtime))
}
