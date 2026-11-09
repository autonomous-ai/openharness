/**
 * The project and folder readers: an agent's branch and pull request, a project's repository and preview,
 * a folder's subfolders for the New Agent browser, media from an agent's project, and an agent's instructions
 * file. Each reads the disk or runs git, so it is answered when it settles, never in the connection's line.
 * Moved out of the socket's switch as they were (docs/design/2026-10-06-core-boundary-next.md, step 4).
 */
import type { Asker, CoreApi, ServiceRequest, ServiceRequests } from '../core/api.js'
import { InstructionsError, readInstructions, readSharedInstructions, writeInstructions } from '../lib/agentInstructions.js'
import { createPullRequestsStatusReader } from '../lib/pullRequestsStatus.js'
import { listDir } from '../lib/fsBrowse.js'
import { readGitProject } from '../lib/gitProject.js'
import { MediaPreviewError, readMediaPreviewChunk } from '../lib/mediaPreview.js'
import { projectPreview } from '../lib/projectPreview.js'
import { readSessionGitPullRequest, type ExpectedGitContext } from '../lib/sessionGitPullRequest.js'
import { detectScmProject } from '../scm/scmProjects.js'
import { internalOnThrow } from './requestErrors.js'

/** The requests the project readers answer for the apps, declared in core/api.ts for the core to route. */
export { PROJECTS_REQUESTS } from '../core/api.js'

/** What a failure is called in a log line: its code (the disk's, or an instructions refusal's), or `unknown` for one without,
 *  which may be a rejection with nothing in it. Never its message, which names the person's folder. */
const codeOf = (error: unknown): string => (error as NodeJS.ErrnoException | null | undefined)?.code ?? 'unknown'

/** A trusted collaborator may use terminals here, but must not borrow this computer's GitHub account, nor read or save
 *  its agents' files. Only a process on this computer, or one of the owner's own computers, may. */
const accountOwnerOnly = (asker: Asker): boolean => asker.owner && (asker.local || asker.accountOwner === true)

export function startProjects(core: CoreApi): ServiceRequests {
  /** The browsable home, widened by the folders agents are running in: a repository outside both is not
   *  somewhere this daemon runs git. */
  const knownRoots = (): string[] => core.agents.live().flatMap((agent) => agent.cwd ? [agent.cwd] : [])
  const readPullRequests = createPullRequestsStatusReader()
  /** What else instructs an agent, as it goes with a read of its instructions: the files its engines load that are shown, and
   *  those that are there and are not, with why, each with where it is and which engines load it. What went wrong with one, where
   *  it is the file's or the disk's, is logged by where it is from the agent's folder and a code and never what: the answer says
   *  only why. Each key is there only when it has something. */
  const projectFiles = async (cwd: string): Promise<Record<string, unknown>> => {
    const { shared, skipped } = await readSharedInstructions(cwd)
    for (const one of skipped) if ('error' in one) console.error(`[projects] agent_instructions_read left out ${one.path} · ${codeOf(one.error)}`)
    return {
      ...(shared.length ? { shared } : {}),
      ...(skipped.length ? { skipped: skipped.map(({ name, path, loadedBy, why }) => ({ name, path, loadedBy, why })) } : {}),
    }
  }
  /** One of the instructions file's two requests, for an agent in a folder here. A refusal that is the person's own
   *  mistake (a stale version, a bad name) is the reply and no more. A file that is not text is logged by that name, and a
   *  failure of the disk by its code, and answered [failed]: its message names the person's folder. [beside] is asked first,
   *  and what it gives comes with the answer, an error included: the agent's own file failing does not hide the rest. */
  const instructions = (
    type: string, failed: string, run: (cwd: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>,
    beside?: (cwd: string) => Promise<Record<string, unknown>>,
  ): ServiceRequest =>
    internalOnThrow(type, async (payload, asker) => {
      if (!accountOwnerOnly(asker)) return { error: 'OWNER_REQUIRED' }
      const { agentId, name } = payload
      if (typeof agentId !== 'string' || !agentId || typeof name !== 'string' || !name) return { error: 'MISSING_AGENT_OR_NAME' }
      const cwd = core.agents.resolve(agentId)?.cwd
      if (!cwd) return { error: 'AGENT_NOT_FOUND' }
      const also = await beside?.(cwd)
      try {
        return { ...await run(cwd, payload), ...also }
      } catch (error) {
        const refusal = error instanceof InstructionsError ? error.code : undefined
        if (refusal && refusal !== 'NOT_UTF8') return { error: refusal, ...also }
        console.error(`[projects] ${type} failed · ${refusal ?? codeOf(error)}`)
        return { error: refusal ?? failed, ...also }
      }
    })
  return {
    git_pull_requests_status: internalOnThrow('git_pull_requests_status', (payload, asker) => {
      if (!accountOwnerOnly(asker)) return { error: 'OWNER_REQUIRED' }
      return readPullRequests(payload.urls)
    }),
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
        usage: () => core.usage?.(agent) ?? Promise.resolve(null),
        expected: requested as ExpectedGitContext | undefined,
        history: payload.history === true, offset: typeof payload.offset === 'number' ? payload.offset : undefined,
      }).then((result) => result, () => ({ status: 'unavailable' }))
    }),

    git_project_info: internalOnThrow('git_project_info', (payload) => {
      const path = typeof payload.path === 'string' ? payload.path : ''
      return readGitProject(path, { refresh: payload.refresh === true, knownRoots: knownRoots() })
        .then((result) => result, () => ({ error: 'UNAVAILABLE' }))
    }),

    // The same probe through the SCM seam, answering `{kind, git?, error?}`. Beside `git_project_info`,
    // not in its place: an older client keeps asking the old question and gets the old answer. Same
    // fence and refresh as above.
    scm_project_info: internalOnThrow('scm_project_info', (payload) => {
      const path = typeof payload.path === 'string' ? payload.path : ''
      return detectScmProject(path, { refresh: payload.refresh === true, knownRoots: knownRoots() })
        .then((result) => result, () => ({ kind: 'none', error: 'UNAVAILABLE' }))
    }),

    project_preview: internalOnThrow('project_preview', (payload) => {
      const path = typeof payload.path === 'string' ? payload.path : ''
      return projectPreview(path, knownRoots()).then((result) => result, () => ({ error: 'UNAVAILABLE' }))
    }),

    // One-level remote directory listing for the New Agent folder browser.
    fs_list_dir: internalOnThrow('fs_list_dir', async (payload) => {
      const path = typeof payload.path === 'string' ? payload.path : ''
      const result = await listDir(path)
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

    // An agent's instructions file, in the folder it works in on this computer (lib/agentInstructions.ts). The owner's
    // other computers read and save it here, so it is never in git or on our servers: the one copy is this one. A read also
    // carries what else instructs the agent, the files its engines load (AGENTS.md and CLAUDE.md in its folder and what Claude
    // Code and Codex read besides, above it too), as `shared`, and those that are there and not shown, with why, as `skipped`:
    // each only when there is any, read only, for an agent with no file of its own too, beside an error of its own file too, and a
    // reader that predates them never looks at the fields.
    agent_instructions_read: instructions('agent_instructions_read', 'READ_FAILED', (cwd, { name }) => readInstructions(cwd, name), projectFiles),
    agent_instructions_write: instructions('agent_instructions_write', 'WRITE_FAILED', (cwd, { name, text, version }) => writeInstructions(cwd, name, text, version)),
  }
}
