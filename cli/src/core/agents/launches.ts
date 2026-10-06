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
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute } from 'node:path'
import type { BackendSocket } from '../../backendSocket.js'
import { installedDsh } from '../../dsh/installed.js'
import { DSH_ID_RE, dshSupportedEngines } from '../../dsh/manifest.js'
import { opencodeMajorVersion } from '../../engines/opencode/version.js'
import { ENGINES, isTerminalEngine, type AgentEngine } from '../../engines/types.js'
import { AgentCreationReceiptError, creationFingerprint, validCreationId, type AgentCreationReceipts, type AgentCreationStatus } from '../../lib/agentCreationReceipt.js'
import type { AgentFrame } from '../../lib/agentFrame.js'
import { engineLabel } from '../../lib/agentNames.js'
import { claudeTrusts, codexTrusts, preTrustClaudeProject, preTrustCodexProject } from '../../lib/claudeTrust.js'
import {
  AGENT_NAME_RE, FirstPromptUnsupportedError, MAX_FIRST_PROMPT_CHARS, NamedAgentUnsupportedError, permissionModeApproves,
  permissionModeFlags, supportsFirstPrompt, supportsNamedAgent,
} from '../../lib/engineLaunch.js'
import { parseGridLaunchOverride, type GridLaunchOverride } from '../../lib/gridLaunch.js'
import { parseNewAgentModel, type NewAgentModel } from '../../lib/newAgentModel.js'
import { parseProjectFolder, prepareProjectFolder, projectsRoot, ProjectFolderError } from '../../lib/projectFolder.js'
import type { RegisteredSession } from '../../lib/registry.js'

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
  | { ok: false; error: string; detail?: string }
>
/** Resumes stopped work directly, or attaches if it is already running. Never replaces a live process
 *  and never falls back to a fresh conversation (core/agents/lifecycle.ts). */
export type ResumeAgent = (agentId: string, permissionMode?: string) => ReturnType<RestartAgent>

export interface LaunchRequestDeps {
  /** The receipts of launches asked for with a `creationId`. */
  receipts: Pick<AgentCreationReceipts, 'run' | 'status'>
  /** Each launch, read when a request comes in: null on a machine that cannot launch agents. */
  createAgent: () => CreateAgent | null
  forkAgent: () => ForkAgent | null
  resumeAgent: () => ResumeAgent | null
  restartAgent: () => RestartAgent | null
  byAgent: (agentId: string) => RegisteredSession | undefined
  /** An agent's frame, as the socket builds it for every reply. */
  toProject: (s: RegisteredSession) => Promise<AgentFrame>
  /** Where a new agent on a grid model sends its inference: the models service's to resolve, on this
   *  machine (core/api.ts `ModelsPort.launchTarget`). Null, or a rejection while models is down, refuses
   *  the create with GRID_UNAVAILABLE rather than start it anywhere else. */
  modelTarget: (selection: NewAgentModel) => Promise<GridLaunchOverride | null>
}

type Reply = (result: Record<string, unknown>) => void

export function createLaunchRequests({ receipts, createAgent, forkAgent, resumeAgent, restartAgent, byAgent, toProject, modelTarget }: LaunchRequestDeps) {
  /** Recover by stable runtime identity; a deleted agent must never become a fresh launch. */
  const creationStatusPayload = async (status: AgentCreationStatus): Promise<Record<string, unknown>> => {
    if (status.state === 'created') {
      const session = byAgent(status.agentId)
      return session
        ? { state: 'created', agent: await toProject(session), ...(status.level ? { level: status.level } : {}), ...(status.resumed !== undefined ? { resumed: status.resumed } : {}) }
        : { state: 'unavailable' }
    }
    // A recorded refusal is a completed outcome. Keep it separate from transport/dispatch errors
    // so clients can distinguish "safe to correct the choices" from "outcome still unknown".
    if (status.state === 'failed') {
      return { state: 'failed', ...(status.preparedFolder ? { preparedFolder: status.preparedFolder } : {}), failure: { code: status.error, ...(status.detail ? { detail: status.detail } : {}) } }
    }
    return status
  }

  /** Answers `agent_create_status`: what became of the launch a `creationId` names. */
  const createStatus = async (payload: Record<string, unknown>, reply: Reply): Promise<void> => {
    const creationId = payload.creationId
    if (!validCreationId(creationId)) { reply({ error: 'INVALID_CREATION_ID' }); return }
    try {
      reply({ creationId, ...await creationStatusPayload(receipts.status(creationId)) })
    } catch (error) {
      reply({ error: error instanceof AgentCreationReceiptError ? error.code : 'INTERNAL' })
    }
  }

  /** Answers `agent_create`. `asker.local` says the frame came from this machine. */
  const create = async (payload: Record<string, unknown>, asker: { local: boolean }, reply: Reply): Promise<void> => {
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
    if (payload.dsh !== undefined && payload.dsh !== null) {
      if (typeof payload.dsh !== 'string' || !DSH_ID_RE.test(payload.dsh)) {
        reply({ error: 'INVALID_DSH', detail: 'dsh must be an owner/name id' }); return
      }
      const installed = installedDsh(payload.dsh)
      if (!installed) {
        reply({ error: 'INVALID_DSH', detail: `${payload.dsh} is not installed on this machine` }); return
      }
      if (installed.manifest.kind === 'viewer') {
        reply({ error: 'INVALID_DSH', detail: `${payload.dsh} is a viewer package, not an agent` }); return
      }
      if (!dshSupportedEngines(installed.manifest).includes(engine)) {
        reply({ error: 'INVALID_DSH', detail: `${payload.dsh} supports ${dshSupportedEngines(installed.manifest).join(', ')}; ${engine} is not compatible` }); return
      }
      dsh = installed.id
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
      // OpenCode v2 counts as no way: its TUI exits 1 on `--agent` (engineLaunch.ts).
      if (!supportsNamedAgent(engine, engine === 'opencode' ? opencodeMajorVersion() : null)) {
        reply({ error: 'AGENT_UNSUPPORTED', detail: new NamedAgentUnsupportedError(engine).message }); return
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
      if (terminal || projectFolder || grid.state === 'ok' || model.state === 'ok' || dsh || prompt || agent) {
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
      const create = onCreateAgent
      try {
        void receipts.run(creationId, creationFingerprint(projectFolder ? { ...fingerprintInput, projectFolder } : fingerprintInput), async () => {
          if (model.state === 'ok') {
            const target = await modelTarget(model.selection).catch(() => null)
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
              // A Codex agent on its own profile reads its trust from that profile's config.toml, not ~/.codex.
              const engineTrust = input.engine === 'claude' ? { trusts: (path: string) => claudeTrusts(path), record: (path: string) => preTrustClaudeProject(path) }
                : input.engine === 'codex' ? { trusts: (path: string) => codexTrusts(path, input.codexHome), record: (path: string) => preTrustCodexProject(path, input.codexHome) } : null
              if (engineTrust && (projectFolder.source === 'new'
                || (projectFolder.source === 'worktree' && engineTrust.trusts(projectFolder.gitSource)))) {
                engineTrust.record(preparedFolder)
              }
            } catch (error) { console.warn(`[agent] pre-trust ${preparedFolder} · ${error instanceof Error ? error.message : error}`) }
          } else if (!dsh && asker.local && dirname(input.cwd) === projectsRoot()) {
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
                if (input.engine === 'codex') preTrustCodexProject(input.cwd, input.codexHome)
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
          reply({ creationId, ...await creationStatusPayload(status) })
        }).catch(() => reply({ error: 'INTERNAL' }))
      } catch (error) {
        reply({ error: error instanceof AgentCreationReceiptError ? error.code : 'INTERNAL' })
      }
      return
    }
    // Clients predating receipts retain their existing response shape.
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
          return { state: 'failed', error: result.error, ...(result.detail ? { detail: result.detail.slice(0, 2000) } : {}) }
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
      reply(result.detail ? { error: result.error, detail: result.detail } : { error: result.error })
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

  return { createStatus, create, relaunch, fork }
}
