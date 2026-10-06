/**
 * The project and folder readers: an agent's branch and pull request, a project's repository and preview,
 * a folder's subfolders for the New Agent browser, and media from an agent's project. Each reads the disk
 * or runs git, so it is answered when it settles, never in the connection's line. Moved out of the
 * socket's switch as they were (docs/design/2026-10-06-core-boundary-next.md, step 4).
 */
import type { CoreApi, ServiceRequests } from '../core/api.js'
import { listDir } from '../lib/fsBrowse.js'
import { readGitProject } from '../lib/gitProject.js'
import { MediaPreviewError, readMediaPreviewChunk } from '../lib/mediaPreview.js'
import { projectPreview } from '../lib/projectPreview.js'
import { readSessionGitPullRequest, type ExpectedGitContext } from '../lib/sessionGitPullRequest.js'
import { internalOnThrow } from './requestErrors.js'

/** The requests the project readers answer for the apps, declared in core/api.ts for the core to route. */
export { PROJECTS_REQUESTS } from '../core/api.js'

export function startProjects(core: CoreApi): ServiceRequests {
  /** The browsable home, widened by the folders agents are running in: a repository outside both is not
   *  somewhere this daemon runs git. */
  const knownRoots = (): string[] => core.agents.live().flatMap((agent) => agent.cwd ? [agent.cwd] : [])
  return {
    git_pull_request: internalOnThrow('git_pull_request', (payload) => {
      const id = payload.agentId
      const agent = typeof id === 'string' ? core.agents.resolve(id) : undefined
      if (!agent?.cwd) return { status: 'unavailable' }
      const requested = payload.context
      if (requested !== undefined && (!requested || typeof requested !== 'object'
        || typeof (requested as Record<string, unknown>).cwd !== 'string'
        || typeof (requested as Record<string, unknown>).branch !== 'string'
        || (requested as Record<string, unknown>).remote !== null && typeof (requested as Record<string, unknown>).remote !== 'string')) {
        return { status: 'unavailable' }
      }
      return readSessionGitPullRequest(agent, {
        expected: requested as ExpectedGitContext | undefined,
        history: payload.history === true, offset: typeof payload.offset === 'number' ? payload.offset : undefined,
      }).then((result) => result, () => ({ status: 'unavailable' }))
    }),

    git_project_info: internalOnThrow('git_project_info', (payload) => {
      const path = typeof payload.path === 'string' ? payload.path : ''
      return readGitProject(path, { refresh: payload.refresh === true, knownRoots: knownRoots() })
        .then((result) => result, () => ({ error: 'UNAVAILABLE' }))
    }),

    project_preview: internalOnThrow('project_preview', (payload) => {
      const path = typeof payload.path === 'string' ? payload.path : ''
      return projectPreview(path, knownRoots()).then((result) => result, () => ({ error: 'UNAVAILABLE' }))
    }),

    // One-level remote directory listing for the New Agent folder browser.
    fs_list_dir: internalOnThrow('fs_list_dir', (payload) => {
      const path = typeof payload.path === 'string' ? payload.path : ''
      const result = listDir(path)
      if ('error' in result) return { error: result.error }
      return { ...result }
    }),

    // Media previews, in bounded binary chunks. The text mode this request also used to serve was read by
    // nothing — every client has always asked with `media: true` — so it is gone rather than carrying a
    // second, laxer file reader (lib/mediaPreview.ts).
    agent_read_file: internalOnThrow('agent_read_file', async (payload) => {
      const projectId = payload.agentId as string | undefined
      const path = payload.path as string | undefined
      if (!projectId || !path) return { error: 'MISSING_AGENT_OR_PATH' }
      if (payload.media !== true) return { error: 'UNSUPPORTED', detail: 'agent_read_file serves media previews only' }
      const s = core.agents.resolve(projectId)
      if (!s?.cwd) return { error: 'AGENT_NOT_FOUND' }
      try {
        return { ...await readMediaPreviewChunk(s.cwd, path, payload.offset, payload.revision) }
      } catch (error) {
        return { error: error instanceof MediaPreviewError ? error.message : 'MEDIA_READ_FAILED' }
      }
    }),
  }
}
