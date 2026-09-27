import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { LiveEvent } from '../normalize.js'
import { SessionSearchIndex, folderWords, type SearchSource } from './indexer.js'
import { SessionSearchStore } from './store.js'

const dirs: string[] = []
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.useRealTimers()
})

const at = (minute: number) => `2026-09-20T10:${String(minute).padStart(2, '0')}:00.000Z`
const prompt = (text: string, minute: number) => JSON.stringify({ type: 'user', timestamp: at(minute), message: { role: 'user', content: text } }) + '\n'
const answer = (text: string, minute: number) => JSON.stringify({ type: 'assistant', timestamp: at(minute), message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' } }) + '\n'

function setup(initial: string, agents?: () => string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'session-search-'))
  dirs.push(dir)
  const path = join(dir, 's1.jsonl')
  writeFileSync(path, initial)
  const store = SessionSearchStore.open(':memory:')!
  let sources: SearchSource[] = [{ agentId: 'agent-1', sessionId: 's1', engine: 'claude', transcriptPath: path, header: 'Dial firmware · harness', updatedAt: 1 }]
  const index = new SessionSearchIndex({ store, sources: () => sources, agents, touchDelayMs: 5 })
  cleanups.push(() => { index.stop(); store.close() })
  const found = (query: string) => index.search(query).hits.map((hit) => hit.sessionId)
  const settle = async () => {
    index.sweep()
    await vi.waitFor(() => { expect((index as unknown as { running: boolean }).running).toBe(false) })
    await index.drain()
  }
  return { path, store, index, found, settle, setSources: (next: SearchSource[]) => { sources = next } }
}

describe('SessionSearchIndex', () => {
  it('indexes a transcript on the first sweep and picks up only what was added since', async () => {
    const { path, store, found, settle } = setup(prompt('why does the dial scroll jump', 0) + answer('The delta is doubled.', 1))
    await settle()
    expect(found('doubled')).toEqual(['s1'])
    const first = store.session('s1')!
    expect(first).toMatchObject({ resumeOffset: 0, resumeTurn: 0, turns: 1, lastAt: Date.parse(at(1)) })

    // The open turn grows, then a new one starts: the pass resumes at the open turn, not the start.
    appendFileSync(path, answer('Halved it in ui.c.', 2) + prompt('now flash the keyboard firmware', 3))
    await settle()
    expect(found('halved')).toEqual(['s1'])
    expect(found('keyboard')).toEqual(['s1'])
    const second = store.session('s1')!
    expect(second.resumeTurn).toBe(1)
    expect(second.resumeOffset).toBeGreaterThan(0)
    expect(store.counts()).toEqual({ sessions: 1, turns: 2 })
    // Nothing indexed twice.
    expect(found('doubled')).toEqual(['s1'])
    expect(store.search('delta')[0].snippet).toContain('doubled')
  })

  it('writes a long first pass in batches, and a pass stopped between them resumes at the next', async () => {
    let transcript = ''
    for (let i = 0; i < 70; i++) transcript += prompt(`step ${i} of the dial rewrite`, i % 60) + answer(`finished step${i}`, i % 60)
    const { store, index, found } = setup(transcript)
    const write = vi.spyOn(store, 'writeSession')
    write.mockImplementationOnce(function (this: SessionSearchStore, ...args) {
      index.stop()
      return SessionSearchStore.prototype.writeSession.apply(this, args)
    })
    index.sweep()
    await vi.waitFor(() => { expect((index as unknown as { running: boolean }).running).toBe(false) })
    // Stopped after the first batch: its rows are in, and the session resumes at the next one.
    expect(store.counts().turns).toBe(32)
    expect(store.session('s1')).toMatchObject({ resumeTurn: 32, mtime: 0 })
    expect(store.session('s1')!.size).toBe(store.session('s1')!.resumeOffset)
    write.mockRestore()

    const resumed = new SessionSearchIndex({ store, sources: () => [{ agentId: 'agent-1', sessionId: 's1', engine: 'claude', transcriptPath: store.session('s1')!.path, header: 'Dial firmware · harness', updatedAt: 1 }] })
    cleanups.push(() => resumed.stop())
    resumed.sweep()
    await vi.waitFor(() => { expect((resumed as unknown as { running: boolean }).running).toBe(false) })
    expect(store.counts()).toEqual({ sessions: 1, turns: 70 })
    for (const i of [0, 31, 32, 33, 64, 69]) expect(found(`step${i}`)).toEqual(['s1'])
    expect(store.session('s1')).toMatchObject({ resumeTurn: 69, turns: 70 })
    expect(store.session('s1')!.mtime).toBeGreaterThan(0)
  })

  it('starts over when the transcript was rewritten shorter', async () => {
    const { path, found, settle } = setup(prompt('first long conversation about cohorts and retention', 0) + answer('Done with the cohort table.', 1))
    await settle()
    writeFileSync(path, prompt('tiny', 0))
    await settle()
    expect(found('cohort')).toEqual([])
    expect(found('tiny')).toEqual(['s1'])
  })

  it('updates the name without rereading the transcript, and forgets sessions of deleted agents', async () => {
    const { store, found, settle, setSources, path } = setup(prompt('flash it', 0))
    await settle()
    setSources([{ agentId: 'agent-1', sessionId: 's1', engine: 'claude', transcriptPath: path, header: 'Keyboard firmware', updatedAt: 2 }])
    await settle()
    expect(found('keyboard')).toEqual(['s1'])
    expect(found('dial')).toEqual([])
    expect(store.session('s1')!.turns).toBe(1)

    // An agent's earlier session (before a /clear) stays while the agent does…
    setSources([{ agentId: 'agent-1', sessionId: 's2', engine: 'terminal', transcriptPath: null, header: 'Keyboard firmware', updatedAt: 3 }])
    await settle()
    expect(found('flash')).toEqual(['s1'])
    // …and goes with it.
    setSources([])
    await settle()
    expect(found('flash')).toEqual([])
    expect(store.counts().sessions).toBe(0)
  })

  it('indexes a touched session shortly after its turn event', async () => {
    const { path, index, found } = setup(prompt('first ask', 0))
    index.touch('s1')
    await vi.waitFor(() => { expect(found('first')).toEqual(['s1']) })
    appendFileSync(path, prompt('second ask about tmux', 1))
    index.touch('s1')
    index.touch('s1')
    await vi.waitFor(() => { expect(found('tmux')).toEqual(['s1']) })
  })

  it('reads a database-backed history whole, again only when the session changed', async () => {
    const store = SessionSearchStore.open(':memory:')!
    let reads = 0
    let history: LiveEvent[] = [
      { type: 'user_message', payload: { content: 'draft the release notes' } },
      { type: 'text_delta', payload: { content: 'Drafted them in RELEASE.md.' } },
    ]
    let source: SearchSource = {
      agentId: 'agent-oc', sessionId: 'ses_1', engine: 'opencode', transcriptPath: null, header: 'OpenCode harness',
      updatedAt: 100, readHistory: async () => { reads++; return history },
    }
    const index = new SessionSearchIndex({ store, sources: () => [source], touchDelayMs: 5 })
    cleanups.push(() => { index.stop(); store.close() })
    const found = (query: string) => index.search(query).hits.map((hit) => hit.sessionId)
    index.sweep()
    await vi.waitFor(() => { expect(found('release')).toEqual(['ses_1']) })
    expect(store.session('ses_1')).toMatchObject({ turns: 1, lastAt: 100 })

    index.sweep()
    await index.drain()
    expect(reads).toBe(1)

    // A turn event marks it changed even before its update time moves.
    history = [...history, { type: 'user_message', payload: { content: 'now tag v2' } }]
    index.touch('ses_1')
    await vi.waitFor(() => { expect(found('tag')).toEqual(['ses_1']) })
    expect(reads).toBe(2)

    // A turn event that changed nothing leaves it as it was worked on.
    const before = store.session('ses_1')!.lastAt
    index.touch('ses_1')
    await vi.waitFor(() => { expect(reads).toBe(3) })
    await index.drain()
    expect(store.session('ses_1')!.lastAt).toBe(before)

    const now = Date.now()
    history = [...history, { type: 'user_message', payload: { content: 'publish the changelog' } }]
    index.touch('ses_1')
    await vi.waitFor(() => { expect(found('changelog')).toEqual(['ses_1']) })
    expect(store.session('ses_1')!.turns).toBe(3)
    expect(store.session('ses_1')!.lastAt).toBeGreaterThanOrEqual(now)

    // A turn whose event was lost (the daemon restarted first): its activity stamp moved, so the
    // next sweep reads it, and dates it by that stamp.
    history = [...history, { type: 'user_message', payload: { content: 'archive the old builds' } }]
    source = { ...source, updatedAt: 5_000 }
    const restarted = new SessionSearchIndex({ store, sources: () => [source] })
    cleanups.push(() => restarted.stop())
    restarted.sweep()
    await vi.waitFor(() => { expect(restarted.search('archive').hits.map((hit) => hit.sessionId)).toEqual(['ses_1']) })
    expect(store.session('ses_1')).toMatchObject({ turns: 4, lastAt: 5_000 })
    restarted.sweep()
    await restarted.drain()
    expect(reads).toBe(5)
  })

  it('keeps an agent\'s sessions while the agent exists, even with nothing to read right now', async () => {
    let agents = ['agent-1']
    const { store, found, settle, setSources } = setup(prompt('the first conversation about tmux', 0), () => agents)
    await settle()
    setSources([])
    await settle()
    expect(found('tmux')).toEqual(['s1'])
    agents = []
    await settle()
    expect(store.counts().sessions).toBe(0)
  })

  it('names folders the way a person would: the last two segments', () => {
    expect(folderWords('/home/me/code/worktrees/autonomous-harness/dapper-otter')).toBe('dapper-otter autonomous-harness')
    expect(folderWords('C:\\work\\app')).toBe('app work')
    expect(folderWords(null)).toBe('')
  })
})
