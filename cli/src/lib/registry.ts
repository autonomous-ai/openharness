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
import { transcriptProject } from '../engines/discoveries.js'
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
import { join, basename, dirname, relative, isAbsolute } from 'path'
import { machineNames } from './machineNames.js'
import { cursorDataDir } from '../engines/cursor/contract.js'
import { env } from '../config/env.js'
import { sessionFolderOf, sessionRoots } from './engineHomes.js'
import { findSessionFileOf, sessionMetaOf } from '../engines/sessionFiles.js'
import { isSessionStoreEngine, sessionStoreContracts, sessionStoreOf } from '../engines/sessionStoreContracts.js'
import { admitHook } from '../engines/hooks.js'
import { ENGINES, isTerminalEngine, type AgentEngine } from '../engines/types.js'
import type { GridAssignment } from './gridAssignment.js'
import { parseGridLaunchOverride, type GridLaunchOverride, type GridLaunchRecord, type GridWebSearchStatus } from './gridLaunchWire.js'
import { parseScmLaunchRecord, type ScmLaunchRecord } from '../scm/types.js'
import { commandcodeTranscriptPath } from '../engines/commandcode/contract.js'
import { agyTranscriptPath } from '../engines/agy/contract.js'
import { copilotTranscriptPath } from '../engines/copilot/contract.js'
import { bootChanged, currentBootId } from './bootId.js'
import { lockOwnerAlive, lockStartMarker, processLockIdentity } from './processLiveness.js'
import { hardenPrivateStateFileIfPresent, readPrivateStateFile, secureStateDirectory } from './secureState.js'
import { mergeTerminalRuntimes, processIdentityKey, sameProcessIdentity, terminalPlacementKey, terminalRouteKey } from './terminalRuntime.js'
import type { HookTerminalHint, ProcessIdentity, TerminalRuntimeRef } from './terminalTypes.js'
import { externalReservations, externalResumePending, externalResumeIds, parseExternalResume, type ExternalResumeIntent } from './externalResume.js'

export type { ProcessIdentity } from './terminalTypes.js'

export type AgentLaunch =
  | { state: 'starting' }
  | { state: 'ready' }
  | { state: 'failed'; error: string; detail?: string }
  /**
   * Not launched yet because the service its launch asks could not be asked (core/agents/heldLaunches.ts): a
   * grid or saved-API agent while models is not running. Nothing about the agent is wrong. It waits in a pane
   * that says why, and is launched once the service is ready. Never a failure: a restore tries it again.
   */
  | { state: 'held'; service: string; detail: string }

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
   * keeps saying so. It only records HOW the pane's requests are billed, which decides two things — the
   * runtime profile becomes display-only, and the daemon's recap/route calls go direct to OpenRouter
   * instead of spawning a vendor CLI that has no credential. Re-derived from the live process on every
   * discovery, so a pane restarted without the wrapper drops it on the next scan.
   */
  gateway?: 'ori' | null
  /**
   * The grid this pane's engine is pointed at, if any — read off the live process on every discovery
   * exactly like `gateway`, never declared. See `gridAssignment.ts`. Carries no credential; the
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
  gridLaunch?: GridLaunchOverride | null
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
   * Written by `agent_create` from what `prepareProjectFolder` made, carried forward like
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
   * The CODEX_HOME folder this agent was launched against, if one was chosen instead of `~/.codex`.
   * Codex only. Unlike `grid`, this is chosen once at creation and never re-derived from the live
   * process — a running agent cannot be moved to a different profile the way it can be retargeted
   * to a different grid.
   */
  codexHome?: string | null
  /**
   * The Hermes home this session's history lives in — `~/.hermes/profiles/<name>` for an agent started
   * with `hermes -p <name>`, null for this machine's default home.
   *
   * Unlike `codexHome` this is not a launch choice the daemon makes: `hermes -p` is how a person starts
   * one, and the daemon meets the pane afterwards. So it is FOUND rather than recorded — by the session
   * id, in whichever store holds its row (`engines/hermes/home.ts`) — and then kept here so the lookup
   * happens once per agent instead of once per poll. Fill-only, like `codexHome`.
   *
   * Everything Hermes-shaped reads it: the live mirror, `agent_recent`, the recap fallback, the hook's
   * source check and the model/effort poll. Reading one fixed home instead is what left a profile
   * fleet's activity cards empty forever while their terminals streamed perfectly (openharness#191).
   */
  hermesHome?: string | null
  /**
   * The domain-specific harness this agent was created as (`autonomous/copper`), or null for a plain
   * engine. NOT a second engine: `engine` stays the base (`claude`, `codex`, …) and every normalizer,
   * probe and install path keys on that. Chosen at creation, carried forward, and re-read off the
   * live process's `HARNESS_DSH` by discovery so a pane the daemon did not create (or had to mint
   * again after a restart) is still labelled. Fill-only, like `codexHome`. See `src/dsh/`.
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
   * shell" (`releaseEngine`) rather than "dormant", and what tells `restoreAgents` to bring back
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


/** The engine's own name for this session, or null while it has none worth showing. */
export function sessionDisplayTitle(s: RegisteredSession): string | null {
  return namingTitle(titleDisplayName(s.title), { engine: s.engine, cwd: s.cwd, defaultName: s.defaultName })
}

const FILE = join(env.ADAPTER_DATA_DIR, 'registry.json')
const NAMES_FILE = join(env.ADAPTER_DATA_DIR, 'agent-names.json')
const BOOT_FILE = join(env.ADAPTER_DATA_DIR, 'registry-boot')
const LOCK_DIR = join(env.ADAPTER_DATA_DIR, 'registry.json.lock')
const PRE_V2_BACKUP_FILE = join(env.ADAPTER_DATA_DIR, 'registry.pre-v2.json')
const NAME_OVERRIDES = new Map<string, string>()

const PANE_RE = /^%\d+$/
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
const LOCK_WAIT_MS = 20
const LOCK_ATTEMPTS = 100

function sleepSync(ms: number): void {
  const view = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(view, 0, 0, ms)
}

function removeRegistryLockOwnedBy(token: string): void {
  try {
    const saved = JSON.parse(readFileSync(join(LOCK_DIR, 'owner.json'), 'utf8')) as { token?: unknown }
    if (saved.token === token) rmSync(LOCK_DIR, { recursive: true, force: true })
  } catch { /* another owner or an unsafe artifact must not be removed */ }
}

function withRegistryFileLock<T>(apply: () => T): T {
  secureStateDirectory(env.ADAPTER_DATA_DIR)
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  const processIdentity = processLockIdentity(process.pid)
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    const token = randomUUID()
    let created = false
    try {
      mkdirSync(LOCK_DIR, { mode: 0o700 })
      created = true
      const owner = join(LOCK_DIR, 'owner.json')
      const fd = openSync(owner, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, ...processIdentity, token }))
        fsyncSync(fd)
      } finally { closeSync(fd) }
      try {
        return apply()
      } finally {
        removeRegistryLockOwnedBy(token)
      }
    } catch (error) {
      if (created) removeRegistryLockOwnedBy(token)
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let ownerPid = 0
      let ownerStartMarker = ''
      let ownerToken = ''
      try {
        const stat = lstatSync(LOCK_DIR)
        if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== null && stat.uid !== uid)
          || (stat.mode & 0o777) !== 0o700) throw new Error('registry lock has unsafe owner, mode, or type')
        const ownerStat = lstatSync(join(LOCK_DIR, 'owner.json'))
        if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || (uid !== null && ownerStat.uid !== uid)
          || (ownerStat.mode & 0o777) !== 0o600) throw new Error('registry lock owner has unsafe owner, mode, or type')
        const owner = JSON.parse(readFileSync(join(LOCK_DIR, 'owner.json'), 'utf8')) as {
          pid?: unknown; startMarker?: unknown; generationMarker?: unknown; token?: unknown
        }
        ownerPid = Number(owner.pid)
        ownerStartMarker = lockStartMarker(owner)
        ownerToken = typeof owner.token === 'string' ? owner.token : ''
      } catch (inspectionError) {
        if (inspectionError instanceof Error && inspectionError.message.startsWith('registry lock')) throw inspectionError
      }
      if (ownerPid > 0 && ownerToken && !lockOwnerAlive(ownerPid, ownerStartMarker)) {
        try {
          const current = JSON.parse(readFileSync(join(LOCK_DIR, 'owner.json'), 'utf8')) as {
            pid?: unknown; startMarker?: unknown; generationMarker?: unknown; token?: unknown
          }
          if (Number(current.pid) === ownerPid
            && lockStartMarker(current) === ownerStartMarker
            && current.token === ownerToken
            && !lockOwnerAlive(ownerPid, ownerStartMarker)) {
            rmSync(LOCK_DIR, { recursive: true, force: true })
            continue
          }
        } catch { /* lock changed or disappeared; retry without deleting another owner's lock */ }
      }
      sleepSync(LOCK_WAIT_MS)
    }
  }
  throw new Error('registry lock is busy')
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
  return JSON.stringify(row, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value)
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
    const directoryFd = openSync(dirname(file), 'r')
    try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
  } finally {
    if (!renamed) rmSync(temporary, { force: true })
  }
}

function boundedIdentityPart(value: unknown, max = 200): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
}

export function validTerminalRuntime(value: unknown): value is TerminalRuntimeRef {
  if (!value || typeof value !== 'object') return false
  const runtime = value as Partial<TerminalRuntimeRef>
  return runtime.backend === 'tmux' && typeof runtime.paneId === 'string' && PANE_RE.test(runtime.paneId)
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

function normalizedRuntimes(raw: unknown, legacyTmuxPane?: unknown): TerminalRuntimeRef[] {
  const fromArray = Array.isArray(raw) ? raw.filter(validTerminalRuntime) : []
  const legacy = typeof legacyTmuxPane === 'string' && PANE_RE.test(legacyTmuxPane)
    ? [{ backend: 'tmux' as const, paneId: legacyTmuxPane }]
    : []
  return mergeTerminalRuntimes([], [...fromArray, ...legacy])
}

function tmuxProjection(runtimes: readonly TerminalRuntimeRef[]): string {
  return runtimes.find((runtime) => runtime.backend === 'tmux')?.paneId ?? ''
}

function persistedRow(entry: RegisteredSession): RegisteredSession | Omit<RegisteredSession, 'tmuxPane'> {
  if (entry.tmuxPane) return { ...entry, runtimes: entry.runtimes.map((runtime) => ({ ...runtime })) }
  const { tmuxPane: _legacy, ...row } = entry
  return { ...row, runtimes: row.runtimes.map((runtime) => ({ ...runtime })) }
}

export function strictPersistedRow(raw: unknown): RegisteredSession | null {
  const value = withoutRetiredRuntimes(raw)
  if (!value || typeof value !== 'object') return null
  const row = value as Partial<RegisteredSession>
  const runtimes = normalizedRuntimes(row.runtimes, row.tmuxPane)
  const primary = typeof row.primaryRuntimeKey === 'string' ? row.primaryRuntimeKey : ''
  const normalizedPrimary = selectedRuntimeKey(runtimes, primary)
  const active = row.active === true
  const projectedTmuxPane = tmuxProjection(runtimes)
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
  const { lastOpenedAt: rawOpenedAt, closePlan: rawClosePlan, forkedFrom: rawForkedFrom, scmLaunch: rawScmLaunch, externalResume: _externalResume, ...rest } = row
  const lastOpenedAt = normalizedOpenedAt(rawOpenedAt)
  // Out of the spread for the same reason: a half-formed record is dropped, never relaunched with.
  const scmLaunch = parseScmLaunchRecord(rawScmLaunch)
  return {
    ...rest,
    ...(externalResume ? { externalResume } : {}),
    ...(scmLaunch ? { scmLaunch } : {}),
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
  if (launch.state === 'starting' || launch.state === 'ready') return { state: launch.state }
  if (launch.state === 'held') {
    const held = value as { service?: unknown; detail?: unknown }
    if (typeof held.service !== 'string' || !/^[a-z][a-z-]{0,39}$/.test(held.service) || typeof held.detail !== 'string') return undefined
    return { state: 'held', service: held.service, detail: held.detail.slice(0, 500) }
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

function validatedRows(values: readonly unknown[]): RegisteredSession[] | null {
  const rows: RegisteredSession[] = []
  const agents = new Set<string>()
  const sessions = new Set<string>()
  const provisionalSessions = new Set<string>()
  const processes = new Set<string>()
  const routes = new Set<string>()
  for (const value of values) {
    const row = strictPersistedRow(value)
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

  constructor(rows: ReadonlyMap<string, Record<string, unknown>>) {
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
    const row = strictPersistedRow(value)
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
): Map<string, Record<string, unknown>> {
  const merged = new Map(latest)
  for (const baselineId of baselines.keys()) {
    if (!currentRows.has(baselineId)) merged.delete(baselineId)
  }
  // Built on the first changed row, as the scan it replaces first read the rows then: a save with no
  // changed row reads none of them.
  let identities: MergeIdentities | null = null
  for (const [agentId, current] of currentRows) {
    const baseline = baselines.get(agentId)
    const intended = intents.get(agentId)
    // An intent on a row this view otherwise left alone never brings back a row another process
    // removed: that agent is gone, and its close plan with it.
    if (baseline === rowFingerprint(current) && (!intended || !latest.has(agentId))) continue
    let candidate = latest.has(agentId)
      ? threeWayRow(baseline, current, latest.get(agentId)!)
      : current
    if (intended) candidate = withIntended(candidate, current, intended)
    const process = strictPersistedRow(candidate)?.processIdentity
    const engine = candidate.engine
    const sessionId = typeof candidate.sessionId === 'string' ? candidate.sessionId : ''
    const routes = new Set(normalizedRuntimes(candidate.runtimes, candidate.tmuxPane).map(terminalRouteKey))
    identities ??= new MergeIdentities(merged)
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
 * Where each engine's conversation file lives, or **null for an engine that keeps no file at all**.
 *
 * The null entries are not gaps: opencode, kilo, hermes and devin keep their conversations in a
 * SQLite database (`sessionRepair.ts`'s `dbEngineSession` reads an id out and has no path to
 * return), and a terminal has no conversation. Written as a table rather than the nested ternary it
 * replaces so "this engine has no transcript" is a fact a caller can ASK for — Pause and Resume both
 * need it, and both used to demand a file every engine was assumed to have.
 */
const TRANSCRIPT_ROOT: Readonly<Record<AgentEngine, (() => string) | 'store' | null>> = {
  // Amp's root is OURS, not Amp's: the transcript is written by the adapter's own plugin because Amp
  // keeps no conversation on disk (see installAmpPlugin).
  amp: () => env.AMP_SESSIONS_DIR,
  muse: () => join(env.MUSE_HOME, 'sessions'),
  // Declared by the engine's session store (engines/sessionStoreContracts.ts): the folders `transcriptRoots` names.
  codex: 'store',
  grok: () => join(env.GROK_HOME, 'sessions'),
  agy: () => join(env.AGY_HOME, 'brain'),
  copilot: () => join(env.COPILOT_HOME, 'session-state'),
  cursor: () => join(cursorDataDir(), 'projects'),
  pi: () => join(env.PI_HOME, 'agent', 'sessions'),
  commandcode: () => join(env.COMMANDCODE_HOME, 'projects'),
  claude: 'store',
  opencode: null,
  kilo: null,
  hermes: null,
  devin: null,
  terminal: null,
}

/** Whether this engine's conversation is a FILE the daemon can point a resume at. False for the
 *  database-backed engines and the shell — for them a recorded session id is the whole record, and
 *  demanding a transcript would refuse a resume that works. */
export function engineKeepsTranscriptFile(engine: AgentEngine): boolean {
  return TRANSCRIPT_ROOT[engine] !== null
}

/**
 * The folders an engine's transcripts may be in: its own, and for an engine with a declared session store each
 * home the person moved in their shell profile (lib/engineHomes.ts). An agent's own profile (its CODEX_HOME) is
 * its only one, for an engine whose sessions follow one.
 */
function transcriptRoots(engine: AgentEngine, root: (() => string) | 'store', codexHome?: string): string[] {
  return root === 'store' ? sessionRoots(engine, codexHome) : [root()]
}

export function validTranscriptPath(engine: AgentEngine, filePath: string, codexHome?: string, allowMissing = false): boolean {
  const rootFor = TRANSCRIPT_ROOT[engine]
  if (!rootFor) return false
  try {
    const missing = allowMissing && !existsSync(filePath)
    const actual = missing ? join(realpathSync(dirname(filePath)), basename(filePath)) : realpathSync(filePath)
    const within = (root: string): boolean => { try { return isWithin(realpathSync(root), actual) } catch { return false } }
    const st = statSync(missing ? dirname(actual) : actual)
    if (!(missing ? st.isDirectory() : st.isFile()) || !transcriptRoots(engine, rootFor, codexHome).some(within)) return false
    if (engine === 'cursor') {
      const id = basename(actual).replace(/\.jsonl$/, '')
      if (!id || basename(dirname(actual)) !== id || basename(dirname(dirname(actual))) !== 'agent-transcripts') return false
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    return uid === null || st.uid === uid
  } catch {
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
  private transactionDepth = 0
  private savePending = false
  /** Root corruption/unknown schemas are read-only until the operator restores valid bytes. */
  private writeBlocked = false
  /** Last committed row bytes, used for a three-way merge with daemon-down hook writes. */
  private persistedBaseline = new Map<string, string>()
  /** Exact bytes of our last durable save; checked against the file, never just its mtime. */
  private persistedContents: string | null = null
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
    return this.rebooted
  }

  /**
   * Told the engine of every session as it enters: loaded, registered, opened or adopted. The core starts
   * loading what that engine's sessions read in its own process then (engines/inProcess.ts `preloadEngine`),
   * so that nothing the session does later waits for an import. Unset outside the core.
   */
  onEnter: ((engine: AgentEngine) => void) | null = null

  private index(entry: RegisteredSession): void {
    this.agents.set(entry.agentId, entry)
    if (entry.sessionId) this.sessionIndex.set(entry.sessionId, entry.agentId)
    for (const runtime of entry.runtimes) this.runtimeIndex.set(terminalRouteKey(runtime), entry.agentId)
    if (entry.processIdentity) this.processIndex.set(processIdentityKey(entry.engine, entry.processIdentity), entry.agentId)
    this.onEnter?.(entry.engine)
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

  private releaseBinding(entry: RegisteredSession): void {
    if (entry.sessionId && this.sessionIndex.get(entry.sessionId) === entry.agentId) {
      this.sessionIndex.delete(entry.sessionId)
    }
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
  load(): void {
    this.agents.clear()
    this.sessionIndex.clear()
    this.runtimeIndex.clear()
    this.processIndex.clear()
    this.terminalAvailableAgents.clear()
    this.writeBlocked = false
    this.rebooted = false
    this.persistedBaseline.clear()
    this.persistedContents = null
    this.intended.clear()
    try {
      secureStateDirectory(env.ADAPTER_DATA_DIR)
    } catch (error) {
      this.writeBlocked = true
      console.error('[registry] unsafe state directory; refusing to load or write state:', error)
      return
    }
    this.loadNames()
    const savedBoot = readSavedBoot()
    const bootId = currentBootId()
    const rebooted = bootChanged(savedBoot, bootId)
    writeBoot(bootId) // refresh the reference so a reboot is detected exactly once, even across same-boot restarts
    try {
      const stored = JSON.parse(readPrivateStateFile(FILE)) as unknown
      if (!Array.isArray(stored)) {
        this.quarantine('root is not an array')
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
        this.quarantine('contains a malformed legacy row')
        return
      }
      const v2Rows = parsed.filter((row) => !!row && typeof row === 'object'
        && (row as { schemaVersion?: unknown }).schemaVersion === 2)
      if (v2Rows.length && !validatedRows(v2Rows)) {
        this.quarantine('contains a malformed v2 row')
        return
      }
      const arr = parsed as Array<Partial<RegisteredSession>>
      for (const row of arr) {
        const id = rowId(row)
        if (id) this.persistedBaseline.set(id, rowFingerprint(row))
      }
      // The rollback copy is the file as found, retired runtimes and all — not the cleaned rows.
      if (arr.some((row) => row.schemaVersion !== 2)) {
        atomicWriteJson(PRE_V2_BACKUP_FILE, stored, true)
      }
      let changed = strippedRetired
      if (rebooted) {
        this.rebooted = true
        console.log(`[registry] machine rebooted since last run — ${arr.length} agent(s) kept with their process identity cleared (stale panes, restored on start)`)
        // The boot marker was already refreshed above, so a crash before the save below would leave
        // pre-reboot pids on disk with no second chance to notice — force the cleared snapshot out.
        changed = true
      }
      for (const raw of Array.isArray(arr) ? arr : []) {
        const engine = normalizedAgentEngine(raw?.engine)
        const runtimes = normalizedRuntimes(raw?.runtimes, raw?.tmuxPane)
        const pane = tmuxProjection(runtimes)
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
        let repairedParentTranscript = false
        if (isSessionStoreEngine(engine) && sessionStoreContracts[engine].repairsOverwrittenParent && transcriptPath) {
          const meta = sessionMetaOf(engine, transcriptPath)
          if (meta?.isSubagent) {
            const repaired = meta.parentThreadId === rawSessionId
              ? findSessionFileOf(engine, rawSessionId, sessionFolderOf(engine, { profile: rawCodexHome, transcriptPath }))
              : null
            if (!repaired || !validTranscriptPath(engine, repaired, rawCodexHome) || sessionMetaOf(engine, repaired)?.isSubagent) {
              changed = true
              bound = false
              transcriptPath = null
            } else {
              console.log(`[registry] repaired ${sessionStoreContracts[engine].label} parent ${rawSessionId.slice(0, 8)} transcript after child hook overwrite`)
              transcriptPath = repaired
              repairedParentTranscript = true
              changed = true
            }
          }
        }
        // A process agent remains valid without a session. A missing/invalid transcript releases only the
        // binding so the discovery/store repair path can bind it again if appropriate.
        if (!bound) transcriptPath = null
        if (!runtimes.length) {
          changed = true
          continue
        }
        if (
          (bound && engine !== 'cursor' && engine !== 'opencode' && engine !== 'kilo' && engine !== 'pi' && engine !== 'hermes' && engine !== 'commandcode' && engine !== 'devin' && !transcriptPath)
          || (bound && transcriptPath !== null && !validTranscriptPath(engine, transcriptPath, rawCodexHome))
        ) {
          bound = false
          transcriptPath = null
          changed = true
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
          hermesHome: typeof raw?.hermesHome === 'string' && raw.hermesHome ? raw.hermesHome : null,
          ...normalizedForkedFrom((raw as { forkedFrom?: unknown }).forkedFrom),
          dsh: normalizedDshId((raw as { dsh?: unknown }).dsh),
          dshRuntime: typeof raw.dshRuntime === 'string' && raw.dshRuntime ? raw.dshRuntime : null,
          agent: normalizedAgentName((raw as { agent?: unknown }).agent),
          ...(rawGridLaunch !== undefined ? { gridLaunch: rawGridLaunch } : {}),
          ...(rawGridLaunch ? { gridWebSearch: normalizedGridWebSearch(raw?.gridWebSearch) } : {}),
          ...(rawScmLaunch ? { scmLaunch: rawScmLaunch } : {}),
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
        if (this.agents.has(s.agentId)) {
          this.quarantine('contains duplicate agent identities')
          return
        }
        this.index(s)
      }
      if (!validatedRows(this.list().map(persistedRow))) {
        this.quarantine('violates global identity invariants')
        return
      }
      if (changed) this.save()
    } catch (error) {
      if (error instanceof SyntaxError) this.quarantine(`is not JSON (${error.message})`)
      else if (existsSync(FILE)) {
        this.writeBlocked = true
        console.error('[registry] registry is unreadable; refusing to overwrite it:', error instanceof Error ? error.message : error)
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
  private quarantine(reason: string): void {
    this.agents.clear()
    this.sessionIndex.clear()
    this.runtimeIndex.clear()
    this.processIndex.clear()
    this.persistedBaseline.clear()
    this.persistedContents = null
    this.intended.clear()
    const aside = `${FILE}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
    try {
      renameSync(FILE, aside)
      this.writeBlocked = false
      console.error(`[registry] registry ${reason}; moved it aside to ${aside} and started empty`)
    } catch (error) {
      this.writeBlocked = true
      console.error(`[registry] registry ${reason}, and it could not be moved aside (${error instanceof Error ? error.message : error}); refusing to overwrite it`)
    }
  }

  private loadNames(): void {
    try {
      const obj = JSON.parse(readPrivateStateFile(NAMES_FILE, 1024 * 1024)) as Record<string, unknown>
      for (const [id, name] of Object.entries(obj)) {
        if (typeof name === 'string' && name.trim()) NAME_OVERRIDES.set(id, name.trim())
      }
    } catch {
      // no file yet / unreadable — start without display-name overrides
    }
  }

  /** Create/adopt a process agent before any engine session exists. */
  openProcessAgent(input: {
    agentId?: string
    engine: AgentEngine
    tmuxPane?: string
    runtimes?: TerminalRuntimeRef[]
    primaryRuntimeKey?: string
    cwd?: string | null
    processIdentity: ProcessIdentity
    gateway?: 'ori' | null
    grid?: GridAssignment | null
    /** Codex only: the CODEX_HOME the process was launched under, read off its environment. Fills a
     *  row that does not know its profile yet; never overwrites one that does (see `codexHome`). */
    codexHome?: string | null
    /** The Hermes home this session's store lives in, if it is not the default. Fill-only. */
    hermesHome?: string | null
    /** The DSH read off the process's `HARNESS_DSH`, if any. Fill-only, like `codexHome`. */
    dsh?: string | null
  }):
    {
      entry: RegisteredSession
      isNew: boolean
      /**
       * The agent this one took a terminal from, once it has no terminal left.
       *
       * BOTH IDS, because by the time the caller reads this the agent is ALREADY
       * GONE from the registry — `drop()` removes it and the loop below only
       * re-indexes it if it still owns a runtime — so nothing can look either id
       * up afterwards. Clients key on the agentId and the daemon's per-session
       * state keys on the sessionId, and the caller needs both to finish the
       * removal it was never told to do.
       */
      evicted: { agentId: string; sessionId: string } | null
    } | null {

    if (this.writeBlocked) return null
    const { engine, processIdentity } = input
    const runtimes = normalizedRuntimes(input.runtimes, input.tmuxPane)
    if (!runtimes.length || !validProcessIdentity(processIdentity)) return null
    if (runtimes.some(runtime => externalResumePending(this.agents.get(this.runtimeIndex.get(terminalRouteKey(runtime)) ?? '')?.externalResume))) return null
    const processAgentId = this.processIndex.get(processIdentityKey(engine, processIdentity))
    const processAgent = processAgentId ? this.agents.get(processAgentId) : undefined
    const routeAgent = runtimes
      .map((runtime) => this.byRuntimeEngine(runtime, engine))
      .find((agent) => agent && (
        // Before its first engine session, a process-agent is owned by its terminal route. Native
        // launchers can replace PID/image while showing setup or folder-trust UI; update that agent in
        // place instead of deleting/recreating its tile. Once bound, process identity remains strict.
        !agent.sessionId
        || !agent.processIdentity
        || sameProcessIdentity(agent.processIdentity, processIdentity)
      ))
    const existing = processAgent ?? routeAgent
    if (existing) {
      const before = rowFingerprint(persistedRow(existing))
      this.drop(existing)
      existing.runtimes = mergeTerminalRuntimes(existing.runtimes, runtimes)
      existing.tmuxPane = tmuxProjection(existing.runtimes)
      existing.primaryRuntimeKey = selectedRuntimeKey(existing.runtimes, input.primaryRuntimeKey || existing.primaryRuntimeKey)
      // The pane's current path follows a terminal tile around until an engine session is bound to
      // it; from then on the bind owns the folder (see `register`), and a pane re-observed in the
      // subfolder its engine `cd`'d into must not move the row there.
      if (!existing.sessionId || !existing.cwd) existing.cwd = input.cwd ?? existing.cwd
      existing.processIdentity = processIdentity
      existing.active = true
      // The same rule the discovery callback applies on its own door (`cli.ts`): a verified engine
      // process in this row's pane is what "started" means. Resume-only rows used to be excluded
      // here, waiting for a startup hook that a resume does not reliably send — which left one
      // reading "Starting" for 19 hours over a pane its owner could type in. The wrong-conversation
      // guard in `register` keys on `lastHookAt`, untouched by this method, so it stays armed.
      if (existing.launch) {
        const before = existing.launch
        existing.launch = { state: 'ready' }
        this.traceLaunch(existing.agentId, before, existing.launch, 'openProcessAgent re-observed')
      }
      // Only a successful read speaks: an undefined probe (ps failed, /proc unreadable) keeps whatever
      // the last good one said rather than silently downgrading a gateway agent to a vendor one.
      if (input.gateway !== undefined) existing.gateway = input.gateway
      if (input.grid !== undefined) existing.grid = input.grid
      if (input.codexHome && !existing.codexHome) existing.codexHome = input.codexHome
      if (input.hermesHome && !existing.hermesHome) existing.hermesHome = input.hermesHome
      if (input.dsh && !existing.dsh) existing.dsh = input.dsh
      if (rowFingerprint(persistedRow(existing)) !== before) existing.touchedAt = Date.now()
      this.index(existing)
      this.terminalAvailableAgents.add(existing.agentId)
      this.save()
      return { entry: existing, isNew: false, evicted: null }
    }

    const agentId = input.agentId || randomUUID()
    let evicted: { agentId: string; sessionId: string } | null = null

    for (const runtime of runtimes) {
      const otherId = this.runtimeIndex.get(terminalRouteKey(runtime))
      const other = otherId ? this.agents.get(otherId) : undefined
      if (!other) continue
      this.drop(other)
      other.runtimes = other.runtimes.filter((candidate) => terminalRouteKey(candidate) !== terminalRouteKey(runtime))
      other.tmuxPane = tmuxProjection(other.runtimes)
      other.primaryRuntimeKey = selectedRuntimeKey(other.runtimes, other.primaryRuntimeKey)
      other.active = other.runtimes.length > 0
      if (other.runtimes.length) this.index(other)
      else this.terminalAvailableAgents.delete(other.agentId)
      // Only when it has nothing left. An agent that still owns another pane is
      // alive and simply narrower; it must not be announced as deleted.
      if (!other.runtimes.length) {
        evicted ??= { agentId: other.agentId, sessionId: other.sessionId }
      }

    }
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
      dsh: input.dsh ?? null,
      // A discovered pane's named agent is only visible in its argv; nothing here reads it, so the
      // row cannot relaunch it as one. Fill-only, like `dsh`.
      agent: null,
      transcriptPath: null,
      projectDir: basename(input.cwd ?? '') || agentId,
      cwd: input.cwd ?? null,
      runtimes,
      primaryRuntimeKey: selectedRuntimeKey(runtimes, input.primaryRuntimeKey),
      tmuxPane: tmuxProjection(runtimes),
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
    this.index(entry)
    this.terminalAvailableAgents.add(entry.agentId)
    this.save()
    return { entry, isNew: true, evicted }
  }

  /** Register a terminal route before its engine process exists. */
  openPendingAgent(input: {
    engine: AgentEngine
    runtimes: TerminalRuntimeRef[]
    primaryRuntimeKey?: string
    cwd?: string | null
    grid?: GridAssignment | null
    /** The grid launch this pane was opened with and what it decided — the pair `setGridLaunch` keeps. */
    gridLaunchRecord?: GridLaunchRecord | null
    /** What the prepared workspace's SCM needs on every relaunch — see RegisteredSession.scmLaunch. */
    scmLaunchRecord?: ScmLaunchRecord | null
    codexHome?: string | null
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
  }): RegisteredSession | null {
    if (this.writeBlocked) return null
    const externalResume = input.externalResume === undefined ? undefined : parseExternalResume(input.externalResume)
    if (externalResume === null || externalResume && (externalResume.phase !== 'waiting' || externalResume.request.engine !== input.engine
      || this.externalConflict(externalResumeIds(externalResume)))) return null
    const runtimes = normalizedRuntimes(input.runtimes)
    if (!runtimes.length) return null
    if (runtimes.some((runtime) => this.runtimeIndex.has(terminalRouteKey(runtime)))) return null
    const now = Date.now()
    const agentId = randomUUID()
    const entry: RegisteredSession = {
      schemaVersion: 2,
      active: !externalResume,
      launch: externalResume ? { state: 'held', service: 'search', detail: 'Waiting for the search service to verify this conversation.' } : { state: 'starting' },
      ...(externalResume ? { externalResume } : {}),
      defaultName: normalizedDefaultName(input.defaultName) ?? this.automaticName(input.label?.trim() || engineLabel(input.engine), new Date(now)),
      agentId,
      sessionId: '',
      boundAt: null,
      engine: input.engine,
      gateway: null,
      grid: input.grid ?? null,
      gridLaunch: input.gridLaunchRecord?.override ?? null,
      gridWebSearch: input.gridLaunchRecord?.webSearch ?? null,
      ...(input.scmLaunchRecord ? { scmLaunch: input.scmLaunchRecord } : {}),
      codexHome: input.codexHome ?? null,
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
      transcriptPath: null,
      projectDir: basename(input.cwd ?? '') || agentId,
      cwd: input.cwd ?? null,
      runtimes,
      primaryRuntimeKey: selectedRuntimeKey(runtimes, input.primaryRuntimeKey),
      tmuxPane: tmuxProjection(runtimes),
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
    this.index(entry)
    this.terminalAvailableAgents.add(entry.agentId)
    try { this.save(!!externalResume, false, externalResume ? agentId : undefined) } catch {
      this.drop(entry)
      this.terminalAvailableAgents.delete(entry.agentId)
      return null
    }
    return this.byAgent(entry.agentId) ?? null
  }

  /** A stopped agent gets a new terminal route while keeping its saved conversation and identity.
   * Archived routes/processes are evidence only: none of them may be indexed or signalled here. */
  resumePendingAgent(saved: RegisteredSession, runtimes: TerminalRuntimeRef[]): RegisteredSession | null {
    if (this.writeBlocked || this.agents.has(saved.agentId)
      || (saved.sessionId && this.bySession(saved.sessionId))) return null
    const routes = normalizedRuntimes(runtimes)
    if (!routes.length || routes.some(route => this.runtimeIndex.has(terminalRouteKey(route)))) return null
    const entry: RegisteredSession = {
      ...saved,
      resumeOnly: true,
      boundAt: null,
      lastHookAt: 0,
      active: true,
      launch: { state: 'starting' },
      processIdentity: null,
      runtimes: routes,
      primaryRuntimeKey: selectedRuntimeKey(routes, ''),
      tmuxPane: tmuxProjection(routes),
      touchedAt: Date.now(),
    }
    this.index(entry)
    this.terminalAvailableAgents.add(entry.agentId)
    this.save()
    return entry
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

  /**
   * Upsert a session. Idempotent — a re-register (e.g. from the UserPromptSubmit catch hook) just
   * refreshes `touchedAt`. Deduped by tmux pane: one session per pane, so a `/clear` rotation
   * (SessionEnd of the old id → SessionStart of a new id, same pane) evicts the old one instead of
   * showing two tiles. Returns { entry, isNew, evicted } — isNew=false on a re-register (so callers
   * can skip re-announcing), evicted = the sessionId displaced from this pane (caller removes it).
   */
  register(input: RegisterInput): {
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
  } | null {

    if (this.writeBlocked) return null
    const transcriptPath = input.transcriptPath
    const sessionId =
      input.sessionId || (transcriptPath ? basename(transcriptPath).replace(/\.jsonl$/, '') : '')
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
        .map((agent) => this.adoptEngine(agent.agentId, engine, validProcessIdentity(input.processIdentity) ? input.processIdentity : null))
        .find((agent): agent is RegisteredSession => !!agent))
    const agentId = processAgent?.agentId ?? ''
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
      || (engine !== 'cursor' && engine !== 'opencode' && engine !== 'kilo' && engine !== 'pi' && engine !== 'hermes' && engine !== 'commandcode' && engine !== 'devin' && engine !== 'grok' && engine !== 'agy' && engine !== 'copilot' && !transcriptPath)
      // The already-registered agent (opened at agent_create time) already carries its own
      // CODEX_HOME profile, if it has one other than the default — see RegisteredSession.codexHome.
      || (transcriptPath && !validTranscriptPath(engine, transcriptPath, processAgent?.codexHome ?? undefined))
    ) return null
    // A delegated session is never registered, by any caller: the same admission the hook server asks before
    // it credits a prompt (hookServer.ts), so that the two can never disagree.
    if (transcriptPath && !admitHook(engine, { transcriptPath }).accepted) return null

    const now = Date.now()
    const existing = this.agents.get(agentId)
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
      if (sessionId !== existing.sessionId && resumesConversation(engine, existing.sessionId)) {
        this.setLaunch(agentId, { state: 'failed', error: 'RESUME_SESSION_MISMATCH', detail: 'The agent reported a different conversation. The requested conversation is still saved.' })
        return null
      }
      if (!validProcessIdentity(input.processIdentity)) return null
    }
    // `isNew` still means "this SESSION id was not bound here before" — a rotation counts as new, which is
    // what makes the caller announce the newly bound session. The agent itself may be long-lived.
    const isNew = !existing || existing.sessionId !== sessionId
    // A rotation: the same process agent and pane swapping the engine session underneath it.
    const rebound = existing && existing.sessionId && existing.sessionId !== sessionId ? existing.sessionId : null

    const evicted: string | null = rebound
    // The same engine session cannot belong to two agents — `claude --resume X` in a second pane. The
    // newest bind wins; the old process agent remains visible but becomes unbound.
    let orphaned: { agentId: string; sessionId: string } | null = null
    const stolenFrom = this.bySession(sessionId)
    if (stolenFrom && stolenFrom.agentId !== agentId) {
      console.log(`[registry] session ${sessionId.slice(0, 8)} moved from agent ${stolenFrom.agentId.slice(0, 8)} to ${agentId.slice(0, 8)}`)
      const wasDormant = !stolenFrom.active
      this.releaseBinding(stolenFrom)
      // The verified canonical conversation moved. Its old row no longer owns the admission or
      // its aliases, and cannot later replay that resume as though it still owned the conversation.
      if (stolenFrom.externalResume) { delete stolenFrom.externalResume; delete stolenFrom.resumeOnly }
      if (wasDormant) {
        orphaned = { agentId: stolenFrom.agentId, sessionId }
        this.drop(stolenFrom)
        this.terminalAvailableAgents.delete(stolenFrom.agentId)
      }
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
    const effectiveTranscriptPath = transcriptPath ?? existing?.transcriptPath ?? derived ?? null
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
    const entry: RegisteredSession = {
      schemaVersion: 2,
      active: existing?.active ?? true,
      // No `launch`: a hook is the engine reporting for duty, so whatever the launch was — starting,
      // or failed by a watcher that gave up too early — it is over, and the frame reads `ready`.
      agentId,
      sessionId,
      boundAt: isNew ? now : existing?.boundAt ?? now,
      engine,
      // Both are facts about the live process the hook came from, re-read by discovery on every
      // pass — but a bind must not blank them in between, or the very first SessionStart hook would
      // announce a grid agent as "on no grid" until the next scan put it back.
      gateway: existing?.gateway ?? null,
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
      // Chosen once at agent_create time and never re-derived (unlike `grid`, which openProcessAgent
      // re-reads off the live process on every discovery) — a hook-triggered bind must carry it
      // forward or the very first SessionStart hook would silently wipe the agent's chosen profile.
      codexHome: existing?.codexHome ?? null,
      // The home the gate looked this session up in, or whatever the row already knew. Carried
      // forward like every field here: a bind REBUILDS the row, and a home dropped at the first hook
      // would send the mirror back to the default store (openharness#191).
      hermesHome: input.hermesHome ?? existing?.hermesHome ?? null,
      dsh: existing?.dsh ?? null,
      dshRuntime: existing?.dshRuntime ?? null,
      agent: existing?.agent ?? null,
      ...(existing?.bypassPermission ? { bypassPermission: true } : {}),
      ...(existing?.permissionMode ? { permissionMode: existing.permissionMode } : {}),
      ...(existing?.resumeOnly ? { resumeOnly: true, launch: { state: 'ready' as const } } : {}),
      // Keep alias reservations and profile arguments across the first hook and daemon restart.
      ...(existing?.externalResume && existing.engine === engine ? { externalResume: existing.externalResume } : {}),
      ...(existing?.terminalHost ? { terminalHost: true } : {}),
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
    entry.tmuxPane = tmuxProjection(entry.runtimes)
    entry.primaryRuntimeKey = selectedRuntimeKey(entry.runtimes, input.primaryRuntimeKey || existing?.primaryRuntimeKey)
    // A bind REBUILDS the row, and the rebuild carries no `launch` unless the row is resume-only:
    // an engine reporting for duty is the end of any launch. Traced like the setters, because this
    // is the one that changes the state without naming it.
    this.traceLaunch(agentId, existing?.launch, entry.launch, `register ${engine} (${isNew ? 'new session' : 're-register'})`)
    if (rebound) this.sessionIndex.delete(rebound)
    this.index(entry)
    this.save()
    return { entry, isNew, evicted, rebound, orphaned }
  }

  remove(sessionId: string): boolean {
    const entry = this.bySession(sessionId)
    if (!entry) return false
    this.drop(entry)
    this.terminalAvailableAgents.delete(entry.agentId)
    this.save()
    return true
  }

  /** Release only the mutable session binding; the process-backed agent remains addressable. */
  unbindSession(sessionId: string): boolean {
    const entry = this.bySession(sessionId)
    if (!entry) return false
    this.releaseBinding(entry)
    entry.touchedAt = Date.now()
    this.save()
    return true
  }

  /** Drop an agent outright, bound or not. */
  removeAgent(agentId: string): boolean {
    const entry = this.agents.get(agentId)
    if (!entry) return false
    this.drop(entry)
    this.terminalAvailableAgents.delete(agentId)
    this.save()
    return true
  }

  has(sessionId: string): boolean {
    return this.sessionIndex.has(sessionId)
  }

  byAgent(agentId: string): RegisteredSession | undefined {
    return this.agents.get(agentId)
  }

  bySession(sessionId: string): RegisteredSession | undefined {
    const agentId = this.sessionIndex.get(sessionId)
    return agentId ? this.agents.get(agentId) : undefined
  }

  byPaneEngine(tmuxPane: string, engine: AgentEngine): RegisteredSession | undefined {
    return this.byRuntimeEngine({ backend: 'tmux', paneId: tmuxPane }, engine)
  }

  byRuntimeEngine(runtime: TerminalRuntimeRef, engine: AgentEngine): RegisteredSession | undefined {
    const agentId = this.runtimeIndex.get(terminalRouteKey(runtime))
    const entry = agentId ? this.agents.get(agentId) : undefined
    return entry?.engine === engine ? entry : undefined
  }

  byProcess(engine: AgentEngine, identity: ProcessIdentity): RegisteredSession | undefined {
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
   * rather than mint another. `terminalHost` stays set so the exit is recognised (`releaseEngine`).
   * Refused for anything but a terminal: an agent already running one engine is never re-labelled.
   */
  adoptEngine(agentId: string, engine: AgentEngine, processIdentity?: ProcessIdentity | null): RegisteredSession | null {
    const entry = this.agents.get(agentId)
    if (!entry || !isTerminalEngine(entry.engine) || isTerminalEngine(engine)) return null
    this.drop(entry)
    entry.engine = engine
    entry.terminalHost = true
    this.traceLaunch(entry.agentId, entry.launch, { state: 'ready' }, `adoptEngine ${engine}`)
    entry.launch = { state: 'ready' }
    entry.active = true
    if (validProcessIdentity(processIdentity)) entry.processIdentity = processIdentity
    entry.touchedAt = Date.now()
    this.index(entry)
    this.terminalAvailableAgents.add(entry.agentId)
    this.save()
    return entry
  }

  /**
   * The engine in this pane has exited and the pane is a shell now: the row is a terminal.
   *
   * For every agent, not only one that began as a terminal — an engine the app launched runs
   * inside its pane's shell too (engineLaunch.ts `engineRunScript`), and `/exit` or Ctrl-C leaves
   * that shell at its prompt with the engine's last screen above it.
   *
   * What goes is what described the PROCESS and its session — session id, transcript, pid,
   * gateway, grid assignment, model, title — because the next thing typed into this shell may be a
   * different engine, and the reconciler hands a pane's engine to a row by its route only when the row
   * lacks a session or a process (`unboundRouteObservation`). What stays is what describes the PANE's
   * launch — `gridLaunch`, `codexHome`, `dsh`, `agent`, the permission choice: the tmux session's
   * environment still carries the grid endpoint and the Codex profile, the workspace is still that
   * harness's, and a restart or a relaunch after a reboot puts the same engine back with the same shape. Dropping `gridLaunch` in particular made
   * a released grid agent unrestorable ("credential not persisted"). The row itself, its id, its
   * pane and its name stay: this is the opposite of dormant, the terminal is live. `terminalHost`
   * is set from here on, since that is what the pane now is.
   */
  releaseEngine(agentId: string, separateShell = false): RegisteredSession | null {
    const original = this.agents.get(agentId)
    if (!original || (isTerminalEngine(original.engine) && !separateShell)) return null
    this.drop(original)
    this.terminalAvailableAgents.delete(agentId)
    // The archived conversation owns the original Harness ID. Preserve the physical shell under
    // a new identity, without sending input, stopping processes or claiming its route twice.
    const entry = separateShell ? { ...original, agentId: randomUUID(), dsh: null, dshRuntime: null, agent: null, defaultName: this.automaticName('Terminal', new Date()) } : original
    this.releaseBinding(entry)
    delete entry.resumeOnly
    delete entry.externalResume
    entry.engine = 'terminal'
    entry.terminalHost = true
    entry.processIdentity = null
    this.traceLaunch(entry.agentId, entry.launch, { state: 'ready' }, 'releaseEngine')
    entry.launch = { state: 'ready' }
    entry.active = true
    entry.gateway = null
    entry.grid = null
    entry.subscriptionModel = null
    entry.model = null
    entry.title = null
    entry.touchedAt = Date.now()
    this.index(entry)
    this.terminalAvailableAgents.add(entry.agentId)
    this.save()
    return entry
  }

  updateRuntimes(agentId: string, runtimes: readonly TerminalRuntimeRef[], primaryRuntimeKey?: string): boolean {
    const entry = this.agents.get(agentId)
    const normalized = normalizedRuntimes(runtimes)
    if (!entry || !normalized.length) return false
    const before = rowFingerprint(persistedRow(entry))
    this.drop(entry)
    entry.runtimes = normalized
    entry.tmuxPane = tmuxProjection(normalized)
    entry.primaryRuntimeKey = selectedRuntimeKey(normalized, primaryRuntimeKey)
    entry.active = true
    if (rowFingerprint(persistedRow(entry)) !== before) entry.touchedAt = Date.now()
    this.index(entry)
    this.terminalAvailableAgents.add(entry.agentId)
    this.save()
    return true
  }

  setActive(agentId: string, active: boolean): boolean {
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

  /** No await between the reservation, ownership transition and durable save. */
  setExternalResume(agentId: string, value: ExternalResumeIntent): RegisteredSession | null {
    if (this.writeBlocked) return null
    const row = this.byAgent(agentId), intent = parseExternalResume(value)
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
    this.drop(row)
    this.index(next)
    try { this.save(true, false, agentId) } catch (error) {
      this.drop(next)
      this.index(row)
      throw error
    }
    return this.byAgent(agentId) ?? null
  }

  /** A cancelled external intent has no owned conversation to archive. Its deletion must be durable. */
  finishExternalCancellation(agentId: string): boolean {
    const row = this.byAgent(agentId)
    if (row?.externalResume?.phase !== 'cancelled') return false
    const available = this.terminalAvailable(agentId)
    this.drop(row); this.terminalAvailableAgents.delete(agentId)
    try { this.save(true, false, agentId) } catch (error) {
      this.index(row); if (available) this.terminalAvailableAgents.add(agentId)
      throw error
    }
    return true
  }

  /** A launch dispatch is durable before tmux may replace the inert shell. */
  beginExternalDispatch(agentId: string): RegisteredSession | null {
    const row = this.byAgent(agentId)
    if (row?.externalResume?.phase !== 'admitted' || row.launch?.state !== 'held') return null
    const prior = row.launch, active = row.active, intent = row.externalResume
    row.launch = { state: 'starting' }; row.active = true; row.externalResume = { ...intent, dispatched: true }
    try { this.save(true, false, agentId) } catch (error) { row.launch = prior; row.active = active; row.externalResume = intent; throw error }
    return row
  }

  setClosePlan(agentId: string, plan: RegisteredSession['closePlan'] | null): RegisteredSession | null {
    const entry = this.agents.get(agentId)
    if (!entry) return null
    const previous = entry.closePlan
    if (plan) entry.closePlan = normalizedClosePlan(plan)
    else delete entry.closePlan
    const intended = this.intended.get(agentId) ?? new Set<string>()
    intended.add('closePlan')
    this.intended.set(agentId, intended)
    try { this.save(true) } catch (error) {
      if (previous) entry.closePlan = previous
      else delete entry.closePlan
      intended.delete('closePlan')
      if (!intended.size) this.intended.delete(agentId)
      throw error
    }
    return entry
  }

  /** Mark whether at least one backend placement was verified by this daemon process. */
  setTerminalAvailable(agentId: string, available: boolean): boolean {
    if (!this.agents.has(agentId)) return false
    if (available) this.terminalAvailableAgents.add(agentId)
    else this.terminalAvailableAgents.delete(agentId)
    return true
  }

  terminalAvailable(agentId: string): boolean {
    return this.terminalAvailableAgents.has(agentId)
  }

  /** The one lookup for anything that arrives from outside: web and device address an agent by `agentId`
   *  for most things but by a bare `sessionId` for turn control, and both must land on the same record. */
  resolve(id: string): RegisteredSession | undefined {
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
    const session = this.resolve(sessionId)
    if (!session || !validProcessIdentity(processIdentity)) return false
    const before = rowFingerprint(persistedRow(session))
    this.drop(session)
    session.processIdentity = processIdentity
    // A record written before gateways existed, or by a pass whose probe failed, learns it here — the
    // env cannot change under a running process, so a successful read is always the truth for this pid.
    if (gateway !== undefined) session.gateway = gateway
    // The grid is read from the same environment and follows the same rule. It matters most right
    // after a retarget: the respawned pane is a new pid, and this is where its new grid lands.
    if (grid !== undefined) session.grid = grid
    if (rowFingerprint(persistedRow(session)) !== before) session.touchedAt = Date.now()
    this.index(session)
    this.save()
    return true
  }

  /** Forget the process an agent was last seen as — its pane is gone, so the pid is gone with it. */
  clearProcessIdentity(agentId: string): boolean {
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
    const session = this.agents.get(agentId)
    if (!session || !permissionModeName(permissionMode)) return false
    if (session.permissionMode) return session.permissionMode === permissionMode
    session.permissionMode = permissionMode
    session.touchedAt = Date.now()
    this.save()
    return true
  }

  /** Fill in the Codex profile a row did not know (discovery read it off the live process). Never
   *  replaces one it already has — the profile is chosen once, see `codexHome`. */
  /** Put a row back in the folder its transcript belongs to (cwdRepair.ts). Any engine, any value:
   *  the caller has already proved the new folder from the transcript. */
  setCwd(agentId: string, cwd: string): boolean {
    const session = this.agents.get(agentId)
    if (!session || session.cwd === cwd) return false
    session.cwd = cwd
    session.touchedAt = Date.now()
    this.save()
    return true
  }

  /** Fill in the profile a row did not know (its CODEX_HOME), for an engine whose sessions follow one (its session
   *  store's `sessions.profile`). Never overwrites. */
  setCodexHome(agentId: string, codexHome: string): boolean {
    const session = this.agents.get(agentId)
    if (!session || !sessionStoreOf(session.engine)?.sessions.profile || session.codexHome) return false
    session.codexHome = codexHome
    session.touchedAt = Date.now()
    this.save()
    return true
  }

  /** Fill in the Hermes home a row did not know — found by looking for its session in each store, or
   *  read off the live process. Never overwrites: like `setCodexHome`, a session does not move between
   *  homes, and a later probe that could not read the process must not take the answer away. */
  setHermesHome(agentId: string, hermesHome: string): boolean {
    const session = this.agents.get(agentId)
    if (!session || session.engine !== 'hermes' || session.hermesHome) return false
    session.hermesHome = hermesHome
    session.touchedAt = Date.now()
    this.save()
    return true
  }

  /** Fill in the DSH a row did not know (discovery read `HARNESS_DSH` off the live process). Never
   *  replaces one it already has — the harness is chosen once, at creation. */
  setDsh(agentId: string, dsh: string): boolean {
    const session = this.agents.get(agentId)
    if (!session || session.dsh || !DSH_ID_RE.test(dsh)) return false
    session.dsh = dsh
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
  setGridLaunch(agentId: string, launch: GridLaunchRecord | null): boolean {
    const session = this.agents.get(agentId)
    if (!session) return false
    session.gridLaunch = launch?.override ?? null
    session.gridWebSearch = launch?.webSearch ?? null
    session.touchedAt = Date.now()
    this.save()
    return true
  }

  /** Remember the engine's own model an agent is leaving behind, so a later move back can restore it.
   *  Kept even while the agent is on a grid — it is the only record that the previous choice existed. */
  setSubscriptionModel(agentId: string, model: string | null): boolean {
    const session = this.agents.get(agentId)
    if (!session) return false
    session.subscriptionModel = model
    session.touchedAt = Date.now()
    this.save()
    return true
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
    const session = this.agents.get(agentId)
    if (!session) return null
    session.lastOpenedAt = Date.now()
    this.save()
    return session
  }

  touchTranscript(sessionId: string, at = Date.now()): boolean {
    const session = this.bySession(sessionId)
    if (!session) return false
    session.lastTranscriptAt = at
    session.touchedAt = Math.max(session.touchedAt, at)
    this.save()
    return true
  }

  updateTitle(sessionId: string, title: string | null): RegisteredSession | null {
    const session = this.resolve(sessionId)
    if (!session) return null
    const next = titleDisplayName(title)
    const current = titleDisplayName(session.title)
    if (next === current) return session
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
    const name = NAME_OVERRIDES.get(fromSessionId)
    if (!name || NAME_OVERRIDES.has(toSessionId)) return
    NAME_OVERRIDES.set(toSessionId, name)
    this.saveNames()
  }

  rename(id: string, name: string): RegisteredSession | null {
    const s = this.resolve(id)
    if (!s) return null
    const trimmed = name.trim()
    if (!trimmed) return null
    // Names are stored under the ENGINE session id on purpose: that is what makes `claude --resume <id>`
    // come back wearing the name the user gave it, even though the resume is a brand-new agent.
    NAME_OVERRIDES.set(s.sessionId || s.agentId, trimmed)
    this.saveNames()
    return s
  }

  deleteSavedNames(ids: string[]): void {
    secureStateDirectory(env.ADAPTER_DATA_DIR)
    let existing: Record<string, unknown> = {}
    try { existing = JSON.parse(readPrivateStateFile(NAMES_FILE, 1024 * 1024)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    for (const id of ids) { delete existing[id]; NAME_OVERRIDES.delete(id) }
    atomicWriteJson(NAMES_FILE, { ...existing, ...Object.fromEntries(NAME_OVERRIDES) })
  }

  list(): RegisteredSession[] {
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
    this.transactionDepth++
    let holding = true
    const release = (): void => {
      if (!holding) return
      holding = false
      this.transactionDepth--
      if (this.transactionDepth === 0 && this.savePending) {
        this.savePending = false
        this.save()
      }
    }
    const timer = options.holdSavesMs === undefined ? undefined : setTimeout(() => {
      console.warn(`[registry] a transaction has held saves back for ${options.holdSavesMs} ms; saving without waiting for it`)
      release()
    }, options.holdSavesMs)
    timer?.unref?.()
    try {
      const result = apply()
      // A synchronous batch commits before another microtask can acknowledge a close intent.
      return result instanceof Promise ? await result : result
    } finally {
      clearTimeout(timer)
      release()
    }
  }

  flush(options: { exiting?: boolean } = {}): void {
    this.save(false, options.exiting === true)
    this.saveNames()
  }

  private save(strict = false, exiting = false, externalAgentId?: string): void {
    if (this.transactionDepth > 0 && !exiting) {
      if (strict) throw new Error('Cannot acknowledge a close intent inside an uncommitted registry transaction')
      this.savePending = true
      return
    }
    if (this.writeBlocked) {
      if (strict) throw new Error('The saved session registry is unavailable')
      console.error('[registry] save skipped because the loaded registry requires operator repair')
      return
    }
    if (this.namesUnsaved) this.saveNames()
    try {
      secureStateDirectory(env.ADAPTER_DATA_DIR)
      const currentRows = new Map(this.list().map((entry) => {
        const row = persistedRow(entry) as unknown as Record<string, unknown>
        return [entry.agentId, row] as const
      }))
      // A discovery batch may be awaiting a reader after acknowledging a complete binding. Exit cannot
      // wait for it. Check BEFORE merge conflict resolution: an incomplete pane swap must never be
      // made to look valid by evicting its other owner. Its last durable snapshot remains untouched.
      if (exiting && !validatedRows([...currentRows.values()])) throw new Error('Cannot flush an incomplete registry transaction at exit')
      // Discovery still calls save on an unchanged observation so a daemon-down hook's commit is
      // noticed. If neither side changed, avoid the lock's process probe and all three fsyncs.
      // Read through the normal ownership/mode/no-symlink checks; timestamps cannot prove equality.
      // A concurrent commit after this read is picked up on the next pass, as after a locked save.
      // Close intents always take the durable path, even when an identical request is retried.
      if (!strict && this.persistedContents !== null
        && currentRows.size === this.persistedBaseline.size
        && [...currentRows].every(([id, row]) => this.persistedBaseline.get(id) === rowFingerprint(row))
        && existsSync(FILE) && readPrivateStateFile(FILE) === this.persistedContents) return
      withRegistryFileLock(() => {
        const latestValues: unknown[] = (() => {
          if (!existsSync(FILE)) return []
          const stored = JSON.parse(readPrivateStateFile(FILE)) as unknown
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
          if (v2Rows.length && !validatedRows(v2Rows)) throw new Error('registry contains a malformed v2 row')
          return parsed
        })()
        const latest = new Map<string, Record<string, unknown>>()
        for (const value of latestValues) {
          const id = rowId(value)
          if (id) latest.set(id, value as Record<string, unknown>)
        }

        if (externalAgentId && (latest.has(externalAgentId) ? rowFingerprint(latest.get(externalAgentId)) : undefined)
          !== this.persistedBaseline.get(externalAgentId)) {
          throw new Error('The durable adoption changed while it was being prepared')
        }
        // Adoption never uses the normal winner/eviction policy. A daemon-down hook may have
        // claimed its conversation since the core's last read; refuse admission inside this lock.
        for (const [id, value] of currentRows) {
          const intent = parseExternalResume(value.externalResume)
          // Every strict admission/signal/dispatch transition earns permission here. Ordinary
          // observations may persist a held provisional overlap; they never authorize a signal.
          if (id !== externalAgentId || !intent || intent.phase === 'cancelled' || this.persistedBaseline.get(id) === rowFingerprint(value)) continue
          const claims = new Set(externalReservations(value as unknown as RegisteredSession))
          for (const [otherId, otherValue] of latest) {
            if (otherId === id) continue
            const other = strictPersistedRow(otherValue)
            if (other && externalReservations(other).some(claim => claims.has(claim))) {
              throw new Error('The external conversation has another durable owner')
            }
          }
        }
        const merged = mergedForSave(latest, currentRows, this.persistedBaseline, this.intended)
        const rows = validatedRows([...merged.values()])
        if (!rows) throw new Error('registry transaction would violate global identity invariants')
        const serialized = rows.map(persistedRow)
        atomicWriteJson(FILE, serialized)
        this.persistedContents = JSON.stringify(serialized, null, 2)
        this.intended.clear()

        // Refresh external daemon-down writes into the in-memory revision without replacing object
        // identities already held by controllers.
        const previous = new Map(this.agents)
        this.agents.clear()
        this.sessionIndex.clear()
        this.runtimeIndex.clear()
        this.processIndex.clear()
        for (const row of rows) {
          const entry = previous.get(row.agentId) ?? row
          if (entry !== row) {
            // External deletions count too: retaining a cancelled closePlan here would make the
            // next observation write it back and turn a cancelled close into pending work again.
            for (const key of Object.keys(entry)) {
              if (!Object.hasOwn(row, key)) delete (entry as unknown as Record<string, unknown>)[key]
            }
            Object.assign(entry, row)
          }
          this.index(entry)
        }
        this.persistedBaseline = new Map(serialized.map((row) => [rowId(row), rowFingerprint(row)]))
      })
    } catch (err) {
      if (strict) throw err
      console.error('[registry] save failed:', err)
    }
  }

  /**
   * A names write that failed, tried again on every save until it lands. The rows heal on their own,
   * because the next save sees them differ from what is on disk; names are written only on a rename,
   * so a rename the daemon answered while the disk was full was lost to a restart that came before the
   * next rename (found end to end, e2e/diskfull.e2e.ts).
   */
  private namesUnsaved = false

  private saveNames(): void {
    try {
      secureStateDirectory(env.ADAPTER_DATA_DIR)
      let existing: Record<string, string> = {}
      try {
        const obj = JSON.parse(readPrivateStateFile(NAMES_FILE, 1024 * 1024)) as Record<string, unknown>
        existing = Object.fromEntries(Object.entries(obj).filter(([, v]) => typeof v === 'string')) as Record<string, string>
      } catch {
        // no file yet / unreadable — write the in-memory overrides
      }
      atomicWriteJson(NAMES_FILE, { ...existing, ...Object.fromEntries(NAME_OVERRIDES) })
      this.namesUnsaved = false
    } catch (err) {
      this.namesUnsaved = true
      console.error('[registry] save names failed:', err)
    }
  }
}

export const registry = new Registry()

function defaultProjectDisplayName(s: RegisteredSession): string {
  const folder = s.cwd ? s.cwd.split('/').filter(Boolean).pop() || s.cwd : s.projectDir
  return `${folder} · ${(s.sessionId || s.agentId).slice(0, 4)}`
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
function normalizedGridLaunch(value: unknown): GridLaunchOverride | null | undefined {
  if (value === undefined) return undefined
  const parsed = parseGridLaunchOverride(value)
  return parsed.state === 'ok' ? parsed.override : null
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
