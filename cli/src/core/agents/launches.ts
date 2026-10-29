/**
 * The requests that start an agent's process: `agent_create`, `agent_fork`, `agent_resume` and
 * `agent_restart`, and `agent_create_status`, which asks what became of one. A client that names its
 * request with a `creationId` gets a durable receipt (lib/agentCreationReceipt.ts): a transport retry
 * carrying the same id never starts a second process, and a lost answer can be asked for again. Such a
 * request is answered outside the connection's line, so a status check can pass a slow launch.
 *
 * Moved verbatim out of the socket's request switch (docs/design/2026-10-03-harnessd.md), with the
 * receipts the socket used to hold.
 */
import { readdir, rmdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute } from 'node:path'
import type { BackendSocket } from '../../backendSocket.js'
import type { Asker, SwarmLaunch } from '../api.js'
import { installedDsh } from '../../dsh/installed.js'
import { DSH_ID_RE, dshSupportedEngines } from '../../dsh/manifest.js'
import { folderTrust } from '../../engines/launchPrep.js'
import type { NativeLaunchResult, NativeLaunchSource } from '../../engines/nativeLaunch.js'
import * as opencodeLaunch from '../../engines/launchControl.js'
import { ENGINES, isTerminalEngine, type AgentEngine } from '../../engines/types.js'
import { AgentCreationReceiptError, creationFingerprint, validCreationId, type AgentCreationOutcome, type AgentCreationReceipts, type AgentCreationStatus, type CreationAuthority } from '../../lib/agentCreationReceipt.js'
import type { AgentFrame } from '../../lib/agentFrame.js'
import { engineLabel } from '../../lib/agentNames.js'
import {
  AGENT_NAME_RE, FirstPromptUnsupportedError, MAX_FIRST_PROMPT_CHARS, NamedAgentUnsupportedError, permissionModeApproves,
  permissionModeFlags, supportsFirstPrompt, supportsNamedAgent, unsupportedLaunchModelFlag,
} from '../../lib/engineLaunch.js'
import { parseGridLaunchOverride, type GridLaunchOverride } from '../../lib/gridLaunchWire.js'
import { parseLaunchModel } from '../../lib/launchModel.js'
import { parseNewAgentModel, type NewAgentModel } from '../../lib/newAgentModel.js'
import { parseProjectFolder, prepareProjectFolder, projectsRoot, ProjectFolderError, type ProjectFolder } from '../../lib/projectFolder.js'
import type { ScmLaunchRecord } from '../../scm/types.js'
import { parentAgentIdOf, type RegisteredSession } from '../../lib/registry.js'
import { buildHarnessSessionLabel } from '../../lib/harnessSessionLabel.js'
import type { LaunchAuthority, LaunchPreparation } from '../../lib/launchPreparation.js'
import { createPendingLaunches } from './pendingLaunches.js'
import type { GuestCreate } from './guestCreate.js'

/** Creates an agent (core/agents/create.ts). The orchestrator creates through the same one. */
export type CreateAgent = NonNullable<BackendSocket['onCreateAgent']>
/** Opens a NEW agent that starts with another one's whole history (core/agents/fork.ts); `level` says
 *  what it got: the engine's own fork, or a handoff message. */
export type ForkAgent = NonNullable<BackendSocket['onForkAgent']>
/** Stops an agent's live engine process and relaunches it in the SAME tmux pane, keeping the SAME
 *  agentId and (best-effort) resuming the same engine session. `resumed` says whether the relaunch
 *  actually resumed the prior conversation or had to fall back to a fresh one (core/agents/restart.ts). */
export type RestartAgent = (agentId: string) => Promise<
  { ok: true; session: RegisteredSession; resumed: boolean }
  | { ok: false; error: string; detail?: string; reason?: string }
>
/** Resumes stopped work directly, or attaches if it is already running. Never replaces a live process
 *  and never falls back to a fresh conversation (core/agents/lifecycle.ts). */
export type ResumeAgent = (agentId: string, permissionMode?: string) => ReturnType<RestartAgent>

export interface LaunchRequestDeps {
  /** The receipts of launches asked for with a `creationId`. */
  receipts: Pick<AgentCreationReceipts, 'run' | 'status' | 'createdLaunchModel' | 'creator' | 'has' | 'runIntent' | 'pendingIntents' | 'pendingIntent' | 'cancelIntent'>
  /** Each launch, read when a request comes in: null on a machine that cannot launch agents. */
  createAgent: () => CreateAgent | null
  prepareCreate?: (input: Parameters<CreateAgent>[0], authority: LaunchAuthority, context?: { local: boolean }) => Promise<LaunchPreparation<Awaited<ReturnType<CreateAgent>>>>
  /** The engine itself made ready, installed first when it is missing (engines/prepareNativeLaunch.ts): what a new
   *  project waits for before its folder is made. */
  prepareEngine?: (engine: CreateInput['engine'], source: NativeLaunchSource, authority: Pick<CreationAuthority, 'id' | 'current'>) => Promise<NativeLaunchResult>
  forkAgent: () => ForkAgent | null
  resumeAgent: () => ResumeAgent | null
  restartAgent: () => RestartAgent | null
  byAgent: (agentId: string) => RegisteredSession | undefined
  /** An agent's frame, as the socket builds it for every reply. */
  toProject: (s: RegisteredSession) => Promise<AgentFrame>
  /** Where a new agent on a grid model sends its inference: the models service's to resolve, on this
   *  machine (core/api.ts `ModelsPort.launchTarget`). Null or a rejection holds a durable model request;
   *  resolving the semantic choice may renew service-owned credentials, but never dispatches a launch. */
  modelTarget: (selection: NewAgentModel) => Promise<GridLaunchOverride | null>
  /** A guest's New Harness, as the guest's own OS user (core/agents/guestCreate.ts); null where there is none. */
  guestCreate?: () => GuestCreate | null
  /** Which Swarm roles and skill modes a start may ask for (superTabs/inCore/launch.ts); absent while the Swarm is off. */
  swarmLaunch?: Pick<SwarmLaunch, 'role' | 'mode'>
}

type Reply = (result: Record<string, unknown>) => void
type CreateInput = Parameters<CreateAgent>[0]

export function createLaunchRequests({ receipts, createAgent, prepareCreate, prepareEngine, forkAgent, resumeAgent, restartAgent, byAgent, toProject, modelTarget, guestCreate, swarmLaunch }: LaunchRequestDeps) {
  const validateInstalled = async (input: CreateInput, known?: ReturnType<typeof installedDsh>): Promise<{ error: string; detail: string } | null> => {
    if (input.dsh) {
      const installed = known ?? installedDsh(input.dsh)
      if (!installed) return { error: 'INVALID_DSH', detail: `${input.dsh} is not installed on this machine` }
      if (installed.manifest.kind === 'viewer') return { error: 'INVALID_DSH', detail: `${input.dsh} is a viewer package, not an agent` }
      if (!dshSupportedEngines(installed.manifest).includes(input.engine)) return { error: 'INVALID_DSH',
        detail: `${input.dsh} supports ${dshSupportedEngines(installed.manifest).join(', ')}; ${input.engine} is not compatible` }
    }
    if (input.agent && !supportsNamedAgent(input.engine, input.engine === 'opencode' ? await opencodeLaunch.opencodeMajorVersion() : null)) {
      return { error: 'AGENT_UNSUPPORTED', detail: new NamedAgentUnsupportedError(input.engine).message }
    }
    return null
  }

  const executeCreate = async (input: CreateInput, projectFolder: ProjectFolder | null, local: boolean, invoke: CreateAgent, validated = false): Promise<AgentCreationOutcome> => {
    if (!validated) {
      const refusal = await validateInstalled(input)
      if (refusal) return { state: 'failed', ...refusal }
    }
    const { dsh, resumeSessionId } = input
    let preparedFolder: string | undefined
    /** A new project's folder, which this made empty: removed again if nothing starts in it. */
    let made: string | undefined
    let scmLaunchRecord: ScmLaunchRecord | null = null
    if (projectFolder) {
      try {
        preparedFolder = await prepareProjectFolder(projectFolder, { label: (dsh ? installedDsh(dsh)?.manifest.name : null) ?? engineLabel(input.engine),
          onPrepared: prepared => { scmLaunchRecord = prepared.scmLaunchRecord } })
        if (projectFolder.source === 'new') made = preparedFolder
      }
      catch (error) {
        return { state: 'failed', error: error instanceof ProjectFolderError ? error.code : 'PROJECT_PREPARATION_FAILED',
          detail: error instanceof ProjectFolderError ? error.message : 'Could not prepare the project folder.',
          // The folder a typed name found already there: the apps offer to start in it, and `harness new` names it.
          ...(error instanceof ProjectFolderError && error.folder ? { existingFolder: error.folder } : {}) }
      }
      // Only a folder this daemon just made EMPTY is one the engine need not ask about. A clone or
      // the person's own repo is theirs to answer for (engines/kit/folderTrust.ts); a worktree gets only
      // the answer its source repo already has. `branch` IS the source folder: nothing to record.
      //
      // One consented exception: a Swarm agent in the Swarm's full mode, in the checkout a remote project resolved
      // to (cloned now, or one already there that holds that very repository). The person chose this repository
      // and full mode for the Swarm, and machine trust favors that choice over a prompt. 2026-10-26: on WIN-DELL
      // a Lead in a reused `harnesses\openharness` sat at Claude Code's trust question; on the Mac Studio a Lead in
      // a fresh clone did, and the next Lead, in a worktree of it, asked again because the source had never been
      // answered. Its Yes then landed under the source's key (Claude Code records a worktree's answer under its
      // main repository), which made the source look trusted before the worktree started.
      // Claude Code only: Codex's trust also sets its defaults for the person's own later sessions in that folder.
      const swarmCheckout = input.engine === 'claude' && projectFolder.source === 'remote' && !!input.swarmRole
        && input.permissionMode === 'full'
      try {
        // A Codex agent on its own profile reads its trust from that profile's config.toml, not ~/.codex.
        const engineTrust = folderTrust(input.engine, input.codexHome)
        if (engineTrust && (projectFolder.source === 'new' || swarmCheckout
          || (projectFolder.source === 'worktree' && engineTrust.trusts(projectFolder.gitSource)))) {
          engineTrust.record(preparedFolder)
        }
      } catch (error) { console.warn(`[agent] pre-trust ${preparedFolder} · ${error instanceof Error ? error.message : error}`) }
    } else if (!dsh && !resumeSessionId && local && dirname(input.cwd) === projectsRoot()) {
      // On the LOCAL machine the desktop makes a new workspace ITSELF and sends the path as a plain
      // cwd, so `projectFolder` above never sees it. Such a folder is empty and is trusted the way a
      // `new` project is — but only on evidence, and only where those workspaces live:
      //
      //   · directly inside the projects root, which is the one folder the app and this daemon
      //     create workspaces in. Claude Code's trust INHERITS downward, so recording it for a
      //     folder the person merely browsed to — an empty `~/code`, or a home with nothing in it —
      //     would silently cover every repo cloned under it later: OH-14 again by another door.
      //   · empty as read from disk, never on the client's word. A clone, a worktree or the
      //     person's own repo has content, so it stays the engine's question (engines/kit/folderTrust.ts).
      //   · from a LOCAL frame. agent_create is not backend-only, so a relayed peer would otherwise
      //     name an empty path on this host and have it trusted.
      //
      // DSH trust is decided in cli.ts, where the template count is known; leave that to it.
      try {
        const empty = await readdir(input.cwd).then((names) => names.length === 0, () => false)
        if (empty) folderTrust(input.engine, input.codexHome)?.record(input.cwd)
      } catch (error) { console.warn(`[agent] pre-trust ${input.cwd} · ${error instanceof Error ? error.message : error}`) }
    }
    const result = await invoke(preparedFolder ? { ...input, cwd: preparedFolder, scmLaunchRecord } : input)
    if (result.ok) return { state: 'created', agentId: result.session.agentId }
    // tmux may have executed before a timeout; registration cleanup is best-effort.
    // Neither can prove that no process started, so never encourage another launch.
    if (result.error === 'SPAWN_FAILED' || result.error === 'REGISTRATION_FAILED') return { state: 'unconfirmed' }
    // A new project's folder that nothing started in goes again while it is still empty: left, it made the same
    // `harness new codex scratch1` refuse its own name ("already exists", a fresh Ubuntu VM, 2026-10-12). rmdir
    // removes only an empty folder, so anything put there meanwhile stays, and the folder is then reported.
    if (made && await rmdir(made).then(() => true, () => false)) preparedFolder = undefined
    return { state: 'failed', error: result.error, ...(preparedFolder ? { preparedFolder } : {}), ...(result.detail ? { detail: result.detail.slice(0, 2000) } : {}) }
  }

  const modelHold = { service: 'models', detail: 'Waiting for the selected model. This request is saved and will continue when it is available.' }
  const launchHold = { service: 'launch', detail: 'Waiting for launch preparation. This request is saved and will continue when its dependencies are available.' }
  const pending = createPendingLaunches({ receipts, prepare: async (saved, authority) => {
    if (saved.kind === 'native-create-v1') {
      if (!prepareCreate || typeof saved.local !== 'boolean' || !saved.input || typeof saved.input !== 'object'
        || typeof saved.label !== 'string' || !/^harness-[a-z0-9-]+$/.test(saved.label)) return null
      const input = structuredClone(saved.input) as CreateInput
      const projectFolder = (saved.projectFolder ?? null) as ProjectFolder | null
      if (!ENGINES.includes(input.engine) || typeof input.cwd !== 'string' || input.resumeSessionId
        || (projectFolder !== null && typeof projectFolder.source !== 'string')) return null
      const { local, label } = saved
      if (saved.selection) {
        authority.hold(modelHold)
        const target = await modelTarget(saved.selection as NewAgentModel)
        if (!authority.current()) return null
        if (!target) { authority.hold(modelHold); return null }
        input.grid = target
        authority.hold(launchHold)
      }
      // An engine Harness is installing for this launch holds it under `install`, which `harness new` waits longer
      // for than any other hold (lib/newCommand.ts): installs take a minute on a fresh computer.
      const held = (ready: { installing?: boolean; unavailable?: string; detail?: string }) =>
        authority.hold({ service: ready.installing ? 'install' : ready.unavailable!, detail: ready.detail ?? 'Waiting for launch preparation.' })
      const refused = (ready: { error: string; detail?: string }) => async (): Promise<AgentCreationOutcome> =>
        ({ state: 'failed', error: ready.error, ...(ready.detail ? { detail: ready.detail.slice(0, 2000) } : {}) })
      if (projectFolder) {
        // A new project waits for its engine before its folder is made, so a launch still waiting for an install leaves
        // nothing behind when it is cancelled or the install fails. It used to be refused at once, folder made, saying
        // "the saved launch continues after installation" of a launch that was over (a fresh Ubuntu VM, 2026-10-12).
        // The folder, the engine's final preparation and the launch are then one claimed effect, as they always were
        // for a project: a refusal there is its outcome, never a hold.
        const engine = prepareEngine ? await prepareEngine(input.engine, input, authority) : null
        if (!authority.current()) return null
        if (engine && !engine.ok) {
          if (engine.refusal) return refused({ error: engine.refusal, detail: engine.detail })
          held(engine); return null
        }
        const invoke: CreateAgent = async (prepared) => {
          const ready = await prepareCreate(prepared, { ...authority, label }, { local })
          return ready.ok ? ready.dispatch() : { ok: false, error: ready.error, ...(ready.detail ? { detail: ready.detail } : {}) }
        }
        return () => executeCreate(input, projectFolder, local, invoke)
      }
      const ready = await prepareCreate(input, { ...authority, label }, { local })
      if (!authority.current()) return null
      if (!ready.ok) {
        if (ready.unavailable) { held(ready); return null }
        return refused(ready)
      }
      return async () => {
        if (!authority.current()) return { state: 'unconfirmed' }
        // All preparation, including local workspace trust, precedes the claim.
        // A trust write here would invalidate Codex's final config proof.
        const result = await ready.dispatch()
        if (result.ok) return { state: 'created', agentId: result.session.agentId }
        // Dispatch's outcome is uncertain once its exclusive claim is durable.
        // In particular, a stale guard must never reopen that claim for replay.
        return { state: 'unconfirmed' }
      }
    }
    // A future intent kind cannot be interpreted as this one. Keep unknown or
    // damaged requests held instead of guessing at their launch choices.
    if (saved.kind !== 'model-create-v1' || typeof saved.local !== 'boolean'
      || !saved.input || typeof saved.input !== 'object' || !saved.selection || typeof saved.selection !== 'object') return null
    const input = structuredClone(saved.input) as CreateInput
    const selection = saved.selection as NewAgentModel
    if (!ENGINES.includes(input.engine) || typeof input.cwd !== 'string' || input.resumeSessionId
      || input.grid !== null || typeof selection.model !== 'string' || typeof selection.grid !== 'string') return null
    const invoke = createAgent()
    if (!invoke) return null
    const target = await modelTarget(selection)
    if (!target) return null
    input.grid = target
    return () => executeCreate(input, (saved.projectFolder ?? null) as ProjectFolder | null, saved.local as boolean, invoke)
  } })

  /** Recover by stable runtime identity; a deleted agent must never become a fresh launch. */
  const creationStatusPayload = async (status: AgentCreationStatus): Promise<Record<string, unknown>> => {
    if (status.state === 'created') {
      const session = byAgent(status.agentId)
      return session
        ? { state: 'created', agent: await toProject(session), ...(status.level ? { level: status.level } : {}), ...(status.resumed !== undefined ? { resumed: status.resumed } : {}) }
        : { state: 'unavailable', createdAgentId: status.agentId }
    }
    // A recorded refusal is a completed outcome. Keep it separate from transport/dispatch errors
    // so clients can distinguish "safe to correct the choices" from "outcome still unknown".
    if (status.state === 'failed') {
      return { state: 'failed', ...(status.preparedFolder ? { preparedFolder: status.preparedFolder } : {}), failure: { code: status.error,
        ...(status.reason ? { reason: status.reason } : {}), ...(status.detail ? { detail: status.detail } : {}),
        ...(status.existingFolder ? { existingFolder: status.existingFolder } : {}) } }
    }
    return status
  }

  /** A guest sees only its own creations. For anyone else's id it hears what an unknown id gets, so the
   *  answer does not tell whether the id exists. The owner administers the machine and sees them all. */
  const hiddenFrom = (asker: Pick<Asker, 'local' | 'guest'>, creationId: string): boolean => {
    if (asker.guest === undefined) return false
    // Damaged evidence for this id is hidden the same way; the guest's own retry still meets it in `run`.
    try { return receipts.creator(creationId) !== asker.guest }
    catch (error) { if (error instanceof AgentCreationReceiptError) return true; throw error }
  }

  /** Answers `agent_create_status`: what became of the launch a `creationId` names. */
  const createStatus = async (payload: Record<string, unknown>, asker: Pick<Asker, 'local' | 'guest'>, reply: Reply): Promise<void> => {
    const creationId = payload.creationId
    if (!validCreationId(creationId)) { reply({ error: 'INVALID_CREATION_ID' }); return }
    try {
      if (hiddenFrom(asker, creationId)) { reply({ creationId, state: 'missing' }); return }
      const status = receipts.status(creationId)
      const launchModel = status.state === 'created' ? receipts.createdLaunchModel(creationId) : null
      reply({ creationId, ...await creationStatusPayload(status), ...(launchModel ? { launchModel } : {}) })
    } catch (error) {
      reply({ error: error instanceof AgentCreationReceiptError ? error.code : 'INTERNAL' })
    }
  }

  /** A guest's `agent_create`: its own launch, never the owner's (core/agents/guestCreate.ts). A `creationId` keeps a
   *  receipt as the owner's launches do, so a status check or a retry finds the same harness. */
  const createForGuest = async (payload: Record<string, unknown>, guest: string, reply: Reply): Promise<void> => {
    const launch = guestCreate?.()
    if (!launch) { reply({ error: 'GUEST_NOT_ALLOWED' }); return }
    const creationId = payload.creationId
    if (creationId !== undefined && !validCreationId(creationId)) { reply({ error: 'INVALID_CREATION_ID' }); return }
    if (creationId === undefined) {
      const result = await launch(payload, guest)
      reply(result.ok ? { agent: await toProject(result.session) } : { error: result.error, ...(result.detail ? { detail: result.detail } : {}) })
      return
    }
    try {
      const fingerprint = creationFingerprint({ guest, engine: payload.engine, name: payload.name })
      void receipts.run(creationId, fingerprint, async () => {
        const result = await launch(payload, guest)
        return result.ok ? { state: 'created', agentId: result.session.agentId }
          : { state: 'failed', error: result.error, ...(result.detail ? { detail: result.detail } : {}) }
      }, guest).then(async (status) => {
        reply({ creationId, ...await creationStatusPayload(status) })
      }).catch(() => reply({ error: 'INTERNAL' }))
    } catch (error) {
      reply({ error: error instanceof AgentCreationReceiptError ? error.code : 'INTERNAL' })
    }
  }

  /** Answers `agent_create`. `asker.local` says the frame came from this machine; `asker.guest`, that a guest
   *  of a machine shared with them asks (core/guestPolicy.ts). */
  const create = async (payload: Record<string, unknown>, asker: Pick<Asker, 'local' | 'guest'>, reply: Reply): Promise<void> => {
    if (asker.guest !== undefined) { await createForGuest(payload, asker.guest, reply); return }
    const engine = payload.engine as AgentEngine | undefined
    const cwd = payload.cwd
    if (typeof engine !== 'string' || !ENGINES.includes(engine)) { reply({ error: 'INVALID_ENGINE' }); return }
    let projectFolder
    try { projectFolder = parseProjectFolder(payload) }
    catch (error) {
      reply(error instanceof ProjectFolderError
        ? { error: error.code, detail: error.message }
        : { error: 'INVALID_PROJECT_SOURCE' }); return
    }
    // A terminal opens where a terminal app would — the home directory — when the client names
    // no folder; every other engine works IN a folder and must be told which.
    const terminal = isTerminalEngine(engine)
    if (terminal && projectFolder) { reply({ error: 'INVALID_PROJECT_SOURCE', detail: 'a terminal opens in a folder, it does not prepare one' }); return }
    if (!projectFolder && !(terminal && cwd === undefined) && (typeof cwd !== 'string' || !isAbsolute(cwd))) { reply({ error: 'INVALID_CWD' }); return }
    const onCreateAgent = createAgent()
    if (!onCreateAgent) { reply({ error: 'UNSUPPORTED_ON_REMOTE' }); return }
    const creationId = payload.creationId
    if (creationId !== undefined && !validCreationId(creationId)) {
      reply({ error: 'INVALID_CREATION_ID' }); return
    }
    if (projectFolder && (!validCreationId(creationId) || cwd !== undefined)) {
      reply({ error: 'INVALID_PROJECT_SOURCE' }); return
    }
    // Absent is the ordinary case and stays indistinguishable from a client that predates grids;
    // present-but-malformed is refused here rather than half-applied at launch, because an agent
    // that quietly ran on the engine's own login would look like it worked.
    const model = parseNewAgentModel(engine, payload)
    if (model.state === 'invalid') { reply({ error: 'INVALID_GRID', detail: model.detail }); return }
    const grid = parseGridLaunchOverride(payload.grid)
    if (grid.state === 'invalid') { reply({ error: 'INVALID_GRID', detail: grid.reason }); return }
    if (terminal && grid.state === 'ok') { reply({ error: 'INVALID_GRID', detail: 'a terminal has no engine to point at a grid' }); return }
    // A model and effort for this session alone, as flags (lib/launchModel.ts). Refused, never ignored: a daemon that
    // dropped them would start the agent on the engine's own model and look like it worked, so a caller that gets
    // LAUNCH_MODEL_UNSUPPORTED switches the model after the start instead. A grid picks its own model.
    const launchModel = parseLaunchModel(engine, payload)
    if (launchModel.state === 'invalid') { reply({ error: 'INVALID_LAUNCH_MODEL', detail: launchModel.detail }); return }
    if (launchModel.state === 'unsupported') { reply({ error: 'LAUNCH_MODEL_UNSUPPORTED', detail: launchModel.detail }); return }
    if (launchModel.state === 'ok' && (grid.state === 'ok' || model.state === 'ok')) {
      reply({ error: 'INVALID_LAUNCH_MODEL', detail: 'a grid chooses its own model' }); return
    }
    // A Claude Code too old for the flags would print its help in the new pane. Refused here, before any receipt, so the
    // caller creates the agent without them and switches the model afterwards, as it did before the flags.
    if (launchModel.state === 'ok') {
      const missing = await unsupportedLaunchModelFlag(engine, launchModel.launchModel)
      if (missing) { reply({ error: 'LAUNCH_MODEL_UNSUPPORTED', detail: `The ${engine} on this machine does not support ${missing}; update ${engine} to launch it with a model.` }); return }
    }
    // Same validation the desktop app already applies client-side (`Agent._safeCodexHome`) —
    // repeated here because a client's own check is not a guarantee about what actually
    // arrives on the wire.
    const rawCodexHome = typeof payload.codexHome === 'string' ? payload.codexHome : null
    const codexHome = rawCodexHome && rawCodexHome.startsWith('/') && rawCodexHome.length <= 4096
      && !/[\x00-\x1f\x7f]/.test(rawCodexHome)
      ? rawCodexHome
      : null
    if (codexHome && (engine !== 'codex' || grid.state === 'ok')) {
      reply({ error: 'INVALID_CODEX_HOME', detail: 'codexHome is only valid for codex, without a grid' })
      return
    }
    // A DSH is refused, never approximated: an agent created as its plain base engine would look
    // like it worked and have none of the skills the user picked the tile for.
    let dsh: string | null = null
    let installed: ReturnType<typeof installedDsh>
    if (payload.dsh !== undefined && payload.dsh !== null) {
      if (typeof payload.dsh !== 'string' || !DSH_ID_RE.test(payload.dsh)) {
        reply({ error: 'INVALID_DSH', detail: 'dsh must be an owner/name id' }); return
      }
      installed = installedDsh(payload.dsh)
      // Formerly-named packages used their canonical ID in both launch input
      // and v1 fingerprints. Resolve aliases without refusing a known receipt
      // merely because the package is no longer installed.
      dsh = installed?.id ?? payload.dsh
    }
    // A first prompt is refused BEFORE any pane exists: an engine with no way to take one would
    // otherwise open on an empty input and look like the person's request had been heard. The
    // length bound is a first message's, not a document's. The text itself is never logged.
    let prompt: string | null = null
    if (payload.prompt !== undefined && payload.prompt !== null) {
      if (typeof payload.prompt !== 'string') { reply({ error: 'INVALID_PROMPT', detail: 'prompt must be a string' }); return }
      const trimmed = payload.prompt.trim()
      if (trimmed.length > MAX_FIRST_PROMPT_CHARS) {
        reply({ error: 'PROMPT_TOO_LONG', detail: `prompt is longer than ${MAX_FIRST_PROMPT_CHARS} characters` }); return
      }
      if (trimmed && !supportsFirstPrompt(engine)) {
        reply({ error: 'PROMPT_UNSUPPORTED', detail: new FirstPromptUnsupportedError(engine).message }); return
      }
      prompt = trimmed || null
    }
    const swarmRole = payload.swarmRole
    if (!swarmLaunch && ((swarmRole !== undefined && swarmRole !== null) || payload.swarmSkillMode !== undefined || payload.swarmGitHub !== undefined)) {
      reply({ error: 'INVALID_SWARM_ROLE', detail: 'The Swarm is off on this computer (HARNESS_SWARM).' }); return
    }
    const isSwarmRole = (value: unknown): value is NonNullable<CreateInput['swarmRole']> => !!swarmLaunch?.role(value)
    if (swarmRole !== undefined && swarmRole !== null &&
      (!isSwarmRole(swarmRole) || (engine !== 'claude' && engine !== 'codex'))) {
      reply({ error: 'INVALID_SWARM_ROLE', detail: 'A Swarm role is lead, dev or review, for Claude Code or Codex.' }); return
    }
    // The skills of the project the agent joins (superTabs/start.ts); a start from before modes sends none.
    const swarmSkillMode = payload.swarmSkillMode
    if (swarmSkillMode !== undefined && !swarmLaunch?.mode(swarmSkillMode)) {
      reply({ error: 'INVALID_SWARM_ROLE', detail: 'A Swarm skill mode is default or orchestration.' }); return
    }
    // Another person's project work: git and gh use the Harness GitHub App's token for the task (lib/swarmGitHub.ts).
    // Only `true`, and only with a role; a start from before the app sends none and launches as it did.
    const swarmGitHub = payload.swarmGitHub
    if (swarmGitHub !== undefined && (swarmGitHub !== true || !isSwarmRole(swarmRole))) {
      reply({ error: 'INVALID_SWARM_ROLE', detail: 'swarmGitHub is true, with a Swarm role.' }); return
    }
    // Its worktree fetches nothing with this machine's own git login: its host fetched with the app's token just before
    // (superTabs/projectFolder.ts), or, started by a Lead on its own machine, it starts from what the checkout has.
    if (swarmGitHub === true && projectFolder?.source === 'worktree') projectFolder = { ...projectFolder, offline: true }
    // Blank is "number it", the same as absent — a client that sends an empty field is not
    // asking for an agent with no name.
    const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : null
    // The engine's named agent is refused BEFORE any pane exists, like the prompt: an engine with
    // no way to open as one would otherwise come up as a general session under that agent's
    // name. The shape is an identifier the engine looks a file up by — never a path.
    let agent: string | null = null
    if (payload.agent !== undefined && payload.agent !== null) {
      if (typeof payload.agent !== 'string' || !AGENT_NAME_RE.test(payload.agent)) {
        reply({ error: 'INVALID_AGENT', detail: 'agent must be 1-64 letters, digits, `-` or `_`' }); return
      }
      agent = payload.agent
    }
    // A permission mode picked in New Harness. A client that predates the choice sends only
    // `bypassPermission`; one that sends a mode this engine does not have is refused rather than
    // quietly launched in some other mode.
    let permissionMode: string | null = null
    if (payload.permissionMode !== undefined && payload.permissionMode !== null) {
      if (typeof payload.permissionMode !== 'string' || !permissionModeFlags(engine, payload.permissionMode)) {
        reply({ error: 'INVALID_PERMISSION_MODE', detail: `${engine} has no permission mode ${JSON.stringify(payload.permissionMode)}` }); return
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
        reply({ error: 'INVALID_SESSION', detail: 'resumeSessionId must be a session id' }); return
      }
      if (terminal || projectFolder || grid.state === 'ok' || model.state === 'ok' || launchModel.state === 'ok' || dsh || prompt || agent || swarmRole) {
        reply({ error: 'INVALID_SESSION', detail: 'a resumed conversation takes no new folder, grid, harness, prompt or agent' }); return
      }
      resumeSessionId = payload.resumeSessionId
    }
    let takeOver: 'idle' | 'now' | 'wait' | null = null
    if (payload.takeOver !== undefined && payload.takeOver !== null) {
      if (!resumeSessionId || (payload.takeOver !== 'idle' && payload.takeOver !== 'now' && payload.takeOver !== 'wait')) {
        reply({ error: 'INVALID_SESSION', detail: 'takeOver is idle, now or wait, with a resumeSessionId' }); return
      }
      takeOver = payload.takeOver
    }
    // Another agent started it (`harness new` from its pane, agentClient/commands.ts `agentOrigin`): its pull requests
    // say so (lib/agentAttribution.ts). Refused, not ignored, when it is anything else: absent is the person.
    if (payload.startedBy !== undefined && payload.startedBy !== null && payload.startedBy !== 'agent') {
      reply({ error: 'INVALID_STARTED_BY', detail: 'startedBy is agent, or absent for the person' }); return
    }
    // Which harness here that agent is (`harness new` or `harness_start` from its pane): the windows open the new one
    // beside it and say who started it. Only with `startedBy: 'agent'`, and only an agent id; one this machine does not
    // know is left out rather than refused, so a harness that just closed does not stop its child from starting.
    let parentAgentId: string | null = null
    if (payload.parentAgentId !== undefined && payload.parentAgentId !== null) {
      parentAgentId = payload.startedBy === 'agent' ? parentAgentIdOf(payload.parentAgentId) : null
      if (!parentAgentId) { reply({ error: 'INVALID_STARTED_BY', detail: 'parentAgentId is the agent id of the harness that started it, with startedBy agent' }); return }
      if (!byAgent(parentAgentId)) parentAgentId = null
    }
    const input: Parameters<CreateAgent>[0] = {
      engine,
      cwd: typeof cwd === 'string' ? cwd : terminal ? homedir() : '',
      // On unless a client says otherwise: a harness works without stopping to ask for each command.
      bypassPermission: permissionMode ? permissionModeApproves(permissionMode) : payload.bypassPermission !== false,
      permissionMode,
      grid: grid.state === 'ok' ? grid.override : null,
      codexHome,
      dsh,
      prompt,
      ...(isSwarmRole(swarmRole) ? { swarmRole, ...(swarmSkillMode ? { swarmSkillMode } : {}), ...(swarmGitHub ? { swarmGitHub } : {}) } : {}),
      name,
      agent,
      resumeSessionId,
      takeOver,
      // Only when set: a person's create keeps the fingerprint its receipt was recorded with before the field.
      ...(payload.startedBy === 'agent' ? { startedBy: 'agent' as const } : {}),
      ...(launchModel.state === 'ok' ? { launchModel: launchModel.launchModel } : {}),
      ...(parentAgentId ? { parentAgentId } : {}),
    }
    const fingerprintInput = model.state === 'ok' ? { ...input, modelSelection: model.selection } : input
    if (creationId !== undefined) {
      // Reserve before spawning. A transport retry carries the SAME creationId; a deliberate
      // New agent action carries a new one. Detach so a status check can pass a slow create
      // on this connection, just as engines_probe is detached above.
      const create = onCreateAgent
      try {
        const fingerprint = creationFingerprint(projectFolder ? { ...fingerprintInput, projectFolder } : fingerprintInput)
        // A new project too, which waits for its engine as any other create does (above).
        const durableNative = !!prepareCreate && !resumeSessionId
        // A new project is refused at once for a harness or named agent it cannot have, as it always was, rather than
        // after its engine is installed and its folder made.
        if ((!durableNative || projectFolder) && model.state !== 'ok' && !receipts.has(creationId, fingerprint)) {
          const refusal = await validateInstalled(input, installed)
          if (refusal) { reply(refusal); return }
        }
        const operation = durableNative
          ? pending.start(creationId, fingerprint, { kind: 'native-create-v1', input, ...(projectFolder ? { projectFolder } : {}),
            selection: model.state === 'ok' ? model.selection : null, label: buildHarnessSessionLabel(engine), local: asker.local }, model.state === 'ok' ? modelHold : launchHold)
          : model.state === 'ok'
          ? pending.start(creationId, fingerprint, { kind: 'model-create-v1', input, selection: model.selection, projectFolder, local: asker.local }, modelHold)
          : receipts.run(creationId, fingerprint, () => executeCreate(input, projectFolder, asker.local, create, true))
        void operation.then(async (status) => {
          reply({ creationId, ...await creationStatusPayload(status) })
        }).catch(() => reply({ error: 'INTERNAL' }))
      } catch (error) {
        reply({ error: error instanceof AgentCreationReceiptError ? error.code : 'INTERNAL' })
      }
      return
    }
    // Clients predating receipts retain their existing response shape.
    const refusal = await validateInstalled(input, installed)
    if (refusal) { reply(refusal); return }
    if (model.state === 'ok') {
      const target = await modelTarget(model.selection).catch(() => null)
      if (!target) { reply({ error: 'GRID_UNAVAILABLE', detail: 'The selected model is unavailable. Choose another model or refresh the list.' }); return }
      input.grid = target
    }
    const result = await onCreateAgent(input)
    // `detail` carries the underlying cause (tmux's own message) so the person who clicked
    // Create can read it, rather than having to open a log on the machine that failed.
    if (!result.ok) {
      reply(result.detail ? { error: result.error, detail: result.detail } : { error: result.error })
      return
    }
    reply({ agent: await toProject(result.session) })
  }

  // Resume attaches or restores a saved conversation; restart replaces a live process in its
  // existing pane. Both keep the agentId and use the same durable operation receipt protocol.
  const relaunch = async (type: string, payload: Record<string, unknown>, reply: Reply): Promise<void> => {
    const target = payload.agentId as string | undefined
    if (!target) { reply({ error: 'MISSING_AGENT_ID' }); return }
    const operation = type === 'agent_resume' ? 'resume' : 'restart'
    const restart = operation === 'resume' ? resumeAgent() : restartAgent()
    if (!restart) { reply({ error: 'UNSUPPORTED_ON_REMOTE' }); return }
    const permissionMode = payload.permissionMode
    if (permissionMode !== undefined && (operation !== 'resume' || typeof permissionMode !== 'string'
      || !['ask', 'auto', 'plan', 'full'].includes(permissionMode))) {
      reply({ error: 'INVALID_PERMISSION_MODE' }); return
    }
    const invoke = () => permissionMode === undefined ? restart(target) : resumeAgent()!(target, permissionMode)
    const creationId = payload.creationId
    if (creationId !== undefined) {
      if (!validCreationId(creationId)) { reply({ error: 'INVALID_CREATION_ID' }); return }
      try {
        void receipts.run(creationId, creationFingerprint({ operation, agentId: target,
          ...(permissionMode === undefined ? {} : { permissionMode }) }), async () => {
          const result = await invoke()
          if (result.ok) return { state: 'created', agentId: result.session.agentId, resumed: result.resumed }
          // RESTART_FAILED can follow an unobserved relaunch. Never silently
          // replace that process again when a caller checks this intent.
          if (result.error === 'RESTART_FAILED' || result.error === 'RESUME_UNCONFIRMED') return { state: 'unconfirmed' }
          return { state: 'failed', error: result.error, ...(result.reason ? { reason: result.reason } : {}),
            ...(result.detail ? { detail: result.detail.slice(0, 2000) } : {}) }
        }).then(async (status) => {
          reply({ creationId, ...await creationStatusPayload(status) })
        }).catch(() => reply({ error: 'INTERNAL' }))
      } catch (error) {
        reply({ error: error instanceof AgentCreationReceiptError ? error.code : 'INTERNAL' })
      }
      return
    }
    const result = await invoke()
    if (!result.ok) {
      reply({ error: result.error, ...(result.reason ? { reason: result.reason } : {}), ...(result.detail ? { detail: result.detail } : {}) })
      return
    }
    reply({ agent: await toProject(result.session), resumed: result.resumed })
  }

  // Fork an agent: a second one with the first one's history — see lib/forkAgent.ts. The reply
  // is agent_create's shape plus `level`, so a client opens the pane the same way.
  const fork = async (payload: Record<string, unknown>, reply: Reply): Promise<void> => {
    const target = payload.agentId as string | undefined
    if (!target) { reply({ error: 'MISSING_AGENT_ID' }); return }
    const onForkAgent = forkAgent()
    if (!onForkAgent) { reply({ error: 'UNSUPPORTED_ON_REMOTE' }); return }
    const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim().slice(0, 120) : null
    const rawPrompt = payload.prompt
    if (rawPrompt !== undefined && rawPrompt !== null && typeof rawPrompt !== 'string') { reply({ error: 'INVALID_PROMPT' }); return }
    const prompt = typeof rawPrompt === 'string' && rawPrompt.trim() ? rawPrompt : null
    if (prompt && prompt.length > MAX_FIRST_PROMPT_CHARS) { reply({ error: 'PROMPT_TOO_LONG' }); return }
    const creationId = payload.creationId
    if (creationId !== undefined) {
      if (!validCreationId(creationId)) { reply({ error: 'INVALID_CREATION_ID' }); return }
      // Forking starts a new process too. Reserve the same durable intent used
      // by agent_create so a lost receipt can be checked without another fork.
      const fork = onForkAgent
      try {
        void receipts.run(creationId, creationFingerprint({ operation: 'fork', agentId: target, name, prompt }), async () => {
          const result = await fork({ agentId: target, name, prompt })
          if (result.ok) return { state: 'created', agentId: result.session.agentId, level: result.level }
          if (result.error === 'SPAWN_FAILED' || result.error === 'REGISTRATION_FAILED') return { state: 'unconfirmed' }
          return { state: 'failed', error: result.error, ...(result.detail ? { detail: result.detail.slice(0, 2000) } : {}) }
        }).then(async (status) => {
          reply({ creationId, ...await creationStatusPayload(status) })
        }).catch(() => reply({ error: 'INTERNAL' }))
      } catch (error) {
        reply({ error: error instanceof AgentCreationReceiptError ? error.code : 'INTERNAL' })
      }
      return
    }
    const result = await onForkAgent({ agentId: target, name, prompt })
    if (!result.ok) {
      reply(result.detail ? { error: result.error, detail: result.detail } : { error: result.error })
      return
    }
    reply({ agent: await toProject(result.session), level: result.level })
  }

  const cancelCreate = async (payload: Record<string, unknown>, asker: Pick<Asker, 'local' | 'guest'>, reply: Reply): Promise<void> => {
    if (!validCreationId(payload.creationId)) { reply({ error: 'INVALID_CREATION_ID' }); return }
    try {
      // A guest cancels nothing of another's, and leaves no cancelled mark for an id that is not its own.
      if (hiddenFrom(asker, payload.creationId)) { reply({ creationId: payload.creationId, state: 'missing' }); return }
      reply({ creationId: payload.creationId, ...await creationStatusPayload(receipts.cancelIntent(payload.creationId)) })
    }
    catch (error) { reply({ error: error instanceof AgentCreationReceiptError ? error.code : 'INTERNAL' }) }
  }

  return { createStatus, cancelCreate, create, relaunch, fork, open: pending.open, stop: pending.stop, recover: pending.recover }
}
