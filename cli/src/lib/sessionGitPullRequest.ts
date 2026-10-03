import type { RegisteredSession } from './registry.js'
import { agentProject, forgetAgentProject } from './agentProject.js'
import { agentTokenUsage } from './agentTokenUsage.js'
import { sessionGitContext } from './sessionGitContext.js'
import { sessionGitHistory } from './sessionGitHistory.js'
import { readBranchPullRequest, readGitPullRequest, readPullRequestUrl } from './gitPullRequest.js'

export type ExpectedGitContext = { cwd: string; branch: string; remote: string | null }
/** The branch badge and session history share the same resolved checkout. Existing callers may
 * omit expected context; new clients bind their reply to the branch they displayed when asking. */
export async function readSessionGitPullRequest(agent: RegisteredSession, options: {
  expected?: ExpectedGitContext; history?: boolean; offset?: number;
} = {}) {
  const work = agentTokenUsage.get(agent)?.work
  const resolve = async (observed = work) => {
    const saved = await sessionGitHistory.get(agent)
    if (options.history) for (const cwd of [agent.cwd, ...saved.branches.map(b => b.cwd), ...(observed?.current.map(b => b.cwd) ?? [])]) {
      if (cwd) forgetAgentProject(cwd)
    }
    return sessionGitContext(await agentProject(agent.cwd), observed, undefined, saved)
  }
  let context = await resolve()
  await sessionGitHistory.observe(agent, context)
  const current = context.recentWork?.project ?? context.current
  let identity = current?.branch ? { cwd: current.cwd, branch: current.branch, remote: current.remote } : null
  const matches = !options.expected || identity && options.expected.cwd === identity.cwd
    && options.expected.branch === identity.branch && options.expected.remote === identity.remote
  let result = matches && current && !current.branch?.startsWith('Detached ')
    ? identity ? await readGitPullRequest(current.cwd, identity) : await readGitPullRequest(current.cwd)
    : { status: 'unavailable' as const }
  const checkedAt = new Date().toISOString()
  if (result.status === 'found') for (const pr of [result, ...(result.related ?? [])]) {
    const { related: _, ...recorded } = pr
    await sessionGitHistory.recordPullRequest(agent,
      { url: pr.url, cwd: current!.cwd, at: context.observedAt ?? checkedAt }, recorded, pr.checkedAt ?? checkedAt)
  }
  const refreshMovedWork = async () => {
    const latest = agentTokenUsage.get(agent)?.work
    if (JSON.stringify(latest) === JSON.stringify(work)) return
    context = await resolve(latest)
    await sessionGitHistory.observe(agent, context)
    const project = context.recentWork?.project ?? context.current
    identity = project?.branch ? { cwd: project.cwd, branch: project.branch, remote: project.remote } : null
    result = { status: 'unavailable' }
  }
  if (!options.history) {
    await refreshMovedWork()
    return options.expected ? { ...result, context: identity } : result
  }

  const offset = Number.isSafeInteger(options.offset) && options.offset! >= 0 ? Math.min(options.offset!, 128) : 0
  // Saved branch identities belong to this session and survive checkout changes. Query a
  // bounded page, including branches whose PR was never printed in any engine's transcript.
  const branches = [...new Map((await sessionGitHistory.get(agent)).branches.map(branch =>
    [JSON.stringify([branch.remote ?? branch.cwd, branch.branch]), branch])).values()]
  await Promise.all(branches.slice(offset, offset + 4).map(async project => {
    const found = await readBranchPullRequest({ branch: project.branch, remote: project.remote })
    if (found.status === 'found') for (const pr of [found, ...(found.related ?? [])]) {
      const { related: _, ...recorded } = pr
      await sessionGitHistory.recordPullRequest(agent, { url: pr.url, cwd: project.cwd, at: checkedAt },
        recorded, pr.checkedAt ?? checkedAt)
    }
  }))

  const saved = await sessionGitHistory.get(agent)
  const page = saved.pullRequests.slice(offset, offset + 4)
  const lookups = await Promise.all(page.map(async pr => {
    const answer = await readPullRequestUrl(pr.url)
    await sessionGitHistory.recordPullRequest(agent, pr, answer, answer.status === 'found' ? answer.checkedAt ?? checkedAt : checkedAt)
    return { url: pr.url, status: answer.status }
  }))
  await refreshMovedWork()
  const history = await sessionGitHistory.get(agent)
  return { ...result, context: identity, gitContext: context, history, lookups,
    nextOffset: offset + 4 < Math.max(saved.pullRequests.length, branches.length) ? offset + 4 : null }
}
