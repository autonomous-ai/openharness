import { describe, expect, it } from 'vitest'
import { bindPullRequestCards, cleanPullRequestLinks } from './cards.js'
import { githubRepository } from '../github/repository.js'
import { appendPullRequestUrls, projectPullRequestUrl, pullRequestLinks, type Conversation, type SuperTabState } from './model.js'
import { groupRepositoryUrl, projectGitHub, type SwarmProject } from './projects.js'

const REPO = 'https://github.com/autonomous-ai/openharness.git'
const WRONG_OWNER = 'https://github.com/openharness/openharness/pull/1'
const RIGHT = 'https://github.com/autonomous-ai/openharness/pull/1'

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
  })

  it('adds links from text by the project\'s repository', () => {
    const group = { pullRequestUrls: [WRONG_OWNER] } as unknown as Conversation
    appendPullRequestUrls(group, [`See ${RIGHT} and https://github.com/autonomous-ai/other/pull/4`], REPO)
    expect(group.pullRequestUrls).toEqual([RIGHT])
  })

  // A Personal Swarm's project made from a pane's folder has no address to clone, only the GitHub repository Desktop named for it
  // (commands.ts project.github): its links are judged by that one, as a project cloned from GitHub has its own judged.
  it('judges by the GitHub repository a project was given when its folder has no address, and by its address first', () => {
    const named = { id: 'p', repository: { machineId: 'm', cwd: '/x', repositoryUrl: null }, githubRepository: 'autonomous-ai/openharness' } as SwarmProject
    expect(projectGitHub(named)).toEqual({ owner: 'autonomous-ai', name: 'openharness', fullName: 'autonomous-ai/openharness' })
    expect(projectGitHub({ ...named, repository: undefined })?.fullName).toBe('autonomous-ai/openharness')
    expect(projectGitHub({ ...named, repository: { machineId: 'm', cwd: '/x', repositoryUrl: 'git@github.com:Acme/App.git' } })?.fullName).toBe('Acme/App')
    expect(projectGitHub({ ...named, githubRepository: undefined })).toBeNull()
    const state = { projects: [named], conversations: [] } as unknown as SuperTabState
    const group = { id: 'g', projectId: 'p', pullRequestUrls: [] } as unknown as Conversation
    expect(groupRepositoryUrl(state, group)).toBe('https://github.com/autonomous-ai/openharness')
    appendPullRequestUrls(group, [`${WRONG_OWNER} https://github.com/Autonomous-AI/OpenHarness/pull/1`], groupRepositoryUrl(state, group))
    expect(group.pullRequestUrls).toEqual([RIGHT])
    expect(groupRepositoryUrl(state, { ...group, projectId: 'gone' } as Conversation)).toBeNull()
    const cloned = (repositoryUrl: string, githubRepository?: string) => ({ projects: [{ ...named, repository: { machineId: 'm', cwd: '/x', repositoryUrl }, githubRepository }],
      conversations: [] }) as unknown as SuperTabState
    expect(groupRepositoryUrl(cloned(REPO), group)).toBe(REPO)
    expect(groupRepositoryUrl(cloned('https://gitlab.com/acme/app', 'acme/app'), group)).toBe('https://github.com/acme/app')
  })
})
