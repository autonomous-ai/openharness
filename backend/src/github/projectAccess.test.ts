import { describe, expect, it } from 'vitest'
import { fakeApp, fakeGitHub, throwawayKey } from './fakeGitHub.js'
import { projectGitHubAccess } from './projectAccess.js'

/** Approved or not, and whether this server can approve. */
const approval = (approved = true, canApprove = true) => ({ approved: async () => approved, canApprove })

const key = throwawayKey()
const setup = (slug: string | null = 'harness-fixture') => {
  let t = Date.parse('2026-10-28T12:00:00Z')
  const github = fakeGitHub({ publicKey: key.publicKey, appId: '424242', now: () => t })
  return { github, app: fakeApp(key.privateKey, github, { now: () => t, slug }), advance: (ms: number) => { t += ms } }
}

describe('a Swarm project\'s GitHub access', () => {
  it('says whether teammates\' agents can push there, and how to let them', async () => {
    const { github, app } = setup()
    expect(await projectGitHubAccess(null, 'https://github.com/acme/app', approval())).toEqual({ state: 'unavailable' })
    expect(await projectGitHubAccess(app, null, approval())).toEqual({ state: 'no-repository' })
    expect(await projectGitHubAccess(app, 'https://gitlab.com/acme/web', approval())).toEqual({ state: 'not-github', repositoryUrl: 'https://gitlab.com/acme/web' })
    expect(await projectGitHubAccess(app, 'git@github.com:acme/app.git', approval()))
      .toEqual({ state: 'not-installed', repository: 'acme/app', installUrl: 'https://github.com/apps/harness-fixture/installations/new', canApprove: true })
    github.installed.set('acme/app', 77)
    // A remembered "not installed" holds a minute; checking again asks GitHub at once.
    expect((await projectGitHubAccess(app, 'git@github.com:acme/app.git', approval())).state).toBe('not-installed')
    expect(await projectGitHubAccess(app, 'git@github.com:acme/app.git', approval(), true)).toEqual({ state: 'covered', repository: 'acme/app' })
    expect(await projectGitHubAccess(setup(null).app, 'https://github.com/acme/app', approval())).toMatchObject({ state: 'not-installed', installUrl: null })
  })

  it('is covered only once someone who can push to the repository approved it for the project', async () => {
    const { github, app } = setup()
    github.installed.set('acme/app', 77)
    expect(await projectGitHubAccess(app, 'https://github.com/acme/app', approval(false)))
      .toEqual({ state: 'not-approved', repository: 'acme/app', canApprove: true })
    expect(await projectGitHubAccess(app, 'https://github.com/acme/app', approval(false, false)))
      .toMatchObject({ state: 'not-approved', canApprove: false })
    let asked = ''
    await projectGitHubAccess(app, 'https://github.com/Acme/App', { approved: async (repository) => { asked = repository; return true }, canApprove: true })
    expect(asked).toBe('acme/app')
  })

  // autonomous-ai/autonomous-harness, renamed autonomous-ai/openharness: GitHub answers the old name by redirect, so the
  // project showed a name the repository no longer has (2026-10-28).
  it('shows a renamed repository by its name now, and keeps approvals with the project\'s address', async () => {
    const { github, app, advance } = setup()
    github.installed.set('acme/old', 77)
    github.owners.set('acme', 77)
    github.renamed.set('acme/old', 'acme/new')
    let asked = ''
    const read = () => projectGitHubAccess(app, 'https://github.com/acme/old', { approved: async (repository) => { asked = repository; return true }, canApprove: true })
    expect(await read()).toEqual({ state: 'covered', repository: 'acme/new' })
    expect(asked).toBe('acme/old')
    const lookups = () => github.calls.filter(c => c.path === '/repos/acme/old').length
    expect(lookups()).toBe(1)
    // Kept ten minutes, a repository that was not renamed too.
    await read()
    expect(lookups()).toBe(1)
    advance(10 * 60_000 + 1)
    github.renamed.delete('acme/old')
    github.installed.set('acme/old', 77)
    expect(await read()).toEqual({ state: 'covered', repository: 'acme/old' })
    expect(lookups()).toBe(2)
  })

  it('reads GitHub not answering as unknown, never as covered, and says when the app\'s credentials are wrong', async () => {
    const { github, app } = setup()
    github.control.down = true
    expect(await projectGitHubAccess(app, 'https://github.com/acme/app', approval())).toEqual({ state: 'unknown', repository: 'acme/app' })
    github.control.down = false
    const wrong = fakeApp(throwawayKey().privateKey, github)
    await expect(projectGitHubAccess(wrong, 'https://github.com/acme/app', approval())).rejects.toMatchObject({ code: 'GITHUB_APP_MISCONFIGURED' })
  })

  it('asks GitHub again on request at most every 15 seconds per repository', async () => {
    const { github, app, advance } = setup()
    const lookups = () => github.calls.filter(c => c.path === '/repos/acme/app/installation').length
    await projectGitHubAccess(app, 'https://github.com/acme/app', approval())
    await projectGitHubAccess(app, 'https://github.com/acme/app', approval(), true)
    await projectGitHubAccess(app, 'https://github.com/acme/app', approval(), true)
    expect(lookups()).toBe(2)
    advance(15_000)
    await projectGitHubAccess(app, 'https://github.com/acme/app', approval(), true)
    expect(lookups()).toBe(3)
  })
})
