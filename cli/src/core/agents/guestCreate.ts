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
import type { createPaneWatcher } from './newPane.js'

export type GuestCreateResult =
  | { ok: true; session: RegisteredSession }
  | { ok: false; error: string; detail?: string }

export interface GuestCreateDeps {
  launch: (input: GuestLaunchInput) => Promise<GuestLaunch>
  /** The tmux backend; null where the configuration lists no tmux. */
  tmuxBackend: () => CreateAgentPaneDeps['tmuxBackend'] | null
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
  return async (payload: Record<string, unknown>, guest: string): Promise<GuestCreateResult> => {
    for (const [key, detail] of NOT_FOR_GUESTS) {
      const value = payload[key]
      if (value !== undefined && value !== null && value !== '') return { ok: false, error: 'GUEST_UNSUPPORTED', detail }
    }
    const tmuxBackend = deps.tmuxBackend()
    if (!tmuxBackend) return { ok: false, error: 'TMUX_UNAVAILABLE' }
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
    // A folder the owner shares, to start in (shared machines checks it is shared; the helper, that it may be).
    const cwd = typeof payload.cwd === 'string' && payload.cwd.startsWith('/') ? payload.cwd : null
    const launch = await deps.launch({ email: guest, engine, bypassPermission, permissionFlags: [...permissionFlags],
      ...(prompt ? { prompt } : {}), ...(cwd ? { cwd } : {}) })
    if (!launch.ok) return { ok: false, error: launch.error, ...(launch.detail ? { detail: launch.detail } : {}) }
    const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim().slice(0, 120) : null
    const label = buildHarnessSessionLabel(engine as AgentEngine)
    const result = await createAndRegisterPane({
      tmuxBackend,
      registry: deps.registry,
      engine: engine as AgentEngine,
      cwd: launch.workspace,
      // The owner's tmux starts the pane: in a folder the owner may enter (the guest's home gives the owner a
      // read ACL). The helper changes to the workspace as the guest.
      spawnCwd: launch.workspace,
      sessionLabel: label,
      argv: launch.argv,
      env: launch.env,
      bypassPermission,
      permissionMode,
      defaultName: name,
      guest,
    })
    if (!result.ok) return { ok: false, error: result.error, detail: result.detail }
    deps.announceSession(result.pending)
    // No install here: the pane installs a missing engine for the guest itself (lib/guestPaneCommand.ts).
    void deps.watchNewPane(engine as AgentEngine, result.pending, result.spawned, launch.argv, undefined)
    console.log(`[agent] create guest pane open · ${engine} · agent ${result.pending.agentId}`)
    return { ok: true, session: result.pending }
  }
}

export type GuestCreate = ReturnType<typeof createGuestCreate>
