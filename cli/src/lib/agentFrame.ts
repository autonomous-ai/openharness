import type { ActivityFrame } from './turnActivity.js'
/**
 * The one shape an agent takes on the wire.
 *
 * Every client — the web, the device, and the desktop window — rebuilds its whole agent from
 * whichever of these frames arrived last: `agents_list` replies and `agent_synced` pushes are the
 * same object, not a snapshot and a patch. So a field this function forgets is not merely missing
 * from one frame; it is ERASED on the next push from whatever an earlier frame had reported.
 *
 * That is not hypothetical. This module exists because there were two hand-maintained copies of the
 * shape — one in `cli.ts` behind `agent_synced`, one in `backendSocket.ts` behind `agents_list` —
 * and `grid` was added to the second only. The desktop showed an agent's grid correctly the moment
 * it was moved, then the next reconciliation pushed a frame with no `grid` at all, the app read that
 * as "on no grid", and its "N running agents are on an older target" banner came back for agents
 * that were already exactly where the user had put them.
 *
 * Pure on purpose: the two callers own the registry, so what they know (is the terminal available,
 * which model did the runtime profile resolve) is passed in rather than looked up here. That is what
 * makes the shape testable without a registry, which is the whole reason the drift went unnoticed.
 */

import { agentProject, type AgentProject } from './agentProject.js'
import { sessionGitContext, SessionGitContextReader, type SessionGitContext } from './sessionGitContext.js'
import { sessionGitHistory } from './sessionGitHistory.js'
import { transcriptActivityAt } from './transcriptActivity.js'
import type { AgentTokenUsage } from './agentTokenUsage.js'
import type { AgentOutputStats } from './agentOutputStats.js'
import type { GridAssignment } from './gridAssignment.js'
import type { GridWebSearchStatus } from './gridLaunch.js'
import { gridAnnotation, type GridAnnotation } from './gridModels.js'
import { projectDisplayName, sessionDisplayTitle, type RegisteredSession } from './registry.js'
import { engineCanFork } from './forkAgent.js'
import { resumeMode, type ResumeMode } from './resumeCapability.js'
import type { DshVerdict } from '../dsh/verdict.js'

/**
 * The grid block on the wire: where the agent's inference goes, and — when the daemon built the
 * launch — whether it can search the web. `webSearch` is absent, not null, when there is nothing to
 * say: a discovered grid agent, or a row from before the daemon recorded it. The app shows nothing
 * for absent and for `on`; the two degraded words each get a sentence.
 */
export type GridFrameBlock = GridAssignment & { webSearch?: GridWebSearchStatus } & Partial<GridAnnotation>

/**
 * One agent as it travels to every client.
 *
 * A `type` rather than an `interface` so it stays assignable to the `Record<string, unknown>` the
 * frame senders take — an interface gets no implicit index signature.
 */
export type AgentFrame = {
  id: string
  sessionId: string
  userId: string
  name: string
  /**
   * What the agent is on, in its own words — the session title (Claude Code's, Codex's), cleaned;
   * null when there is none or it is the name already. It is usually the name too (registry.ts,
   * projectDisplayName), but not once the person renames the agent, and a client searching for
   * "board fab check" must still find it by this, not by luck in a recap.
   */
  title: string | null
  status: string
  activity: ActivityFrame | null
  closePlan: { state: 'waiting' | 'failed'; detail?: string } | null
  closeSupported: boolean
  launch: NonNullable<RegisteredSession['launch']>
  createdAt: string
  updatedAt: string
  /**
   * When any app last opened this agent (`agent_update {opened: true}`), stamped by this daemon's
   * clock (registry.ts, `markOpened`). ALWAYS present: null means nobody has opened it yet, while an
   * absent key means a daemon too old to keep the stamp — the distinction a client needs to tell "never
   * opened" from "cannot say". A client's "last used" is the later of this and `updatedAt`, so every
   * app orders the same agents the same way.
   */
  lastOpenedAt: string | null
  /** Cached usage from this conversation's owning machine; null means unreported, never zero. */
  tokenUsage: AgentTokenUsage | null
  outputStats: (AgentOutputStats & { updatedAt: string }) | null
  tmuxPane: string | null
  terminal: { available: boolean; primary: string; runtimes: RegisteredSession['runtimes'] }
  engine: RegisteredSession['engine']
  selectedModel: string | null
  grid: GridFrameBlock | null
  codexHome: string | null
  project: AgentProject | null
  /** Additive display context; project/cwd remain the registered launch workspace. */
  gitContext: SessionGitContext
  /** The domain-specific harness this agent was created as, or null for a plain engine. */
  dsh: string | null
  /** Its display name from the installed manifest; null when unknown here (not installed, plain engine). */
  dshName: string | null
  /** Where this agent's viewer is being served right now, or null when it has none up. */
  viewerUrl: string | null
  /** What its viewer pane is called ("3D Viewer", "Marp Viewer"); null with no viewer or none known. */
  viewerName: string | null
  /** The DSH's last verdict for this workspace, reduced for the pane header; null when none yet. */
  verdict: DshVerdict | null
  /** The agent this one was forked from (`agent_fork`), or null — a real answer, like `dsh: null`. */
  forkedFrom: { agentId: string; name: string } | null
  /** Whether `agent_fork` can do anything for this engine (lib/forkAgent.ts) — natively, or by a
   *  handoff. A client hides the Fork action on a false rather than offering a button that refuses. */
  forkable: boolean
  /**
   * How much a Pause of this harness can promise to bring back (lib/resumeCapability.ts):
   * `'shell'` (a terminal — a fresh shell in the same tile), `'conversation'` (this engine reopens
   * the one it was in) or `'fresh'` (it comes back, as a new conversation). Every value is
   * pausable; a client words the button from this rather than keeping its own copy of the engine
   * table, which is how the two drifted before.
   */
  resumeMode: ResumeMode
  /**
   * The launch choices a client needs to open ANOTHER agent like this one — the desktop's Clone
   * (`agent_create` with the same `permissionMode`, `bypassPermission` and `agent`). Read off the
   * registry row, never off the live process. Each null is a real answer: a row from before the
   * choice existed, or an agent Harness did not launch, has none to report — and a clone of one
   * falls back to the client's own defaults rather than to a guess made here.
   */
  permissionMode: string | null
  bypassPermission: boolean | null
  /** The engine's named agent (`agent_create`'s `agent`); `namedAgent` on the wire so an agent
   *  object never carries a key called `agent`. */
  namedAgent: string | null
}

/** What the daemon knows about an agent's DSH — looked up by the caller, never here. */
export interface AgentDshContext {
  /** The harness's CURRENT id — an agent created under a former name (`formerly`) reports the new one. */
  id: string | null
  name: string | null
  viewerUrl: string | null
  /** manifest.ts, dshViewerName. */
  viewerName?: string | null
  verdict: DshVerdict | null
}

/** What the caller knows and this module deliberately does not look up for itself. */
export interface AgentFrameContext {
  /** Evaluated after asynchronous projection, so old snapshots cannot revive work. */
  activity?: () => ActivityFrame | null
  /** The runtime profile's answer for this session, or null when there is none. */
  selectedModel: string | null
  /** `registry.terminalAvailable(agentId)` — the caller already holds the registry. */
  terminalAvailable: boolean
  tokenUsage?: AgentTokenUsage | null
  /** The DSH companions' state for this agent; absent when the caller has none to give. */
  dsh?: AgentDshContext | null
}

/**
 * When the conversation last moved, in epoch ms: dated work in the transcript, else the last time the engine
 * reported in (a hook, or a session bind — the agent's creation at the latest).
 *
 * ⚠️ Never the registry row's `touchedAt`. That is bookkeeping: discovery used to rewrite it on every
 * pass, so falling back to it stamped every agent without a readable transcript "now"
 * — and a client sorting by recency put exactly those agents above the ones just used. File mtime is
 * bookkeeping too: an idle transcript can be rewritten without a new conversation event.
 *
 * "The agent's creation at the latest" is the part that was missing: a row no hook has ever reached —
 * a bare terminal, an engine still starting, a harness opened from the catalog — carries
 * `lastHookAt: 0`, and answering the epoch made a client render its age as 20719 days ("20719d") and
 * sort it below everything. Creation is a real answer for "nothing has happened yet"; zero is not.
 *
 * Every step is a stamp the row already carries, never a fresh clock read: a client compares this
 * field to decide whether an agent changed at all (the desktop's `agentsEqual`), so a value that
 * moves on its own would redraw the row on every sync and reset its age to "0m" forever.
 */
export async function lastActivityAt(s: RegisteredSession): Promise<number> {
  return await transcriptActivityAt(s.transcriptPath, s.engine)
    ?? (s.lastHookAt || s.boundAt || s.registeredAt)
}

function frameTitle(s: RegisteredSession): string | null {
  const title = sessionDisplayTitle(s)
  return title && title !== projectDisplayName(s) ? title : null
}

/**
 * One agent as every client consumes it. `updatedAt` is {@link lastActivityAt}, so a client sorting by
 * recency follows the conversation rather than the daemon's housekeeping; `lastOpenedAt` is the other
 * half of "last used" — when a person last opened it, from any app — and a client sorts by the later
 * of the two.
 */
const gitContexts = new SessionGitContextReader()

export async function agentFrame(
  s: RegisteredSession,
  { selectedModel, terminalAvailable, dsh, tokenUsage, activity: contextActivity }: AgentFrameContext,
): Promise<AgentFrame> {
  const home = agentProject(s.cwd)
  const context = gitContexts.read(JSON.stringify([s.agentId, s.sessionId, s.engine, s.codexHome, s.registeredAt]), async () => {
    const saved = await sessionGitHistory.get(s)
    const value = await sessionGitContext(await home, tokenUsage?.work, undefined, saved)
    value.history = await sessionGitHistory.observe(s, value)
    return value
  })
  const [project, updatedAt, gitContext] = await Promise.all([home, lastActivityAt(s), context])
  return {
    id: s.agentId,
    sessionId: s.sessionId,
    userId: '',
    name: projectDisplayName(s),
    title: frameTitle(s),
    status: s.active ? 'active' : 'offline',
    activity: contextActivity?.() ?? null,
    closePlan: s.closePlan ? { state: s.closePlan.state, ...(s.closePlan.detail ? { detail: s.closePlan.detail } : {}) } : null,
    closeSupported: true,
    launch: s.launch ?? { state: 'ready' },
    createdAt: new Date(s.registeredAt).toISOString(),
    updatedAt: new Date(updatedAt).toISOString(),
    // Null, never omitted, for the reason the module doc gives: a push without the key would erase
    // the open an earlier frame had reported.
    lastOpenedAt: s.lastOpenedAt ? new Date(s.lastOpenedAt).toISOString() : null,
    tokenUsage: tokenUsage?.totalTokens != null
      ? { totalTokens: tokenUsage.totalTokens, updatedAt: tokenUsage.updatedAt,
        ...(tokenUsage.inputTokens == null ? {} : { inputTokens: tokenUsage.inputTokens }),
        ...(tokenUsage.outputTokens == null ? {} : { outputTokens: tokenUsage.outputTokens }),
        ...(tokenUsage.cachedTokens == null ? {} : { cachedTokens: tokenUsage.cachedTokens }),
      } : null,
    outputStats: tokenUsage?.output ? { ...tokenUsage.output, updatedAt: tokenUsage.updatedAt } : null,
    tmuxPane: s.tmuxPane || null,
    terminal: { available: terminalAvailable, primary: s.primaryRuntimeKey, runtimes: s.runtimes },
    engine: s.engine,
    selectedModel,
    // Where this agent's inference actually goes, so a client can tell which agents a newly picked
    // grid has left behind. Read off the live process by discovery; carries no credential. Null is
    // a real answer ("on no grid") and must be sent as one — omitting the key would make every push
    // indistinguishable from a daemon too old to know about grids. The web-search status rides on
    // the block — decided by the launch, kept on the row — so it is gone the moment the block is. So do
    // that grid's `state` and a `note` when the agent's model will not answer (issue 03), read from what
    // the model list last showed — no I/O, and absent for a grid this daemon is not tracking.
    grid: s.grid ? { ...s.grid, ...(s.gridWebSearch ? { webSearch: s.gridWebSearch } : {}), ...gridAnnotation(s.grid) } : null,
    // The Codex profile folder this agent launched against, if one was chosen instead of the
    // engine's own login. Codex only; null is a real answer ("uses ~/.codex") for the same reason
    // `grid: null` is above.
    codexHome: s.codexHome ?? null,
    project,
    gitContext,
    // All five are real answers when null, for the reason the module doc gives: a frame that omits
    // them would erase a viewer URL or a verdict an earlier frame had reported.
    dsh: dsh?.id ?? s.dsh ?? null,
    dshName: dsh?.name ?? null,
    viewerUrl: dsh?.viewerUrl ?? null,
    viewerName: dsh?.viewerName ?? null,
    verdict: dsh?.verdict ?? null,
    forkedFrom: s.forkedFrom ? { agentId: s.forkedFrom.agentId, name: s.forkedFrom.name } : null,
    forkable: engineCanFork(s.engine),
    resumeMode: resumeMode(s.engine),
    permissionMode: s.permissionMode ?? null,
    bypassPermission: s.bypassPermission ?? null,
    namedAgent: s.agent ?? null,
  }
}
