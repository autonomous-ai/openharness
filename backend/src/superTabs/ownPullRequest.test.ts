// Task #3953: a task's checks count at the pull request it is about, not at its newest link, and the PM or the task's
// Engineer can take a wrong link off it. #3820 had #3819's and #3817's pull requests linked, and #3872 a closed duplicate.
import { describe, expect, it } from 'vitest'
import type { Command } from './commands.js'
import { appendPullRequestUrls } from './model.js'
import { owner, stepsFixture } from './steps.test-support.js'

const OWN = 'https://github.com/acme/app/pull/20', OTHER = 'https://github.com/acme/app/pull/19', DUPLICATE = 'https://github.com/acme/app/pull/9'
const OWN_HEAD = 'a'.repeat(40), OTHER_HEAD = 'b'.repeat(40), DUPLICATE_HEAD = 'c'.repeat(40)
const head = (sha: string, over: { closed?: true } = {}) => ({ head: sha, base: 'main', patch: `patch-${sha[0]}`, at: 1, ...over })

function linked(urls: string[], heads: Record<string, ReturnType<typeof head>>, result: string, code?: string[]) {
  const f = stepsFixture()
  const assignment = f.group(f.task).assignment!.id
  f.run({ type: 'work.status', conversationId: f.task, assignmentId: assignment, status: 'review', result } as Command, f.as(f.dev))
  const reviewer = f.add('rev', f.task)
  // After every command: each one replaces the state, so the group is read again.
  const group = f.group(f.task)
  group.pullRequestUrls = urls
  group.pullRequestHeads = heads
  if (code) group.codePullRequestUrls = code
  const check = (actor = f.as(f.dev), sha = OWN_HEAD) => f.run({ type: 'work.check', conversationId: f.task, assignmentId: assignment, checkId: f.group(f.task).checks[0]!.id,
    passed: true, evidence: 'Read the diff', head: sha, base: 'main' } as Command, actor)
  return Object.assign(f, { assignment, check, reviewer })
}

describe('a task\'s checks count at its own pull request (#3953)', () => {
  it('records a verdict at the pull request its Engineer\'s Ready line names, though another task\'s is linked after it', () => {
    const f = linked([OWN, OTHER], { [OWN]: head(OWN_HEAD), [OTHER]: head(OTHER_HEAD) }, `Ready for review: ${OWN} at aaaaaaa`)
    const effects = f.check(f.as(f.reviewer))
    expect(f.group(f.task).checks[0]!.verdicts!.at(-1)).toMatchObject({ pullRequest: OWN, head: OWN_HEAD })
    expect(effects.result.counts).toBe(true)
  })

  it('does not let a closed duplicate capture the checks', () => {
    const f = linked([OWN, DUPLICATE], { [OWN]: head(OWN_HEAD), [DUPLICATE]: head(DUPLICATE_HEAD, { closed: true }) }, 'Ready for review.')
    const effects = f.check(f.as(f.reviewer))
    expect(f.group(f.task).checks[0]!.verdicts!.at(-1)).toMatchObject({ pullRequest: OWN })
    expect(effects.result.counts).toBe(true)
  })

  it('falls back to the pull request in the task\'s code list when its status names none', () => {
    const f = linked([OWN, OTHER], { [OWN]: head(OWN_HEAD), [OTHER]: head(OTHER_HEAD) }, 'Ready for review.', [OWN])
    f.check(f.as(f.reviewer))
    expect(f.group(f.task).checks[0]!.verdicts!.at(-1)).toMatchObject({ pullRequest: OWN })
  })

  it('still uses the newest linked pull request for a task that names none and has no code list', () => {
    const f = linked([OWN, OTHER], { [OWN]: head(OWN_HEAD), [OTHER]: head(OTHER_HEAD) }, 'Ready for review.')
    f.check(f.as(f.reviewer), OTHER_HEAD)
    expect(f.group(f.task).checks[0]!.verdicts!.at(-1)).toMatchObject({ pullRequest: OTHER })
  })
})

describe('conversation.unlink (#3953)', () => {
  const unlink = (f: ReturnType<typeof linked>, actor = f.as(f.lead), url = OTHER, reason = 'It is #3819\'s pull request.') =>
    f.run({ type: 'conversation.unlink', conversationId: f.task, pullRequestUrl: url, reason } as Command, actor)
  const fixture = () => linked([OWN, OTHER], { [OWN]: head(OWN_HEAD), [OTHER]: head(OTHER_HEAD) }, `Ready for review: ${OWN} at aaaaaaa`, [OWN, OTHER])

  it('takes the link, its head and its code entry off the task for the PM, and records who, why and when in its history', () => {
    const f = fixture()
    const effects = unlink(f)
    const group = f.group(f.task)
    expect(group.pullRequestUrls).toEqual([OWN])
    expect(group.codePullRequestUrls).toEqual([OWN])
    expect(Object.keys(group.pullRequestHeads!)).toEqual([OWN])
    expect(group.unlinkedPullRequests).toEqual([{ url: OTHER, by: `agent:${f.lead}`, reason: 'It is #3819\'s pull request.', at: f.now }])
    expect(effects.messages.some(m => m.conversationId === f.task && m.text.includes(`unlinked ${OTHER}`) && m.text.includes('#3819'))).toBe(true)
  })

  it('works for the task\'s Engineer too', () => {
    const f = fixture()
    unlink(f, f.as(f.dev))
    expect(f.group(f.task).pullRequestUrls).toEqual([OWN])
  })

  it('refuses another agent and a person, and changes nothing', () => {
    const f = fixture()
    expect(() => unlink(f, f.as(f.reviewer))).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => unlink(f, owner)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(f.group(f.task).pullRequestUrls).toEqual([OWN, OTHER])
    expect(f.group(f.task).unlinkedPullRequests).toBeUndefined()
  })

  it('refuses a pull request whose merge the task recorded, and one it does not link', () => {
    const f = fixture()
    f.group(f.task).cards = { pullRequests: [{ url: OTHER, messageId: 'm1', mergedAt: 5 }] }
    expect(() => unlink(f)).toThrowError(expect.objectContaining({ code: 'MERGED_LINK' }))
    expect(() => unlink(f, f.as(f.lead), DUPLICATE)).toThrowError(expect.objectContaining({ code: 'NOT_LINKED' }))
    expect(f.group(f.task).pullRequestUrls).toEqual([OWN, OTHER])
  })

  it('leaves a verdict on the unlinked pull request counting nowhere, and keeps a later post from linking it again', () => {
    const f = fixture()
    f.check(f.as(f.reviewer), OTHER_HEAD)
    expect(f.group(f.task).checks[0]!.verdicts!.at(-1)).toMatchObject({ pullRequest: OWN })
    f.group(f.task).checks[0]!.verdicts![0]!.pullRequest = OTHER
    f.group(f.task).checks[0]!.verdicts![0]!.head = OTHER_HEAD
    unlink(f)
    expect(f.group(f.task).checks[0]!.verdicts![0]!.stale).toBeDefined()
    appendPullRequestUrls(f.group(f.task), [`See ${OTHER}`])
    expect(f.group(f.task).pullRequestUrls).toEqual([OWN])
  })
})
