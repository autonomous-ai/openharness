import { describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { commentAuthors, commentKey, recordComment, RECORDS_PER_HOUR, repositoryProject } from './githubComments.js'
import { SuperTabError, type SuperTabState } from './model.js'
import type { SwarmProject } from './projects.js'

type Row = { id: string; tabId: string; projectId: string; agentId: string; createdAt: Date }
/** The collection as Mongo keeps it: a second insert of one id is refused as a duplicate key, as Prisma names it. */
function database() {
  const rows = new Map<string, Row>()
  const db = { superTabGithubComment: {
    create: async ({ data }: { data: Row }) => {
      if (rows.has(data.id)) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
      rows.set(data.id, data)
      return data
    },
    findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
    aggregateRaw: async ({ pipeline }: { pipeline: Array<{ $match?: { _id: { $in: string[] } } }> }) =>
      pipeline[0]!.$match!._id.$in.flatMap(id => rows.has(id) ? [{ _id: id, agentId: rows.get(id)!.agentId, projectId: rows.get(id)!.projectId }] : []),
  } } as unknown as PrismaClient
  return { db, rows }
}
const NOW = 1_800_000_000_000
const record = (db: PrismaClient, over: Partial<Parameters<typeof recordComment>[1]> = {}) =>
  recordComment(db, { tabId: 'tab', projectId: 'web', agentId: 'juno', repository: 'Acme/App', kind: 'issue', commentId: '101', now: NOW, ...over })
const refusal = async (body: () => Promise<unknown>) => {
  try { await body(); return null } catch (error) { if (error instanceof SuperTabError) return error; throw error }
}

describe('which agent wrote a GitHub comment', () => {
  it('keeps ids only, under its Swarm, the repository in lower case, its kind and GitHub\'s id', async () => {
    const { db, rows } = database()
    expect(await record(db)).toEqual({ recorded: true })
    expect([...rows.values()]).toEqual([{ id: 'tab|acme/app|issue|101', tabId: 'tab', projectId: 'web', agentId: 'juno', createdAt: new Date(NOW) }])
    expect(commentKey('tab', 'Acme/App', 'review-comment', '7')).toBe('tab|acme/app|review-comment|7')
  })

  it('lets the first writer keep it: the same record again is no change, another agent\'s claim is refused', async () => {
    const { db, rows } = database()
    await record(db)
    expect(await record(db, { repository: 'acme/app' })).toEqual({ recorded: true })
    expect(await refusal(() => record(db, { agentId: 'oak' }))).toMatchObject({ code: 'COMMENT_NOT_YOURS', status: 409 })
    expect(rows.get('tab|acme/app|issue|101')!.agentId).toBe('juno')
    // Another Swarm on the same repository keeps its own records: it neither sees nor blocks this one.
    expect(await record(db, { tabId: 'other-tab', agentId: 'oak' })).toEqual({ recorded: true })
    // GitHub numbers a review and an issue comment apart: the same number of another kind is another comment.
    expect(await record(db, { agentId: 'oak', kind: 'review' })).toEqual({ recorded: true })
  })

  it('refuses an agent past its hourly new records, never a retry of one it made, and no other agent', async () => {
    const { db } = database()
    for (let i = 0; i < RECORDS_PER_HOUR; i++) await record(db, { agentId: 'busy', commentId: String(i + 1), now: NOW + 1 })
    expect(await record(db, { agentId: 'busy', commentId: '1', now: NOW + 2 })).toEqual({ recorded: true })
    expect(await refusal(() => record(db, { agentId: 'busy', commentId: '9001', now: NOW + 2 }))).toMatchObject({ code: 'RATE_LIMITED', status: 429 })
    expect(await record(db, { agentId: 'calm', commentId: '9002', now: NOW + 2 })).toEqual({ recorded: true })
  })

  it('answers recorded when the same agent\'s other write won the race, and refuses when another agent\'s did', async () => {
    const { db, rows } = database()
    const racing = (winner: string) => ({ superTabGithubComment: { ...db.superTabGithubComment, create: async ({ data }: { data: Row }) => {
      rows.set(data.id, { ...data, agentId: winner })
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    } } }) as unknown as PrismaClient
    expect(await record(racing('juno'), { commentId: '701' })).toEqual({ recorded: true })
    expect(await refusal(() => record(racing('oak'), { commentId: '702' }))).toMatchObject({ code: 'COMMENT_NOT_YOURS', status: 409 })
  })

  it('reads the recorded authors of a Swarm by the ids asked, any case of the repository, and leaves out the rest', async () => {
    const { db } = database()
    await record(db)
    await record(db, { kind: 'review', commentId: '5', agentId: 'oak', projectId: 'api' })
    await record(db, { tabId: 'other-tab', commentId: '9' })
    const authors = await commentAuthors(db, 'tab', 'ACME/app', ['issue:101', 'review:5', 'issue:9', 'issue:404', 'bogus:1', 'nocolon'])
    expect(Object.fromEntries(authors)).toEqual({ 'issue:101': { agentId: 'juno', projectId: 'web' }, 'review:5': { agentId: 'oak', projectId: 'api' } })
    expect((await commentAuthors(db, 'tab', 'acme/app', ['bogus:1'])).size).toBe(0)
  })
})

// Reviews of #4152: a repository has one coordinator in a Swarm, its project that got the repository's address first and has a PM.
describe('the project of a repository', () => {
  const project = (id: string, repositoryUrl: string | null, addressedAt?: number): SwarmProject => ({ id, name: id, ownerId: 'dee', leadConversationId: `lead-${id}`,
    visibility: 'public', members: [], updateMinutes: 5, ...repositoryUrl === undefined ? {} : { repository: { machineId: 'mac', cwd: `/work/${id}`, repositoryUrl,
      ...addressedAt === undefined ? {} : { addressedAt } } } })
  const state = (projects: SwarmProject[], led: string[]): SuperTabState => ({ projects, agents: led.map(id => ({ id: `pm-${id}` })),
    conversations: projects.map(p => ({ id: p.leadConversationId, leadId: led.includes(p.id) ? `pm-${p.id}` : null })) }) as unknown as SuperTabState
  const APP = 'https://github.com/Acme/App.git'

  it('is the one that got the address first, whatever order the projects were made in', () => {
    const projects = [project('early', APP, 2_000), project('web', APP, 1_000), project('docs', null)]
    expect(repositoryProject(state(projects, ['early', 'web', 'docs']), 'acme/app')?.id).toBe('web')
    expect(repositoryProject(state(projects, ['early', 'web', 'docs']), 'acme/other')).toBeUndefined()
  })

  it('is one whose address came before its time was kept, first in the order the projects were made', () => {
    const projects = [project('newer', APP, 1_000), project('old', APP), project('older', APP)]
    expect(repositoryProject(state(projects, ['newer', 'old', 'older']), 'acme/app')?.id).toBe('old')
  })

  it('passes over a project with no PM: its lead not there, or no agent of that id', () => {
    const projects = [project('first', APP, 1_000), project('next', APP, 2_000)]
    expect(repositoryProject(state(projects, ['next']), 'acme/app')?.id).toBe('next')
    const gone = state(projects, ['next'])
    gone.conversations[0]!.leadId = 'pm-left'
    expect(repositoryProject(gone, 'acme/app')?.id).toBe('next')
    expect(repositoryProject(state(projects, []), 'acme/app')).toBeUndefined()
  })
})
