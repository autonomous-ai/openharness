import { describe, expect, it } from 'vitest'
import { fakeApp, fakeGitHub, throwawayKey } from './fakeGitHub.js'
import { githubRepository } from './repository.js'
import { TRAIN_PERMISSIONS, TrainReadError, repositoryTrain, trainGitHub, type TrainCall } from './train.js'

const SHA = 'a'.repeat(40), MAIN = 'c'.repeat(40), MERGED = 'd'.repeat(40)
const pullBody = (n: number, over: Record<string, unknown> = {}) => ({ number: n, html_url: `https://github.com/acme/app/pull/${n}`, state: 'open',
  merged: false, draft: false, title: `PR ${n}`, body: 'text', mergeable: true, head: { sha: SHA, ref: `feature-${n}` }, base: { ref: 'main' },
  labels: [{ name: 'hold' }], ...over })

/** A stub of GitHub's answers by "METHOD path", recording each call. */
function stub(answers: Record<string, { status: number; body?: unknown }>) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const call: TrainCall = async (method, path, body) => {
    calls.push({ method, path, ...(body === undefined ? {} : { body }) })
    const found = answers[`${method} ${path}`]
    return found ? { status: found.status, body: found.body ?? {} } : { status: 404, body: { message: 'Not Found' } }
  }
  return { calls, train: trainGitHub(call, 'acme/app') }
}

describe('the merge train on GitHub', () => {
  it('reads main, a pull request, its files and its ci/required', async () => {
    const { train } = stub({
      'GET /repos/acme/app/git/ref/heads/main': { status: 200, body: { ref: 'refs/heads/main', object: { type: 'commit', sha: MAIN } } },
      'GET /repos/acme/app/pulls/7': { status: 200, body: pullBody(7) },
      'GET /repos/acme/app/pulls/7/files?per_page=100&page=1': { status: 200, body: [{ filename: 'backend/a.ts' }, { filename: 'docs/b.md' }] },
      [`GET /repos/acme/app/commits/${SHA}/check-runs?check_name=ci%2Frequired&filter=latest`]: { status: 200, body: { total_count: 1,
        check_runs: [{ name: 'ci/required', status: 'completed', conclusion: 'success' }] } },
    })
    expect(await train.mainHead()).toBe(MAIN)
    expect(await train.pull(7)).toEqual({ number: 7, url: 'https://github.com/acme/app/pull/7', state: 'open', merged: false, draft: false,
      title: 'PR 7', body: 'text', mergeable: true, head: SHA, headRef: 'feature-7', base: 'main', labels: ['hold'] })
    expect(await train.files(7)).toEqual(['backend/a.ts', 'docs/b.md'])
    expect(await train.ciRequired(SHA)).toBe('success')
  })

  it('reads ci/required as pending, failed or missing', async () => {
    const runs = (check_runs: unknown[]) => stub({ [`GET /repos/acme/app/commits/${SHA}/check-runs?check_name=ci%2Frequired&filter=latest`]: { status: 200, body: { total_count: check_runs.length, check_runs } } }).train
    expect(await runs([{ name: 'ci/required', status: 'in_progress', conclusion: null }]).ciRequired(SHA)).toBe('pending')
    expect(await runs([{ name: 'ci/required', status: 'completed', conclusion: 'failure' }]).ciRequired(SHA)).toBe('failure')
    expect(await runs([{ name: 'ci/required', status: 'completed', conclusion: 'skipped' }]).ciRequired(SHA)).toBe('failure')
    expect(await runs([]).ciRequired(SHA)).toBe(null)
  })

  it('fails closed on every read it cannot trust', async () => {
    const broken = stub({
      'GET /repos/acme/app/git/ref/heads/main': { status: 500 },
      'GET /repos/acme/app/pulls/7': { status: 200, body: { number: 8, state: 'open' } },
      'GET /repos/acme/app/pulls/7/files?per_page=100&page=1': { status: 403 },
      [`GET /repos/acme/app/commits/${SHA}/check-runs?check_name=ci%2Frequired&filter=latest`]: { status: 200, body: { check_runs: 'x' } },
    }).train
    await expect(broken.mainHead()).rejects.toBeInstanceOf(TrainReadError)
    await expect(broken.pull(7)).rejects.toBeInstanceOf(TrainReadError)
    await expect(broken.files(7)).rejects.toBeInstanceOf(TrainReadError)
    await expect(broken.ciRequired(SHA)).rejects.toBeInstanceOf(TrainReadError)
    await expect(broken.ciRequired('main')).rejects.toBeInstanceOf(TrainReadError)
  })

  it('builds a batch: a branch at main, each head merged in, a pull request to main', async () => {
    const { train, calls } = stub({
      'POST /repos/acme/app/git/refs': { status: 201, body: { ref: 'refs/heads/harness-train/1', object: { sha: MAIN } } },
      'POST /repos/acme/app/merges': { status: 201, body: { sha: MERGED, parents: [{ sha: MAIN }, { sha: SHA }] } },
      'POST /repos/acme/app/pulls': { status: 201, body: pullBody(9, { head: { sha: MERGED, ref: 'harness-train/1' }, labels: [] }) },
    })
    await train.createBranch('harness-train/1', MAIN)
    expect(await train.mergeInto('harness-train/1', SHA, 'Merge #7')).toEqual({ sha: MERGED })
    expect((await train.openPull('harness-train/1', 'Batch', 'body')).number).toBe(9)
    expect(calls.map(c => [c.method, c.path, c.body])).toEqual([
      ['POST', '/repos/acme/app/git/refs', { ref: 'refs/heads/harness-train/1', sha: MAIN }],
      ['POST', '/repos/acme/app/merges', { base: 'harness-train/1', head: SHA, commit_message: 'Merge #7' }],
      ['POST', '/repos/acme/app/pulls', { head: 'harness-train/1', base: 'main', title: 'Batch', body: 'body', draft: false }],
    ])
  })

  it('reads a conflict as one, and never lets the branch point at a member\'s own commit', async () => {
    expect(await stub({ 'POST /repos/acme/app/merges': { status: 409 } }).train.mergeInto('harness-train/1', SHA, 'm')).toBe('conflict')
    // Nothing merged: the branch already held the head.
    await expect(stub({ 'POST /repos/acme/app/merges': { status: 204 } }).train.mergeInto('harness-train/1', SHA, 'm')).rejects.toBeInstanceOf(TrainReadError)
    // A fast-forward would leave the branch at the member's commit, which reads as the bot pushing it (pushOrigin.ts).
    await expect(stub({ 'POST /repos/acme/app/merges': { status: 201, body: { sha: SHA, parents: [{ sha: MAIN }] } } }).train
      .mergeInto('harness-train/1', SHA, 'm')).rejects.toBeInstanceOf(TrainReadError)
  })

  it('squash-merges at the exact head, comments, closes and deletes', async () => {
    const { train, calls } = stub({
      'PUT /repos/acme/app/pulls/9/merge': { status: 200, body: { merged: true, sha: MERGED } },
      'POST /repos/acme/app/issues/7/comments': { status: 201, body: { id: 1 } },
      'PATCH /repos/acme/app/pulls/7': { status: 200, body: pullBody(7, { state: 'closed' }) },
      'DELETE /repos/acme/app/git/refs/heads/harness-train/1': { status: 204 },
    })
    expect(await train.squash(9, MERGED, 'Batch (#9)', 'msg')).toEqual({ sha: MERGED })
    await train.comment(7, 'Merged in the batch')
    await train.close(7)
    await train.deleteBranch('harness-train/1')
    expect(calls[0]).toEqual({ method: 'PUT', path: '/repos/acme/app/pulls/9/merge', body: { sha: MERGED, merge_method: 'squash', commit_title: 'Batch (#9)', commit_message: 'msg' } })
    expect(calls.map(c => c.method)).toEqual(['PUT', 'POST', 'PATCH', 'DELETE'])
  })

  it('refuses a squash GitHub did not do, and a branch name outside the train', async () => {
    await expect(stub({ 'PUT /repos/acme/app/pulls/9/merge': { status: 409 } }).train.squash(9, MERGED, 't', 'm')).rejects.toBeInstanceOf(TrainReadError)
    await expect(stub({ 'PUT /repos/acme/app/pulls/9/merge': { status: 200, body: { merged: false } } }).train.squash(9, MERGED, 't', 'm')).rejects.toBeInstanceOf(TrainReadError)
    const { train, calls } = stub({})
    await expect(train.createBranch('main', MAIN)).rejects.toBeInstanceOf(TrainReadError)
    await expect(train.deleteBranch('feature-7')).rejects.toBeInstanceOf(TrainReadError)
    expect(calls).toEqual([])
  })

  it('lists open pull requests into main, a page at a time', async () => {
    const { train } = stub({
      'GET /repos/acme/app/pulls?state=open&base=main&per_page=100&page=1': { status: 200, body: [pullBody(7), pullBody(8, { draft: true })] },
    })
    expect((await train.openPulls()).map(p => [p.number, p.draft])).toEqual([[7, false], [8, true]])
  })
})

describe('the train\'s token', () => {
  it('asks only for what the train does, and is revoked when the pass is done', async () => {
    const key = throwawayKey(), github = fakeGitHub({ publicKey: key.publicKey, appId: '424242' })
    github.installed.set('acme/app', 77)
    const opened = await repositoryTrain(fakeApp(key.privateKey, github), githubRepository('https://github.com/acme/app')!)
    expect(opened).not.toBeNull()
    expect([...github.permissions.values()]).toEqual([TRAIN_PERMISSIONS])
    expect(TRAIN_PERMISSIONS).toEqual({ contents: 'write', pull_requests: 'write', checks: 'read', metadata: 'read' })
    await opened!.done()
    expect(github.revoked).toHaveLength(1)
  })
  it('is null where the app is not installed', async () => {
    const key = throwawayKey(), github = fakeGitHub({ publicKey: key.publicKey, appId: '424242' })
    expect(await repositoryTrain(fakeApp(key.privateKey, github), githubRepository('https://github.com/acme/app')!)).toBeNull()
  })
})
