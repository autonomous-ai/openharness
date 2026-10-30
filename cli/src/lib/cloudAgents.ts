/**
 * Cloud agents: agents that run on their maker's servers and are reached through its API rather than started
 * as a terminal program here (docs/design/2026-10-11-cloud-agents.md). The cloud service owns them
 * (services/cloud.ts); the core lists them beside the terminal agents and routes a person's answers,
 * messages and Stop to that service (core/agents/cloud.ts). This file is what the two, and the frames the
 * apps read, share.
 *
 * A cloud agent's id is never an engine id (engines/types.ts `ENGINES`): it has no launch, transcript or pane,
 * and every per-engine table in the core would otherwise need a row for it that could only refuse.
 */
import type { AgentFrame } from './agentFrame.js'

export interface CloudAgentInfo {
  /** What the apps call it: a CLI agent's name plus "Cloud" for its maker's cloud coding agent (Naming System). */
  name: string
  /** Where it runs, said where a remote computer's name goes. */
  place: string
  /** A coding agent works on a GitHub repository; a personal agent runs errands and takes no repository. */
  kind: 'coding' | 'personal'
  /** A coding agent that can start with no repository: Devin's API takes `repos` as optional (lampOS asked, #1444). */
  repositoryOptional?: true
  /** How its connection is found among the person's Connections: by the host its MCP server or API is at. */
  connection: { mcp: string } | { api: string }
  /** What to connect, said when it is not connected. */
  connect: string
}

export const CLOUD_AGENTS = {
  fo: {
    name: 'Fo', place: "Fo's cloud", kind: 'personal', connection: { mcp: 'mcp.api.wajo.ai' },
    connect: 'Connect Fo in Connections (Add custom, https://mcp.api.wajo.ai/fo).',
  },
  'devin-cloud': {
    name: 'Devin Cloud', place: "Devin's cloud", kind: 'coding', repositoryOptional: true, connection: { api: 'https://api.devin.ai' },
    connect: 'Add your Devin API key: harness connections add-key Devin https://api.devin.ai',
  },
  'cursor-cloud': {
    name: 'Cursor Cloud', place: "Cursor's cloud", kind: 'coding', connection: { api: 'https://api.cursor.com' },
    connect: 'Add your Cursor API key: harness connections add-key Cursor https://api.cursor.com',
  },
} as const satisfies Record<string, CloudAgentInfo>

export type CloudAgentId = keyof typeof CLOUD_AGENTS
export const CLOUD_AGENT_IDS = Object.keys(CLOUD_AGENTS) as CloudAgentId[]

export function isCloudAgent(id: unknown): id is CloudAgentId {
  return typeof id === 'string' && Object.hasOwn(CLOUD_AGENTS, id)
}

/** `owner/name` from a GitHub address or the pair itself, or null. */
export function repositoryOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(value.trim())
  return match ? `${match[1]}/${match[2]}` : null
}

/**
 * Why a cloud agent cannot start this task, in the words a person reads, or null when it can. The cloud service
 * answers with it (cloud/service.ts) and `harness new` refuses with it before sending (lib/newCommand.ts): a typo
 * there reached the service and came back a counted launch failure (Oct 26 report). [repositories] are the ways a
 * request names one, the first that reads winning.
 */
export function cloudRequestRefusal(agent: CloudAgentId, task: string, repositories: readonly unknown[]): string | null {
  const info: CloudAgentInfo = CLOUD_AGENTS[agent]
  if (!task.trim()) return `Tell ${info.name} what to do.`
  const repository = repositories.map(repositoryOf).find(Boolean)
  // A repository given but not read (a GitLab address, a typo) is refused: started without it, the agent would work blind.
  if (!repository && repositories.some(Boolean)) return 'That is not a GitHub repository: give owner/name or https://github.com/owner/name.'
  if (info.kind === 'coding' && !info.repositoryOptional && !repository) return `Choose a GitHub repository for ${info.name}.`
  return null
}

/** Where a cloud harness is: working, waiting on the person, done with its turn, failed, or stopped. */
export type CloudState = 'starting' | 'working' | 'needs_input' | 'idle' | 'failed' | 'stopped'
export const CLOUD_STATES: readonly CloudState[] = ['starting', 'working', 'needs_input', 'idle', 'failed', 'stopped']

/**
 * The maker's own status, beside Harness's. A null is a reading where the maker gave none, so a later look
 * can drop a detail that went away. It does not say whether the words in the transcript were a question:
 * Devin's `finished` and a wait can look the same, and the text is not a status.
 */
export interface CloudProviderStatus {
  status: string | null
  detail: string | null
}

/** One cloud harness, as the cloud service tells the core about it (`core.cloud.publish`). */
export interface CloudHarness {
  /** Harness's own id for it, `cloud_…`: never the vendor's session id, which the service keeps. */
  agentId: string
  agent: CloudAgentId
  name: string
  state: CloudState
  /** What it is doing, in a line ("Calling Hair Lab"), or null. */
  activity: string | null
  /** The maker's own status. Absent on a harness saved before it was kept, and for a maker that does not report one. */
  providerStatus?: CloudProviderStatus
  /** The GitHub repository a coding agent works on (`owner/name`), or null. */
  repository: string | null
  branch: string | null
  /** Where to see it at its maker (the session page) and what it made (a pull request). */
  links: { label: string; url: string }[]
  /** How many messages its conversation holds: a client that shows it reads the conversation again when this moves. */
  messages: number
  /** What it said last, for the dial's card: a terminal agent's turn ends with its answer the same way. Kept in
   *  the core alone, never in a frame: the apps read the whole conversation. */
  said?: string | null
  createdAt: string
  updatedAt: string
}

/** As much of its last words as the dial's longest card draws, and some over (lib/deviceRecap.ts). */
export const SAID_MAX = 4_000
/** A maker's own status string on the way into the core: long enough for an unknown detail, and no more. */
const PROVIDER_STATUS_MAX = 200

const text = (value: unknown, max = 500): string | null => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null)
const stamp = (value: unknown): string | null => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null)

/** A maker's status beside the harness, or nothing when it is absent or not an object. A bad field is dropped, not the harness. */
function providerStatusIn(raw: unknown): CloudProviderStatus | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  return { status: text(value.status, PROVIDER_STATUS_MAX), detail: text(value.detail, PROVIDER_STATUS_MAX) }
}

/** A harness as a service reported it, or null for anything else: the core keeps nothing it cannot read. */
export function cloudHarnessIn(raw: unknown): CloudHarness | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const agentId = text(value.agentId, 80)
  const createdAt = stamp(value.createdAt), updatedAt = stamp(value.updatedAt)
  if (!agentId?.startsWith('cloud_') || !isCloudAgent(value.agent) || !CLOUD_STATES.includes(value.state as CloudState) || !createdAt || !updatedAt) return null
  const links = Array.isArray(value.links) ? value.links.flatMap((link) => {
    const entry = link as Record<string, unknown> | null
    const label = text(entry?.label, 80), url = text(entry?.url, 2048)
    return label && url && /^https:\/\//.test(url) ? [{ label, url }] : []
  }).slice(0, 8) : []
  const providerStatus = providerStatusIn(value.providerStatus)
  return {
    agentId,
    agent: value.agent,
    name: text(value.name, 120) ?? CLOUD_AGENTS[value.agent].name,
    state: value.state as CloudState,
    activity: text(value.activity, 200),
    ...(providerStatus ? { providerStatus } : {}),
    repository: text(value.repository, 200),
    branch: text(value.branch, 200),
    links,
    messages: typeof value.messages === 'number' && Number.isInteger(value.messages) && value.messages >= 0 ? value.messages : 0,
    said: text(value.said, SAID_MAX),
    createdAt,
    updatedAt,
  }
}

/** What the apps read about a cloud agent beyond an agent's usual frame: `location: 'cloud'` and this. */
export interface CloudFrameBlock {
  place: string
  state: CloudState
  activity: string | null
  links: { label: string; url: string }[]
  messages: number
  /** Absent when the harness has no maker status (an older one, or Fo and Cursor). */
  providerStatus?: CloudProviderStatus
}

export type CloudAgentFrame = Omit<AgentFrame, 'engine'> & { engine: CloudAgentId; location: 'cloud'; cloud: CloudFrameBlock }

/**
 * A cloud harness as every client reads an agent: the same frame a terminal agent has, with no pane and no
 * terminal (as a stopped agent's), `location: 'cloud'` for the chat pane, and its repository as its project
 * so the footer and the pull request read it as they read any other.
 */
export function cloudAgentFrame(harness: CloudHarness): CloudAgentFrame {
  const working = harness.state === 'working' || harness.state === 'starting'
  const project = harness.repository
    ? { kind: 'git' as const, name: harness.repository.split('/').pop() ?? harness.repository, cwd: '', root: null,
      remote: `https://github.com/${harness.repository}`, branch: harness.branch }
    : null
  return {
    id: harness.agentId,
    sessionId: harness.agentId,
    userId: '',
    name: harness.name,
    title: null,
    status: harness.state === 'stopped' ? 'stopped' : 'active',
    activity: { state: working ? 'working' : 'idle', epoch: harness.agentId, revision: Date.parse(harness.updatedAt), validForMs: working ? 120_000 : 0 },
    closePlan: null,
    closeSupported: false,
    launch: harness.state === 'failed' ? { state: 'failed', error: 'CLOUD_FAILED', detail: harness.activity ?? `${CLOUD_AGENTS[harness.agent].name} stopped with an error.` }
      : harness.state === 'starting' ? { state: 'starting' } : { state: 'ready' },
    createdAt: harness.createdAt,
    updatedAt: harness.updatedAt,
    lastOpenedAt: null,
    tokenUsage: null,
    outputStats: null,
    tmuxPane: null,
    terminal: { available: false, primary: '', runtimes: [] },
    engine: harness.agent,
    selectedModel: null,
    grid: null,
    codexHome: null,
    project,
    gitContext: { state: project ? 'workspace' : 'unavailable', current: project, observedAt: null, locations: [], pullRequests: [], truncated: false },
    dsh: null,
    dshName: null,
    viewerUrl: null,
    viewerName: null,
    verdict: null,
    forkedFrom: null,
    forkable: false,
    // A person starts a cloud harness from New Harness: no agent here or elsewhere started it.
    parentAgentId: null,
    startedBy: null,
    resumeMode: 'conversation',
    permissionMode: null,
    bypassPermission: null,
    namedAgent: null,
    location: 'cloud',
    cloud: {
      place: CLOUD_AGENTS[harness.agent].place, state: harness.state, activity: harness.activity, links: harness.links, messages: harness.messages,
      ...(harness.providerStatus ? { providerStatus: { status: harness.providerStatus.status, detail: harness.providerStatus.detail } } : {}),
    },
  }
}
