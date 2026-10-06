/**
 * The agents on this machine, for a window or a device that asks (`agents_list`): every live agent's
 * frame and, when asked for, the stopped ones a person can resume, in one stable order. A device gets
 * the rows it can draw, trimmed to what its firmware holds; a window that asks for the monitor gets each
 * agent's activity and resource readings as well.
 *
 * Moved verbatim out of the socket's request switch (docs/design/2026-10-03-harnessd.md), with the
 * device trimming it alone used.
 */
import { isTerminalEngine, PROCESS_ENGINES, type ProcessEngine } from '../../engines/types.js'
import type { AgentFrame } from '../../lib/agentFrame.js'
import type { MonitorActivity, MonitorCompletions } from '../../lib/harnessMonitor.js'
import type { createHarnessResourcesReader } from '../../lib/harnessResources.js'
import type { createHarnessStorageReader } from '../../lib/harnessTelemetry.js'
import type { registry, RegisteredSession } from '../../lib/registry.js'
import type { stoppedAgents } from '../../lib/stoppedAgents.js'

const DEVICE_AGENT_LIST_LIMIT = 100
const DEVICE_AGENT_NAME_MAX_CODEPOINTS = 15
const DEVICE_AGENT_NAME_MAX_BYTES = 39 // device project_t.name[40], including trailing NUL on-device.
const DEVICE_ELLIPSIS = '…'

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

function clipDeviceAgentName(input: string): string {
  const chars = [...input]
  if (chars.length <= DEVICE_AGENT_NAME_MAX_CODEPOINTS && byteLen(input) <= DEVICE_AGENT_NAME_MAX_BYTES) return input
  const ellipsisBytes = byteLen(DEVICE_ELLIPSIS)
  let out = ''
  for (const ch of chars.slice(0, DEVICE_AGENT_NAME_MAX_CODEPOINTS)) {
    if (byteLen(out) + byteLen(ch) + ellipsisBytes > DEVICE_AGENT_NAME_MAX_BYTES) break
    out += ch
  }
  return `${out}${DEVICE_ELLIPSIS}`
}

export function deviceAgentListItem(
  raw: unknown,
): { id: unknown; name?: string; engine?: ProcessEngine; selectedModel?: string | null } {
  const o = (raw ?? {}) as Record<string, unknown>
  const item: { id: unknown; name?: string; engine?: ProcessEngine; selectedModel?: string | null } = { id: o.id }
  if (typeof o.name === 'string') item.name = clipDeviceAgentName(o.name)
  // The dial only ever meets process engines — a terminal never reaches it (see `deviceAgentRow`),
  // and the union here says so rather than repeating fourteen string literals.
  if (typeof o.engine === 'string' && (PROCESS_ENGINES as readonly string[]).includes(o.engine)) item.engine = o.engine as ProcessEngine
  // Runtime model/effort profile (opaque runtime-v1:...) — lets the device render + change model/effort.
  if (typeof o.selectedModel === 'string' || o.selectedModel === null) item.selectedModel = o.selectedModel
  return item
}

/**
 * Whether an agent row belongs on a device at all. The dial drives agents — a terminal with nobody
 * running in it has no turn to watch, no question to answer and no model to switch, so it is not
 * listed there; the same row becomes listable the moment an engine is started inside it and its
 * `engine` flips (registry `adoptEngine`).
 */
export function deviceAgentRow(raw: unknown): boolean {
  const o = (raw ?? {}) as Record<string, unknown>
  return !isTerminalEngine(typeof o.engine === 'string' ? o.engine : undefined)
}

export interface AgentListDeps {
  registry: Pick<typeof registry, 'advertised'>
  /** The saved conversations of stopped agents, less those running again. */
  stoppedAgents: Pick<typeof stoppedAgents, 'available'>
  /** A live agent's frame and a stopped one's, as the socket builds them for every other reply. */
  toProject: (s: RegisteredSession) => Promise<AgentFrame>
  toStoppedProject: (s: RegisteredSession) => Promise<AgentFrame>
  /** The monitor's readings: each agent's processes, and what its workspace and transcript hold. */
  harnessResourcesReader: ReturnType<typeof createHarnessResourcesReader>
  harnessStorageReader: ReturnType<typeof createHarnessStorageReader>
  /** What an agent is doing, from its turns and questions (core/questions.ts). Null while unknown. */
  monitorActivityProvider: ((sessionId: string) => MonitorActivity) | null
  /** How an agent's last turn ended, from the turn frames the socket sent. */
  monitorCompletions: Pick<MonitorCompletions, 'state'>
}

export function createAgentList({
  registry, stoppedAgents, toProject, toStoppedProject, harnessResourcesReader, harnessStorageReader,
  monitorActivityProvider, monitorCompletions,
}: AgentListDeps) {
  /**
   * Answers `agents_list` through `reply`: before it returns, or, for the monitor's readings, once
   * they are read. `sessionRole` is the asking connection's paired role, read where the list needs it.
   */
  const agentsList = async (
    payload: Record<string, unknown>,
    sessionRole: () => string | null,
    reply: (result: Record<string, unknown>) => void,
  ): Promise<void> => {
    const sessions = registry.advertised()
    const projects = await Promise.all(sessions.map((s) => toProject(s)))
    // Older clients/devices keep their live-only contract. The desktop picker
    // explicitly asks for stopped work and receives no stale terminal routes.
    const savedSessions = payload.includeStopped === true && sessionRole() !== 'device' ? stoppedAgents.available(sessions) : []
    projects.push(...await Promise.all(savedSessions.map(s => toStoppedProject(s))))
    // Ordered by creation time, oldest → newest — a stable tab order that doesn't reshuffle as
    // sessions become active (createdAt = the session's registeredAt). The id breaks a tie so the
    // order is TOTAL: without it two agents registered in the same millisecond fall through to array
    // position, which is Map insertion order and differs between daemon runs — the web, the app and
    // the dial would each show a different order for the same registry. `cableHost.listAgents`
    // sorts by the same rule; the two must stay identical.
    projects.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))
    if (sessionRole() === 'device') {
      reply({ agents: projects.filter(deviceAgentRow).slice(0, DEVICE_AGENT_LIST_LIMIT).map(deviceAgentListItem) })
      return
    }
    if (payload.monitor === true) {
      // Optional telemetry must never hold the ordered terminal-input queue.
      void (async () => {
        const [snapshot, storage] = await Promise.all([
          harnessResourcesReader().catch(() => ({ agents: [], sampledAt: null, shared: [] })),
          harnessStorageReader([...sessions, ...savedSessions]).catch(() => new Map()),
        ])
        const resources = new Map(snapshot.agents.map(row => [row.agentId, row]))
        const byId = new Map(sessions.map(s => [s.agentId, s]))
        reply({ agents: projects.map(agent => {
          const session = byId.get(agent.id)
          const activity = session ? monitorActivityProvider?.(session.sessionId) : null
          const reading = resources.get(agent.id)
          return { ...agent, monitor: {
            activity: activity && activity !== 'idle' ? activity : session ? monitorCompletions.state(session) : 'idle',
            activityKnown: monitorActivityProvider !== null,
            rssBytes: agent.status === 'stopped' ? 0 : reading?.memoryBytes ?? null,
            cpu: agent.status === 'stopped' ? 0 : reading?.cpuPercent ?? null,
            pid: reading?.processCount != null ? session?.processIdentity?.pid ?? null : null,
            sampledAt: snapshot.sampledAt,
            processCount: reading?.processCount ?? null,
            gpuMemoryBytes: reading?.gpuMemoryBytes ?? null,
            gpuPercent: reading?.gpuPercent ?? null,
            diskReadBytesPerSecond: reading?.diskReadBytesPerSecond ?? null,
            diskWriteBytesPerSecond: reading?.diskWriteBytesPerSecond ?? null,
            processes: reading?.processes ?? [],
            ...(storage.get(agent.id) ?? {}),
          } }
        }), sharedResources: snapshot.shared ?? [], sampledAt: snapshot.sampledAt })
      })().catch(() => reply({ error: 'UNAVAILABLE' }))
    } else reply({ agents: projects })
  }

  return { agentsList }
}
