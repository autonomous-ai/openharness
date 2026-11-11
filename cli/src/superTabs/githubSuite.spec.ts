import { describe, expect, it } from 'vitest'
import { SAID_MAX, saySuite, suiteAsked, type SuiteResult } from './githubSuite.js'
import type { GitHubGet, GitHubSend } from './githubRest.js'
import { SuperTabHostError } from './wire.js'

type Json = Record<string, unknown>
const TIP = '1a2b3c4c0ffee0000000000000000000000000ab'
const OLD = '9f8e7d6c0ffee0000000000000000000000000cd'
const FILE = '| Shard | Needs | Command |\n|---|---|---|\n| desktop-macos-1 | macos | `python3 scripts/test-desktop.py --shard 1/2` |\n| cli/core | | `npm test` |\n'
const base64 = (text: string) => ({ type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') })
const status = (context: string, state: string, login = 'runner-login') => ({ context, state, creator: { login } })

/** One private repository as GitHub's REST API answers for it: its commits, its suites file at each, the statuses on each, and
 *  what was sent to it. */
function setup() {
  const repo = { about: { private: true } as Json | null, commits: { [TIP]: TIP, [OLD]: OLD } as Record<string, string>, files: { [TIP]: base64(FILE) } as Record<string, unknown>,
    statuses: [] as Json[] | Json, fail: {} as Record<string, number>, postStatus: 201, down: '' }
  const sent: Array<{ method: string; path: string; body: unknown }> = []
  const asked: string[] = []
  const answer = (status: number, body: unknown = null) => ({ status, etag: null, body, resetAt: null })
  const get: GitHubGet = async path => {
    asked.push(path)
    const url = new URL(`https://api.github.com${path}`), p = url.pathname
    const part = p === '/repos/acme/app' ? 'about' : p.endsWith('/statuses') ? 'statuses' : p.includes('/contents/') ? 'file' : 'commit'
    if (repo.down === part) throw new Error('gh is not signed in on this computer: run `gh auth login`.')
    if (repo.fail[part]) return answer(repo.fail[part]!)
    if (part === 'about') return repo.about ? answer(200, repo.about) : answer(404)
    if (part === 'statuses') return answer(200, repo.statuses)
    if (part === 'file') {
      const file = p === '/repos/acme/app/contents/agents/SUITES.md' ? repo.files[url.searchParams.get('ref') ?? ''] : undefined
      return file === undefined ? answer(404) : answer(200, file)
    }
    const found = Object.entries(repo.commits).find(([asked]) => asked.startsWith(p.slice('/repos/acme/app/commits/'.length)))
    return found ? answer(200, { sha: found[1], commit: { tree: { sha: 'f'.repeat(40) } } }) : answer(422)
  }
  const send: GitHubSend = async (method, path, body) => {
    sent.push({ method, path, body })
    if (repo.down === 'send') throw new Error('GitHub could not be reached.')
    return answer(repo.postStatus, repo.postStatus === 201 ? { id: 1, ...(body as Json) } : null)
  }
  const pip = { name: 'Pip', repositories: new Map([['acme/app', { project: 'acme/app', github: 'acme/app' }]]) }
  const passed: SuiteResult = { repository: 'acme/app', sha: '1a2b3c4', shard: 'desktop-macos-1', result: 'passed' }
  // gh gives a login as its person wrote it, and GitHub lists it in any case.
  const run = (result: SuiteResult = passed, agent = pip) => saySuite({ get, send, login: async () => 'Runner-Login' }, agent, result)
  return { repo, sent, asked, run, passed, pip }
}
const refusal = async (made: Promise<unknown>) => made.then(() => null, error => error instanceof SuperTabHostError ? { code: error.code, message: error.message, status: error.status } : { thrown: error })

describe('a shard\'s result, said by command', () => {
  it('says passed as a success on the whole commit, under the shard\'s check and the agent\'s name, after reading the repository, the commit, its file and its statuses', async () => {
    const t = setup()
    expect(await t.run()).toEqual({ commit: TIP, check: 'suite: desktop-macos-1', said: true })
    expect(t.sent).toEqual([{ method: 'POST', path: `/repos/acme/app/statuses/${TIP}`, body: { state: 'success', context: 'suite: desktop-macos-1', description: 'passed, said by Pip' } }])
    // The file as that commit has it, never another branch's.
    expect(t.asked).toEqual(['/repos/acme/app', '/repos/acme/app/commits/1a2b3c4', `/repos/acme/app/contents/agents/SUITES.md?ref=${TIP}`,
      `/repos/acme/app/commits/${TIP}/statuses?per_page=100`])
  })

  it('says failed as a failure, for a shard whose name has a slash, on a commit named whole', async () => {
    const t = setup()
    expect(await t.run({ repository: 'acme/app', sha: TIP, shard: 'cli/core', result: 'failed' })).toEqual({ commit: TIP, check: 'suite: cli/core', said: true })
    expect(t.sent.map(sent => sent.body)).toEqual([{ state: 'failure', context: 'suite: cli/core', description: 'failed, said by Pip' }])
  })

  it('refuses a repository that is no project of the agent\'s, and asks GitHub nothing', async () => {
    const t = setup()
    expect(await refusal(t.run({ ...t.passed, repository: 'other/thing' }))).toMatchObject({ code: 'REPOSITORY_NOT_PROJECT', status: 422 })
    expect(t.asked).toEqual([])
    expect(t.sent).toEqual([])
  })

  // For private teams only: in an open project a result counts when computers of different people agree, which is not built.
  it('refuses a repository GitHub does not call private, and says nothing', async () => {
    for (const about of [{ private: false }, { visibility: 'public' }, { private: 'true' }, {}]) {
      const t = setup()
      t.repo.about = about
      expect(await refusal(t.run()), JSON.stringify(about)).toEqual({ code: 'NOT_PRIVATE', status: 403,
        message: 'acme/app is not a private repository: a suite\'s result is said only in one.' })
      expect(t.asked).toEqual(['/repos/acme/app'])
      expect(t.sent).toEqual([])
    }
  })

  it('refuses a commit GitHub does not know, and one it answers with another commit for, and says nothing', async () => {
    const t = setup()
    const unknown = { code: 'COMMIT_NOT_FOUND', status: 404, message: 'acme/app at 0000000 is not a commit this computer\'s GitHub login can read.' }
    // GitHub answers 422 for digits that name no commit, and 404 for a commit of another repository.
    expect(await refusal(t.run({ ...t.passed, sha: '0000000' }))).toEqual(unknown)
    t.repo.fail.commit = 404
    expect(await refusal(t.run({ ...t.passed, sha: '0000000' }))).toEqual(unknown)
    t.repo.fail = {}
    // A branch named like the digits: GitHub answers with its tip, which is not the commit asked for.
    t.repo.commits = { '1a2b3c4': OLD }
    expect((await refusal(t.run()))?.code).toBe('COMMIT_NOT_FOUND')
    // An answer with a short commit id, or none at all.
    for (const answered of ['1a2b3c4', undefined]) {
      t.repo.commits = { '1a2b3c4': answered as string }
      expect((await refusal(t.run()))?.code, String(answered)).toBe('COMMIT_NOT_FOUND')
    }
    expect(t.sent).toEqual([])
    expect(t.asked.filter(path => path.includes('/contents/') || path.endsWith('/statuses'))).toEqual([])
  })

  it('refuses a shard the file does not have at that commit, naming the ones it has, and says nothing', async () => {
    const t = setup()
    expect(await refusal(t.run({ ...t.passed, shard: 'desktop-macos-2' }))).toEqual({ code: 'SHARD_NOT_FOUND', status: 404,
      message: 'acme/app has no shard named desktop-macos-2 in agents/SUITES.md at 1a2b3c4. Its shards there: desktop-macos-1, cli/core.' })
    // The commit before the file was written, a folder of that name, and a file GitHub does not send whole.
    const none = 'acme/app has no shard named desktop-macos-1 in agents/SUITES.md at 9f8e7d6. That file has no shard there.'
    expect((await refusal(t.run({ ...t.passed, sha: '9f8e7d6' })))?.message).toBe(none)
    for (const file of [[{ name: 'a.md' }], { type: 'file', encoding: 'none', content: '' }, { type: 'file', encoding: 'base64' }, { ...base64(FILE), encoding: 'none' }]) {
      t.repo.files[OLD] = file
      expect((await refusal(t.run({ ...t.passed, sha: '9f8e7d6' })))?.message, JSON.stringify(file)).toBe(none)
    }
    expect(t.sent).toEqual([])
  })

  // A command that arrives twice does its work once: the result this login said last for the shard on the commit stands.
  it('says the same result once, and another result again', async () => {
    const t = setup()
    t.repo.statuses = [status('suite: desktop-macos-1', 'success')]
    expect(await t.run()).toEqual({ commit: TIP, check: 'suite: desktop-macos-1', said: false })
    expect(t.sent).toEqual([])
    expect(await t.run({ ...t.passed, result: 'failed' })).toMatchObject({ said: true })
    expect(t.sent.map(sent => (sent.body as Json).state)).toEqual(['failure'])
    // GitHub lists the newest first: a pass said before a failure is not the last word.
    t.repo.statuses = [status('suite: desktop-macos-1', 'failure'), status('suite: desktop-macos-1', 'success')]
    expect(await t.run()).toMatchObject({ said: true })
  })

  it('counts only its own login\'s statuses of that shard: another person\'s, another shard\'s and the train\'s own mark are none of its', async () => {
    const t = setup()
    t.repo.statuses = [status('suite: desktop-macos-1', 'success', 'someone-else'), status('suite: cli/core', 'success'), status('harness/train', 'success'),
      { context: 'suite: desktop-macos-1', state: 'success' }]
    expect(await t.run()).toMatchObject({ said: true })
    // Its login in any case is its own.
    t.repo.statuses = [status('suite: desktop-macos-1', 'success', 'RUNNER-LOGIN')]
    expect(await t.run()).toMatchObject({ said: false })
    expect(t.sent).toHaveLength(1)
  })

  // Each is a write in a person's name: a command sent again and again with one result then the other is stopped.
  it('says a shard\'s result on one commit no more than five times', async () => {
    const t = setup()
    const flips = (count: number) => Array.from({ length: count }, (_, n) => status('suite: desktop-macos-1', n % 2 ? 'success' : 'failure'))
    t.repo.statuses = flips(SAID_MAX - 1)
    expect(await t.run()).toMatchObject({ said: true })
    t.repo.statuses = flips(SAID_MAX)
    expect(await refusal(t.run())).toEqual({ code: 'RESULT_LIMIT', status: 429,
      message: `You said suite: desktop-macos-1 on 1a2b3c4 ${SAID_MAX} times, and ${SAID_MAX} is the most: it stands as GitHub shows it.` })
    expect(t.sent).toHaveLength(1)
    // The result it said last, asked again, is still only said already.
    expect(await t.run({ ...t.passed, result: 'failed' })).toMatchObject({ said: false })
  })

  it('says what GitHub answered when it refuses a read or the status itself, and that nothing was said', async () => {
    for (const part of ['about', 'commit', 'file', 'statuses']) {
      const t = setup()
      t.repo.fail[part] = 500
      expect(await refusal(t.run()), part).toEqual({ code: 'GITHUB_REFUSED', status: 502, message: 'GitHub answered 500 for acme/app at 1a2b3c4. Nothing was said.' })
      expect(t.sent).toEqual([])
    }
    const t = setup()
    t.repo.statuses = { message: 'not a list' }
    expect((await refusal(t.run()))?.code).toBe('GITHUB_REFUSED')
    // A login that may not write there: GitHub refuses the status.
    t.repo.statuses = []
    t.repo.postStatus = 403
    expect(await refusal(t.run())).toEqual({ code: 'GITHUB_REFUSED', status: 502, message: 'GitHub answered 403 for acme/app at 1a2b3c4. Nothing was said.' })
  })

  it('says in gh\'s own words when gh is missing or signed out, or GitHub is out of reach', async () => {
    for (const part of ['about', 'commit', 'file', 'statuses', 'send']) {
      const t = setup()
      t.repo.down = part
      expect((await refusal(t.run()))?.code, part).toBe('GITHUB_UNAVAILABLE')
    }
    const t = setup()
    const out = await refusal(saySuite({ get: async () => { throw 'offline' }, send: async () => { throw 'offline' }, login: async () => 'runner-login' }, t.pip, t.passed))
    expect(out).toEqual({ code: 'GITHUB_UNAVAILABLE', status: 503, message: 'GitHub could not be reached.' })
    // Its login is asked of gh too.
    const signedOut = await refusal(saySuite({ get: setupGet(t), send: async () => { throw new Error('unused') }, login: async () => { throw new Error('gh auth login') } }, t.pip, t.passed))
    expect(signedOut).toMatchObject({ code: 'GITHUB_UNAVAILABLE', message: 'gh auth login' })
  })

  it('refuses an agent with no name, and says a name on one line, no longer than a status holds', async () => {
    const t = setup()
    expect(await refusal(t.run(t.passed, { ...t.pip, name: ' \n ' }))).toMatchObject({ code: 'AGENT_UNNAMED', status: 409 })
    expect(t.asked).toEqual([])
    await t.run(t.passed, { ...t.pip, name: ' Pip\nTwo\u0007 ' })
    await t.run({ ...t.passed, shard: 'cli/core' }, { ...t.pip, name: `${'🐝'.repeat(70)}` })
    expect(t.sent.map(sent => (sent.body as Json).description)).toEqual(['passed, said by Pip Two', `passed, said by ${'🐝'.repeat(60)}`])
  })

  // A repository renamed on GitHub keeps its old name in its project (githubVerdict.ts ProjectRepositories).
  it('says it on the repository as GitHub names it now, by either of its names', async () => {
    const t = setup()
    const renamed = { name: 'Pip', repositories: new Map([['old/app', { project: 'old/app', github: 'acme/app' }], ['acme/app', { project: 'old/app', github: 'acme/app' }]]) }
    expect(await t.run({ ...t.passed, repository: 'Old/App' }, renamed)).toMatchObject({ said: true })
    expect(t.sent.map(sent => sent.path)).toEqual([`/repos/acme/app/statuses/${TIP}`])
  })
})

/** The fake's reads alone, for a login that fails. */
function setupGet(t: ReturnType<typeof setup>): GitHubGet {
  return async path => {
    const p = new URL(`https://api.github.com${path}`).pathname
    return { status: 200, etag: null, resetAt: null, body: p === '/repos/acme/app' ? t.repo.about : p.includes('/contents/') ? base64(FILE) : { sha: TIP } }
  }
}

describe('a result asked for', () => {
  it('is a repository, a commit of 7 to 40 digits, a shard\'s name, and passed or failed', () => {
    const asked = { repository: 'acme/app', sha: '1a2b3c4', shard: 'desktop-macos-1', result: 'passed' }
    expect(suiteAsked(asked)).toEqual(asked)
    expect(suiteAsked({ ...asked, sha: TIP, result: 'failed', repository: 'Acme/App.js', extra: 1 })).toEqual({ repository: 'Acme/App.js', sha: TIP, shard: 'desktop-macos-1', result: 'failed' })
    for (const bad of [{ repository: 'acme' }, { repository: 'acme/../app' }, { repository: 'acme/..' }, { repository: '../app' }, { repository: 'acme/app#3' }, { repository: 7 },
      { sha: '1a2b3c' }, { sha: `${TIP}0` }, { sha: 'HEAD' },
      { sha: '1A2B3C4' }, { sha: 1234567 }, { shard: 'Desktop 1' }, { shard: '' }, { shard: undefined }, { result: 'ok' }, { result: 'success' }, { result: undefined }]) {
      expect(suiteAsked({ ...asked, ...bad }), JSON.stringify(bad)).toBeNull()
    }
  })
})
