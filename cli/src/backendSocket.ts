import type { PurgeAgentService } from './lib/purgeAgentService.js'
import type { Asker } from './core/api.js'
import { ServiceUnavailableError } from './core/serviceHost.js'
import type { ActivityFrame } from './lib/turnActivity.js'
import { readSessionGitPullRequest } from './lib/sessionGitPullRequest.js'
import { MonitorCompletions, type MonitorActivity } from './lib/harnessMonitor.js'
import type { HarnessShareOwner } from './sharing/owner.js'
import { SHARE_REQUEST_TYPES } from './sharing/protocol.js'
import { AutonomousDeviceRelay } from './lib/autonomous-device/relay.js'
import { deviceDump } from './lib/autonomous-device/dump.js'
import type { AutonomousDeviceService, AutonomousDeviceFrame } from './lib/autonomous-device/service.js'
/**
 * BackendSocket — the CLI's dial-out connection to the backend's `/api/adapter-ws`.
 *
 * The adapter occupies the NODE side of its agentId on the backend hub:
 *   - `up`   { t:'up', frame }            → normalized claude events + `<x>_result` RPC replies
 *   - `down` { t:'down', connId, frame }  → web chat/control + data-plane RPC requests
 *
 * Mirrors the hosted runtime’s managerSocket: idempotent connect, exponential backoff (1s→30s),
 * WS liveness (`lib/wsLiveness.ts`: ping every 20s, 60s deadline on silence) + a 15s app-level
 * `{t:'ping'}` that refreshes the backend presence key, and a bounded FIFO queue for client-facing
 * outbound frames.
 *
 * Auth: the SSO access token rides as the first WS subprotocol.
 */

import { WebSocket } from 'ws'
import { BACKEND_IDLE_DEADLINE_MS, watchSocketLiveness, type LivenessWatch } from './lib/wsLiveness.js'
import { stat, readdir } from 'fs/promises'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'path'
import { hostname, homedir } from 'os'
import { env } from './config/env.js'
import { AuthSessionManager, AuthSessionError } from './lib/authSession.js'
import { VERSION } from './version.js'
import { registry, projectDisplayName, type RegisteredSession } from './lib/registry.js'
import { AgentStopError } from './lib/stopAgentService.js'
import type { CloseAgentService, CloseMode } from './lib/closeAgentService.js'
import { MODEL_MANAGER_ID } from './dsh/builtins.js'
import { ENGINES, PROCESS_ENGINES, isTerminalEngine, type AgentEngine, type ProcessEngine } from './engines/types.js'
import { listDir } from './lib/fsBrowse.js'
import { linkCodexProfile, listCodexProfiles } from './lib/codexProfiles.js'
import { gridCliPresence } from './lib/gridExec.js'
import { GridFleetRpc, GRID_FLEET_PROTOCOL, GRID_FLEET_MAX_TIMEOUT_MS, parseGridFleetRequest } from './lib/gridFleetRpc.js'
import { LocalModels } from './lib/localModels.js'
import { appEngineOps, scanAppModels } from './lib/appModels.js'
import { ApiConnectionError, ApiConnections, apiConnectionsRequest } from './lib/apiConnections.js'
import { apiModelsRequest, rememberSavedApis, resolveApiTarget } from './lib/apiModels.js'
import { gridCapableEngines, isApiLaunch, parseGridLaunchOverride, type GridLaunchOverride } from './lib/gridLaunch.js'
import {
  forgetGridModels, gridInventory, listAllGridModels, onGridModelsChanged, presentGridSections, retargetPrewarm, type GridSection,
} from './lib/gridModels.js'
import { resolveGridTarget } from './lib/gridTarget.js'
import type { GridAttachResult } from './lib/gridAttach.js'
import { parseNewAgentModel, resolveNewAgentModel } from './lib/newAgentModel.js'
import { deriveHarnessGridName } from './lib/gridDerive.js'
import { AGENT_NAME_RE, FirstPromptUnsupportedError, MAX_FIRST_PROMPT_CHARS, NamedAgentUnsupportedError, permissionModeApproves, permissionModeFlags, supportsFirstPrompt, supportsNamedAgent } from './lib/engineLaunch.js'
import { opencodeMajorVersion } from './engines/opencode/version.js'
import { readAccountUsage, type AccountUsageReading } from './lib/accountUsage.js'
import { probeEngines } from './lib/engineProbe.js'
import { readMachineResources } from './lib/machineResources.js'
import { harnessDevicesRequest, type HarnessDevicesService } from './lib/harnessDevices.js'
import { createHarnessResourcesReader } from './lib/harnessResources.js'
import { createHarnessStorageReader } from './lib/harnessTelemetry.js'
import { AgentCreationReceipts, AgentCreationReceiptError, creationFingerprint, validCreationId, type AgentCreationStatus } from './lib/agentCreationReceipt.js'
import { engineInstallRecipe } from './lib/engineInstall.js'
import { parseProjectFolder, prepareProjectFolder, projectsRoot, ProjectFolderError } from './lib/projectFolder.js'
import { claudeTrusts, codexTrusts, preTrustClaudeProject, preTrustCodexProject } from './lib/claudeTrust.js'
import { projectPreview } from './lib/projectPreview.js'
import { readGitProject } from './lib/gitProject.js'
import { agentFrame, lastActivityAt, type AgentDshContext, type AgentFrame } from './lib/agentFrame.js'
import { agentTokenUsage } from './lib/agentTokenUsage.js'
import { installedDsh } from './dsh/installed.js'
import { installedHarnessCatalog, orchestratorEngineSupported } from './orchestrator/catalog.js'
import { OrchestratorService } from './orchestrator/service.js'
import { OrchestratorError } from './orchestrator/model.js'
import { orchestratorRequest } from './orchestrator/wire.js'
import { TeamService } from './teams/service.js'
import { SwarmPromptScopes } from './teams/promptScope.js'
import { ChannelDirectory } from './teams/channels.js'
import { TeamMailbox } from './teams/mailbox.js'
import { teamRequest, teamDeliveryRequest, TEAM_REQUEST_TYPES, teamFailure } from './teams/wire.js'
import { teamRpc } from './teams/client.js'
import { Address, Id, OperationId, Receipt, TeamError, type MemberRuntime } from './teams/model.js'
import { shellQuote } from './orchestrator/prompts.js'
import type { SessionInputDelivery } from './lib/sessionInput.js'
import type { QuestionAnswerResult } from './lib/askQuestion.js'
import { engineLabel } from './lib/agentNames.js'
import { DSH_ID_RE, dshSupportedEngines } from './dsh/manifest.js'
import { terminalHandoffRequest } from './lib/terminalHandoff.js'
import { routeVoiceTask } from './lib/voiceRouter.js'
import { stoppedAgents } from './lib/stoppedAgents.js'
import { messagesToEvents, windowRawLines, SubagentStats, type SessionEvent } from './lib/normalize.js'
import { TranscriptPager } from './lib/transcriptPages.js'
import { streamRecords, tailFileCapped, WHOLE_READ_CAP_BYTES } from './lib/transcriptTail.js'
import { MediaPreviewError, readMediaPreviewChunk } from './lib/mediaPreview.js'
import { ViewerForwarder } from './lib/viewerForwarder.js'
import { InteractiveViewers } from './lib/interactiveViewer.js'
import { OwnerCommands, OWNER_COMMAND_TYPES } from './lib/ownerCommands.js'
import { VIEWER_DOWN_TYPES } from './lib/viewerWire.js'
import { codexMessagesToEvents } from './engines/codex/normalizer.js'
import { codexSubagentResolverFor } from './engines/codex/subagent.js'
import { parseHostTheme, type HostTheme } from './lib/hostTheme.js'
import { cursorMessagesToEvents, windowCursorLines } from './engines/cursor/normalizer.js'
import { cursorConfigDir, cursorDataDir } from './engines/cursor/home.js'
import { loadCursorReplayTaskLinks } from './engines/cursor/subagent.js'
import { opencodeMessagesToEvents, windowOpencodeMessages } from './engines/opencode/normalizer.js'
import { kiloMessagesToEvents, windowKiloMessages } from './engines/kilo/normalizer.js'
import { museMessagesToEvents } from './engines/muse/normalizer.js'
import { ampMessagesToEvents } from './engines/amp/normalizer.js'
import { grokMessagesToEvents } from './engines/grok/normalizer.js'
import { agyMessagesToEvents } from './engines/agy/normalizer.js'
import { copilotMessagesToEvents } from './engines/copilot/normalizer.js'
import { ampThreadToEvents, readAmpThread } from './engines/amp/threadExport.js'
import { piMessagesToEvents, windowPiLines } from './engines/pi/normalizer.js'
import { commandcodeMessagesToEvents, windowCommandCodeLines } from './engines/commandcode/normalizer.js'
import { hermesMessagesToEvents, windowHermesMessages } from './engines/hermes/normalizer.js'
import { devinMessagesToEvents, windowDevinMessages } from './engines/devin/normalizer.js'
import { readHermesMessages } from './engines/hermes/reader.js'
import { hermesDbForSession } from './lib/hermesHome.js'
import { readDevinMessages } from './engines/devin/reader.js'
import { readOpencodeMessages } from './engines/opencode/reader.js'
import { readKiloMessages } from './engines/kilo/reader.js'
import { E2eeManager, type LinkedPeer, type PairResult } from './lib/e2ee/manager.js'
import { MachinePeerStore } from './lib/e2ee/machinePeers.js'
import type { TerminalStreamManager } from './lib/terminalStreamManager.js'
import {
  decodeTerminalHop,
  encodeTerminalLocal,
  encodeTerminalHop,
  TerminalHopDirection,
  type TerminalBinaryClear,
} from './lib/terminalBinary.js'
import { b64d, fingerprint, isWrapped } from './lib/e2ee/core.js'
import { encryptRpcResult, PAIR_REQUESTS, PLATE_REQUEST, rpcResultType } from './lib/e2ee/applicationFrames.js'
import { tmuxPaneInfo } from './lib/tmux.js'
import { DEVICE_RECENT_SAFE_FRAME_BYTES, fitRecentReplyPayloadForDevice } from './lib/deviceRecentTrim.js'
import { shouldReplayCommander } from './lib/commanderReplay.js'
import { RuntimeProfileControlError, type RuntimeProfileErrorCode } from './lib/runtimeProfileController.js'
import { parseRuntimeProfile, type RuntimeModelOption } from './lib/runtimeProfile.js'
import { sid, preview, logFrame } from './lib/log.js'
import {
  TerminalP2pResponderPool,
  TERMINAL_P2P_DOWN_TYPES,
  TERMINAL_P2P_SIGNAL_TYPES,
  type TerminalP2pData,
  type TerminalP2pSignal,
} from './lib/terminalP2p.js'

// OpenCode has no per-session transcript file — its history is read from this SQLite store.
const OPENCODE_DB = join(env.OPENCODE_DATA_DIR, 'opencode.db')
/** History pages and line counts for the threads clients read (lib/transcriptPages.ts). */
const transcriptPages = new TranscriptPager()
// Kilo keeps history the same way opencode does, in its own store.
const KILO_DB = join(env.KILO_DATA_DIR, 'kilo.db')
const DEVIN_DB = join(env.DEVIN_HOME, 'sessions.db')
// Hermes history likewise comes from a SQLite store, not a per-session file — one per HOME, so the
// path is the session's own (`hermesDbForSession`) rather than this machine's default.

/** Answers the device `project_recent` RPC — set by cli.ts to the CommanderMirror's `recent`. */
export type RecentProvider = (sessionId: string, n: number) => Array<{ kind: string; text: string; recap?: string }>


const APP_PING_MS = 15_000
// Floor between two `app_presence` up-frames while a window is attached. Rides the 15s app-ping
// tick; the backend only needs to hear about it about once a minute (it floors its own Mongo write
// at five). `open` is never held back — it is the one that counts as a session in
// `user_daily_presence`.
const APP_PRESENCE_UP_MS = 60_000
// How long the opening handshake may take before the attempt is abandoned and retried. `ws` waits
// forever by default, and the heartbeat below only starts on 'open' — so a TCP connection that came
// up while the network was flapping but never got its upgrade answered sat in CONNECTING for hours,
// `this.ws` set, every later connect() returning early, and the daemon reporting "cloud
// reconnecting…" until someone restarted it.
const HANDSHAKE_TIMEOUT_MS = 15_000
/** An `agent_update {opened: true}` for an agent opened less than this long ago is answered but not
 *  stamped or broadcast: a person flicking between two tabs, or two apps opening the same agent at
 *  once, would otherwise push a frame to every client for each flick. Exported for the spec. */
export const AGENT_OPENED_THROTTLE_MS = 3_000
const BASE_DELAY_MS = 1_000
const MAX_DELAY_MS = 30_000
const QUEUE_MAX = 2_000
/** Requests one local connection may queue before the daemon is ready (see `openRequests`). The app
 *  sends a handful on connect; hundreds is a client looping, not a person. */
const MAX_REQUESTS_BEFORE_READY = 256
const DEVICE_AGENT_LIST_LIMIT = 100
const DEVICE_AGENT_NAME_MAX_CODEPOINTS = 15
const DEVICE_AGENT_NAME_MAX_BYTES = 39 // device project_t.name[40], including trailing NUL on-device.
const DEVICE_ELLIPSIS = '…'

export type Frame = Record<string, unknown>
type OutboundEnvelope = Record<string, unknown>

export interface LocalClientSink {
  sendFrame: (frame: Frame) => boolean
  sendBinary: (frame: Uint8Array) => boolean
}

/** A loopback desktop connection (localWsServer.ts), as opposed to a cloud/relay one. */
export function isLocalClientId(connId: string): boolean {
  return connId.startsWith('local:')
}

/**
 * Where a down-frame came from, carried with it to `dispatchDown`.
 *
 * `relay` is the backend link and ONLY the backend link; `local` is a process on this machine
 * talking to the daemon's local socket; `p2p` is a paired device over its own channel. The
 * distinction is a trust boundary, not bookkeeping: a handful of frames are the backend's alone to
 * send, and before `local` existed they were accepted from anything that could open the local port.
 */
export type DownTransport = 'relay' | 'local' | 'p2p'

/**
 * Down-frames only the BACKEND may send, refused from every other transport.
 *
 * Each one hands the daemon an instruction no client is entitled to give:
 *   - `machine_meta` names the account's private grid — the inference endpoint every agent on this
 *     computer is then pointed at. Forged, it redirects the account's work to a grid of the
 *     sender's choosing. A leftover test script did exactly this by accident once.
 *   - `machine_revoked` clears the stored SSO session and exits the daemon. Forged, it is a
 *     one-frame forced sign-out and denial of service.
 *
 * Neither is sent by any client in this repository — only by `backend/src/lib/adapterWs.ts` and
 * `backend/src/services/MachineService.ts` — so there is nothing to stay compatible with. The
 * backend blocks its OWN `__`-prefixed control frames from web clients for the same reason; these
 * two escaped that rule because they are not `__`-prefixed.
 *
 * `device_keys_changed` and `devlog_append_result` are the backend's own too (the device key log,
 * lib/e2ee/deviceLogSyncer.ts): forged, the first only makes this daemon re-read and verify the log,
 * the second could fake an answer to its own append — neither is anything a client should be sending.
 */
const BACKEND_ONLY_DOWN_TYPES = new Set(['machine_meta', 'machine_revoked', 'desk_changed', 'zoo_changed', 'machines_changed', 'device_keys_changed', 'devlog_append_result'])

/** A frame type as the sender spelled it, fit for one log line: the relay chooses it, so it is bounded
 *  and escaped rather than trusted not to carry a newline that forges the next line. */
function logSafeType(type: string): string {
  return JSON.stringify(type.length > 64 ? `${type.slice(0, 64)}…` : type)
}

interface QueueItem {
  id: number
  data: string
  msg: OutboundEnvelope
  attempts: number
}

interface DownEnvelope {
  t: 'down'
  connId?: string
  frame?: Frame
}

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

/**
 * Amp history comes from AMP's store, not from ours.
 *
 * The plugin's JSONL is a record of what the plugin saw; a thread that ran before the integration existed
 * — or in a pane still holding an older plugin — is simply not in it, and no local file can rebuild those
 * turns. `amp threads export` returns the thread complete, including the tools Amp runs server-side.
 *
 * The local file stays as the FALLBACK, because an export is a network call and a pane with no history at
 * all is worse than a partial one. Which source answered is logged either way: silently serving the lesser
 * record is exactly how the missing tool cards went unnoticed for a day.
 */
async function ampHistory(sessionId: string, lines: string[]): Promise<SessionEvent[]> {
  const messages = await readAmpThread(sessionId)
  if (messages) {
    console.log(`[history] ${sessionId.slice(0, 12)} amp · ${messages.length} message(s) from amp's own store`)
    return ampThreadToEvents(messages)
  }
  console.warn(`[history] ${sessionId.slice(0, 12)} amp · export unavailable — falling back to the local transcript`)
  return ampMessagesToEvents(lines)
}

/** Grok has no transcript windower yet. Keep BOTH `session_get` shapes on the same real-record replay:
 * web always sends a limit, while legacy callers omit it. Returning the whole small transcript for a
 * page is honest (`hasMore:false`) and cannot fall through to Claude's incompatible line cursor. */
export function grokHistoryPage(lines: string[], paginated: boolean):
  { events: SessionEvent[]; hasMore?: false; oldestCursor?: null } {
  const events = grokMessagesToEvents(lines)
  return paginated ? { events, hasMore: false, oldestCursor: null } : { events }
}

/** agy has no transcript windower either; same both-shapes replay as grok, for the same reason. */
export function agyHistoryPage(lines: string[], paginated: boolean):
  { events: SessionEvent[]; hasMore?: false; oldestCursor?: null } {
  const events = agyMessagesToEvents(lines)
  return paginated ? { events, hasMore: false, oldestCursor: null } : { events }
}

/** Copilot has no transcript windower either; same both-shapes replay as grok and agy. */
export function copilotHistoryPage(lines: string[], paginated: boolean):
  { events: SessionEvent[]; hasMore?: false; oldestCursor?: null } {
  const events = copilotMessagesToEvents(lines)
  return paginated ? { events, hasMore: false, oldestCursor: null } : { events }
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

/**
 * How many models the DEVICE picker may receive. It has room for 48 (`models[48]` in ui_habitat.c) and
 * is handed half of that, so the list it draws is never one it was not built for; the web picker is
 * unbounded and still gets everything.
 */
const DEVICE_PICKER_MAX_MODELS = 24

export function compactRuntimePickerModels(
  models: RuntimeModelOption[],
  sessionId: string | undefined,
  pickerMode: unknown,
  selectedModel: unknown,
): Array<{ id: string }> {
  const compact = models.map(({ id }) => ({ id }))
  if ((pickerMode !== 'model' && pickerMode !== 'effort') || !sessionId) return compact

  const profiles = models.flatMap((item) => {
    const profile = parseRuntimeProfile(item.id)
    return profile?.sessionId === sessionId ? [{ item, profile }] : []
  })
  const selected = parseRuntimeProfile(selectedModel)
  const current = selected?.sessionId === sessionId ? selected : null

  if (pickerMode === 'effort') {
    if (!current) return []
    const seen = new Set<string>()
    return profiles.flatMap(({ item, profile }) => {
      if (profile.model !== current.model || profile.effort === 'auto' || seen.has(profile.effort)) return []
      seen.add(profile.effort)
      return [{ id: item.id }]
    })
  }

  const byModel = new Map<string, typeof profiles>()
  for (const entry of profiles) {
    const group = byModel.get(entry.profile.model) ?? []
    group.push(entry)
    byModel.set(entry.profile.model, group)
  }
  const rows = [...byModel.values()].map((group) => {
    const target = group.find(({ profile }) => current && profile.effort === current.effort)
      ?? group.find(({ profile }) => profile.effort === 'auto')
      ?? group[0]
    return { id: target.item.id, model: target.profile.model }
  })
  // Top N only. The picker is a scroll wheel on a 1.9" round screen, and a 49-row one was enough to stall
  // the device's the device UI task into a task-watchdog reset; devin alone publishes 72
  // models. The catalog arrives in the engine's own order — its curated/most-used first — so "top" is that
  // order, with the model the agent is RUNNING pinned in front so the list can never hide it.
  const ordered = current
    ? [...rows].sort((a, b) => Number(b.model === current.model) - Number(a.model === current.model))
    : rows
  return ordered.slice(0, DEVICE_PICKER_MAX_MODELS).map(({ id }) => ({ id }))
}

/** Fill in missing sub-agent aggregates on tool_end events by reading the sub-agent's own transcript
 *  (`<session>/subagents/agent-<id>.jsonl`). Async/background launchers only record
 *  `{status:'async_launched', agentId}` in the main transcript — without this join the delegation
 *  card shows "0 tools · worked for 0s" forever. Best-effort per agent; missing files are skipped. */
async function enrichSubagentStats(events: SessionEvent[], transcriptPath: string): Promise<void> {
  const subagentsDir = join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents')
  for (const e of events) {
    if (e.type !== 'tool_end') continue
    const sub = e.payload.subagent
    if (!sub?.agentId || typeof sub.totalToolUseCount === 'number') continue
    try {
      // A line at a time: a long sub-agent's transcript is never held whole to count its calls.
      const file = join(subagentsDir, `agent-${sub.agentId}.jsonl`)
      const totals = new SubagentStats()
      await streamRecords(file, 0, (await stat(file)).size, (line) => { totals.push(line) }, () => true)
      const stats = totals.result()
      sub.totalToolUseCount = stats.totalToolUseCount
      if (sub.totalDurationMs === undefined) sub.totalDurationMs = stats.totalDurationMs
      if (sub.totalTokens === undefined) sub.totalTokens = stats.totalTokens
    } catch { /* subagent transcript absent (still spawning / pruned) — leave as-is */ }
  }
}

/** Sections one `grid_models_list` may ask to wake — a person presses one "Show models" at a time. */
const MAX_WAKES_PER_ASK = 8

/** What `grid_models_list` answers and `grid_models_changed` pushes — one shape, so a window parses both
 *  with one reader. `gridName` and `models` keep naming the own grid alone, for an app that predates
 *  `grids`; each section's `state`, `seenAt`, `lastKnownAge` and `wakeOutcome` are additive, and a row's
 *  offline label is `unavailable` for a window that asked for row state, its node text for one that did
 *  not (`presentGridSections`). */
function gridModelsPayload(gridName: string | null, sections: GridSection[], rowState: boolean): Record<string, unknown> {
  const grids = presentGridSections(sections, { rowState })
  return {
    gridName,
    models: grids.find((g) => g.own)?.models ?? [],
    grids,
    // Which engines a Local model can be offered to at all. Static per CLI version — it is
    // the set of launch contracts in `gridLaunch.ts` — and answered here, beside the list,
    // so the picker can say "Cursor runs only on its own login" instead of offering a row
    // whose retarget the daemon would refuse. An older app ignores the field; an older
    // daemon omits it, which the app reads as "offer everything", as before.
    localModelEngines: gridCapableEngines(),
    supportsModelLaunch: true,
    // Whether this MACHINE has a `grid` to run at all — `managed`, `path` or `missing` —
    // as distinct from `gridName`, which is about the account. The Local model dialog was
    // gating on the account alone and starting an agent whose second step is `grid`; this
    // is what lets it, and the picker, say so first. An older app ignores the field.
    gridCli: gridCliPresence(),
  }
}

export class BackendSocket {
  harnessDevices: HarnessDevicesService | null = null
  private readonly gridFleet = new GridFleetRpc()
  // The Model Manager reads the grid it runs on through the same credential-less reader as every picker
  // (never `grid engines`, which carries the grid credential and so wakes a sleeping grid on every tick),
  // and a start or stop it finishes makes every list read again — pushed to the window when it changes.
  private readonly localModels = new LocalModels({
    stateDir: join(env.ADAPTER_DATA_DIR, 'local-models'),
    machineName: () => this.machineDisplayName,
    inventory: gridInventory,
    onChanged: () => { forgetGridModels(); void this.pushGridModels() },
    // Models Ollama, LM Studio and llama.cpp downloaded here, found by the Model Manager's own scan (the
    // bundled harness), so the picker and that harness agree on what is here and what starts it.
    appModels: () => scanAppModels({ node: process.execPath, packageDir: installedDsh(MODEL_MANAGER_ID)?.realDir ?? null, env: process.env }),
    appEngines: appEngineOps(process.env),
  })
  /** This machine's name as Harness shows it (Machines), from the backend's `machine_meta`. Null
   *  until the first one arrives. */
  private machineDisplayName: string | null = null
  /** A read the window did not ask for changed what a picker would show: tell the window
   *  (`grid_models_changed`), so its one picture stays current without polling. */
  private readonly stopGridModelsPush = onGridModelsChanged(() => { void this.pushGridModels() })
  private readonly apiConnections = new ApiConnections(env.ADAPTER_DATA_DIR)
  private ws: WebSocket | null = null
  private connecting = false
  /** A 401 on the upgrade is being answered with a token refresh; that refresh owns the next connect. */
  private retryingAuth = false
  private readonly auth: AuthSessionManager
  /** Constructor-without-auth is retained for isolated unit tests only. */
  private readonly testToken?: string
  private url: string
  private attempts = 0
  private closed = false
  private queue: QueueItem[] = []
  private draining = false
  private nextQueueId = 1
  private droppedSinceLog = 0
  private heartbeat: LivenessWatch | null = null
  private appPing: NodeJS.Timeout | null = null
  private lastAppPresenceUpAt = 0
  // A window attached while there was no link to tell (cold start: the app dials this daemon before
  // the daemon has dialed the backend; or a daemon restart under an open window). The session is
  // real and must be counted once, so it is owed to the next link — not turned into a `ping`.
  private appOpenOwed = false
  private readonly downChains = new Map<string, Promise<void>>()
  /**
   * Requests wait here until the daemon is ready (`openRequests`), each in its connection's own order.
   * The port answers long before start-up has wired every handler and confirmed the agents it
   * restored; a request answered in between met a handler that was not there yet — refused with
   * UNSUPPORTED_ON_REMOTE, or for `message` silently dropped — or a registry not yet reconciled.
   */
  private requestsOpen = true
  private openRequestGate: () => void = () => {}
  private requestGate: Promise<void> = Promise.resolve()
  /** Requests waiting at the gate, per connection: a client that floods a starting daemon is closed. */
  private readonly waitingAtGate = new Map<string, number>()
  private readonly localClients = new Map<string, LocalClientSink>()
  /**
   * Loopback clients that are TOOLS, not windows (`machine_select { tool: true }`): `harness pair`, the
   * `harnessd` MCP server. They get their RPC replies like any local client, but they are not a person at
   * this computer — not presence, not a window to push to, and never what wakes the pair brain.
   */
  private readonly toolClients = new Set<string>()
  private terminalStreams: TerminalStreamManager | null = null
  private readonly terminalP2p: TerminalP2pResponderPool
  private readonly p2pPendingOpens = new Map<string, Set<string>>()
  private readonly p2pStreams = new Map<string, Set<string>>()
  private onStatus: (connected: boolean) => void
  /** Cross-instance commander (device) client count, from backend `__clients` frames. */
  private commanderCount = 0
  /** Subset of commanderCount whose device is ACTIVELY rendering this machine (multi-attach). null = the
   *  backend doesn't send the signal (old build) → fall back to hasCommander so streaming isn't gated off. */
  private commanderActive: number | null = null
  private replayedCommanderGeneration: number | undefined
  private replayCommanderOnNextSnapshot = true
  /** Called when a commander attach is observed — cli.ts replays live state. */
  onCommanderJoin: (() => void) | null = null
  /** Called only when commander presence crosses zero; drives the disposable recap-worker grace. */
  onCommanderPresenceChanged: ((connected: boolean) => void) | null = null
  /** Called when the web cancels a turn (C-c) — cli.ts stops that session's turn heartbeat. */
  onCancel: ((sessionId: string) => void) | null = null
  /** Called when the web deletes an agent (`agent_delete`) — cli.ts signals only the validated engine
   *  process and forgets the session. Keeps recap + agent name. */
  onDeleteAgent: ((sessionId: string) => void | Promise<void>) | null = null
  purgeAgentService: PurgeAgentService | null = null
  closeAgentService: CloseAgentService | null = null
  cleanupPreview: (() => Promise<Record<string, unknown>>) | null = null
  /** Called on `agent_create` — cli.ts spawns a fresh tmux session running the requested engine in the
   *  requested folder and returns its process-agent. Session metadata may bind later through hooks. */
  onCreateAgent: ((input: {
    engine: AgentEngine
    cwd: string
    bypassPermission: boolean
    /** A grid to point this agent at instead of the engine's own login; null when none was chosen. */
    grid: GridLaunchOverride | null
    /** A Codex CODEX_HOME folder to launch this agent against instead of `~/.codex`; codex only. */
    codexHome: string | null
    /** The domain-specific harness to create this agent as (installed here, base engine = `engine`). */
    dsh: string | null
    /** The message the session opens with, already submitted (`FIRST_PROMPT_ARGS` in engineLaunch.ts);
     *  null when the pane opens on an empty input. Validated here — length, and that the engine has a
     *  contract for it — so cli.ts never sees one it cannot hand over. Never logged. */
    prompt: string | null
    /** The name the pane opens under, instead of the next `agent-N`; null to number it. */
    name: string | null
    /** The engine's named agent the pane opens AS (`NAMED_AGENT_ARGS` in engineLaunch.ts; opencode
     *  `--agent <name>`); null for a general session. Validated here — shape, and that the engine has
     *  a contract for it. Unlike `prompt`, kept on the row so a relaunch opens as it again. */
    agent: string | null
    /** A mode from `PERMISSION_MODES` for this engine; null when the client sent only
     *  `bypassPermission`, which then decides. Validated here (`INVALID_PERMISSION_MODE`). */
    permissionMode: string | null
    /** A conversation Harness did not start, to open this harness ON: the engine resumes it, in its own
     *  folder (lib/sessionSearch/external.ts). Null for a new conversation. Shape-checked here; cli.ts
     *  checks it is one it found, not open elsewhere, and not already a harness. */
    resumeSessionId?: string | null
    /** A conversation open in a terminal, taken over from it: `idle` stops that terminal's process
     *  only between turns, `now` whatever it is doing (then tells it to continue), `wait` when its
     *  turn ends. Absent, one open elsewhere is refused and the refusal says whether it is busy. */
    takeOver?: 'idle' | 'now' | 'wait' | null
  }) =>
    Promise<{ ok: true; session: RegisteredSession } | { ok: false; error: string; detail?: string }>) | null = null
  /** Called on `remote_terminal_handoff` — cli.ts names the agent whose tile is that tmux pane, or null. */
  onTerminalHandoff: ((tmuxPane: string) => string | null) | null = null
  /** What the daemon knows about an agent's DSH companions (viewer URL, verdict); null when nothing. */
  harnessSharing: HarnessShareOwner | null = null
  /** Answers the trust group's roster exchange (`group_sync`); null until the daemon wires it. */
  groupSync: { handle: (peerPub: string, payload: Record<string, unknown>) => Record<string, unknown> } | null = null
  activityFrameProvider: ((session: RegisteredSession) => ActivityFrame | null) | null = null
  dshFrameProvider: ((session: RegisteredSession) => AgentDshContext | null) | null = null
  viewerTargetProvider: ((agentId: string) => string | null) | null = null
  readonly interactiveViewers = new InteractiveViewers(agentId => this.viewerTargetProvider?.(agentId) ?? null)
  readonly viewerForwarder = new ViewerForwarder({
    target: (agentId) => this.viewerTargetProvider?.(agentId) ?? null,
    send: (connId, type, payload) => {
      if (this.localClients.has(connId)) { this.sendTo(connId, { type, payload }); return true }
      if (!this.isConnected()) return false
      const frame = this.e2ee.wrapTarget(connId, type, payload)
      if (!frame) return false
      this.sendTo(connId, frame)
      return true
    },
  })
  private readonly agentCreations = new AgentCreationReceipts(join(env.ADAPTER_DATA_DIR, 'agent-creations'))
  /** Injectable for queue-isolation tests; production uses the machine-local probe. */
  engineProbeProvider: typeof probeEngines = probeEngines
  /** Entrypoint override for isolated integration fixtures; never a wire option. */
  orchestratorCommand: string | null = null
  readonly ownerCommands = new OwnerCommands()
  onCancelOrchestratorMessage: ((deliveryId: string) => boolean) | null = null
  orchestratorDelivery(event: SessionInputDelivery): void {
    this.orchestratorService?.delivery(event)
  }
  private orchestratorService: OrchestratorService | null = null
  /** Isolated daemon fixtures can override these without touching installed state. */
  teamStateDir = join(env.ADAPTER_DATA_DIR, 'teams')
  teamCommand: string | null = null
  private teamService: TeamService | null = null
  readonly swarmPromptScopes = new SwarmPromptScopes()
  private teamMailboxService: TeamMailbox | null = null
  readChannelDesk: (() => Promise<unknown>) | null = null
  writeChannelSettings: ((enabled: boolean) => Promise<unknown>) | null = null
  private channelsEnabled = false
  private channelDirectory: ChannelDirectory | null = null
  private channels(): ChannelDirectory {
    if (!this.readChannelDesk) throw new TeamError('CHANNELS_UNSUPPORTED', 'Tab channels are not available on this daemon.')
    return this.channelDirectory ??= new ChannelDirectory({
      machineId: this.machineId, service: this.teams(), readDesk: () => this.readChannelDesk!(),
      writeSettings: async enabled => {
        if (!this.writeChannelSettings) throw new TeamError('CHANNELS_UNSUPPORTED', 'Update Harness to configure swarm collaboration.')
        return this.writeChannelSettings(enabled)
      },
      enabledChanged: enabled => { this.channelsEnabled = enabled; this.teamMailboxService?.pump() },
      forward: (machineId, payload) => teamRpc({ port: env.PORT, machineId, dataDir: env.ADAPTER_DATA_DIR }, 'team', payload),
    })
  }
  refreshChannels(): void { if (this.readChannelDesk) void this.channels().refresh(true).catch(() => {}) }
  teamDelivery(event: SessionInputDelivery): void { this.teamMailboxService?.observe(event) }
  teamCanWrite(deliveryId: string): boolean { return this.teamMailboxService?.canWrite(deliveryId) ?? false }
  private localTeamRuntime(agentId: string): MemberRuntime | null {
    const agent = registry.byAgent(agentId)
    return agent ? { name: projectDisplayName(agent), engine: agent.engine, cwd: agent.cwd ?? undefined,
      available: agent.active && registry.terminalAvailable(agentId),
      ...(!agent.active ? { reason: 'Session is paused or offline.' } : {}) } : null
  }
  private teamMailbox(): TeamMailbox {
    return this.teamMailboxService ??= new TeamMailbox({
      stateDir: join(this.teamStateDir, 'mailboxes'),
      channelsEnabled: () => this.channelsEnabled,
      runtime: id => this.localTeamRuntime(id),
      send: (id, text, deliveryId) => {
        if (!this.onMessage) throw new TeamError('UNAVAILABLE', 'Agent input is not ready.')
        this.onMessage(id, text, deliveryId)
      },
      cancel: id => this.onCancelOrchestratorMessage?.(id) ?? false,
    })
  }
  private teams(): TeamService {
    return this.teamService ??= new TeamService({
      stateDir: join(this.teamStateDir, 'ledgers'), machineId: this.machineId,
      taskScope: async address => {
        if (address.machineId === this.machineId) return this.swarmPromptScopes.current(address.agentId)
        const result = await teamRpc({ port: env.PORT, machineId: address.machineId, dataDir: env.ADAPTER_DATA_DIR },
          'team_delivery', { action: 'prompt_scope', agentId: address.agentId })
        return typeof result.teamId === 'string' ? result.teamId : null
      },
      questionReplied: async (address, teamId, questionId) => {
        if (address.machineId === this.machineId) this.swarmPromptScopes.replied(address.agentId, teamId, questionId)
        else await teamRpc({ port: env.PORT, machineId: address.machineId, dataDir: env.ADAPTER_DATA_DIR },
          'team_delivery', { action: 'prompt_replied', agentId: address.agentId, teamId, questionId })
      },
      command: address => address.machineId === this.machineId
        ? this.teamCommand ?? `${[process.execPath, ...process.execArgv, process.argv[1]].map(shellQuote).join(' ')} team --port ${env.PORT}`
        : 'harness team',
      runtime: async address => {
        Address.parse(address)
        if (address.machineId === this.machineId) return this.localTeamRuntime(address.agentId)
        const result = await teamRpc({ port: env.PORT, machineId: address.machineId, dataDir: env.ADAPTER_DATA_DIR }, 'team_delivery', { action: 'runtime', agentId: address.agentId })
        return result.runtime as MemberRuntime | null
      },
      delivery: async (address, action, delivery) => {
        if (address.machineId === this.machineId) {
          const mailbox = this.teamMailbox()
          return action === 'send' ? mailbox.accept(delivery) : action === 'status' ? mailbox.status(delivery.id)
            : action === 'hold' || action === 'release' ? mailbox.hold(delivery.id, action === 'hold') : mailbox.cancel(delivery.id, action === 'consume')
        }
        const result = await teamRpc({ port: env.PORT, machineId: address.machineId, dataDir: env.ADAPTER_DATA_DIR }, 'team_delivery', { action, delivery })
        return result.receipt == null ? null : Receipt.parse(result.receipt)
      },
      changed: (id, revision) => this.sendLocal({ type: 'team_changed', payload: { id, revision } }),
    })
  }
  /** Resume persisted queues after input wiring is ready, even with no UI attached. */
  startTeams(): void {
    if (this.readChannelDesk) this.channels().start()
    if (!existsSync(this.teamStateDir)) return
    try { this.teamMailbox().start(); this.teams().start() }
    catch { console.warn('[teams] preserved unreadable team state; inspect Team for recovery') }
  }
  /** The commander asks this for every turn that ends — see OrchestratorService.roleOf. */
  orchestratorRoleOf(agentId: string): ReturnType<OrchestratorService['roleOf']> {
    return this.orchestration().roleOf(agentId)
  }
  /** Load saved orchestrator projects now, so their deadlines run without waiting for a request; resolves once saved projects were reconciled. */
  orchestratorRecover(): Promise<void> { return this.orchestration().recover() }
  private orchestration(): OrchestratorService {
    return this.orchestratorService ??= new OrchestratorService({
      stateDir: join(env.ADAPTER_DATA_DIR, 'orchestrator'),
      workspaceDir: join(homedir(), 'harnesses', 'orchestrated'),
      command: this.orchestratorCommand ?? `${[process.execPath, ...process.execArgv, process.argv[1]].map(shellQuote).join(' ')} orchestrator --port ${env.PORT} --machine ${shellQuote(this.machineId)}`,
      catalog: installedHarnessCatalog,
      supportsEngine: orchestratorEngineSupported,
      create: async input => {
        if (!this.onCreateAgent) throw new OrchestratorError('UNSUPPORTED', 'This daemon cannot create agents.')
        const available = await this.engineProbeProvider([input.engine])
        if (!available.some(e => e.engine === input.engine && e.installed)) throw new OrchestratorError('ENGINE_NOT_INSTALLED', `${input.engine} must be installed before starting this specialist.`)
        const result = await this.onCreateAgent({ ...input, grid: null, codexHome: null, agent: null, permissionMode: null })
        if (!result.ok) throw new OrchestratorError(result.error, result.detail ?? result.error)
        return { agentId: result.session.agentId }
      },
      send: (id, text, deliveryId) => {
        if (!this.onMessage || !registry.resolve(id)) throw new OrchestratorError('AGENT_UNAVAILABLE', 'The agent is not available to receive a message.')
        this.onMessage(id, text, deliveryId)
      },
      cancelDelivery: id => this.onCancelOrchestratorMessage?.(id) ?? false,
      cancel: id => this.onCancel?.(id),
      agent: id => {
        const agent = registry.resolve(id)
        if (!agent) return null
        const context = this.dshFrameProvider?.(agent)
        return { viewerUrl: context?.viewerUrl, viewerName: context?.viewerName, error: agent.launch?.state === 'failed' ? agent.launch.detail ?? agent.launch.error : null }
      },
      changed: (id, revision) => this.sendLocal({ type: 'orchestrator_changed', payload: { id, revision } }),
    })
  }
  /**
   * Called on `agent_retarget` — cli.ts re-execs an EXISTING agent's pane against a different grid,
   * or, when `grid` is null, back onto its own login.
   *
   * Separate from `onCreateAgent` because it is a different promise: the pane, its id and its
   * scrollback survive, and only the process is replaced. A running process's environment cannot be
   * edited, so there is no gentler way to move an agent that is already up.
   *
   * Separate from `onRestartAgent` because that one puts the agent back exactly as it was; this one
   * puts it back somewhere else. They share the swap underneath and differ in what they hand it.
   */
  onRetargetAgent: ((input: { agentId: string; grid: GridLaunchOverride | null }) =>
    Promise<{ ok: true } | { ok: false; error: string; detail?: string }>) | null = null
  /** Called on `agent_restart` — cli.ts stops the agent's live engine process and relaunches it in the
   *  SAME tmux pane, keeping the SAME agentId and (best-effort) resuming the same engine session.
   *  `resumed` tells the caller whether the relaunch actually resumed the prior conversation or had to
   *  fall back to a fresh one under the same agent/pane. */
  onRestartAgent: ((agentId: string) =>
    Promise<
      { ok: true; session: RegisteredSession; resumed: boolean }
      | { ok: false; error: string; detail?: string }
    >) | null = null
  /** Resume stopped work directly, or attach if it is already running. Never replaces a live
   * process and never falls back to a fresh conversation. */
  onResumeAgent: ((agentId: string, permissionMode?: string) => ReturnType<NonNullable<BackendSocket['onRestartAgent']>>) | null = null
  /** Called on `agent_fork` — cli.ts opens a NEW agent that starts with `agentId`'s whole history
   *  (lib/forkAgent.ts) and returns its process-agent, exactly as `agent_create` does. `level` says
   *  what the new agent actually got: the engine's own fork, or a handoff message. */
  onForkAgent: ((input: { agentId: string; name: string | null; prompt: string | null }) =>
    Promise<
      { ok: true; session: RegisteredSession; level: 'native' | 'handoff' }
      | { ok: false; error: string; detail?: string }
    >) | null = null
  /** Called when the web/device sends chat input to an agent terminal. */
  onMessage: ((sessionId: string, content: string, deliveryId?: string, tabId?: string) => void) | null = null
  /** Best-effort terminal-native title sync after a user renames an agent. */
  onAgentRename: ((session: RegisteredSession, name: string) => void) | null = null
  /** Called when a device answers an AskUserQuestion (`question_response`) — cli.ts drives the CLI's own
   *  terminal dialog (option digit / free text), since a remote machine has no
   *  programmatic answer channel the way the hosted runtime’s brain does. */
  onQuestionAnswer: ((payload: { requestId?: string; sessionId?: string; agentId?: string; answers?: Record<string, string> }) => Promise<QuestionAnswerResult> | void) | null = null
  /** Called when this machine was deleted/revoked (a `machine_revoked` down-frame, or a 401/403 on the
   *  upgrade) — CLI clears the saved SSO session and shuts down instead of retrying forever. */
  onRevoked: (() => void) | null = null
  /** Called with the machine's display name (`machine_meta` down-frame: seeded on connect, pushed on a
   *  web rename; null = unnamed) — cli mirrors it to a local file for `harness status`. */
  onMachineMeta: ((name: string | null) => void) | null = null
  /** Called when this machine is already connected from ANOTHER computer (HTTP 409 on the upgrade) — the
   *  SSO session is valid, so CLI keeps it and stops without a retry loop. */
  onBusy: (() => void) | null = null
  /** Answers the device `project_recent` RPC (cli.ts wires this to CommanderMirror.recent). */
  recentProvider: RecentProvider | null = null
  /** The person's own last questions for an agent, newest first. See the `agent_recent` case. */
  recentAsksProvider: ((agentId: string, n: number) => string[]) | null = null
  /** Writes the structured handoff file for an agent whose engine is about to change (the
   *  `agent_handoff_prepare` case; cli.ts wires lib/agentHandoff.ts). It resolves with where the file is,
   *  never with text for the next engine (the desktop words that prompt itself). A `HandoffError`'s `code`
   *  is the error reply; any other failure replies `INTERNAL`. */
  handoffProvider: ((req: { agentId: string; changeId: string; targetEngine: string }) =>
    Promise<{ file: string | null; gitRepo: boolean; cwd: string; degraded: string[] }>) | null = null
  monitorActivityProvider: ((sessionId: string) => MonitorActivity) | null = null
  private readonly monitorCompletions = new MonitorCompletions()
  /** Runtime Model/Effort integration, wired by cli.ts for registered tmux sessions. */
  runtimeModelsProvider: ((sessionId?: string) => Promise<RuntimeModelOption[]>) | null = null
  /** Answers `usage_read` — this machine's own agent-account usage (lib/accountUsage.ts). A field
   *  rather than a direct call so a spec answers it without a real home, Keychain or network. */
  accountUsageReader: () => Promise<AccountUsageReading[]> = readAccountUsage
  harnessResourcesReader = createHarnessResourcesReader(() => registry.advertised())
  harnessStorageReader = createHarnessStorageReader()
  /** The grid listing currently out, shared by every `grid_models_list` for the same own grid
   *  that lands meanwhile. */
  private gridModelsInFlight: { gridName: string | null; grids: ReturnType<typeof listAllGridModels> } | null = null
  /** The windows on this computer that draw row state (`grid_models_list` with `rowState: true`) and so
   *  are pushed labels as `unavailable` rather than in the node text. */
  private readonly rowStateWindows = new Set<string>()
  /** Receives `theme_set` — the desktop's pane colours, to become this machine's tmux
   *  `window-style` (lib/hostTheme.ts). Wired by cli.ts; null answers with UNSUPPORTED. */
  hostThemeSink: ((theme: HostTheme) => void) | null = null
  /** The account's device key log grew (lib/e2ee/deviceLogSyncer.ts): re-read it from this machine's head. */
  onDeviceKeysChanged: (() => void) | null = null
  /** This machine's key was taken out of the account's device key log (`machine_revoked` says so). */
  onDeviceRemoved: ((pub: string) => void) | null = null
  /** Whether [pub] is this machine's own device key. Set, a `machine_revoked` naming another key (an earlier
   *  install under the same machine id) does not sign this one out. Null: every removal signs out. */
  isOwnDeviceKey: ((pub: string) => boolean) | null = null
  /** The link to the backend just came up (each reconnect too). */
  onLinkUp: (() => void) | null = null
  /** Appends to the device key log waiting for the backend's answer, by requestId. */
  private readonly devlogAppends = new Map<string, (payload: Record<string, unknown> | null) => void>()
  runtimeProfileProvider: ((session: RegisteredSession) => string | null) | null = null
  onRuntimeProfileUpdate: ((sessionId: string, selectedModel: string) => Promise<void>) | null = null
  /** Web↔adapter E2EE: group-encrypts user events, runs the CPace pairing, holds per-conn sessions. */
  readonly e2ee: E2eeManager
  /** Backend-resolved machine id, persisted by the SSO login preflight. */
  readonly machineId: string

  /** The ONE place commander presence changes. Both callers — the `__clients` snapshot and `onGone` (our
   *  own backend link died) — mean the same thing when the count reaches zero: nobody is watching. They
   *  used to differ, and `onGone` forgot to drop the device's E2EE session, so `deviceE2eeConnected()`
   *  stayed true and the local dashboard kept a green "device connected" dot for a device long gone. */
  private setCommanderCount(commander: number, active: number | null): void {
    const hadCommander = this.commanderCount > 0
    this.commanderCount = commander
    this.commanderActive = active
    if (hadCommander !== (commander > 0)) this.onCommanderPresenceChanged?.(commander > 0)
    if (commander <= 0) {
      if (this.directDeviceSinks.size) this.e2ee.dropSessionsByRole('device', id => this.directDeviceSinks.has(id))
      else this.e2ee.dropSessionsByRole('device')
    }
  }

  /** True while at least one device (commander) client is connected — gates the LLM recap. */
  hasCommander(): boolean {
    return this.commanderCount > 0
  }

  /** True while at least one connected device is ACTIVELY rendering this machine — gates the full turn-card
   *  STREAM (processing/tool/todos). The recap still runs on hasCommander(), so a BACKGROUND machine gets its
   *  turn-done `summary` card (badge) without the live stream. Falls back to hasCommander() against a
   *  backend that doesn't emit the signal (commanderActive === null). */
  hasActiveCommander(): boolean {
    return this.commanderActive == null ? this.hasCommander() : this.commanderActive > 0
  }

  /** True while a desktop window on THIS computer is attached over loopback.
   *
   *  Separate from `hasCommander()` on purpose: a device and a window are different audiences that
   *  happen to want some of the same work done. The question watcher is the first thing to need it —
   *  polling a pane for a dialog is pointless with nobody rendering it, but "nobody" used to mean
   *  "no device", which left the window unable to learn that an agent was blocked. */
  hasLocalClient(): boolean {
    return this.localClients.size > this.toolClients.size
  }

  /** True after a paired device has completed the E2EE hello/welcome session. */
  deviceE2eeConnected(): boolean {
    return this.e2ee.deviceConnected()
  }

  private readonly directDeviceSinks = new Map<string, (frame: Record<string, unknown>) => void>()
  private readonly directDevicePins = new Map<string, string>()
  onDirectDeviceRevoked?: (fingerprint: string) => void
  /** A peer linked here over the remote password (after it is trusted and, for a machine, pinned back). */
  onPeerLinked?: (peer: LinkedPeer) => void
  /** A person unpaired this identity here (not the trust group removing it). */
  onUnpaired?: (identityPub: string) => void
  /** A connection that is, or is pairing as, an Autonomous device — what the device dump records. */
  private isDeviceConn(connId: string): boolean {
    return this.directDeviceSinks.has(connId) || this.e2ee.sessionRole(connId) === 'device'
      || (this.e2ee.pendingConnection() === connId && this.e2ee.pendingPair()?.role === 'device')
  }
  attachDirectDevice(connId: string, send: (frame: Record<string, unknown>) => void): void { this.directDeviceSinks.set(connId, send) }
  detachDirectDevice(connId: string): void { this.directDeviceSinks.delete(connId); this.directDevicePins.delete(connId); this.e2ee.dropSession(connId); this.autonomousDeviceRelay?.drop(connId); this.onCommanderPresenceChanged?.(this.hasCommander()) }
  pairedDirectFingerprint(connId: string): string | null { const pub = this.directDevicePins.get(connId); return pub ? fingerprint(b64d(pub)) : null }
  async receiveDirectDevice(connId: string, frame: Record<string, unknown>, pairingAllowed: boolean): Promise<void> {
    if (!this.directDeviceSinks.has(connId)) return
    const type = frame.type
    if (type !== 'autonomous_device_request') deviceDump.record('in', 'wire', connId, frame) // requests: decrypted in the relay
    if (type === 'machine_selected') return
    if (type === 'autonomous_device_request') { await this.autonomousDeviceRelay?.handle(connId, frame); return }
    const controls = pairingAllowed ? ['e2e_pair_intent', 'e2e_pair_cancel', 'e2e_pake', 'e2e_hello', 'e2e_status'] : ['e2e_hello', 'e2e_status']
    if ((type === 'e2e_pake' || type === 'e2e_pair_cancel') && this.e2ee.pendingConnection() !== connId) return
    if (typeof type === 'string' && controls.includes(type)) this.e2ee.handleFrame(connId, frame)
  }
  private autonomousDeviceRelay?: AutonomousDeviceRelay
  setAutonomousDeviceService(service: AutonomousDeviceService): void {
    this.autonomousDeviceRelay = new AutonomousDeviceRelay(
      this.e2ee,
      (connId, frame) => this.sendTo(connId, frame),
      service,
      this.machineId,
      () => this.onCommanderJoin?.(),
      identity => this.e2ee.revoke(fingerprint(b64d(identity))),
    )
  }
  directAutonomousDeviceSessions(): number { return this.autonomousDeviceRelay?.count(id => this.directDeviceSinks.has(id)) ?? 0 }
  autonomousDeviceConnected(): boolean { return this.autonomousDeviceRelay?.connected() ?? false }
  emitAutonomousDeviceEvent(frame: AutonomousDeviceFrame, deviceId?: string): void { this.autonomousDeviceRelay?.emit(frame, deviceId) }

  /** Live backend link state (local dashboard + E2EE gating). */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  /** A browser waiting to pair (local dashboard), or null. */
  pendingPair(): ReturnType<E2eeManager['pendingPair']> {
    return this.e2ee.pendingPair()
  }

  /** Record the local dashboard port so it's surfaced to the web (in e2e_status) for approve-via-web. */
  setDashboardPort(port: number): void {
    this.e2ee.dashboardPort = port
  }

  constructor(machineId: string, auth?: AuthSessionManager, onStatus: (connected: boolean) => void = () => {}, computerId = '', autonomousEnv = 'prod') {
    this.auth = auth ?? new AuthSessionManager(env.BACKEND_WS_URL.replace(/\/$/, '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:'))
    this.testToken = auth ? undefined : machineId
    // `?label=<hostname>` lets the backend record which machine connected (shown on the machine card);
    // `?computer=<stable id>` enforces one-computer-per-computer (a 2nd computer is rejected with HTTP 409);
    // `?v=<VERSION>` is our own version, which the backend stores on the machine at every connect.
    const base = `${env.BACKEND_WS_URL.replace(/\/$/, '')}/api/adapter-ws?label=${encodeURIComponent(hostname())}&v=${encodeURIComponent(VERSION)}&autonomousEnv=${encodeURIComponent(autonomousEnv)}`
    // `?machine=<id>` is the machine this daemon still believes it is. The backend uses it to tell a
    // REVOKED daemon — one whose machine was deleted while it was offline — apart from a first-time
    // pairing, and answers 403 instead of quietly minting a replacement machine. Guarded on shape
    // because in test mode the first constructor argument carries a token, not a machine id.
    const claim = /^[a-f0-9]{32}$/.test(machineId) ? `&machine=${encodeURIComponent(machineId)}` : ''
    this.url = (computerId ? `${base}&computer=${encodeURIComponent(computerId)}` : base) + claim
    this.onStatus = onStatus
    this.machineId = machineId
    this.e2ee = new E2eeManager({
      machineId: this.machineId,
      sendTo: (connId, frame) => this.sendTo(connId, frame),
      sendUser: (frame) => this.sendUser(frame),
      isConnected: () => this.isConnected(),
      isConnectionAvailable: connId => this.directDeviceSinks.has(connId) || this.isConnected(),
      onIdentityPaired: (connId, pub) => { if (this.directDeviceSinks.has(connId)) this.directDevicePins.set(connId, pub) },
      onIdentityRevoked: identity => { this.autonomousDeviceRelay?.revoke(identity); this.onDirectDeviceRevoked?.(fingerprint(b64d(identity))) },
      onSessionDropped: (connId) => { this.viewerForwarder.closeConnection(connId); this.interactiveViewers.closeConnection(connId); this.ownerCommands.closeConnection(connId) },
      onPeerLinked: (peer) => {
        // The mutual half of a password link: a machine that proved this one's password is pinned back,
        // so this machine can dial it without that machine's own password.
        if (peer.kind === 'machine' && peer.machineId && peer.machineId !== this.machineId) {
          new MachinePeerStore().pin(peer.machineId, peer.pub, peer.label)
        }
        this.onPeerLinked?.(peer)
      },
      onUnpaired: (pub) => this.onUnpaired?.(pub),
    })
    this.terminalP2p = new TerminalP2pResponderPool({
      sendSignal: (connId, type, payload) => this.sendP2pSignal(connId, type, payload),
      onData: (connId, data) => this.handleP2pData(connId, data),
      onUnavailable: (connId, reason) => this.demoteP2pConnection(connId, reason),
    })
  }

  setTerminalStreamManager(manager: TerminalStreamManager): void {
    this.terminalStreams = manager
  }

  /** Run CPace pairing for a code entered via `harness pair <code>` (delegated to the manager). */
  pair(code: string): Promise<PairResult> {
    return this.e2ee.onPair(code)
  }
  e2eeFingerprint(): string {
    return this.e2ee.fingerprint()
  }
  /** `harness pairings` — list paired clients. */
  listPairs(): ReturnType<E2eeManager['listPaired']> {
    return this.e2ee.listPaired()
  }
  /** `harness unpair <id>` — unpair one client (signals it to re-pair if online). */
  revoke(id: string): ReturnType<E2eeManager['revoke']> {
    return this.e2ee.revoke(id)
  }
  /** `harness unpair --all` — unpair every client. */
  revokeAll(): ReturnType<E2eeManager['revokeAll']> {
    return this.e2ee.revokeAll()
  }
  /** `harness remote-password set` — stretch + persist a new persistent remote password. */
  setRemotePassword(password: string): ReturnType<E2eeManager['setRemotePassword']> {
    return this.e2ee.setRemotePassword(password)
  }
  /** `harness remote-password clear` — remove the persistent remote password. */
  clearRemotePassword(): void {
    this.e2ee.clearRemotePassword()
  }
  /** `harness link connect` — trust the machine this one just linked as a client too (mutual link). */
  trustPeer(peer: LinkedPeer): void {
    this.e2ee.trustPeer(peer)
  }
  /** Stop trusting `pub` here (unlink / trust-group removal); true when it was trusted. */
  untrustPeer(pub: string): boolean {
    return this.e2ee.untrustPeer(pub)
  }
  pairedPeers(): ReturnType<E2eeManager['pairedPeers']> {
    return this.e2ee.pairedPeers()
  }
  /** `harness remote-password status` — whether one is set, and its fingerprint. */
  remotePasswordStatus(): ReturnType<E2eeManager['remotePasswordStatus']> {
    return this.e2ee.remotePasswordStatus()
  }

  /** The account's private harness grid name, as the backend last reported it. Null until the first
   *  `machine_meta` lands, or when this account has none yet. */
  private harnessGridName: string | null = null
  /** Injected so the derivation (a `grid` spawn) is a seam in tests; see `lib/gridDerive.ts`. */
  deriveGridName: () => Promise<string | null> = deriveHarnessGridName
  /** Have grid ready for a grid feature the person is using now (`lib/gridAttach.ts`): `grid` installed,
   *  signed in as this account with its harness token, and — `ownGrid` — the account's own grid there.
   *  Asked by acts only (Set up, Get, Use, a move onto a grid model, a Model Manager command), never by
   *  a read. Set by `cli.ts`; null (tests) reads grid as it stands. */
  ensureGrid: ((request?: { ownGrid?: boolean }) => Promise<GridAttachResult>) | null = null
  /** Offline, cheap: is there a `grid` here holding a sign-in? Answers the list read's
   *  `gridSetupNeeded`. Null (tests) reads as set up. */
  gridSetUp: (() => boolean) | null = null

  /** Set the account's private grid name from the reconcile that just confirmed it, so the RPCs
   *  answer with it at once rather than waiting for the next `machine_meta` (`lib/gridAttach.ts`). */
  setHarnessGridName(name: string | null): void { this.harnessGridName = name }

  /** Which grid this machine's agents can be pointed at — for `harness status` and the models RPC. */
  gridName(): string | null { return this.harnessGridName }

  /** This machine's name as the Machines list shows it — what a model it serves is labelled with. */
  machineName(): string | null { return this.machineDisplayName }

  /** The account's private grid, resolved the way the models RPC resolves it — for a harness
   *  workspace that must be told which grid is "yours" rather than work it out or ask. */
  privateGridName(): Promise<string | null> { return this.resolveGridName() }

  /** `grid_models_changed` to the windows on this computer: the same payload `grid_models_list` answers,
   *  built from the pictures as they stand — no read is started to build it, so a push never causes one. */
  private async pushGridModels(): Promise<void> {
    if (this.closed || this.localClients.size === 0) return
    try {
      const gridName = await this.resolveGridName()
      const grids = await listAllGridModels(gridName, { refresh: false })
      // Each window in the form it asked for — see `gridModelsPayload`.
      const plain: Frame = { type: 'grid_models_changed', payload: gridModelsPayload(gridName, grids, false) }
      const withRowState: Frame = { type: 'grid_models_changed', payload: gridModelsPayload(gridName, grids, true) }
      this.sendLocal((connId) => this.rowStateWindows.has(connId) ? withRowState : plain)
    } catch { /* the next ask answers the same thing */ }
  }

  /**
   * The account's private grid: the backend's word when it gave one, else what this machine can
   * work out for itself (`lib/gridDerive.ts`). A backend that predates `machine_meta.gridName`
   * left every picker empty while `grid models` listed the model fine; the derivation is the
   * skill's own rule, so the daemon and the agent it opens agree on which grid is "yours".
   */
  private async resolveGridName(): Promise<string | null> {
    return this.harnessGridName ?? await this.deriveGridName()
  }

  /**
   * Grid set up for an act, or the sentence saying why it could not be: null when it is ready — or
   * when this daemon has no [ensureGrid] to ask (tests), which reads grid as it stands.
   */
  private async gridNotReady(ownGrid: boolean): Promise<string | null> {
    if (!this.ensureGrid) return null
    const ready = await this.ensureGrid({ ownGrid })
    if (ready.status !== 'converged' && ready.status !== 'signed-in') {
      return ready.detail || 'Grid could not be set up on this computer. Try again.'
    }
    if (ownGrid && ready.ownGrid && !['created', 'existed', 'adopted'].includes(ready.ownGrid)) {
      return ready.detail || 'Your grid could not be created. Try again.'
    }
    return null
  }

  connect(): void {
    if (this.closed || this.ws || this.connecting) return
    this.connecting = true
    void this.connectWithSession()
  }

  private async connectWithSession(): Promise<void> {
    let token: string
    try {
      token = this.testToken ?? await this.auth.accessToken()
    } catch (err) {
      this.connecting = false
      this.onStatus(false)
      const delay = err instanceof AuthSessionError && err.code === 'INVALID_REFRESH' ? MAX_DELAY_MS : BASE_DELAY_MS
      if (!this.closed) setTimeout(() => this.connect(), delay)
      return
    }
    if (this.closed) { this.connecting = false; return }
    // On timeout `ws` emits 'error' ("Opening handshake has timed out") then 'close', which lands in
    // onGone below and re-enters the ordinary backoff — the same path a refused connection takes.
    const ws = new WebSocket(this.url, [token], { handshakeTimeout: HANDSHAKE_TIMEOUT_MS })
    this.ws = ws
    this.connecting = false

    ws.on('open', () => {
      this.attempts = 0
      console.log(`[backend] connected → ${this.url}`)
      this.onStatus(true)
      this.drainQueue()
      this.onLinkUp?.()

      this.heartbeat = watchSocketLiveness(ws, {
        onIdle: (idleMs) => console.log(`[backend] no traffic for ${Math.round(idleMs / 1000)}s — terminating the link`),
        onWake: (sleptMs, hungUp) => console.log(`[backend] woke after ${Math.round(sleptMs / 1000)}s asleep — ${hungUp ? 'the backend has hung up, redialing' : 're-probing the link'}`),
        peerGivesUpAfterMs: BACKEND_IDLE_DEADLINE_MS,
      })

      // App-level ping refreshes the backend's presence key (TTL 30s). The window's presence rides
      // the same tick — a fresh socket knows nothing about the window, so its first tick goes through.
      this.lastAppPresenceUpAt = 0
      if (this.appOpenOwed && this.localClients.size > 0) this.sendAppPresence('open')
      this.appPing = setInterval(() => {
        this.sendBestEffort({ t: 'ping' })
        if (this.localClients.size > 0) this.sendAppPresence('ping')
      }, APP_PING_MS)
    })

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        const hop = decodeTerminalHop(new Uint8Array(raw as Buffer))
        if (hop?.direction === TerminalHopDirection.down) this.enqueueTerminalBinary(hop.connId, hop.clientFrame)
        return
      }
      let env_: DownEnvelope
      try { env_ = JSON.parse(raw.toString()) as DownEnvelope } catch { return }
      if (env_.t === 'down' && env_.frame) {
        // A malformed/hostile down-frame (bad __e2e envelope, bad ephemeral key) can throw in the
        // pre-`try` part of dispatchDown; without this .catch that becomes an unhandledRejection and the
        // daemon exits. Contain it: log, drop the frame, keep the socket alive.
        this.enqueueDown(env_.frame, env_.connId ?? '')
      }
    })

    const onGone = (why: string): void => {
      if (this.ws !== ws) return
      this.ws = null
      if (this.heartbeat) { this.heartbeat.stop(); this.heartbeat = null }
      if (this.appPing) { clearInterval(this.appPing); this.appPing = null }
      this.draining = false
      // While the backend link is down we can neither observe device presence nor deliver a card, so
      // default the recap gate to OFF (safe value) instead of holding a stale count — otherwise a turn
      // completing during the gap burns a `claude -p` recap that goes nowhere. attachAdapter always
      // re-pushes the true count via recomputeAndSendClients on reconnect (and 0→N re-fires the replay).
      this.harnessSharing?.closeAll()
      this.setCommanderCount(0, null) // active count is unknown until the next __clients snapshot
      this.viewerForwarder.closeAll()
      this.interactiveViewers.closeAll(); this.ownerCommands.closeAll()
      void this.terminalStreams?.closeConnectionsWhere(
        (connId) => !isLocalClientId(connId),
        'backend disconnected',
        false,
      )
      void this.terminalP2p.stop()
      this.p2pPendingOpens.clear()
      this.p2pStreams.clear()
      this.replayCommanderOnNextSnapshot = true
      this.onStatus(false)
      if (this.closed) return
      // A 401 refresh owns the next connect (see the error handler below): no competing backoff timer,
      // or two sockets would race for the one machine claim.
      if (this.retryingAuth) { console.log(`[backend] disconnected (${why}) — refreshing the token before reconnecting`); return }
      const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(this.attempts++, 5))
      console.log(`[backend] disconnected (${why}) — retrying in ${Math.round(delay / 1000)}s (attempt ${this.attempts})`)
      setTimeout(() => this.connect(), delay)
    }
    ws.on('close', (code) => onGone(`close ${code}`))
    ws.on('error', (err) => {
      const e = err as Error & { code?: string }
      const msg = e.message || e.code || String(err)
      console.error('[backend] socket error:', msg)
      // 401 on the upgrade = the access token was refused. Refresh it and come back; the socket is
      // torn down the ordinary way below (`ws.close()` → onGone: timers, status, streams), which is
      // what the previous shape skipped — it nulled `this.ws` first, so onGone returned at its first
      // line, status kept saying connected, and a refresh that failed for ANY reason (a network blip
      // included) wiped the SSO session. Only a refresh token the backend itself rejects means the
      // session is over; everything else is a transient and re-enters the backoff.
      if (/Unexpected server response: 401\b/.test(msg) && !this.retryingAuth) {
        this.retryingAuth = true
        void this.auth.accessToken({ force: true, failedToken: token })
          .then(() => {
            this.retryingAuth = false
            // onGone has normally run by now (the close lands long before a network round trip
            // returns); if this socket is somehow still ours, let go of it before dialing again.
            if (this.ws === ws) { this.ws = null; try { ws.terminate() } catch { /* ignore */ } }
            this.connect()
          })
          .catch((error: unknown) => {
            this.retryingAuth = false
            // No session to refresh, or a refresh token the backend rejects: the session is over.
            if (error instanceof AuthSessionError && (error.code === 'INVALID_REFRESH' || error.code === 'MISSING')) {
              this.closed = true
              this.onRevoked?.()
              return
            }
            if (this.closed) return
            if (this.ws === ws) { this.ws = null; try { ws.terminate() } catch { /* ignore */ } }
            const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(this.attempts++, 5))
            console.log(`[backend] token refresh failed (${error instanceof Error ? error.message : String(error)}) — retrying in ${Math.round(delay / 1000)}s (attempt ${this.attempts})`)
            setTimeout(() => this.connect(), delay)
          })
      } else if (/Unexpected server response: 40[13]\b/.test(msg)) {
        this.closed = true
        this.onRevoked?.()
      }
      // 409 = another computer already holds this machine. Keep the SSO session; stop
      // retrying (the 40[13] regex above deliberately excludes 409, so without this it would loop).
      else if (/Unexpected server response: 409\b/.test(msg)) {
        this.closed = true
        this.onBusy?.()
      }
      try { ws.close() } catch { /* ignore */ }
    })
  }

  async stop(): Promise<void> {
    this.closed = true
    this.closeAgentService?.dispose()
    this.stopGridModelsPush()
    this.orchestratorService?.stop()
    this.teamService?.stop()
    this.teamMailboxService?.stop()
    this.channelDirectory?.stop()
    this.viewerForwarder.closeAll()
    this.interactiveViewers.closeAll(); this.ownerCommands.closeAll()
    if (this.heartbeat) this.heartbeat.stop()
    if (this.appPing) clearInterval(this.appPing)
    await this.terminalStreams?.stop()
    await this.terminalP2p.stop()
    try { this.ws?.close() } catch { /* ignore */ }
    this.ws = null
    await this.harnessSharing?.stop()
  }

  /** Send an up-frame (event or RPC reply) to the WEB audience. Queued while disconnected.
   *  User-content events are group-encrypted (E2EE) here; system frames pass through as plaintext. */
  send(frame: Frame): void {
    this.monitorCompletions.observe(frame)
    // Only an already-open orchestration service observes events; ordinary sessions
    // do not create project state or incur disk work. Project payloads stay local.
    this.orchestratorService?.ingest(frame)
    if (env.LOG_FRAMES) logFrame('→', 'web', frame)
    for (const [connId, sink] of this.localClients) {
      if (!sink.sendFrame(frame)) void this.unregisterLocalClient(connId)
    }
    this.enqueue({ t: 'up', frame: this.e2ee.wrapUp(frame) })
  }

  /** Send an up-frame to the LOOPBACK clients only — never to the cloud.
   *
   *  For things that describe what is happening at THIS desk rather than what the machine is doing: the
   *  dial is a physical object on one table, and a finger moving on its glass is meaningful to the window
   *  in front of it and to nothing else. `send()` fans out to the web audience as well, which would scroll
   *  a window on a computer the user is not sitting at. */
  /** One frame to every window on this computer — or, given a function, each window its own. */
  sendLocal(frame: Frame | ((connId: string) => Frame)): void {
    for (const [connId, sink] of this.localClients) {
      if (this.toolClients.has(connId)) continue
      const sent = typeof frame === 'function' ? frame(connId) : frame
      if (env.LOG_FRAMES) logFrame('→', 'local', sent)
      if (!sink.sendFrame(sent)) void this.unregisterLocalClient(connId)
    }
  }

  /** One frame to ONE window on this computer, if it is one. Never queued, never to the cloud. */
  sendLocalTo(connId: string, frame: Frame): boolean {
    const sink = this.localClients.get(connId)
    if (!sink) return false
    if (env.LOG_FRAMES) logFrame('→', 'local', frame)
    if (sink.sendFrame(frame)) return true
    void this.unregisterLocalClient(connId)
    return false
  }

  /** Ask one local desktop to select focus, without opening panes in every window. */
  sendFirstLocal(frame: Frame): boolean {
    for (const [connId, sink] of this.localClients) {
      if (this.toolClients.has(connId)) continue
      if (sink.sendFrame(frame)) return true
      void this.unregisterLocalClient(connId)
    }
    return false
  }

  /** Send an up-frame to exactly ONE web connection (E2EE pairing/welcome + targeted RPC replies). */
  sendObserver(connId: string, type: string, payload: Record<string, unknown>): boolean {
    return this.sendBestEffort({ t: 'up', targetConnId: connId, webEligible: false, commanderEligible: false, frame: { type, payload } })
  }

  sendTo(connId: string, frame: Frame): void {
    // Handshake frames only: device RPC, legacy replies and broadcasts are recorded in the clear where built.
    if (typeof frame.type === 'string' && frame.type.startsWith('e2e_') && deviceDump.enabled && this.isDeviceConn(connId)) deviceDump.record('out', 'wire', connId, frame)
    const direct = this.directDeviceSinks.get(connId)
    if (direct) { direct(frame); return }
    const local = this.localClients.get(connId)
    if (local) {
      if (!local.sendFrame(frame)) void this.unregisterLocalClient(connId)
      return
    }
    this.enqueue({ t: 'up', targetConnId: connId, frame })
  }

  /** Pairwise terminal output is never queued across reconnect: the stream/lease is closed on link loss. */
  sendTerminalTo(connId: string, type: string, payload: Record<string, unknown>): boolean {
    const local = this.localClients.get(connId)
    if (local) return local.sendFrame({ type, payload })
    const frame = this.e2ee.wrapTarget(connId, type, payload)
    if (!frame) return false
    if (this.routeTerminalOutputToP2p(connId, type, payload)) {
      if (this.terminalP2p.send(connId, JSON.stringify(frame))) return true
      this.demoteP2pConnection(connId, 'send_failed')
    }
    return this.sendBestEffort({
      t: 'up',
      targetConnId: connId,
      webEligible: true,
      commanderEligible: false,
      frame,
    })
  }

  /** Pairwise-encrypted binary terminal output/keyframe. The hop prefix exposes
   * only connId and direction to the opaque backend relay. */
  sendTerminalBinaryTo(connId: string, clear: TerminalBinaryClear): boolean {
    const local = this.localClients.get(connId)
    if (local) {
      const frame = encodeTerminalLocal(clear)
      return frame ? local.sendBinary(frame) : false
    }
    const clientFrame = this.e2ee.wrapTerminalBinary(connId, clear)
    if (!clientFrame) return false
    if (this.p2pStreams.get(connId)?.has(clear.streamId)) {
      if (this.terminalP2p.send(connId, Buffer.from(clientFrame))) return true
      this.demoteP2pConnection(connId, 'send_failed')
    }
    const packet = encodeTerminalHop(TerminalHopDirection.up, connId, clientFrame)
    if (!packet || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    try { this.ws.send(packet); return true } catch { return false }
  }

  /**
   * Append one entry to the account's device key log, over this machine's own socket — the backend
   * ties a machine's entries to the machine that sent them. Resolves to the backend's answer
   * (`{head}` or `{error, head?}`), or null when it did not come in time.
   */
  appendDeviceLog(entry: Record<string, unknown>, timeoutMs = 15_000): Promise<Record<string, unknown> | null> {
    const requestId = `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.devlogAppends.delete(requestId); resolve(null) }, timeoutMs)
      timer.unref?.()
      this.devlogAppends.set(requestId, (payload) => { clearTimeout(timer); resolve(payload) })
      this.enqueue({ t: 'up', webEligible: false, frame: { type: 'devlog_append', payload: { requestId, entry } } })
    })
  }

  /** Send a user-level notification to every logged-in browser that owns this machine. */
  sendUser(frame: Frame): void {
    this.enqueue({ t: 'up', userEligible: true, webEligible: false, frame })
  }

  /** Send a DEVICE-audience frame (commanderEligible, not web). User/data frames are group-encrypted
   *  (E2EE) here so the backend relays only ciphertext; system/presence frames pass through. */
  /**
   * A tap on everything bound for a device, taken BEFORE E2EE wrapping.
   *
   * The dial on the USB cable is a second device audience, and it wants exactly what this one gets — the
   * same `commander_event` cards, in the same order, with the same recaps. Teeing here rather than adding
   * a parallel emit at each of the two dozen call sites is what keeps the two surfaces from drifting: a
   * new event kind reaches the cable the day it reaches the socket, without anyone remembering to add it.
   *
   * Plaintext on purpose: E2EE exists because the backend relays those frames. The cable relays nothing —
   * it is a wire the user physically owns, running to a process on their own computer.
   */
  onOutboundCommander?: (frame: Frame) => void

  sendCommander(frame: Frame): void {
    this.onOutboundCommander?.(frame)
    if (env.LOG_FRAMES) logFrame('→', 'device', frame)
    deviceDump.record('out', 'commander', undefined, frame)
    this.enqueue({ t: 'up', webEligible: false, commanderEligible: true, frame: this.e2ee.wrapCommander(frame) })
  }

  /**
   * The desktop window is open on this computer: tell the backend, which turns it into the person's
   * `user_daily_presence` row. The window itself says nothing — its loopback socket IS the fact, so
   * this daemon reports it: `open` the moment a window registers (registerLocalClient), `ping` on the
   * app-ping tick while any window is attached, at most once per APP_PRESENCE_UP_MS. Best-effort and
   * plaintext on purpose: it is bookkeeping about the person, not data, and a daemon that is signed
   * out (no backend dial) or between reconnects simply drops it rather than queueing a stale "was
   * open" behind real frames. Returns whether a frame went up.
   */
  sendAppPresence(kind: 'open' | 'ping'): boolean {
    const now = Date.now()
    if (kind === 'ping' && now - this.lastAppPresenceUpAt < APP_PRESENCE_UP_MS) return false
    const sent = this.sendBestEffort({
      t: 'up',
      webEligible: false,
      commanderEligible: false,
      frame: { type: 'app_presence', payload: { kind } },
    })
    if (sent) this.lastAppPresenceUpAt = now
    if (kind === 'open') this.appOpenOwed = !sent
    return sent
  }

  /** Attach one authenticated loopback desktop client to the same RPC and event plane as cloud web. */
  registerLocalClient(connId: string, sink: LocalClientSink, opts: { tool?: boolean } = {}): boolean {
    if (!isLocalClientId(connId) || this.localClients.has(connId)) return false
    this.localClients.set(connId, sink)
    if (opts.tool) { this.toolClients.add(connId); return true }
    this.sendAppPresence('open')
    this.onLocalClient?.(connId, true)
    return true
  }

  /** A loopback client that said it is a tool (`harness pair`, the MCP server), not a window. */
  isToolClient(connId: string): boolean { return this.toolClients.has(connId) }

  /** The windows attached right now — for a listener that arrives after some of them did. */
  localClientIds(): string[] { return [...this.localClients.keys()].filter((connId) => !this.toolClients.has(connId)) }

  /** Routes a request to the service that answers it, in its own process (core/serviceLinks.ts) or in
   *  this one (core/serviceHost.ts): false when none does and the socket answers it itself. */
  serviceRouter: ((type: string, payload: Record<string, unknown>, asker: Asker, reply: (result: Record<string, unknown>) => void) => boolean) | null = null
  /** A window (or `hn`) on this computer attached or went away — the pair brain thinks only while one is here. */
  onLocalClient: ((connId: string, attached: boolean) => void) | null = null

  /** Release all connection-scoped state when the loopback WebSocket closes. */
  async unregisterLocalClient(connId: string): Promise<void> {
    if (!this.localClients.delete(connId)) return
    if (!this.toolClients.delete(connId)) this.onLocalClient?.(connId, false)
    this.rowStateWindows.delete(connId)
    this.viewerForwarder.closeConnection(connId)
    this.interactiveViewers.closeConnection(connId); this.ownerCommands.closeConnection(connId)
    // The window left before any link could hear it attach: nothing happened, as far as the backend
    // is concerned, and a later link must not be told otherwise.
    if (this.localClients.size === 0) this.appOpenOwed = false
    this.downChains.delete(connId)
    await this.terminalStreams?.closeConnection(connId, 'local client disconnected', false)
  }

  /** Route an authenticated local JSON frame through the existing per-client FIFO.
   *
   *  ⚠️ Tagged `'local'`, not left to default to `'relay'`. These frames come from a process on THIS
   *  machine over the local socket, and until they were tagged they arrived at `dispatchDown`
   *  indistinguishable from the backend's own — which let any local process send a frame only the
   *  backend is entitled to send. See the `machine_meta` branch there. */
  handleLocalFrame(connId: string, frame: Frame): void {
    if (!this.localClients.has(connId)) return
    this.enqueueDown(frame, connId, 'local')
  }

  /** The window's focused agent on this local connection — its terminal gets the short output window. */
  setLocalTerminalFocus(connId: string, agentId: string | null): void {
    if (!this.localClients.has(connId)) return
    this.terminalStreams?.setFocusedAgent(connId, agentId)
  }

  /** Route an authenticated local terminal frame without applying cloud E2EE. */
  async handleLocalBinary(connId: string, frame: TerminalBinaryClear): Promise<void> {
    if (!this.localClients.has(connId)) return
    await this.terminalStreams?.handleBinary(connId, frame)
  }

  private enqueue(msg: OutboundEnvelope): void {
    const item: QueueItem = { id: this.nextQueueId++, data: JSON.stringify(msg), msg, attempts: 0 }
    if (this.queue.length >= QUEUE_MAX) this.dropOneQueued()
    if (this.queue.length >= QUEUE_MAX) {
      this.droppedSinceLog++
      this.logQueueDrops()
      return
    }
    this.queue.push(item)
    this.drainQueue()
  }

  private sendBestEffort(msg: OutboundEnvelope): boolean {
    const data = JSON.stringify(msg)
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(data); return true } catch { /* ignore */ }
    }
    return false
  }

  private sendP2pSignal(connId: string, type: string, payload: TerminalP2pSignal): void {
    const frame = this.e2ee.wrapTarget(connId, type, { ...payload })
    if (frame) this.sendTo(connId, frame)
  }

  private handleP2pData(connId: string, data: TerminalP2pData): void {
    if (typeof data === 'string') {
      if (Buffer.byteLength(data, 'utf8') > 512 * 1024) return
      let frame: Frame
      try { frame = JSON.parse(data) as Frame } catch { return }
      if (typeof frame.type !== 'string' || !TERMINAL_P2P_DOWN_TYPES.has(frame.type)) return
      this.enqueueDown(frame, connId, 'p2p')
      return
    }
    if (data.length > 512 * 1024) return
    this.enqueueTerminalBinary(connId, data)
  }

  private noteTerminalInputRoute(
    connId: string,
    type: string,
    payload: Record<string, unknown>,
    transport: DownTransport,
  ): void {
    if (type === 'terminal_open' && typeof payload.requestId === 'string') {
      let pending = this.p2pPendingOpens.get(connId)
      if (!pending) { pending = new Set(); this.p2pPendingOpens.set(connId, pending) }
      if (transport === 'p2p') pending.add(payload.requestId)
      else pending.delete(payload.requestId)
      return
    }
    const streamId = typeof payload.streamId === 'string' ? payload.streamId : ''
    // Live-migration promotion: the client's remoteRelay.ts sends a SECOND terminal_resync over p2p
    // (after the first one, over relay, already drained/snapshotted the stream) once its own p2p
    // channel is ready — arriving here is our signal to start routing this stream's OUTPUT over p2p
    // too, mirroring what the client just did on its side. hasStream() guards against promoting a
    // streamId whose pane was closed in the same instant the migration was in flight.
    if (type === 'terminal_resync' && transport === 'p2p' && streamId
      && this.terminalStreams?.hasStream(connId, streamId)) {
      let streams = this.p2pStreams.get(connId)
      if (!streams) { streams = new Set(); this.p2pStreams.set(connId, streams) }
      streams.add(streamId)
      return
    }
    if (transport !== 'p2p' && streamId) this.p2pStreams.get(connId)?.delete(streamId)
  }

  private routeTerminalOutputToP2p(connId: string, type: string, payload: Record<string, unknown>): boolean {
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
    const streamId = typeof payload.streamId === 'string' ? payload.streamId : ''
    const pending = this.p2pPendingOpens.get(connId)
    if ((type === 'terminal_ready' || type === 'terminal_error') && requestId && pending?.has(requestId)) {
      pending.delete(requestId)
      if (pending.size === 0) this.p2pPendingOpens.delete(connId)
      if (type === 'terminal_ready' && streamId) {
        let streams = this.p2pStreams.get(connId)
        if (!streams) { streams = new Set(); this.p2pStreams.set(connId, streams) }
        streams.add(streamId)
      }
      return true
    }
    const streams = this.p2pStreams.get(connId)
    const selected = !!streamId && streams?.has(streamId) === true
    if (selected && type === 'terminal_closed') {
      streams!.delete(streamId)
      if (streams!.size === 0) this.p2pStreams.delete(connId)
    }
    return selected
  }

  private demoteP2pConnection(connId: string, reason: string): void {
    this.p2pPendingOpens.delete(connId)
    this.p2pStreams.delete(connId)
    console.warn(`[terminal-p2p] conn=${sid(connId)} fallback=relay reason=${reason}`)
  }

  /** Hold requests at the gate until `openRequests`. The daemon calls this the moment it builds this
   *  socket, before anything can reach it; a socket built without it answers at once. */
  holdRequests(): void {
    if (!this.requestsOpen) return
    this.requestsOpen = false
    this.requestGate = new Promise<void>((resolve) => { this.openRequestGate = resolve })
  }

  /** Let requests through: every handler is wired and the agents the daemon restored are confirmed.
   *  Idempotent. Called once at the end of start-up — and by safe mode, so a daemon that could not
   *  start still answers rather than leaving its clients waiting. */
  openRequests(): void {
    if (this.requestsOpen) return
    this.requestsOpen = true
    this.waitingAtGate.clear()
    this.openRequestGate()
  }

  private enqueueDown(frame: Frame, connId: string, transport: DownTransport = 'relay'): void {
    const key = connId || '__backend__'
    if (!this.requestsOpen) {
      const waiting = (this.waitingAtGate.get(key) ?? 0) + 1
      this.waitingAtGate.set(key, waiting)
      if (waiting > MAX_REQUESTS_BEFORE_READY && transport === 'local') {
        console.warn(`[backend] local client ${key} sent ${waiting} requests before the daemon was ready — closing it`)
        this.waitingAtGate.delete(key)
        void this.unregisterLocalClient(connId)
        return
      }
    }
    const previous = this.downChains.get(key) ?? Promise.resolve()
    const next = previous
      .catch(() => { /* prior failure is already logged */ })
      .then(() => this.requestGate)
      .then(() => this.dispatchDown(frame, connId, transport))
      .catch((err) => {
        console.error('[backend] down-frame dispatch failed:', err instanceof Error ? err.message : err)
      })
      .finally(() => {
        if (this.downChains.get(key) === next) this.downChains.delete(key)
      })
    this.downChains.set(key, next)
  }

  private enqueueTerminalBinary(connId: string, raw: Uint8Array): void {
    const key = connId || '__backend__'
    const previous = this.downChains.get(key) ?? Promise.resolve()
    const next = previous
      .catch(() => { /* prior failure is already logged */ })
      .then(async () => {
        const clear = this.e2ee.unwrapTerminalBinary(connId, raw)
        if (clear) await this.terminalStreams?.handleBinary(connId, clear)
      })
      .catch((err) => {
        console.error('[backend] binary terminal dispatch failed:', err instanceof Error ? err.message : err)
      })
      .finally(() => {
        if (this.downChains.get(key) === next) this.downChains.delete(key)
      })
    this.downChains.set(key, next)
  }

  private drainQueue(): void {
    if (this.draining || !this.queue.length) return
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const item = this.queue[0]
    this.draining = true
    try {
      ws.send(item.data, (err?: Error) => {
        if (this.ws !== ws) return
        if (err) {
          item.attempts++
          this.draining = false
          console.error(`[backend] queued send failed (id=${item.id}, attempts=${item.attempts}):`, err.message)
          try { ws.close() } catch { /* ignore */ }
          return
        }
        if (this.queue[0] === item) this.queue.shift()
        this.draining = false
        this.drainQueue()
      })
    } catch (err) {
      item.attempts++
      this.draining = false
      console.error(`[backend] queued send threw (id=${item.id}, attempts=${item.attempts}):`, err instanceof Error ? err.message : err)
      try { ws.close() } catch { /* ignore */ }
    }
  }

  private dropOneQueued(): void {
    const idx = this.queue.findIndex((item) => !('targetConnId' in item.msg))
    const dropAt = idx >= 0 ? idx : 0
    if (this.queue.splice(dropAt, 1).length) {
      this.droppedSinceLog++
      this.logQueueDrops()
    }
  }

  private logQueueDrops(): void {
    if (this.droppedSinceLog === 1 || this.droppedSinceLog % 100 === 0) {
      console.warn(`[backend] outbound queue full; dropped ${this.droppedSinceLog} frame(s) so far`)
    }
  }

  // ── down-frame dispatch (the hosted runtime-role RPC switch) ────────────────────────────────────────────

  /** Emit an RPC reply. For an E2EE-session requester whose result carries user content, the reply is
   *  encrypted with that connection's session key and delivered ONLY to it. Content-bearing adapter data
   *  is never returned plaintext: even legacy backend nodeRequest (`connId === ''`) gets only an error. */
  private emitReply(connId: string, type: string, requestId: unknown, payload: Record<string, unknown>): void {
    const resultType = rpcResultType(type)
    if (connId && deviceDump.enabled && this.e2ee.sessionRole(connId) === 'device') deviceDump.record('out', 'legacy', connId, { type: resultType, payload: { requestId, ...payload } })
    // Before the E2EE wrap: an RPC reply is only readable here.
    if (env.LOG_FRAMES && !TEAM_REQUEST_TYPES.has(type) && !OWNER_COMMAND_TYPES.has(type) && !type.startsWith('viewer_') && type !== 'phone_pair' && type !== 'api_connections' && type !== 'orchestrator' && !type.startsWith('grid_fleet_') && type !== 'agent_read_file' && type !== 'project_preview' && type !== 'git_project_info' && type !== 'git_pull_request' && type !== 'agent_handoff_prepare' && !SHARE_REQUEST_TYPES.has(type) && !type.startsWith('pair')) logFrame('→', connId ? `conn:${sid(connId)}` : 'backend', { type: resultType, payload: { requestId, ...payload } })
    if (this.localClients.has(connId)) {
      this.sendTo(connId, { type: resultType, payload: { requestId, ...payload } })
      return
    }
    if (connId && this.e2ee.hasSession(connId) && encryptRpcResult(resultType)) {
      let replyPayload = payload
      // ⚠️ The DIAL's frame budget, so only a dial's reply is fitted to it. The phone app and a remote
      // desktop are `web` sessions and search this reply for the agent's latest answer: fitted, a reply
      // over ~15KB dropped to one event without its `fullText`, so any agent doing real work — long
      // answers — could not be found by what it had just said.
      if (resultType === 'agent_recent_result' && this.e2ee.sessionRole(connId) === 'device') {
        const trim = fitRecentReplyPayloadForDevice(
          payload,
          (candidate) => this.e2ee.rpcReplyFrameBytes(connId, resultType, requestId, candidate),
        )
        replyPayload = trim.payload
        if (trim.trimmed) {
          console.warn(
            `[recent-trim] agent=${String(payload.agentId ?? '')} originalFrame=${trim.originalBytes ?? 'unknown'} ` +
            `finalFrame=${trim.finalBytes ?? 'unknown'} target=${DEVICE_RECENT_SAFE_FRAME_BYTES} ` +
            `textBytes=${trim.textBytes} recapBytes=${trim.recapBytes}`,
          )
        }
      }
      const wrapped = this.e2ee.wrapRpcReply(connId, resultType, requestId, replyPayload)
      if (wrapped) { this.sendTo(connId, wrapped); return }
    }
    // Enforcement ("no E2EE ⇒ no adapter data"): content-bearing RPC replies must never leave the
    // adapter plaintext. A real client gets a targeted error; the legacy backend nodeRequest awaiter
    // (`connId === ''`) gets a broadcast error with the same requestId so it fails closed without data.
    // 
    if (encryptRpcResult(resultType)) {
      const errorFrame = { type: resultType, payload: { requestId, error: 'E2EE_REQUIRED' } }
      if (connId) this.sendTo(connId, errorFrame)
      else this.send(errorFrame)
      return
    }
    this.send({ type: resultType, payload: { requestId, ...payload } })
  }

  private async dispatchDown(frame: Frame, connId: string, transport: DownTransport = 'relay'): Promise<void> {
    const type = frame.type as string | undefined
    if (!type) return
    // Whether this frame came from a process on THIS machine — the trust boundary the gates below
    // turn on. The membership half is a dispatch-time question about a connection that may already
    // be gone: frames run through a per-connId queue, so a local client that disconnects between
    // sending and being dispatched used to leave `localClients.has()` false, and its already-queued
    // frames were then read as the BACKEND's. The transport half closes that, because it is stamped
    // at enqueue by the caller that had just verified membership. Either one being true is local.
    const local = transport === 'local' || this.localClients.has(connId)
    // ⚠️ The backend's own instructions, refused from anywhere else. See BACKEND_ONLY_DOWN_TYPES.
    // `transport === 'relay'` rather than `!local`, so this keeps holding if the p2p allowlist
    // (`TERMINAL_P2P_DOWN_TYPES`) ever widens; "not local" would quietly start admitting p2p.
    //
    // Deliberately ABOVE the observer hand-off below. A genuine observer frame is `relay`, so this
    // never intercepts one; but placed after it, a forged `observer:` connId on a local or p2p frame
    // would be swallowed by `harnessSharing.receive` and returned without ever reaching this line —
    // silently, with no warning — and the invariant would then rest on three facts in other files
    // (the `local:` prefix rule, `registerLocalClient`'s check, the p2p-signal ordering) instead of
    // on this one. The grid-name incident was exactly a bypass nobody could see.
    if (transport !== 'relay' && BACKEND_ONLY_DOWN_TYPES.has(type)) {
      console.warn(`[backend] ignoring ${type} from ${transport} (${connId}) — only the backend may send it`)
      return
    }
    if (connId.startsWith('observer:')) {
      await this.harnessSharing?.receive(connId, type, (frame.payload ?? {}) as Record<string, unknown>)
      return
    }
    if (type.startsWith('observer_')) return
    // E2EE control frames (pairing/handshake) are handled by the manager, never as node RPCs.
    if (type.startsWith('e2e_')) {
      if (local) {
        this.sendTo(connId, { type: 'local_protocol_error', payload: { error: 'LOCAL_E2EE_UNSUPPORTED' } })
        return
      }
      const deviceBefore = deviceDump.enabled && (this.isDeviceConn(connId) || (type === 'e2e_pair_intent' && (frame.payload as { role?: unknown } | undefined)?.role === 'device'))
      if (deviceBefore) deviceDump.record('in', 'wire', connId, frame)
      this.e2ee.handleFrame(connId, frame)
      // A reconnecting device is only known as one once its hello has been accepted.
      if (!deviceBefore && deviceDump.enabled && this.isDeviceConn(connId)) deviceDump.record('in', 'wire', connId, frame)
      return
    }
    if (type === 'autonomous_device_request') {
      if (!local) await this.autonomousDeviceRelay?.handle(connId, frame)
      return
    }
    // ⚠️ Default-deny: the relay is NOT trusted. A non-local frame is acted on only if it opens under
    // this connId's E2EE session — whatever its type — or is one of the backend's own plaintext frames.
    // A list of "sensitive" types to check instead fails open: every type missing from it, including
    // ones added later, would be taken in the clear.
    //
    // The backend's own control frames are the mirror image: only ever plaintext, because the backend
    // holds no key — so one that arrives SEALED was sealed by a paired client, and opening it would let
    // that client speak as the backend (`machine_meta` repoints this computer's grid).
    if (!local) {
      const from = `${transport} (${connId ? `conn:${sid(connId)}` : 'backend'})`
      const wrapped = isWrapped(frame.payload)
      if (type.startsWith('__') || BACKEND_ONLY_DOWN_TYPES.has(type)) {
        // And only on the backend's OWN address: it sends these with `connId: ''`, while every frame a
        // client sends arrives stamped with that client's connId — so a client-shaped one was relayed, not
        // written by the backend, whichever socket let it through. `__client_disconnected` is the one the
        // hub addresses to a client's own connId; it only tears down that connection's state.
        if (transport !== 'relay' || wrapped || (connId !== '' && type !== '__client_disconnected')) {
          console.warn(`[backend] ignoring ${logSafeType(type)} from ${from} — only the backend sends it, and only in the clear`)
          return
        }
      } else if (wrapped) {
        const dec = this.e2ee.unwrapDown(connId, frame)
        if (!dec) return
        frame = dec
      } else {
        console.warn(`[backend] refusing plaintext ${logSafeType(type)} from ${from} — E2EE required`)
        const requestId = (frame.payload as { requestId?: unknown } | undefined)?.requestId
        if (requestId !== undefined) this.emitReply(connId, type, requestId, { error: 'E2EE_REQUIRED' })
        return
      }
    }
    if (!local && deviceDump.enabled && this.e2ee.sessionRole(connId) === 'device') deviceDump.record('in', 'legacy', connId, frame)
    if (!local && TERMINAL_P2P_SIGNAL_TYPES.has(type)) {
      await this.terminalP2p.handleSignal(connId, type, frame.payload)
      return
    }
    // Logged AFTER the unwrap above, so a down-frame reads as what the client actually asked for rather
    // than as an opaque __e2e envelope.
    // Terminal frames contain raw keystrokes, paste text and screen bytes after
    // unwrap. Never pass them to the frame logger, even in diagnostic mode.
    if (env.LOG_FRAMES && !TEAM_REQUEST_TYPES.has(type) && !OWNER_COMMAND_TYPES.has(type) && !type.startsWith('terminal_') && !type.startsWith('viewer_') && !type.startsWith('grid_fleet_') && type !== 'agent_read_file' && type !== 'project_preview' && type !== 'git_project_info' && type !== 'git_pull_request' && type !== 'agent_handoff_prepare' && type !== 'orchestrator' && type !== 'api_connections' && type !== 'phone_pair' && !SHARE_REQUEST_TYPES.has(type) && !type.startsWith('pair')) {
      logFrame('←', connId ? `conn:${sid(connId)}` : 'backend', frame)
    }
    const reply = (t: string, rid: unknown, p: Record<string, unknown>): void => this.emitReply(connId, t, rid, p)
    const lifecycleTarget = (frame.payload as { agentId?: unknown } | undefined)?.agentId
    if (typeof lifecycleTarget === 'string' && this.purgeAgentService?.busy(lifecycleTarget)
      && ['agent_close', 'agent_delete', 'agent_resume', 'agent_restart', 'agent_retarget', 'agent_update'].includes(type)) {
      reply(type, (frame.payload as { requestId?: unknown }).requestId, { error: 'DELETE_IN_PROGRESS' }); return
    }
    if (SHARE_REQUEST_TYPES.has(type)) {
      const p = (frame.payload ?? {}) as Record<string, unknown>
      const result = await this.harnessSharing?.manage(type, p).catch(() => ({ error: 'SHARING_UNAVAILABLE', detail: 'Sharing is temporarily unavailable. Try again.' }))
      reply(type, p.requestId, result ?? { error: 'UNSUPPORTED' })
      return
    }
    // Cross-instance client snapshot. Generation detects leave/join cycles that coalesce to the same
    // count; count rise remains the compatibility fallback for older backends.
    if (type === '__clients') {
      const payload = (frame.payload ?? {}) as { commander?: number; commanderActive?: number; commanderJoinGeneration?: number }
      const commander = Number(payload.commander ?? 0)
      const rawGeneration = payload.commanderJoinGeneration
      const generation = typeof rawGeneration === 'number' && Number.isSafeInteger(rawGeneration) && rawGeneration >= 0
        ? rawGeneration
        : undefined
      const replay = shouldReplayCommander(
        this.commanderCount,
        commander,
        this.replayedCommanderGeneration,
        generation,
        this.replayCommanderOnNextSnapshot,
      )
      this.setCommanderCount(commander, payload.commanderActive != null ? Number(payload.commanderActive) : null)
      if (replay) {
        this.replayCommanderOnNextSnapshot = false
        if (generation != null) this.replayedCommanderGeneration = generation
        this.onCommanderJoin?.()
      }
      return
    }
    if (type === '__client_disconnected') {
      // The backend is authoritative for the outer connId. Drop both kinds of
      // connection-scoped state immediately; otherwise a dead Desktop keeps a
      // terminal controller lease until the 30-second heartbeat timeout.
      this.autonomousDeviceRelay?.drop(connId)
      this.e2ee.dropSession(connId)
      this.viewerForwarder.closeConnection(connId)
      this.interactiveViewers.closeConnection(connId); this.ownerCommands.closeConnection(connId)
      await this.terminalP2p.closeConnection(connId, 'client_disconnected', false)
      this.p2pPendingOpens.delete(connId)
      this.p2pStreams.delete(connId)
      await this.terminalStreams?.closeConnection(
        connId,
        'client connection closed',
        false,
      )
      return
    }
    // Other backend-hub internal control frames (__clients_dirty) — not for us; drop silently.
    if (type.startsWith('__')) return

    // The machine was deleted/revoked from the web → stop for good (don't reconnect) and let the CLI
    // clear the saved token. `closed` blocks the reconnect that would otherwise fire on socket drop.
    if (type === 'machine_revoked') {
      const p = (typeof frame.payload === 'object' && frame.payload !== null ? frame.payload : {}) as { reason?: unknown; pub?: unknown }
      // Another key under this machine id was removed — an earlier install of this computer that this one
      // waits behind (`device_conflict`). The frame goes to the machine id, so it reaches this install too:
      // that removal is what lets this key register, not a sign-out. Re-read the log instead.
      if (p.reason === 'device_removed' && typeof p.pub === 'string' && this.isOwnDeviceKey && !this.isOwnDeviceKey(p.pub)) {
        this.onDeviceKeysChanged?.()
        return
      }
      this.closed = true
      // Removed from the account's device key log (not just signed out): the key itself is spent.
      if (p.reason === 'device_removed' && typeof p.pub === 'string') {
        try { this.onDeviceRemoved?.(p.pub) } catch { /* signing out still happens */ }
      }
      this.onRevoked?.()
      return
    }

    // The account's tabs changed on another computer (or in another window of this one): hand the
    // window the revision and let it fetch `/api/desk` through this daemon. Backend-only, like
    // machine_meta — a local client cannot make the window re-read anything by sending this.
    if (type === 'desk_changed') {
      this.refreshChannels()
      const revision = (typeof frame.payload === 'object' && frame.payload !== null ? (frame.payload as { revision?: unknown }).revision : undefined)
      this.sendLocal({ type: 'desk_changed', payload: { revision: typeof revision === 'number' ? revision : 0 } })
      return
    }

    // The account's zoo — its daemons and eggs — changed on another client: the same hand-off as the
    // desk, on its own frame, so the window re-reads `/api/zoo` and never the desk (or the other way
    // round). Backend-only for the same reason as desk_changed.
    if (type === 'zoo_changed') {
      const revision = (typeof frame.payload === 'object' && frame.payload !== null ? (frame.payload as { revision?: unknown }).revision : undefined)
      this.sendLocal({ type: 'zoo_changed', payload: { revision: typeof revision === 'number' ? revision : 0 } })
      return
    }

    // The account's device key log grew: this daemon re-reads and verifies it (deviceLogSyncer.ts), and
    // the window re-reads its Devices list. Backend-only for the same reason as desk_changed.
    if (type === 'device_keys_changed') {
      this.onDeviceKeysChanged?.()
      this.sendLocal({ type: 'device_keys_changed', payload: {} })
      return
    }
    // The backend's answer to this machine's own append to the device key log.
    if (type === 'devlog_append_result') {
      const p = (typeof frame.payload === 'object' && frame.payload !== null ? frame.payload : {}) as Record<string, unknown>
      const done = typeof p.requestId === 'string' ? this.devlogAppends.get(p.requestId) : undefined
      if (done) { this.devlogAppends.delete(p.requestId as string); done(p) }
      return
    }

    // The account's machine list changed on some worker — a machine created / renamed / deleted, or a
    // shared harness invited / taken back. The window re-reads `/api/machines` through this daemon; this
    // push is why it does not have to poll for that. Backend-only for the same reason as desk_changed.
    if (type === 'machines_changed') {
      const reason = (typeof frame.payload === 'object' && frame.payload !== null ? (frame.payload as { reason?: unknown }).reason : undefined)
      this.sendLocal({ type: 'machines_changed', payload: { reason: typeof reason === 'string' ? reason : 'updated' } })
      return
    }

    // Machine display name (seed on connect + web renames) — mirrored locally for `harness status`.
    if (type === 'machine_meta') {
      // ⚠️ The BACKEND's frame and nobody else's. It carries this machine's display name and, more
      // to the point, the account's private grid — the grid every agent on this computer is then
      // pointed at. Accepted from any transport, it let a process that could open the daemon's local
      // port redirect the account's inference somewhere of its choosing, and a leftover test script
      // doing exactly that by accident cost hours to find. No client sends this frame; there is
      // nothing to be compatible with.
      // The source check is above, with the other frames only the backend may send.
      //
      // A malformed/hostile frame's payload need not be an object; `'gridName' in meta` would throw
      // on a primitive (and drop the whole frame via enqueueDown's catch). Guard the type first, the
      // way the plain property reads elsewhere in this dispatcher tolerate one.
      const meta = (typeof frame.payload === 'object' && frame.payload !== null ? frame.payload : {}) as { name?: unknown; gridName?: unknown }
      const name = meta.name
      // The account's private grid, pushed on connect. Held in memory only: it is the backend's
      // value, and a daemon that cached it on disk would keep answering with a stale one after the
      // account's grid changed. Only ACT on the key when it is present: the connect frame always
      // carries it (a string or null), but a rename pushes `{name}` alone — and treating that
      // absence as null used to WIPE a grid name a moment after it was set, leaving the picker
      // empty. Absent ⇒ unchanged; null ⇒ this account has none; a string ⇒ that grid.
      if ('gridName' in meta) {
        this.harnessGridName = typeof meta.gridName === 'string' && meta.gridName.trim() ? meta.gridName.trim() : null
      }
      // The same rule for the name: a frame that does not carry it leaves it as it was.
      if ('name' in meta) this.machineDisplayName = typeof name === 'string' && name.trim() ? name.trim() : null
      this.onMachineMeta?.(typeof name === 'string' && name.trim() ? name.trim() : null)
      return
    }

    const payload = (frame.payload ?? {}) as Record<string, unknown>
    const requestId = payload.requestId

    if (TEAM_REQUEST_TYPES.has(type)) {
      // Observers were handled above; only the owner or a paired owner client reaches this route.
      if (!local && this.e2ee.sessionRole(connId) !== 'web') {
        reply(type, requestId, { error: 'OWNER_REQUIRED', detail: 'Team communication requires an owner connection.' })
        return
      }
      void Promise.resolve().then(async () => {
        if (type === 'team') {
          if (payload.action === 'context') {
            const agentId = Id.parse(payload.agentId)
            return this.channels().taskContext(agentId, this.swarmPromptScopes.current(agentId))
          }
          if (String(payload.action).startsWith('channel_')) return this.channels().request(payload)
          if (typeof payload.teamId === 'string' && this.teams().isChannel(payload.teamId)
              && ['ask', 'get', 'members'].includes(String(payload.action))) await this.channels().refresh(payload.action === 'ask')
          return teamRequest(this.teams(), payload)
        }
        if (payload.action === 'runtime') return { runtime: this.localTeamRuntime(Id.parse(payload.agentId)) }
        if (payload.action === 'prompt_scope') return { teamId: this.swarmPromptScopes.current(Id.parse(payload.agentId)) }
        if (payload.action === 'prompt_replied') {
          this.swarmPromptScopes.replied(Id.parse(payload.agentId), OperationId.parse(payload.teamId), OperationId.parse(payload.questionId))
          return { ok: true }
        }
        return teamDeliveryRequest(this.teamMailbox(), payload)
      }).then(result => reply(type, requestId, result)).catch(error => reply(type, requestId, teamFailure(error)))
      return
    }

    if (type === 'api_connections') {
      if (!local && this.e2ee.sessionRole(connId) !== 'web') { reply(type, requestId, { error: 'OWNER_REQUIRED' }); return }
      if (payload.action === 'models') {
        reply(type, requestId, await apiModelsRequest(this.apiConnections, payload))
        return
      }
      reply(type, requestId, apiConnectionsRequest(this.apiConnections, payload))
      if (payload.action === 'save') rememberSavedApis(this.apiConnections)
      return
    }

    // A paired owner can run the machine's orchestrator; observers and device sessions cannot.
    // Both requests and replies are encrypted, including project artifacts.
    if (OWNER_COMMAND_TYPES.has(type)) {
      if (!local && this.e2ee.sessionRole(connId) !== 'web') { reply(type, requestId, { error: 'OWNER_REQUIRED' }); return }
      void this.ownerCommands.request(connId, type, payload).then(result => reply(type, requestId, result))
      return
    }

    if (type === 'orchestrator') {
      if (!local && this.e2ee.sessionRole(connId) !== 'web') { reply(type, requestId, { error: 'OWNER_REQUIRED' }); return }
      // Detached: a large artifact snapshot must not block cancel/status on this connection.
      void orchestratorRequest(this.orchestration(), payload)
        .then(result => reply(type, requestId, result))
        .catch(() => reply(type, requestId, { error: 'ORCHESTRATOR_FAILED' }))
      return
    }

    // Retired optional-feature requests remain reserved. Never reinterpret one as an
    // ordinary command or weaken its existing encryption / local transport boundary.
    if (PAIR_REQUESTS.has(type) || type === 'pair' || type === PLATE_REQUEST) {
      const error = type === 'pair' && !local ? 'LOCAL_ONLY'
        : type !== 'pair' && local ? 'REMOTE_ONLY' : 'UNSUPPORTED'
      reply(type, requestId, { error })
      return
    }

    if (type === 'viewer_surface') {
      if (!local && this.e2ee.sessionRole(connId) !== 'web') return
      // Rendering and input never hold up terminal traffic on the ordered machine queue.
      void this.interactiveViewers.request(connId, payload)
        .then(result => reply(type, requestId, result))
        .catch(() => reply(type, requestId, { error: 'VIEWER_UNAVAILABLE' }))
      return
    }

    // Trust-group roster exchange: only over an E2EE session, from the identity that session proved —
    // the roster carries the keys this machine trusts, and the peer's own entry must be that identity.
    if (type === 'group_sync') {
      const peerPub = local ? null : this.e2ee.sessionIdentity(connId)
      if (!peerPub || this.e2ee.sessionRole(connId) !== 'web' || !this.groupSync) { reply(type, requestId, { error: 'UNSUPPORTED' }); return }
      try { reply(type, requestId, this.groupSync.handle(peerPub, payload)) } catch { reply(type, requestId, { error: 'GROUP_SYNC_FAILED' }) }
      return
    }

    if (type.startsWith('viewer_')) {
      if (VIEWER_DOWN_TYPES.has(type) && (local || this.e2ee.sessionRole(connId) === 'web')) {
        this.viewerForwarder.handle(connId, type, payload)
      }
      return
    }

    if (type.startsWith('terminal_')) {
      this.noteTerminalInputRoute(connId, type, payload, transport)
      const taken = this.terminalStreams ? await this.terminalStreams.handleFrame(connId, type, payload) : false
      // `terminal_info` (what a pane runs and where, which hn asks) is not a stream's: the streams pass
      // it over, and it is answered below. From hn's first release it stopped here unanswered
      // (e2e/compat.e2e.ts found it), and hn waited out its three seconds each time.
      if (taken || type !== 'terminal_info') return
    }

    // A request a service answers, in its own process or in this one: routed to it, or answered
    // SERVICE_UNAVAILABLE while it is off. Never waited on in line: the next frame is not held for it.
    // Who asked is established here, after the gates above, and the service trusts only that.
    const asker: Asker = { local, owner: local || this.e2ee.sessionRole(connId) === 'web' }
    if (this.serviceRouter?.(type, payload, asker, (result) => reply(type, requestId, result))) return

    try {
      switch (type) {
        case 'machine_resources':
          // Sampling CPU must not hold up typing or other machine requests.
          void (payload.harnesses === true
            ? this.harnessResourcesReader().then(async harnesses => {
              if (payload.storage !== true) return { harnesses }
              const storage = await this.harnessStorageReader(registry.advertised())
              return { harnesses: { ...harnesses, agents: harnesses.agents.map(row => ({ ...row, ...storage.get(row.agentId) })) } }
            })
            : readMachineResources())
            .then(resources => reply(type, requestId, { ...resources }))
            .catch(() => reply(type, requestId, { error: 'UNAVAILABLE' }))
          return
        case 'grid_fleet_models_list':
        case 'grid_fleet_model_download':
        case 'grid_fleet_model_start':
        case 'grid_fleet_model_stop': {
          // A daemon-owned operation survives panel closure and a lost reply.
          // Keep hardware/catalog/network reads off the ordered terminal queue.
          //
          // Grid is set up here only for an ACT: the picker's Set up (a list read carrying `setup`),
          // a Get, a Use. The list read the app polls while a picker is open never sets anything up —
          // it says whether it is needed (`gridSetupNeeded`). A Get needs a sign-in (the catalog is
          // grid's); a Use serves on the account's own grid, and so does the Set up that offers it.
          void (async () => {
            const list = type === 'grid_fleet_models_list'
            const setup = list ? payload.setup === true : type !== 'grid_fleet_model_stop'
            const notReady = setup ? await this.gridNotReady(type !== 'grid_fleet_model_download') : null
            const grid = await this.resolveGridName()
            if (list) {
              const snapshot = await this.localModels.list(grid, payload.refresh === true || setup)
              const needed = this.gridSetUp ? !this.gridSetUp() : false
              if (setup && !notReady) void this.pushGridModels()
              return { ...snapshot, ...(needed ? { gridSetupNeeded: true } : {}), ...(notReady ? { gridSetupError: notReady } : {}) }
            }
            if (notReady) return { error: notReady }
            return this.localModels.act(grid, payload.modelId, type === 'grid_fleet_model_download' ? 'download' : type === 'grid_fleet_model_start' ? 'start' : 'stop')
          })()
            .then(result => reply(type, requestId, { ...result }))
            .catch(() => reply(type, requestId, { error: 'Models are unavailable. Try again.' }))
          return
        }
        case 'grid_fleet_capabilities':
          reply(type, requestId, { protocol: GRID_FLEET_PROTOCOL, gridCli: gridCliPresence(), maxTimeoutMs: GRID_FLEET_MAX_TIMEOUT_MS, thinkingControl: true })
          return
        case 'grid_fleet_run': {
          const request = parseGridFleetRequest(payload)
          if (!request || typeof requestId !== 'string') { reply(type, requestId, { error: 'INVALID_GRID_COMMAND' }); return }
          // Detached: pulls/builds can take minutes. Keep typing, cancellation, and telemetry responsive.
          // ⚠️ Run against grid AS IT STANDS — never set up first. A Grid harness session issues these
          // on its own the moment its viewer comes up (every open one, on every daemon start), so
          // setting grid up here signed a machine in to grid right after a Harness-only sign-in,
          // with nobody asking. Grid is set up by the picker's Set up, by making or opening a Model
          // Manager, and by that harness's own `harness grid setup`; until then grid answers these in
          // its own words.
          void this.gridFleet.run(connId, requestId, request)
            .then(result => reply(type, requestId, { ...result }))
            .catch(() => reply(type, requestId, { ok: false, code: 1, error: 'Grid command failed unexpectedly.' }))
          return
        }
        case 'grid_fleet_cancel':
          reply(type, requestId, { cancelled: typeof payload.commandId === 'string' && this.gridFleet.cancel(connId, payload.commandId) })
          return
        case 'device_e2ee_pair':
          await this.e2ee.pairDeviceFromTrustedWeb(connId, payload)
          return
        case 'phone_pair':
          // CPace waits for another connection. Do not block this browser's terminal queue.
          void this.e2ee.pairPhoneFromTrustedWeb(connId, payload)
          return

        case 'e2ee_pairings_list':
          reply(type, requestId, { pairs: this.e2ee.listPaired(connId) })
          return

        case 'e2ee_pairing_unpair':
          this.e2ee.revokeFromTrustedWeb(connId, payload)
          return

        case 'e2ee_pairings_unpair_all':
          this.e2ee.revokeAllFromTrustedWeb(connId, requestId)
          return

        case 'agents_list': {
          const sessions = registry.advertised()
          const projects = await Promise.all(sessions.map((s) => this.toProject(s)))
          // Older clients/devices keep their live-only contract. The desktop picker
          // explicitly asks for stopped work and receives no stale terminal routes.
          const savedSessions = payload.includeStopped === true && this.e2ee.sessionRole(connId) !== 'device' ? stoppedAgents.available(sessions) : []
          projects.push(...await Promise.all(savedSessions.map(s => this.toStoppedProject(s))))
          // Ordered by creation time, oldest → newest — a stable tab order that doesn't reshuffle as
          // sessions become active (createdAt = the session's registeredAt). The id breaks a tie so the
          // order is TOTAL: without it two agents registered in the same millisecond fall through to array
          // position, which is Map insertion order and differs between daemon runs — the web, the app and
          // the dial would each show a different order for the same registry. `cableHost.listAgents`
          // sorts by the same rule; the two must stay identical.
          projects.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))
          if (this.e2ee.sessionRole(connId) === 'device') {
            reply(type, requestId, { agents: projects.filter(deviceAgentRow).slice(0, DEVICE_AGENT_LIST_LIMIT).map(deviceAgentListItem) })
            return
          }
          if (payload.monitor === true) {
            // Optional telemetry must never hold the ordered terminal-input queue.
            void (async () => {
              const [snapshot, storage] = await Promise.all([
                this.harnessResourcesReader().catch(() => ({ agents: [], sampledAt: null, shared: [] })),
                this.harnessStorageReader([...sessions, ...savedSessions]).catch(() => new Map()),
              ])
              const resources = new Map(snapshot.agents.map(row => [row.agentId, row]))
              const byId = new Map(sessions.map(s => [s.agentId, s]))
              reply(type, requestId, { agents: projects.map(agent => {
                const session = byId.get(agent.id)
                const activity = session ? this.monitorActivityProvider?.(session.sessionId) : null
                const reading = resources.get(agent.id)
                return { ...agent, monitor: {
                  activity: activity && activity !== 'idle' ? activity : session ? this.monitorCompletions.state(session) : 'idle',
                  activityKnown: this.monitorActivityProvider !== null,
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
            })().catch(() => reply(type, requestId, { error: 'UNAVAILABLE' }))
          } else reply(type, requestId, { agents: projects })
          return
        }

        case 'sessions_list': {
          const projectId = payload.agentId as string | undefined
          if (!projectId) { reply(type, requestId, { error: 'MISSING_AGENT_ID' }); return }
          const s = registry.resolve(projectId)
          // An agent whose engine has not reported a session yet has no transcript to list. Saying so
          // plainly beats inventing one: the web then shows the tab with an empty thread until the bind
          // lands, instead of pinning `currentSessionId` to an id no event will ever carry.
          if (!s || !s.sessionId) { reply(type, requestId, { sessions: [] }); return }
          // Counted from an index kept as the file grows (lib/transcriptPages.ts), not by reading it whole.
          const messageCount = s.transcriptPath ? await transcriptPages.lineCount(s.transcriptPath) : 0
          reply(type, requestId, {
            sessions: [{
              id: s.sessionId,
              title: projectDisplayName(s),
              timestamp: new Date(s.registeredAt).toISOString(),
              messageCount,
              lastActivity: new Date(await lastActivityAt(s)).toISOString(),
              participants: [],
            }],
          })
          return
        }

        case 'session_get': {
          const sessionId = payload.sessionId as string | undefined
          if (!sessionId) { reply(type, requestId, { error: 'MISSING_SESSION_ID' }); return }
          // Only serve transcripts for a REGISTERED tmux session, read from its own trusted
          // transcriptPath — never resolve an arbitrary request-supplied id to a file (that let a
          // caller read any *.jsonl on the computer, incl. unshared claude history / traversal).
          const s = registry.resolve(sessionId)
          if (!s) { reply(type, requestId, { error: 'NOT_FOUND' }); return }
          if (s.engine === 'devin') {
            // Devin history comes from its SQLite store (no transcript file). Same replay/window shape.
            const rawLimit = payload.limit
            const limit = typeof rawLimit === 'number' && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : undefined
            const before = typeof payload.before === 'string' ? payload.before : undefined
            const messages = await readDevinMessages(DEVIN_DB, sessionId)
            const timestamp = new Date(s.touchedAt).toISOString()
            if (!limit) {
              reply(type, requestId, { id: sessionId, title: projectDisplayName(s), events: devinMessagesToEvents(messages), timestamp, engine: s.engine })
              return
            }
            const w = windowDevinMessages(messages, { limit, before })
            if (w.staleCursor) {
              reply(type, requestId, { id: sessionId, title: projectDisplayName(s), events: [], timestamp, engine: s.engine, hasMore: false, oldestCursor: null, staleCursor: true })
              return
            }
            const events = devinMessagesToEvents(w.window)
            if (before && events[events.length - 1]?.type === 'done') events.pop()
            reply(type, requestId, { id: sessionId, title: projectDisplayName(s), events, timestamp, engine: s.engine, hasMore: w.hasMore, oldestCursor: w.oldestCursor })
            return
          }
          if (s.engine === 'hermes') {
            // Hermes history lives in its SQLite store (no transcript file). Same replay/window shape.
            const rawLimit = payload.limit
            const limit = typeof rawLimit === 'number' && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : undefined
            const before = typeof payload.before === 'string' ? payload.before : undefined
            const messages = await readHermesMessages(await hermesDbForSession(s), sessionId)
            const timestamp = new Date(s.touchedAt).toISOString()
            if (!limit) {
              reply(type, requestId, { id: sessionId, title: projectDisplayName(s), events: hermesMessagesToEvents(messages), timestamp, engine: s.engine })
              return
            }
            const w = windowHermesMessages(messages, { limit, before })
            if (w.staleCursor) {
              reply(type, requestId, { id: sessionId, title: projectDisplayName(s), events: [], timestamp, engine: s.engine, hasMore: false, oldestCursor: null, staleCursor: true })
              return
            }
            const events = hermesMessagesToEvents(w.window)
            if (before && events[events.length - 1]?.type === 'done') events.pop()
            reply(type, requestId, { id: sessionId, title: projectDisplayName(s), events, timestamp, engine: s.engine, hasMore: w.hasMore, oldestCursor: w.oldestCursor })
            return
          }
          if (s.engine === 'opencode') {
            // OpenCode history comes from its SQLite DB (no transcript file). Same replay/window shape.
            const rawLimit = payload.limit
            const limit = typeof rawLimit === 'number' && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : undefined
            const before = typeof payload.before === 'string' ? payload.before : undefined
            const messages = await readOpencodeMessages(OPENCODE_DB, sessionId)
            const timestamp = new Date(s.touchedAt).toISOString()
            if (!limit) {
              reply(type, requestId, { id: sessionId, title: projectDisplayName(s), events: opencodeMessagesToEvents(messages), timestamp, engine: s.engine })
              return
            }
            const w = windowOpencodeMessages(messages, { limit, before })
            if (w.staleCursor) {
              reply(type, requestId, { id: sessionId, title: projectDisplayName(s), events: [], timestamp, engine: s.engine, hasMore: false, oldestCursor: null, staleCursor: true })
              return
            }
            const events = opencodeMessagesToEvents(w.window)
            if (before && events[events.length - 1]?.type === 'done') events.pop()
            reply(type, requestId, { id: sessionId, title: projectDisplayName(s), events, timestamp, engine: s.engine, hasMore: w.hasMore, oldestCursor: w.oldestCursor })
            return
          }
          if (s.engine === 'kilo') {
            // Kilo history likewise comes from its SQLite DB. BOTH branches below are load-bearing: the
            // web client always sends a `limit`, so handling only the full-transcript one opens an empty
            // pane — the exact half-dispatch this file has been caught on before. Cursors are namespaced
            // `kilo:<index>` by `windowKiloMessages`, so a cursor from another engine reads as stale
            // rather than silently indexing into the wrong conversation.
            const rawLimit = payload.limit
            const limit = typeof rawLimit === 'number' && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : undefined
            const before = typeof payload.before === 'string' ? payload.before : undefined
            const messages = await readKiloMessages(KILO_DB, sessionId)
            const timestamp = new Date(s.touchedAt).toISOString()
            if (!limit) {
              reply(type, requestId, { id: sessionId, title: projectDisplayName(s), events: kiloMessagesToEvents(messages), timestamp, engine: s.engine })
              return
            }
            const w = windowKiloMessages(messages, { limit, before })
            if (w.staleCursor) {
              reply(type, requestId, { id: sessionId, title: projectDisplayName(s), events: [], timestamp, engine: s.engine, hasMore: false, oldestCursor: null, staleCursor: true })
              return
            }
            const events = kiloMessagesToEvents(w.window)
            if (before && events[events.length - 1]?.type === 'done') events.pop()
            reply(type, requestId, { id: sessionId, title: projectDisplayName(s), events, timestamp, engine: s.engine, hasMore: w.hasMore, oldestCursor: w.oldestCursor })
            return
          }
          if (!s.transcriptPath) {
            reply(type, requestId, {
              id: sessionId,
              title: projectDisplayName(s),
              events: [],
              timestamp: new Date(s.touchedAt).toISOString(),
              engine: s.engine,
              hasMore: false,
              oldestCursor: null,
            })
            return
          }
          // Optional pagination: `limit` = window size; `before` = uuid cursor (oldest line the
          // client already holds). Absent → full transcript (legacy). Clamp limit defensively.
          const rawLimit = payload.limit
          const limit = typeof rawLimit === 'number' && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : undefined
          const before = typeof payload.before === 'string' ? payload.before : undefined
          if (s.engine === 'claude' || s.engine === 'codex') {
            // Only the page asked for is read (lib/transcriptPages.ts): the whole history of a long session
            // is more memory than the daemon has. Without a limit, the newest lines that fit a page, and
            // the cursor to the rest when they do not all fit — a cursor the full-transcript reply never had.
            const opts = limit ? { limit, before } : {}
            const page = s.engine === 'codex'
              ? await transcriptPages.codex(s.transcriptPath, opts)
              : await transcriptPages.claude(s.transcriptPath, opts)
            const st = await stat(s.transcriptPath).catch(() => null)
            const timestamp = new Date(st?.mtimeMs ?? Date.now()).toISOString()
            if (page.staleCursor) {
              reply(type, requestId, { id: sessionId, title: projectDisplayName(s), events: [], timestamp, engine: s.engine, hasMore: false, oldestCursor: null, staleCursor: true })
              return
            }
            const events = s.engine === 'codex'
              ? codexMessagesToEvents(page.lines, codexSubagentResolverFor(s.codexHome))
              : messagesToEvents(page.lines)
            await enrichSubagentStats(events, s.transcriptPath)
            // Older pages must not inject a spurious end-of-transcript marker mid-scroll.
            if (limit && before && events[events.length - 1]?.type === 'done') events.pop()
            reply(type, requestId, {
              id: sessionId,
              title: projectDisplayName(s),
              events,
              timestamp,
              engine: s.engine,
              ...(limit || page.hasMore ? { hasMore: page.hasMore, oldestCursor: page.oldestCursor } : {}),
            })
            return
          }
          // Read from the end and bounded: these engines have no pages of their own yet, and one huge
          // transcript read whole would take the whole daemon down (lib/transcriptTail.ts). History past
          // the cap is not shown, and the reply says so.
          const { lines, truncated: capped } = await tailFileCapped(s.transcriptPath)
          if (capped) console.warn(`[backend] session_get ${sid(sessionId)}: the transcript is over ${WHOLE_READ_CAP_BYTES / 1024 / 1024} MB · its oldest history is not shown`)
          const truncated = capped ? { truncated: true } : {}
          const st = await stat(s.transcriptPath).catch(() => null)
          const timestamp = new Date(st?.mtimeMs ?? Date.now()).toISOString()

          if (!limit) {
            const fullEvents = s.engine === 'cursor'
                ? cursorMessagesToEvents(lines, sessionId, await loadCursorReplayTaskLinks(cursorConfigDir(), sessionId, cursorDataDir()))
                : s.engine === 'muse'
                  ? museMessagesToEvents(lines)
                  : s.engine === 'amp'
                  ? await ampHistory(sessionId, lines)
                  : s.engine === 'grok'
                    ? grokHistoryPage(lines, false).events
                  : s.engine === 'agy'
                    ? agyHistoryPage(lines, false).events
                  : s.engine === 'copilot'
                    ? copilotHistoryPage(lines, false).events
                  : s.engine === 'pi'
                  ? piMessagesToEvents(lines)
                  : s.engine === 'commandcode'
                    ? commandcodeMessagesToEvents(lines)
                    : messagesToEvents(lines)
            if (s.engine !== 'cursor' && s.engine !== 'pi' && s.engine !== 'commandcode' && s.engine !== 'muse' && s.engine !== 'amp' && s.engine !== 'grok' && s.engine !== 'agy' && s.engine !== 'copilot') await enrichSubagentStats(fullEvents, s.transcriptPath)
            reply(type, requestId, {
              id: sessionId,
              title: projectDisplayName(s),
              events: fullEvents,
              timestamp,
              engine: s.engine,
              ...truncated,
            })
            return
          }

          // Muse has no windower, so it must not fall through to the raw one: that pairs claude's
          // line-uuid cursor with claude's normalizer, and a muse transcript comes back EMPTY — the web
          // pane opened blank with no error anywhere. Until a muse window exists, answer the page with
          // the whole transcript (`hasMore: false` ends the scroll honestly, and these sessions are
          // small: a real one measured 271 lines).
          // Amp is in the same position as muse and for the same reason: no windower, so falling
          // through would pair claude's line-uuid cursor with claude's normalizer and return nothing.
          if (s.engine === 'muse' || s.engine === 'amp' || s.engine === 'grok' || s.engine === 'agy' || s.engine === 'copilot') {
            const wholePage = s.engine === 'grok'
              ? grokHistoryPage(lines, true)
              : s.engine === 'agy'
                ? agyHistoryPage(lines, true)
                : s.engine === 'copilot'
                  ? copilotHistoryPage(lines, true)
                  : null
            reply(type, requestId, {
              id: sessionId,
              title: projectDisplayName(s),
              events: s.engine === 'amp'
                ? await ampHistory(sessionId, lines)
                : wholePage
                  ? wholePage.events
                  : museMessagesToEvents(lines),
              timestamp,
              engine: s.engine,
              hasMore: wholePage?.hasMore ?? false,
              oldestCursor: wholePage?.oldestCursor ?? null,
              ...truncated,
            })
            return
          }
          const w = s.engine === 'cursor'
              ? windowCursorLines(lines, { limit, before })
              : s.engine === 'pi'
                ? windowPiLines(lines, { limit, before })
                : s.engine === 'commandcode'
                  ? windowCommandCodeLines(lines, { limit, before })
                  : windowRawLines(lines, { limit, before })
          if (w.staleCursor) {
            reply(type, requestId, { id: sessionId, title: projectDisplayName(s), events: [], timestamp, engine: s.engine, hasMore: false, oldestCursor: null, staleCursor: true, ...truncated })
            return
          }
          const events = s.engine === 'cursor'
              ? cursorMessagesToEvents(
                  w.window,
                  sessionId,
                  await loadCursorReplayTaskLinks(cursorConfigDir(), sessionId, cursorDataDir()),
                  'startIndex' in w && typeof w.startIndex === 'number' ? w.startIndex : 0,
                  'initialTodos' in w && Array.isArray(w.initialTodos) ? w.initialTodos : [],
                )
              : s.engine === 'pi'
                ? piMessagesToEvents(w.window)
                : s.engine === 'commandcode'
                  ? commandcodeMessagesToEvents(w.window)
                  : messagesToEvents(w.window)
          // muse and amp are answered above and never reach here, so both are absent by design.
          if (s.engine !== 'cursor' && s.engine !== 'pi' && s.engine !== 'commandcode') await enrichSubagentStats(events, s.transcriptPath)
          // Older pages must not inject a spurious end-of-transcript marker mid-scroll.
          if (before && events[events.length - 1]?.type === 'done') events.pop()
          reply(type, requestId, {
            id: sessionId,
            title: projectDisplayName(s),
            events,
            timestamp,
            engine: s.engine,
            hasMore: w.hasMore,
            oldestCursor: w.oldestCursor,
            ...truncated,
          })
          return
        }

        case 'grid_models_list': {
          // Every grid this computer is signed into, in sections, the account's own first. `gridName`
          // and `models` keep naming the own grid alone, for an app that predates `grids`.
          //
          // DETACHED from this connection's ordered RPC chain, like `engines_probe`: it waits on a
          // grid reconcile (up to 6s), then a `grid ls` spawn and — for a grid this daemon has never
          // read — up to 4s of its first read (`gridModels.ts`); every other grid answers from its picture.
          // The desktop asks for it in the same breath as `terminal_capabilities` and `agents_list`
          // on every connect, and awaited here it held both behind it — with no network, past the
          // app's 10s request timeout, on which the app forces a reconnect and asks all three again.
          // Measured 2026-09-18, wifi off, daemon restarted: every local RPC timed out for as long
          // as the backend stayed unreachable; the terminal on the SAME computer sat on "offline"
          // until the wifi came back. Request ids make the reply safe to land out of order.
          //
          // One computation at a time: detached, a second ask that lands while the first is still
          // out (the app re-asks on every connect) would spawn another `grid ls` for the same answer.
          // Later askers share the one in flight; each grid's reads are single-flight in the service.
          //
          // `rowState: true` — a window that draws row state gets offline labels as `unavailable` (and
          // its pushes in that form); `wake: [name]` — a person pressed "Show models" / "Wake now", and
          // the answer (with those sections "waking") comes back at once while the wake runs behind it
          // (grid-reads-without-waking issue 03). A wake never joins a listing already out: that one
          // was built before the wake began, and would not say "waking".
          const rowState = payload.rowState === true
          if (rowState && this.localClients.has(connId)) this.rowStateWindows.add(connId)
          const wake = Array.isArray(payload.wake)
            ? payload.wake.filter((name): name is string => typeof name === 'string' && !!name.trim()).map((name) => name.trim()).slice(0, MAX_WAKES_PER_ASK)
            : []
          void (async () => {
            const gridName = await this.resolveGridName()
            const inFlight = this.gridModelsInFlight
            const listing = wake.length
              ? listAllGridModels(gridName, { wake })
              : inFlight && inFlight.gridName === gridName
                ? inFlight.grids
                : (this.gridModelsInFlight = {
                    gridName,
                    grids: listAllGridModels(gridName).finally(() => {
                      if (this.gridModelsInFlight?.gridName === gridName) this.gridModelsInFlight = null
                    }),
                  }).grids
            reply(type, requestId, gridModelsPayload(gridName, await listing, rowState))
          })().catch(() => reply(type, requestId, { error: 'GRID_MODELS_FAILED' }))
          return
        }


        case 'models_list': {
          const sessionId = typeof payload.agentId === 'string' && payload.agentId
            ? payload.agentId
            : undefined
          const models = this.runtimeModelsProvider
            ? await this.runtimeModelsProvider(sessionId)
            : [{ id: 'default', displayName: 'Remote CLI default' }]
          reply(type, requestId, {
            // The device derives labels from the opaque runtime-v1 id. Omitting the duplicate
            // displayName keeps the encrypted picker response below its 16 KiB decrypt cap.
            models: payload.compact === true
              ? compactRuntimePickerModels(models, sessionId, payload.pickerMode, payload.selectedModel)
              : models,
          })
          return
        }

        case 'remote_terminal_handoff': {
          // `harness remote`, typed INSIDE one of this machine's terminal tiles, opened a terminal on
          // another machine and asks the window showing the tile to swap it over: the tile it was
          // typed in (named by its tmux pane, the one fact the shell has about itself) becomes the new
          // agent's, and the old shell is ended by the window. Asked over loopback only (the command
          // runs on this machine), but PUSHED to every audience: the window showing a tile of this
          // machine may be on another computer, reached through the relay — nothing in the payload
          // but ids, so it travels plain like dsh_install_status.
          if (!this.localClients.has(connId)) { reply(type, requestId, { error: 'UNSUPPORTED' }); return }
          const handoff = terminalHandoffRequest(payload)
          if (!handoff) { reply(type, requestId, { error: 'INVALID_HANDOFF', detail: 'remote_terminal_handoff needs tmuxPane (%N), machineId and agentId' }); return }
          const fromAgentId = this.onTerminalHandoff?.(handoff.tmuxPane) ?? null
          if (!fromAgentId) { reply(type, requestId, { error: 'NOT_A_HARNESS_PANE', detail: `${handoff.tmuxPane} is not a Harness terminal on this machine` }); return }
          // Who could hear it: other loopback clients (a window on this computer) and the web audience
          // (a window elsewhere, relayed). None means nobody is here to swap the tile.
          const windows = [...this.localClients.keys()].filter((id) => id !== connId).length + this.commanderCount
          this.send({ type: 'remote_terminal_handoff', payload: { fromAgentId, machineId: handoff.machineId, agentId: handoff.agentId } })
          reply(type, requestId, { ok: true, fromAgentId, windows })
          return
        }

        case 'engines_probe': {
          // Which engines this machine has, asked BEFORE a create rather than discovered by one
          // failing. Answered here — on the machine in question — because a Mac and the Docker rig
          // routinely hold different engines, and an availability list computed anywhere else is
          // wrong for exactly the remote case this request exists to serve.
          //
          // `engines` narrows the probe to what the caller is showing; an absent or malformed list
          // means "all of them", so an older app that sends nothing still gets a usable answer.
          const asked = Array.isArray(payload.engines)
            ? payload.engines.filter((id): id is AgentEngine =>
              typeof id === 'string' && (ENGINES as readonly string[]).includes(id))
            : undefined
          // A full probe starts interactive login shells and is intentionally detached from this
          // connection's ordered RPC chain. Request ids make its eventual reply safe to deliver out
          // of order; keeping it awaited here made a Create click sit behind an unrelated sweep.
          void this.engineProbeProvider(asked && asked.length > 0 ? asked : undefined)
            .then((availability) => reply(type, requestId, {
              engines: availability.map((entry) => ({
                engine: entry.engine,
                installed: entry.installed,
                command: entry.command,
                installable: entry.installable,
                installCommand: entry.installable ? engineInstallRecipe(entry.engine)?.command ?? null : null,
                // Static per-CLI-version capability, not a probe result: its mere presence is what
                // lets an older CLI (which never sends the field) keep reading as "unknown" rather
                // than "no", per the desktop app's `EngineAvailability.fromJson`.
                ...(entry.engine === 'codex' ? { supportsCodexHome: true } : {}),
              })),
            }))
            .catch(() => reply(type, requestId, { error: 'ENGINE_PROBE_FAILED' }))
          return
        }

        case 'agent_recent': {
          // Device tile restore at boot: the session's persisted LLM turn-summary (recap + body),
          // mirroring the hosted runtime’s SessionService.getRecentEvents. Empty until a turn was summarized
          // (device-gated) — never a resurrected full-text card.
          const projectId = payload.agentId as string | undefined
          if (!projectId) { reply(type, requestId, { error: 'MISSING_AGENT_ID' }); return }
          const n = Math.max(1, Math.min(5, Number(payload.n) || 2))
          const events = this.recentProvider ? this.recentProvider(projectId, n) : []
          // ASKS TRAVEL AS THEIR OWN LIST, beside the events rather than inside them. A question exists
          // the moment it is asked; a recap exists once the turn has been answered and summarised. They
          // are different lengths on any machine where a turn ended without one, so a reply that folds
          // the questions into the event rows loses exactly the newest ones — and a REMOTE agent then
          // reaches the router with nothing but its name.
          const asks = this.recentAsksProvider ? this.recentAsksProvider(projectId, n) : []
          reply(type, requestId, { agentId: projectId, events, asks })
          return
        }

        case 'agent_handoff_prepare': {
          // "Change agent": before the engine is swapped, write what the old one did into the project
          // (`.harness/handoff/`) so the new one can read it. It writes into the user's folder and runs
          // git there, so only the owner may ask: the loopback window, or a sealed `web` session. A
          // `device` (the dial) and a shared viewer never do.
          if (!local && this.e2ee.sessionRole(connId) !== 'web') { reply(type, requestId, { error: 'OWNER_REQUIRED' }); return }
          const agentId = payload.agentId
          if (typeof agentId !== 'string' || agentId.length === 0 || agentId.length > 200) { reply(type, requestId, { error: 'MISSING_AGENT_ID' }); return }
          const changeId = payload.changeId
          if (typeof changeId !== 'string' || !/^[0-9a-f]{32}$/.test(changeId)) { reply(type, requestId, { error: 'BAD_CHANGE_ID' }); return }
          const targetEngine = payload.targetEngine
          if (typeof targetEngine !== 'string' || !(ENGINES as readonly string[]).includes(targetEngine)) { reply(type, requestId, { error: 'BAD_ENGINE' }); return }
          const provider = this.handoffProvider
          if (!provider) { reply(type, requestId, { error: 'UNSUPPORTED' }); return }
          // DETACHED from this connection's ordered RPC chain, like `engines_probe`: it reads a whole
          // session and runs git, and a window's next request must not queue behind it. The reply names
          // fixed fields only; whatever else the provider returned stays here.
          // Called inside the executor so a provider that throws before returning its promise lands in
          // the same catch (and the same message-free log) as one that rejects.
          void new Promise<Awaited<ReturnType<typeof provider>>>((resolve) => resolve(provider({ agentId, changeId, targetEngine })))
            .then((r) => reply(type, requestId, { agentId, file: r.file, gitRepo: r.gitRepo, cwd: r.cwd, degraded: r.degraded }))
            .catch((e: unknown) => {
              // Only a HandoffError's code goes on the wire, and only code-shaped: the reply never carries
              // a message or anything else the provider put in it.
              const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined
              const known = (e as { name?: unknown } | null)?.name === 'HandoffError' && typeof code === 'string' && /^[A-Z][A-Z_]{0,39}$/.test(code)
              // Name and errno code only: a message can quote the project path or, from a parser, a
              // slice of the transcript it choked on.
              if (!known) console.error(`[handoff] prepare failed: ${e instanceof Error ? e.name : typeof e}${typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? ` ${code}` : ''}`)
              reply(type, requestId, { error: known ? code : 'INTERNAL' })
            })
          return
        }

        case 'voice_route': {
          // Voice router (REMOTE machine): pick the best-fit agent for a transcribed Overview voice task,
          // using each agent's name + recent-turn recap. Once asked plaintext by the backend's legacy
          // device-ws voice path; that path no longer reaches a harness machine, and the relay gate now
          // refuses it unsealed like any other RPC.
          const transcript = typeof payload.transcript === 'string' ? payload.transcript : ''
          if (!transcript.trim()) {
            console.log('[voice-route] backend sent an empty transcript — nothing to route')
            reply(type, requestId, { error: 'MISSING_TRANSCRIPT' })
            return
          }
          const projects = (await Promise.all(registry.advertised().map((s) => this.toProject(s)))).slice(0, 24) // cap the router prompt (mirror the hosted runtime path)
          const agents = projects.map((p) => {
            // Use the last 3 turns' recaps (not just 1) — a single turn can misrepresent what the agent is
            // actually working on; 3 gives the router a more stable picture.
            const recents = this.recentProvider?.(p.id, 3) ?? []
            const recentSummary = recents.map((r) => r?.recap || r?.text || '').filter(Boolean).join(' · ')
            // engine: the router classifies with a CLI the machine actually runs (a live agent proves it is
            // installed and logged in), so it has to travel with the agent.
            const session = registry.resolve(p.id)
            return { id: p.id, name: p.name, recentSummary, engine: session?.engine, gateway: session?.gateway }
          })
          const decision = await routeVoiceTask(transcript, agents)   // logs the task, candidates and pick
          const chosen = projects.find((p) => p.id === decision.agentId)
          reply(type, requestId, { ...decision, agentName: chosen?.name ?? '' })
          return
        }

        case 'agent_update': {
          const projectId = payload.agentId as string | undefined
          if (!projectId) { reply(type, requestId, { error: 'MISSING_AGENT_ID' }); return }
          const hasName = Object.prototype.hasOwnProperty.call(payload, 'name')
          const hasProfile = Object.prototype.hasOwnProperty.call(payload, 'selectedModel')
          // An app OPENED this agent — see RegisteredSession.lastOpenedAt. Only a literal `true`: a
          // client that means "opened" says so, and anything else is not an update at all. A client
          // reaching this handler is already one that may change the agent — a shared harness's
          // observer never gets here (sharing/owner.ts answers everything but terminal frames with
          // VIEW_ONLY) — so an open is taken from the local window, a paired web/phone session and a
          // remote desktop relayed through its own daemon alike.
          const hasOpened = payload.opened === true
          // An older client, and a request carrying none of the three, still get MISSING_UPDATE — which
          // is also what a client learns from a daemon that predates `opened`.
          if (!hasName && !hasProfile && !hasOpened) { reply(type, requestId, { error: 'MISSING_UPDATE' }); return }
          const name = typeof payload.name === 'string' ? payload.name.trim() : ''
          if (hasName && !name) { reply(type, requestId, { error: 'MISSING_NAME' }); return }
          let s = registry.resolve(projectId)
          if (!s) { reply(type, requestId, { error: 'AGENT_NOT_FOUND' }); return }
          if (hasProfile) {
            if (typeof payload.selectedModel !== 'string' || !this.onRuntimeProfileUpdate) {
              reply(type, requestId, { error: 'INVALID_RUNTIME_PROFILE' })
              return
            }
            try {
              await this.onRuntimeProfileUpdate(projectId, payload.selectedModel)
            } catch (error) {
              const code: RuntimeProfileErrorCode | 'INTERNAL' = error instanceof RuntimeProfileControlError ? error.code : 'INTERNAL'
              reply(type, requestId, { error: code })
              return
            }
          }
          if (hasName) {
            s = registry.rename(projectId, name) ?? s
            this.onAgentRename?.(s, name)
          }
          // Throttled on the stamp the row already carries, so a repeat inside the window is answered
          // with the current frame but moves nothing and tells no one. A stamp from the future (the
          // clock was set back) never throttles: the next open corrects it.
          let opened = false
          if (hasOpened) {
            this.closeAgentService?.cancel(s.agentId)
            const since = Date.now() - (s.lastOpenedAt ?? 0)
            if (!s.lastOpenedAt || since < 0 || since >= AGENT_OPENED_THROTTLE_MS) {
              s = registry.markOpened(s.agentId) ?? s
              opened = true
            }
          }
          const agent = await this.toProject(s)
          reply(type, requestId, { agent })
          // Every app sorts by the same stamp, so every app hears it: the web audience — the phone,
          // other desktops, and this computer's own windows — through `send`. Not the device: the dial
          // lists agents in creation order and has nothing to reorder. Not for an agent whose terminal
          // this daemon cannot see either, the rule `syncSession` (cli.ts) keeps: that row is not in
          // `agents_list`, and a push would put it back on every screen.
          if (opened && registry.terminalAvailable(s.agentId)) {
            this.send({ type: 'agent_synced', payload: { agent } })
          }
          if (hasName) {
            const renamed = { type: 'agent_renamed', payload: { agentId: s.agentId, name, engine: s.engine } }
            this.send(renamed)          // every OTHER web client on this machine (group-encrypted)
            this.sendCommander(renamed) // and the device
            // The whole rename path was silent end to end, which is why "web1 renamed it, web2 never saw
            // it" had no evidence to work from: nothing said whether the request even arrived. One line
            // here splits the question in two — no line means it never reached the adapter, a line means
            // the fan-out is downstream.
            console.log(`[rename] ${sid(projectId)} → "${preview(name, 40)}" · broadcast to web + device`)
          }
          return
        }

        case 'agent_create_status': {
          const creationId = payload.creationId
          if (!validCreationId(creationId)) { reply(type, requestId, { error: 'INVALID_CREATION_ID' }); return }
          try {
            reply(type, requestId, { creationId, ...await this.creationStatusPayload(this.agentCreations.status(creationId)) })
          } catch (error) {
            reply(type, requestId, { error: error instanceof AgentCreationReceiptError ? error.code : 'INTERNAL' })
          }
          return
        }

        case 'agent_create': {
          const engine = payload.engine as AgentEngine | undefined
          const cwd = payload.cwd
          if (typeof engine !== 'string' || !ENGINES.includes(engine)) { reply(type, requestId, { error: 'INVALID_ENGINE' }); return }
          let projectFolder
          try { projectFolder = parseProjectFolder(payload) }
          catch (error) {
            reply(type, requestId, error instanceof ProjectFolderError
              ? { error: error.code, detail: error.message }
              : { error: 'INVALID_PROJECT_SOURCE' }); return
          }
          // A terminal opens where a terminal app would — the home directory — when the client names
          // no folder; every other engine works IN a folder and must be told which.
          const terminal = isTerminalEngine(engine)
          if (terminal && projectFolder) { reply(type, requestId, { error: 'INVALID_PROJECT_SOURCE', detail: 'a terminal opens in a folder, it does not prepare one' }); return }
          if (!projectFolder && !(terminal && cwd === undefined) && (typeof cwd !== 'string' || !isAbsolute(cwd))) { reply(type, requestId, { error: 'INVALID_CWD' }); return }
          if (!this.onCreateAgent) { reply(type, requestId, { error: 'UNSUPPORTED_ON_REMOTE' }); return }
          const creationId = payload.creationId
          if (creationId !== undefined && !validCreationId(creationId)) {
            reply(type, requestId, { error: 'INVALID_CREATION_ID' }); return
          }
          if (projectFolder && (!validCreationId(creationId) || cwd !== undefined)) {
            reply(type, requestId, { error: 'INVALID_PROJECT_SOURCE' }); return
          }
          // Absent is the ordinary case and stays indistinguishable from a client that predates grids;
          // present-but-malformed is refused here rather than half-applied at launch, because an agent
          // that quietly ran on the engine's own login would look like it worked.
          const model = parseNewAgentModel(engine, payload)
          if (model.state === 'invalid') { reply(type, requestId, { error: 'INVALID_GRID', detail: model.detail }); return }
          const grid = parseGridLaunchOverride(payload.grid)
          if (grid.state === 'invalid') { reply(type, requestId, { error: 'INVALID_GRID', detail: grid.reason }); return }
          if (terminal && grid.state === 'ok') { reply(type, requestId, { error: 'INVALID_GRID', detail: 'a terminal has no engine to point at a grid' }); return }
          // Same validation the desktop app already applies client-side (`Agent._safeCodexHome`) —
          // repeated here because a client's own check is not a guarantee about what actually
          // arrives on the wire.
          const rawCodexHome = typeof payload.codexHome === 'string' ? payload.codexHome : null
          const codexHome = rawCodexHome && rawCodexHome.startsWith('/') && rawCodexHome.length <= 4096
            && !/[\x00-\x1f\x7f]/.test(rawCodexHome)
            ? rawCodexHome
            : null
          if (codexHome && (engine !== 'codex' || grid.state === 'ok')) {
            reply(type, requestId, { error: 'INVALID_CODEX_HOME', detail: 'codexHome is only valid for codex, without a grid' })
            return
          }
          // A DSH is refused, never approximated: an agent created as its plain base engine would look
          // like it worked and have none of the skills the user picked the tile for.
          let dsh: string | null = null
          if (payload.dsh !== undefined && payload.dsh !== null) {
            if (typeof payload.dsh !== 'string' || !DSH_ID_RE.test(payload.dsh)) {
              reply(type, requestId, { error: 'INVALID_DSH', detail: 'dsh must be an owner/name id' }); return
            }
            const installed = installedDsh(payload.dsh)
            if (!installed) {
              reply(type, requestId, { error: 'INVALID_DSH', detail: `${payload.dsh} is not installed on this machine` }); return
            }
            if (installed.manifest.kind === 'viewer') {
              reply(type, requestId, { error: 'INVALID_DSH', detail: `${payload.dsh} is a viewer package, not an agent` }); return
            }
            if (!dshSupportedEngines(installed.manifest).includes(engine)) {
              reply(type, requestId, { error: 'INVALID_DSH', detail: `${payload.dsh} supports ${dshSupportedEngines(installed.manifest).join(', ')}; ${engine} is not compatible` }); return
            }
            dsh = installed.id
          }
          // A first prompt is refused BEFORE any pane exists: an engine with no way to take one would
          // otherwise open on an empty input and look like the person's request had been heard. The
          // length bound is a first message's, not a document's. The text itself is never logged.
          let prompt: string | null = null
          if (payload.prompt !== undefined && payload.prompt !== null) {
            if (typeof payload.prompt !== 'string') { reply(type, requestId, { error: 'INVALID_PROMPT', detail: 'prompt must be a string' }); return }
            const trimmed = payload.prompt.trim()
            if (trimmed.length > MAX_FIRST_PROMPT_CHARS) {
              reply(type, requestId, { error: 'PROMPT_TOO_LONG', detail: `prompt is longer than ${MAX_FIRST_PROMPT_CHARS} characters` }); return
            }
            if (trimmed && !supportsFirstPrompt(engine)) {
              reply(type, requestId, { error: 'PROMPT_UNSUPPORTED', detail: new FirstPromptUnsupportedError(engine).message }); return
            }
            prompt = trimmed || null
          }
          // Blank is "number it", the same as absent — a client that sends an empty field is not
          // asking for an agent with no name.
          const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : null
          // The engine's named agent is refused BEFORE any pane exists, like the prompt: an engine with
          // no way to open as one would otherwise come up as a general session under that agent's
          // name. The shape is an identifier the engine looks a file up by — never a path.
          let agent: string | null = null
          if (payload.agent !== undefined && payload.agent !== null) {
            if (typeof payload.agent !== 'string' || !AGENT_NAME_RE.test(payload.agent)) {
              reply(type, requestId, { error: 'INVALID_AGENT', detail: 'agent must be 1-64 letters, digits, `-` or `_`' }); return
            }
            // OpenCode v2 counts as no way: its TUI exits 1 on `--agent` (engineLaunch.ts).
            if (!supportsNamedAgent(engine, engine === 'opencode' ? opencodeMajorVersion() : null)) {
              reply(type, requestId, { error: 'AGENT_UNSUPPORTED', detail: new NamedAgentUnsupportedError(engine).message }); return
            }
            agent = payload.agent
          }
          // A permission mode picked in New Harness. A client that predates the choice sends only
          // `bypassPermission`; one that sends a mode this engine does not have is refused rather than
          // quietly launched in some other mode.
          let permissionMode: string | null = null
          if (payload.permissionMode !== undefined && payload.permissionMode !== null) {
            if (typeof payload.permissionMode !== 'string' || !permissionModeFlags(engine, payload.permissionMode)) {
              reply(type, requestId, { error: 'INVALID_PERMISSION_MODE', detail: `${engine} has no permission mode ${JSON.stringify(payload.permissionMode)}` }); return
            }
            permissionMode = payload.permissionMode
          }
          // Opening a conversation Harness did not start: the engine resumes it, as it was. Nothing a new
          // conversation is created with applies to it.
          let resumeSessionId: string | null = null
          if (payload.resumeSessionId !== undefined && payload.resumeSessionId !== null) {
            // Engines' ids: uuids, `ses_…` (OpenCode, Kilo), `20260927_101500_ab12cd` (Hermes), slugs
            // (Devin), Pi's custom ids with dots. One word, never a path.
            if (typeof payload.resumeSessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/.test(payload.resumeSessionId)) {
              reply(type, requestId, { error: 'INVALID_SESSION', detail: 'resumeSessionId must be a session id' }); return
            }
            if (terminal || projectFolder || grid.state === 'ok' || model.state === 'ok' || dsh || prompt || agent) {
              reply(type, requestId, { error: 'INVALID_SESSION', detail: 'a resumed conversation takes no new folder, grid, harness, prompt or agent' }); return
            }
            resumeSessionId = payload.resumeSessionId
          }
          let takeOver: 'idle' | 'now' | 'wait' | null = null
          if (payload.takeOver !== undefined && payload.takeOver !== null) {
            if (!resumeSessionId || (payload.takeOver !== 'idle' && payload.takeOver !== 'now' && payload.takeOver !== 'wait')) {
              reply(type, requestId, { error: 'INVALID_SESSION', detail: 'takeOver is idle, now or wait, with a resumeSessionId' }); return
            }
            takeOver = payload.takeOver
          }
          const input = {
            engine,
            cwd: typeof cwd === 'string' ? cwd : terminal ? homedir() : '',
            // On unless a client says otherwise: a harness works without stopping to ask for each command.
            bypassPermission: permissionMode ? permissionModeApproves(permissionMode) : payload.bypassPermission !== false,
            permissionMode,
            grid: grid.state === 'ok' ? grid.override : null,
            codexHome,
            dsh,
            prompt,
            name,
            agent,
            resumeSessionId,
            takeOver,
          }
          const fingerprintInput = model.state === 'ok' ? { ...input, modelSelection: model.selection } : input
          if (creationId !== undefined) {
            // Reserve before spawning. A transport retry carries the SAME creationId; a deliberate
            // New agent action carries a new one. Detach so a status check can pass a slow create
            // on this connection, just as engines_probe is detached above.
            const create = this.onCreateAgent
            try {
              void this.agentCreations.run(creationId, creationFingerprint(projectFolder ? { ...fingerprintInput, projectFolder } : fingerprintInput), async () => {
                if (model.state === 'ok') {
                  const target = await resolveNewAgentModel(model.selection).catch(() => null)
                  if (!target) return { state: 'failed', error: 'GRID_UNAVAILABLE', detail: 'The selected model is unavailable. Choose another model or refresh the list.' }
                  input.grid = target
                }
                let preparedFolder: string | undefined
                if (projectFolder) {
                  try { preparedFolder = await prepareProjectFolder(projectFolder, { label: (dsh ? installedDsh(dsh)?.manifest.name : null) ?? engineLabel(input.engine) }) }
                  catch (error) {
                    return { state: 'failed', error: error instanceof ProjectFolderError ? error.code : 'PROJECT_PREPARATION_FAILED',
                      detail: error instanceof ProjectFolderError ? error.message : 'Could not prepare the project folder.' }
                  }
                  // Only a folder this daemon just made EMPTY is one the engine need not ask about. A clone or
                  // the person's own repo is theirs to answer for (lib/claudeTrust.ts); a worktree gets only
                  // the answer its source repo already has. `branch` IS the source folder: nothing to record.
                  try {
                    const engineTrust = input.engine === 'claude' ? { trusts: claudeTrusts, record: preTrustClaudeProject }
                      : input.engine === 'codex' ? { trusts: codexTrusts, record: preTrustCodexProject } : null
                    if (engineTrust && (projectFolder.source === 'new'
                      || (projectFolder.source === 'worktree' && engineTrust.trusts(projectFolder.gitSource)))) {
                      engineTrust.record(preparedFolder)
                    }
                  } catch (error) { console.warn(`[agent] pre-trust ${preparedFolder} · ${error instanceof Error ? error.message : error}`) }
                } else if (!dsh && local && dirname(input.cwd) === projectsRoot()) {
                  // On the LOCAL machine the desktop makes a new workspace ITSELF and sends the path as a plain
                  // cwd, so `projectFolder` above never sees it. Such a folder is empty and is trusted the way a
                  // `new` project is — but only on evidence, and only where those workspaces live:
                  //
                  //   · directly inside the projects root, which is the one folder the app and this daemon
                  //     create workspaces in. Trust INHERITS downward (claudeTrusts), so recording it for a
                  //     folder the person merely browsed to — an empty `~/code`, or a home with nothing in it —
                  //     would silently cover every repo cloned under it later: OH-14 again by another door.
                  //   · empty as read from disk, never on the client's word. A clone, a worktree or the
                  //     person's own repo has content, so it stays the engine's question (lib/claudeTrust.ts).
                  //   · from a LOCAL frame. agent_create is not backend-only, so a relayed peer would otherwise
                  //     name an empty path on this host and have it trusted.
                  //
                  // DSH trust is decided in cli.ts, where the template count is known; leave that to it.
                  try {
                    const empty = await readdir(input.cwd).then((names) => names.length === 0, () => false)
                    if (empty) {
                      if (input.engine === 'claude') preTrustClaudeProject(input.cwd)
                      if (input.engine === 'codex') preTrustCodexProject(input.cwd)
                    }
                  } catch (error) { console.warn(`[agent] pre-trust ${input.cwd} · ${error instanceof Error ? error.message : error}`) }
                }
                const result = await create(preparedFolder ? { ...input, cwd: preparedFolder } : input)
                if (result.ok) return { state: 'created', agentId: result.session.agentId }
                // tmux may have executed before a timeout; registration cleanup is best-effort.
                // Neither can prove that no process started, so never encourage another launch.
                if (result.error === 'SPAWN_FAILED' || result.error === 'REGISTRATION_FAILED') return { state: 'unconfirmed' }
                return { state: 'failed', error: result.error, ...(preparedFolder ? { preparedFolder } : {}), ...(result.detail ? { detail: result.detail.slice(0, 2000) } : {}) }
              }).then(async (status) => {
                reply(type, requestId, { creationId, ...await this.creationStatusPayload(status) })
              }).catch(() => reply(type, requestId, { error: 'INTERNAL' }))
            } catch (error) {
              reply(type, requestId, { error: error instanceof AgentCreationReceiptError ? error.code : 'INTERNAL' })
            }
            return
          }
          // Clients predating receipts retain their existing response shape.
          if (model.state === 'ok') {
            const target = await resolveNewAgentModel(model.selection).catch(() => null)
            if (!target) { reply(type, requestId, { error: 'GRID_UNAVAILABLE', detail: 'The selected model is unavailable. Choose another model or refresh the list.' }); return }
            input.grid = target
          }
          const result = await this.onCreateAgent(input)
          // `detail` carries the underlying cause (tmux's own message) so the person who clicked
          // Create can read it, rather than having to open a log on the machine that failed.
          if (!result.ok) {
            reply(type, requestId, result.detail ? { error: result.error, detail: result.detail } : { error: result.error })
            return
          }
          reply(type, requestId, { agent: await this.toProject(result.session) })
          return
        }

        // Move a RUNNING agent onto a grid. The pane survives; its process is re-exec'd with the
        // engine's grid environment and, when one is bound, `--resume <session>` so the conversation
        // comes back. Refused rather than half-applied: see cli.ts for what it checks first.
        case 'agent_retarget': {
          const agentId = (payload.agentId as string | undefined) || (payload.sessionId as string | undefined)
          if (!agentId) { reply(type, requestId, { error: 'MISSING_AGENT_ID' }); return }
          if (!this.onRetargetAgent) { reply(type, requestId, { error: 'UNSUPPORTED_ON_REMOTE' }); return }
          const clear = payload.clearGrid === true
          // `gridModel` is the header picker's frame: a model id and nothing else. The endpoint and
          // the credential are resolved HERE, from this machine's own signed-in `grid`, so neither
          // ever crosses the relay and the app cannot be the source of truth for an address it does
          // not know. A client that sends the full `grid` object still works unchanged.
          const picked = typeof payload.gridModel === 'string' ? payload.gridModel : ''
          // `apiConnection` + `apiModel`: a model of an API saved on this machine. Same rule as a grid
          // model — the app names it, and the endpoint and key are read here, from the store — and
          // only for whoever may manage those APIs (`api_connections`): this machine's own app, or
          // its owner's paired session. The key itself never leaves this daemon either way.
          const api = typeof payload.apiConnection === 'string' ? payload.apiConnection : ''
          if (api && (picked || payload.grid !== undefined || clear)) {
            reply(type, requestId, { error: 'INVALID_GRID', detail: 'Choose an API model, a grid model or the own login, not several.' })
            return
          }
          if (api) {
            if (!local && this.e2ee.sessionRole(connId) !== 'web') { reply(type, requestId, { error: 'OWNER_REQUIRED' }); return }
            try {
              payload.grid = await resolveApiTarget(this.apiConnections, api, typeof payload.apiModel === 'string' ? payload.apiModel.trim() : '')
            } catch (error) {
              reply(type, requestId, {
                error: 'API_UNAVAILABLE',
                detail: error instanceof ApiConnectionError ? error.message : 'This API could not be used. Try again.',
              })
              return
            }
          }
          if (picked && payload.grid === undefined && !clear) {
            // The grid the model was picked FROM, when the picker says (a shared grid's section);
            // the account's own grid otherwise, as before.
            // A move onto a grid model is a grid feature in use: grid is signed in first, if it is not
            // yet — and the account's own grid made sure of when that is where the model is.
            const named = typeof payload.gridName === 'string' && payload.gridName.trim() ? payload.gridName.trim() : null
            const notReady = await this.gridNotReady(!named || named === this.harnessGridName)
            if (notReady) {
              reply(type, requestId, { error: 'GRID_UNAVAILABLE', detail: notReady })
              return
            }
            const pickedGrid = named ?? await this.resolveGridName()
            const resolved = await resolveGridTarget(pickedGrid, picked)
            if (!resolved) {
              reply(type, requestId, { error: 'GRID_UNAVAILABLE', detail: 'Could not read this machine\'s grid endpoint.' })
              return
            }
            payload.grid = resolved
          }
          const target = parseGridLaunchOverride(payload.grid)
          // Exactly one, and `clearGrid` is a separate field rather than `grid: null` on purpose:
          // parseGridLaunchOverride already answers `absent` for both undefined and null, so
          // overloading null would make "I forgot the field" and "I mean own login" the same frame.
          if (clear && target.state !== 'absent') {
            reply(type, requestId, { error: 'INVALID_GRID', detail: 'clearGrid and grid are mutually exclusive' })
            return
          }
          if (!clear && target.state !== 'ok') {
            reply(type, requestId, {
              error: 'INVALID_GRID',
              detail: target.state === 'invalid' ? target.reason : 'grid is required',
            })
            return
          }
          const override = target.state === 'ok' ? target.override : null
          const moved = await this.onRetargetAgent({ agentId, grid: override })
          if (!moved.ok) {
            reply(type, requestId, moved.detail ? { error: moved.error, detail: moved.detail } : { error: moved.error })
            return
          }
          reply(type, requestId, { retargeted: true })
          // The agent is on a grid model now and its pane is restarting: start that grid meanwhile if it
          // sleeps, so the first message rarely waits on a boot (issue 03). Detached — the move is done
          // and answered — and it decides for itself whether a wake is worth it.
          // An API has no sleep to wake it from, and is not a grid to look up.
          if (override && !isApiLaunch(override)) void retargetPrewarm(override).catch(() => {})
          return
        }

        // Delete an agent: signal its validated engine process and drop it from the list. Idempotent — an already
        // gone target still acks + re-emits agent_deleted so the web/device converge. E2EE-gated (the
        // frame arrived decrypted). Keeps the persisted recap + agent name for a later resume.
        case 'agents_cleanup_preview': {
          if (!this.cleanupPreview) { reply(type, requestId, { error: 'UNSUPPORTED' }); return }
          void this.cleanupPreview().then(result => reply(type, requestId, result), error => reply(type, requestId, {
            error: error?.code ?? 'TABS_UNAVAILABLE', detail: error instanceof Error ? error.message : 'Could not check open tabs.',
          }))
          return
        }
        case 'agent_close': {
          if (!this.closeAgentService) { reply(type, requestId, { error: 'UNSUPPORTED' }); return }
          const { agentId, sessionId, createdAt, mode } = payload
          if (typeof agentId !== 'string' || typeof sessionId !== 'string' || typeof createdAt !== 'string'
            || typeof mode !== 'string' || !['inspect', 'idle', 'now', 'after_task', 'cancel'].includes(mode)) {
            reply(type, requestId, { error: 'INVALID_CLOSE_REQUEST' }); return
          }
          // Saving/exit may take seconds; terminal input and unrelated agents keep flowing.
          void this.closeAgentService.request({ agentId, sessionId, createdAt, mode: mode as CloseMode,
            ...(payload.onlyIfHidden === true ? { onlyIfHidden: true } : {}) })
            .then(result => reply(type, requestId, result), () => reply(type, requestId, { error: 'CLOSE_FAILED' }))
          return
        }
        case 'agent_worktree_delete':
        case 'agent_purge': {
          if (!local && this.e2ee.sessionRole(connId) !== 'web') { reply(type, requestId, { error: 'OWNER_REQUIRED' }); return }
          if (!this.purgeAgentService) { reply(type, requestId, { error: 'UNSUPPORTED' }); return }
          const { agentId, sessionId, createdAt, mode, reviewId, path, discardChanges, choices, includeWorktree } = payload
          const selected = choices && typeof choices === 'object' ? choices as Record<string, unknown> : null
          if (typeof agentId !== 'string' || !(sessionId === null || typeof sessionId === 'string')
            || typeof createdAt !== 'number' || !Number.isFinite(createdAt)
            || (mode !== 'inspect' && mode !== 'delete' && !(type === 'agent_worktree_delete' && mode === 'describe'))
            || (mode === 'delete' && typeof reviewId !== 'string')
            || (choices !== undefined && (!selected
              || typeof selected.sessionData !== 'boolean' || typeof selected.worktreeData !== 'boolean'))) {
            reply(type, requestId, { error: 'INVALID_DELETE_REQUEST' }); return
          }
          const deletion = { agentId, sessionId, createdAt, mode: mode as 'inspect' | 'delete',
            ...(typeof reviewId === 'string' ? { reviewId } : {}),
            ...(typeof path === 'string' ? { path } : {}), discardChanges: discardChanges === true,
            includeWorktree: includeWorktree === true,
            ...(selected ? { choices: { sessionData: selected.sessionData as boolean, worktreeData: selected.worktreeData as boolean } } : {}) }
          const operation = type === 'agent_worktree_delete'
            ? this.purgeAgentService.worktreeRequest({ ...deletion, mode: mode as 'describe' | 'inspect' | 'delete' })
            : this.purgeAgentService.request(deletion)
          void operation
            .then(result => {
              if (result.deleted === true || result.worktreeDeleted === true) void this.harnessStorageReader([], true)
              reply(type, requestId, result)
            }, () => reply(type, requestId, { error: 'DELETE_FAILED' }))
          return
        }
        case 'agent_delete': {
          const target = (payload.agentId as string | undefined) || (payload.sessionId as string | undefined)
          if (!target) { reply(type, requestId, { error: 'MISSING_AGENT_ID' }); return }
          if (!this.onDeleteAgent) { reply(type, requestId, { error: 'UNSUPPORTED' }); return }
          if (Object.hasOwn(payload, 'expectedSessionId')) {
            const current = registry.byAgent(target)
            if (!current || (current.sessionId || null) !== payload.expectedSessionId) {
              reply(type, requestId, { error: 'SESSION_CHANGED', detail: 'This conversation changed. Refresh and review it before stopping.' })
              return
            }
          }
          try { await this.onDeleteAgent(target) }
          catch (error) {
            if (!(error instanceof AgentStopError)) throw error
            reply(type, requestId, { error: error.code, detail: error.message })
            return
          }
          reply(type, requestId, { deleted: true })
          return
        }

        // Resume attaches or restores a saved conversation; restart replaces a live process in its
        // existing pane. Both keep the agentId and use the same durable operation receipt protocol.
        case 'agent_resume':
        case 'agent_restart': {
          const target = payload.agentId as string | undefined
          if (!target) { reply(type, requestId, { error: 'MISSING_AGENT_ID' }); return }
          const operation = type === 'agent_resume' ? 'resume' : 'restart'
          const restart = operation === 'resume' ? this.onResumeAgent : this.onRestartAgent
          if (!restart) { reply(type, requestId, { error: 'UNSUPPORTED_ON_REMOTE' }); return }
          const permissionMode = payload.permissionMode
          if (permissionMode !== undefined && (operation !== 'resume' || typeof permissionMode !== 'string'
            || !['ask', 'auto', 'plan', 'full'].includes(permissionMode))) {
            reply(type, requestId, { error: 'INVALID_PERMISSION_MODE' }); return
          }
          const invoke = () => permissionMode === undefined ? restart(target) : this.onResumeAgent!(target, permissionMode)
          const creationId = payload.creationId
          if (creationId !== undefined) {
            if (!validCreationId(creationId)) { reply(type, requestId, { error: 'INVALID_CREATION_ID' }); return }
            try {
              void this.agentCreations.run(creationId, creationFingerprint({ operation, agentId: target,
                ...(permissionMode === undefined ? {} : { permissionMode }) }), async () => {
                const result = await invoke()
                if (result.ok) return { state: 'created', agentId: result.session.agentId, resumed: result.resumed }
                // RESTART_FAILED can follow an unobserved relaunch. Never silently
                // replace that process again when a caller checks this intent.
                if (result.error === 'RESTART_FAILED' || result.error === 'RESUME_UNCONFIRMED') return { state: 'unconfirmed' }
                return { state: 'failed', error: result.error, ...(result.detail ? { detail: result.detail.slice(0, 2000) } : {}) }
              }).then(async (status) => {
                reply(type, requestId, { creationId, ...await this.creationStatusPayload(status) })
              }).catch(() => reply(type, requestId, { error: 'INTERNAL' }))
            } catch (error) {
              reply(type, requestId, { error: error instanceof AgentCreationReceiptError ? error.code : 'INTERNAL' })
            }
            return
          }
          const result = await invoke()
          if (!result.ok) {
            reply(type, requestId, result.detail ? { error: result.error, detail: result.detail } : { error: result.error })
            return
          }
          reply(type, requestId, { agent: await this.toProject(result.session), resumed: result.resumed })
          return
        }

        // Fork an agent: a second one with the first one's history — see lib/forkAgent.ts. The reply
        // is agent_create's shape plus `level`, so a client opens the pane the same way.
        case 'agent_fork': {
          const target = payload.agentId as string | undefined
          if (!target) { reply(type, requestId, { error: 'MISSING_AGENT_ID' }); return }
          if (!this.onForkAgent) { reply(type, requestId, { error: 'UNSUPPORTED_ON_REMOTE' }); return }
          const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim().slice(0, 120) : null
          const rawPrompt = payload.prompt
          if (rawPrompt !== undefined && rawPrompt !== null && typeof rawPrompt !== 'string') { reply(type, requestId, { error: 'INVALID_PROMPT' }); return }
          const prompt = typeof rawPrompt === 'string' && rawPrompt.trim() ? rawPrompt : null
          if (prompt && prompt.length > MAX_FIRST_PROMPT_CHARS) { reply(type, requestId, { error: 'PROMPT_TOO_LONG' }); return }
          const creationId = payload.creationId
          if (creationId !== undefined) {
            if (!validCreationId(creationId)) { reply(type, requestId, { error: 'INVALID_CREATION_ID' }); return }
            // Forking starts a new process too. Reserve the same durable intent used
            // by agent_create so a lost receipt can be checked without another fork.
            const fork = this.onForkAgent
            try {
              void this.agentCreations.run(creationId, creationFingerprint({ operation: 'fork', agentId: target, name, prompt }), async () => {
                const result = await fork({ agentId: target, name, prompt })
                if (result.ok) return { state: 'created', agentId: result.session.agentId, level: result.level }
                if (result.error === 'SPAWN_FAILED' || result.error === 'REGISTRATION_FAILED') return { state: 'unconfirmed' }
                return { state: 'failed', error: result.error, ...(result.detail ? { detail: result.detail.slice(0, 2000) } : {}) }
              }).then(async (status) => {
                reply(type, requestId, { creationId, ...await this.creationStatusPayload(status) })
              }).catch(() => reply(type, requestId, { error: 'INTERNAL' }))
            } catch (error) {
              reply(type, requestId, { error: error instanceof AgentCreationReceiptError ? error.code : 'INTERNAL' })
            }
            return
          }
          const result = await this.onForkAgent({ agentId: target, name, prompt })
          if (!result.ok) {
            reply(type, requestId, result.detail ? { error: result.error, detail: result.detail } : { error: result.error })
            return
          }
          reply(type, requestId, { agent: await this.toProject(result.session), level: result.level })
          return
        }

        case 'terminal_info': {
          // What a harness's pane runs now and where — tmux's #{pane_current_command} and
          // #{pane_current_path}, for a terminal client's formats. Read-only. Not in the e2ee
          // sets (core.ts is hash-pinned with the other implementations), so it answers the local
          // client; over the relay a peer is not asked, and the client keeps its fallback.
          const id = payload.agentId
          const agent = typeof id === 'string' ? registry.resolve(id) : undefined
          if (!agent?.tmuxPane) { reply(type, requestId, { error: 'AGENT_NOT_FOUND' }); return }
          void tmuxPaneInfo(agent.tmuxPane).then(info => reply(type, requestId, info ? { ...info } : { error: 'PANE_NOT_FOUND' }))
          return
        }

        case 'git_pull_request': {
          const id = payload.agentId
          const agent = typeof id === 'string' ? registry.resolve(id) : undefined
          if (!agent?.cwd) { reply(type, requestId, { status: 'unavailable' }); return }
          const requested = payload.context
          if (requested !== undefined && (!requested || typeof requested !== 'object'
            || typeof (requested as Record<string, unknown>).cwd !== 'string'
            || typeof (requested as Record<string, unknown>).branch !== 'string'
            || (requested as Record<string, unknown>).remote !== null && typeof (requested as Record<string, unknown>).remote !== 'string')) {
            reply(type, requestId, { status: 'unavailable' }); return
          }
          void readSessionGitPullRequest(agent, {
            expected: requested as import('./lib/sessionGitPullRequest.js').ExpectedGitContext | undefined,
            history: payload.history === true, offset: typeof payload.offset === 'number' ? payload.offset : undefined,
          }).then(result => reply(type, requestId, result))
            .catch(() => reply(type, requestId, { status: 'unavailable' }))
          return
        }

        case 'git_project_info': {
          const path = typeof payload.path === 'string' ? payload.path : ''
          // Same root set as project_preview below: the browsable home, widened by the workspaces
          // agents are running in, so a repo outside both is not somewhere this daemon runs git.
          void readGitProject(path, { refresh: payload.refresh === true,
            knownRoots: registry.list().flatMap(agent => agent.cwd ? [agent.cwd] : []) })
            .then(result => reply(type, requestId, result))
            .catch(() => reply(type, requestId, { error: 'UNAVAILABLE' }))
          return
        }

        case 'project_preview': {
          const path = typeof payload.path === 'string' ? payload.path : ''
          // Preview work is detached so typing and other RPCs stay responsive.
          void projectPreview(path, registry.list().flatMap(agent => agent.cwd ? [agent.cwd] : []))
            .then(result => reply(type, requestId, result))
            .catch(() => reply(type, requestId, { error: 'UNAVAILABLE' }))
          return
        }

        case 'fs_list_dir': {
          // One-level remote directory listing for the New Agent folder browser.
          const path = typeof payload.path === 'string' ? payload.path : ''
          const result = listDir(path)
          if ('error' in result) { reply(type, requestId, { error: result.error }); return }
          reply(type, requestId, { ...result })
          return
        }

        case 'codex_profiles_list': {
          // Which CODEX_HOME folders THIS machine can offer — answered here, on the machine in
          // question, for the same reason `engines_probe` is: a Codex profile is a folder on disk,
          // and a folder on a Mac means nothing on the Docker rig it was asked about instead.
          const observed = Array.isArray(payload.observedPaths)
            ? payload.observedPaths.filter((p): p is string => typeof p === 'string')
            : []
          try {
            reply(type, requestId, { profiles: listCodexProfiles(observed) })
          } catch {
            reply(type, requestId, { error: 'CODEX_PROFILES_FAILED' })
          }
          return
        }

        case 'codex_profile_link': {
          const path = typeof payload.path === 'string' ? payload.path : ''
          const result = linkCodexProfile(path)
          if ('error' in result) { reply(type, requestId, { error: result.error }); return }
          reply(type, requestId, { profile: result })
          return
        }

        case 'agent_read_file': {
          // Media previews, in bounded binary chunks. The text mode this RPC also used to serve was
          // read by nothing — every client has always asked with `media: true` — so it is gone rather
          // than carrying a second, laxer file reader (lib/mediaPreview.ts).
          const projectId = payload.agentId as string | undefined
          const path = payload.path as string | undefined
          if (!projectId || !path) { reply(type, requestId, { error: 'MISSING_AGENT_OR_PATH' }); return }
          if (payload.media !== true) { reply(type, requestId, { error: 'UNSUPPORTED', detail: 'agent_read_file serves media previews only' }); return }
          const s = registry.resolve(projectId)
          if (!s?.cwd) { reply(type, requestId, { error: 'AGENT_NOT_FOUND' }); return }
          try {
            reply(type, requestId, { ...await readMediaPreviewChunk(s.cwd, path, payload.offset, payload.revision) })
          } catch (error) {
            reply(type, requestId, { error: error instanceof MediaPreviewError ? error.message : 'MEDIA_READ_FAILED' })
          }
          return
        }

        case 'claude_login_status':
          // Legacy RPC name; report the selected agent's actual engine when one was supplied.
          {
            const target = (payload.agentId as string | undefined) || (payload.sessionId as string | undefined)
            reply(type, requestId, { loggedIn: true, engine: (target ? registry.resolve(target)?.engine : undefined) ?? 'claude', account: hostname() })
          }
          return

        case 'message': {
          const content = payload.content as string | undefined
          const target = (payload.agentId as string | undefined) || (payload.sessionId as string | undefined)
          if (!content || !target) return
          // Inject into the pane; the resulting JSONL user/assistant lines drive the turn lifecycle back
          // to the web (mirror-all) — no synthetic events here. Prefer cli.ts's handler (inject + Enter
          // retry); fall back to a direct inject when unwired (isolation/tests). From the relay this is
          // only reached sealed: text typed into an agent is never taken from the relay in the clear.
          const tabId = Id.safeParse(payload.tabId)
          if (this.onMessage) {
            if (tabId.success) this.onMessage(target, content, undefined, tabId.data)
            else this.onMessage(target, content)
          }
          else console.warn('[backend] message handler is not wired; terminal input was not dispatched')
          return
        }

        case 'cancel': {
          const target = (payload.agentId as string | undefined) || (payload.sessionId as string | undefined)
          if (target) this.onCancel?.(target)
          return
        }

        case 'speaking': {
          // A device is capturing a voice instruction. Mirror the hosted runtime: re-broadcast the presence
          // signal to the web (indicator) + other devices. Ephemeral, no requestId.
          const p = payload as { speaking?: boolean; agentId?: string; sessionId?: string }
          const sessionId = p.sessionId ?? p.agentId
          const projectId = p.agentId ?? p.sessionId ?? null
          const on = p.speaking !== false
          // Echo the canonical agent id, whichever id the sender used to address it.
          const speaker = projectId ? registry.resolve(projectId) : undefined
          const speakerAgentId = speaker?.agentId ?? projectId
          const evt = { type: 'speaking', dbSessionId: speaker?.sessionId ?? sessionId, agentId: speakerAgentId, payload: { speaking: on, agentId: speakerAgentId, sessionId: speaker?.sessionId ?? sessionId } }
          this.send(evt) // web
          this.sendCommander(evt) // other devices (firmware ignores its own echo; matches node forwardToCommander)
          return
        }

        case 'question_response': {
          // A device answered an AskUserQuestion. There's no control channel into an interactive CLI, so
          // cli.ts keys the answer straight into that session's tmux dialog.
          const p = payload as { requestId?: string; sessionId?: string; agentId?: string; answers?: Record<string, string> }
          const answered = this.onQuestionAnswer?.(p)
          // Detached: driving a dialog takes seconds of keystrokes and repaints. The outcome goes back
          // under the QUESTION's requestId, so the client that answered can say why nothing happened —
          // STALE_QUESTION when the dialog changed before the answer arrived and nothing was typed.
          if (answered) {
            void answered
              .then((result) => reply(type, requestId, result.ok ? { ok: true } : { error: result.error, detail: result.detail }))
              .catch(() => reply(type, requestId, { error: 'ANSWER_FAILED', detail: 'The answer could not be entered.' }))
          }
          return
        }

        // This machine's Claude/Codex rate limits, read with ITS OWN credentials. The desktop reads the
        // account on the computer it runs on directly; this is how it reads one on a machine it does
        // not — which may be signed in to a different subscription entirely. The vendor's answer goes
        // back as it came: see lib/accountUsage.ts for why the parsing stays on the client.
        case 'usage_read': {
          // Two vendor round trips (up to 8s each, lib/accountUsage.ts) — detached from the ordered
          // chain for the same reason as `grid_models_list`: it is asked on connect beside the RPCs
          // the terminal needs, and with no network it held them past the app's timeout.
          void this.accountUsageReader()
            .then((providers) => reply(type, requestId, { providers }))
            .catch(() => reply(type, requestId, { error: 'USAGE_READ_FAILED' }))
          return
        }

        // Physical devices belong to this machine; only its owner or loopback tools may manage them.
        case 'harness_devices_list':
        case 'harness_device_settings': {
          if (!local && this.e2ee.sessionRole(connId) !== 'web') {
            reply(type, requestId, { error: 'OWNER_REQUIRED' })
            return
          }
          reply(type, requestId, await harnessDevicesRequest(this.harnessDevices, type, payload))
          return
        }

        // The colours the desktop paints its panes with, so tmux answers a TUI's OSC 10/11 with
        // them instead of with whatever terminal happened to attach first (lib/hostTheme.ts).
        case 'theme_set': {
          if (!this.hostThemeSink) { reply(type, requestId, { error: 'UNSUPPORTED' }); return }
          const theme = parseHostTheme(payload)
          if (!theme) { reply(type, requestId, { error: 'BAD_THEME' }); return }
          this.hostThemeSink(theme)
          reply(type, requestId, { applied: true })
          return
        }

        default:
          // Unknown RPC with a requestId: reject fast so the web promise doesn't wait out its 20s.
          if (requestId !== undefined) reply(type, requestId, { error: 'UNSUPPORTED' })
          return
      }
    } catch (err) {
      // A service on the core boundary that failed or is off (core/serviceHost.ts): the host has logged
      // it, and the client may ask again — the service can be back after the daemon restarts.
      if (err instanceof ServiceUnavailableError) {
        console.warn(`[backend] ${type}: ${err.message}`)
        if (requestId !== undefined) reply(type, requestId, { error: 'SERVICE_UNAVAILABLE', service: err.service, retryable: true })
        return
      }
      console.error(`[backend] dispatch ${type} failed:`, err)
      if (requestId !== undefined) reply(type, requestId, { error: 'INTERNAL' })
    }
  }

  /** Recover by stable runtime identity; a deleted agent must never become a fresh launch. */
  private async creationStatusPayload(status: AgentCreationStatus): Promise<Record<string, unknown>> {
    if (status.state === 'created') {
      const session = registry.byAgent(status.agentId)
      return session
        ? { state: 'created', agent: await this.toProject(session), ...(status.level ? { level: status.level } : {}), ...(status.resumed !== undefined ? { resumed: status.resumed } : {}) }
        : { state: 'unavailable' }
    }
    // A recorded refusal is a completed outcome. Keep it separate from transport/dispatch errors
    // so clients can distinguish "safe to correct the choices" from "outcome still unknown".
    if (status.state === 'failed') {
      return { state: 'failed', ...(status.preparedFolder ? { preparedFolder: status.preparedFolder } : {}), failure: { code: status.error, ...(status.detail ? { detail: status.detail } : {}) } }
    }
    return status
  }

  async publishStoppedAgent(s: RegisteredSession): Promise<void> {
    this.send({ type: 'agent_synced', payload: { agent: await this.toStoppedProject(s) } })
    this.sendCommander({ type: 'agent_deleted', payload: { agentId: s.agentId } })
  }

  private async toStoppedProject(s: RegisteredSession): Promise<AgentFrame> {
    const frame = await agentFrame(s, { selectedModel: s.model, terminalAvailable: false, dsh: this.dshFrameProvider?.(s) ?? null,
      tokenUsage: agentTokenUsage.get(s) })
    return {
      ...frame,
      status: 'stopped',
      tmuxPane: null,
      terminal: { available: false, primary: '', runtimes: [] },
      viewerUrl: null,
      forkable: false,
    }
  }

  /** Map a registered tmux session onto the web's Project shape (tabs in ProjectTabs). */
  private toProject(s: RegisteredSession): Promise<AgentFrame> {
    return agentFrame(s, {
      tokenUsage: agentTokenUsage.get(s),
      selectedModel: this.runtimeProfileProvider?.(s) ?? null,
      terminalAvailable: registry.terminalAvailable(s.agentId),
      dsh: this.dshFrameProvider?.(s) ?? null,
      activity: () => this.activityFrameProvider?.(s) ?? null,
    })
  }
}
