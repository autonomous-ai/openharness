/**
 * Registry of process-owned AGENTS — one per supported top-level engine process in a tmux pane.
 *
 * An agent is created the moment process discovery observes it and lives exactly as long as that process.
 * The ENGINE
 * session is a mapping bound to the agent afterwards, and rebound whenever the engine rotates it
 * (`/clear`, `/new`) — the agent, its tab, its name and its place in the list do not move.
 *
 * Two indexes, because the outside world speaks both languages: `agentId` for anything the user
 * addresses, and a bare `sessionId` for turn control (`cancel`, `question_response`, `session_get`).
 * `resolve()` accepts either. Persisted to disk so a live agent survives a self-update restart.
 *
 * Module singleton (like the ws `clients` set) — imported by routes + reaper.
 */

import { DSH_ID_RE } from '../dsh/id.js'
import { AGENT_NAME_RE } from './engineLaunch.js'
import { resumesConversation } from './resumeCapability.js'
import { namingTitle } from './sessionTitle.js'
import { reportedProfileHome, transcriptProject } from '../engines/discoveries.js'
import { automaticAgentName, engineLabel, isAutomaticName } from './agentNames.js'
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { randomUUID } from 'crypto'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { join, basename, dirname, relative, isAbsolute } from 'path'
import { machineNames } from './machineNames.js'
import { IdentityReadUnavailable } from '../engines/kit/identityScan.js'
import { env } from '../config/env.js'
import { engineHomeSnapshot, sessionRoots, type EngineHomeSnapshot } from './engineHomes.js'
import { transcriptRoot as TRANSCRIPT_ROOT, needsHomeCatalog, savedTranscriptEvidence, transcriptEvidence, transcriptRootEvidence } from '../engines/transcriptBindings.js'
export { engineKeepsTranscriptFile } from '../engines/transcriptBindings.js'
import { sessionStoreOf } from '../engines/sessionStoreContracts.js'
import { ENGINES, isTerminalEngine, type AgentEngine } from '../engines/types.js'
import type { GridAssignment } from './gridAssignment.js'
import type { GridLaunchRecord, GridWebSearchStatus } from './gridLaunchWire.js'
import { sessionStorage, type SessionImageSource } from './sessionStorage.js'
import { credentialEquality, storedGridLaunch, sessionFileIdentity, type SessionImageProof, type StoredGridLaunch } from './sessionStorageWire.js'
import { prepareSessionPublication } from './sessionPublication.js'
import { parseScmLaunchRecord, type ScmLaunchRecord } from '../scm/types.js'
import { storedLaunchModel, type LaunchModel } from './launchModel.js'
import { commandcodeTranscriptPath } from '../engines/commandcode/contract.js'
import { agyTranscriptPath } from '../engines/agy/contract.js'
import { copilotTranscriptPath } from '../engines/copilot/contract.js'
import { OPENCLAW_KEY } from '../engines/openclaw/contract.js'
import { bootChanged, currentBootId } from './bootId.js'
import { hardenPrivateStateFileIfPresent, readPrivateStateFile, secureStateDirectory, syncStateDirectory } from './secureState.js'
import { AtomicWriteUnconfirmed, RegistryPersistenceUnavailable, RegistryWriteQueue, privateRegistryDirectory, registryFileLock, type RegistryWriteDeadline } from './registryPersistence.js'
import { mergeTerminalRuntimes, primaryRuntime, processIdentityKey, sameProcessIdentity, terminalPlacementKey, terminalRouteKey } from './terminalRuntime.js'
import type { HookTerminalHint, ProcessIdentity, TerminalRuntimeRef } from './terminalTypes.js'
import { externalReservations, externalResumePending, externalResumeIds, parseExternalResume, type ExternalResumeIntent } from './externalResume.js'
import type { StartedBy } from './agentAttribution.js'
import { PTY_HOST_INSTANCE } from './ptyHost/instance.js'
import { isKittyGraphicsCommand } from './terminalTitle.js'
import { sid } from './log.js'
import { HOOK_GATEWAY_ENGINES } from './gatewayRuntime.js'

export type { ProcessIdentity } from './terminalTypes.js'

export interface RegistryAuthority {
  current?: () => boolean
  /** An earlier monotonic operation deadline; retries never renew it. */
  expires?: number
  /** Refresh an asynchronous native observation after image preparation, before final publication. */
  refresh?: () => Promise<void>
}

export interface LaunchPublicationInput {
  processIdentity: ProcessIdentity | null
  gateway?: 'ori' | null
  grid?: GridAssignment | null
  launchArgs?: string[]
  gridLaunchRecord?: GridLaunchRecord | null
  subscriptionModel?: string | null
  runtimes?: readonly TerminalRuntimeRef[]
  primaryRuntimeKey?: string
}

export type LaunchPublication = { state: 'not-published' } | { state: 'confirmed'; entry: RegisteredSession | null }

/** A launch published `ready` and the row a hook's registration rebuilds without one are the same launch. Read
 *  apart, the second of two restarts took the engine down and answered AGENT_CHANGED (e2e/races.e2e.ts, 2026-11-17). */
function launchIdentity(row: RegisteredSession | undefined): string {
  return rowFingerprint({ launch: row?.launch?.state === 'ready' ? undefined : row?.launch, launchArgs: row?.launchArgs, grid: row?.grid,
    gridLaunch: row?.gridLaunch, gridWebSearch: row?.gridWebSearch, subscriptionModel: row?.subscriptionModel, active: row?.active })
}

/** A durable receipt grants only this installed owner and launch, including after a terminal await. */
export function matchesLaunchReceipt(row: RegisteredSession | undefined, receipt: RegisteredSession): boolean {
  return !!row && ownershipIdentity(row) === ownershipIdentity(receipt) && launchIdentity(row) === launchIdentity(receipt)
}

function ownershipIdentity(row: RegisteredSession | undefined): string | undefined {
  if (!row) return undefined
  return rowFingerprint({ agentId: row.agentId, registeredAt: row.registeredAt, engine: row.engine,
    sessionId: row.sessionId, transcriptPath: row.transcriptPath, processIdentity: row.processIdentity,
    runtimes: row.runtimes, primaryRuntimeKey: row.primaryRuntimeKey, codexHome: row.codexHome,
    claudeHome: row.claudeHome, hermesHome: row.hermesHome, openclawStateDir: row.openclawStateDir,
    externalToken: row.externalResume?.token, evidenceRevision: row.evidenceRevision })
}

export type AgentLaunch =
  | { state: 'starting'; nativeToken?: string }
  | { state: 'ready' }
  | { state: 'failed'; error: string; detail?: string }
  /**
   * Not launched yet because the service its launch asks could not be asked (core/agents/heldLaunches.ts): a
   * grid or saved-API agent while models is not running. Nothing about the agent is wrong. It waits in a pane
   * that says why, and is launched once the service is ready. Never a failure: a restore tries it again.
   */
  | { state: 'held'; service: string; detail: string; nativeToken?: string }

/** Claude Code's hooks report `model` as {id, display_name}; Codex/Cursor report a plain string. This is
 *  the boundary where hook JSON becomes persisted state, so anything else is dropped rather than stored —
 *  a non-string here reaches runtimeProfile's `.toLowerCase()` and takes the daemon down AT STARTUP, which
 *  no restart can heal because the bad value is on disk. */
function modelString(value: unknown): string | null {
  if (typeof value === 'string') return value.slice(0, 200)
  const id = (value as { id?: unknown } | null)?.id
  return typeof id === 'string' ? id.slice(0, 200) : null
}

export interface RegisteredSession {
  /** An explicit Close-after-task intent. Never inferred from visibility or CPU use. */
  closePlan?: import('./closeAgentService.js').AgentClosePlan
  /** Per-row marker; the top-level array is retained for backward-reader safety. */
  schemaVersion: 2
  /** Whether the supported engine process is currently identified; terminal liveness is tracked separately. */
  active: boolean
  /** Harness-created panes can be rendered before their engine process exists. Absent on legacy rows. */
  launch?: AgentLaunch
  /** Fresh evidence is unavailable; retain the binding and expose its reason without persisting an authority verdict. */
  identityHold?: string
  /** Pending native hook evidence; it does not revoke an already-bound conversation. */
  admissionHold?: string
  /** Monotonic process-local authority: a hold/recovery cycle must never revive an older read. */
  evidenceRevision?: number
  /** Native identity recovered; interpretation stays paused until its replacement tail is installed. */
  interpretationHold?: string
  /** Enter on stopped work must never become a fresh conversation, including after a daemon restart. */
  resumeOnly?: true
  /** External admission survives a crash independently of any conversation Harness already owns. */
  externalResume?: ExternalResumeIntent
  /**
   * THE AGENT. Public identity: this is what web tabs, device tiles and every inbound frame address.
   *
   * It is normally minted when a top-level engine process is discovered. Harness-created panes mint it
   * immediately so clients can render the terminal while the engine starts. Persisted route/process identity
   * keeps the UUID stable across daemon restarts and engine session rotations (`/clear`, `/new`).
   */
  agentId: string
  /**
   * The engine session currently BOUND to this agent — internal mapping, not identity. It changes on a
   * rotation and is only ever addressed through the session index.
   */
  sessionId: string
  /** When the CURRENT sessionId was bound (vs `registeredAt`, which is when the agent appeared). */
  boundAt: number | null
  engine: AgentEngine
  /**
   * Set when the engine process is pointed at an OpenRouter endpoint (`ori claude`, `ori codex`, …).
   *
   * It is NOT a second engine: the engine stays `claude`/`codex`/… and every badge, icon and wire field
   * keeps saying so. It only records HOW the pane's requests are billed, which makes the runtime profile
   * display-only: the core types no `/model` into the pane. Never read from the process's environment:
   * Codex's comes from its argv on every discovery; Claude Code's, OpenCode's and Hermes's from what their
   * hook says of its own environment (`X-Harness-Hook-Gateway`), the only hooks that say it. A relaunch
   * keeps it until the engine says it again, so a pane restarted without the wrapper drops it on the next
   * scan or hook.
   */
  gateway?: 'ori' | null
  /**
   * The grid this pane's engine is pointed at, if any. Comes from the launch record (create and retarget
   * write it) and from argv evidence that models classifies; unlike `gateway`, which comes from Codex's
   * argv or a hook's header. See `gridAssignment.ts`. Carries no credential; the
   * launch that put the engine there, credential included, is `gridLaunch` below.
   */
  grid?: GridAssignment | null
  /**
   * The full grid launch this agent was last created or retargeted with, apiKey included. Persisted
   * (this file is 0600, see `secureState.ts`) so a pane recreated after a reboot (`restoreAgents`) or
   * respawned in place (`agent_restart`) is launched onto the SAME grid with the SAME credential
   * instead of silently coming back on the engine's own login. Never announced — `agentFrame` picks
   * its fields explicitly — and never logged. `grid` stays the observed, credential-free projection.
   * Null on a vendor-login agent; absent on a row written before this field existed, which restore
   * treats as "grid agent without a credential".
   */
  gridLaunch?: StoredGridLaunch | null
  /**
   * What `gridLaunch` decided about web search — `on`, `unavailable` or `unsupported` — as the app
   * shows it (`grid.webSearch` on the frame). Written with the launch and cleared with it, never
   * re-derived: the launch builder decided it from the machine as it was at launch, and that is what
   * the pane actually got. Null on a vendor-login agent and on a discovered grid agent (no launch was
   * built, so there is nothing to say); absent on a row written before this field existed.
   */
  gridWebSearch?: GridWebSearchStatus | null
  /**
   * What the workspace's SCM needs re-applied to the pane on every relaunch (scm/types.ts) — the
   * SCM's half of `gridLaunch`. A git worktree's record only says it is one and asks for nothing.
   * Written by `agent_create` from what the workspaces service made (`prepareFolder`), carried forward like
   * `gridLaunch`, never re-derived. Absent on a row from before the seam and on a folder no SCM
   * prepared — absent, not null, so a row that never had one is written exactly as before.
   */
  scmLaunch?: ScmLaunchRecord | null
  /**
   * The engine's OWN model this agent was on immediately before it moved to a grid.
   *
   * Captured at the moment of leaving, because that is the only moment it is still observable: once
   * the pane is on a grid, the engine reports the GRID's model and the previous one exists nowhere.
   * Re-selected when the agent moves back, so coming home does not mean landing on whatever default
   * the vendor would otherwise pick. Null when the agent has never left, or was on no particular
   * model when it did.
   */
  subscriptionModel?: string | null
  /**
   * The model and effort this session was launched with as flags (`agent_create`'s launch model, lib/launchModel.ts),
   * or the one a person moved it onto through Harness since (`agent_update`). Every relaunch passes them again
   * (lib/launchOverrides.ts): the flags hold for one launch only, and an agent launched on Opus at xhigh came
   * back on its engine's own default, the machine's last-used Claude Code model, once reopened (task #3395, anh Dee
   * 11-05). Absent for a session launched with none.
   */
  launchModel?: LaunchModel
  /**
   * Extra command-line words an owner asked for on this agent (`agent_restart`'s `launchArgs`, lib/launchArgs.ts),
   * appended to every relaunch so they hold across a restart, a reboot and a daemon update until cleared. Never an
   * empty array: clearing deletes the field. Absent for an agent with none.
   */
  launchArgs?: string[]
  /**
   * Its Browser was on, as the core kept it until 2026-11-15: the agent browser keeps whose Browser is on itself now
   * (services/agentBrowser.ts), and takes this in once for each agent it sees with it, the migration of the flags the
   * core kept. The core never sets or clears it but at the create of a Desktop from before Browser left New agent
   * (core/agents/launches.ts), and carries it as it was, so a rollback finds every flag as it was at the update. Delete
   * on or after 2026-12-18, with that create's field.
   */
  browser?: true
  /**
   * On the shell an exit left (`confirmEngineExit(id, 'successor')`): the agent whose engine ended in this pane. The pane's next
   * agent is reported through the generic pane-takeover lifecycle. A search of saved agents by pane is no proof: pane ids
   * restart with every tmux server. Gone once an engine is adopted here, and once that agent runs again under its own
   * id. Never in a saved record.
   */
  previousAgentId?: string
  /**
   * The CODEX_HOME folder this agent runs against, if it is not `~/.codex`. Codex only. Chosen at creation; a row
   * that does not know it (a Codex started by hand) is filled once, from its hook's own CODEX_HOME when its transcript
   * is under it, or from the rollout its process holds open. Unlike `grid`, never changed once known — a running
   * agent cannot be moved to a different profile the way it can be retargeted to a different grid.
   */
  codexHome?: string | null
  /**
   * The CLAUDE_CONFIG_DIR folder (a Claude profile) this agent was launched against, if one was chosen instead of
   * `~/.claude`. Claude only. Chosen once at creation like `codexHome`; the row is the relaunch source, so restart and
   * resume come back in the same account.
   */
  claudeHome?: string | null
  /**
   * The Hermes home this session's history lives in — `~/.hermes/profiles/<name>` for an agent started
   * with `hermes -p <name>`, null for this machine's default home.
   *
   * Unlike `codexHome` this is not a launch choice the daemon makes: `hermes -p` is how a person starts
   * one, and the daemon meets the pane afterwards. So it is FOUND rather than recorded — by the session
   * id, in whichever store holds its row (`engines/hermes/home.ts`), or from the store its process holds
   * open — and then kept here so the lookup happens once per agent instead of once per poll. Fill-only,
   * like `codexHome`.
   *
   * Everything Hermes-shaped reads it: the live mirror, `agent_recent`, the recap fallback, the hook's
   * source check and the model/effort poll. Reading one fixed home instead is what left a profile
   * fleet's activity cards empty forever while their terminals streamed perfectly (openharness#191).
   */
  hermesHome?: string | null
  /**
   * Only beside `hermesHome`: that path is the daemon's path of a sandboxed process's home, not the one the process
   * names it by. A relaunch exports no `HERMES_HOME` for it, since the relaunched process works out its own home, in
   * its own view. Stored, not kept in memory, so an agent resumed after the daemon that saw its process has gone still
   * is not handed the daemon's path.
   */
  hermesHomeDerived?: true
  /**
   * OpenClaw only: the state folder its TUI held open when the session was bound (lib/openclawStore.ts). A `--profile`
   * or `--dev` TUI keeps its store outside the default folder, and once the TUI has exited this is where its history,
   * usage and checkpoint are read from.
   */
  openclawStateDir?: string | null
  /**
   * OpenClaw only: the `--local` folder this harness runs in (`agent_create`'s `openclawLocal`), an absolute path. Its
   * `openclawStateDir` is this folder from the start and never moves off it. Kept as written: a folder that is gone is
   * refused at launch, never dropped here.
   */
  openclawLocal?: string
  /**
   * The session keys this harness moved off (`/new`), newest first, once each, at most EARLIER_SESSIONS_MAX: a delete
   * erases what is kept under every one of them. Never on the agent's frame.
   */
  earlierSessionIds?: string[]
  /**
   * The first task its launch carried, for an engine that is handed it by typing rather than in argv (OpenClaw), until
   * it is typed into the pane. Saved with the row, so a daemon restart before the engine is ready still types it; taken
   * off durably before it is typed (`takeFirstTask`), so it is typed at most once. Never on the agent's frame.
   */
  firstTask?: string
  /**
   * The domain-specific harness this agent was created as (`autonomous/copper`), or null for a plain
   * engine. NOT a second engine: `engine` stays the base (`claude`, `codex`, …) and every normalizer,
   * probe and install path keys on that. Chosen at creation and carried by every relaunch: the launch
   * record is the one source, so a row discovery mints has none. See `src/dsh/`.
   */
  dsh?: string | null
  /** Stable key of the session-scoped harness runtime; preserved by bind, restore and fork. */
  dshRuntime?: string | null
  /**
   * The engine's own named agent this pane was opened as (`agent_create`'s `agent`; opencode
   * `--agent <name>`), or null for a general session. Chosen at creation and carried into every
   * relaunch (`launchOverrides.ts`), so a pane opened as `harness-compute` comes back as `harness-compute`.
   * Like `codexHome`, never re-derived from the live process.
   */
  agent?: string | null
  /**
   * Whether the engine was launched with its permission prompts bypassed (`--dangerously-skip-permissions`
   * and friends, `BYPASS_PERMISSION_FLAGS`). Recorded at launch because it is otherwise only readable
   * off a LIVE process's argv — and a pane that has to be recreated after a reboot has no live process
   * to read it from. Like `codexHome`, chosen at launch and carried forward, never re-derived.
   */
  bypassPermission?: boolean
  /**
   * The permission mode picked in New Harness (`PERMISSION_MODES` in engineLaunch.ts: `auto`, `ask`,
   * `acceptEdits`, `plan`, `readOnly`, `full`). Recorded at launch and reapplied on every relaunch, so
   * an agent started in Plan stays in Plan across a restart. Absent on rows from before the choice
   * existed and on agents Harness did not launch; those relaunch from `bypassPermission`.
   */
  permissionMode?: string
  /**
   * The pane was opened as a terminal (engine `terminal`, the desktop's New Terminal) rather than
   * for an engine. Set once at creation and kept for the row's whole life, whichever engine is
   * running in it now: this is what tells the reconciler that an engine exiting means "back to a
   * shell" (`confirmEngineExit`) rather than "dormant", and what tells `restoreAgents` to bring back
   * a shell rather than a `claude`. Not a type — `engine` still says what the pane IS right now.
   */
  terminalHost?: boolean
  /**
   * The agent this one was FORKED from (`agent_fork`): a new session opened with the source's whole
   * history, the source left as it was. Recorded once at creation so the pane can say "forked from X"
   * and link back; `name` is the source's name at that moment, kept because the source may be renamed
   * or gone by the time anyone reads it. The source's session at that moment is kept too (see `ForkOrigin`),
   * so a Change agent before the fork's first answer can hand over the history it inherited. Absent on every
   * other agent.
   */
  forkedFrom?: ForkOrigin | null
  /**
   * `agent` when another agent started this harness (`harness new` from its pane); absent when the person did.
   * Recorded once at creation and carried into every relaunch (`launchOverrides.ts`), whose argv then has the
   * engine add a line to the pull requests it opens (lib/agentAttribution.ts). Never re-derived from the process.
   */
  startedBy?: StartedBy
  /**
   * The harness on this machine whose agent started this one (`harness new`, or `harness_start` through `harness mcp`,
   * run in its pane), by agent id. Absent when the person started it, and when the agent that did is outside Harness or
   * on another machine. Recorded once at creation beside `startedBy` and carried like it, so every window can put the
   * new harness beside the one that started it and say so in its header (docs/design/2026-10-11-agent-client.md).
   */
  parentAgentId?: string
  /**
   * The guest (email) this harness was started for: a session of an account the owner shares this machine
   * with. Its process runs as that guest's OS user, and only that guest's sessions may see or drive it
   * (core/guestPolicy.ts, docs/plans/2026-10-19-guest-machine-sharing-plan.md). Absent for the owner's own.
   * Recorded once at creation and never changed.
   */
  guest?: string
  /** Legacy launcher-owned snapshots may still contain this field. New records never write it. */
  launcherId?: string
  transcriptPath: string | null
  projectDir: string
  /** Stable default for agents created by Harness — `<agent> harness M-D H:MM` (agentNames.ts), or the
   *  name the creator asked for (`agent_create`'s `name`). Rows from earlier daemons carry `harness-N`.
   *  Discovered agents keep their existing names. */
  defaultName?: string
  cwd: string | null
  /** Authoritative backend-neutral terminal placements for this one process-owned agent. */
  runtimes: TerminalRuntimeRef[]
  primaryRuntimeKey: string
  /** Additive rollback/wire projection of the tmux runtime. */
  tmuxPane: string
  source: string | null
  title: string | null
  /**
   * The title its engine gave its conversation from a line typed for the agent alone (a quiet delivery,
   * core/agents/quietTitles.ts), as `sessionDisplayTitle` reads one: never its name (`updateTitle`). Kept on the row because the
   * engine shows it again after a restart or a resume (Codex keeps the first name it gave a thread). Absent until there is one.
   */
  quietTitle?: string
  model: string | null
  cliVersion: string | null
  processIdentity: ProcessIdentity | null
  registeredAt: number
  /**
   * When the daemon last changed this row: housekeeping (a reconcile pass, an attach, a rename),
   * never when the conversation moved. That is `lastActivityAt` (agentFrame.ts), which is what
   * clients get as `updatedAt`. Rows saved before 2026-09-27 call this `updatedAt` ([savedTouchedAt]).
   */
  touchedAt: number
  lastHookAt: number
  lastTranscriptAt: number
  /**
   * When an app last OPENED this agent (ms epoch) — a desktop window focusing its tab, the phone
   * landing on it — on any computer. Stamped by `markOpened` with THIS daemon's clock, never a
   * client's: the agent's owner is the one place every app reads from, so it is the one clock they
   * can all agree on, and "last used" comes out in the same order on every screen. Absent until the
   * first open; persisted, carried through a hook bind, a stop and a resume like any other fact
   * about the agent. A client sorts by the later of this and the frame's `updatedAt`.
   */
  lastOpenedAt?: number
}

/** A saved row's `touchedAt`, which rows saved before 2026-09-27 call `updatedAt`. */
function savedTouchedAt(row: { touchedAt?: unknown; updatedAt?: unknown }): number | null {
  return typeof row.touchedAt === 'number' ? row.touchedAt : typeof row.updatedAt === 'number' ? row.updatedAt : null
}

export interface RegisterInput {
  engine?: AgentEngine
  /** Accepted from old hook/plugin payloads for wire compatibility, but deliberately ignored. */
  launcherId?: string
  sessionId?: string
  transcriptPath?: string
  cwd?: string
  source?: string
  tmuxPane?: string
  title?: string
  model?: string
  cliVersion?: string
  processIdentity?: ProcessIdentity
  /** New authenticated hooks may supply resolved runtime hints. Legacy hooks continue to use tmuxPane. */
  runtimes?: TerminalRuntimeRef[]
  primaryRuntimeKey?: string
  runtimeHints?: HookTerminalHint[]
  callerPid?: number
  hookEvent?: string
  /** Hermes only: the home whose store holds this session, when it is not the machine's default one.
   *  Found by the hook gate (`awaitHermesKind`), which has to look the session up anyway, and by the
   *  hook script itself when the daemon was down. Fill-only — see RegisteredSession.hermesHome. */
  hermesHome?: string
  /** `hermesHome` is one Harness worked out — see RegisteredSession.hermesHomeDerived. */
  hermesHomeDerived?: true
  /** From the hook's own environment: undefined when the hook did not say. Taken for Claude Code, OpenCode and Hermes. */
  gateway?: 'ori' | null
  /** Codex only, the hook's own CODEX_HOME. Fill-only, and only when this session's transcript is under its sessions folder. */
  codexHome?: string
}

/** Display name for a session's "project" tab/tile. A user rename (persisted override) is
 *  authoritative and FIXED. Until there is one, a session is called what its engine calls it — the
 *  conversation title Claude Code puts on its terminal, Codex's thread name (sessionTitle.ts) — which
 *  moves as the engine retitles it, and says what the agent is doing. The name a harness is created
 *  with ("Codex harness 9-17 15:26") stands in until the engine has a title, a name its creator chose
 *  is kept like a rename, and a discovered session falls back to its folder. */
export function projectDisplayName(s: RegisteredSession): string {
  // A name the creator chose ("Local model") is fixed like a rename; only a name Harness gave gives way.
  const chosen = s.defaultName && !isAutomaticName(s.defaultName) ? s.defaultName : null
  return NAME_OVERRIDES.get(s.sessionId) || NAME_OVERRIDES.get(s.agentId) || chosen
    || sessionDisplayTitle(s) || s.defaultName || defaultProjectDisplayName(s)
}


/** Whether a person chose [s]'s name: they renamed it (kept in agent-names.json), as against the name it was created with
 *  or the engine's session title, which `projectDisplayName` falls back to. The agent frame carries it (`nameChosen`), so
 *  a client sends only a chosen name on and never a title (task #2920). */
export function isNameChosen(s: RegisteredSession): boolean {
  return !!(NAME_OVERRIDES.get(s.sessionId) || NAME_OVERRIDES.get(s.agentId))
}

/** The engine's own name for this session, or null while it has none worth showing. */
export function sessionDisplayTitle(s: RegisteredSession): string | null {
  return namingTitle(titleDisplayName(s.title), { engine: s.engine, cwd: s.cwd, defaultName: s.defaultName })
}

const FILE = join(env.ADAPTER_DATA_DIR, 'registry.json')
const BOOT_FILE = join(env.ADAPTER_DATA_DIR, 'registry-boot')
const LOCK_DIR = join(env.ADAPTER_DATA_DIR, 'registry.json.lock')
const PRE_V2_BACKUP_FILE = join(env.ADAPTER_DATA_DIR, 'registry.pre-v2.json')
/** Written once this machine's saved agents are cleared of the permission modes Harness forced (`withoutForcedModes`). */
const OWN_MODES_FILE = join(env.ADAPTER_DATA_DIR, 'registry-own-modes')
const NAME_OVERRIDES = new Map<string, string>()

const PANE_RE = /^%\d+$/
/** A pty host instance (`PtyRuntimeRef.instance`): `p<protocol>`, or `p<protocol>-<build>` (ptyHost/instance.ts). */
const PTY_INSTANCE_RE = PTY_HOST_INSTANCE
const GROK_SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const AGENT_ENGINES: ReadonlySet<string> = new Set(ENGINES)

/**
 * A persisted `defaultName`, or undefined for anything that is not one.
 *
 * Used to be `agent-N` only. A creator can now name the agent (`agent_create`'s `name`), and a row
 * validated against the numbered shape alone dropped that name on the next load — the pane came
 * back titled `agent-3` after a daemon restart. Trimmed and bounded, so a row cannot carry a name
 * the header would draw as nothing, or one long enough to be a document.
 */
const MAX_DEFAULT_NAME_CHARS = 200
function normalizedDefaultName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const name = value.trim()
  return name && name.length <= MAX_DEFAULT_NAME_CHARS ? name : undefined
}

/** A persisted DSH id, or null for anything that is not one (older rows have no field at all). */
function normalizedDshId(value: unknown): string | null {
  return typeof value === 'string' && DSH_ID_RE.test(value) ? value : null
}

/** A persisted named agent, or null for anything that is not one — the same shape `agent_create`
 *  accepts, so a hand-edited row cannot put a path or prose into the relaunch argv. */
function normalizedAgentName(value: unknown): string | null {
  return typeof value === 'string' && AGENT_NAME_RE.test(value) ? value : null
}

/** A persisted permission mode, or null. Only its shape is checked here — the launch looks it up per
 *  engine (`permissionModeFlags`), and a name the engine lacks launches as `bypassPermission` says. */
function permissionModeName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z]{1,24}$/.test(value)
}

/** A persisted `lastOpenedAt`, or undefined for anything that is not a real moment (a row from before
 *  the field, or a hand-edited one) — undefined rather than 0, so "never opened" stays absent. */
function normalizedOpenedAt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function normalizedAgentEngine(value: unknown): AgentEngine {
  return typeof value === 'string' && AGENT_ENGINES.has(value)
    ? value as AgentEngine
    : 'claude'
}
function rowId(row: unknown): string {
  if (!row || typeof row !== 'object') return ''
  const candidate = row as { agentId?: unknown; launcherId?: unknown }
  return typeof candidate.agentId === 'string' && candidate.agentId
    ? candidate.agentId
    : typeof candidate.launcherId === 'string' ? candidate.launcherId : ''
}

// Key order carries no meaning but differs between load()'s literal, register(), strictPersistedRow and
// setters that add keys (`launch`); compared as JSON text it rewrote registry.json (lock, 3 fsyncs, rename)
// every 5 s on an unchanged row, ~720 writes/hour measured 2026-10-06. Array order still counts.
function rowFingerprint(row: unknown): string {
  return JSON.stringify(row, (_key, value) => {
    value = credentialEquality(value)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    // Admissions compare every row repeatedly; avoid a temporary entry array for every property.
    const ordered: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(value).sort()) ordered[key] = value[key]
    return ordered
  })
}

/** The new image is visible, but its directory has not confirmed durability yet. */
const BINDING_RECOVERY_HOLD = 'Waiting for native evidence after a concurrent binding write.'
export class RegistryOwnershipChanged extends IdentityReadUnavailable {}

/** Storage errors can quote file contents or paths. Only fixed categories cross this boundary. */
function persistenceFailure(error: unknown, names = false): Error {
  if (error instanceof IdentityReadUnavailable || error instanceof RegistryPersistenceUnavailable) return error
  const subject = names ? 'name storage' : 'registry storage'
  // A write unconfirmed after its rename (the folder's fsync) carries the disk's code on its cause.
  const code = (error instanceof AtomicWriteUnconfirmed ? error.cause as NodeJS.ErrnoException | undefined
    : error as NodeJS.ErrnoException | null)?.code
  // The master tells a full disk from a broken build by these codes (harnessd/supervisor.ts namesTheDisk).
  // Without them a good build whose core could not save on a full disk was rolled back
  // (e2e/updateHostile.e2e.ts, 2026-11-17). A code names no path.
  const category = error instanceof SyntaxError ? 'contains invalid JSON'
    : code === 'ENOSPC' || code === 'EDQUOT' ? `has no available space (${code})`
      : code === 'EROFS' ? 'is read-only (EROFS)'
        : code === 'EACCES' || code === 'EPERM' ? 'access was refused'
          : code === 'ENOENT' ? 'is unavailable'
            : code === 'ELOOP' ? 'has an unsafe file type' : 'write failed'
  const failure = new RegistryPersistenceUnavailable(`${subject} ${category}`)
  return error instanceof AtomicWriteUnconfirmed ? new AtomicWriteUnconfirmed(failure, error.retryable) : failure
}

export function atomicWriteJson(file: string, value: unknown, exclusive = false): void {
  const exists = hardenPrivateStateFileIfPresent(file)
  if (exclusive && exists) return
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  let renamed = false
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      writeFileSync(fd, JSON.stringify(value, null, 2))
      fchmodSync(fd, 0o600)
      fsyncSync(fd)
    } finally { closeSync(fd) }
    renameSync(temporary, file)
    renamed = true
    syncStateDirectory(dirname(file))
  } catch (error) {
    if (renamed) throw new AtomicWriteUnconfirmed(error)
    throw error
  } finally {
    if (!renamed) rmSync(temporary, { force: true })
  }
}

function boundedIdentityPart(value: unknown, max = 200): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
}

export function validTerminalRuntime(value: unknown): value is TerminalRuntimeRef {
  if (!value || typeof value !== 'object') return false
  const runtime = value as { backend?: unknown; paneId?: unknown; instance?: unknown }
  if (typeof runtime.paneId !== 'string' || !PANE_RE.test(runtime.paneId)) return false
  if (runtime.backend === 'tmux') return true
  return runtime.backend === 'ptyhost' && typeof runtime.instance === 'string' && PTY_INSTANCE_RE.test(runtime.instance)
}

function retiredRuntime(value: unknown): boolean {
  return !!value && typeof value === 'object' && (value as { backend?: unknown }).backend === 'herdr'
}

/**
 * Earlier builds could also place an agent in a Herdr pane. That backend is gone, so its runtimes are
 * dropped on read — the rest of the row is untouched, and a primary that named one falls to the first
 * remaining tmux route. Returns `null` for a row left with no terminal at all: nothing can reach it.
 * A row without a retired runtime is returned as is.
 */
function withoutRetiredRuntimes(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const row = value as Record<string, unknown>
  if (!Array.isArray(row.runtimes) || !row.runtimes.some(retiredRuntime)) return value
  const runtimes = row.runtimes.filter((runtime) => !retiredRuntime(runtime))
  const hasLegacyPane = typeof row.tmuxPane === 'string' && PANE_RE.test(row.tmuxPane)
  if (!runtimes.length && !hasLegacyPane) return null
  const { runtimes: _retired, ...rest } = row
  const cleaned: Record<string, unknown> = runtimes.length ? { ...rest, runtimes } : rest
  if (typeof row.primaryRuntimeKey === 'string' && row.primaryRuntimeKey.startsWith('herdr\u0000')) {
    const first = runtimes.find(validTerminalRuntime)
    cleaned.primaryRuntimeKey = first ? terminalRouteKey(first) : ''
  }
  // A v2 row always carries `runtimes`, even when only the legacy pane is left to fill it.
  if (!runtimes.length && Object.hasOwn(row, 'schemaVersion')) {
    const pane = { backend: 'tmux' as const, paneId: row.tmuxPane as string }
    cleaned.runtimes = [pane]
    cleaned.primaryRuntimeKey = terminalRouteKey(pane)
  }
  return cleaned
}

/** `withoutRetiredRuntimes` over a whole stored file, dropping the rows it empties. */
function withoutRetiredRows(stored: readonly unknown[]): { rows: unknown[]; dropped: number; changed: boolean } {
  const cleaned = stored.map(withoutRetiredRuntimes)
  const rows = cleaned.filter((row, i) => row !== null || stored[i] === null)
  return { rows, dropped: stored.length - rows.length, changed: cleaned.some((row, i) => row !== stored[i]) }
}

/**
 * Task #4215 (2026-11-07): until then Harness itself started every Swarm agent in full mode, and an older Buddy in `buddy` or
 * `readOnlyAsk`; nobody chose those, and a relaunch reapplies a saved mode. So the first load of a build with this clears them,
 * once (`OWN_MODES_FILE`): full mode a person chose afterwards is theirs and kept. The Swarm is gone (2026-11-14), but a machine
 * that has not loaded a build since still has those rows, Swarm role and all. Remove on or after 2027-01-07.
 */
function withoutForcedModes(rows: Array<Partial<RegisteredSession>>): { rows: Array<Partial<RegisteredSession>>; cleared: number } {
  let cleared = 0
  const kept = rows.map((row) => {
    const mode: unknown = row?.permissionMode
    const swarmRole: unknown = (row as { swarmSkill?: unknown })?.swarmSkill
    if (!(mode === 'buddy' || mode === 'readOnlyAsk' || (mode === 'full' && !!swarmRole && typeof swarmRole === 'object'))) return row
    cleared++
    const { permissionMode: _mode, bypassPermission: _bypass, ...own } = row
    return own
  })
  return { rows: kept, cleared }
}

/**
 * A row a build before the Swarm was deleted (2026-11-14) saved may still name its Swarm role (`swarmSkill`). One the Swarm
 * started, a Claude Code or Codex agent with no mode, comes back in Auto-approve, the mode every Swarm agent had since
 * 2026-11-12 and a new agent in a tab has. With no mode, discovery would read its mode back off a pane Harness may have
 * started in full mode before task #4215, and a restart or an Open would skip permissions again. Every other row is as it
 * was. The role goes at the row's next write (`strictPersistedRow`), so this applies once. Remove on or after 2027-01-07.
 */
function withRetiredSwarmMode<T extends Partial<RegisteredSession>>(row: T): T {
  const swarmRole: unknown = (row as { swarmSkill?: unknown })?.swarmSkill
  if (!swarmRole || typeof swarmRole !== 'object' || row.permissionMode != null || (row.engine !== 'claude' && row.engine !== 'codex')
    || row.startedBy !== 'agent' || row.parentAgentId) return row
  return { ...row, permissionMode: 'auto', bypassPermission: true }
}

/** A legacy `tmuxPane` adds a tmux runtime unless it is a listed runtime's own projection (`paneProjection`). */
function normalizedRuntimes(raw: unknown, legacyTmuxPane?: unknown): TerminalRuntimeRef[] {
  const fromArray = Array.isArray(raw) ? raw.filter(validTerminalRuntime) : []
  const legacy = typeof legacyTmuxPane === 'string' && PANE_RE.test(legacyTmuxPane)
    && !fromArray.some((runtime) => runtime.paneId === legacyTmuxPane)
    ? [{ backend: 'tmux' as const, paneId: legacyTmuxPane }]
    : []
  return mergeTerminalRuntimes([], [...fromArray, ...legacy])
}

/** The legacy `tmuxPane` field: the primary runtime's pane, whatever its backend. */
function paneProjection(runtimes: readonly TerminalRuntimeRef[]): string {
  return runtimes.length ? primaryRuntime({ runtimes }).paneId : ''
}

function persistedRow(entry: RegisteredSession): RegisteredSession | Omit<RegisteredSession, 'tmuxPane'> {
  const { identityHold: _hold, evidenceRevision: _revision, interpretationHold: _interpretation, admissionHold: _admission, ...saved } = entry
  if (saved.tmuxPane) return { ...saved, runtimes: saved.runtimes.map((runtime) => ({ ...runtime })) }
  const { tmuxPane: _legacy, ...row } = saved
  return { ...row, runtimes: row.runtimes.map((runtime) => ({ ...runtime })) }
}

export function strictPersistedRow(raw: unknown): RegisteredSession | null {
  const value = withoutRetiredRuntimes(raw)
  if (!value || typeof value !== 'object') return null
  const row = withRetiredSwarmMode(value as Partial<RegisteredSession>)
  const runtimes = normalizedRuntimes(row.runtimes, row.tmuxPane)
  const primary = typeof row.primaryRuntimeKey === 'string' ? row.primaryRuntimeKey : ''
  const normalizedPrimary = selectedRuntimeKey(runtimes, primary)
  const active = row.active === true
  const projectedTmuxPane = paneProjection(runtimes)
  const launch = normalizedLaunch(row.launch)
  const externalResume = row.externalResume === undefined ? undefined : parseExternalResume(row.externalResume)
  if (row.schemaVersion !== 2
    || typeof row.active !== 'boolean'
    || externalResume === null || externalResume && externalResume.request.engine !== row.engine
    || externalResume && externalResumePending(externalResume) && (row.sessionId !== '' || row.processIdentity !== null || launch?.state !== 'held')
    || typeof row.agentId !== 'string' || !row.agentId
    || typeof row.sessionId !== 'string'
    || typeof row.engine !== 'string' || !AGENT_ENGINES.has(row.engine as AgentEngine)
    || typeof row.projectDir !== 'string'
    || typeof row.primaryRuntimeKey !== 'string'
    || !Array.isArray(row.runtimes) || runtimes.length !== row.runtimes.length || !runtimes.length
    || (projectedTmuxPane ? row.tmuxPane !== projectedTmuxPane : row.tmuxPane !== undefined)
    || (primary !== '' && !runtimes.some((runtime) => terminalRouteKey(runtime) === primary))
    // Older dormant rows intentionally persisted an empty primary. Accept and repair those once; new
    // rows keep terminal routing independent from engine activity.
    || (active && primary === '')
    || (row.processIdentity !== null && !validProcessIdentity(row.processIdentity))) return null
  const placements = runtimes.map(terminalPlacementKey)
  if (new Set(placements).size !== placements.length) return null
  // Taken out of the spread and put back only when it is a real moment: the spread would otherwise
  // carry a hand-edited string or a negative number straight into the frame's `toISOString()`.
  // `forkedFrom` is out too, so an invalid one is dropped rather than spread back in as-is.
  // `swarmSkill` is a Swarm role a build before the Swarm was deleted (2026-11-14) saved: dropped, and gone from the file at
  // its next write. Remove it from here on or after 2027-01-14.
  const { gridLaunch: rawGridLaunch, identityHold: _identityHold, evidenceRevision: _revision, interpretationHold: _interpretation, admissionHold: _admission, lastOpenedAt: rawOpenedAt, closePlan: rawClosePlan, forkedFrom: rawForkedFrom, scmLaunch: rawScmLaunch, launchModel: rawLaunchModel, externalResume: _externalResume, startedBy: rawStartedBy, parentAgentId: rawParentAgentId, launchArgs: rawLaunchArgs, browser: rawBrowser, quietTitle: rawQuietTitle, firstTask: rawFirstTask, openclawLocal: rawOpenclawLocal, earlierSessionIds: rawEarlierSessionIds, hermesHomeDerived: _hermesHomeDerived, swarmSkill: _retiredSwarmSkill, ...rest } = row as Partial<RegisteredSession> & { swarmSkill?: unknown }
  const lastOpenedAt = normalizedOpenedAt(rawOpenedAt)
  // Out of the spread for the same reason: a half-formed record is dropped, never relaunched with.
  const scmLaunch = parseScmLaunchRecord(rawScmLaunch)
  const launchModel = storedLaunchModel(rawLaunchModel)
  const launchArgs = storedLaunchArgs(rawLaunchArgs)
  const firstTask = storedFirstTask(rawFirstTask)
  const openclawLocal = storedOpenclawLocal(rawOpenclawLocal)
  const earlierSessionIds = earlierSessionKeys(rawEarlierSessionIds)
  return {
    ...rest,
    gridLaunch: normalizedGridLaunch(rawGridLaunch),
    ...(externalResume ? { externalResume } : {}),
    ...(firstTask ? { firstTask } : {}),
    ...(openclawLocal ? { openclawLocal } : {}),
    ...(earlierSessionIds ? { earlierSessionIds } : {}),
    ...storedHermesHomeDerived(row),
    ...(scmLaunch ? { scmLaunch } : {}),
    ...(launchModel ? { launchModel } : {}),
    ...(launchArgs ? { launchArgs } : {}),
    ...(rawBrowser === true ? { browser: true as const } : {}),
    ...(typeof rawQuietTitle === 'string' && rawQuietTitle ? { quietTitle: rawQuietTitle } : {}),
    ...(normalizedClosePlan(rawClosePlan) ? { closePlan: normalizedClosePlan(rawClosePlan)! } : {}),
    schemaVersion: 2,
    active,
    ...(launch ? { launch } : {}),
    agentId: row.agentId,
    sessionId: row.sessionId,
    boundAt: typeof row.boundAt === 'number' ? row.boundAt : null,
    engine: row.engine as AgentEngine,
    transcriptPath: typeof row.transcriptPath === 'string' ? row.transcriptPath : null,
    projectDir: row.projectDir,
    defaultName: normalizedDefaultName(row.defaultName),
    agent: normalizedAgentName((row as { agent?: unknown }).agent),
    ...normalizedForkedFrom(rawForkedFrom),
    // Out of the spread too: only `agent` is a harness another agent started; anything else is the person's.
    ...(rawStartedBy === 'agent' ? { startedBy: 'agent' as const } : {}),
    ...normalizedParent(rawStartedBy, rawParentAgentId),
    cwd: typeof row.cwd === 'string' ? row.cwd : null,
    runtimes,
    primaryRuntimeKey: normalizedPrimary,
    tmuxPane: projectedTmuxPane,
    source: typeof row.source === 'string' ? row.source : null,
    title: typeof row.title === 'string' ? row.title : null,
    model: modelString(row.model),
    cliVersion: typeof row.cliVersion === 'string' ? row.cliVersion : null,
    processIdentity: row.processIdentity ?? null,
    ...(row.terminalHost === true || row.engine === 'terminal' ? { terminalHost: true } : {}),
    registeredAt: typeof row.registeredAt === 'number' ? row.registeredAt : Date.now(),
    touchedAt: savedTouchedAt(row) ?? Date.now(),
    lastHookAt: typeof row.lastHookAt === 'number' ? row.lastHookAt : Date.now(),
    lastTranscriptAt: typeof row.lastTranscriptAt === 'number' ? row.lastTranscriptAt : Date.now(),
    ...(lastOpenedAt !== undefined ? { lastOpenedAt } : {}),
  }
}

/**
 * An agent id as a harness that started another is named by (`parentAgentId`): one word, never a path. The registry's
 * own ids are uuids; the bound only keeps a hand-edited row from carrying anything else into every frame.
 */
export function parentAgentIdOf(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ? value : null
}

/** Only a non-empty array of strings is a saved flag list; anything else on disk is dropped, never launched with. */
function storedLaunchArgs(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length > 0 && value.every(w => typeof w === 'string') ? [...value] : undefined
}

/** Only a non-empty string is a saved first task; anything else on disk is dropped, never typed into a pane. */
function storedFirstTask(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/** The mark is kept only as `true` beside a home: anything else on disk is dropped, and the home is exported as before. */
function storedHermesHomeDerived(row: { hermesHome?: unknown; hermesHomeDerived?: unknown }): { hermesHomeDerived: true } | Record<string, never> {
  return row.hermesHomeDerived === true && typeof row.hermesHome === 'string' && row.hermesHome ? { hermesHomeDerived: true } : {}
}

/**
 * [row] with [from]'s Hermes home, by the rule `register` keeps: the mark goes with the home it was set with, kept from
 * either row while the home is the same, never left beside another home (RegisteredSession.hermesHomeDerived). A home
 * copied without its mark would be exported on a resume, the daemon's path of it inside a remapped sandbox.
 */
export function withHermesHome<T extends RegisteredSession>(row: T, from: Pick<RegisteredSession, 'hermesHome' | 'hermesHomeDerived'>): T {
  const { hermesHomeDerived: _mark, ...rest } = row
  const derived = !!from.hermesHome && (from.hermesHomeDerived || from.hermesHome === row.hermesHome && row.hermesHomeDerived)
  return { ...rest, hermesHome: from.hermesHome, ...(derived ? { hermesHomeDerived: true as const } : {}) } as T
}

/** Only a non-empty string is a saved `--local` folder. */
function storedOpenclawLocal(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

const EARLIER_SESSIONS_MAX = 32

/**
 * The session keys a row moved off, with [movedOff] put at the front: newest first, each a non-empty key of at most
 * 256 characters, once, at most EARLIER_SESSIONS_MAX. Anything else on disk is dropped.
 */
function earlierSessionKeys(value: unknown, movedOff?: string | null): string[] | undefined {
  const keys = [movedOff, ...Array.isArray(value) ? value : []]
    .filter((key): key is string => typeof key === 'string' && key.length > 0 && key.length <= 256)
  const kept = [...new Set(keys)].slice(0, EARLIER_SESSIONS_MAX)
  return kept.length ? kept : undefined
}

/** Says a first task is on the agent's row, by the agent's short id only: the task is the person's words. */
function firstTaskKept(agentId: string): void {
  console.log(`[agent] ${sid(agentId)} first task kept`)
}

/** `parentAgentId` as a row keeps it: only beside `startedBy: 'agent'`, and only an agent id. */
function normalizedParent(startedBy: unknown, value: unknown): { parentAgentId: string } | Record<string, never> {
  const parentAgentId = startedBy === 'agent' ? parentAgentIdOf(value) : null
  return parentAgentId ? { parentAgentId } : {}
}

/**
 * Where a fork came from. `sessionId` / `transcriptPath` are the PARENT's conversation at the moment of the
 * fork; they let a fork that has not started its own conversation yet still say whose history it carries.
 * Both are absent on forks recorded before the fields existed, and on forks of an unbound parent.
 */
export interface ForkOrigin {
  agentId: string
  name: string
  sessionId?: string
  transcriptPath?: string
}

const FORK_SESSION_ID_MAX = 256
const FORK_TRANSCRIPT_PATH_MAX = 4096

/**
 * `forkedFrom` as written by this daemon, or nothing: a row from before the field, or a hand-edited one.
 * Rebuilt key by key so nothing unknown rides along; a transcript path is kept only with its session id.
 */
function normalizedForkedFrom(value: unknown): { forkedFrom: ForkOrigin } | Record<string, never> {
  if (!value || typeof value !== 'object') return {}
  const v = value as { agentId?: unknown; name?: unknown; sessionId?: unknown; transcriptPath?: unknown }
  if (typeof v.agentId !== 'string' || !v.agentId) return {}
  const sessionId = typeof v.sessionId === 'string' && v.sessionId.length > 0 && v.sessionId.length <= FORK_SESSION_ID_MAX
    ? v.sessionId : null
  const transcriptPath = sessionId && typeof v.transcriptPath === 'string'
    && v.transcriptPath.length <= FORK_TRANSCRIPT_PATH_MAX && isAbsolute(v.transcriptPath)
    ? v.transcriptPath : null
  return {
    forkedFrom: {
      agentId: v.agentId,
      name: typeof v.name === 'string' ? v.name.slice(0, 120) : '',
      ...(sessionId ? { sessionId } : {}),
      ...(sessionId && transcriptPath ? { transcriptPath } : {}),
    },
  }
}

function normalizedLaunch(value: unknown): AgentLaunch | undefined {
  if (!value || typeof value !== 'object') return undefined
  const launch = value as { state?: unknown; error?: unknown; detail?: unknown }
  const token = (value as { nativeToken?: unknown }).nativeToken
  const nativeToken = typeof token === 'string' && /^[a-f0-9-]{36}$/.test(token) ? token : undefined
  if (launch.state === 'starting' || launch.state === 'ready') return { state: launch.state, ...(launch.state === 'starting' && nativeToken ? { nativeToken } : {}) }
  if (launch.state === 'held') {
    const held = value as { service?: unknown; detail?: unknown }
    if (typeof held.service !== 'string' || !/^[a-z][a-z-]{0,39}$/.test(held.service) || typeof held.detail !== 'string') return undefined
    return { state: 'held', service: held.service, detail: held.detail.slice(0, 500), ...(nativeToken ? { nativeToken } : {}) }
  }
  if (launch.state !== 'failed' || typeof launch.error !== 'string' || !launch.error) return undefined
  const error = launch.error.slice(0, 80)
  const detail = typeof launch.detail === 'string' && launch.detail
    ? launch.detail.slice(0, 500)
    : undefined
  return { state: 'failed', error, ...(detail ? { detail } : {}) }
}

function normalizedClosePlan(value: unknown): RegisteredSession['closePlan'] {
  if (!value || typeof value !== 'object') return undefined
  const plan = value as Partial<NonNullable<RegisteredSession['closePlan']>>
  if ((plan.state !== 'waiting' && plan.state !== 'failed') || typeof plan.id !== 'string' || !/^[a-f0-9-]{36}$/.test(plan.id)
    || typeof plan.identity !== 'string'
    || !plan.identity || plan.identity.length > 8192 || typeof plan.requestedAt !== 'number'
    || !Number.isFinite(plan.requestedAt) || plan.requestedAt < 0) return undefined
  return { id: plan.id, state: plan.state, identity: plan.identity, requestedAt: plan.requestedAt,
    ...(typeof plan.detail === 'string' ? { detail: plan.detail.slice(0, 500) } : {}) }
}

function validatedRows(values: readonly unknown[], normalize: typeof strictPersistedRow = strictPersistedRow): RegisteredSession[] | null {
  const rows: RegisteredSession[] = []
  const agents = new Set<string>()
  const sessions = new Set<string>()
  const provisionalSessions = new Set<string>()
  const processes = new Set<string>()
  const routes = new Set<string>()
  for (const value of values) {
    const row = normalize(value)
    if (!row || agents.has(row.agentId)) return null
    agents.add(row.agentId)
    // A waiting adoption is an intention, not ownership. A real hook may bind while search is
    // unavailable; that fact holds the intention without surrendering the process's binding.
    const claimed = externalResumePending(row.externalResume) ? provisionalSessions : sessions
    for (const id of new Set(externalReservations(row))) {
      if (claimed.has(id)) return null
      claimed.add(id)
    }
    if (row.processIdentity) {
      const key = processIdentityKey(row.engine, row.processIdentity)
      if (processes.has(key)) return null
      processes.add(key)
    }
    for (const runtime of row.runtimes) {
      const key = terminalRouteKey(runtime)
      if (routes.has(key)) return null
      routes.add(key)
    }
    rows.push(row)
  }
  return rows
}

function hasUnknownRowSchema(value: unknown): boolean {
  return !!value && typeof value === 'object'
    && Object.hasOwn(value, 'schemaVersion')
    && (value as { schemaVersion?: unknown }).schemaVersion !== 2
}

function validLegacyRegistryRow(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.hasOwn(value, 'schemaVersion')) return false
  const row = value as Partial<RegisteredSession>
  const id = rowId(row)
  if (!boundedIdentityPart(id)) return false
  if (row.engine !== undefined && (typeof row.engine !== 'string' || !AGENT_ENGINES.has(row.engine))) return false
  if (row.tmuxPane !== undefined && (typeof row.tmuxPane !== 'string' || !PANE_RE.test(row.tmuxPane))) return false
  if (row.runtimes !== undefined
    && (!Array.isArray(row.runtimes) || !row.runtimes.length || !row.runtimes.every(validTerminalRuntime))) return false
  return normalizedRuntimes(row.runtimes, row.tmuxPane).length > 0
}

function threeWayRow(
  baselineJson: string | undefined,
  current: Record<string, unknown>,
  latest: Record<string, unknown>,
): Record<string, unknown> {
  let baseline: Record<string, unknown> = {}
  try { baseline = baselineJson ? JSON.parse(baselineJson) as Record<string, unknown> : {} } catch { /* empty */ }
  const merged: Record<string, unknown> = { ...latest }
  for (const key of Object.keys(baseline)) {
    if (!(key in current)) delete merged[key]
  }
  for (const [key, value] of Object.entries(current)) {
    if (rowFingerprint(value) !== rowFingerprint(baseline[key])) merged[key] = value
  }
  return merged
}

/** `candidate` with each intended field as `current` has it: set, or removed when `current` has none. */
function withIntended(
  candidate: Record<string, unknown>,
  current: Record<string, unknown>,
  intended: ReadonlySet<string>,
): Record<string, unknown> {
  const row = { ...candidate }
  for (const key of intended) {
    if (Object.hasOwn(current, key)) row[key] = current[key]
    else delete row[key]
  }
  return row
}

/**
 * The rows a merge holds, found by what they share: the process's pid, the conversation, each pane. A
 * row another row claims leaves the merge; these are the only rows that can be claimed, so a save looks
 * them up instead of comparing a changed row with every row. Comparing every pair is what made the first
 * start on a fully legacy registry (every row changed) quadratic: 20.7 s for 2,000 rows and 122 s for
 * 5,000 on the core's event loop; 0.32 s and 0.74 s looked up, the saved file byte for byte the same
 * (measured 2026-10-08).
 */
class MergeIdentities {
  /** A row's place in the merge's Map order, which the claims follow: a claim can carry a binding over. */
  private readonly order = new Map<string, number>()
  private nextOrder = 0
  private readonly strict = new Map<string, RegisteredSession>()
  private readonly holders = new Map<string, Set<string>>()

  constructor(rows: ReadonlyMap<string, Record<string, unknown>>, private readonly normalize: typeof strictPersistedRow = strictPersistedRow) {
    for (const [id, row] of rows) this.put(id, row)
  }

  private static keys(row: RegisteredSession): string[] {
    return [
      ...(row.processIdentity ? [`p:${row.processIdentity.pid}`] : []),
      ...(row.sessionId ? [`s:${row.sessionId}`] : []),
      ...row.runtimes.map((runtime) => `r:${terminalRouteKey(runtime)}`),
    ]
  }

  /** Follows `merged.set`: a row already in the merge keeps its place, a new one goes last. */
  put(id: string, value: Record<string, unknown>): void {
    this.remove(id, true)
    if (!this.order.has(id)) this.order.set(id, this.nextOrder++)
    // A row that is not a valid v2 row claims nothing and is claimed by nothing, as before. Parsed once
    // here rather than once per pair: what a claim reads of it, its identity and binding, is the row's own.
    const row = this.normalize(value)
    if (!row) return
    this.strict.set(id, row)
    for (const key of MergeIdentities.keys(row)) {
      const holders = this.holders.get(key)
      if (holders) holders.add(id)
      else this.holders.set(key, new Set([id]))
    }
  }

  /** Follows `merged.delete`. */
  remove(id: string, keepPlace = false): void {
    const row = this.strict.get(id)
    if (row) {
      this.strict.delete(id)
      for (const key of MergeIdentities.keys(row)) this.holders.get(key)?.delete(id)
    }
    if (!keepPlace) this.order.delete(id)
  }

  /** Every other valid row with the pid, the conversation or a pane, in the merge's order. */
  sharing(id: string, pid: number | undefined, sessionId: string, routes: ReadonlySet<string>): Array<[string, RegisteredSession]> {
    const keys = [
      ...(pid !== undefined ? [`p:${pid}`] : []),
      ...(sessionId ? [`s:${sessionId}`] : []),
      ...[...routes].map((route) => `r:${route}`),
    ]
    const ids = new Set<string>()
    for (const key of keys) for (const holder of this.holders.get(key) ?? []) if (holder !== id) ids.add(holder)
    return [...ids]
      .sort((a, b) => this.order.get(a)! - this.order.get(b)!)
      .map((holder) => [holder, this.strict.get(holder)!])
  }
}

/**
 * What a save writes: the file's rows as `latest` has them, with this view's changes merged in. A row this
 * view saved and has since dropped leaves; a changed row is merged three ways against what this view last
 * saved; and a changed row claims its process, conversation and panes from every other row, which leaves.
 * The result's order is the file's, with new rows last.
 */
export function mergedForSave(
  latest: ReadonlyMap<string, Record<string, unknown>>,
  currentRows: ReadonlyMap<string, Record<string, unknown>>,
  baselines: ReadonlyMap<string, string>,
  intents: ReadonlyMap<string, ReadonlySet<string>>,
  fingerprint: (row: Record<string, unknown>) => string = rowFingerprint,
  identities?: MergeIdentities,
  normalize: typeof strictPersistedRow = strictPersistedRow,
): Map<string, Record<string, unknown>> {
  const merged = new Map(latest)
  for (const baselineId of baselines.keys()) {
    if (!currentRows.has(baselineId)) {
      merged.delete(baselineId)
      identities?.remove(baselineId)
    }
  }
  // Preparation may transfer its index of the same private latest table. Otherwise build on the first
  // changed row, as the scan first read rows then: an unchanged save needs no index.
  for (const [agentId, current] of currentRows) {
    const baseline = baselines.get(agentId)
    const intended = intents.get(agentId)
    // An intent on a row this view otherwise left alone never brings back a row another process
    // removed: that agent is gone, and its close plan with it.
    if (baseline !== undefined && baseline === fingerprint(current) && (!intended || !latest.has(agentId))) continue
    let candidate = latest.has(agentId)
      ? threeWayRow(baseline, current, latest.get(agentId)!)
      : current
    if (intended) candidate = withIntended(candidate, current, intended)
    const process = normalize(candidate)?.processIdentity
    const engine = candidate.engine
    const sessionId = typeof candidate.sessionId === 'string' ? candidate.sessionId : ''
    const routes = new Set(normalizedRuntimes(candidate.runtimes, candidate.tmuxPane).map(terminalRouteKey))
    identities ??= new MergeIdentities(merged, normalize)
    for (const [otherId, otherRow] of identities.sharing(agentId, process?.pid, sessionId, routes)) {
      const sameProcess = otherRow.engine === engine && sameProcessIdentity(process, otherRow.processIdentity)
      const sameSession = !!sessionId && otherRow.sessionId === sessionId
      const sameRoute = otherRow.runtimes.some((runtime) => routes.has(terminalRouteKey(runtime)))
      // Sharing a pid is not yet the same process: the engine and the start must match too.
      if (!sameProcess && !sameSession && !sameRoute) continue
      // A daemon-down hook may bind a session while startup discovery is opening the same process.
      // Preserve that binding, then let the scanner-owned agent id/runtime state win deterministically.
      if (sameProcess && !candidate.sessionId && otherRow.sessionId) {
        candidate = {
          ...candidate,
          sessionId: otherRow.sessionId,
          boundAt: otherRow.boundAt,
          transcriptPath: otherRow.transcriptPath,
          source: otherRow.source,
          lastHookAt: otherRow.lastHookAt,
        }
      }
      merged.delete(otherId)
      identities.remove(otherId)
    }
    merged.set(agentId, candidate)
    identities.put(agentId, candidate)
  }
  return merged
}

/** The merge's helpers, for its spec, which checks it against the scan of every pair it replaced. */
export const saveMergeHelpers = { threeWayRow, withIntended, normalizedRuntimes, rowFingerprint }

function selectedRuntimeKey(runtimes: readonly TerminalRuntimeRef[], requested: unknown): string {
  const keys = new Set(runtimes.map(terminalRouteKey))
  return typeof requested === 'string' && keys.has(requested)
    ? requested
    : runtimes[0] ? terminalRouteKey(runtimes[0]) : ''
}

function isWithin(root: string, file: string): boolean {
  const rel = relative(root, file)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`/`) && !rel.startsWith(`\\`))
}

/**
 * The folders an engine's transcripts may be in: its own, and for an engine with a declared session store each
 * home the person moved in their shell profile (lib/engineHomes.ts). An agent's own profile (its CODEX_HOME) is
 * its only one, for an engine whose sessions follow one.
 */
function transcriptRoots(engine: AgentEngine, root: (() => string) | 'store', codexHome?: string, snapshot?: EngineHomeSnapshot): string[] {
  return root === 'store' ? sessionRoots(engine, codexHome, snapshot) : [root()]
}

export function validTranscriptPath(engine: AgentEngine, filePath: string, codexHome?: string, allowMissing = false): boolean {
  return checkTranscriptPath(engine, filePath, codexHome, allowMissing, false)
}

/** Existing control candidates: an unreadable path cannot be excluded from a complete identity pool. */
export function inspectTranscriptPath(engine: AgentEngine, filePath: string, codexHome?: string, allowMissing = false): boolean {
  const proof = transcriptEvidence(engine, filePath, codexHome, allowMissing)
  proof.verify()
  return proof.valid
}

function checkTranscriptPath(engine: AgentEngine, filePath: string, codexHome: string | undefined, allowMissing: boolean, strict: boolean, snapshot?: EngineHomeSnapshot): boolean {
  const rootFor = TRANSCRIPT_ROOT[engine]
  if (!rootFor) return false
  try {
    const missing = allowMissing && !existsSync(filePath)
    const actual = missing ? join(realpathSync(dirname(filePath)), basename(filePath)) : realpathSync(filePath)
    const within = (root: string): boolean => {
      try { return isWithin(realpathSync(root), actual) }
      catch (error) { if (strict) throw error; return false }
    }
    const st = statSync(missing ? dirname(actual) : actual)
    if (!(missing ? st.isDirectory() : st.isFile()) || !transcriptRoots(engine, rootFor, codexHome, snapshot).some(within)) return false
    if (engine === 'cursor') {
      const id = basename(actual).replace(/\.jsonl$/, '')
      if (!id || basename(dirname(actual)) !== id || basename(dirname(dirname(actual))) !== 'agent-transcripts') return false
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    return uid === null || st.uid === uid
  } catch {
    if (strict) throw new IdentityReadUnavailable('the transcript path could not be validated')
    return false
  }
}

/** The boot the registry was last loaded in (lib/bootId.ts says how a boot is named). */
function readSavedBoot(): string | null {
  try {
    const raw = readPrivateStateFile(BOOT_FILE, 256).trim()
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as unknown
      return typeof parsed === 'string' ? parsed : raw
    } catch { return raw }
  } catch { return null }
}
function writeBoot(bootId: string): void {
  try {
    secureStateDirectory(env.ADAPTER_DATA_DIR)
    atomicWriteJson(BOOT_FILE, bootId)
  } catch { /* registry load will remain conservative on the next restart */ }
}

class Registry {
  /** agentId → record. The store. */
  private agents = new Map<string, RegisteredSession>()
  private evidenceRevision = 0
  /** engine sessionId → agentId. Needed because web and device address turn control with a bare
   *  `sessionId` (`cancel`, `question_response`, `compact`, `session_get`) while everything else
   *  addresses the agent. `resolve()` is the one lookup that accepts either. */
  private sessionIndex = new Map<string, string>()
  /** backend-scoped route → agentId. */
  private runtimeIndex = new Map<string, string>()
  /** engine + PID start marker → agentId. This is authoritative across nested multiplexers. */
  private processIndex = new Map<string, string>()
  /**
   * Ephemeral terminal liveness, deliberately not persisted. A locator loaded from disk is only a hint
   * until this daemon has seen the backend placement again. Engine activity and terminal availability
   * are separate: a trust/setup/shell prompt can remain viewable after the engine process goes dormant.
   */
  private terminalAvailableAgents = new Set<string>()
  private readonly writer = new RegistryWriteQueue()
  private loading: Promise<void> | undefined
  private initializing = false
  private exiting = false

  private assertReady(): void {
    // Prior admitted writes can still read the complete old view while the queue
    // drains. Once load starts replacing it, no public reader sees staged rows.
    if (this.initializing) throw new RegistryPersistenceUnavailable('registry is initializing')
  }

  private assertOpen(): void {
    this.writer.assertOpen()
    if (this.exiting) throw new RegistryPersistenceUnavailable('registry is closing')
    if (this.loading) throw new RegistryPersistenceUnavailable('registry is initializing')
  }
  private withGridRecord<T>(row: { agentId: string; registeredAt: number }, record: GridLaunchRecord | null | undefined,
    apply: (record: { override: StoredGridLaunch; webSearch: GridWebSearchStatus } | null | undefined) => Promise<T>): Promise<T> {
    if (!record) return apply(record)
    return sessionStorage.withImport(row, record.override, override => apply({ override, webSearch: record.webSearch }))
  }
  private pendingObservation: Promise<void> | undefined
  private transactionCompletion: Promise<void> = Promise.resolve()
  private transactionDepth = 0
  private savePending = false
  private readonly afterTransactionCallbacks: Array<{ run: () => void; reject: (error: unknown) => void }> = []
  /** Root corruption/unknown schemas are read-only until the operator restores valid bytes. */
  private writeBlocked = false
  /** Last committed row bytes, used for a three-way merge with daemon-down hook writes. */
  private persistedBaseline = new Map<string, string>()
  /** Exact bytes of our last durable save; checked against the file, never just its mtime. */
  private persistedContents: SessionImageProof | null = null
  // A post-rename failure is not absence. Only the same immutable binding intent,
  // unchanged local owners and these exact affected rows can confirm that write.
  private unconfirmedBinding: { image: ReturnType<typeof persistedRow>[]; prior: unknown[]; before: Map<string, string>;
    agentId: string; intent: string | null; affected: Set<string>; source: SessionImageSource } | null = null
  /**
   * Fields a caller set on purpose since the last save, by agent: written as they are now, whatever the
   * file says. The merge alone keeps the file's value wherever this view matches what it last saved, so
   * a view that had never seen another process's close plan matched while cancelling it: the cancel was
   * dropped and the plan stayed (CI's registry-observation contract, 2026-10-05). A close retried over
   * another process's cancel was dropped the same way.
   */
  private intended = new Map<string, Set<string>>()
  private rebooted = false

  /** True when the last `load()` found the machine had rebooted since the previous daemon run. */
  get rebootedSinceLastRun(): boolean {
    this.assertReady()
    return this.rebooted
  }

  /**
   * Told the engine of every session as it enters: loaded, registered, opened or adopted. The core starts
   * loading what that engine's sessions read in its own process then (engines/inProcess.ts `preloadEngine`),
   * so that nothing the session does later waits for an import. Unset outside the core.
   */
  onEnter: ((engine: AgentEngine) => void) | null = null

  private index(entry: RegisteredSession, notify = true): void {
    this.agents.set(entry.agentId, entry)
    if (entry.sessionId) this.sessionIndex.set(entry.sessionId, entry.agentId)
    for (const runtime of entry.runtimes) this.runtimeIndex.set(terminalRouteKey(runtime), entry.agentId)
    if (entry.processIdentity) this.processIndex.set(processIdentityKey(entry.engine, entry.processIdentity), entry.agentId)
    if (notify) this.entered(entry.engine)
  }

  private entered(engine: AgentEngine): void {
    if (this.initializing || this.exiting) return
    try { this.onEnter?.(engine) }
    catch (error) { console.warn('[registry] engine entry notification failed:', error) }
  }

  private drop(entry: RegisteredSession | undefined): void {
    if (!entry) return
    this.agents.delete(entry.agentId)
    if (entry.sessionId && this.sessionIndex.get(entry.sessionId) === entry.agentId) {
      this.sessionIndex.delete(entry.sessionId)
    }
    for (const runtime of entry.runtimes) {
      const key = terminalRouteKey(runtime)
      if (this.runtimeIndex.get(key) === entry.agentId) this.runtimeIndex.delete(key)
    }
    if (entry.processIdentity) {
      const key = processIdentityKey(entry.engine, entry.processIdentity)
      if (this.processIndex.get(key) === entry.agentId) this.processIndex.delete(key)
    }
  }

  private clearBinding(entry: RegisteredSession): void {
    delete entry.identityHold
    delete entry.interpretationHold
    entry.evidenceRevision = ++this.evidenceRevision
    entry.sessionId = ''
    entry.boundAt = null
    entry.transcriptPath = null
    entry.source = null
    entry.lastTranscriptAt = Date.now()
  }

  /** Load persisted process agents. Invalid session bindings are released without dropping their agent.
   *  A reboot keeps every row but clears its process identity and marks it dormant: no process survives
   *  a reboot, but the agent — its id, cwd, session and pane placement — is what `restoreAgents` rebuilds
   *  a pane for. */
  load(): Promise<void> {
    if (this.loading) return this.loading
    try {
      this.assertOpen()
      if (this.transactionDepth) throw new RegistryPersistenceUnavailable('registry has an unfinished transaction')
    } catch (error) { return Promise.reject(error) }
    const loading = this.loadState().then(() => {
      this.initializing = false
      for (const row of this.agents.values()) this.entered(row.engine)
    }, error => {
      this.agents.clear(); this.sessionIndex.clear(); this.runtimeIndex.clear(); this.processIndex.clear()
      this.writeBlocked = true
      this.initializing = false
      throw error
    })
    this.loading = loading
    const settled = () => { if (this.loading === loading) this.loading = undefined }
    void loading.then(settled, settled)
    return loading
  }

  private async loadState(): Promise<void> {
    // A reload cannot clear a prior publication while its I/O still owns the queue.
    await this.writer.run(async () => {})
    await this.unconfirmedBinding?.source.release()
    this.initializing = true
    this.agents.clear()
    this.sessionIndex.clear()
    this.runtimeIndex.clear()
    this.processIndex.clear()
    this.terminalAvailableAgents.clear()
    this.writeBlocked = false
    this.rebooted = false
    this.persistedBaseline.clear()
    this.persistedContents = null
    this.unconfirmedBinding = null
    this.intended.clear()
    try {
      secureStateDirectory(env.ADAPTER_DATA_DIR)
    } catch (error) {
      this.writeBlocked = true
      console.error('[registry] unsafe state directory; refusing to load or write state:', error)
      return
    }
    await this.loadNames()
    const savedBoot = readSavedBoot()
    const bootId = currentBootId()
    const rebooted = bootChanged(savedBoot, bootId)
    let originalContents: SessionImageProof | undefined
    try {
      const image = await sessionStorage.read({ kind: 'registry' })
      if (image.state === 'missing') throw Object.assign(new Error('registry is absent'), { code: 'ENOENT' })
      originalContents = image.proof
      if (!image.json) {
        await this.quarantine('is not JSON', image.proof)
        return
      }
      const stored = image.value
      if (!Array.isArray(stored)) {
        await this.quarantine('root is not an array', originalContents)
        return
      }
      const { rows: parsed, dropped, changed: strippedRetired } = withoutRetiredRows(stored)
      if (dropped) console.log(`[registry] dropped ${dropped} agent(s) that lived only in a retired Herdr terminal`)
      if (parsed.some(hasUnknownRowSchema) || parsed.some(value => !!value && typeof value === 'object'
        && Object.hasOwn(value, 'externalResume') && !strictPersistedRow(value))) {
        this.writeBlocked = true
        console.error('[registry] registry contains an unknown row schema; refusing to overwrite it')
        return
      }
      const legacyRows = parsed.filter((row) => !row || typeof row !== 'object' || !Object.hasOwn(row, 'schemaVersion'))
      if (legacyRows.some((row) => !validLegacyRegistryRow(row))) {
        await this.quarantine('contains a malformed legacy row', originalContents)
        return
      }
      const v2Rows = parsed.filter((row) => !!row && typeof row === 'object'
        && (row as { schemaVersion?: unknown }).schemaVersion === 2)
      if (v2Rows.length && !validatedRows(v2Rows)) {
        await this.quarantine('contains a malformed v2 row', originalContents)
        return
      }
      let arr = parsed as Array<Partial<RegisteredSession>>
      for (const row of arr) {
        const id = rowId(row)
        if (id) this.persistedBaseline.set(id, rowFingerprint(row))
      }
      // After the baseline, so the save below writes the cleared rows rather than merging the disk's back in.
      const ownModes = !existsSync(OWN_MODES_FILE)
      if (ownModes) {
        const swept = withoutForcedModes(arr)
        if (swept.cleared) console.log(`[registry] ${swept.cleared} agent(s) no longer keep a permission mode Harness forced`)
        arr = swept.rows
      }
      // After the forced modes are cleared: a Swarm agent full mode was forced on comes back in Auto-approve too.
      const retired = arr.map(withRetiredSwarmMode)
      const swarmAuto = retired.some((row, i) => row !== arr[i])
      if (swarmAuto) console.log(`[registry] ${retired.filter((row, i) => row !== arr[i]).length} agent(s) the Swarm started come back in Auto-approve`)
      arr = retired
      // The rollback copy is the file as found, retired runtimes and all — not the cleaned rows.
      if (arr.some((row) => row.schemaVersion !== 2)) {
        await this.preserveLegacyImage(originalContents)
      }
      let changed = strippedRetired || swarmAuto || (ownModes && arr.some((row, i) => row !== parsed[i]))
      if (rebooted) {
        this.rebooted = true
        console.log(`[registry] machine rebooted since last run — ${arr.length} agent(s) kept with their process identity cleared (stale panes, restored on start)`)
        // Persist the cleared snapshot before advancing the boot marker, so a crash
        // during initialization leaves a second chance to recognize the reboot.
        changed = true
      }
      // One catalog snapshot serves the private initialization. Its final guard
      // preserves every dependent binding if the catalog changed between rows.
      let snapshot: EngineHomeSnapshot | undefined, unavailableHomes: unknown
      const dependent = new Map<string, Partial<RegisteredSession>>()
      const staged = new Map<string, RegisteredSession>()
      const bindingProofs = new Map<string, { original: Partial<RegisteredSession> }>()
      const rootScopes = new Map<string, { proof?: ReturnType<typeof transcriptRootEvidence>; verify?: () => void; error?: unknown;
        rows: Map<string, Partial<RegisteredSession>> }>()
      const rootsFor = (engine: AgentEngine, profile: string | undefined, catalog: EngineHomeSnapshot | undefined) => {
        const key = JSON.stringify([engine, profile ?? null])
        let scope = rootScopes.get(key)
        if (!scope) {
          scope = { rows: new Map() }; rootScopes.set(key, scope)
          try {
            scope.proof = transcriptRootEvidence(engine, profile, catalog)
            scope.verify = scope.proof.retain()
          }
          catch (error) { scope.error = error }
        }
        if (scope.error) throw scope.error
        return scope
      }
      const catalogFor = (engine: AgentEngine, profile?: string): EngineHomeSnapshot | undefined => {
        if (!needsHomeCatalog(engine, profile)) return undefined
        if (unavailableHomes) throw unavailableHomes
        try { return snapshot ??= engineHomeSnapshot() }
        catch (error) { unavailableHomes = error; throw error }
      }
      const preserve = (row: RegisteredSession, original: Partial<RegisteredSession>, error: unknown): void => {
        row.sessionId = typeof original.sessionId === 'string' ? original.sessionId : ''
        row.boundAt = row.sessionId ? original.boundAt ?? original.registeredAt ?? row.registeredAt : null
        row.transcriptPath = typeof original.transcriptPath === 'string' && original.transcriptPath ? original.transcriptPath : null
        row.source = row.sessionId && typeof original.source === 'string' ? original.source : null
        row.projectDir = typeof original.projectDir === 'string' ? original.projectDir : row.transcriptPath ? basename(dirname(row.transcriptPath)) : row.sessionId || row.agentId
        row.identityHold = error instanceof Error ? error.message : String(error)
        row.evidenceRevision = ++this.evidenceRevision
      }
      for (const raw of Array.isArray(arr) ? arr : []) {
        const engine = normalizedAgentEngine(raw?.engine)
        const runtimes = normalizedRuntimes(raw?.runtimes, raw?.tmuxPane)
        const pane = paneProjection(runtimes)
        if (!runtimes.length) { changed = true; continue }
        let transcriptPath =
          typeof raw?.transcriptPath === 'string' && raw.transcriptPath
            ? raw.transcriptPath
            : null
        let bound = typeof raw?.sessionId === 'string' && raw.sessionId !== ''
        const rawSessionId = typeof raw?.sessionId === 'string' ? raw.sessionId : ''
        // This row's own CODEX_HOME profile, when it was created against one other than the default —
        // see RegisteredSession.codexHome.
        const rawCodexHome = raw?.codexHome ?? undefined
        const rawGridLaunch = normalizedGridLaunch(raw?.gridLaunch)
        const rawScmLaunch = parseScmLaunchRecord((raw as { scmLaunch?: unknown })?.scmLaunch)
        // A sub-agent's hooks run from its parent's pane, and an older daemon let them overwrite the parent's
        // binding with the child's file: put the parent's own back, found by its id in the same home (or its
        // profile), else release the binding. Declared by the engine's session store (`repairsOverwrittenParent`)
        // and read with the kit, in core.
        let repairedParentTranscript = false, homeError: unknown
        const needsCatalog = bound && !!transcriptPath && needsHomeCatalog(engine, rawCodexHome)
        let bindingProof: ReturnType<typeof savedTranscriptEvidence> | undefined
        let rootScope: ReturnType<typeof rootsFor> | undefined
        try {
          const rowSnapshot = needsCatalog ? catalogFor(engine, rawCodexHome) : undefined
          if (!bound) transcriptPath = null
          if (bound && transcriptPath) {
            rootScope = rootsFor(engine, rawCodexHome, rowSnapshot)
            bindingProof = savedTranscriptEvidence(engine, rawSessionId, transcriptPath, rawCodexHome, rowSnapshot, rootScope.proof)
            const verified = bindingProof.path
            if (verified !== transcriptPath) {
              changed = true
              repairedParentTranscript = !!verified
              transcriptPath = verified
            }
            if (!verified) bound = false
          } else if (bound && engine !== 'cursor' && engine !== 'opencode' && engine !== 'kilo' && engine !== 'pi'
            && engine !== 'hermes' && engine !== 'commandcode' && engine !== 'devin' && engine !== 'openclaw') {
            bound = false
            changed = true
          }
        } catch (error) {
          homeError = error
          transcriptPath = typeof raw.transcriptPath === 'string' && raw.transcriptPath ? raw.transcriptPath : null
          bound = !!rawSessionId
          repairedParentTranscript = false
          bindingProof = undefined
        }
        // Old launcher-owned records used launcherId as the public id. Preserve it while process discovery
        // validates/adopts the live runtime, then save the record without the legacy ownership field.
        const legacyLauncherId = typeof raw?.launcherId === 'string' ? raw.launcherId : ''
        const agentId = typeof raw.agentId === 'string' && raw.agentId ? raw.agentId : legacyLauncherId
        if (!agentId) { changed = true; continue }
        if (agentId !== raw.agentId) changed = true
        const now = Date.now()
        const active = !rebooted && raw.active !== false
        const launch = normalizedLaunch(raw.launch)
        const s: RegisteredSession = {
          schemaVersion: 2,
          active,
          ...(launch ? { launch } : {}),
          ...(raw.resumeOnly === true ? { resumeOnly: true } : {}),
          ...(raw.externalResume ? { externalResume: parseExternalResume(raw.externalResume)! } : {}),
          agentId,
          boundAt: bound ? (typeof raw.boundAt === 'number' ? raw.boundAt : (raw.registeredAt ?? now)) : null,
          engine,
          gateway: raw.gateway === 'ori' ? 'ori' : null,
          grid: normalizedGridAssignment(raw.grid),
          codexHome: typeof rawCodexHome === 'string' && rawCodexHome ? rawCodexHome : null,
          claudeHome: typeof raw?.claudeHome === 'string' && raw.claudeHome ? raw.claudeHome : null,
          hermesHome: typeof raw?.hermesHome === 'string' && raw.hermesHome ? raw.hermesHome : null,
          ...storedHermesHomeDerived(raw),
          ...(typeof raw?.openclawStateDir === 'string' && raw.openclawStateDir ? { openclawStateDir: raw.openclawStateDir } : {}),
          ...(storedFirstTask(raw.firstTask) ? { firstTask: storedFirstTask(raw.firstTask) } : {}),
          ...(storedOpenclawLocal(raw.openclawLocal) ? { openclawLocal: storedOpenclawLocal(raw.openclawLocal) } : {}),
          ...(earlierSessionKeys(raw.earlierSessionIds) ? { earlierSessionIds: earlierSessionKeys(raw.earlierSessionIds) } : {}),
          ...normalizedForkedFrom((raw as { forkedFrom?: unknown }).forkedFrom),
          dsh: normalizedDshId((raw as { dsh?: unknown }).dsh),
          dshRuntime: typeof raw.dshRuntime === 'string' && raw.dshRuntime ? raw.dshRuntime : null,
          agent: normalizedAgentName((raw as { agent?: unknown }).agent),
          ...(rawGridLaunch !== undefined ? { gridLaunch: rawGridLaunch } : {}),
          ...(rawGridLaunch ? { gridWebSearch: normalizedGridWebSearch(raw?.gridWebSearch) } : {}),
          ...(rawScmLaunch ? { scmLaunch: rawScmLaunch } : {}),
          ...(storedLaunchArgs(raw.launchArgs) ? { launchArgs: storedLaunchArgs(raw.launchArgs) } : {}),
          ...(raw.browser === true ? { browser: true as const } : {}),
          ...(typeof raw.quietTitle === 'string' && raw.quietTitle ? { quietTitle: raw.quietTitle } : {}),
          ...(engine === 'terminal' && parentAgentIdOf(raw.previousAgentId) ? { previousAgentId: raw.previousAgentId as string } : {}),
          ...(storedLaunchModel((raw as { launchModel?: unknown }).launchModel) ? { launchModel: storedLaunchModel((raw as { launchModel?: unknown }).launchModel) } : {}),
          // ⚠️ Rehydrated EXPLICITLY, like every field above it. A row is rebuilt from this list on
          // load, so a field added to the type and the setter but not to this list is written to
          // disk and then silently dropped by the next load — which is exactly what happened, and
          // it looks like "the setter never ran" rather than like a missing line here.
          ...(typeof raw?.subscriptionModel === 'string' && raw.subscriptionModel
            ? { subscriptionModel: raw.subscriptionModel }
            : {}),
          ...(raw.bypassPermission === true ? { bypassPermission: true } : {}),
          ...(permissionModeName(raw.permissionMode) ? { permissionMode: raw.permissionMode } : {}),
          ...(raw.terminalHost === true || engine === 'terminal' ? { terminalHost: true } : {}),
          ...(raw.startedBy === 'agent' ? { startedBy: 'agent' as const } : {}),
          ...normalizedParent(raw.startedBy, raw.parentAgentId),
          // Rehydrated explicitly (see above): dropped, a guest's harness would read as the owner's.
          ...(typeof raw.guest === 'string' && raw.guest ? { guest: raw.guest } : {}),
          transcriptPath,
          defaultName: normalizedDefaultName(raw.defaultName),
          title: titleDisplayName(typeof raw.title === 'string' ? raw.title : null),
          sessionId: bound ? rawSessionId : '',
          projectDir: !repairedParentTranscript && typeof raw.projectDir === 'string' && raw.projectDir
            ? raw.projectDir
            : transcriptPath
              ? basename(dirname(transcriptPath))
              : (bound ? rawSessionId : agentId),
          tmuxPane: pane,
          runtimes,
          primaryRuntimeKey: selectedRuntimeKey(runtimes, raw.primaryRuntimeKey),
          cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
          source: bound && typeof raw.source === 'string' ? raw.source : null,
          cliVersion: typeof raw.cliVersion === 'string' ? raw.cliVersion : null,
          model: modelString(raw.model),
          processIdentity: !rebooted && validProcessIdentity(raw.processIdentity) ? raw.processIdentity : null,
          registeredAt: typeof raw.registeredAt === 'number' ? raw.registeredAt : now,
          touchedAt: savedTouchedAt(raw) ?? now,
          lastHookAt: typeof raw.lastHookAt === 'number' ? raw.lastHookAt : (savedTouchedAt(raw) ?? now),
          lastTranscriptAt: typeof raw.lastTranscriptAt === 'number' ? raw.lastTranscriptAt : (savedTouchedAt(raw) ?? now),
          // Rehydrated explicitly for the reason the ⚠️ above gives. A reboot keeps it: it is when a
          // person last looked, which no reboot changes.
          ...(normalizedOpenedAt(raw.lastOpenedAt) !== undefined ? { lastOpenedAt: normalizedOpenedAt(raw.lastOpenedAt) } : {}),
          ...(!rebooted && normalizedClosePlan(raw.closePlan) ? { closePlan: normalizedClosePlan(raw.closePlan)! } : {}),
        }
        if (
          raw.engine !== engine
          || raw.schemaVersion !== 2
          || typeof raw.active !== 'boolean'
          || JSON.stringify(raw.launch) !== JSON.stringify(s.launch)
          || raw.tmuxPane !== pane
          || JSON.stringify(raw.runtimes) !== JSON.stringify(runtimes)
          || raw.primaryRuntimeKey !== s.primaryRuntimeKey
          || raw.transcriptPath !== transcriptPath
          || raw.title !== s.title
          || raw.lastHookAt == null
          || raw.lastTranscriptAt == null
          || legacyLauncherId !== ''
        ) changed = true
        if (staged.has(s.agentId)) {
          await this.quarantine('contains duplicate agent identities', originalContents)
          return
        }
        // The proof and this private row commitment share one turn. A later native
        // effect earns fresh evidence; startup never grants lasting file authority.
        if (bindingProof) {
          try { bindingProof.verify() }
          catch (error) { preserve(s, raw, error) }
          bindingProofs.set(s.agentId, { original: raw })
        }
        rootScope?.rows.set(s.agentId, raw)
        if (needsCatalog) dependent.set(s.agentId, raw)
        if (homeError) preserve(s, raw, homeError)
        staged.set(s.agentId, s)
        await nextTurn()
      }
      for (const { verify, rows } of rootScopes.values()) {
        try { verify?.() }
        catch (error) { for (const [id, raw] of rows) preserve(staged.get(id)!, raw, error) }
      }
      if (snapshot) {
        try { snapshot.verify() }
        catch (error) {
          for (const [id, raw] of dependent) preserve(staged.get(id)!, raw, error)
        }
      }
      for (const row of staged.values()) {
        this.index(row)
        if (row.identityHold) console.log(`[registry] ${row.agentId.slice(0, 8)} binding held · ${row.identityHold}`)
        else if (row.transcriptPath && bindingProofs.has(row.agentId)
          && bindingProofs.get(row.agentId)!.original.transcriptPath !== row.transcriptPath) {
          console.log(`[registry] repaired ${sessionStoreOf(row.engine)!.label} parent ${row.sessionId.slice(0, 8)} transcript after child hook overwrite`)
        }
      }
      if (!validatedRows([...this.agents.values()].map(persistedRow))) {
        await this.quarantine('violates global identity invariants', originalContents)
        return
      }
      if (changed) await this.writer.run(deadline => this.persist(deadline, 'observation'))
      // A marker must not make an interrupted migration look complete on the next start.
      writeBoot(bootId)
      if (ownModes) atomicWriteJson(OWN_MODES_FILE, Date.now())
    } catch (error) {
      if (error instanceof RegistryPersistenceUnavailable || error instanceof AtomicWriteUnconfirmed) throw error
      if (error instanceof SyntaxError) await this.quarantine('is not JSON', originalContents!)
      else if (existsSync(FILE)) {
        this.writeBlocked = true
        console.error('[registry] registry is unreadable; refusing to overwrite it:', error instanceof Error ? error.message : error)
      } else {
        writeBoot(bootId)
        atomicWriteJson(OWN_MODES_FILE, Date.now())
      }
      // A genuinely absent file starts empty. A file that cannot be opened safely (a symlink, another
      // owner, open permissions) is left exactly as it is, and nothing is written over it.
    }
  }

  /**
   * Bytes no version of the registry can load — not JSON, the wrong shape, malformed or contradictory
   * rows — are moved aside, kept byte-for-byte for an operator, and the daemon starts empty: discovery
   * finds the agents still running in tmux again. Refusing every write instead left a daemon that could
   * not start a single agent until someone repaired the file by hand. A newer version's rows (an
   * unknown schema) are not corruption, and are still never touched.
   */
  private async quarantine(reason: string, originalContents: SessionImageProof): Promise<void> {
    this.agents.clear()
    this.sessionIndex.clear()
    this.runtimeIndex.clear()
    this.processIndex.clear()
    this.persistedBaseline.clear()
    this.persistedContents = null
    this.unconfirmedBinding = null
    this.intended.clear()
    const aside = `${FILE}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
    try {
      await this.writer.run(deadline => registryFileLock(env.ADAPTER_DATA_DIR, deadline, async checkOwner => {
        // A peer may publish while rows are being prepared or the lock is awaited.
        // Only the exact malformed image we read may be moved aside.
        const latest = await sessionStorage.read({ kind: 'registry' })
        if (latest.state !== 'image' || latest.proof.sha256 !== originalContents.sha256) {
          throw new RegistryPersistenceUnavailable('registry image changed during initialization')
        }
        checkOwner()
        if (sessionFileIdentity(lstatSync(FILE, { bigint: true })) !== latest.proof.identity) {
          throw new RegistryPersistenceUnavailable('registry image changed during initialization')
        }
        renameSync(FILE, aside)
      }))
      this.writeBlocked = false
      console.error(`[registry] registry ${reason}; moved it aside and started empty`)
    } catch (error) {
      this.writeBlocked = true
      console.error(`[registry] registry ${reason}, and it could not be moved aside (${error instanceof Error ? error.message : error}); refusing to overwrite it`)
      if (error instanceof RegistryPersistenceUnavailable) throw error
    }
  }

  private async preserveLegacyImage(original: SessionImageProof): Promise<void> {
    if (existsSync(PRE_V2_BACKUP_FILE)) return
    await this.writer.run(deadline => sessionStorage.withWrite(deadline.expires,
      () => registryFileLock(env.ADAPTER_DATA_DIR, deadline, async checkOwner => {
        const latest = await sessionStorage.read({ kind: 'registry' })
        if (latest.state !== 'image' || latest.proof.sha256 !== original.sha256) {
          throw new RegistryPersistenceUnavailable('registry image changed during initialization')
        }
        const backup = await sessionStorage.retain({ kind: 'legacy-registry' })
        try {
          if (backup.image.state !== 'missing') return
          const prepared = await prepareSessionPublication(sessionStorage, { kind: 'legacy-registry' }, backup, [], deadline, latest.proof)
          try {
            checkOwner()
            if (sessionFileIdentity(lstatSync(FILE, { bigint: true })) !== latest.proof.identity) {
              throw new RegistryPersistenceUnavailable('registry image changed during initialization')
            }
            prepared.publish(() => {})
            await prepared.sync()
            await prepared.settle()
            checkOwner()
            prepared.finish()
            deadline.markAdmitted()
          } finally { await prepared.discard() }
        } finally { await backup.release() }
      })))
  }

  private async loadNames(): Promise<void> {
    try {
      const image = await sessionStorage.read({ kind: 'names' })
      if (image.state !== 'image' || !image.json) return
      const obj = image.value as Record<string, unknown>
      for (const [id, name] of Object.entries(obj)) {
        if (typeof name === 'string' && name.trim()) NAME_OVERRIDES.set(id, name.trim())
      }
    } catch {
      // no file yet / unreadable — start without display-name overrides
    }
  }

  /** Create/adopt a process agent before any engine session exists. */
  async openProcessAgent(input: {
    agentId?: string
    engine: AgentEngine
    tmuxPane?: string
    runtimes?: TerminalRuntimeRef[]
    primaryRuntimeKey?: string
    cwd?: string | null
    processIdentity: ProcessIdentity
    gateway?: 'ori' | null
    grid?: GridAssignment | null
    /** Codex only: the CODEX_HOME the process runs under, from the rollout it holds open. Fills a
     *  row that does not know its profile yet; never overwrites one that does (see `codexHome`). */
    codexHome?: string | null
    /** The Hermes home this session's store lives in, if it is not the default. Fill-only. */
    hermesHome?: string | null
    claudeHome?: string | null
  }, authority: RegistryAuthority = {}): Promise<
    {
      entry: RegisteredSession
      isNew: boolean
      /**
       * Every agent this one took its last terminal from, in route order.
       *
       * BOTH IDS, because by the time the caller reads this the agent is ALREADY
       * GONE from the registry — `drop()` removes it and the loop below only
       * re-indexes it if it still owns a runtime — so nothing can look either id
       * up afterwards. Clients key on the agentId and the daemon's per-session
       * state keys on the sessionId, and the caller needs both to finish the
       * removal it was never told to do.
       */
      evicted: RegisteredSession[]
    } | null> {
    this.assertOpen()
    if (this.writeBlocked) return null
    input = structuredClone(input)
    const { engine, processIdentity } = input
    const runtimes = normalizedRuntimes(input.runtimes, input.tmuxPane)
    if (!runtimes.length || !validProcessIdentity(processIdentity)) return null
    if (runtimes.some(runtime => externalResumePending(this.agents.get(this.runtimeIndex.get(terminalRouteKey(runtime)) ?? '')?.externalResume))) return null
    const processAgentId = this.processIndex.get(processIdentityKey(engine, processIdentity))
    const processAgent = processAgentId ? this.agents.get(processAgentId) : undefined
    const routeAgent = runtimes.map(runtime => this.byRuntimeEngine(runtime, engine)).find(agent => agent && (
      !agent.sessionId || !agent.processIdentity || sameProcessIdentity(agent.processIdentity, processIdentity)))
    const selected = processAgent ?? routeAgent
    const agentId = selected?.agentId ?? input.agentId ?? randomUUID()
    const routes = new Map(runtimes.map(runtime => [terminalRouteKey(runtime), this.runtimeIndex.get(terminalRouteKey(runtime))]))
    const owners = new Map([...new Set([agentId, ...routes.values()].filter((id): id is string => !!id))]
      .map(id => [id, ownershipIdentity(this.byAgent(id))]))
    const verify = () => {
      if (authority.current?.() === false || [...owners].some(([id, owner]) => ownershipIdentity(this.byAgent(id)) !== owner)
        || [...routes].some(([key, id]) => this.runtimeIndex.get(key) !== id)) {
        throw new RegistryOwnershipChanged('the discovered ownership group changed before publication')
      }
    }
    return this.writer.run(async deadline => {
      verify()
      let candidate: RegisteredSession
      let observationFingerprint: string | undefined
      const evicted: RegisteredSession[] = []
      const displaced: Array<{ agentId: string; candidate: RegisteredSession | null }> = []
      const taken = new Set(routes.keys())
      for (const id of new Set(routes.values())) {
        if (!id || id === agentId) continue
        const captured = structuredClone(this.byAgent(id)!)
        const other = structuredClone(captured)
        other.runtimes = other.runtimes.filter(runtime => !taken.has(terminalRouteKey(runtime)))
        other.tmuxPane = paneProjection(other.runtimes)
        other.primaryRuntimeKey = selectedRuntimeKey(other.runtimes, other.primaryRuntimeKey)
        other.active = other.runtimes.length > 0
        displaced.push({ agentId: id, candidate: other.runtimes.length ? other : null })
        if (!other.runtimes.length) evicted.push(captured)
      }
      if (selected) {
        candidate = structuredClone(this.byAgent(agentId)!)
        candidate.runtimes = mergeTerminalRuntimes(candidate.runtimes, runtimes)
        candidate.tmuxPane = paneProjection(candidate.runtimes)
        candidate.primaryRuntimeKey = selectedRuntimeKey(candidate.runtimes, input.primaryRuntimeKey || candidate.primaryRuntimeKey)
        if (!candidate.sessionId || !candidate.cwd) candidate.cwd = input.cwd ?? candidate.cwd
        candidate.processIdentity = processIdentity
        candidate.active = true
        if (candidate.launch) candidate.launch = { state: 'ready' }
        if (input.gateway !== undefined) candidate.gateway = input.gateway
        if (input.grid !== undefined) candidate.grid = input.grid
        if (input.codexHome && !candidate.codexHome) candidate.codexHome = input.codexHome
        if (input.claudeHome && !candidate.claudeHome) candidate.claudeHome = input.claudeHome
        if (input.hermesHome && !candidate.hermesHome) candidate.hermesHome = input.hermesHome
        const fingerprint = rowFingerprint(persistedRow(candidate))
        if (fingerprint !== rowFingerprint(persistedRow(this.byAgent(agentId)!))) candidate.touchedAt = Date.now()
        else observationFingerprint = fingerprint
      } else {
        const now = Date.now()
        const entry: RegisteredSession = {
          schemaVersion: 2,
          active: true,
          agentId,
          sessionId: '',
          boundAt: null,
          engine,
          gateway: input.gateway ?? null,
          grid: input.grid ?? null,
          // A discovered grid agent has no credential the daemon ever saw: it can be observed, not relaunched.
          gridLaunch: null,
          gridWebSearch: null,
          codexHome: input.codexHome ?? null,
          hermesHome: input.hermesHome ?? null,
          claudeHome: input.claudeHome ?? null,
          // A DSH is a launch fact Harness records when it creates the agent, never read off a process.
          dsh: null,
          // A discovered pane's named agent is only visible in its argv; nothing here reads it, so the
          // row cannot relaunch it as one.
          agent: null,
          transcriptPath: null,
          projectDir: basename(input.cwd ?? '') || agentId,
          cwd: input.cwd ?? null,
          runtimes,
          primaryRuntimeKey: selectedRuntimeKey(runtimes, input.primaryRuntimeKey),
          tmuxPane: paneProjection(runtimes),
          source: null,
          title: null,
          model: null,
          cliVersion: null,
          processIdentity,
          registeredAt: now,
          touchedAt: now,
          lastHookAt: now,
          lastTranscriptAt: now,
        }
        candidate = entry
      }
      const unchanged = (): boolean => {
        const live = this.byAgent(agentId)
        return observationFingerprint !== undefined && !!live && displaced.length === 0
          && this.transactionDepth === 0 && this.unconfirmedBinding === null && !this.intended.has(agentId)
          && this.persistedBaseline.get(agentId) === observationFingerprint
          && rowFingerprint(persistedRow(live)) === observationFingerprint
      }
      if (unchanged()) {
        // Discovery still checks the private file, but observing an already-durable owner grants no new binding.
        await authority.refresh?.()
        verify()
        if (!unchanged()) throw new RegistryOwnershipChanged('the discovered row changed during authority refresh')
        await this.persist(deadline, 'observation')
        deadline.check()
        verify()
        const committed = this.byAgent(agentId)
        if (!committed || launchIdentity(committed) !== launchIdentity(candidate)) return null
        this.terminalAvailableAgents.add(agentId)
        return { entry: structuredClone(committed), isNew: false, evicted }
      }
      const previousLaunch = this.byAgent(agentId)?.launch
      const receipt = await this.persist(deadline, true, false, undefined, {
        agentId, candidate, displaced, verify, refresh: authority.refresh, allowTransaction: true,
      })
      const committed = this.committedOwner(agentId, receipt)
      if (!committed || launchIdentity(committed) !== launchIdentity(candidate)) return null
      if (selected) this.traceLaunch(agentId, previousLaunch, committed.launch, 'openProcessAgent re-observed')
      for (const removed of displaced) if (!this.byAgent(removed.agentId)) this.terminalAvailableAgents.delete(removed.agentId)
      this.terminalAvailableAgents.add(agentId)
      return { entry: structuredClone(committed), isNew: !selected, evicted }
    }, authority.expires)
  }

  /** Register a terminal route before its engine process exists. */
  async openPendingAgent(input: {
    /** The id the launch already named its session after (OpenClaw's `harness-<agentId>`); a new one otherwise. */
    agentId?: string
    nativeToken?: string
    engine: AgentEngine
    runtimes: TerminalRuntimeRef[]
    primaryRuntimeKey?: string
    cwd?: string | null
    grid?: GridAssignment | null
    /** The grid launch this pane was opened with and what it decided — the pair `setGridLaunch` keeps. */
    gridLaunchRecord?: GridLaunchRecord | null
    /** What the prepared workspace's SCM needs on every relaunch — see RegisteredSession.scmLaunch. */
    scmLaunchRecord?: ScmLaunchRecord | null
    /** The model and effort it was launched with as flags — see RegisteredSession.launchModel. */
    launchModel?: LaunchModel | null
    codexHome?: string | null
    claudeHome?: string | null
    dsh?: string | null
    dshRuntime?: string | null
    /** The engine's named agent the pane was opened as (`agent_create`'s `agent`), validated upstream. */
    agent?: string | null
    bypassPermission?: boolean
    permissionMode?: string | null
    /** The name the creator asked for. Blank or absent means Harness names it (agentNames.ts). */
    defaultName?: string | null
    /** Who the agent is, for the name Harness gives it: a DSH's own name ("Blender"); the engine's by default. */
    label?: string | null
    /** The agent this one is a fork of — see RegisteredSession.forkedFrom. */
    forkedFrom?: ForkOrigin | null
    externalResume?: ExternalResumeIntent
    /** Who started it — see RegisteredSession.startedBy. */
    startedBy?: StartedBy | null
    /** The harness here that started it — see RegisteredSession.parentAgentId. Kept only with `startedBy: 'agent'`. */
    parentAgentId?: string | null
    /** The guest it is started for — see RegisteredSession.guest. */
    guest?: string | null
    /** Its Browser is on from the start (an older Desktop's create) — see RegisteredSession.browser. */
    browser?: boolean
    /** The first task to type once the engine is ready — see RegisteredSession.firstTask. */
    firstTask?: string
    /** OpenClaw's `--local` folder — see RegisteredSession.openclawLocal. */
    openclawLocal?: string
  }): Promise<RegisteredSession | null> {
    this.assertOpen()
    input = structuredClone(input)
    return this.writer.run(async deadline => {
      if (this.writeBlocked) return null
      const externalResume = input.externalResume === undefined ? undefined : parseExternalResume(input.externalResume)
      if (externalResume === null || externalResume && (externalResume.phase !== 'waiting' || externalResume.request.engine !== input.engine
        || this.externalConflict(externalResumeIds(externalResume)))) return null
      const runtimes = normalizedRuntimes(input.runtimes)
      if (!runtimes.length) return null
      if (runtimes.some((runtime) => this.runtimeIndex.has(terminalRouteKey(runtime)))) return null
      const agentId = input.agentId ?? randomUUID()
      if (this.byAgent(agentId)) return null
      const now = Date.now()
      return this.withGridRecord({ agentId, registeredAt: now }, input.gridLaunchRecord, async gridLaunchRecord => {
      const entry: RegisteredSession = {
        schemaVersion: 2,
        active: !externalResume,
        launch: externalResume ? { state: 'held', service: 'search', detail: 'Waiting for the search service to verify this conversation.' } : { state: 'starting', ...(input.nativeToken ? { nativeToken: input.nativeToken } : {}) },
        ...(externalResume ? { externalResume } : {}),
        defaultName: normalizedDefaultName(input.defaultName) ?? this.automaticName(input.label?.trim() || engineLabel(input.engine), new Date(now)),
        agentId,
        sessionId: '',
        boundAt: null,
        engine: input.engine,
        gateway: null,
        grid: input.grid ?? null,
        gridLaunch: gridLaunchRecord?.override ?? null,
        gridWebSearch: gridLaunchRecord?.webSearch ?? null,
        ...(input.scmLaunchRecord ? { scmLaunch: input.scmLaunchRecord } : {}),
        ...(storedLaunchModel(input.launchModel) ? { launchModel: storedLaunchModel(input.launchModel) } : {}),
        codexHome: input.codexHome ?? null,
        claudeHome: input.claudeHome ?? null,
        // A pane Harness opens starts in the default home; `hermes -p` is the person's own doing, and
        // the row learns it from the session that lands in it. See RegisteredSession.hermesHome.
        hermesHome: null,
        dsh: input.dsh ?? null,
        dshRuntime: input.dshRuntime ?? null,
        agent: normalizedAgentName(input.agent),
        ...(input.bypassPermission ? { bypassPermission: true } : {}),
        ...(permissionModeName(input.permissionMode) ? { permissionMode: input.permissionMode } : {}),
        ...(isTerminalEngine(input.engine) ? { terminalHost: true } : {}),
        ...normalizedForkedFrom(input.forkedFrom),
        ...(input.startedBy === 'agent' ? { startedBy: 'agent' as const } : {}),
        ...normalizedParent(input.startedBy, input.parentAgentId),
        ...(input.guest ? { guest: input.guest } : {}),
        ...(input.browser ? { browser: true as const } : {}),
        ...(input.firstTask ? { firstTask: input.firstTask } : {}),
        // Its store is in that folder from the start: nothing waits for a TUI to be seen holding it.
        ...(input.openclawLocal ? { openclawLocal: input.openclawLocal, openclawStateDir: input.openclawLocal } : {}),
        transcriptPath: null,
        projectDir: basename(input.cwd ?? '') || agentId,
        cwd: input.cwd ?? null,
        runtimes,
        primaryRuntimeKey: selectedRuntimeKey(runtimes, input.primaryRuntimeKey),
        tmuxPane: paneProjection(runtimes),
        source: null,
        title: null,
        model: null,
        cliVersion: null,
        processIdentity: null,
        registeredAt: now,
        touchedAt: now,
        lastHookAt: now,
        lastTranscriptAt: now,
      }
      const verify = this.ownerGuard(agentId)
      const receipt = await this.persist(deadline, true, false, externalResume ? agentId : undefined,
        { agentId, candidate: entry, verify, allowTransaction: true })
      const committed = this.committedOwner(agentId, receipt)
      if (!committed) return null
      this.terminalAvailableAgents.add(entry.agentId)
      if (entry.firstTask) firstTaskKept(agentId)
      return structuredClone(committed)
      })
    }).catch(error => {
      console.error('[registry] pending admission failed')
      // Read as a taken route, a storage refusal opened and closed three panes and answered "tmux pane could not
      // be registered" (e2e/diskfull.e2e.ts, 2026-11-17). Its caller answers it by name instead.
      if (error instanceof RegistryPersistenceUnavailable || error instanceof AtomicWriteUnconfirmed) throw error
      return null
    })
  }

  /** A stopped agent gets a new terminal route while keeping its saved conversation and identity.
   * Archived routes/processes are evidence only: none of them may be indexed or signalled here. */
  async resumePendingAgent(saved: RegisteredSession, runtimes: TerminalRuntimeRef[], nativeToken?: string,
    authority: RegistryAuthority = {}): Promise<RegisteredSession | null> {
    this.assertOpen()
    const archived = structuredClone(saved), routes = normalizedRuntimes(structuredClone(runtimes))
    return this.writer.run(async deadline => {
      if (this.writeBlocked || this.agents.has(archived.agentId)
        || (archived.sessionId && this.bySession(archived.sessionId))
        || !routes.length || routes.some(route => this.runtimeIndex.has(terminalRouteKey(route)))) return null
      const entry: RegisteredSession = {
        ...archived,
        resumeOnly: true,
        boundAt: null,
        lastHookAt: 0,
        active: true,
        launch: { state: 'starting', ...(nativeToken ? { nativeToken } : {}) },
        processIdentity: null,
        runtimes: routes,
        primaryRuntimeKey: selectedRuntimeKey(routes, ''),
        tmuxPane: paneProjection(routes),
        touchedAt: Date.now(),
      }
      const verify = this.ownerGuard(entry.agentId, authority.current)
      const receipt = await this.persist(deadline, true, false, undefined,
        { agentId: entry.agentId, candidate: entry, verify, refresh: authority.refresh, resumed: true })
      const committed = this.committedOwner(entry.agentId, receipt)
      if (!committed) return null
      this.terminalAvailableAgents.add(entry.agentId)
      return structuredClone(committed)
    }).catch(error => {
      console.error('[registry] resume admission failed')
      if (error instanceof AtomicWriteUnconfirmed) throw error
      return null
    })
  }

  /** Readiness, its native process and the launch words are one durable authority change. */
  async confirmLaunch(agentId: string, input: LaunchPublicationInput, authority: RegistryAuthority = {}): Promise<LaunchPublication> {
    this.assertOpen()
    const selected = this.byAgent(agentId)
    if (!selected || (!isTerminalEngine(selected.engine) && !validProcessIdentity(input.processIdentity))) return { state: 'not-published' }
    // A peer that recorded this same process while this write waited (discovery's pass over the pane: its confirmation,
    // active and ready, or the process and the grid its argv names after a retarget) wrote part of this launch, not
    // another owner's. Read apart, a resume that discovery beat answered RESUME_UNCONFIRMED over its running engine
    // (e2e/eagerOpenCode.e2e.ts, 2026-11-17). Any other process or field still ends the write.
    const owners = [selected, { ...selected, processIdentity: input.processIdentity }].map(ownershipIdentity)
    const grids = input.grid === undefined ? [selected] : [selected, { ...selected, grid: input.grid }]
    const launches = grids.flatMap(row => [row, { ...row, active: true, launch: { state: 'ready' as const } }]).map(launchIdentity)
    const requested = structuredClone(input)
    const expires = Math.min(authority.expires ?? Infinity, performance.now() + 5_000)
    const verify = () => {
      if (authority.current?.() === false || !owners.includes(ownershipIdentity(this.byAgent(agentId)))) {
        throw new RegistryOwnershipChanged('the registry owner changed while its write was being prepared')
      }
      if (!launches.includes(launchIdentity(this.byAgent(agentId)))) {
        throw new RegistryOwnershipChanged('the selected launch changed while its write was being prepared')
      }
    }
    const imported = requested.gridLaunchRecord
    delete requested.gridLaunchRecord
    return this.withGridRecord(selected, imported, async importedRecord => {
    let candidate: RegisteredSession | undefined
    let uncertain = false
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.writer.run(async deadline => {
          verify()
          if (!candidate) {
            candidate = structuredClone({ ...this.byAgent(agentId)!, processIdentity: requested.processIdentity,
              active: true, launch: { state: 'ready' as const }, touchedAt: Date.now() })
            if (requested.grid !== undefined) candidate.grid = requested.grid
            if (requested.gateway !== undefined) candidate.gateway = requested.gateway
            if (requested.launchArgs !== undefined) {
              if (requested.launchArgs.length) candidate.launchArgs = requested.launchArgs
              else delete candidate.launchArgs
            }
            if (importedRecord !== undefined) {
              candidate.gridLaunch = importedRecord?.override ?? null
              candidate.gridWebSearch = importedRecord?.webSearch ?? null
            }
            if (requested.subscriptionModel !== undefined) candidate.subscriptionModel = requested.subscriptionModel
            if (requested.runtimes !== undefined) {
              const routes = normalizedRuntimes(requested.runtimes)
              if (!routes.length) return { state: 'not-published' as const }
              candidate.runtimes = routes
              candidate.primaryRuntimeKey = selectedRuntimeKey(routes, requested.primaryRuntimeKey ?? '')
              candidate.tmuxPane = paneProjection(routes)
            }
          }
          // Never turn a same-operation recovery into persist's different-intent rollback.
          if (uncertain) {
            const pending = this.unconfirmedBinding
            if (!pending || pending.agentId !== agentId || [...pending.affected].some(id => {
              const live = this.byAgent(id)
              return (live ? rowFingerprint(persistedRow(live)) : undefined) !== pending.before.get(id)
            })) throw new RegistryOwnershipChanged('the unconfirmed launch changed before recovery')
          }
          const receipt = await this.persist(deadline, true, false, undefined,
            { agentId, candidate, verify, refresh: authority.refresh, allowTransaction: true })
          const committed = this.committedOwner(agentId, receipt)
          return { state: 'confirmed' as const,
            entry: committed && launchIdentity(committed) === launchIdentity(candidate) ? structuredClone(committed) : null }
        }, expires)
      } catch (error) {
        if (error instanceof AtomicWriteUnconfirmed) uncertain = true
        else if (!uncertain) throw error
        if (attempt === 1 || !(error instanceof AtomicWriteUnconfirmed) || !error.retryable) {
          throw new AtomicWriteUnconfirmed(new Error('launch publication remains unconfirmed'), error instanceof AtomicWriteUnconfirmed && error.retryable)
        }
      }
    }
    throw new AtomicWriteUnconfirmed(new Error('launch publication remains unconfirmed'))
    })
  }

  /**
   * [agentId] runs again under its own id, and what went with its pane came back with it (its browser, decision 14): no
   * shell's next agent may take it. One pass over the live rows, at a resume only. Not saved here: the caller's save
   * carries it.
   */
  private forgetPreviousAgent(agentId: string): void {
    for (const row of this.agents.values()) {
      if (row.previousAgentId !== agentId) continue
      delete row.previousAgentId
      row.touchedAt = Date.now()
    }
  }

  /** Every name an agent on this machine answers to: default names, project names, renames. */
  agentNamesInUse(): string[] {
    return [
      ...this.list().flatMap(agent => [agent.defaultName, projectDisplayName(agent)]),
      ...NAME_OVERRIDES.values(),
    ].filter((name): name is string => typeof name === 'string' && name.length > 0)
  }

  /**
   * "Codex harness 9-17 15:26", or with the seconds when that name is already taken — two of the same
   * agent started in one minute. Nothing is counted, so nothing can drift.
   */
  private automaticName(label: string, at: Date): string {
    const name = automaticAgentName(label, at)
    return this.agentNamesInUse().includes(name) ? automaticAgentName(label, at, true) : name
  }

  /** Discovered process agents that have no engine session bound yet. */
  unbound(): RegisteredSession[] {
    return this.list().filter((s) => !s.sessionId)
  }

  /** A current observation for frames; never persisted as conversation evidence. */
  setIdentityHold(agentId: string, reason?: string): boolean {
    this.assertOpen()
    const entry = this.agents.get(agentId)
    const detail = reason === undefined ? undefined : reason.slice(0, 1024) || 'Waiting for conversation identity.'
    if (!entry || entry.identityHold === detail) return false
    entry.evidenceRevision = ++this.evidenceRevision
    if (detail) entry.identityHold = detail
    else delete entry.identityHold
    return true
  }

  /** Only the attachment that read this revision can complete or explain its recovery. */
  setInterpretationHold(agentId: string, revision: number | undefined, reason?: string, create = false): boolean {
    this.assertOpen()
    const entry = this.agents.get(agentId)
    if (!entry || entry.identityHold || entry.evidenceRevision !== revision || (!entry.interpretationHold && !(create && reason))) return false
    if (!entry.interpretationHold) entry.evidenceRevision = ++this.evidenceRevision
    if (reason) entry.interpretationHold = reason.slice(0, 1024)
    else delete entry.interpretationHold
    return true
  }

  /** Retry only this saved binding. A failed read leaves all of its prior facts intact. */
  async revalidateBinding(agentId: string, authority: RegistryAuthority = {}): Promise<RegisteredSession | null> {
    this.assertOpen()
    const verifyOwner = this.ownerGuard(agentId, authority.current)
    return this.writer.run(async deadline => {
      verifyOwner()
      const entry = this.agents.get(agentId)
      if (!entry) return null
      if (!entry.sessionId || !entry.transcriptPath) return structuredClone(entry)
      const proof = savedTranscriptEvidence(entry.engine, entry.sessionId, entry.transcriptPath, entry.codexHome ?? undefined)
      // Stage the change without releasing the live index. A daemon-down hook may have bound another
      // conversation since load; a three-way save of this repair must never overwrite that newer bind.
      const candidate = { ...entry }
      if (!proof.path) Object.assign(candidate, { sessionId: '', boundAt: null, transcriptPath: null, source: null, lastTranscriptAt: Date.now() })
      else if (proof.path !== entry.transcriptPath) {
        candidate.transcriptPath = proof.path
        candidate.projectDir = basename(dirname(proof.path))
      }
      delete candidate.identityHold
      const receipt = await this.persist(deadline, true, false, undefined, { agentId, candidate, allowTransaction: true, verify: () => { verifyOwner(); proof.verify() } })
      // save refreshes the indices only after the durable commit. Even same-path recovery is fenced
      // against another writer and rechecks the native evidence after obtaining the lock.
      const saved = this.committedOwner(agentId, receipt)
      if (!saved) return null
      delete saved.identityHold
      saved.evidenceRevision = ++this.evidenceRevision
      if (saved.sessionId) saved.interpretationHold = 'Waiting for transcript interpretation to recover.'
      else delete saved.interpretationHold
      return structuredClone(saved)
    })
  }

  /**
   * Upsert a session. Idempotent — a re-register (e.g. from the UserPromptSubmit catch hook) just
   * refreshes `touchedAt`. Deduped by tmux pane: one session per pane, so a `/clear` rotation
   * (SessionEnd of the old id → SessionStart of a new id, same pane) evicts the old one instead of
   * showing two tiles. Returns { entry, isNew, evicted } — isNew=false on a re-register (so callers
   * can skip re-announcing), evicted = the sessionId displaced from this pane (caller removes it).
   */
  async register(input: RegisterInput, options: RegistryAuthority & { verifiedNativeSource?: boolean } = {}): Promise<{
    entry: RegisteredSession
    isNew: boolean
    evicted: string | null
    rebound: string | null
    /**
     * An agent left with NOTHING by this bind, and therefore removed here.
     *
     * `claude --resume` in a second pane moves the engine session to the new
     * agent. If the old one still has a live engine it is a real, separate
     * agent and is left alone — it merely became unbound. But if its engine is
     * already gone (the usual case: you quit it in order to resume it
     * elsewhere) it now has no session AND no process, and the only thing it
     * can still do is sit in the list as a second row for the same work that
     * cannot be opened. The caller announces the removal.
     */
    orphaned: { agentId: string; sessionId: string } | null
    /** The `codexHome` the input named was not taken: this session's transcript was not found under it. */
    refusedHome?: true
  } | null> {
    this.assertOpen()
    input = structuredClone(input)
    const engine = normalizedAgentEngine(input.engine)
    const pane = input.tmuxPane
    // Hooks carry process metadata, not ownership. The already-discovered pane+engine process chooses the
    // agent; an optional legacy launcherId is intentionally ignored.
    const inputRuntimes = normalizedRuntimes(input.runtimes, pane)
    const processAgent = (validProcessIdentity(input.processIdentity)
      ? this.byProcess(engine, input.processIdentity)
      : undefined)
      ?? inputRuntimes.map((runtime) => this.byRuntimeEngine(runtime, engine)).find(Boolean)
      // An engine started by hand inside a terminal, whose SessionStart hook beat the reconciler to
      // it: the terminal at that route is the agent, and it becomes this engine's here and now —
      // the same flip the reconciler would make a scan later (cli.ts `onObserved`).
      ?? (isTerminalEngine(engine) ? undefined : inputRuntimes
        .map((runtime) => this.byRuntimeTerminal(runtime))
        .filter((agent): agent is RegisteredSession => !!agent)
        .find((agent): agent is RegisteredSession => !!agent))
    const agentId = processAgent?.agentId ?? ''
    const verifyOwner = this.ownerGuard(agentId, options.current)
    return this.writer.run(async deadline => {
      verifyOwner()
      if (this.writeBlocked) throw new IdentityReadUnavailable('the saved session registry is unavailable')
      const transcriptPath = input.transcriptPath
      const sessionId = input.sessionId || (transcriptPath ? basename(transcriptPath).replace(/\.jsonl$/, '') : '')
      // An inert adoption pane cannot bind a hook before core has admitted its external conversation.
      if (processAgent?.externalResume && processAgent.externalResume.phase !== 'admitted') return null
      const admittedAlias = this.list().find(row => row.agentId !== agentId && row.externalResume?.phase === 'admitted'
        && row.sessionId !== sessionId && externalReservations(row).includes(sessionId))
      if (admittedAlias) return null
      if (
        !sessionId
        || !agentId
        || !inputRuntimes.length
        || (engine === 'grok' && !GROK_SESSION_RE.test(sessionId))
        // agy's session id IS its conversation id, and it names the directory the transcript lives in.
        || (engine === 'agy' && !GROK_SESSION_RE.test(sessionId))
        // Copilot's session id is a uuid and names the directory its event stream lives in.
        || (engine === 'copilot' && !GROK_SESSION_RE.test(sessionId))
        // OpenClaw's session id is its key, `agent:<agentId>:<key>`, which names the agent database it is read from.
        || (engine === 'openclaw' && !OPENCLAW_KEY.test(sessionId))
        || (engine !== 'cursor' && engine !== 'opencode' && engine !== 'kilo' && engine !== 'pi' && engine !== 'hermes' && engine !== 'commandcode' && engine !== 'devin' && engine !== 'grok' && engine !== 'agy' && engine !== 'copilot' && engine !== 'openclaw' && !transcriptPath)
        // The already-registered agent (opened at agent_create time) already carries its own
        // CODEX_HOME profile, if it has one other than the default — see RegisteredSession.codexHome.
      ) return null

      const now = Date.now()
      const existing = this.agents.get(agentId)
      // `isNew` still means "this SESSION id was not bound here before" — a rotation counts as new, which is
      // what makes the caller announce the newly bound session. The agent itself may be long-lived.
      const isNew = !existing || existing.sessionId !== sessionId
      // A rotation: the same process agent and pane swapping the engine session underneath it.
      const rebound = existing && existing.sessionId && existing.sessionId !== sessionId ? existing.sessionId : null
      const earlierSessionIds = earlierSessionKeys(existing?.earlierSessionIds, rebound)

      const evicted: string | null = rebound
      // The same engine session cannot belong to two agents — `claude --resume X` in a second pane. The
      // newest bind wins; the old process agent remains visible but becomes unbound.
      let orphaned: { agentId: string; sessionId: string } | null = null
      const stolenFrom = this.bySession(sessionId)
      let displaced: { agentId: string; candidate: RegisteredSession | null } | undefined
      if (stolenFrom && stolenFrom.agentId !== agentId) {
        const released = { ...stolenFrom, sessionId: '', boundAt: null, transcriptPath: null,
          source: null, lastTranscriptAt: now }
        delete released.externalResume; delete released.resumeOnly
        delete released.identityHold; delete released.interpretationHold
        displaced = { agentId: stolenFrom.agentId, candidate: stolenFrom.active ? released : null }
        if (!stolenFrom.active) orphaned = { agentId: stolenFrom.agentId, sessionId }
      }


      // Command Code announces SessionStart BEFORE writing its transcript, and validTranscriptPath stats the
      // file — so a real path is rejected at that moment and only arrives with the first Stop hook, AFTER the
      // first turn. Nothing tailed the transcript for that turn, and a transcript-derived turn_started is the
      // ONLY thing that tells Command Code a message was accepted: every new session's first message reported
      // "the agent did not accept this message" and produced no recap. Its layout is deterministic, so derive
      // the path rather than wait to be told. A file that does not exist yet is fine — the watcher starts at
      // offset 0 and chokidar fires when it appears.
      // WHOSE cwd this bind takes. A re-register of the session the row already holds (every
      // UserPromptSubmit; the SessionStart a resume gets for the row it was opened into) keeps the row's:
      // Claude reports its tracked SHELL directory, which follows every Bash `cd`, and a row that took
      // it each time drifted into subfolders, sibling repos and temp dirs — then the next resume,
      // restore or restart `cd`'d there and ran the engine in the wrong project. A first bind or a
      // rotation takes the hook's — that is what gives a terminal-turned-claude row its folder at all.
      const sameSession = !!existing && existing.sessionId === sessionId
      const baseCwd = sameSession ? existing.cwd ?? input.cwd ?? null : input.cwd ?? existing?.cwd ?? null
      const derived = !transcriptPath && engine === 'commandcode'
        ? commandcodeTranscriptPath(baseCwd ?? undefined, sessionId)
        : !transcriptPath && engine === 'grok' && baseCwd
          ? join(env.GROK_HOME, 'sessions', encodeURIComponent(baseCwd), sessionId, 'updates.jsonl')
          // agy's layout is deterministic from the conversation id alone, and its `PreInvocation` hook can
          // land before the first line is flushed — derive rather than wait a turn for the path.
          : !transcriptPath && engine === 'agy'
            ? agyTranscriptPath(env.AGY_HOME, sessionId)
            // Copilot announces its session before the first event is flushed; its layout is
            // deterministic, so derive rather than wait a turn for the path.
            : !transcriptPath && engine === 'copilot'
              ? copilotTranscriptPath(env.COPILOT_HOME, sessionId)
              : null
      const effectiveTranscriptPath = transcriptPath ?? (sameSession ? existing.transcriptPath : null) ?? derived ?? null
      // Native evidence is staged before terminal adoption, displacement or any live publication.
      const evidenceUnder = (profile: string | undefined) => effectiveTranscriptPath ? transcriptEvidence(engine, effectiveTranscriptPath,
        profile, !transcriptPath && derived === effectiveTranscriptPath ? 'derived' : false) : undefined
      // A home the hook says of its own environment fills a row that has none, and only once this session's transcript
      // is found under it. A home that does not hold it, or cannot be read, is no evidence: the transcript is taken as
      // it would be without it, and the registration goes on.
      const reportedHome = processAgent?.codexHome ? null : reportedProfileHome(engine, input.codexHome)
      let proof: ReturnType<typeof evidenceUnder>
      if (reportedHome) {
        try { proof = evidenceUnder(reportedHome) } catch (error) { if (!(error instanceof IdentityReadUnavailable)) throw error }
      }
      const refusedHome = !!reportedHome && !proof?.valid
      if (!reportedHome || refusedHome) proof = evidenceUnder(processAgent?.codexHome ?? undefined)
      if (proof && !proof.valid) {
        proof.verify()
        if (!proof.files.file(effectiveTranscriptPath!, true)) throw new IdentityReadUnavailable('the announced transcript is not yet available')
        return null
      }
      const first = sessionStoreOf(engine)?.first
      if (proof && first) {
        const meta = proof.files.header(effectiveTranscriptPath!, first)
        if (meta.isSubagent || meta.id !== sessionId) { proof.verify(); return null }
      }
      // A resumed row that has not yet been told, by a hook, which conversation it actually reopened.
      // Two ways to be in that state, and both have to count:
      //  - `lastHookAt === 0` — a resume allocated by `resumePendingAgent` and not yet hooked. Its
      //    `launch` may ALREADY read `ready`, because a resume is confirmed by its own live engine
      //    process now (`resumeStoppedAgent.ts`) and that is usually earlier than the hook. Reading
      //    only `launch` here disarmed this guard for exactly the resumes it exists to protect.
      //  - a launch that is not `ready` — a row put back by the post-reboot restore, which relaunches
      //    `--resume` against a row that kept `lastHookAt` from its previous life.
      if (existing?.resumeOnly && (existing.lastHookAt === 0 || (existing.launch && existing.launch.state !== 'ready'))) {
        // A native startup hook, carrying the verified process, must confirm this exact history —
        // but only where an exact history was asked for. A resume that opened a NEW conversation (an
        // engine with no resume argv, or a row with no id to reopen) reports a different id BECAUSE
        // it did what it was told; failing it there would refuse the resume the caller requested.
        if (!validProcessIdentity(input.processIdentity)) return null
        if (sessionId !== existing.sessionId && resumesConversation(engine, existing.sessionId)) {
          const failed: RegisteredSession = { ...existing, active: false, touchedAt: now,
            launch: { state: 'failed', error: 'RESUME_SESSION_MISMATCH', detail: 'The agent reported a different conversation. The requested conversation is still saved.' } }
          await this.persist(deadline, true, false, undefined, { agentId, candidate: failed, allowTransaction: true, refresh: options.refresh, verify: () => { verifyOwner(); proof?.verify() } })
          this.traceLaunch(agentId, existing.launch, failed.launch, 'resume conversation mismatch')
          return null
        }
      }
      // Even a first bind can carry a drifted cwd (a fork inherits its source's; `claude --resume` typed
      // from a subfolder). Claude's transcript never moves from the project dir it was started in, so a
      // cwd that does not round-trip to that directory name is not this session's folder — the row's own
      // is kept when it does, else the transcript names the folder itself (`projectFolder` in Claude Code's
      // discovery contract, engines/kit/projectFolder.ts).
      const project = !sameSession && effectiveTranscriptPath && input.cwd ? transcriptProject(engine) : null
      const cwd = project && effectiveTranscriptPath && input.cwd
          && project.isProjectTranscript(effectiveTranscriptPath) && !project.belongs(input.cwd, effectiveTranscriptPath)
        ? (existing?.cwd && project.belongs(existing.cwd, effectiveTranscriptPath) ? existing.cwd
          : project.cwdOf(effectiveTranscriptPath) ?? input.cwd)
        : baseCwd
      const retainEvidence = sameSession && existing.engine === engine && existing.transcriptPath === effectiveTranscriptPath
      const hermesHome = input.hermesHome ?? existing?.hermesHome ?? null
      // The mark goes with the home it was set with: kept while the row keeps that home, taken with a home the input
      // brings marked, never carried onto another home (which a relaunch would then fail to export).
      const hermesHomeDerived = !!hermesHome && (!!input.hermesHome && input.hermesHomeDerived
        || hermesHome === existing?.hermesHome && existing.hermesHomeDerived)
      const entry: RegisteredSession = {
        schemaVersion: 2,
        active: existing && isTerminalEngine(existing.engine) ? true : existing?.active ?? true,
        ...(existing?.evidenceRevision === undefined ? {} : { evidenceRevision: existing.evidenceRevision }),
        ...(retainEvidence && existing.identityHold ? { identityHold: existing.identityHold } : {}),
        ...(retainEvidence && existing.interpretationHold ? { interpretationHold: existing.interpretationHold } : {}),
        // No `launch`: a hook is the engine reporting for duty, so whatever the launch was — starting,
        // or failed by a watcher that gave up too early — it is over, and the frame reads `ready`.
        agentId,
        sessionId,
        boundAt: isNew ? now : existing?.boundAt ?? now,
        engine,
        // A bind blanks neither, or the very first SessionStart hook would announce a grid agent as "on no grid" until
        // the next scan put it back. An engine whose hook says its gateway takes the hook's word; a hook that says
        // nothing (an older one) leaves the last word standing.
        gateway: HOOK_GATEWAY_ENGINES.has(engine) && input.gateway !== undefined ? input.gateway : existing?.gateway ?? null,
        grid: existing?.grid ?? null,
        // The credential-bearing launch. Like codexHome: written once, carried forward, never re-derived.
        gridLaunch: existing?.gridLaunch ?? null,
        // What that launch decided — it travels with the launch, or it is lost at the first hook.
        gridWebSearch: existing?.gridWebSearch ?? null,
        // The workspace's SCM record, for the same reason: a bind rebuilds the row, and a relaunch
        // without it would come back without the environment the workspace was created with.
        ...(existing?.scmLaunch ? { scmLaunch: existing.scmLaunch } : {}),
        // ⚠️ Carried forward for the same reason, and it was missed once: a bind REBUILDS the row from
        // named fields, so a field the rebuild does not name survives on disk and vanishes from
        // memory the moment the engine reports in. The symptom is a move back to the engine's own
        // login landing on a house default — the remembered model was there, then a hook bind ate it.
        ...(existing?.subscriptionModel ? { subscriptionModel: existing.subscriptionModel } : {}),
        // And the model it launches with, for the same reason: a hook bind that forgot it reopened an agent on its
        // engine's own default (task #3395).
        ...(existing?.launchModel ? { launchModel: existing.launchModel } : {}),
        // And the owner's extra launch flags: a hook bind that forgot them would drop them at the first relaunch.
        ...(existing?.launchArgs ? { launchArgs: existing.launchArgs } : {}),
        // And its browser: dropped at the first hook, the agent's browser would stop with its next start.
        ...(existing?.browser ? { browser: true as const } : {}),
        // And the title its engine gave from a quiet line: dropped, a resumed conversation's title would name the agent.
        ...(existing?.quietTitle ? { quietTitle: existing.quietTitle } : {}),
        defaultName: existing?.defaultName,
        transcriptPath: effectiveTranscriptPath,
        projectDir: engine === 'grok' || engine === 'agy' || engine === 'copilot'
          ? basename(cwd ?? '') || sessionId
          : effectiveTranscriptPath
          ? basename(dirname(effectiveTranscriptPath))
          : basename(cwd ?? '') || sessionId,
        cwd,
        runtimes: mergeTerminalRuntimes(existing?.runtimes ?? [], inputRuntimes),
        primaryRuntimeKey: '',
        tmuxPane: '',
        source: input.source ?? existing?.source ?? null,
        title: titleDisplayName(input.title ?? existing?.title ?? null),
        model: modelString(input.model) ?? existing?.model ?? null,
        cliVersion: input.cliVersion ?? existing?.cliVersion ?? null,
        // Chosen at agent_create, or filled once for a row with none: from the home its hook reports, when
        // this session's transcript is under it (above), or from the rollout its process holds open
        // (openProcessAgent). Never changed once known — a hook-triggered bind must carry it forward or the
        // very first SessionStart hook would silently wipe the agent's profile.
        codexHome: existing?.codexHome ?? (refusedHome ? null : reportedHome),
        claudeHome: existing?.claudeHome ?? null,
        // The home the gate looked this session up in, or whatever the row already knew. Carried
        // forward like every field here: a bind REBUILDS the row, and a home dropped at the first hook
        // would send the mirror back to the default store (openharness#191).
        hermesHome,
        ...(hermesHomeDerived ? { hermesHomeDerived: true as const } : {}),
        // Carried forward too: `/new` rebinds the same TUI, and its store is where it was.
        ...(existing?.openclawStateDir && engine === 'openclaw' ? { openclawStateDir: existing.openclawStateDir } : {}),
        ...(existing?.openclawLocal && engine === 'openclaw' ? { openclawLocal: existing.openclawLocal } : {}),
        // And the key it moved off, so a delete still finds what is kept under it.
        ...(earlierSessionIds ? { earlierSessionIds } : {}),
        // And the task not yet typed: the bind is what lets it be typed, so dropping it here would lose it every time.
        ...(existing?.firstTask ? { firstTask: existing.firstTask } : {}),
        dsh: existing?.dsh ?? null,
        dshRuntime: existing?.dshRuntime ?? null,
        agent: existing?.agent ?? null,
        // Carried forward like `agent`: dropped at the first hook, a restart of a harness another agent started came
        // back without its pull request line (found by e2e/agentClient.e2e.ts).
        ...(existing?.startedBy ? { startedBy: existing.startedBy } : {}),
        // And who it was, for the same reason: dropped at the first hook, the windows lost which harness started it.
        ...(existing?.parentAgentId ? { parentAgentId: existing.parentAgentId } : {}),
        // Whose guest's it is: dropped at the first hook, the guest would lose its own harness to the owner.
        ...(existing?.guest ? { guest: existing.guest } : {}),
        ...(existing?.bypassPermission ? { bypassPermission: true } : {}),
        ...(existing?.permissionMode ? { permissionMode: existing.permissionMode } : {}),
        ...(existing?.resumeOnly ? { resumeOnly: true, launch: { state: 'ready' as const } } : {}),
        // Keep alias reservations and profile arguments across the first hook and daemon restart.
        ...(existing?.externalResume && existing.engine === engine ? { externalResume: existing.externalResume } : {}),
        ...(existing?.terminalHost || existing && isTerminalEngine(existing.engine) ? { terminalHost: true } : {}),
        processIdentity: validProcessIdentity(input.processIdentity) ? input.processIdentity : existing?.processIdentity ?? null,
        registeredAt: existing?.registeredAt ?? now,
        touchedAt: now,
        lastHookAt: now,
        lastTranscriptAt: existing?.lastTranscriptAt ?? now,
        // ⚠️ Carried forward, for the reason the ⚠️ on `subscriptionModel` gives: without this line
        // the first hook after an open — the next prompt, a `/clear` — erases it from memory, the next
        // save writes that to disk, and every app's "last used" order forgets the open ever happened.
        ...(existing?.lastOpenedAt ? { lastOpenedAt: existing.lastOpenedAt } : {}),
        ...(existing?.closePlan ? { closePlan: existing.closePlan } : {}),
      }
      entry.tmuxPane = paneProjection(entry.runtimes)
      entry.primaryRuntimeKey = selectedRuntimeKey(entry.runtimes, input.primaryRuntimeKey || existing?.primaryRuntimeKey)
      const previousLaunch = existing?.launch, promoted = !!existing && isTerminalEngine(existing.engine)
      const receipt = await this.persist(deadline, true, false, undefined, { agentId, candidate: entry, displaced: displaced ? [displaced] : undefined, replaceLive: true, allowTransaction: true, refresh: options.refresh, verify: () => { verifyOwner(); proof?.verify() } })
      const committed = this.committedOwner(agentId, receipt)
      if (!committed) return null
      // Fileless sources cannot use transcript revalidation. A fresh native hook
      // source/process check can recover this precise peer-write hold only after
      // its registration has been committed. It cannot clear unrelated holds.
      if (!committed.transcriptPath && options.verifiedNativeSource && committed.identityHold === BINDING_RECOVERY_HOLD) {
        delete committed.identityHold
        committed.evidenceRevision = ++this.evidenceRevision
        committed.interpretationHold = 'Waiting for transcript interpretation to recover.'
      }
      if (orphaned) this.terminalAvailableAgents.delete(orphaned.agentId)
      if (promoted) this.terminalAvailableAgents.add(agentId)
      this.traceLaunch(agentId, previousLaunch, committed.launch, `register ${engine} (${isNew ? 'new session' : 're-register'})`)
      return { entry: structuredClone(committed), isNew, evicted, rebound, orphaned, ...(refusedHome ? { refusedHome: true as const } : {}) }
    })
  }

  /** A session reset is acknowledged only after its exact binding is durably released. */
  async confirmSessionUnbound(agentId: string, sessionId: string, authority: RegistryAuthority = {}): Promise<LaunchPublication> {
    this.assertOpen()
    const selected = this.byAgent(agentId)
    if (!selected || selected.sessionId !== sessionId) return { state: 'not-published' }
    const verify = this.ownerGuard(agentId, authority.current)
    return this.writer.run(async deadline => {
      verify()
      const candidate = structuredClone(this.byAgent(agentId)!)
      this.clearBinding(candidate)
      candidate.touchedAt = Date.now()
      const receipt = await this.persist(deadline, true, false, undefined, {
        agentId, candidate, verify, refresh: authority.refresh, allowTransaction: true,
      })
      const committed = this.committedOwner(agentId, receipt)
      return { state: 'confirmed', entry: committed ? structuredClone(committed) : null }
    }, authority.expires)
  }

  has(sessionId: string): boolean {
    this.assertReady()
    return this.sessionIndex.has(sessionId)
  }

  byAgent(agentId: string): RegisteredSession | undefined {
    this.assertReady()
    return this.agents.get(agentId)
  }

  bySession(sessionId: string): RegisteredSession | undefined {
    this.assertReady()
    const agentId = this.sessionIndex.get(sessionId)
    return agentId ? this.agents.get(agentId) : undefined
  }

  byPaneEngine(tmuxPane: string, engine: AgentEngine): RegisteredSession | undefined {
    return this.byRuntimeEngine({ backend: 'tmux', paneId: tmuxPane }, engine)
  }

  byRuntimeEngine(runtime: TerminalRuntimeRef, engine: AgentEngine): RegisteredSession | undefined {
    this.assertReady()
    const agentId = this.runtimeIndex.get(terminalRouteKey(runtime))
    const entry = agentId ? this.agents.get(agentId) : undefined
    return entry?.engine === engine ? entry : undefined
  }

  byProcess(engine: AgentEngine, identity: ProcessIdentity): RegisteredSession | undefined {
    this.assertReady()
    const agentId = this.processIndex.get(processIdentityKey(engine, identity))
    return agentId ? this.agents.get(agentId) : undefined
  }

  /** The terminal (engine `terminal`, nobody running in it yet) that owns this route, if that is what owns it. */
  byRuntimeTerminal(runtime: TerminalRuntimeRef): RegisteredSession | undefined {
    return this.byRuntimeEngine(runtime, 'terminal')
  }

  /**
   * An engine CLI was started inside a terminal: the row becomes that engine's agent, in place.
   *
   * Same agentId, same pane, same tile — the desktop only sees `engine` change on the next
   * `agent_synced`. The process identity is indexed under the NEW engine (the key is engine-scoped),
   * which is what lets the hook that follows (`register`, `byProcess(engine, …)`) land on this row
   * rather than mint another. `terminalHost` stays set so the exit is recognised (`confirmEngineExit`).
   * Refused for anything but a terminal: an agent already running one engine is never re-labelled.
   */
  /**
   * An archived harness back on the pane its own engine never left: the terminal row that kept the pane gives it back.
   *
   * A restore that could not see a pane's engine archived the harness as exited and handed its pane to a new terminal
   * row (`retainExitedSession`), while the engine ran on: on DESKTOP-0TFH0OJ (2026-11-10) CLI 0.5.97 did that to every
   * Hermes pane, and the harness then answered Enter with `AGENT_BUSY` for as long as its own Hermes lived. The caller
   * has proved [processIdentity] is the archived row's own process, in this pane. The archived row keeps its id, name and
   * conversation, and takes the terminal row's pane; the terminal row goes. The terminal row may already have adopted that
   * engine (a build with the engine fix but not this one): a terminal-born row of the same engine, with no conversation
   * of its own yet, gives the pane back the same way. Null, changing nothing, for any other row, an archived id that is
   * live, or a conversation bound to another row.
   */
  async reinstateArchived(terminalAgentId: string, saved: RegisteredSession, processIdentity: ProcessIdentity,
    authority: RegistryAuthority = {}): Promise<RegisteredSession | null> {
    this.assertOpen()
    const archived = structuredClone(saved), identity = structuredClone(processIdentity)
    const verifyHolder = this.ownerGuard(terminalAgentId, authority.current)
    const verifySaved = this.ownerGuard(archived.agentId)
    return this.writer.run(async deadline => {
      verifyHolder(); verifySaved()
      const terminal = this.byAgent(terminalAgentId)
      const holder = !!terminal && (isTerminalEngine(terminal.engine)
        || (!!terminal.terminalHost && !terminal.sessionId && terminal.engine === archived.engine))
      if (this.writeBlocked || !terminal || !holder || isTerminalEngine(archived.engine)
        || this.agents.has(archived.agentId) || (archived.sessionId && this.bySession(archived.sessionId)) || !validProcessIdentity(identity)) return null
      const candidate: RegisteredSession = { ...archived, active: true, launch: { state: 'ready' }, processIdentity: identity,
        runtimes: structuredClone(terminal.runtimes), primaryRuntimeKey: terminal.primaryRuntimeKey, tmuxPane: terminal.tmuxPane, touchedAt: Date.now() }
      const receipt = await this.persist(deadline, true, false, undefined, { agentId: archived.agentId, candidate,
        displaced: [{ agentId: terminalAgentId, candidate: null }], allowTransaction: true, resumed: true,
        verify: () => { verifyHolder(); verifySaved() }, refresh: authority.refresh })
      const committed = this.committedOwner(archived.agentId, receipt)
      if (!committed) return null
      if (!this.byAgent(terminalAgentId)) this.terminalAvailableAgents.delete(terminalAgentId)
      this.terminalAvailableAgents.add(archived.agentId)
      return structuredClone(committed)
    }, authority.expires)
  }

  async adoptEngine(agentId: string, engine: AgentEngine, processIdentity?: ProcessIdentity | null,
    authority: RegistryAuthority = {}, observed?: Pick<LaunchPublicationInput, 'runtimes' | 'primaryRuntimeKey' | 'gateway' | 'grid'>): Promise<RegisteredSession | null> {
    this.assertOpen()
    const verify = this.ownerGuard(agentId, authority.current)
    const identity = processIdentity ? structuredClone(processIdentity) : null
    const observation = observed ? structuredClone(observed) : undefined
    const routes = observation?.runtimes ? normalizedRuntimes(observation.runtimes) : undefined
    return this.writer.run(async deadline => {
      verify()
      const entry = this.byAgent(agentId)
      if (!entry || !isTerminalEngine(entry.engine) || isTerminalEngine(engine)) return null
      const candidate = structuredClone(entry)
      candidate.engine = engine
      candidate.terminalHost = true
      if (routes) {
        if (!routes.length) return null
        candidate.runtimes = routes
        candidate.primaryRuntimeKey = selectedRuntimeKey(routes, observation?.primaryRuntimeKey ?? candidate.primaryRuntimeKey)
        candidate.tmuxPane = paneProjection(routes)
      }
      if (observation?.gateway !== undefined) candidate.gateway = observation.gateway
      if (observation?.grid !== undefined) candidate.grid = observation.grid
      delete candidate.previousAgentId
      candidate.launch = { state: 'ready' }
      candidate.active = true
      if (validProcessIdentity(identity)) candidate.processIdentity = identity
      candidate.touchedAt = Date.now()
      const receipt = await this.persist(deadline, true, false, undefined, { agentId, candidate, verify,
        refresh: authority.refresh, allowTransaction: true })
      const committed = this.committedOwner(agentId, receipt)
      if (!committed) return null
      this.terminalAvailableAgents.add(agentId)
      return structuredClone(committed)
    }, authority.expires)
  }

  /** Build the shell without changing the live ownership indices. */
  private shellEntry(original: RegisteredSession, separateShell: boolean): RegisteredSession {
    // The archived conversation owns the original Harness ID. Preserve the physical shell under
    // a new identity, without sending input, stopping processes or claiming its route twice.
    const entry = separateShell ? { ...original, agentId: randomUUID(), dsh: null, dshRuntime: null, agent: null, defaultName: this.automaticName('Terminal', new Date()) } : original
    // The shell under a new identity is the person's, not a harness an agent started: kept, a window took the new id for
    // a new child and opened the shell beside the agent, even after the person had closed the child (review of #1217).
    if (separateShell) delete entry.parentAgentId
    // What went with the pane is the archived agent's, its browser's logins among them: never the shell's, which names that
    // agent for whatever new agent takes this pane (decision 19). A release in place names nobody.
    if (separateShell) {
      delete entry.browser
      entry.previousAgentId = original.agentId
    }
    // And its first task: the shell under a new identity would carry a copy beside the archived agent's. A row that stays
    // has had its launch end before the task was typed, and an engine the person starts in its shell is theirs: one they
    // typed the task into themselves would get it twice.
    if (entry.firstTask) {
      delete entry.firstTask
      if (!separateShell) console.log(`[agent] ${sid(original.agentId)} first task dropped · its engine exited before it was typed`)
    }
    this.clearBinding(entry)
    delete entry.resumeOnly
    delete entry.externalResume
    entry.engine = 'terminal'
    entry.terminalHost = true
    entry.processIdentity = null
    this.traceLaunch(entry.agentId, entry.launch, { state: 'ready' }, 'confirmEngineExit')
    entry.launch = { state: 'ready' }
    entry.active = true
    entry.gateway = null
    entry.grid = null
    entry.subscriptionModel = null
    delete entry.launchModel
    delete entry.launchArgs
    entry.model = null
    entry.title = null
    entry.touchedAt = Date.now()
    return entry
  }

  /** Archive/shell announcements follow this durable ownership-group transition. */
  async confirmEngineExit(agentId: string, disposition: 'shell' | 'successor' | 'remove',
    authority: RegistryAuthority = {}): Promise<LaunchPublication> {
    this.assertOpen()
    const verify = this.ownerGuard(agentId, authority.current)
    return this.writer.run(async deadline => {
      verify()
      const original = this.byAgent(agentId)
      if (!original) return { state: 'not-published' }
      const candidate = disposition === 'remove' ? null : this.shellEntry(structuredClone(original), disposition === 'successor')
      const target = candidate?.agentId ?? agentId
      const receipt = await this.persist(deadline, true, false, undefined, {
        agentId: target, candidate, verify, refresh: authority.refresh, allowTransaction: true,
        ...(target !== agentId ? { displaced: [{ agentId, candidate: null }] } : {}),
      })
      if (!this.byAgent(agentId)) this.terminalAvailableAgents.delete(agentId)
      const committed = this.committedOwner(target, receipt)
      if (committed) this.terminalAvailableAgents.add(target)
      return { state: 'confirmed', entry: committed ? structuredClone(committed) : null }
    }, authority.expires)
  }

  updateRuntimes(agentId: string, runtimes: readonly TerminalRuntimeRef[], primaryRuntimeKey?: string): boolean {
    this.assertOpen()
    const entry = this.agents.get(agentId)
    const normalized = normalizedRuntimes(runtimes)
    if (!entry || !normalized.length) return false
    const before = rowFingerprint(persistedRow(entry))
    this.drop(entry)
    entry.runtimes = normalized
    entry.tmuxPane = paneProjection(normalized)
    entry.primaryRuntimeKey = selectedRuntimeKey(normalized, primaryRuntimeKey)
    entry.active = true
    if (rowFingerprint(persistedRow(entry)) !== before) entry.touchedAt = Date.now()
    this.index(entry)
    this.terminalAvailableAgents.add(entry.agentId)
    this.save()
    return true
  }

  setActive(agentId: string, active: boolean): boolean {
    this.assertOpen()
    const entry = this.agents.get(agentId)
    if (!entry || entry.active === active) return !!entry
    entry.active = active
    entry.touchedAt = Date.now()
    this.save()
    return true
  }

  /**
   * Every change of a row's launch state, named by the door it came through.
   *
   * `launch` is what a desk reads as "Starting", and a row that does not leave that state looks stuck
   * on a harness that is working — measured once at 9 minutes on a restored opencode agent whose
   * engine the log had already confirmed up. The state is written from six places and no two of them
   * see each other, so the only way to say which one is fighting which is to have each say so. Rare
   * in a settled daemon (create, restore, an engine exiting); a row that oscillates prints the pair
   * that is doing it, once per pass.
   */
  private traceLaunch(agentId: string, before: AgentLaunch | undefined, after: AgentLaunch | undefined, where: string): void {
    const name = (launch: AgentLaunch | undefined): string => launch ? launch.state : 'none'
    if (name(before) === name(after)) return
    console.log(`[launch] ${agentId.slice(0, 8)} ${name(before)} → ${name(after)} · ${where}`)
  }

  setLaunch(agentId: string, launch: AgentLaunch): RegisteredSession | null {
    this.assertOpen()
    const entry = this.agents.get(agentId)
    if (!entry) return null
    const before = entry.launch
    entry.launch = normalizedLaunch(launch)
    // A held agent runs no engine yet: it is not active until its launch is.
    entry.active = launch.state !== 'failed' && launch.state !== 'held'
    entry.touchedAt = Date.now()
    this.traceLaunch(agentId, before, entry.launch, `setLaunch${launch.state === 'failed' ? ` (${launch.error})` : ''}`)
    this.save()
    return entry
  }

  /** A canonical conversation and every alias have one core owner, including pending adoptions. */
  externalConflict(ids: readonly string[], except?: string): RegisteredSession | undefined {
    const sought = new Set(ids)
    return this.list().find(row => row.agentId !== except &&
      externalReservations(row).some(id => sought.has(id)))
  }

  /** Prepare outside the loop; native authority and durable publication still share one final section. */
  async setExternalResume(agentId: string, value: ExternalResumeIntent, authority: RegistryAuthority = {}): Promise<RegisteredSession | null> {
    this.assertOpen()
    const captured = structuredClone(value)
    const verify = this.ownerGuard(agentId, authority.current)
    return this.writer.run(async deadline => {
      verify()
      if (this.writeBlocked) return null
      const row = this.byAgent(agentId), intent = parseExternalResume(captured)
      if (!row?.externalResume || !intent || row.externalResume.token !== intent.token || row.engine !== intent.request.engine
        || row.externalResume.request.sessionId !== intent.request.sessionId || row.externalResume.takeOver !== intent.takeOver
        || this.externalConflict(externalResumeIds(intent), agentId)) return null
      if (row.externalResume.phase === 'cancelled' && intent.phase !== 'cancelled'
        || row.externalResume.phase === 'admitted' && intent.phase !== 'admitted') return null
      const next: RegisteredSession = { ...row, externalResume: intent }
      if (intent.phase === 'admitted') {
        const session = intent.session!
        Object.assign(next, { sessionId: session.sessionId, cwd: session.cwd, title: session.title || row.title,
          transcriptPath: session.transcriptPath, resumeOnly: true })
      }
      const receipt = await this.persist(deadline, true, false, agentId, { agentId, candidate: next, verify, refresh: authority.refresh })
      const committed = this.committedOwner(agentId, receipt)
      return committed ? structuredClone(committed) : null
    })
  }

  /** A cancelled external intent has no owned conversation to archive. Its deletion must be durable. */
  async finishExternalCancellation(agentId: string): Promise<boolean> {
    this.assertOpen()
    const verify = this.ownerGuard(agentId)
    return this.writer.run(async deadline => {
      verify()
      const row = this.byAgent(agentId)
      if (row?.externalResume?.phase !== 'cancelled') return false
      await this.persist(deadline, true, false, agentId, { agentId, candidate: null, verify })
      if (this.byAgent(agentId)) return false
      this.terminalAvailableAgents.delete(agentId)
      return true
    })
  }

  /** The dispatch and first task are durable before a terminal may replace the inert shell. */
  async beginExternalDispatch(agentId: string, firstTask?: string, authority: RegistryAuthority = {}): Promise<RegisteredSession | null> {
    this.assertOpen()
    const verify = this.ownerGuard(agentId, authority.current)
    return this.writer.run(async deadline => {
      verify()
      const row = this.byAgent(agentId)
      if (row?.externalResume?.phase !== 'admitted' || row.launch?.state !== 'held') return null
      const next: RegisteredSession = { ...row, launch: { state: 'starting' }, active: true,
        externalResume: { ...row.externalResume, dispatched: true }, ...(firstTask ? { firstTask } : {}) }
      const receipt = await this.persist(deadline, true, false, agentId, { agentId, candidate: next, verify })
      const committed = this.committedOwner(agentId, receipt)
      if (committed && firstTask) firstTaskKept(agentId)
      return committed ? structuredClone(committed) : null
    })
  }

  /** A backend may leave its guarded shell only after this exact native token is durable. */
  async beginNativeDispatch(agentId: string, nativeToken: string, authority: RegistryAuthority = {}): Promise<RegisteredSession | null> {
    this.assertOpen()
    const verifyOwner = this.ownerGuard(agentId, authority.current)
    const before = launchIdentity(this.byAgent(agentId))
    return this.writer.run(async deadline => {
      const verify = () => {
        verifyOwner()
        if (launchIdentity(this.byAgent(agentId)) !== before) throw new RegistryOwnershipChanged('the native launch changed before dispatch')
      }
      verify()
      const row = this.byAgent(agentId), launch = normalizedLaunch({ state: 'starting', nativeToken })
      if (!row || launch?.state !== 'starting' || launch.nativeToken !== nativeToken) return null
      const candidate = { ...row, launch, active: true }
      const receipt = await this.persist(deadline, true, false, undefined, { agentId, candidate, verify, refresh: authority.refresh, allowTransaction: true })
      const committed = this.committedOwner(agentId, receipt)
      return committed && launchIdentity(committed) === launchIdentity(candidate) ? structuredClone(committed) : null
    }, authority.expires)
  }

  /** The task is returned only after its removal is durable, to at most one caller. */
  async takeFirstTask(agentId: string): Promise<string | null> {
    this.assertOpen()
    const verify = this.ownerGuard(agentId)
    return this.writer.run(async deadline => {
      verify()
      const row = this.agents.get(agentId)
      const task = row?.firstTask
      if (!row?.sessionId || !task) return null
      const next = { ...row }
      delete next.firstTask
      const receipt = await this.persist(deadline, true, false, undefined, { agentId, candidate: next, verify })
      return this.committedOwner(agentId, receipt) ? task : null
    })
  }

  async setClosePlan(agentId: string, plan: RegisteredSession['closePlan'] | null, authority: RegistryAuthority = {}): Promise<RegisteredSession | null> {
    this.assertOpen()
    const captured = plan ? structuredClone(plan) : null
    const verify = this.ownerGuard(agentId, authority.current)
    return this.writer.run(async deadline => {
      verify()
      const entry = this.agents.get(agentId)
      if (!entry) return null
      const next = { ...entry }
      if (captured) next.closePlan = normalizedClosePlan(captured)
      else delete next.closePlan
      // Each operation owns its intent object, even a repeated same-value cancellation.
      const intended = new Set(this.intended.get(agentId))
      intended.add('closePlan')
      this.intended.set(agentId, intended)
      let receipt: string | undefined
      try { receipt = await this.persist(deadline, true, false, undefined, { agentId, candidate: next, verify, metadata: 'closePlan' }, agentId) }
      catch (error) {
        if (this.intended.get(agentId) === intended) this.intended.delete(agentId)
        throw error
      }
      const committed = this.committedOwner(agentId, receipt)
      return committed ? structuredClone(committed) : null
    })
  }

  /** Mark whether at least one backend placement was verified by this daemon process. */
  setTerminalAvailable(agentId: string, available: boolean): boolean {
    this.assertOpen()
    if (!this.agents.has(agentId)) return false
    if (available) this.terminalAvailableAgents.add(agentId)
    else this.terminalAvailableAgents.delete(agentId)
    return true
  }

  terminalAvailable(agentId: string): boolean {
    this.assertReady()
    return this.terminalAvailableAgents.has(agentId)
  }

  /** The one lookup for anything that arrives from outside: web and device address an agent by `agentId`
   *  for most things but by a bare `sessionId` for turn control, and both must land on the same record. */
  resolve(id: string): RegisteredSession | undefined {
    this.assertReady()
    return this.agents.get(id) ?? this.bySession(id)
  }

  get(sessionId: string): RegisteredSession | undefined {
    return this.bySession(sessionId)
  }

  updateProcessIdentity(
    sessionId: string,
    processIdentity: ProcessIdentity,
    gateway?: 'ori' | null,
    grid?: GridAssignment | null,
  ): boolean {
    this.assertOpen()
    const session = this.resolve(sessionId)
    if (!session || !validProcessIdentity(processIdentity)) return false
    const before = rowFingerprint(persistedRow(session))
    this.drop(session)
    session.processIdentity = processIdentity
    // A Codex's argv, which cannot change under a running process, is the truth for this pid, and an engine with no
    // gateway Harness can see says null. Undefined (Claude Code, OpenCode and Hermes, whose hook says it, or a
    // relaunch) keeps what the row knew.
    if (gateway !== undefined) session.gateway = gateway
    // The grid follows the same rule. It matters most right after a retarget: the respawned pane is a new
    // pid, and this is where its new grid lands.
    if (grid !== undefined) session.grid = grid
    if (rowFingerprint(persistedRow(session)) !== before) session.touchedAt = Date.now()
    this.index(session)
    this.save()
    return true
  }

  /** Forget the process an agent was last seen as — its pane is gone, so the pid is gone with it. */
  clearProcessIdentity(agentId: string): boolean {
    this.assertOpen()
    const session = this.agents.get(agentId)
    if (!session) return false
    if (!session.processIdentity) return true
    this.drop(session)
    session.processIdentity = null
    session.touchedAt = Date.now()
    this.index(session)
    this.save()
    return true
  }

  setBypassPermission(agentId: string, bypassPermission: boolean): boolean {
    this.assertOpen()
    const session = this.agents.get(agentId)
    if (!session) return false
    if ((session.bypassPermission === true) === bypassPermission) return true
    if (bypassPermission) session.bypassPermission = true
    else delete session.bypassPermission
    session.touchedAt = Date.now()
    this.save()
    return true
  }

  /** Fill in the mode a row did not record — discovery read it off the live argv — so a relaunch can
   *  reapply exactly that mode rather than the yes/no `bypassPermission` reduces it to. Fill-only,
   *  like `setCodexHome`: the mode create recorded is the person's choice and is never re-derived
   *  (the same name again is a no-op). A name that is not a mode is refused, as on load. */
  setPermissionMode(agentId: string, permissionMode: string): boolean {
    this.assertOpen()
    const session = this.agents.get(agentId)
    if (!session || !permissionModeName(permissionMode)) return false
    if (session.permissionMode) return session.permissionMode === permissionMode
    session.permissionMode = permissionMode
    session.touchedAt = Date.now()
    this.save()
    return true
  }

  /** Put a row back in the folder its transcript belongs to (cwdRepair.ts). Any engine, any value:
   *  the caller has already proved the new folder from the transcript. */
  setCwd(agentId: string, cwd: string): boolean {
    this.assertOpen()
    const session = this.agents.get(agentId)
    if (!session || session.cwd === cwd) return false
    session.cwd = cwd
    session.touchedAt = Date.now()
    this.save()
    return true
  }

  /** Fill in the profile a row did not know (its CODEX_HOME, which discovery found from the rollout its process holds
   *  open), for an engine whose sessions follow one (its session store's `sessions.profile`). Never overwrites: the
   *  profile is chosen once, see `codexHome`. */
  setCodexHome(agentId: string, codexHome: string): boolean {
    this.assertOpen()
    const session = this.agents.get(agentId)
    if (!session || !sessionStoreOf(session.engine)?.sessions.profile || session.codexHome) return false
    session.codexHome = codexHome
    session.touchedAt = Date.now()
    this.save()
    return true
  }

  /** Fill in the Hermes home a row did not know — found by looking for its session in each store, or
   *  from the store its process holds open. Never overwrites: like `setCodexHome`, a session does not move between
   *  homes, and a later probe that could not list the process must not take the answer away. `derived`: the home is
   *  the daemon's path of a sandboxed process's home (RegisteredSession.hermesHomeDerived). A row that has a home is
   *  never marked either: a descriptor cannot tell an older daemon's row from one Harness launched by name, whose
   *  relaunch must export its home. */
  setHermesHome(agentId: string, hermesHome: string, derived = false): boolean {
    this.assertOpen()
    const session = this.agents.get(agentId)
    if (!session || session.engine !== 'hermes' || session.hermesHome) return false
    session.hermesHome = hermesHome
    if (derived) session.hermesHomeDerived = true
    session.touchedAt = Date.now()
    this.save()
    return true
  }

  /** Where an OpenClaw session's TUI keeps its state, read off the TUI while it runs: the one it holds now wins. */
  setOpenclawStateDir(agentId: string, stateDir: string): boolean {
    this.assertOpen()
    const session = this.agents.get(agentId)
    // A `--local` row's store is its folder: a TUI seen elsewhere never moves it off.
    if (!session || session.engine !== 'openclaw' || session.openclawLocal || session.openclawStateDir === stateDir) return false
    session.openclawStateDir = stateDir
    session.touchedAt = Date.now()
    this.save()
    return true
  }

  /**
   * Record the launch an agent was last put onto a grid with (`agent_create` / `agent_retarget`) and
   * what it decided about web search — or null for both once the agent was moved back to the engine's
   * own login. One call for the pair on purpose: a status without its launch, or a launch without its
   * status, is a row the app would read wrongly.
   */
  async setGridLaunch(agentId: string, launch: GridLaunchRecord | null, authority: RegistryAuthority = {}): Promise<boolean> {
    this.assertOpen()
    const session = this.agents.get(agentId)
    if (!session) return false
    const verify = this.ownerGuard(agentId, authority.current)
    return this.writer.run(async deadline => this.withGridRecord(session, launch, async record => {
      verify()
      const candidate = structuredClone(this.byAgent(agentId)!)
      candidate.gridLaunch = record?.override ?? null
      candidate.gridWebSearch = record?.webSearch ?? null
      candidate.touchedAt = Date.now()
      const receipt = await this.persist(deadline, true, false, undefined, { agentId, candidate, verify, refresh: authority.refresh, allowTransaction: true })
      return this.committedOwner(agentId, receipt) !== null
    }), authority.expires)
  }

  /** Record the model and effort [agentId]'s session relaunches with (RegisteredSession.launchModel); null forgets it. */
  async setLaunchModel(agentId: string, launchModel: LaunchModel | null, authority: RegistryAuthority = {}): Promise<RegisteredSession | null> {
    this.assertOpen()
    const session = this.agents.get(agentId)
    if (!session) return null
    const verify = this.ownerGuard(agentId, authority.current)
    const stored = storedLaunchModel(launchModel)
    return this.writer.run(async deadline => {
      verify()
      const candidate = structuredClone(this.byAgent(agentId)!)
      if (stored) candidate.launchModel = stored
      else delete candidate.launchModel
      candidate.touchedAt = Date.now()
      const receipt = await this.persist(deadline, true, false, undefined, { agentId, candidate, verify, allowTransaction: true })
      const committed = this.committedOwner(agentId, receipt)
      return committed ? structuredClone(committed) : null
    }, authority.expires)
  }

  /**
   * An app opened this agent: stamp `lastOpenedAt` with THIS daemon's clock. Never takes a time from
   * the caller — a phone and a laptop whose clocks disagree would otherwise order the same agents
   * differently, which is the one thing this field exists to prevent.
   *
   * `updatedAt` is left alone on purpose. That is the row's bookkeeping (`session_get`'s timestamp),
   * and looking at an agent changes nothing about the agent. The save
   * still happens: a row is written whenever its bytes differ from the last write, whichever field
   * moved.
   */
  markOpened(agentId: string): RegisteredSession | null {
    this.assertOpen()
    const session = this.agents.get(agentId)
    if (!session) return null
    session.lastOpenedAt = Date.now()
    this.save()
    return session
  }

  touchTranscript(sessionId: string, at = Date.now()): boolean {
    this.assertOpen()
    const session = this.bySession(sessionId)
    if (!session) return false
    session.lastTranscriptAt = at
    session.touchedAt = Math.max(session.touchedAt, at)
    this.save()
    return true
  }

  /**
   * The engine's title for [sessionId]'s conversation, as the title sync reads it. [quiet]: the agent's last turn was a line typed
   * for it alone (core/agents/quietTitles.ts), so a title that would name it is that line's: kept as its `quietTitle` and not taken,
   * then or later. The agent keeps the name it had until its engine titles the conversation anew.
   */
  updateTitle(sessionId: string, title: string | null, quiet = false): RegisteredSession | null {
    this.assertOpen()
    const session = this.resolve(sessionId)
    if (!session) return null
    const next = titleDisplayName(title)
    const current = titleDisplayName(session.title)
    if (next === current) return session
    // Only a title that changed pays for this: the sync reads every agent's title every 5 s, and most are as they were.
    const naming = namingTitle(next, session)
    if (naming && (quiet || naming === session.quietTitle)) {
      if (naming === session.quietTitle) return session
      session.quietTitle = naming
      this.save()
      return session
    }
    session.title = next
    session.touchedAt = Date.now()
    this.save()
    return session
  }

  displayName(s: RegisteredSession): string {
    return projectDisplayName(s)
  }

  /**
   * Carry a user-chosen name from one session id to another.
   *
   * For a session ROTATION: `/clear` in claude (and `/new` in opencode) ends one session id and starts
   * another under the same live process in the same pane. That is the same agent to the person watching it,
   * so the name they gave it has to come along — otherwise clearing the context silently renames their
   * agent back to a default.
   */
  inheritName(fromSessionId: string, toSessionId: string): void {
    this.assertOpen()
    const name = NAME_OVERRIDES.get(fromSessionId)
    if (!name || NAME_OVERRIDES.has(toSessionId)) return
    NAME_OVERRIDES.set(toSessionId, name)
    this.saveNames()
  }

  async rename(id: string, name: string, authority: RegistryAuthority = {}): Promise<RegisteredSession | null> {
    this.assertOpen()
    const s = this.resolve(id)
    if (!s) return null
    const trimmed = name.trim()
    if (!trimmed) return null
    // Names are stored under the ENGINE session id on purpose: that is what makes `claude --resume <id>`
    // come back wearing the name the user gave it, even though the resume is a brand-new agent.
    const key = s.sessionId || s.agentId
    const verify = this.ownerGuard(s.agentId, authority.current)
    return this.writer.run(async deadline => {
      verify()
      await this.persistNames(deadline, { key, value: trimmed, verify })
      verify()
      return structuredClone(this.byAgent(s.agentId)!)
    }, authority.expires)
  }

  async deleteSavedNames(ids: string[]): Promise<void> {
    this.assertOpen()
    for (const id of ids) { this.deletedNames.add(id); NAME_OVERRIDES.delete(id) }
    this.namesRevision++
    this.namesUnsaved = true
    return this.writer.run(deadline => this.persistNames(deadline))
  }

  list(): RegisteredSession[] {
    this.assertReady()
    return Array.from(this.agents.values())
  }

  active(): RegisteredSession[] {
    return this.list().filter((entry) => entry.active)
  }

  /** The one public list: a verified terminal pane is sufficient even when its engine is dormant. */
  advertised(): RegisteredSession[] {
    return this.list().filter((entry) => this.terminalAvailableAgents.has(entry.agentId))
  }

  /**
   * Saves are held back while [apply] runs, and made once when it is done. [holdSavesMs] bounds the
   * hold: a transaction whose apply has not finished by then stops holding saves back — what it has
   * changed so far is saved, and what it changes after is saved as it changes — instead of the
   * registry going unsaved for as long as it runs. A reconcile pass stuck on an engine's files did
   * that (RECONCILE_PASS_DEADLINE_MS).
   */
  async transaction<T>(apply: () => T | Promise<T>, options: { holdSavesMs?: number } = {}): Promise<T> {
    this.assertOpen()
    this.transactionDepth++
    let holding = true, completion: Promise<void> = Promise.resolve()
    const release = (): Promise<void> => {
      if (!holding) return completion
      holding = false
      this.transactionDepth--
      if (this.transactionDepth === 0) {
        if (this.savePending) {
          this.savePending = false
          completion = this.writer.run(async deadline => { await this.persist(deadline, 'observation') })
          this.transactionCompletion = completion
          const batch = completion
          const settled = () => { if (this.transactionCompletion === batch) this.transactionCompletion = Promise.resolve() }
          void batch.then(settled, settled)
        }
        completion = completion.then(() => {
          while (this.transactionDepth === 0 && this.afterTransactionCallbacks.length) this.afterTransactionCallbacks.shift()!.run()
        }, error => {
          for (const callback of this.afterTransactionCallbacks.splice(0)) callback.reject(error)
          throw error
        })
      }
      return completion
    }
    const timer = options.holdSavesMs === undefined ? undefined : setTimeout(() => {
      console.warn(`[registry] a transaction has held saves back for ${options.holdSavesMs} ms; saving without waiting for it`)
      void release().catch(() => console.error('[registry] transaction save failed'))
    }, options.holdSavesMs)
    timer?.unref?.()
    try {
      // Host moves observe a synchronous batch immediately; durability belongs to this Promise.
      const result = apply()
      return result instanceof Promise ? await result : result
    } finally {
      clearTimeout(timer)
      await release()
    }
  }

  /** Run a durability-sensitive action only after the current discovery batch has committed. */
  async afterTransaction<T>(action: () => T | Promise<T>): Promise<T> {
    this.assertOpen()
    if (this.transactionDepth === 0) return this.transactionCompletion.then(action)
    return new Promise<T>((resolve, reject) => {
      this.afterTransactionCallbacks.push({ run: () => {
        try { resolve(action()) } catch (error) { reject(error) }
      }, reject })
    })
  }

  flush(options: { exiting?: boolean } = {}): Promise<void> {
    if (options.exiting) this.exiting = true
    const finish = () => {
      const write = async (deadline: RegistryWriteDeadline) => {
        await this.persistNames(deadline)
        await this.persist(deadline, 'observation', options.exiting === true)
      }
      return options.exiting ? this.writer.finish(write) : this.writer.run(write)
    }
    // Closing the writer first would let a late load install rows it cannot persist.
    return this.loading ? this.loading.then(finish, async error => {
      if (options.exiting) await this.writer.finish(async () => {})
      throw error
    }) : finish()
  }

  private ownerGuard(agentId: string, current?: () => boolean): () => void {
    const identity = ownershipIdentity(this.agents.get(agentId))
    return () => {
      if (current?.() === false || ownershipIdentity(this.agents.get(agentId)) !== identity) {
        throw new RegistryOwnershipChanged('the registry owner changed while its write was being prepared')
      }
    }
  }

  private committedOwner(agentId: string, receipt: string | undefined): RegisteredSession | null {
    const row = this.agents.get(agentId)
    return row && receipt !== undefined && ownershipIdentity(row) === receipt ? row : null
  }

  private save(): Promise<void> {
    if (this.transactionDepth > 0) { this.savePending = true; return Promise.resolve() }
    if (this.pendingObservation) return this.pendingObservation
    let started = false
    const pending = this.writer.run(async deadline => {
      started = true
      this.pendingObservation = undefined
      await this.persist(deadline)
    }).catch(() => { console.error('[registry] save failed') })
    if (!started) this.pendingObservation = pending
    void pending.finally(() => { if (this.pendingObservation === pending) this.pendingObservation = undefined })
    return pending
  }

  private preparedOwnerGuard(before: Map<string, RegisteredSession>, candidates: Map<string, Record<string, unknown>>,
    changed: Set<string>, target?: string): () => void {
    const selected = new Set(changed)
    if (target) selected.add(target)
    const claims = (row: RegisteredSession): string[] => [
      ...(row.processIdentity ? [`p:${processIdentityKey(row.engine, row.processIdentity)}`] : []),
      ...row.runtimes.map(runtime => `r:${terminalRouteKey(runtime)}`),
      ...externalReservations(row).map(id => `s:${id}`),
    ]
    const wanted = new Set([...selected].flatMap(id => {
      const row = strictPersistedRow(candidates.get(id))
      return row ? claims(row) : []
    }))
    return () => {
      // Candidate claims are private snapshots; every live claimant is read again at each fence.
      const affected = new Set(selected)
      for (const row of Array.from(this.agents.values())) if (claims(row).some(claim => wanted.has(claim))) affected.add(row.agentId)
      for (const id of affected) if (ownershipIdentity(this.agents.get(id)) !== ownershipIdentity(before.get(id))) {
        throw new RegistryOwnershipChanged('the registry ownership group changed while its write was being prepared')
      }
    }
  }

  /** Adopt a peer's complete ownership group without granting native control. */
  private reconcileUnconfirmed(latest: Map<string, Record<string, unknown>>, affected: Set<string>): void {
    const selected = new Map(Array.from(this.agents.values()).map(row => [row.agentId, row]))
    // Follow the same process, terminal and owned/provisional conversation
    // identities as validatedRows, including external canonical IDs and aliases.
    const peer = new Map([...latest].map(([id, value]) => [id, strictPersistedRow(value)]))
    const claims = (row: RegisteredSession): string[] => [
      ...(row.processIdentity ? [`p:${processIdentityKey(row.engine, row.processIdentity)}`] : []),
      ...row.runtimes.map(runtime => `r:${terminalRouteKey(runtime)}`),
      ...externalReservations(row).map(id => `${externalResumePending(row.externalResume) ? 'i' : 's'}:${id}`),
    ]
    const owners = new Map<string, Set<string>>()
    for (const row of [...selected.values(), ...peer.values()]) if (row) {
      for (const claim of claims(row)) {
        const ids = owners.get(claim) ?? new Set<string>()
        ids.add(row.agentId); owners.set(claim, ids)
      }
    }
    for (const id of affected) for (const row of [selected.get(id), peer.get(id)]) if (row) {
      for (const claim of claims(row)) for (const otherId of owners.get(claim)!) affected.add(otherId)
    }
    for (const id of affected) {
      const row = strictPersistedRow(latest.get(id))
      // The recovered live owner must not share nested values with the locked peer image.
      if (row) selected.set(id, structuredClone(row))
      else selected.delete(id)
    }
    if (!validatedRows([...selected.values()].map(persistedRow))) {
      throw new IdentityReadUnavailable('the recovered ownership group is incomplete')
    }
    for (const id of affected) {
      const old = this.agents.get(id)
      if (old) this.drop(old)
    }
    for (const id of affected) {
      const row = selected.get(id)
      if (row) {
        if (row.sessionId) row.identityHold = BINDING_RECOVERY_HOLD
        row.evidenceRevision = ++this.evidenceRevision
        this.index(row, false)
        this.persistedBaseline.set(id, rowFingerprint(persistedRow(row)))
      } else this.persistedBaseline.delete(id)
      this.intended.delete(id)
    }
    this.persistedContents = null
  }

  private async persist(deadline: RegistryWriteDeadline, strict: boolean | 'observation' = false, exiting = false, externalAgentId?: string,
    bindingCommit?: { agentId: string; candidate: RegisteredSession | null; verify: () => void; refresh?: () => Promise<void>; replaceLive?: boolean;
      displaced?: Array<{ agentId: string; candidate: RegisteredSession | null }>; allowTransaction?: boolean; resumed?: boolean; metadata?: 'closePlan' },
    mutationAgentId = externalAgentId ?? bindingCommit?.agentId): Promise<string | undefined> {
    // Discovery batches observations, but a recovered binding must be durable before interpretation
    // resumes. Commit a complete batch now; an incomplete batch remains held and retries next pass.
    if (this.transactionDepth > 0 && !exiting && !bindingCommit?.allowTransaction) {
      if (strict) throw new Error('Cannot acknowledge a close intent inside an uncommitted registry transaction')
      this.savePending = true
      return
    }
    if (this.writeBlocked) {
      if (strict) throw new Error('The saved session registry is unavailable')
      console.error('[registry] save skipped because the loaded registry requires operator repair')
      return
    }
    if (bindingCommit) bindingCommit = { ...bindingCommit,
      candidate: bindingCommit.candidate ? structuredClone(bindingCommit.candidate) : null,
      ...(bindingCommit.displaced ? { displaced: bindingCommit.displaced.map(row => ({ ...row,
        candidate: row.candidate ? structuredClone(row.candidate) : null })) } : {}) }
    const entered: AgentEngine[] = []
    let committedOwner: string | undefined
    try {
      deadline.check()
      const currentRows = new Map(Array.from(this.agents.values()).map((entry) => {
        const row = structuredClone(persistedRow(entry)) as unknown as Record<string, unknown>
        return [entry.agentId, row] as const
      }))
      // Preserve authority now; unchanged observations never need to serialize it.
      const beforeOwners = new Map(strict ? Array.from(this.agents.values()).map(row => [row.agentId, {
        ...currentRows.get(row.agentId), evidenceRevision: row.evidenceRevision,
      } as unknown as RegisteredSession]) : [])
      // Only these owned snapshots share comparisons; live rows must be read afresh after preparation.
      const fingerprints = new WeakMap<Record<string, unknown>, string>()
      const snapshotFingerprint = (row: Record<string, unknown>): string => {
        let value = fingerprints.get(row)
        if (value === undefined) {
          value = rowFingerprint(row)
          fingerprints.set(row, value)
        }
        return value
      }
      const beforeCommit = new Map([...currentRows].map(([id, row]) => [id, snapshotFingerprint(row)]))
      const capturedIntents = new Map(this.intended)
      const intentRow = (row: RegisteredSession | null) => row ? { ...persistedRow(row), touchedAt: 0, boundAt: 0, lastHookAt: 0, lastTranscriptAt: 0 } : null
      const intent = bindingCommit ? rowFingerprint({ candidate: intentRow(bindingCommit.candidate),
        displaced: bindingCommit.displaced?.map(row => ({ agentId: row.agentId, candidate: intentRow(row.candidate) })) }) : undefined
      let unconfirmed = this.unconfirmedBinding
      let confirming = !!unconfirmed && !!bindingCommit && unconfirmed.agentId === bindingCommit.agentId && unconfirmed.intent === intent
        && [...unconfirmed.affected].every(id => beforeCommit.get(id) === unconfirmed!.before.get(id))
      if (bindingCommit) {
        if (bindingCommit.candidate) currentRows.set(bindingCommit.agentId, structuredClone(persistedRow(bindingCommit.candidate)) as unknown as Record<string, unknown>)
        else currentRows.delete(bindingCommit.agentId)
        for (const displaced of bindingCommit.displaced ?? []) {
          if (displaced.candidate) currentRows.set(displaced.agentId, structuredClone(persistedRow(displaced.candidate)) as unknown as Record<string, unknown>)
          else currentRows.delete(displaced.agentId)
        }
        if (bindingCommit.resumed) for (const [id, row] of currentRows) {
          if (row.previousAgentId !== bindingCommit.agentId) continue
          const { previousAgentId: _previous, ...resumed } = row
          currentRows.set(id, { ...resumed, touchedAt: bindingCommit.candidate!.touchedAt })
        }
      }
      // A discovery batch may be awaiting a reader after acknowledging a complete binding. Exit cannot
      // wait for it. Check BEFORE merge conflict resolution: an incomplete pane swap must never be
      // made to look valid by evicting its other owner. Its last durable snapshot remains untouched.
      if (exiting && !validatedRows([...currentRows.values()])) throw new Error('Cannot flush an incomplete registry transaction at exit')
      if (bindingCommit && !validatedRows([...currentRows.values()])) throw new IdentityReadUnavailable('the registry observation batch is incomplete')
      if (this.namesUnsaved) await this.persistNames(deadline)
      await privateRegistryDirectory(env.ADAPTER_DATA_DIR)
      deadline.check()
      // Discovery still calls save on an unchanged observation so a daemon-down hook's commit is
      // noticed. If neither side changed, avoid the lock's process probe and all three fsyncs.
      // Read through the normal ownership/mode/no-symlink checks; timestamps cannot prove equality.
      // A concurrent commit after this read is picked up on the next pass, as after a locked save.
      // Close intents always take the durable path, even when an identical request is retried.
      if (strict !== true && !unconfirmed && this.persistedContents !== null
        && currentRows.size === this.persistedBaseline.size
        && [...currentRows].every(([id]) => this.persistedBaseline.get(id) === beforeCommit.get(id))) {
        const same = await sessionStorage.equal(this.persistedContents)
        if (same) {
          this.persistedContents = same
          // An old writer may atomically publish identical bytes. Keep launch witnesses fresh without a rewrite.
          for (const row of this.agents.values()) if (row.gridLaunch) row.gridLaunch = { ...row.gridLaunch,
            credential: { ...row.gridLaunch.credential, source: { kind: 'image', proof: same } } }
          return
        }
      }
      await sessionStorage.withWrite(deadline.expires, () => registryFileLock(env.ADAPTER_DATA_DIR, deadline, async checkOwner => {
        const priorSource = unconfirmed?.source
        const source = await sessionStorage.retain({ kind: 'registry' })
        const normalizedSourceRows = new Map<object, RegisteredSession>()
        const normalizeSourceRow = (value: unknown): RegisteredSession | null =>
          value && typeof value === 'object' && normalizedSourceRows.has(value)
            ? normalizedSourceRows.get(value)! : strictPersistedRow(value)
        try {
        const latestValues: unknown[] = (() => {
          deadline.check()
          if (source.image.state === 'missing') return []
          if (!source.image.json) throw new SyntaxError('registry is not JSON')
          const stored = source.image.value
          if (!Array.isArray(stored)) throw new Error('registry root changed to a non-array value')
          const parsed = withoutRetiredRows(stored).rows
          if (parsed.some(hasUnknownRowSchema) || parsed.some(value => !!value && typeof value === 'object'
        && Object.hasOwn(value, 'externalResume') && !strictPersistedRow(value))) {
            throw new Error('registry contains an unknown row schema')
          }
          const legacyRows = parsed.filter((row) => !row || typeof row !== 'object' || !Object.hasOwn(row, 'schemaVersion'))
          if (legacyRows.some((row) => !validLegacyRegistryRow(row))) {
            throw new Error('registry contains a malformed legacy row')
          }
          const v2Rows = parsed.filter((row) => !!row && typeof row === 'object'
            && (row as { schemaVersion?: unknown }).schemaVersion === 2)
          if (v2Rows.length) {
            const normalized = validatedRows(v2Rows)
            if (!normalized) throw new Error('registry contains a malformed v2 row')
            for (const [index, value] of v2Rows.entries()) {
              const row = value as Record<string, unknown>
              // Historical incomplete rows still receive their original per-call clock defaults.
              if (typeof row.registeredAt === 'number' && savedTouchedAt(row) !== null
                && typeof row.lastHookAt === 'number' && typeof row.lastTranscriptAt === 'number') {
                normalizedSourceRows.set(row, normalized[index])
              }
            }
          }
          return parsed
        })()
        const latest = new Map<string, Record<string, unknown>>()
        for (const value of latestValues) {
          const id = rowId(value)
          if (id) latest.set(id, value as Record<string, unknown>)
        }

        if (unconfirmed && [...unconfirmed.affected].some(id => {
          const written = unconfirmed!.image.find(row => rowId(row) === id)
          return (latest.has(id) ? snapshotFingerprint(latest.get(id)!) : undefined)
            !== (written ? rowFingerprint(written) : undefined)
        })) {
          // A peer changed part of our unpublished ownership group. Its complete
          // validated table wins that whole group; no fragment of the old draft may
          // overwrite it. Recovered bindings stay held until native revalidation.
          this.reconcileUnconfirmed(latest, unconfirmed.affected)
          for (const id of unconfirmed.affected) {
            const row = this.agents.get(id)
            // Recovery exposed this row after the initial capture; preparation needs its own snapshot too.
            if (row) currentRows.set(id, structuredClone(persistedRow(row)) as unknown as Record<string, unknown>)
            else currentRows.delete(id)
          }
          const revoked = mutationAgentId !== undefined && unconfirmed.affected.has(mutationAgentId)
            || bindingCommit?.displaced?.some(row => unconfirmed!.affected.has(row.agentId)) === true
          this.unconfirmedBinding = unconfirmed = null
          confirming = false
          if (revoked) throw new RegistryOwnershipChanged('the unconfirmed binding has a different durable owner; retry with fresh evidence')
        }
        // Roll back only the rows of our unpublished group for a different local
        // operation. Unrelated peer commits remain in the merge throughout recovery.
        if (unconfirmed && !confirming) {
          for (const id of unconfirmed.affected) {
            const prior = unconfirmed.prior.find(row => rowId(row) === id)
            if (prior) latest.set(id, prior as Record<string, unknown>)
            else latest.delete(id)
          }
        }
        if (confirming) {
          for (const id of unconfirmed!.affected) {
            const written = unconfirmed!.image.find(row => rowId(row) === id)
            if (written) currentRows.set(id, written as unknown as Record<string, unknown>)
            else currentRows.delete(id)
          }
        }
        if (bindingCommit?.metadata && !confirming) {
          const baseline = this.persistedBaseline.get(bindingCommit.agentId)
          const prior = baseline ? strictPersistedRow(JSON.parse(baseline)) : null
          const latestOwner = strictPersistedRow(latest.get(bindingCommit.agentId))
          if (latestOwner && ownershipIdentity(latestOwner) !== ownershipIdentity(prior ?? undefined)) {
            throw new RegistryOwnershipChanged('the close intent has a different durable owner')
          }
          if (!latestOwner) currentRows.delete(bindingCommit.agentId)
        }
        // Reconciliation is finished. These checks and the first merge read this private table without
        // yielding; the post-refresh live merge must construct its own index.
        let identities: MergeIdentities | undefined
        if (bindingCommit && !bindingCommit.metadata && !confirming) {
          if ((latest.has(bindingCommit.agentId) ? snapshotFingerprint(latest.get(bindingCommit.agentId)!) : undefined)
            !== this.persistedBaseline.get(bindingCommit.agentId)) {
            throw externalAgentId ? new RegistryOwnershipChanged('The durable adoption changed while it was being prepared')
              : new IdentityReadUnavailable('the saved binding changed while its evidence was being read')
          }
          const displacedIds = new Set(bindingCommit.displaced?.map(row => row.agentId))
          for (const displaced of bindingCommit.displaced ?? []) {
            if ((latest.has(displaced.agentId) ? snapshotFingerprint(latest.get(displaced.agentId)!) : undefined)
              !== this.persistedBaseline.get(displaced.agentId)) {
              throw new IdentityReadUnavailable('the displaced binding changed while its evidence was being read')
            }
          }
          const candidate = bindingCommit.candidate
          const routes = new Set(candidate?.runtimes.map(terminalRouteKey) ?? [])
          identities = new MergeIdentities(latest, normalizeSourceRow)
          for (const [otherId, other] of identities.sharing(bindingCommit.agentId,
            candidate?.processIdentity?.pid, candidate?.sessionId ?? '', routes)) {
            if (!candidate || displacedIds.has(otherId)) continue
            if ((other.engine === candidate.engine && sameProcessIdentity(other.processIdentity, candidate.processIdentity))
              || (!!candidate.sessionId && other.sessionId === candidate.sessionId)
              || other.runtimes.some(runtime => routes.has(terminalRouteKey(runtime)))) {
              throw externalAgentId ? new RegistryOwnershipChanged('The external conversation has another durable owner')
                : new IdentityReadUnavailable('the conversation or terminal has a different durable owner')
            }
          }
        }
        if (externalAgentId && (latest.has(externalAgentId) ? snapshotFingerprint(latest.get(externalAgentId)!) : undefined)
          !== this.persistedBaseline.get(externalAgentId)) {
          throw new RegistryOwnershipChanged('The durable adoption changed while it was being prepared')
        }
        // Adoption never uses the normal winner/eviction policy. A daemon-down hook may have
        // claimed its conversation since the core's last read; refuse admission inside this lock.
        for (const [id, value] of currentRows) {
          const intent = parseExternalResume(value.externalResume)
          // Every strict admission/signal/dispatch transition earns permission here. Ordinary
          // observations may persist a held provisional overlap; they never authorize a signal.
          if (id !== externalAgentId || !intent || intent.phase === 'cancelled') continue
          const claims = new Set(externalReservations(value as unknown as RegisteredSession))
          for (const [otherId, otherValue] of latest) {
            if (otherId === id) continue
            const other = strictPersistedRow(otherValue)
            if (other && externalReservations(other).some(claim => claims.has(claim))) {
              throw new RegistryOwnershipChanged('The external conversation has another durable owner')
            }
          }
        }
        // A binding may flush an already-staged discovery batch. Every changed row
        // must still own what the observation claims, not only the hook's own row.
        const changed = new Set(strict || bindingCommit
          ? [...new Set([...this.persistedBaseline.keys(), ...currentRows.keys()])].filter(id =>
            !this.persistedBaseline.has(id) || this.persistedBaseline.get(id) !== (currentRows.has(id) ? snapshotFingerprint(currentRows.get(id)!) : undefined))
          : [])
        if (bindingCommit) {
          identities ??= new MergeIdentities(latest, normalizeSourceRow)
          for (const id of changed) {
            if (bindingCommit.metadata && id === bindingCommit.agentId) continue
            if (confirming && unconfirmed!.affected.has(id)) continue
            if ((latest.has(id) ? snapshotFingerprint(latest.get(id)!) : undefined) !== this.persistedBaseline.get(id)) {
              throw new IdentityReadUnavailable('a staged registry observation has a different durable owner')
            }
            const candidate = currentRows.has(id) ? strictPersistedRow(currentRows.get(id)) : null
            if (!candidate) continue
            const routes = new Set(candidate.runtimes.map(terminalRouteKey))
            for (const [otherId, other] of identities.sharing(id, candidate.processIdentity?.pid, candidate.sessionId, routes)) {
              if (changed.has(otherId)) continue
              if ((other.engine === candidate.engine && sameProcessIdentity(other.processIdentity, candidate.processIdentity))
                || (!!candidate.sessionId && other.sessionId === candidate.sessionId)
                || other.runtimes.some(runtime => routes.has(terminalRouteKey(runtime)))) {
                throw new IdentityReadUnavailable('a staged registry observation conflicts with a newer durable owner')
              }
            }
          }
        }
        const merged = [...mergedForSave(latest, currentRows, this.persistedBaseline, capturedIntents, snapshotFingerprint, identities, normalizeSourceRow).values()]
        const rows = validatedRows(merged, normalizeSourceRow)
        if (!rows) throw new Error('registry transaction would violate global identity invariants')
        const candidateRows = rows.map(row => persistedRow(row))
        // Reuse only the exact validated source objects in this non-yielding merge. Fresh live rebases
        // must normalize changed objects again, and no comparison cache survives preparation.
        normalizedSourceRows.clear()
        const prepared = await prepareSessionPublication(sessionStorage, { kind: 'registry' }, source, candidateRows, deadline)
        // These graphs are private capture/merge results. Publication accepts only row-bound reference
        // replacements, so a second child metadata image cannot replace or revalidate session authority.
        const projected = prepared.value as Array<{ gridLaunch?: StoredGridLaunch | null }>
        for (let index = 0; index < rows.length; index++) rows[index].gridLaunch = projected[index].gridLaunch
        // Exact prepared objects may survive the fresh live rebase unchanged; their normalized rows
        // are still private. Changed/live-derived objects must be parsed again after refresh.
        const preparedRows = new Map<object, RegisteredSession>()
        const preparedImages = new Map<RegisteredSession, Record<string, unknown>>()
        const serialized = rows.map(row => {
          const saved = persistedRow(row)
          preparedRows.set(saved, row)
          preparedImages.set(row, saved as unknown as Record<string, unknown>)
          return saved
        })
        // Recovery must already exist when an asynchronous directory flush lets the reply timer run.
        const recovery = (() => {
          if (!bindingCommit && !unconfirmed) return null
          const prior = new Map(latest)
          if (unconfirmed) for (const id of unconfirmed.affected) {
            const original = unconfirmed.prior.find(row => rowId(row) === id)
            if (original) prior.set(id, original as Record<string, unknown>)
            else prior.delete(id)
          }
          const image = new Map(serialized.map(row => [rowId(row), row]))
          const affected = new Set([...new Set([...prior.keys(), ...image.keys()])].filter(id =>
            (prior.has(id) ? snapshotFingerprint(prior.get(id)!) : undefined)
              !== (image.has(id) ? snapshotFingerprint(image.get(id)! as unknown as Record<string, unknown>) : undefined)))
          return {
            image: JSON.parse(JSON.stringify(serialized)), prior: JSON.parse(JSON.stringify([...prior.values()])),
            agentId: bindingCommit?.agentId ?? unconfirmed!.agentId, intent: intent ?? null,
            before: beforeCommit, affected,
            source: unconfirmed && (!bindingCommit || bindingCommit.agentId === unconfirmed.agentId) ? unconfirmed.source : source,
          }
        })()
        const verifyOwners = strict ? this.preparedOwnerGuard(beforeOwners, currentRows, changed, mutationAgentId) : undefined
        let rebased: RegisteredSession[]
        const rebase = () => {
          deadline.check()
          checkOwner()
          verifyOwners?.()
          bindingCommit?.verify()
          // Ordinary observations can advance during durability; never install the pre-rename rebase.
          const liveRows = new Map(Array.from(this.agents.values()).map(row => [row.agentId, persistedRow(row) as unknown as Record<string, unknown>]))
          const committed = new Map(serialized.map(row => [row.agentId, row as unknown as Record<string, unknown>]))
          const remainingIntents = new Map([...this.intended].filter(([id, intent]) => capturedIntents.get(id) !== intent))
          return [...mergedForSave(committed, liveRows, beforeCommit, remainingIntents).values()].map(value => {
            const row = preparedRows.get(value) ?? strictPersistedRow(value)
            if (!row) throw new IdentityReadUnavailable('a live registry observation changed to an invalid row')
            return row
          })
        }
        try {
          await bindingCommit?.refresh?.()
          rebased = rebase()
          prepared.publish(() => { this.unconfirmedBinding = recovery })
          const syncing = prepared.sync()
          if (syncing) {
            await syncing
            deadline.check()
          }
          await prepared.settle()
          await bindingCommit?.refresh?.()
          rebased = rebase()
          prepared.finish()
        }
        catch (error) {
          let failure = prepared.published && !(error instanceof AtomicWriteUnconfirmed)
            ? new AtomicWriteUnconfirmed(error, false) : error
          if (prepared.published && failure instanceof AtomicWriteUnconfirmed && failure.retryable) {
            // An I/O error does not excuse losing this lock or the operation's original authority.
            try { rebase() } catch (error) { failure = new AtomicWriteUnconfirmed(error, false) }
          }
          await prepared.discard()
          throw failure
        }
        this.unconfirmedBinding = null
        this.persistedContents = prepared.proof
        for (const [id, intent] of capturedIntents) if (this.intended.get(id) === intent) this.intended.delete(id)

        // External refresh keeps controller references. Registration replaces its target only now:
        // deferred readers must keep the former home/binding, never inherit the newly admitted one.
        const previous = new Map(this.agents)
        this.agents.clear()
        this.sessionIndex.clear()
        this.runtimeIndex.clear()
        this.processIndex.clear()
        for (const row of rebased) {
          const prior = previous.get(row.agentId)
          const entry = prior && bindingCommit?.replaceLive && bindingCommit.agentId === row.agentId ? { ...prior } : prior ?? row
          if (entry !== row) {
            const sameBinding = entry.engine === row.engine && entry.sessionId === row.sessionId
              && entry.transcriptPath === row.transcriptPath && entry.codexHome === row.codexHome
            const admissionHold = entry.admissionHold
            const identityHold = sameBinding ? entry.identityHold : undefined
            const interpretationHold = sameBinding ? entry.interpretationHold : undefined
            const evidenceRevision = sameBinding ? entry.evidenceRevision : ++this.evidenceRevision
            // External deletions count too: retaining a cancelled closePlan here would make the
            // next observation write it back and turn a cancelled close into pending work again.
            for (const key of Object.keys(entry)) {
              if (!Object.hasOwn(row, key)) delete (entry as unknown as Record<string, unknown>)[key]
            }
            Object.assign(entry, row)
            if (admissionHold) entry.admissionHold = admissionHold
            if (identityHold) entry.identityHold = identityHold
            if (interpretationHold) entry.interpretationHold = interpretationHold
            if (evidenceRevision !== undefined) entry.evidenceRevision = evidenceRevision
          }
          this.index(entry, false)
          entered.push(entry.engine)
        }
        committedOwner = bindingCommit ? ownershipIdentity(this.agents.get(bindingCommit.agentId)) : undefined
        this.persistedBaseline = new Map(serialized.map(row => [rowId(row), snapshotFingerprint(row as unknown as Record<string, unknown>)]))
        deadline.markAdmitted()
        if (rebased.length !== serialized.length || rebased.some(row => this.persistedBaseline.get(row.agentId) !== (preparedImages.has(row)
          ? snapshotFingerprint(preparedImages.get(row)!) : rowFingerprint(persistedRow(row))))) void this.save()
        } finally {
          normalizedSourceRows.clear()
          if (this.unconfirmedBinding?.source !== source) await source.release()
          if (priorSource && priorSource !== source && this.unconfirmedBinding?.source !== priorSource) await priorSource.release()
        }
      }))
    } catch (err) {
      if (strict) throw persistenceFailure(err)
      console.error('[registry] save failed')
    }
    // Optional engine startup observes the complete durable publication, outside its no-yield section.
    for (const engine of entered) this.entered(engine)
    return committedOwner
  }

  /**
   * A names write that failed, tried again on every save until it lands. The rows heal on their own,
   * because the next save sees them differ from what is on disk; names are written only on a rename,
   * so a rename the daemon answered while the disk was full was lost to a restart that came before the
   * next rename (found end to end, e2e/diskfull.e2e.ts).
   */
  private namesUnsaved = false
  private namesRevision = 0
  private pendingNames: Promise<void> | undefined
  private readonly deletedNames = new Set<string>()

  private saveNames(): void {
    this.namesUnsaved = true
    this.namesRevision++
    if (this.pendingNames) return
    let started = false
    const pending = this.writer.run(async deadline => {
      started = true
      this.pendingNames = undefined
      await this.persistNames(deadline)
    }).catch(() => { this.namesUnsaved = true; console.error('[registry] save names failed') })
    if (!started) this.pendingNames = pending
    void pending.finally(() => { if (this.pendingNames === pending) this.pendingNames = undefined })
  }

  private async persistNames(deadline: RegistryWriteDeadline, intent?: { key: string; value: string; verify: () => void }): Promise<void> {
    try {
      await sessionStorage.withWrite(deadline.expires, async () => {
      const revision = this.namesRevision
      const names = Object.fromEntries(NAME_OVERRIDES)
      if (intent) names[intent.key] = intent.value
      const deleted = new Set(this.deletedNames)
      await privateRegistryDirectory(env.ADAPTER_DATA_DIR)
      deadline.check()
      let existing: Record<string, string> = {}
      const source = await sessionStorage.retain({ kind: 'names' })
      try {
      if (source.image.state === 'image') {
        if (!source.image.json) throw new RegistryPersistenceUnavailable('names are not JSON')
        const obj = source.image.value as Record<string, unknown>
        existing = Object.fromEntries(Object.entries(obj).filter(([, value]) => typeof value === 'string')) as Record<string, string>
      }
      deadline.check()
      // Equal bytes can still be an unconfirmed rename. Only a clean observation may omit publication.
      if (!intent && !this.namesUnsaved && deleted.size === 0 && revision === this.namesRevision
        && source.image.state === 'image' && source.image.json && rowFingerprint(source.image.value) === rowFingerprint(names)) return
      for (const id of deleted) delete existing[id]
      const prepared = await prepareSessionPublication(sessionStorage, { kind: 'names' }, source, { ...existing, ...names }, deadline)
      try {
        intent?.verify()
        prepared.publish(() => {})
        const syncing = prepared.sync()
        if (syncing) {
          await syncing
          deadline.check()
        }
        await prepared.settle()
        intent?.verify()
        prepared.finish()
      } catch (error) {
        let failure = prepared.published && !(error instanceof AtomicWriteUnconfirmed)
          ? new AtomicWriteUnconfirmed(error, false) : error
        if (prepared.published && failure instanceof AtomicWriteUnconfirmed && failure.retryable) {
          try { intent?.verify() } catch (error) { failure = new AtomicWriteUnconfirmed(error, false) }
        }
        await prepared.discard()
        throw failure
      }
      // A deletion admitted while this image waited is later intent. Installing the
      // older rename must not resurrect its name before that queued deletion runs.
      if (intent && (revision === this.namesRevision || !this.deletedNames.has(intent.key))) {
        NAME_OVERRIDES.set(intent.key, intent.value)
        if (revision === this.namesRevision) this.deletedNames.delete(intent.key)
      }
      if (revision === this.namesRevision) {
        this.namesUnsaved = false
        for (const id of deleted) this.deletedNames.delete(id)
      }
      deadline.markAdmitted()
      } finally { await source.release() }
      })
    } catch (error) { this.namesUnsaved = true; throw persistenceFailure(error, true) }
  }

}

export const registry = new Registry()

function defaultProjectDisplayName(s: RegisteredSession): string {
  const folder = s.cwd ? s.cwd.split('/').filter(Boolean).pop() || s.cwd : s.projectDir
  // Every OpenClaw key starts `agent:<agentId>:`: it is told apart by its own part (`main`, `tui-22b7208d`).
  const key = s.engine === 'openclaw' ? OPENCLAW_KEY.exec(s.sessionId)?.[2] : undefined
  return `${folder} · ${key ? key.slice(0, 12) : (s.sessionId || s.agentId).slice(0, 4)}`
}

/**
 * A pane title, as an agent NAME — or null when the title says nothing about this agent.
 *
 * Two rejections, and the second is the interesting one.
 *
 * The machine's own name is refused. Hermes sets its terminal title to the hostname and leaves it
 * there, following the shell convention rather than the conversation one, so every hermes agent on
 * this Mac was called `MacBookPro2021.local` — in the sidebar, in the pane header, forever, and
 * identically for every one of them. A name that is the same for every agent on a machine is worse
 * than no name: `defaultProjectDisplayName` at least says which folder and which session. This is
 * about the machine, not the engine, so it is refused by what it SAYS rather than by who sent it —
 * any engine that adopts the same convention is covered without a table to keep in step. tmux titles
 * a new pane with the machine's name too, kept by any engine that sets no title of its own. Every
 * name the machine has had while the daemon ran counts (lib/machineNames.ts): a laptop's name follows
 * its network, and a pane keeps the name it was made under.
 */
export function titleDisplayName(title: string | null | undefined): string | null {
  // (A graphics query tmux took as a pane title, one a registry stored before tmux.ts stopped reading it included.)
  if (title && isKittyGraphicsCommand(title)) return null
  const cleaned = title
    ?.trim()
    .replace(/^[\s\p{Mark}\p{Punctuation}\p{Symbol}]+/u, '')
    .trim()
    .slice(0, 80)
  if (!cleaned) return null
  return machineNames.owns(cleaned) ? null : cleaned
}

function validProcessIdentity(value: unknown): value is ProcessIdentity {
  const p = value as Partial<ProcessIdentity> | null | undefined
  return !!p && Number.isSafeInteger(p.pid) && (p.pid ?? 0) > 0 && typeof p.executable === 'string' && typeof p.startMarker === 'string'
}

/** A persisted grid launch. Anything short of a complete, well-formed override is treated as
 *  "no credential" — a half-remembered key is worse than none, because a launch built from it would
 *  look like a grid launch and fail like one. `undefined` (the field was never written) is kept
 *  distinct from `null` (vendor login) so restore can tell a pre-upgrade grid row apart. */
function normalizedGridLaunch(value: unknown): StoredGridLaunch | null | undefined {
  if (value === undefined) return undefined
  return storedGridLaunch(value) ? value : null
}

/** What a persisted launch said about web search. Anything but the three known words is "nothing to
 *  say" — a row from a daemon that knew a fourth would otherwise have the app print it verbatim. */
function normalizedGridWebSearch(value: unknown): GridWebSearchStatus | null {
  return value === 'on' || value === 'unavailable' || value === 'unsupported' ? value : null
}

/** A persisted grid assignment. Lenient on `model` on purpose: a row that only knows WHERE it pointed
 *  must still read as a grid agent, or a restore would relaunch it on the engine's own login. */
function normalizedGridAssignment(value: unknown): GridAssignment | null {
  const g = value as Partial<GridAssignment> | null | undefined
  if (!g || typeof g.baseUrl !== 'string' || !g.baseUrl) return null
  return { baseUrl: g.baseUrl, model: typeof g.model === 'string' ? g.model : null }
}
