import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { bindPullRequestCards, cleanPullRequestLinks, pullRequestCard } from './cards.js'
import { githubRepository } from '../github/repository.js'
import { appendPullRequestUrls, createSuperTab, projectPullRequestUrl, pullRequestLinks, type Actor, type Conversation } from './model.js'

const REPO = 'https://github.com/autonomous-ai/openharness.git'
const WRONG_OWNER = 'https://github.com/openharness/openharness/pull/1'
const RIGHT = 'https://github.com/autonomous-ai/openharness/pull/1'
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'diego@autonomous.ai' }

function fixture(repositoryUrl: string | null = REPO) {
  let state = createSuperTab('tab', 'Office', { id: 'owner', email: owner.email }, 'prod')
  state.projects![0]!.repository = { machineId: 'host', cwd: '/work', repositoryUrl }
  let sequence = 0
  const run = (command: Command, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, owner, command, { now: 1000, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const id = run({ type: 'conversation.create', title: 'Links', brief: 'Link.', checks: [] } as Command).result.conversationId as string
  return { run, id, group: () => state.conversations.find(c => c.id === id)!, get state() { return state } }
}

describe('a project\'s pull request links', () => {
  it('reads the repository of an https, ssh or scp address, and nothing for another host', () => {
    for (const url of [REPO, 'https://github.com/autonomous-ai/openharness', 'git@github.com:autonomous-ai/openharness.git', 'ssh://git@github.com/autonomous-ai/openharness.git/']) {
      expect(githubRepository(url)).toEqual({ owner: 'autonomous-ai', name: 'openharness', fullName: 'autonomous-ai/openharness' })
    }
    expect(githubRepository('https://gitlab.com/autonomous-ai/openharness')).toBeNull()
    expect(githubRepository(null)).toBeNull()
  })

  it('keeps the project\'s own link in its spelling, and drops any other repository\'s, another owner\'s included', () => {
    expect(projectPullRequestUrl(WRONG_OWNER, REPO)).toBeNull()
    expect(projectPullRequestUrl('https://github.com/AUTONOMOUS-AI/OpenHarness/pull/1', REPO)).toBe(RIGHT)
    expect(projectPullRequestUrl(RIGHT, REPO)).toBe(RIGHT)
    expect(projectPullRequestUrl('https://github.com/autonomous-ai/other/pull/1', REPO)).toBeNull()
    expect(projectPullRequestUrl('https://github.com/x/other/pull/1', 'https://gitlab.com/a/b')).toBe('https://github.com/x/other/pull/1')
    expect(projectPullRequestUrl('https://github.com/x/other/pull/1', null)).toBe('https://github.com/x/other/pull/1')
  })

  it('finds one link per pull request in text', () => {
    expect(pullRequestLinks(`${WRONG_OWNER} ${RIGHT} https://github.com/autonomous-ai/other/pull/1 https://github.com/AUTONOMOUS-AI/OpenHarness/pull/1`, REPO)).toEqual([RIGHT])
    expect(pullRequestLinks(`${WRONG_OWNER} ${RIGHT}`)).toEqual([WRONG_OWNER, RIGHT])
  })

  it('cleans a group\'s record: the other owner\'s link goes and the right one stays, as does another repository\'s removal', () => {
    const group = { pullRequestUrls: [WRONG_OWNER, RIGHT, 'https://github.com/autonomous-ai/other/pull/9'],
      cards: { pullRequests: [{ url: WRONG_OWNER, messageId: 'm1' }, { url: RIGHT, messageId: 'm2', mergedAt: 5 },
        { url: 'https://github.com/AUTONOMOUS-AI/openharness/pull/1', messageId: 'm4', mergedAt: 3 }, { url: 'https://github.com/o/other/pull/9', messageId: 'm3' }] } } as unknown as Conversation
    cleanPullRequestLinks(group, REPO)
    expect(group.pullRequestUrls).toEqual([RIGHT])
    expect(group.cards!.pullRequests).toEqual([{ url: RIGHT, messageId: 'm2', mergedAt: 3 }])
    cleanPullRequestLinks(group, null)
    expect(group.pullRequestUrls).toEqual([RIGHT])
  })

  it('binds one card per pull request, and none for another owner\'s', () => {
    const group = { pullRequestUrls: [] } as unknown as Conversation
    bindPullRequestCards(group, { id: 'm1', conversationId: 'g', author: {} as never, text: `Opened ${WRONG_OWNER}`, replyTo: null, recipients: [] }, REPO)
    expect(group.cards).toBeUndefined()
    bindPullRequestCards(group, { id: 'm2', conversationId: 'g', author: {} as never, text: `Again ${RIGHT}`, replyTo: null, recipients: [] }, REPO)
    bindPullRequestCards(group, { id: 'm3', conversationId: 'g', author: {} as never, text: `Spelled https://github.com/Autonomous-AI/OpenHarness/pull/1`, replyTo: null, recipients: [] }, REPO)
    expect(group.cards!.pullRequests).toEqual([{ url: RIGHT, messageId: 'm2' }])
    expect(pullRequestCard(group, RIGHT)?.messageId).toBe('m2')
  })

  it('records a merge of a link in the project\'s spelling, and refuses another owner\'s', () => {
    const f = fixture()
    expect(() => f.run({ type: 'conversation.merged', conversationId: f.id, pullRequestUrl: WRONG_OWNER })).toThrow(/not in the project's repository/)
    f.run({ type: 'conversation.merged', conversationId: f.id, pullRequestUrl: 'https://github.com/Autonomous-AI/OpenHarness/pull/1' })
    f.run({ type: 'conversation.merged', conversationId: f.id, pullRequestUrl: RIGHT })
    expect(f.group().pullRequestUrls).toEqual([RIGHT])
    expect(f.group().cards!.pullRequests).toEqual([expect.objectContaining({ url: RIGHT, mergedAt: 1000 })])
  })

  it('refuses a merge of a pull request in another repository, saying which one the project uses', () => {
    const f = fixture()
    expect(() => f.run({ type: 'conversation.merged', conversationId: f.id, pullRequestUrl: 'https://github.com/autonomous-ai/other/pull/3' }))
      .toThrow(/not in the project's repository \(autonomous-ai\/openharness\)/)
    expect(f.group().pullRequestUrls ?? []).toEqual([])
  })

  it('takes any link when the project has no GitHub repository to judge by', () => {
    const f = fixture(null)
    f.run({ type: 'conversation.merged', conversationId: f.id, pullRequestUrl: WRONG_OWNER })
    expect(f.group().pullRequestUrls).toEqual([WRONG_OWNER])
  })

  it('adds links from text by the project\'s repository', () => {
    const group = { pullRequestUrls: [WRONG_OWNER] } as unknown as Conversation
    appendPullRequestUrls(group, [`See ${RIGHT} and https://github.com/autonomous-ai/other/pull/4`], REPO)
    expect(group.pullRequestUrls).toEqual([RIGHT])
  })
})
