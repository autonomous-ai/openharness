/**
 * A guest's New Harness (docs/plans/2026-10-19-guest-machine-sharing-plan.md): the engine run as the
 * guest's own OS user, in the guest's workspace, on the owner's subscription. Shared machines builds the
 * launch (core/api.ts `SharedMachinesCorePort.guestLaunch`: the account, a relay token, the pane's command);
 * the core opens the pane as any other and records whose it is (registry `guest`), which is what lets the
 * guest, and only the guest, list it and reach it (core/guestPolicy.ts).
 *
 * The guest gets its workspace, the folders the owner shares and its engine, and nothing else: a folder in the
 * request is where it starts only when the owner shares it, and what would run the owner's way — a harness from the Store, a
 * conversation to resume, an engine's named agent — is refused before anything starts, rather than
 * half-applied. A first message goes to the engine as its first prompt. A grid or a saved API never reaches here (the policy refuses it).
 */
import type { GuestLaunch, GuestLaunchInput } from '../api.js'
import type { AgentEngine } from '../../engines/types.js'
import { createAndRegisterPane, type CreateAgentPaneDeps } from '../../lib/createAgentPane.js'
import { MAX_FIRST_PROMPT_CHARS, permissionModeApproves, permissionModeFlags } from '../../lib/engineLaunch.js'
import { DEFAULT_HARNESS_PERMISSION } from '../../lib/harnessDefaults.js'
import { buildHarnessSessionLabel } from '../../lib/harnessSessionLabel.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { windowsAfterExit } from '../../lib/windows/engineStart.js'
import { ensureGuestEngine, guestNodeDir, type GuestEngineBackend, type GuestEngineResult } from '../../lib/windows/guestEngine.js'
import { guestHostHome, WINDOWS_GUEST_SETUP_VERSION } from '../../lib/windows/guestRequests.js'
import { windowsEngineArgv, windowsLaunchRefusal } from '../../lib/windows/launch.js'
import type { createPaneWatcher } from './newPane.js'

export type GuestCreateResult =
  | { ok: true; session: RegisteredSession }
  | { ok: false; error: string; detail?: string }

export interface GuestCreateDeps {
  launch: (input: GuestLaunchInput) => Promise<GuestLaunch>
  /** The tmux backend; null where the configuration lists no tmux. */
  tmuxBackend: () => CreateAgentPaneDeps['tmuxBackend'] | null
  /** The pane backend of a guest's own host, for a launch that must not be made by this account (Windows: the
   *  guest's `harness-pty` host, lib/windows/guestHostBackend.ts); absent where the platform has no such host.
   *  Resolves null when that host cannot be reached: the owner's backend is never a fallback. */
  guestBackend?: (user: string) => Promise<(CreateAgentPaneDeps['tmuxBackend'] & GuestEngineBackend) | null>
    | (CreateAgentPaneDeps['tmuxBackend'] & GuestEngineBackend) | null
  /** Makes sure the guest's engine is installed for its account first (Windows: lib/windows/guestEngine.ts); a seam
   *  for tests. Only called for a launch on a guest's own host. */
  ensureEngine?: (backend: GuestEngineBackend, options: { user: string; engine: string; cwd: string; prefix: string }) => Promise<GuestEngineResult>
  /** The engine's argv as this machine runs it, from the guest's own engines folder (Windows resolves the npm shim
   *  there, lib/windows/launch.ts); a seam for tests. */
  resolveEngine?: (engine: string, argv: readonly string[], prefix: string) => string[]
  registry: CreateAgentPaneDeps['registry']
  announceSession: (session: RegisteredSession) => void
  watchNewPane: ReturnType<typeof createPaneWatcher>
}

/** What a guest's New Harness may not ask for, each with why. */
const NOT_FOR_GUESTS: ReadonlyArray<readonly [string, string]> = [
  ['dsh', 'On a computer shared with you, you can start Claude Code or Codex, not harnesses from the Store.'],
  ['resumeSessionId', 'On a computer shared with you, start a new conversation.'],
  ['agent', 'On a computer shared with you, start Claude Code or Codex itself, not a named agent.'],
]

export function createGuestCreate(deps: GuestCreateDeps) {
  /** One install per guest and engine at a time: two panes running npm at once fight over the same prefix. */
  const installing = new Map<string, Promise<GuestEngineResult>>()
  const installOnce = (key: string, run: () => Promise<GuestEngineResult>): Promise<GuestEngineResult> => {
    const at = installing.get(key)
    if (at) return at
    const pending = run().finally(() => { installing.delete(key) })
    installing.set(key, pending)
    return pending
  }
  const ensureEngine = deps.ensureEngine ?? ((backend, options) => ensureGuestEngine(backend, {
    ...options, setupVersion: WINDOWS_GUEST_SETUP_VERSION, log: (line) => console.log(`[guest] ${line}`),
  }))
  const resolveEngine = deps.resolveEngine ?? ((engine, argv, prefix) => windowsEngineArgv(engine, argv, {
    environment: { PATH: `${prefix};${guestNodeDir(WINDOWS_GUEST_SETUP_VERSION)}` },
  }))
  return async (payload: Record<string, unknown>, guest: string): Promise<GuestCreateResult> => {
    for (const [key, detail] of NOT_FOR_GUESTS) {
      const value = payload[key]
      if (value !== undefined && value !== null && value !== '') return { ok: false, error: 'GUEST_UNSUPPORTED', detail }
    }
    const engine = typeof payload.engine === 'string' ? payload.engine : ''
    // The mode the guest chose, with the engine's own flags for it, as an owner's launch has (Auto-approve is the
    // engine's auto mode, never Skip all checks). A client that predates the choice sends only `bypassPermission`.
    const permissionMode = typeof payload.permissionMode === 'string' ? payload.permissionMode
      : payload.bypassPermission === false ? 'ask' : DEFAULT_HARNESS_PERMISSION
    const permissionFlags = permissionModeFlags(engine as AgentEngine, permissionMode)
    if (!permissionFlags) return { ok: false, error: 'INVALID_PERMISSION_MODE', detail: `${engine} has no permission mode ${JSON.stringify(permissionMode)}` }
    const bypassPermission = permissionModeApproves(permissionMode)
    // A first message, bounded as the owner's are (core/agents/launches.ts).
    if (payload.prompt !== undefined && payload.prompt !== null && typeof payload.prompt !== 'string') {
      return { ok: false, error: 'INVALID_PROMPT', detail: 'prompt must be a string' }
    }
    const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : ''
    if (prompt.length > MAX_FIRST_PROMPT_CHARS) {
      return { ok: false, error: 'PROMPT_TOO_LONG', detail: `prompt is longer than ${MAX_FIRST_PROMPT_CHARS} characters` }
    }
    // A folder the owner shares, to start in (shared machines checks it is shared; the helper, that it may be). Both
    // platforms' absolute forms: `/Users/...` and `C:\Users\...`.
    const cwd = typeof payload.cwd === 'string' && payload.cwd.trim() ? payload.cwd : null
    const launch = await deps.launch({ email: guest, engine, bypassPermission, permissionFlags: [...permissionFlags],
      ...(prompt ? { prompt } : {}), ...(cwd ? { cwd } : {}) })
    if (!launch.ok) return { ok: false, error: launch.error, ...(launch.detail ? { detail: launch.detail } : {}) }
    // Where the pane must be made by the guest's own host (Windows), never by this account: the owner's tmux or
    // pty host has no pane there, and a fallback to it would run the guest's harness as the owner.
    let backend: CreateAgentPaneDeps['tmuxBackend'] | null
    // The engine's argv as the pane runs it. On Windows it is resolved after the install, from the guest's own
    // engines folder, exactly as the owner's is from its PATH (lib/windows/launch.ts `windowsEngineArgv`):
    // an npm shim becomes its program or node script, so no argument is ever read by cmd.exe.
    let argv = launch.argv
    const hostUser = launch.guestHostUser
    if (hostUser) {
      const host = await deps.guestBackend?.(hostUser) ?? null
      if (!host) {
        return { ok: false, error: 'GUEST_HOST_UNAVAILABLE',
          detail: 'The guest\'s own terminal host is not running on this computer. Turn sharing on again for it.' }
      }
      const prefix = `${guestHostHome(hostUser)}\\engines`
      // The engine must be installed for that account, as the guest: a new Windows account has neither, and its
      // profile is not the owner's (lib/windows/guestEngine.ts, the macOS helper's `install` on this platform).
      const ready = await installOnce(`${hostUser}:${engine}`,
        () => ensureEngine(host, { user: hostUser, engine, cwd: launch.workspace, prefix }))
      if (!ready.ok) return { ok: false, error: ready.error, detail: ready.detail }
      try {
        argv = resolveEngine(engine, launch.argv, prefix)
      } catch (error) {
        const refused = windowsLaunchRefusal(error)
        return { ok: false, error: refused.error, detail: refused.detail }
      }
      backend = host
    } else {
      backend = deps.tmuxBackend()
      if (!backend) return { ok: false, error: 'TMUX_UNAVAILABLE' }
    }
    const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim().slice(0, 120) : null
    const label = buildHarnessSessionLabel(engine as AgentEngine)
    const result = await createAndRegisterPane({
      tmuxBackend: backend,
      registry: deps.registry,
      engine: engine as AgentEngine,
      cwd: launch.workspace,
      // The owner's tmux starts the pane: in a folder the owner may enter (the guest's home gives the owner a
      // read ACL). The helper changes to the workspace as the guest.
      spawnCwd: launch.workspace,
      // Windows: the guest's host makes the pane in the workspace; when the engine exits it becomes the guest's
      // shell, as an owner's pane does. Nothing of this account's environment goes in (no `windowsPaneLaunch`:
      // its PATH is the owner's, which the guest may not read).
      ...(launch.guestHostUser ? { paneLaunch: { cwd: launch.workspace, afterExit: windowsAfterExit(engine) } } : {}),
      sessionLabel: label,
      argv,
      env: launch.env,
      bypassPermission,
      permissionMode,
      defaultName: name,
      guest,
    })
    if (!result.ok) return { ok: false, error: result.error, detail: result.detail }
    deps.announceSession(result.pending)
    // The engine is installed before the pane opens (Windows); on macOS the pane's own bootstrap installs it.
    void deps.watchNewPane(engine as AgentEngine, result.pending, result.spawned, argv, undefined)
    console.log(`[agent] create guest pane open · ${engine} · agent ${result.pending.agentId}`)
    return { ok: true, session: result.pending }
  }
}

export type GuestCreate = ReturnType<typeof createGuestCreate>
