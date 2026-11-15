/**
 * Workspaces in their own process, as the core sees them (`HARNESSD_SERVICES=workspaces`, the edge host by default; the
 * process's side is services/workspacesProcess.ts).
 *
 * Workspaces do git's work for the core, which runs none (the audit of 2026-11-12): the folder a create asks git for (a
 * clone, a worktree, the folder itself on another branch), a harness's worktree read and removed at a purge, and a
 * made-up worktree branch named after its session. The core asks each with a deadline and reads what comes back as typed,
 * bounded data, or as not answered: the process down, slow, or too old to know the question. A process says it makes
 * folders (`folders`) each time it connects; one from before never does, and is asked nothing it would leave unanswered.
 *
 * Branch naming is a command: each terminal-title pass (every few seconds) tells the process to name branches, with the
 * live agents, and one it misses is followed by the next. After a rename the process asks the core to send the agent's
 * frame again (`branchNamed`), and the frame shows the new name now rather than when the core's read of the folder
 * expires.
 */
import { isAbsolute } from 'node:path'
import type { WorkspaceInspection, WorktreeReview } from '../lib/worktreeDeletion.js'
import { safeSshAlias } from '../lib/githubRepository.js'
import { parseScmLaunchRecord } from '../scm/types.js'
import { WORKSPACES_OFF, type CoreApi, type PreparedFolder, type WorkspacesPort, type WorktreeAnswer } from './api.js'
import type { ServiceFrame } from './serviceLinks.js'

type Payload = Record<string, unknown>

/** Tell the workspaces' process something (core/serviceLinks.ts `notify`, for `workspaces`). */
export type NotifyWorkspaces = (frame: ServiceFrame) => boolean
/** Ask it (core/serviceLinks.ts `call`, for `workspaces`): never rejects. */
export type CallWorkspaces = (type: string, payload: Payload, waitMs: number) => Promise<Payload>

/** How long a create waits for its folder. A backstop, never the work's own limit: the process ends a clone that stops
 *  making progress within two minutes and a worktree's checkout within ten (lib/gitProjectFolder.ts, lib/gitProject.ts),
 *  and its process going (killed, or hung and killed by the master's heartbeat watch) answers at once. A clone that keeps
 *  progressing may take long on a slow connection. */
export const PREPARE_FOLDER_MS = 60 * 60_000
/** How long a worktree's review waits: under the 30 s a window gives a purge's review, so it hears why. */
export const WORKTREE_REVIEW_MS = 20_000
/** And its removal: `git worktree remove` gets 30 s in the process, after the review it makes again. */
export const WORKTREE_REMOVE_MS = 45_000

const MAX_PATH = 4096
const path = (value: unknown): value is string =>
  typeof value === 'string' && isAbsolute(value) && value.length <= MAX_PATH && !/[\x00-\x1f\x7f]/.test(value)
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max

/** A folder the process says git made, or why not, held to the shape a create reads. Anything else is not answered. */
export function folderAnswer(answer: Payload): PreparedFolder | null {
  if (path(answer.cwd)) {
    const record = answer.scmLaunchRecord === undefined ? null : parseScmLaunchRecord(answer.scmLaunchRecord)
    const alias = (answer.clonedVia as { alias?: unknown } | undefined)?.alias
    return { ok: true, cwd: answer.cwd, ...(record ? { scmLaunchRecord: record } : {}),
      ...(typeof alias === 'string' && safeSshAlias(alias) ? { clonedVia: { alias } } : {}) }
  }
  if (typeof answer.error !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(answer.error) || answer.error === 'SERVICE_UNAVAILABLE') return null
  return { ok: false, error: answer.error, detail: text(answer.detail, 2000) ? answer.detail : 'Could not prepare the project folder.',
    ...(answer.access === 'denied' ? { access: 'denied' as const } : {}) }
}

const KINDS = new Set(['main', 'worktree', 'folder', 'unavailable'])
/** Where the process says a harness works, held to its shape; null when it is anything else. */
export function inspectionAnswer(answer: Payload): WorkspaceInspection | null {
  const w = answer.workspace as Record<string, unknown> | null | undefined
  if (!w || typeof w !== 'object' || !KINDS.has(w.kind as string) || (w.path !== null && !path(w.path)) || typeof w.canDelete !== 'boolean'
    || !text(w.reason, 2000) || (w.worktreePath !== undefined && !path(w.worktreePath)) || (w.mainPath !== undefined && !path(w.mainPath))) return null
  return { kind: w.kind as WorkspaceInspection['kind'], path: w.path as string | null, canDelete: w.canDelete, reason: w.reason,
    ...(w.worktreePath !== undefined ? { worktreePath: w.worktreePath as string } : {}), ...(w.mainPath !== undefined ? { mainPath: w.mainPath as string } : {}) }
}

/** A review as the process sent it, held to its shape: the core keeps it for the delete it confirms. */
export function reviewAnswer(answer: Payload): WorktreeAnswer | null {
  if (answer.ok === false) return text(answer.reason, 2000) ? { ok: false, reason: answer.reason } : null
  const r = answer.review as Record<string, unknown> | undefined
  if (answer.ok !== true || !r || typeof r !== 'object' || !path(r.path) || !path(r.main) || (r.branch !== null && !text(r.branch, 1024))
    || !text(r.head, 128) || (r.bytes !== null && !Number.isSafeInteger(r.bytes)) || typeof r.dirty !== 'boolean'
    || !Array.isArray(r.changes) || r.changes.length > 12 || !r.changes.every((line) => text(line, MAX_PATH))
    || !text(r.signature, 128) || !Number.isSafeInteger(r.dev) || !Number.isSafeInteger(r.ino)) return null
  const review: WorktreeReview = { path: r.path, main: r.main, branch: r.branch as string | null, head: r.head, bytes: r.bytes as number | null,
    dirty: r.dirty, changes: [...r.changes as string[]], signature: r.signature, dev: r.dev as number, ino: r.ino as number }
  return { ok: true, review }
}

export function createWorkspacesLink(
  core: Pick<CoreApi, 'agents'>,
  notify: NotifyWorkspaces,
  call: CallWorkspaces,
  /** Forget what the core read of a folder's project (lib/agentProject.ts `forgetAgentProject`). */
  forgetProject: (cwd: string) => void,
) {
  /** The process connected now said it makes folders: until it does, it is asked none of it. */
  let folders = false
  const ask = (type: string, payload: Payload, waitMs: number): Promise<Payload> =>
    folders ? call(type, payload, waitMs) : Promise.resolve({ error: 'SERVICE_UNAVAILABLE' })

  const port: WorkspacesPort = {
    nameBranches: () => {
      notify({ type: 'service_event', payload: { kind: 'nameBranches', agents: core.agents.live() } })
    },
    ready: () => folders,
    prepareFolder: async (project, options) =>
      folderAnswer(await ask('prepareFolder', { project, cloneFallback: options.cloneFallback }, PREPARE_FOLDER_MS)) ?? await WORKSPACES_OFF.prepareFolder(project, options),
    describeWorkspace: async (target, others) => inspectionAnswer(await ask('describeWorkspace', { target, others }, WORKTREE_REVIEW_MS)),
    reviewWorktree: async (target, others) =>
      reviewAnswer(await ask('reviewWorktree', { target, others }, WORKTREE_REVIEW_MS)) ?? await WORKSPACES_OFF.reviewWorktree(target, others),
    removeWorktree: async (review, target, others, discardChanges) => {
      const answer = await ask('removeWorktree', { review, target, others, discardChanges }, WORKTREE_REMOVE_MS)
      if (answer.ok === true) return { ok: true }
      return answer.ok === false && text(answer.reason, 2000) ? { ok: false, reason: answer.reason }
        : await WORKSPACES_OFF.removeWorktree(review, target, others, discardChanges)
    },
  }

  /** The process renamed an agent's branch: its frame goes out again, read fresh. */
  const branchNamed = (payload: Payload): Payload => {
    const session = typeof payload.agentId === 'string' ? core.agents.byAgent(payload.agentId) : undefined
    if (!session) return { synced: false }
    if (session.cwd) forgetProject(session.cwd)
    core.agents.sync(session)
    return { synced: true }
  }

  return {
    port,
    /** The core's answers to the workspaces' questions (core/serviceLinks.ts `answer`, for `workspaces`). */
    answer(query: string, payload: Payload): Payload {
      if (query === 'branchNamed') return branchNamed(payload)
      if (query === 'folders') { folders = true; return { ok: true } }
      return { error: 'UNKNOWN_QUERY' }
    },
    /** The process's connection ended: the next one says again whether it makes folders. */
    disconnected(): void { folders = false },
  }
}

export type WorkspacesLink = ReturnType<typeof createWorkspacesLink>
